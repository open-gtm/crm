import { config } from "../config.js";
import { audit } from "../core/audit.js";
import { ALL_SCOPES, OWNER_ROLE, can, type Ctx, type SignInMethod } from "../core/context.js";
import { keyOwner, memberAccess, type Principal } from "../core/keys.js";
import { assertCoversRole } from "../core/roles.js";
import { loadSchema } from "../core/schema.js";
import { db, type Tx } from "../db/pool.js";
import { tenantIds } from "../core/auditchain.js";
import { safeEqual } from "../lib/crypto.js";
import { ApiError, forbidden, notFound } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import {
  deleteEndedSessions, enterSessionWorkspace, enterWorkspace, insertSession, liveSessionsOf, memberRole, narrowToSessionToken, recordSignIn,
  revokeSessionOf, revokeSessionsOf, sessionByTokenHash, touchSession, type SessionRow,
} from "./queries.js";
import { csrfToken, isToken, newToken, tokenHash } from "./tokens.js";

/**
 * Browser sessions (ADR 0009). A session is a row in Postgres found by the SHA-256 of the 256-bit
 * token in its HttpOnly cookie. It acts as its member with their full role: permissions, object and
 * field rules are read on every request, exactly as for a key, so a role change or disabling takes
 * effect on the next request. Idle and absolute timeouts are enforced here, server-side.
 */

export interface ClientMeta { requestId: string; userAgent?: string | null; address?: string | null }

/** How recent a sign-in must be for a sensitive change (a password without the current one, an API key, unlinking SSO; a future consent step). */
export const RECENT_SIGN_IN_SECONDS = 600;

const lifetimes = () => ({ idleMs: config().SESSION_IDLE_TIMEOUT_MINUTES * 60_000, absoluteMs: config().SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000 });

export const sessionPublicId = (id: string) => encodeId("ses", id);

/** A context for auth events written before (or without) a request context: the member as actor, on the web surface. */
export function webCtx(tenantId: string, userId: string | null, role: string, meta: ClientMeta, session?: Ctx["session"]): Ctx {
  return { tenantId, actor: userId ? { type: "user", id: userId, role } : { type: "system", id: null, role: OWNER_ROLE }, keyId: null,
    permissions: new Set(), scopes: new Set(), surface: "web", requestId: meta.requestId, ...(session ? { session } : {}) };
}

/**
 * Starts a session for a member who has just proved who they are, in their workspace's transaction.
 * Always a new ID and token: nothing from before sign-in is reused. Returns the token once.
 */
export async function createSession(tx: Tx, m: { tenantId: string; userId: string; role: string }, method: SignInMethod, meta: ClientMeta) {
  const { idleMs, absoluteMs } = lifetimes();
  const id = uuidv7();
  const token = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + absoluteMs);
  const idleExpiresAt = new Date(Math.min(now + idleMs, now + absoluteMs));
  const row = await insertSession(tx, { tenantId: m.tenantId, id, userId: m.userId, tokenHash: tokenHash(token), method, idleExpiresAt, expiresAt,
    userAgent: meta.userAgent?.slice(0, 256) ?? null, address: meta.address?.slice(0, 64) ?? null });
  // Any successful sign-in clears the password lockout: the person has shown they control the account.
  await recordSignIn(tx, m.tenantId, m.userId);
  const session = { id, signedInAt: row!.signed_in_at, method };
  await audit(tx, webCtx(m.tenantId, m.userId, m.role, meta, session), { action: "auth.signed_in", objectType: "user", recordId: m.userId, details: { method } });
  return { id, token, expiresAt, idleExpiresAt, csrfToken: csrfToken(id) };
}

/**
 * The member a session cookie acts as, or null for anything invalid, expired, revoked or belonging
 * to a disabled member (without saying which). The next task's consent page should call this (or read
 * `ctx.session` on a /v1 route) and `requireRecentSignIn` for a step-up.
 */
export async function resolveSession(token: string): Promise<Principal | null> {
  if (!isToken(token)) return null;
  const hash = tokenHash(token);
  return db().begin(async (tx) => {
    await narrowToSessionToken(tx, hash.toString("hex"));
    const s = await sessionByTokenHash(tx, hash);
    const now = Date.now();
    if (!s || !safeEqual(s.token_hash, hash) || s.revoked_at || s.expires_at.getTime() <= now || s.idle_expires_at.getTime() <= now) return null;
    await enterSessionWorkspace(tx, s.tenant_id);
    const owner = await keyOwner(tx, "user", s.user_id);
    if (!owner || owner.disabled_at || owner.archived_at) return null;
    // At most once a minute, so a busy browser doesn't write on every request.
    if (now - s.last_seen_at.getTime() >= 60_000) {
      await touchSession(tx, s.id, lifetimes().idleMs / 1000);
    }
    return {
      tenantId: s.tenant_id, keyId: null, session: { id: s.id, signedInAt: s.signed_in_at, method: s.method },
      actor: { type: "user", id: s.user_id, role: owner.role },
      // A session is the member acting with their whole role: every scope the role can use, so nothing is narrowed.
      ...(await memberAccess(tx, s.tenant_id, owner, ALL_SCOPES)),
    } satisfies Principal;
  }) as Promise<Principal | null>;
}

/** Refuses unless a person signed in (not a key) within `maxAgeSeconds`. For changes that should need a fresh proof of identity. */
export function requireRecentSignIn(ctx: Ctx, maxAgeSeconds = RECENT_SIGN_IN_SECONDS): void {
  if (!ctx.session) throw forbidden("This needs a signed-in person, not an API key");
  if (Date.now() - ctx.session.signedInAt.getTime() > maxAgeSeconds * 1000) {
    throw new ApiError(403, "recent_sign_in_required", `Sign in again to do this (your last sign-in was more than ${Math.round(maxAgeSeconds / 60)} minutes ago)`);
  }
}

export const requireSession = (ctx: Ctx): NonNullable<Ctx["session"]> => {
  if (!ctx.session || ctx.actor.type !== "user" || !ctx.actor.id) throw forbidden("This is for a signed-in person, not an API key");
  return ctx.session;
};

const view = (r: SessionRow, currentId?: string) => ({
  id: sessionPublicId(r.id), method: r.method, signed_in_at: r.signed_in_at.toISOString(), last_seen_at: r.last_seen_at.toISOString(),
  idle_expires_at: r.idle_expires_at.toISOString(), expires_at: r.expires_at.toISOString(), user_agent: r.user_agent, client_address: r.client_address,
  ...(currentId !== undefined ? { current: r.id === currentId } : {}),
});

/** A member's sessions that still work, newest first. */
export async function listSessions(tx: Tx, userId: string, currentId?: string) {
  const rows = await liveSessionsOf(tx, userId);
  return rows.map((r) => view(r, currentId));
}

export type RevokeReason = "signed_out" | "revoked" | "revoked_by_admin" | "other_sessions_revoked" | "member_disabled" | "password_changed";

/** Revokes a member's sessions (all, or all but `exceptId`). Returns how many were still live. */
export async function revokeUserSessions(tx: Tx, userId: string, reason: RevokeReason, exceptId?: string): Promise<number> {
  return revokeSessionsOf(tx, userId, reason, exceptId);
}

/** Revokes one of `userId`'s sessions by public ID. Not found for anyone else's (or an unknown) session. */
export async function revokeOne(tx: Tx, ctx: Ctx, userId: string, publicId: string, reason: RevokeReason) {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "ses") throw notFound("Session");
  const row = await revokeSessionOf(tx, d.uuid, userId, reason);
  if (!row) throw notFound("Session");
  await audit(tx, ctx, { action: reason === "signed_out" ? "auth.signed_out" : "auth.session_revoked", objectType: "user", recordId: userId,
    details: { revoked_session: publicId, reason } });
  return { id: publicId, revoked: true };
}

/**
 * The rules for seeing or acting on another member's sign-in (their sessions, with addresses and
 * browsers, and their SSO link), as for changing the member: members:manage, an owner's only by an
 * owner, and never someone whose role holds permissions or record access the caller doesn't. Listing
 * is held to the same rules as revoking.
 */
export async function assertMayManageSignInOf(tx: Tx, ctx: Ctx, userId: string) {
  if (!can(ctx, "members:manage")) throw forbidden("Managing other members' sign-in needs the members:manage permission");
  const m = await memberRole(tx, userId);
  if (!m) throw notFound("Member");
  if (ctx.actor.type === "user" && ctx.actor.id === userId) return;
  if (m.role === OWNER_ROLE && ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can see or change an owner's sign-in");
  const over = m.permissions.filter((p) => !ctx.permissions.has(p));
  if (over.length) throw forbidden(`This member has permissions you don't hold: ${over.join(", ")}`);
  await assertCoversRole(tx, ctx, await loadSchema(tx), { id: m.role_id, key: m.role, permissions: m.permissions, access_version: m.access_version }, "This member's role");
}

/** Deletes sessions that ended more than a day ago, in every workspace. The worker runs this hourly. */
export async function pruneSessions(): Promise<number> {
  let n = 0;
  for (const t of await tenantIds(db())) {
    n += await db().begin(async (tx) => {
      await enterWorkspace(tx, t);
      return deleteEndedSessions(tx);
    }) as number;
  }
  return n;
}
