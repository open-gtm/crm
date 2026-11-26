import type { Tx } from "../../db/pool.js";

/**
 * The SQL of connections (core/connections.ts, ADR 0016 and ADR 0012). The callers keep their checks,
 * errors, audits and the order of statements in each transaction.
 */

export type ConnectionType = "static_token" | "oauth_client_credentials" | "oauth_refresh_token";

export interface ConnectionRow {
  id: string; key: string; name: string; description: string | null; type: ConnectionType; base_url: string;
  header_name: string; header_prefix: string; token_url: string | null; client_id: string | null; scope: string | null;
  token_params: Record<string, string>; token_lifetime_minutes: number; test_path: string | null;
  /** Encrypted. */
  secret: string | null; secret_set_at: Date | null;
  /** Encrypted. */
  refresh_token: string | null; refresh_token_set_at: Date | null;
  /** Encrypted. */
  access_token: string | null; access_token_expires_at: Date | null; access_token_fetched_at: Date | null;
  enabled: boolean; last_used_at: Date | null; last_error: string | null; last_error_at: Date | null;
  created_at: Date; updated_at: Date; archived_at: Date | null;
}

/** One connection, archived or not; `forUpdate` locks it. */
export async function connectionById(tx: Tx, id: string, forUpdate = false): Promise<ConnectionRow | undefined> {
  const [c] = forUpdate
    ? await tx<ConnectionRow[]>`SELECT * FROM connections WHERE id = ${id} FOR UPDATE`
    : await tx<ConnectionRow[]>`SELECT * FROM connections WHERE id = ${id}`;
  return c;
}

/** The connection steps name by `key`, if it isn't archived. */
export async function liveConnectionByKey(tx: Tx, key: string): Promise<ConnectionRow | undefined> {
  const [c] = await tx<ConnectionRow[]>`SELECT * FROM connections WHERE key = ${key} AND archived_at IS NULL`;
  return c;
}

/** The connections that aren't archived, oldest first. */
export async function liveConnections(tx: Tx): Promise<ConnectionRow[]> {
  return tx<ConnectionRow[]>`SELECT * FROM connections WHERE archived_at IS NULL ORDER BY created_at`;
}

export async function countLiveConnections(tx: Tx): Promise<number> {
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM connections WHERE archived_at IS NULL`;
  return count?.n ?? 0;
}

export interface ConnectionSettings {
  name: string; description: string | null; baseUrl: string; headerName: string; headerPrefix: string; tokenUrl: string | null;
  clientId: string | null; scope: string | null; tokenParams: Record<string, string>; tokenLifetimeMinutes: number; testPath: string | null; enabled: boolean;
}

/** `secret` and `refreshToken` are encrypted. */
export async function insertConnection(tx: Tx, c: ConnectionSettings & { tenantId: string; id: string; key: string; type: ConnectionType;
  secret: string; refreshToken: string | null; createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO connections (tenant_id, id, key, name, description, type, base_url, header_name, header_prefix, token_url, client_id, scope,
                             token_params, token_lifetime_minutes, test_path, secret, secret_set_at, refresh_token, refresh_token_set_at, enabled, created_by)
    VALUES (${c.tenantId}, ${c.id}, ${c.key}, ${c.name}, ${c.description}, ${c.type}, ${c.baseUrl}, ${c.headerName}, ${c.headerPrefix}, ${c.tokenUrl},
            ${c.clientId}, ${c.scope}, ${tx.json(c.tokenParams)}, ${c.tokenLifetimeMinutes}, ${c.testPath}, ${c.secret}, now(),
            ${c.refreshToken}, ${c.refreshToken === null ? null : tx`now()`}, ${c.enabled}, ${c.createdBy})`;
}

/** What a person changed. `dropToken` forgets the cached access token and the last error, when the change makes them stale. */
export async function updateConnectionSettings(tx: Tx, id: string, c: ConnectionSettings, dropToken: boolean): Promise<void> {
  await tx`
    UPDATE connections SET name = ${c.name}, description = ${c.description}, base_url = ${c.baseUrl}, header_name = ${c.headerName},
      header_prefix = ${c.headerPrefix}, token_url = ${c.tokenUrl}, client_id = ${c.clientId}, scope = ${c.scope},
      token_params = ${tx.json(c.tokenParams)}, token_lifetime_minutes = ${c.tokenLifetimeMinutes}, test_path = ${c.testPath}, enabled = ${c.enabled},
      access_token = CASE WHEN ${dropToken} THEN NULL ELSE access_token END,
      access_token_expires_at = CASE WHEN ${dropToken} THEN NULL ELSE access_token_expires_at END,
      last_error = CASE WHEN ${dropToken} THEN NULL ELSE last_error END,
      last_error_at = CASE WHEN ${dropToken} THEN NULL ELSE last_error_at END,
      updated_at = now()
    WHERE id = ${id}`;
}

/** Stores a new (encrypted) token or client secret, and forgets the cached access token. */
export async function setConnectionSecret(tx: Tx, id: string, secret: string): Promise<void> {
  await tx`UPDATE connections SET secret = ${secret}, secret_set_at = now(), access_token = NULL, access_token_expires_at = NULL, updated_at = now() WHERE id = ${id}`;
}

/** Stores a new (encrypted) refresh token a person entered, and forgets the cached access token. */
export async function setConnectionRefreshToken(tx: Tx, id: string, refreshToken: string): Promise<void> {
  await tx`UPDATE connections SET refresh_token = ${refreshToken}, refresh_token_set_at = now(), access_token = NULL, access_token_expires_at = NULL,
             updated_at = now() WHERE id = ${id}`;
}

/** Caches a fetched (encrypted) access token, with the refresh token the provider gave in its place, if it gave one. */
export async function cacheAccessToken(tx: Tx, id: string, accessToken: string, expiresAt: Date, rotatedRefreshToken: string | null): Promise<void> {
  await tx`
    UPDATE connections SET access_token = ${accessToken}, access_token_expires_at = ${expiresAt}, access_token_fetched_at = now(),
      refresh_token = COALESCE(${rotatedRefreshToken}, refresh_token),
      refresh_token_set_at = CASE WHEN ${rotatedRefreshToken}::text IS NULL THEN refresh_token_set_at ELSE now() END,
      last_error = NULL, last_error_at = NULL
    WHERE id = ${id}`;
}

/** Records why the last token request failed, and forgets the cached access token. */
export async function setConnectionError(tx: Tx, id: string, error: string): Promise<void> {
  await tx`UPDATE connections SET last_error = ${error}, last_error_at = now(), access_token = NULL, access_token_expires_at = NULL WHERE id = ${id}`;
}

/** Notes a use. Skipped while the row is held (a token is being fetched): the run that notes it never waits on that. */
export async function touchConnectionUsed(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE connections SET last_used_at = now() WHERE id = (SELECT id FROM connections WHERE id = ${id} FOR UPDATE SKIP LOCKED)`;
}

export async function archiveConnectionRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE connections SET archived_at = now(), enabled = false, secret = NULL, refresh_token = NULL, access_token = NULL,
             access_token_expires_at = NULL, updated_at = now() WHERE id = ${id}`;
}

/** Live automations whose steps might name a connection: the caller reads their steps. */
export async function automationsNamingConnections(tx: Tx): Promise<{ id: string; name: string; actions: unknown }[]> {
  return tx<{ id: string; name: string; actions: unknown }[]>`
    SELECT id, name, actions FROM automations WHERE archived_at IS NULL AND actions::text LIKE '%"connection"%' ORDER BY created_at`;
}
