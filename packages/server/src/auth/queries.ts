import type { SignInMethod } from "../core/context.js";
import type { Tx } from "../db/pool.js";
import type { Candidate } from "./identity.js";
import type { RevokeReason } from "./sessions.js";

/**
 * The SQL of sign-in, sessions and members' own credentials (ADR 0009), and of the handlers that read
 * them (/v1/auth, the /auth pages). Every statement in auth/ lives here (ADR 0012): the code that calls
 * these keeps its checks, errors, audits and the order of statements in its transaction.
 */

// --- Row-level security scoping ---------------------------------------------------------------------

/** Lets the transaction read only the sign_in_identities rows of one identity (the identity_lookup policy). */
export async function narrowToIdentity(tx: Tx, kind: "email" | "oidc", value: string): Promise<void> {
  await tx`SELECT set_config('app.identity_kind', ${kind}, true), set_config('app.identity_lookup', ${value}, true)`;
}

/** Lets the transaction see only the flows of this browser cookie and/or link token, by their hashes in hex ("" for none). */
export async function narrowToFlows(tx: Tx, browserHex: string, linkHex: string): Promise<void> {
  await tx`SELECT set_config('app.flow_browser', ${browserHex}, true), set_config('app.flow_link', ${linkHex}, true)`;
}

/** Lets the transaction see expired flows only, to delete them. */
export async function allowFlowPrune(tx: Tx): Promise<void> {
  await tx`SELECT set_config('app.flow_prune', 'on', true)`;
}

/** Lets the transaction find one session by its token hash (hex), before its workspace is known. */
export async function narrowToSessionToken(tx: Tx, hashHex: string): Promise<void> {
  await tx`SELECT set_config('app.session_lookup', ${hashHex}, true)`;
}

/** Ends the session-token lookup and enters the session's workspace. */
export async function enterSessionWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.session_lookup', '', true), set_config('app.tenant_id', ${tenantId}, true)`;
}

/** Enters one workspace in a transaction opened outside withTenant (session pruning walks every workspace). */
export async function enterWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

// --- Identities and memberships ---------------------------------------------------------------------

/**
 * The (workspace, member) pairs of one identity, at most `limit`: members stored with exactly
 * `exactAddress` first, then by workspace. `tenant` narrows to one workspace.
 */
export async function identityMembers(tx: Tx, q: { kind: "email" | "oidc"; value: string; tenant?: string | null; exactAddress: string | null; limit: number }) {
  return tx<{ tenant_id: string; user_id: string }[]>`
      SELECT tenant_id, user_id FROM sign_in_identities WHERE kind = ${q.kind} AND value = ${q.value} ${q.tenant ? tx`AND tenant_id = ${q.tenant}` : tx``}
      ORDER BY address IS NOT DISTINCT FROM ${q.exactAddress} DESC, tenant_id, user_id LIMIT ${q.limit}`;
}

export interface SignInMemberRow { email: string; name: string; role: string; workspace: string; password_sign_in: boolean; password_hash: string | null;
  sso_sign_in: boolean; sso_allowed_domains: string[]; oidc_issuer: string | null; oidc_subject: string | null }

/** A member who can sign in now (active, role not archived), with their workspace's sign-in settings and their credentials. */
export async function signInMember(tx: Tx, userId: string): Promise<SignInMemberRow | undefined> {
  const [r] = await tx<SignInMemberRow[]>`
        SELECT u.email::text, u.name, r.key AS role, t.name AS workspace, t.password_sign_in, c.password_hash, t.sso_sign_in, t.sso_allowed_domains,
               c.oidc_issuer, c.oidc_subject
        FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id CROSS JOIN tenants t
        LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id
        WHERE u.id = ${userId} AND u.disabled_at IS NULL AND r.archived_at IS NULL`;
  return r;
}

/** A member's display name (the inviter, in an invitation email). */
export async function memberName(tx: Tx, userId: string): Promise<{ name: string } | undefined> {
  const [r] = await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${userId}`;
  return r;
}

/** A member's role and its permissions, whatever their state. */
export async function memberRole(tx: Tx, userId: string): Promise<{ role: string; permissions: string[] } | undefined> {
  const [m] = await tx<{ role: string; permissions: string[] }[]>`
    SELECT r.key AS role, r.permissions FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id WHERE u.id = ${userId}`;
  return m;
}

// --- Sign-in flows ----------------------------------------------------------------------------------

export interface FlowRow { id: string; purpose: string; browser_hash: Buffer | null; link_hash: Buffer | null; code_hash: Buffer | null; attempts: number;
  candidates: Candidate[]; method: SignInMethod | null; return_to: string | null; workspace_id: string | null; more_workspaces: boolean;
  expires_at: Date; consumed_at: Date | null }

/** The columns of a FlowRow, as a fragment of the query that selects or returns them. */
const flowColumns = (tx: Tx) =>
  tx`id, purpose, browser_hash, link_hash, code_hash, attempts, candidates, method, return_to, workspace_id, more_workspaces, expires_at, consumed_at`;

export async function insertSignInFlow(tx: Tx, f: { id: string; browserHash: Buffer | null; linkHash: Buffer | null; purpose: string; codeHash: Buffer | null;
  candidates: Candidate[]; method: SignInMethod | null; returnTo: string | null; more: boolean; minutes: number }): Promise<void> {
  await tx`INSERT INTO sign_in_flows (id, browser_hash, link_hash, purpose, code_hash, candidates, method, return_to, more_workspaces, expires_at)
           VALUES (${f.id}, ${f.browserHash}, ${f.linkHash}, ${f.purpose}, ${f.codeHash},
                   ${tx.json(f.candidates as never)}, ${f.method}, ${f.returnTo}, ${f.more},
                   now() + make_interval(mins => ${f.minutes}))`;
}

/** The newest workspace choice this browser can see, used or not. */
export async function latestChoiceFlow(tx: Tx): Promise<FlowRow | undefined> {
  return (await tx<FlowRow[]>`SELECT ${flowColumns(tx)} FROM sign_in_flows WHERE purpose = 'choose' ORDER BY created_at DESC LIMIT 1`)[0];
}

/** Uses up this browser's live workspace choice, returning it; undefined when there is none. */
export async function consumeChoiceFlow(tx: Tx): Promise<FlowRow | undefined> {
  return (await tx<FlowRow[]>`UPDATE sign_in_flows SET consumed_at = now() WHERE purpose = 'choose' AND consumed_at IS NULL AND expires_at > now() RETURNING ${flowColumns(tx)}`)[0];
}

/** Fills in the memberships an email flow signs in, once they are known. */
export async function setFlowCandidates(tx: Tx, id: string, candidates: Candidate[], more: boolean): Promise<void> {
  await tx`UPDATE sign_in_flows SET candidates = ${tx.json(candidates as never)}, more_workspaces = ${more} WHERE id = ${id}`;
}

/** This browser's email flows, oldest first, locked. */
export async function emailFlowsForUpdate(tx: Tx): Promise<FlowRow[]> {
  return tx<FlowRow[]>`SELECT ${flowColumns(tx)} FROM sign_in_flows WHERE purpose = 'email' ORDER BY created_at, id FOR UPDATE`;
}

/** Records a wrong code against every unused email flow of this browser; `consumedAt` voids them. */
export async function recordWrongCode(tx: Tx, attempts: number, consumedAt: Date | null): Promise<void> {
  await tx`UPDATE sign_in_flows SET attempts = ${attempts}, consumed_at = ${consumedAt}
               WHERE purpose = 'email' AND consumed_at IS NULL`;
}

/** Uses up every unused email flow this transaction can see. */
export async function consumeEmailFlows(tx: Tx): Promise<void> {
  await tx`UPDATE sign_in_flows SET consumed_at = now() WHERE purpose = 'email' AND consumed_at IS NULL`;
}

/** The email flow of a link token, locked. */
export async function emailFlowByLinkForUpdate(tx: Tx, linkHash: Buffer): Promise<FlowRow | undefined> {
  const [f] = await tx<FlowRow[]>`SELECT ${flowColumns(tx)} FROM sign_in_flows WHERE link_hash = ${linkHash} AND purpose = 'email' FOR UPDATE`;
  return f;
}

/** Uses up every unused email flow of one browser. */
export async function consumeEmailFlowsOfBrowser(tx: Tx, browserHash: Buffer): Promise<void> {
  await tx`UPDATE sign_in_flows SET consumed_at = now() WHERE purpose = 'email' AND consumed_at IS NULL AND browser_hash = ${browserHash}`;
}

/** Uses up the live server-printed link with this hash, returning it; undefined when there is none. */
export async function consumeServerLinkFlow(tx: Tx, linkHash: Buffer): Promise<FlowRow | undefined> {
  return (await tx<FlowRow[]>`UPDATE sign_in_flows SET consumed_at = now() WHERE link_hash = ${linkHash} AND purpose = 'server_link' AND consumed_at IS NULL AND expires_at > now()
     RETURNING ${flowColumns(tx)}`)[0];
}

export async function insertSsoFlow(tx: Tx, f: { browserHash: Buffer; returnTo: string; workspaceId: string | null; minutes: number }): Promise<void> {
  await tx`
    INSERT INTO sign_in_flows (id, browser_hash, purpose, return_to, workspace_id, expires_at)
    VALUES (gen_random_uuid(), ${f.browserHash}, 'oidc', ${f.returnTo}, ${f.workspaceId}, now() + make_interval(mins => ${f.minutes}))`;
}

/** Uses up this browser's live single sign-on flow, returning where it goes; undefined when there is none. */
export async function consumeSsoFlow(tx: Tx): Promise<{ return_to: string | null; workspace_id: string | null } | undefined> {
  return (await tx<{ return_to: string | null; workspace_id: string | null }[]>`
    UPDATE sign_in_flows SET consumed_at = now() WHERE purpose = 'oidc' AND consumed_at IS NULL AND expires_at > now() RETURNING return_to, workspace_id`)[0];
}

/** Deletes the expired flows the transaction can see (after allowFlowPrune). Returns how many. */
export async function deleteExpiredFlows(tx: Tx): Promise<number> {
  return (await tx`DELETE FROM sign_in_flows WHERE expires_at < now() RETURNING 1`).length;
}

// --- Member credentials -----------------------------------------------------------------------------

/** What a password change is checked against: the member's email, workspace name, current hash, and whether the workspace allows passwords. */
export async function passwordChangeFacts(tx: Tx, userId: string) {
  return (await tx<{ email: string; workspace: string; password_hash: string | null; password_sign_in: boolean }[]>`
    SELECT u.email::text, t.name AS workspace, c.password_hash, t.password_sign_in FROM users u CROSS JOIN tenants t
    LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id WHERE u.id = ${userId}`)[0];
}

/** The member's current password hash, locking their credentials row until the transaction ends. */
export async function passwordHashForUpdate(tx: Tx, userId: string): Promise<{ password_hash: string | null } | undefined> {
  const [row] = await tx<{ password_hash: string | null }[]>`
    SELECT password_hash FROM member_credentials WHERE user_id = ${userId} FOR UPDATE`;
  return row;
}

/** Sets (or, with null, removes) a member's password hash and clears the lockout. */
export async function storePasswordHash(tx: Tx, tenantId: string, userId: string, hash: string | null, setAt: Date | null): Promise<void> {
  await tx`INSERT INTO member_credentials (tenant_id, user_id, password_hash, password_set_at) VALUES (${tenantId}, ${userId}, ${hash}, ${setAt})
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, password_set_at = EXCLUDED.password_set_at,
             password_failures = 0, password_locked_until = NULL`;
}

/**
 * Counts one password attempt against a member who has a password and isn't locked, locking them
 * once the count reaches `lockAfter`. Returns the new count and the hash to check; undefined when
 * the member is locked or has no password.
 */
export async function countPasswordAttempt(tx: Tx, userId: string, lockAfter: number): Promise<{ failures: number; hash: string } | undefined> {
  const [slot] = await tx<{ failures: number; hash: string }[]>`
    UPDATE member_credentials SET password_failures = password_failures + 1,
      password_locked_until = CASE WHEN password_failures + 1 >= ${lockAfter}
        THEN now() + make_interval(mins => least(power(2, password_failures + 1 - ${lockAfter}), 60)::int) END
    WHERE user_id = ${userId} AND password_hash IS NOT NULL AND (password_locked_until IS NULL OR password_locked_until <= now())
    RETURNING password_failures AS failures, password_hash AS hash`;
  return slot;
}

export async function clearPasswordFailures(tx: Tx, userId: string): Promise<void> {
  await tx`UPDATE member_credentials SET password_failures = 0, password_locked_until = NULL WHERE user_id = ${userId}`;
}

/** Replaces the hash only if it is still `previous`, so a rehash never overwrites a password changed meanwhile. */
export async function replacePasswordHash(tx: Tx, userId: string, next: string, previous: string): Promise<void> {
  await tx`UPDATE member_credentials SET password_hash = ${next} WHERE user_id = ${userId} AND password_hash = ${previous}`;
}

/** Records a successful sign-in, which also clears the password lockout. */
export async function recordSignIn(tx: Tx, tenantId: string, userId: string): Promise<void> {
  await tx`INSERT INTO member_credentials (tenant_id, user_id, last_sign_in_at) VALUES (${tenantId}, ${userId}, now())
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_sign_in_at = now(), password_failures = 0, password_locked_until = NULL`;
}

/** Links a member to a provider subject unless they are already linked to one. True when this call linked them. */
export async function linkSsoSubject(tx: Tx, tenantId: string, userId: string, issuer: string, subject: string): Promise<boolean> {
  const linkedNow = await tx`
        INSERT INTO member_credentials (tenant_id, user_id, oidc_issuer, oidc_subject, oidc_linked_at) VALUES (${tenantId}, ${userId}, ${issuer}, ${subject}, now())
        ON CONFLICT (tenant_id, user_id) DO UPDATE SET oidc_issuer = EXCLUDED.oidc_issuer, oidc_subject = EXCLUDED.oidc_subject, oidc_linked_at = now()
          WHERE member_credentials.oidc_subject IS NULL RETURNING 1`;
  return linkedNow.length > 0;
}

/** Removes a member's single sign-on link, returning the issuer it had; undefined when there was none. */
export async function removeSsoLink(tx: Tx, userId: string): Promise<{ issuer: string } | undefined> {
  const [old] = await tx<{ issuer: string }[]>`
    UPDATE member_credentials c SET oidc_issuer = NULL, oidc_subject = NULL, oidc_linked_at = NULL
    FROM (SELECT user_id, oidc_issuer FROM member_credentials WHERE user_id = ${userId} AND oidc_subject IS NOT NULL FOR UPDATE) old
    WHERE c.user_id = old.user_id RETURNING old.oidc_issuer AS issuer`;
  return old;
}

// --- Sessions ---------------------------------------------------------------------------------------

export async function insertSession(tx: Tx, s: { tenantId: string; id: string; userId: string; tokenHash: Buffer; method: SignInMethod; idleExpiresAt: Date;
  expiresAt: Date; userAgent: string | null; address: string | null }): Promise<{ signed_in_at: Date } | undefined> {
  const [row] = await tx<{ signed_in_at: Date }[]>`
    INSERT INTO sessions (tenant_id, id, user_id, token_hash, method, idle_expires_at, expires_at, user_agent, client_address)
    VALUES (${s.tenantId}, ${s.id}, ${s.userId}, ${s.tokenHash}, ${s.method}, ${s.idleExpiresAt}, ${s.expiresAt},
            ${s.userAgent}, ${s.address})
    RETURNING signed_in_at`;
  return row;
}

export interface SessionByTokenRow { tenant_id: string; id: string; user_id: string; token_hash: Buffer; method: SignInMethod; signed_in_at: Date;
  last_seen_at: Date; idle_expires_at: Date; expires_at: Date; revoked_at: Date | null }

/** The session with this token hash, in whatever state (after narrowToSessionToken). */
export async function sessionByTokenHash(tx: Tx, hash: Buffer): Promise<SessionByTokenRow | undefined> {
  const [s] = await tx<SessionByTokenRow[]>`
      SELECT tenant_id, id, user_id, token_hash, method, signed_in_at, last_seen_at, idle_expires_at, expires_at, revoked_at
      FROM sessions WHERE token_hash = ${hash}`;
  return s;
}

/** Marks a session seen now and pushes its idle expiry out by `idleSeconds`, never past its absolute expiry. */
export async function touchSession(tx: Tx, id: string, idleSeconds: number): Promise<void> {
  await tx`UPDATE sessions SET last_seen_at = now(), idle_expires_at = least(now() + make_interval(secs => ${idleSeconds}), expires_at)
               WHERE id = ${id}`;
}

export interface SessionRow { id: string; method: string; signed_in_at: Date; last_seen_at: Date; idle_expires_at: Date; expires_at: Date;
  user_agent: string | null; client_address: string | null; revoked_at: Date | null; revoked_reason: string | null }

/** A member's sessions that still work, newest first, at most 200. */
export async function liveSessionsOf(tx: Tx, userId: string): Promise<SessionRow[]> {
  return tx<SessionRow[]>`
    SELECT id, method, signed_in_at, last_seen_at, idle_expires_at, expires_at, user_agent, client_address, revoked_at, revoked_reason
    FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now()
    ORDER BY signed_in_at DESC LIMIT 200`;
}

/** Revokes a member's unexpired sessions (all, or all but `exceptId`). Returns how many were still live. */
export async function revokeSessionsOf(tx: Tx, userId: string, reason: RevokeReason, exceptId?: string): Promise<number> {
  const rows = await tx`UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
                        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() ${exceptId ? tx`AND id <> ${exceptId}` : tx``} RETURNING id`;
  return rows.length;
}

/** Revokes one session of `userId` (keeping the first revocation's time and reason). Undefined when it isn't theirs or doesn't exist. */
export async function revokeSessionOf(tx: Tx, sessionId: string, userId: string, reason: RevokeReason): Promise<{ id: string } | undefined> {
  const [row] = await tx<{ id: string }[]>`UPDATE sessions SET revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, ${reason})
                                           WHERE id = ${sessionId} AND user_id = ${userId} RETURNING id`;
  return row;
}

/** The member a session belongs to, whatever its state. */
export async function sessionOwner(tx: Tx, sessionId: string): Promise<{ user_id: string } | undefined> {
  const [row] = await tx<{ user_id: string }[]>`SELECT user_id FROM sessions WHERE id = ${sessionId}`;
  return row;
}

/** Deletes sessions that ended more than a day ago, in the workspace the transaction is in. Returns how many. */
export async function deleteEndedSessions(tx: Tx): Promise<number> {
  const rows = await tx`DELETE FROM sessions WHERE least(expires_at, idle_expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '1 day' RETURNING 1`;
  return rows.length;
}

// --- What the session and account pages show --------------------------------------------------------

/** GET /v1/auth/session: the session's expiry and its member, with whether they have a password or an SSO link. */
export async function sessionInfo(tx: Tx, sessionId: string) {
  const [row] = await tx<{ expires_at: Date; idle_expires_at: Date; email: string; name: string; has_password: boolean; sso_linked: boolean }[]>`
      SELECT s.expires_at, s.idle_expires_at, u.email::text, u.name,
             coalesce(c.password_hash IS NOT NULL, false) AS has_password, coalesce(c.oidc_subject IS NOT NULL, false) AS sso_linked
      FROM sessions s JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id
      LEFT JOIN member_credentials c ON c.tenant_id = s.tenant_id AND c.user_id = s.user_id
      WHERE s.id = ${sessionId}`;
  return row;
}

/** The /auth/signed-in page: the member, workspace and session expiry, and whether they have (and may have) a password. */
export async function signedInPageFacts(tx: Tx, sessionId: string) {
  return (await tx<{ name: string; email: string; workspace: string; expires_at: Date; has_password: boolean; allowed: boolean }[]>`
      SELECT u.name, u.email::text, t.name AS workspace, s.expires_at, c.password_hash IS NOT NULL AS has_password, t.password_sign_in AS allowed
      FROM sessions s JOIN users u ON u.tenant_id = s.tenant_id AND u.id = s.user_id CROSS JOIN tenants t
      LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id WHERE s.id = ${sessionId}`)[0];
}

/** The /auth/password page: whether the member has a password and whether the workspace allows them. */
export async function passwordPageFacts(tx: Tx, userId: string) {
  return (await tx<{ has_password: boolean; allowed: boolean }[]>`
      SELECT c.password_hash IS NOT NULL AS has_password, t.password_sign_in AS allowed FROM users u CROSS JOIN tenants t
      LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id WHERE u.id = ${userId}`)[0];
}
