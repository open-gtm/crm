import { config } from "../config.js";
import { audit } from "../core/audit.js";
import type { Ctx } from "../core/context.js";
import type { Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { ApiError, conflict, unprocessable } from "../lib/errors.js";
import { LIMITS, emailKey, hit } from "./limits.js";
import { hashPassword, isBreached, passwordProblem } from "./passwords.js";
import { passwordChangeFacts, passwordHashForUpdate, storePasswordHash } from "./queries.js";
import { requireRecentSignIn, requireSession, revokeUserSessions } from "./sessions.js";
import { checkPassword, rateLimited } from "./signin.js";

/**
 * A signed-in member's own password: set a first one, change it, or remove it. A member has no
 * password until they set one here (after signing in by email code, link or SSO). Each change needs
 * the current password, or a sign-in within the last 10 minutes, which is how a reset works: sign in
 * with an email code, then set a new password. Every change ends the member's other sessions. A wrong
 * current password counts toward the same lockout as password sign-in, so a stolen session can't be
 * used to guess it without limit.
 *
 * Split in two so hashing (and the optional breach check) happen outside the route's transaction:
 * `preparePasswordChange` before it, `applyPasswordChange` inside it.
 */

export interface PasswordChange { userId: string; previous: string | null; next: string | null }

export async function preparePasswordChange(ctx: Ctx, input: { password: string | null; current_password?: string | null }): Promise<PasswordChange> {
  requireSession(ctx);
  const userId = ctx.actor.id!;
  const cur = await withTenant(ctx.tenantId, (tx) => passwordChangeFacts(tx, userId));
  if (!cur) throw new ApiError(404, "not_found", "Member not found");
  if (input.password !== null && (!config().PASSWORD_SIGN_IN || !cur.password_sign_in)) {
    throw new ApiError(409, "password_sign_in_off", "Password sign-in is turned off for this workspace");
  }
  if (input.password === null && !cur.password_hash) throw conflict("You don't have a password to remove");
  const current = input.current_password;
  if (cur.password_hash && typeof current === "string" && current.length > 0) {
    const wait = hit(LIMITS.password, emailKey(cur.email));
    if (wait !== null) throw rateLimited(wait);
    const r = await checkPassword({ tenantId: ctx.tenantId, userId }, current, { requestId: ctx.requestId }, { reason: "wrong_current_password", rehash: false });
    if (r === "locked") {
      throw new ApiError(429, "password_locked", "Too many wrong passwords. Wait, or sign in again by email code and change it within 10 minutes");
    }
    if (r === "wrong") throw new ApiError(403, "current_password_wrong", "Your current password is not right");
  } else requireRecentSignIn(ctx);
  if (input.password === null) return { userId, previous: cur.password_hash, next: null };
  const why = passwordProblem(input.password, { email: cur.email, workspaceName: cur.workspace });
  if (why) throw unprocessable(why);
  if (await isBreached(input.password)) throw unprocessable("This password has appeared in a data breach; choose another one");
  return { userId, previous: cur.password_hash, next: await hashPassword(input.password) };
}

export async function applyPasswordChange(tx: Tx, ctx: Ctx, change: PasswordChange) {
  const session = requireSession(ctx);
  const row = await passwordHashForUpdate(tx, change.userId);
  if ((row?.password_hash ?? null) !== change.previous) throw conflict("Your password changed while this request was being checked; try again");
  await storePasswordHash(tx, ctx.tenantId, change.userId, change.next, change.next ? new Date() : null);
  const others = await revokeUserSessions(tx, change.userId, "password_changed", session.id);
  const action = change.next === null ? "auth.password_removed" : change.previous ? "auth.password_changed" : "auth.password_set";
  await audit(tx, ctx, { action, objectType: "user", recordId: change.userId, details: { other_sessions_revoked: others } });
  return { has_password: change.next !== null, other_sessions_revoked: others };
}
