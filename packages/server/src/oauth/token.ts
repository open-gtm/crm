import { createLocalJWKSet, decodeJwt, errors as joseErrors, jwtVerify, type JSONWebKeySet } from "jose";
import { oauthSettings } from "../config.js";
import { audit } from "../core/audit.js";
import type { Scope } from "../core/context.js";
import { db, type Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { ClientError, fetchKeySet, resolveClient, touchClient, type Client } from "./clients.js";
import { resourceFor } from "./authorize.js";
import { LIMITS, hit } from "../auth/limits.js";
import { keyOwner, memberAccess, type Owner } from "../core/keys.js";
import { createGrant, grantPublicId, issueTokens, oauthCtx, revokeGrant, tokenScopes } from "./grants.js";
import {
  codeForUpdate, codeLocation, grantForUpdate, grantMemberAndClient, markCodeUsed, markGrantUsed, markTokenRevoked, markTokenUsed, narrowToAssertion,
  narrowToSecretLookup, recordAssertion, refreshTokenForUpdate, sessionStillValid, setCodeGrant, tokenForRevocation, tokenLocation, workspaceAllowsApps,
  workspaceOAuthScopes,
} from "./queries.js";
import { ACCESS_TOKEN_PATTERN, CODE_PATTERN, REFRESH_TOKEN_PATTERN, expandScopes, isScope, secretHash } from "./scopes.js";

/**
 * The token endpoint (authorization_code and refresh_token grants) and revocation (RFC 7009), ADR 0010.
 *
 * Public clients send only their client_id. Clients whose metadata document says private_key_jwt must
 * sign an assertion with a key from their published key set (RFC 7523); each assertion works once.
 * There are no client secrets. A refresh token rotates on every use; presenting one that was already
 * exchanged is taken as theft (RFC 9700 §4.14.2) and revokes the whole grant.
 */

export class TokenError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryAfter?: number) {
    super(message);
  }
}

/**
 * About the request. `caller` is the address's limit key. `proven` turns true once the request has
 * shown something only a real client holds (a code or refresh token that exists, a verified
 * assertion): only then is it charged to a budget its client shares with other users.
 */
export interface Meta { requestId: string; address: string; caller: string; proven?: boolean }
type Fields = Record<string, string>;

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASYMMETRIC = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
const KEYSET_TTL_MS = 5 * 60_000;
/** A key set past its cache life still verifies when fetching it again fails or is refused, for at most this long. */
const KEYSET_STALE_MS = 24 * 60 * 60_000;
/** An assertion naming a key the set doesn't have forces a fetch at most this often per key set: unknown `kid`s can't make this server hammer a host. */
const KEYSET_FORCE_MS = 60_000;
const MAX_KEYSETS = 1_000;
const keysets = new Map<string, { at: number; forcedAt: number; set: JSONWebKeySet }>();
/** For tests. */
export function resetKeySets(): void {
  keysets.clear();
}

const hostOf = (url: string) => new URL(url).host;

/**
 * A client's key set: cached for 5 minutes, fetched again at most once a minute for a key it doesn't
 * have (rotation), and the last good set is kept when a fetch fails or is refused. A set is known
 * (charged to its host's own budget) once fetched, or when a cached client names one on its own host.
 */
async function keySet(client: Client, fresh: boolean, caller: string): Promise<JSONWebKeySet> {
  const uri = client.jwksUri!;
  const now = Date.now();
  const last = keysets.get(uri);
  const usable = last && now - last.at < KEYSET_STALE_MS ? last : null;
  if (usable && !fresh && now - usable.at < KEYSET_TTL_MS) return usable.set;
  if (usable && fresh) {
    if (now - usable.forcedAt < KEYSET_FORCE_MS) return usable.set;
    usable.forcedAt = now;
  }
  let set: unknown;
  try {
    set = await fetchKeySet(uri, last !== undefined || (client.stored === true && hostOf(uri) === hostOf(client.clientId)), caller);
    if (!set || typeof set !== "object" || !Array.isArray((set as JSONWebKeySet).keys)) throw new ClientError("invalid_client", "The client's key set has no keys");
  } catch (e) {
    if (usable) return usable.set;
    throw e;
  }
  keysets.delete(uri);
  keysets.set(uri, { at: now, forcedAt: fresh ? now : last?.forcedAt ?? 0, set: set as JSONWebKeySet });
  for (const k of keysets.keys()) {
    if (keysets.size <= MAX_KEYSETS) break;
    keysets.delete(k);
  }
  return set as JSONWebKeySet;
}

/**
 * Who is calling the token or revocation endpoint. A public client names itself; a private_key_jwt
 * client proves it with a fresh, single-use assertion whose issuer and subject are its client_id and
 * whose audience is this server. A client registered for one method can't use the other.
 */
export async function authenticateClient(f: Fields, authorization: string | undefined, meta: Meta): Promise<Client> {
  if (authorization) throw new TokenError("invalid_client", "This server issues no client secrets; send client_id (or a private_key_jwt assertion) in the body", 401);
  try {
    if (f.client_assertion !== undefined || f.client_assertion_type !== undefined) {
      if (f.client_assertion_type !== JWT_BEARER || !f.client_assertion) throw new TokenError("invalid_client", `client_assertion_type must be ${JWT_BEARER}`, 401);
      let iss: unknown;
      try {
        iss = decodeJwt(f.client_assertion).iss;
      } catch {
        throw new TokenError("invalid_client", "client_assertion is not a JWT", 401);
      }
      if (typeof iss !== "string" || (f.client_id !== undefined && f.client_id !== iss)) throw new TokenError("invalid_client", "The assertion's issuer must be the client_id", 401);
      const client = await resolveClient(iss, { allowStale: true, caller: meta.caller });
      if (client.authMethod !== "private_key_jwt" || !client.jwksUri) throw new TokenError("invalid_client", "This client doesn't authenticate with private_key_jwt", 401);
      await verifyAssertion(client, f.client_assertion, meta.caller);
      meta.proven = true;
      return client;
    }
    const client = await resolveClient(f.client_id, { allowStale: true, caller: meta.caller });
    if (client.authMethod !== "none") throw new TokenError("invalid_client", "This client must authenticate with private_key_jwt", 401);
    return client;
  } catch (e) {
    if (e instanceof ClientError) throw new TokenError(e.code === "temporarily_unavailable" ? "temporarily_unavailable" : "invalid_client", e.message, e.code === "temporarily_unavailable" ? 503 : 401);
    throw e;
  }
}

async function verifyAssertion(client: Client, assertion: string, caller: string): Promise<void> {
  const s = oauthSettings()!;
  const audience = [s.issuer, `${s.issuer}/oauth/token`, `${s.issuer}/oauth/revoke`];
  const verify = async (fresh: boolean) => jwtVerify(assertion, createLocalJWKSet(await keySet(client, fresh, caller)),
    { issuer: client.clientId, subject: client.clientId, audience, algorithms: ASYMMETRIC, requiredClaims: ["exp", "jti"], clockTolerance: 30 });
  let payload;
  try {
    payload = (await verify(false).catch((e: unknown) => {
      // A key the cached set doesn't have may be a rotation: fetch the set once more.
      if (e instanceof joseErrors.JWKSNoMatchingKey) return verify(true);
      throw e;
    })).payload;
  } catch (e) {
    if (e instanceof ClientError) throw e;
    throw new TokenError("invalid_client", "The client assertion did not verify", 401);
  }
  const exp = payload.exp! * 1000;
  if (exp - Date.now() > 10 * 60_000) throw new TokenError("invalid_client", "The client assertion must expire within 10 minutes", 401);
  if (typeof payload.jti !== "string" || payload.jti.length > 200) throw new TokenError("invalid_client", "The client assertion needs a jti", 401);
  const jti = sha256(`${client.clientId}\n${payload.jti}`);
  const fresh = await db().begin(async (tx) => {
    await narrowToAssertion(tx, jti.toString("hex"));
    return recordAssertion(tx, jti, new Date(exp + 60_000));
  });
  if (!fresh) throw new TokenError("invalid_client", "This client assertion was already used", 401);
}

export interface TokenResponse { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }

const invalidGrant = (why: string) => new TokenError("invalid_grant", why);

/**
 * Called once a code or refresh token was found. From here on the request counts against its
 * client's budget in that workspace, never before: a public client_id proves nothing, so requests
 * naming one can't use up what the client's real users need.
 */
function chargeProven(client: Client, tenantId: string, meta: Meta): void {
  meta.proven = true;
  const wait = hit(LIMITS.oauthTokenClient, `${client.clientId}|${tenantId}`);
  if (wait !== null) throw new TokenError("slow_down", "Too many token requests from this app for this workspace; wait and retry", 429, wait);
}

/** The scopes a new token can use now, as its MCP requests will compute them (grants.ts tokenScopes, then the role): what the response reports. */
async function effectiveScope(tx: Tx, tenantId: string, owner: Owner, asked: string[] | null, granted: string[]): Promise<string> {
  const w = await workspaceOAuthScopes(tx);
  const access = await memberAccess(tx, tenantId, owner, tokenScopes(asked, granted, w?.oauth_scopes ?? []));
  return expandScopes(access.scopes).join(" ");
}

/** Finds which workspace a code or token hash belongs to, through its lookup policy. */
async function lookupTenant(setting: "app.oauth_code_lookup" | "app.oauth_token_lookup", table: "oauth_codes" | "oauth_tokens", hash: Buffer) {
  return db().begin(async (tx) => {
    await narrowToSecretLookup(tx, setting, hash.toString("hex"));
    const row = table === "oauth_codes" ? await codeLocation(tx, hash) : await tokenLocation(tx, hash);
    return row ?? null;
  }) as Promise<{ tenant_id: string; id: string } | null>;
}

/** The member still active and the workspace still allowing apps, in the workspace's transaction. */
async function stillAllowed(tx: Tx, userId: string) {
  const w = await workspaceAllowsApps(tx);
  const owner = await keyOwner(tx, "user", userId);
  return w?.oauth_apps && owner && !owner.disabled_at && !owner.archived_at ? { role: owner.role, owner } : null;
}

/** The authorization_code grant: every parameter the code was bound to must be repeated exactly, and the verifier must match. */
export async function exchangeCode(client: Client, f: Fields, meta: Meta): Promise<TokenResponse> {
  if (!f.code || !CODE_PATTERN.test(f.code)) throw invalidGrant("The code is not valid");
  if (!f.redirect_uri) throw new TokenError("invalid_request", "redirect_uri is required");
  if (!f.code_verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(f.code_verifier)) throw new TokenError("invalid_request", "code_verifier must be 43 to 128 unreserved characters");
  const resource = f.resource === undefined ? null : resourceFor(f.resource);
  if (f.resource !== undefined && !resource) throw new TokenError("invalid_target", "resource must be one of this server's MCP endpoints");
  const hash = secretHash(f.code);
  const found = await lookupTenant("app.oauth_code_lookup", "oauth_codes", hash);
  if (!found) throw invalidGrant("The code is not valid, has expired or was already used");
  chargeProven(client, found.tenant_id, meta);
  const outcome = await withTenant(found.tenant_id, async (tx) => {
    const c = await codeForUpdate(tx, found.id);
    if (!c || !safeEqual(c.code_hash, hash)) return { error: invalidGrant("The code is not valid") };
    if (c.used_at) {
      // A code used twice was intercepted, or replayed: whatever the first use got is revoked (RFC 9700 §4.5).
      if (c.grant_id && await revokeGrant(tx, c.grant_id, "code_reuse")) {
        const owner = await keyOwner(tx, "user", c.user_id);
        await audit(tx, oauthCtx(found.tenant_id, c.user_id, owner?.role ?? "member", meta.requestId, { id: c.grant_id, clientId: c.client_id }),
          { action: "oauth.code_reuse_detected", objectType: "user", recordId: c.user_id, details: { client_id: c.client_id } });
      }
      return { error: invalidGrant("The code was already used") };
    }
    if (c.expires_at.getTime() <= Date.now()) return { error: invalidGrant("The code has expired") };
    if (c.client_id !== client.clientId) return { error: invalidGrant("The code was issued to another client") };
    if (c.redirect_uri !== f.redirect_uri) return { error: invalidGrant("redirect_uri doesn't match the authorization request") };
    const computed = Buffer.from(sha256(f.code_verifier!).toString("base64url"));
    if (!safeEqual(computed, Buffer.from(c.code_challenge))) return { error: invalidGrant("code_verifier doesn't match the code_challenge") };
    if (resource && oauthSettings()!.resources[resource] !== c.resource) return { error: new TokenError("invalid_target", "resource doesn't match the authorization request") };
    const s = await sessionStillValid(tx, c.session_id);
    const member = await stillAllowed(tx, c.user_id);
    // The person who approved signed out (or was signed out) before the app redeemed the code.
    if (!s?.ok || !member) return { error: invalidGrant("The approval is no longer valid; connect again") };
    if (!(await markCodeUsed(tx, c.id))) return { error: invalidGrant("The code was already used") };
    const ctx = { ...oauthCtx(found.tenant_id, c.user_id, member.role, meta.requestId, { id: "", clientId: c.client_id }) };
    const grant = await createGrant(tx, ctx, { userId: c.user_id, sessionId: c.session_id, clientId: c.client_id, clientName: c.client_name, clientKind: c.client_kind,
      redirectUri: c.redirect_uri, scopes: c.scopes, resource: c.resource });
    await setCodeGrant(tx, c.id, grant.id);
    const tokens = await issueTokens(tx, found.tenant_id, grant, null);
    await audit(tx, { ...ctx, oauth: { grantId: grant.id, clientId: c.client_id } }, { action: "oauth.token_issued", objectType: "user", recordId: c.user_id,
      details: { grant: grantPublicId(grant.id), client_id: c.client_id, scopes: c.scopes, resource: c.resource, ...(grant.replaced.length ? { replaced: grant.replaced } : {}) } });
    return { tokens, scope: await effectiveScope(tx, found.tenant_id, member.owner, null, c.scopes) };
  });
  if ("error" in outcome) throw outcome.error;
  await touchClient(client.clientId).catch(() => {});
  return { access_token: outcome.tokens.access, token_type: "Bearer", expires_in: outcome.tokens.expiresIn, refresh_token: outcome.tokens.refresh, scope: outcome.scope };
}

/** The refresh_token grant. Rotates the refresh token; asking for more than the grant holds is refused, asking for less narrows the access token. */
export async function refresh(client: Client, f: Fields, meta: Meta): Promise<TokenResponse> {
  if (!f.refresh_token || !REFRESH_TOKEN_PATTERN.test(f.refresh_token)) throw invalidGrant("The refresh token is not valid");
  const resource = f.resource === undefined ? null : resourceFor(f.resource);
  if (f.resource !== undefined && !resource) throw new TokenError("invalid_target", "resource must be one of this server's MCP endpoints");
  const asked = f.scope === undefined ? null : f.scope.split(" ").filter(Boolean);
  if (asked && (asked.length === 0 || asked.some((s) => !isScope(s)))) throw new TokenError("invalid_scope", "scope holds a scope this server doesn't know");
  const hash = secretHash(f.refresh_token);
  const found = await lookupTenant("app.oauth_token_lookup", "oauth_tokens", hash);
  if (!found) throw invalidGrant("The refresh token is not valid or has expired");
  chargeProven(client, found.tenant_id, meta);
  const outcome = await withTenant(found.tenant_id, async (tx) => {
    const t = await refreshTokenForUpdate(tx, found.id);
    if (!t || t.kind !== "refresh" || !safeEqual(t.token_hash, hash)) return { error: invalidGrant("The refresh token is not valid") };
    const g = await grantForUpdate(tx, t.grant_id);
    if (!g) return { error: invalidGrant("The refresh token is not valid") };
    // Another client presenting this token learns nothing and changes nothing.
    if (g.client_id !== client.clientId) return { error: invalidGrant("The refresh token was issued to another client") };
    if (t.used_at && !g.revoked_at) {
      await revokeGrant(tx, g.id, "refresh_reuse");
      const owner = await keyOwner(tx, "user", g.user_id);
      await audit(tx, oauthCtx(found.tenant_id, g.user_id, owner?.role ?? "member", meta.requestId, { id: g.id, clientId: g.client_id }),
        { action: "oauth.refresh_reuse_detected", objectType: "user", recordId: g.user_id, details: { grant: grantPublicId(g.id), client_id: g.client_id } });
      logger.warn({ requestId: meta.requestId, event: "oauth_refresh_reuse", grant: grantPublicId(g.id) }, "a used refresh token was presented again; the grant is revoked");
      return { error: invalidGrant("The refresh token was already used; the connection is revoked and must be approved again") };
    }
    if (t.used_at || t.revoked_at || g.revoked_at || t.expires_at.getTime() <= Date.now() || g.expires_at.getTime() <= Date.now()) {
      return { error: invalidGrant("The refresh token has expired or was revoked") };
    }
    if (resource && oauthSettings()!.resources[resource] !== g.resource) return { error: new TokenError("invalid_target", "resource doesn't match the grant") };
    const held = new Set(expandScopes(g.scopes));
    if (asked && asked.some((s) => !held.has(s as Scope))) return { error: new TokenError("invalid_scope", "A refresh can't add scopes; approve the app again for more") };
    const member = await stillAllowed(tx, g.user_id);
    if (!member) return { error: invalidGrant("The refresh token has expired or was revoked") };
    await markTokenUsed(tx, found.id);
    await markGrantUsed(tx, g.id);
    const scopes = asked ? expandScopes(asked).filter((s) => asked.includes(s)) : null;
    const tokens = await issueTokens(tx, found.tenant_id, g, scopes);
    await audit(tx, oauthCtx(found.tenant_id, g.user_id, member.role, meta.requestId, { id: g.id, clientId: g.client_id }),
      { action: "oauth.token_refreshed", objectType: "user", recordId: g.user_id, details: { grant: grantPublicId(g.id), client_id: g.client_id, ...(scopes ? { scopes } : {}) } });
    // What applies now (the workspace or the role may have narrowed it since the grant), not what was granted.
    return { tokens, scope: await effectiveScope(tx, found.tenant_id, member.owner, scopes, g.scopes) };
  });
  if ("error" in outcome) throw outcome.error;
  await touchClient(client.clientId).catch(() => {});
  return { access_token: outcome.tokens.access, token_type: "Bearer", expires_in: outcome.tokens.expiresIn, refresh_token: outcome.tokens.refresh, scope: outcome.scope };
}

/**
 * Revocation (RFC 7009). Always succeeds from the caller's point of view: an unknown token, or one
 * issued to another client, changes nothing. A refresh token ends its whole grant; an access token ends itself.
 */
export async function revokeToken(client: Client, f: Fields, meta: Meta): Promise<void> {
  const token = f.token ?? "";
  if (!ACCESS_TOKEN_PATTERN.test(token) && !REFRESH_TOKEN_PATTERN.test(token)) return;
  const hash = secretHash(token);
  const found = await lookupTenant("app.oauth_token_lookup", "oauth_tokens", hash);
  if (!found) return;
  await withTenant(found.tenant_id, async (tx) => {
    const t = await tokenForRevocation(tx, found.id);
    if (!t || !safeEqual(t.token_hash, hash)) return;
    const g = await grantMemberAndClient(tx, t.grant_id);
    if (!g || g.client_id !== client.clientId) return;
    const changed = t.kind === "refresh" ? await revokeGrant(tx, t.grant_id, "revoked")
      : await markTokenRevoked(tx, found.id);
    if (!changed) return;
    const owner = await keyOwner(tx, "user", g.user_id);
    await audit(tx, oauthCtx(found.tenant_id, g.user_id, owner?.role ?? "member", meta.requestId, { id: t.grant_id, clientId: g.client_id }),
      { action: "oauth.token_revoked", objectType: "user", recordId: g.user_id, details: { grant: grantPublicId(t.grant_id), client_id: g.client_id, token_kind: t.kind } });
  });
}
