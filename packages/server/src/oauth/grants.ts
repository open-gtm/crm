import { config, oauthSettings } from "../config.js";
import { audit } from "../core/audit.js";
import { tenantIds } from "../core/auditchain.js";
import type { Ctx, Scope } from "../core/context.js";
import { keyOwner, memberAccess, type Principal } from "../core/keys.js";
import { db, type Tx } from "../db/pool.js";
import { safeEqual } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { redirectHost } from "./clients.js";
import {
  deleteEndedCodes, deleteEndedGrants, deleteEndedTokens, enterTokenWorkspace, enterWorkspace, grantForAccess, insertGrant, insertTokenPair, liveGrants,
  markGrantRevoked, markGrantUsed, narrowToTokenHash, replaceLiveGrants, revokeLiveGrantsOf, revokeTokensOfGrant, revokeTokensOfGrants, tokenByHash,
  unrevokedGrantOwner, workspaceOAuth, type GrantRow,
} from "./queries.js";
import { ACCESS_PREFIX, REFRESH_PREFIX, RESOURCES, expandScopes, isAccessToken, newSecret, secretHash, type ResourceName } from "./scopes.js";

/**
 * Grants and their tokens (ADR 0010). A grant is one approved connection: a member, in one workspace,
 * letting one client reach one MCP endpoint (the resource, which is the tokens' audience) with some
 * scopes. Its tokens are opaque random strings stored as SHA-256 hashes, found like API keys and
 * sessions by a narrow lookup policy before the tenant is known. Every use re-reads the member's role,
 * the grant and the workspace's OAuth settings, so revoking, disabling or narrowing applies at once.
 */

export const grantPublicId = (id: string) => encodeId("ogr", id);

export type GrantRevokeReason = "revoked" | "revoked_by_admin" | "member_disabled" | "signed_out_everywhere" | "replaced" | "refresh_reuse"
  | "code_reuse" | "workspace_disabled";

/** A context for OAuth events: the member as actor, on the oauth surface, naming the grant and client. */
export function oauthCtx(tenantId: string, userId: string, role: string, requestId: string, grant: { id: string; clientId: string }): Ctx {
  return { tenantId, actor: { type: "user", id: userId, role }, keyId: null, permissions: new Set(), scopes: new Set(), surface: "oauth", requestId,
    oauth: { grantId: grant.id, clientId: grant.clientId } };
}

const lifetimes = () => {
  const c = config();
  return { accessS: c.OAUTH_ACCESS_TOKEN_MINUTES * 60, refreshS: c.OAUTH_REFRESH_TOKEN_DAYS * 86_400, grantDays: c.OAUTH_GRANT_MAX_DAYS };
};

/** Issues an access token and a rotated refresh token for a grant. Neither outlives the grant. */
export async function issueTokens(tx: Tx, tenantId: string, grant: { id: string; expires_at: Date }, scopes: Scope[] | null) {
  const { accessS, refreshS } = lifetimes();
  const access = newSecret(ACCESS_PREFIX);
  const refresh = newSecret(REFRESH_PREFIX);
  const now = Date.now();
  const accessExp = new Date(Math.min(now + accessS * 1000, grant.expires_at.getTime()));
  const refreshExp = new Date(Math.min(now + refreshS * 1000, grant.expires_at.getTime()));
  await insertTokenPair(tx, { tenantId, grantId: grant.id, scopes, access: { id: uuidv7(), hash: secretHash(access), expiresAt: accessExp },
    refresh: { id: uuidv7(), hash: secretHash(refresh), expiresAt: refreshExp } });
  return { access, refresh, expiresIn: Math.max(1, Math.floor((accessExp.getTime() - now) / 1000)) };
}

/** Creates a grant for a redeemed code. Earlier live grants of the same member, client and resource are replaced: one connection per app and server. */
export async function createGrant(tx: Tx, ctx: Ctx, g: { userId: string; sessionId: string; clientId: string; clientName: string; clientKind: string;
  redirectUri: string; scopes: string[]; resource: string }) {
  const replaced = await replaceLiveGrants(tx, g.userId, g.clientId, g.resource);
  if (replaced.length) await revokeTokensOfGrants(tx, replaced.map((r) => r.id));
  const id = uuidv7();
  const row = await insertGrant(tx, { tenantId: ctx.tenantId, id, ...g, days: lifetimes().grantDays });
  return { id, expires_at: row!.expires_at, replaced: replaced.map((r) => grantPublicId(r.id)) };
}

/** Revokes a grant and all its tokens. Returns false when it was already revoked. */
export async function revokeGrant(tx: Tx, grantId: string, reason: GrantRevokeReason): Promise<boolean> {
  const revoked = await markGrantRevoked(tx, grantId, reason);
  await revokeTokensOfGrant(tx, grantId);
  return revoked;
}

/** Revokes every live grant of a member (or, with no member, of the whole workspace). Returns how many. */
export async function revokeUserGrants(tx: Tx, userId: string | null, reason: GrantRevokeReason): Promise<number> {
  const rows = await revokeLiveGrantsOf(tx, userId, reason);
  if (rows.length) await revokeTokensOfGrants(tx, rows.map((r) => r.id));
  return rows.length;
}

/** A token's scopes now: its own (or its grant's), within the grant and what the workspace allows, `ops:write` implying `ops:read` throughout. The role narrows them further (memberAccess). */
export function tokenScopes(token: string[] | null, grant: string[], workspace: string[]): Scope[] {
  const granted = new Set(expandScopes(grant));
  const allowed = new Set(expandScopes(workspace));
  return expandScopes(token ?? grant).filter((x) => granted.has(x) && allowed.has(x));
}

export interface OAuthPrincipal extends Principal { oauth: { grantId: string; clientId: string; resource: ResourceName } }

/**
 * The member an access token acts as, or null for anything invalid, expired or revoked, a revoked or
 * expired grant, a disabled member or a workspace that turned OAuth off (without saying which).
 * Scopes are the token's (or grant's), within what the workspace allows now, with `ops:write`
 * implying `ops:read`; then, as for a key, the member's current role decides the permissions.
 */
export async function resolveAccessToken(token: string): Promise<OAuthPrincipal | null> {
  const s = oauthSettings();
  if (!s || !isAccessToken(token)) return null;
  const hash = secretHash(token);
  return db().begin(async (tx) => {
    await narrowToTokenHash(tx, hash.toString("hex"));
    const t = await tokenByHash(tx, hash);
    if (!t || t.kind !== "access" || !safeEqual(t.token_hash, hash) || t.revoked_at || t.expires_at.getTime() <= Date.now()) return null;
    await enterTokenWorkspace(tx, t.tenant_id);
    const g = await grantForAccess(tx, t.grant_id);
    if (!g || g.revoked_at || g.expires_at.getTime() <= Date.now()) return null;
    const resource = RESOURCES.find((r) => s.resources[r] === g.resource);
    if (!resource) return null;
    const w = await workspaceOAuth(tx);
    if (!w?.oauth_apps) return null;
    const owner = await keyOwner(tx, "user", g.user_id);
    if (!owner || owner.disabled_at || owner.archived_at) return null;
    const scopes = tokenScopes(t.scopes, g.scopes, w.oauth_scopes);
    // At most once a minute, so a busy client doesn't write on every request.
    if (!g.last_used_at || Date.now() - g.last_used_at.getTime() >= 60_000) await markGrantUsed(tx, t.grant_id);
    return {
      tenantId: t.tenant_id, keyId: null, actor: { type: "user", id: g.user_id, role: owner.role },
      oauth: { grantId: t.grant_id, clientId: g.client_id, resource },
      ...(await memberAccess(tx, t.tenant_id, owner, scopes)),
    } satisfies OAuthPrincipal;
  }) as Promise<OAuthPrincipal | null>;
}

const grantView = (r: GrantRow) => ({
  id: grantPublicId(r.id), member: encodeId("usr", r.user_id),
  client: { id: r.client_id, name: r.client_name, kind: r.client_kind, verified_by_document: r.client_kind === "metadata_document", redirect_host: redirectHost(r.redirect_uri) },
  scopes: r.scopes, resource: r.resource, created_at: r.created_at.toISOString(), last_used_at: r.last_used_at?.toISOString() ?? null,
  expires_at: r.expires_at.toISOString(),
});

/** Live grants of one member (or every member, for the access review), newest first. */
export async function listGrants(tx: Tx, userId: string | null) {
  const rows = await liveGrants(tx, userId, userId ? 500 : 100_000);
  return rows.map(grantView);
}

/** A grant's owner by public ID (ogr_…), or not found. */
export async function grantOwner(tx: Tx, publicId: string): Promise<{ id: string; userId: string; clientId: string }> {
  const d = decodeId(publicId);
  if (d?.prefix !== "ogr") throw notFound("Connected app");
  const g = await unrevokedGrantOwner(tx, d.uuid);
  if (!g) throw notFound("Connected app");
  return { id: d.uuid, userId: g.user_id, clientId: g.client_id };
}

/** Revokes one grant on a member's or an admin's request, audited. */
export async function revokeGrantAudited(tx: Tx, ctx: Ctx, grant: { id: string; userId: string; clientId: string }, byAdmin: boolean) {
  await revokeGrant(tx, grant.id, byAdmin ? "revoked_by_admin" : "revoked");
  await audit(tx, ctx, { action: "oauth.grant_revoked", objectType: "user", recordId: grant.userId,
    details: { grant: grantPublicId(grant.id), client_id: grant.clientId, by_admin: byAdmin } });
  return { id: grantPublicId(grant.id), revoked: true };
}

/**
 * Deletes what has ended, in every workspace: codes after a day, tokens a day after they expire or are
 * revoked, used refresh tokens a week after use (reuse of an older one is then just invalid, not
 * detected), and revoked or expired grants after 90 days. The worker runs this hourly.
 */
export async function pruneGrants(): Promise<number> {
  let n = 0;
  for (const t of await tenantIds(db())) {
    n += await db().begin(async (tx) => {
      await enterWorkspace(tx, t);
      const codes = await deleteEndedCodes(tx);
      const tokens = await deleteEndedTokens(tx);
      const grants = await deleteEndedGrants(tx);
      return codes + tokens + grants;
    }) as number;
  }
  return n;
}
