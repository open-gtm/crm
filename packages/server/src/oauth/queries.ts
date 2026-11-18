import type { Scope } from "../core/context.js";
import type { Tx } from "../db/pool.js";
import type { Client } from "./clients.js";
import type { GrantRevokeReason } from "./grants.js";

/**
 * The SQL of OAuth (ADR 0010): clients, authorization codes, grants and their tokens, and the
 * assertions private_key_jwt clients sign. Every statement in oauth/ lives here (ADR 0012): the code
 * that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

// --- Row-level security scoping ---------------------------------------------------------------------

/** Enters one workspace in a transaction opened outside withTenant (pruning walks every workspace). */
export async function enterWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

/** Lets the transaction see only the client with this client_id (the client_lookup policy). */
export async function narrowToClient(tx: Tx, clientId: string): Promise<void> {
  await tx`SELECT set_config('app.oauth_client', ${clientId}, true)`;
}

/** Lets the transaction count and evict clients across the registry, and write the client with this client_id. */
export async function openClientRegistry(tx: Tx, clientId: string): Promise<void> {
  await tx`SELECT set_config('app.oauth_registry', 'on', true), set_config('app.oauth_client', ${clientId}, true)`;
}

/** Lets the transaction see lapsed clients and expired assertion IDs, to delete them. */
export async function allowClientPrune(tx: Tx): Promise<void> {
  await tx`SELECT set_config('app.oauth_prune', 'on', true)`;
}

/** Lets the transaction see only the assertion ID with this hash (hex). */
export async function narrowToAssertion(tx: Tx, jtiHex: string): Promise<void> {
  await tx`SELECT set_config('app.oauth_jti', ${jtiHex}, true)`;
}

/** Lets the transaction find one access or refresh token by its hash (hex), before its workspace is known. */
export async function narrowToTokenHash(tx: Tx, hashHex: string): Promise<void> {
  await tx`SELECT set_config('app.oauth_token_lookup', ${hashHex}, true)`;
}

/** Lets the transaction find one code or token by its hash (hex) through the lookup policy `setting` names. */
export async function narrowToSecretLookup(tx: Tx, setting: "app.oauth_code_lookup" | "app.oauth_token_lookup", hashHex: string): Promise<void> {
  await tx`SELECT set_config(${setting}, ${hashHex}, true)`;
}

/** Ends the token lookup and enters the token's workspace. */
export async function enterTokenWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.oauth_token_lookup', '', true), set_config('app.tenant_id', ${tenantId}, true)`;
}

// --- Workspace and member ---------------------------------------------------------------------------

/** Whether the workspace lets apps connect, and the scopes it lets them have. */
export async function workspaceOAuth(tx: Tx): Promise<{ oauth_apps: boolean; oauth_scopes: string[] } | undefined> {
  const [w] = await tx<{ oauth_apps: boolean; oauth_scopes: string[] }[]>`SELECT oauth_apps, oauth_scopes FROM tenants`;
  return w;
}

/** The workspace's name, whether it lets apps connect and the scopes it lets them have (the consent page). */
export async function consentWorkspace(tx: Tx): Promise<{ name: string; oauth_apps: boolean; oauth_scopes: string[] } | undefined> {
  const [t] = await tx<{ name: string; oauth_apps: boolean; oauth_scopes: string[] }[]>`SELECT name, oauth_apps, oauth_scopes FROM tenants`;
  return t;
}

/** The scopes the workspace lets apps have. */
export async function workspaceOAuthScopes(tx: Tx): Promise<{ oauth_scopes: string[] } | undefined> {
  const [w] = await tx<{ oauth_scopes: string[] }[]>`SELECT oauth_scopes FROM tenants`;
  return w;
}

/** Whether the workspace lets apps connect. */
export async function workspaceAllowsApps(tx: Tx): Promise<{ oauth_apps: boolean } | undefined> {
  const [w] = await tx<{ oauth_apps: boolean }[]>`SELECT oauth_apps FROM tenants`;
  return w;
}

/** A member's name and email (the consent page). */
export async function memberNameAndEmail(tx: Tx, userId: string): Promise<{ name: string; email: string } | undefined> {
  const [u] = await tx<{ name: string; email: string }[]>`SELECT name, email::text FROM users WHERE id = ${userId}`;
  return u;
}

/** Whether a session still works: not revoked, nor past its absolute or idle expiry. Undefined when there is no such session. */
export async function sessionStillValid(tx: Tx, sessionId: string): Promise<{ ok: boolean } | undefined> {
  const [s] = await tx<{ ok: boolean }[]>`SELECT revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now() AS ok FROM sessions WHERE id = ${sessionId}`;
  return s;
}

// --- Clients ----------------------------------------------------------------------------------------

export interface ClientRow { client_id: string; kind: Client["kind"]; client_name: string; client_uri: string | null; redirect_uris: string[];
  application_type: Client["applicationType"]; token_endpoint_auth_method: Client["authMethod"]; jwks_uri: string | null; expires_at: Date }

/** The stored client with this client_id (after narrowToClient), whatever its state. */
export async function storedClientRow(tx: Tx, clientId: string): Promise<ClientRow | null> {
  return (await tx<ClientRow[]>`
    SELECT client_id, kind, client_name, client_uri, redirect_uris, application_type, token_endpoint_auth_method, jwks_uri, expires_at
    FROM oauth_clients WHERE client_id = ${clientId}`)[0] ?? null;
}

/** Records that a client was used for a grant; a registration is kept at least `days` from now. */
export async function markClientUsed(tx: Tx, clientId: string, days: number): Promise<void> {
  await tx`UPDATE oauth_clients SET last_used_at = now(),
    expires_at = CASE WHEN kind = 'registered' THEN greatest(expires_at, now() + make_interval(days => ${days})) ELSE expires_at END
    WHERE client_id = ${clientId}`;
}

/** Whether a client with this client_id is stored, in any state. */
export async function clientExists(tx: Tx, clientId: string): Promise<boolean> {
  const [exists] = await tx`SELECT 1 FROM oauth_clients WHERE client_id = ${clientId}`;
  return !!exists;
}

/**
 * Deletes one cached metadata document, expired ones first, then the least recently used. With
 * `hostPrefix`, only among the documents whose client_id starts with it (one host's).
 */
export async function evictLeastRecentDocument(tx: Tx, hostPrefix: string | null): Promise<void> {
  await tx`DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE kind = 'metadata_document'
          ${hostPrefix ? tx`AND starts_with(client_id, ${hostPrefix})` : tx``} ORDER BY expires_at <= now() DESC, coalesce(last_used_at, created_at) LIMIT 1)`;
}

/** How many metadata documents of one host (client_ids starting with `prefix`) are cached, expired or not. */
export async function countHostDocuments(tx: Tx, prefix: string): Promise<number> {
  const [host] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_clients WHERE kind = 'metadata_document' AND starts_with(client_id, ${prefix})`;
  return host!.n;
}

/** How many cached metadata documents are unexpired. */
export async function countLiveDocuments(tx: Tx): Promise<number> {
  const [all] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_clients WHERE kind = 'metadata_document' AND expires_at > now()`;
  return all!.n;
}

/** Deletes up to 100 expired metadata documents, oldest expiry first. Returns how many. */
export async function deleteExpiredDocuments(tx: Tx): Promise<number> {
  const expired = await tx`DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE kind = 'metadata_document' AND expires_at <= now()
              ORDER BY expires_at LIMIT 100) RETURNING 1`;
  return expired.length;
}

/** Stores a fetched metadata document for `seconds`, or updates the cached copy (never a registration with the same client_id). */
export async function upsertDocument(tx: Tx, id: string, c: Client, seconds: number): Promise<void> {
  await tx`INSERT INTO oauth_clients (id, client_id, kind, client_name, client_uri, redirect_uris, application_type, token_endpoint_auth_method, jwks_uri, expires_at)
               VALUES (${id}, ${c.clientId}, 'metadata_document', ${c.name}, ${c.clientUri}, ${c.redirectUris}, ${c.applicationType}, ${c.authMethod},
                       ${c.jwksUri}, now() + make_interval(secs => ${seconds}))
               ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, client_uri = EXCLUDED.client_uri, redirect_uris = EXCLUDED.redirect_uris,
                 application_type = EXCLUDED.application_type, token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method, jwks_uri = EXCLUDED.jwks_uri,
                 expires_at = EXCLUDED.expires_at
               WHERE oauth_clients.kind = 'metadata_document'`;
}

/** How many registrations are unexpired. */
export async function countLiveRegistrations(tx: Tx): Promise<number> {
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_clients WHERE kind = 'registered' AND expires_at > now()`;
  return count!.n;
}

/** Deletes the oldest registration never used for a token and older than `minutes`. Returns how many (0 or 1). */
export async function evictOldestUnusedRegistration(tx: Tx, minutes: number): Promise<number> {
  const evicted = await tx`DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE kind = 'registered' AND last_used_at IS NULL
        AND created_at < now() - make_interval(mins => ${minutes}) ORDER BY created_at LIMIT 1) RETURNING 1`;
  return evicted.length;
}

/** Stores a new public registration that lapses after `hours` unless used. Returns when it was created. */
export async function insertRegistration(tx: Tx, r: { id: string; clientId: string; name: string; clientUri: string | null; redirectUris: string[];
  applicationType: Client["applicationType"]; hours: number }): Promise<Date> {
  const [row] = await tx<{ created_at: Date }[]>`
      INSERT INTO oauth_clients (id, client_id, kind, client_name, client_uri, redirect_uris, application_type, token_endpoint_auth_method, expires_at)
      VALUES (${r.id}, ${r.clientId}, 'registered', ${r.name}, ${r.clientUri}, ${r.redirectUris}, ${r.applicationType}, 'none',
              now() + make_interval(hours => ${r.hours}))
      RETURNING created_at`;
  return row!.created_at;
}

/** Deletes lapsed registrations at once and cached documents a day past their expiry (after allowClientPrune). Returns how many. */
export async function deleteLapsedClients(tx: Tx): Promise<number> {
  const a = await tx`DELETE FROM oauth_clients WHERE expires_at < now() - CASE WHEN kind = 'registered' THEN interval '0' ELSE interval '1 day' END RETURNING 1`;
  return a.length;
}

// --- Client assertions ------------------------------------------------------------------------------

/** Records a private_key_jwt assertion ID (after narrowToAssertion). False when it was already recorded: the assertion is a replay. */
export async function recordAssertion(tx: Tx, jtiHash: Buffer, expiresAt: Date): Promise<boolean> {
  return (await tx`INSERT INTO oauth_assertions (jti_hash, expires_at) VALUES (${jtiHash}, ${expiresAt}) ON CONFLICT DO NOTHING RETURNING 1`).length > 0;
}

/** Deletes expired assertion IDs (after allowClientPrune). Returns how many. */
export async function deleteExpiredAssertions(tx: Tx): Promise<number> {
  const b = await tx`DELETE FROM oauth_assertions WHERE expires_at < now() RETURNING 1`;
  return b.length;
}

// --- Authorization codes ----------------------------------------------------------------------------

/** The workspace and ID of the code with this hash (after narrowToSecretLookup). */
export async function codeLocation(tx: Tx, hash: Buffer): Promise<{ tenant_id: string; id: string } | undefined> {
  const [row] = await tx<{ tenant_id: string; id: string }[]>`SELECT tenant_id, id FROM oauth_codes WHERE code_hash = ${hash}`;
  return row;
}

export async function insertCode(tx: Tx, c: { tenantId: string; id: string; codeHash: Buffer; userId: string; sessionId: string; clientId: string; clientName: string;
  clientKind: string; redirectUri: string; codeChallenge: string; resource: string; scopes: Scope[]; seconds: number }): Promise<void> {
  await tx`INSERT INTO oauth_codes (tenant_id, id, code_hash, user_id, session_id, client_id, client_name, client_kind, redirect_uri, code_challenge, resource, scopes, expires_at)
           VALUES (${c.tenantId}, ${c.id}, ${c.codeHash}, ${c.userId}, ${c.sessionId}, ${c.clientId}, ${c.clientName}, ${c.clientKind},
                   ${c.redirectUri}, ${c.codeChallenge}, ${c.resource}, ${c.scopes}, now() + make_interval(secs => ${c.seconds}))`;
}

export interface CodeRow { id: string; code_hash: Buffer; user_id: string; session_id: string; client_id: string; client_name: string; client_kind: string;
  redirect_uri: string; code_challenge: string; resource: string; scopes: string[]; expires_at: Date; used_at: Date | null; grant_id: string | null }

/** A code by ID, in whatever state, locked. */
export async function codeForUpdate(tx: Tx, id: string): Promise<CodeRow | undefined> {
  const [c] = await tx<CodeRow[]>`
      SELECT id, code_hash, user_id, session_id, client_id, client_name, client_kind, redirect_uri, code_challenge, resource, scopes, expires_at, used_at, grant_id
      FROM oauth_codes WHERE id = ${id} FOR UPDATE`;
  return c;
}

/** Uses up a code. False when it was already used. */
export async function markCodeUsed(tx: Tx, id: string): Promise<boolean> {
  const used = await tx`UPDATE oauth_codes SET used_at = now() WHERE id = ${id} AND used_at IS NULL RETURNING 1`;
  return used.length > 0;
}

/** Records the grant a code was redeemed for, so a second use can revoke it. */
export async function setCodeGrant(tx: Tx, codeId: string, grantId: string): Promise<void> {
  await tx`UPDATE oauth_codes SET grant_id = ${grantId} WHERE id = ${codeId}`;
}

/** How many unrevoked, unexpired grants a member has. */
export async function countLiveGrants(tx: Tx, userId: string): Promise<number> {
  const [live] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_grants WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now()`;
  return live!.n;
}

/** Deletes codes a day past their expiry, in the workspace the transaction is in. Returns how many. */
export async function deleteEndedCodes(tx: Tx): Promise<number> {
  const codes = await tx`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day' RETURNING 1`;
  return codes.length;
}

// --- Grants -----------------------------------------------------------------------------------------

/** Revokes a member's live grants of one client and resource ('replaced'), returning their IDs. */
export async function replaceLiveGrants(tx: Tx, userId: string, clientId: string, resource: string): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    UPDATE oauth_grants SET revoked_at = now(), revoked_reason = 'replaced'
    WHERE user_id = ${userId} AND client_id = ${clientId} AND resource = ${resource} AND revoked_at IS NULL RETURNING id`;
}

/** Stores a new grant lasting `days`. Returns its expiry. */
export async function insertGrant(tx: Tx, g: { tenantId: string; id: string; userId: string; sessionId: string; clientId: string; clientName: string;
  clientKind: string; redirectUri: string; scopes: string[]; resource: string; days: number }): Promise<{ expires_at: Date } | undefined> {
  const [row] = await tx<{ expires_at: Date }[]>`
    INSERT INTO oauth_grants (tenant_id, id, user_id, session_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, expires_at)
    VALUES (${g.tenantId}, ${g.id}, ${g.userId}, ${g.sessionId}, ${g.clientId}, ${g.clientName}, ${g.clientKind}, ${g.redirectUri}, ${g.scopes}, ${g.resource},
            now() + make_interval(days => ${g.days}))
    RETURNING expires_at`;
  return row;
}

/** Revokes a grant (not its tokens). False when it was already revoked. */
export async function markGrantRevoked(tx: Tx, grantId: string, reason: GrantRevokeReason): Promise<boolean> {
  const rows = await tx`UPDATE oauth_grants SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${grantId} AND revoked_at IS NULL RETURNING 1`;
  return rows.length > 0;
}

/** Revokes every live grant of a member (or, with no member, of the whole workspace), not their tokens, returning their IDs. */
export async function revokeLiveGrantsOf(tx: Tx, userId: string | null, reason: GrantRevokeReason): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`UPDATE oauth_grants SET revoked_at = now(), revoked_reason = ${reason}
    WHERE revoked_at IS NULL ${userId ? tx`AND user_id = ${userId}` : tx``} RETURNING id`;
}

export interface AccessGrantRow { user_id: string; client_id: string; scopes: string[]; resource: string; expires_at: Date; revoked_at: Date | null; last_used_at: Date | null }

/** What an access token's use is checked against: its grant, in whatever state. */
export async function grantForAccess(tx: Tx, grantId: string): Promise<AccessGrantRow | undefined> {
  const [g] = await tx<AccessGrantRow[]>`
      SELECT user_id, client_id, scopes, resource, expires_at, revoked_at, last_used_at FROM oauth_grants WHERE id = ${grantId}`;
  return g;
}

export interface RefreshGrantRow { id: string; user_id: string; client_id: string; scopes: string[]; resource: string; expires_at: Date; revoked_at: Date | null }

/** A grant by ID, in whatever state, locked (a refresh). */
export async function grantForUpdate(tx: Tx, grantId: string): Promise<RefreshGrantRow | undefined> {
  const [g] = await tx<RefreshGrantRow[]>`
      SELECT id, user_id, client_id, scopes, resource, expires_at, revoked_at FROM oauth_grants WHERE id = ${grantId} FOR UPDATE`;
  return g;
}

/** The member and client of a grant, in whatever state. */
export async function grantMemberAndClient(tx: Tx, grantId: string): Promise<{ user_id: string; client_id: string } | undefined> {
  const [g] = await tx<{ user_id: string; client_id: string }[]>`SELECT user_id, client_id FROM oauth_grants WHERE id = ${grantId}`;
  return g;
}

/** The member and client of an unrevoked grant. */
export async function unrevokedGrantOwner(tx: Tx, grantId: string): Promise<{ user_id: string; client_id: string } | undefined> {
  const [g] = await tx<{ user_id: string; client_id: string }[]>`SELECT user_id, client_id FROM oauth_grants WHERE id = ${grantId} AND revoked_at IS NULL`;
  return g;
}

/** Marks a grant used now. */
export async function markGrantUsed(tx: Tx, grantId: string): Promise<void> {
  await tx`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${grantId}`;
}

export interface GrantRow { id: string; user_id: string; client_id: string; client_name: string; client_kind: string; redirect_uri: string; scopes: string[];
  resource: string; created_at: Date; last_used_at: Date | null; expires_at: Date }

/** Live grants of one member (or every member), newest first, at most `limit`. */
export async function liveGrants(tx: Tx, userId: string | null, limit: number): Promise<GrantRow[]> {
  return tx<GrantRow[]>`
    SELECT id, user_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, created_at, last_used_at, expires_at
    FROM oauth_grants WHERE revoked_at IS NULL AND expires_at > now() ${userId ? tx`AND user_id = ${userId}` : tx``}
    ORDER BY created_at DESC LIMIT ${limit}`;
}

/** Deletes grants revoked or expired more than 90 days ago, in the workspace the transaction is in. Returns how many. */
export async function deleteEndedGrants(tx: Tx): Promise<number> {
  const grants = await tx`DELETE FROM oauth_grants WHERE least(expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '90 days' RETURNING 1`;
  return grants.length;
}

// --- Tokens -----------------------------------------------------------------------------------------

/** Stores a grant's new access token (with `scopes`, null for the grant's) and refresh token, by their hashes. */
export async function insertTokenPair(tx: Tx, t: { tenantId: string; grantId: string; scopes: Scope[] | null;
  access: { id: string; hash: Buffer; expiresAt: Date }; refresh: { id: string; hash: Buffer; expiresAt: Date } }): Promise<void> {
  await tx`INSERT INTO oauth_tokens (tenant_id, id, grant_id, kind, token_hash, scopes, expires_at)
           VALUES (${t.tenantId}, ${t.access.id}, ${t.grantId}, 'access', ${t.access.hash}, ${t.scopes}, ${t.access.expiresAt}),
                  (${t.tenantId}, ${t.refresh.id}, ${t.grantId}, 'refresh', ${t.refresh.hash}, NULL, ${t.refresh.expiresAt})`;
}

/** Revokes the unrevoked tokens of one grant. */
export async function revokeTokensOfGrant(tx: Tx, grantId: string): Promise<void> {
  await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = ${grantId} AND revoked_at IS NULL`;
}

/** Revokes the unrevoked tokens of several grants (at least one). */
export async function revokeTokensOfGrants(tx: Tx, grantIds: string[]): Promise<void> {
  await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id IN ${tx(grantIds)} AND revoked_at IS NULL`;
}

export interface TokenByHashRow { tenant_id: string; grant_id: string; kind: string; token_hash: Buffer; scopes: string[] | null; expires_at: Date; revoked_at: Date | null }

/** The token with this hash, in whatever state (after narrowToTokenHash). */
export async function tokenByHash(tx: Tx, hash: Buffer): Promise<TokenByHashRow | undefined> {
  const [t] = await tx<TokenByHashRow[]>`
      SELECT tenant_id, grant_id, kind, token_hash, scopes, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ${hash}`;
  return t;
}

/** The workspace and ID of the token with this hash (after narrowToSecretLookup). */
export async function tokenLocation(tx: Tx, hash: Buffer): Promise<{ tenant_id: string; id: string } | undefined> {
  const [row] = await tx<{ tenant_id: string; id: string }[]>`SELECT tenant_id, id FROM oauth_tokens WHERE token_hash = ${hash}`;
  return row;
}

export interface RefreshTokenRow { grant_id: string; kind: string; token_hash: Buffer; expires_at: Date; used_at: Date | null; revoked_at: Date | null }

/** A token by ID, in whatever state, locked (a refresh). */
export async function refreshTokenForUpdate(tx: Tx, id: string): Promise<RefreshTokenRow | undefined> {
  const [t] = await tx<RefreshTokenRow[]>`
      SELECT grant_id, kind, token_hash, expires_at, used_at, revoked_at FROM oauth_tokens WHERE id = ${id} FOR UPDATE`;
  return t;
}

/** A token by ID, in whatever state, locked (a revocation). */
export async function tokenForRevocation(tx: Tx, id: string): Promise<{ grant_id: string; kind: string; token_hash: Buffer; revoked_at: Date | null } | undefined> {
  const [t] = await tx<{ grant_id: string; kind: string; token_hash: Buffer; revoked_at: Date | null }[]>`
      SELECT grant_id, kind, token_hash, revoked_at FROM oauth_tokens WHERE id = ${id} FOR UPDATE`;
  return t;
}

/** Marks a refresh token exchanged. */
export async function markTokenUsed(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE oauth_tokens SET used_at = now() WHERE id = ${id}`;
}

/** Revokes one token. False when it was already revoked. */
export async function markTokenRevoked(tx: Tx, id: string): Promise<boolean> {
  return (await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING 1`).length > 0;
}

/**
 * Deletes tokens a day after they expire or are revoked, and refresh tokens a week after they were
 * exchanged, in the workspace the transaction is in. Returns how many.
 */
export async function deleteEndedTokens(tx: Tx): Promise<number> {
  const tokens = await tx`DELETE FROM oauth_tokens WHERE least(expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '1 day'
                                OR (kind = 'refresh' AND used_at < now() - interval '7 days') RETURNING 1`;
  return tokens.length;
}
