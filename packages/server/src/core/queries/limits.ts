import type { Sql, Tx } from "../../db/pool.js";

/**
 * The SQL of per-workspace limits and usage (core/limits.ts; ADR 0012, ADR 0019). The code that calls
 * these keeps its checks, errors and the order of statements in its transaction.
 */

// --- Limits the operator set for this workspace -------------------------------------------------------

/** The limits set for this workspace in place of the server's defaults. A null value is "unlimited". */
export async function limitOverrides(tx: Tx): Promise<{ key: string; value: number | null }[]> {
  return tx<{ key: string; value: number | null }[]>`SELECT key, value::float8 AS value FROM tenant_limits`;
}

/**
 * Sets one workspace's limit (null: unlimited). For the `limits` command, on a connection of the
 * migrator role, which owns the table: the app role may only read it.
 */
export async function upsertLimitOverride(tx: Tx, tenantId: string, key: string, value: number | null): Promise<void> {
  await tx`INSERT INTO tenant_limits (tenant_id, key, value) VALUES (${tenantId}, ${key}, ${value})
           ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** Puts one workspace's limit back to the server's default. For the `limits` command, as above. */
export async function deleteLimitOverride(tx: Tx, key: string): Promise<void> {
  await tx`DELETE FROM tenant_limits WHERE key = ${key}`;
}

/** Whether the workspace exists (the tenant directory has no row-level security). */
export async function workspaceExists(sql: Sql | Tx, tenantId: string): Promise<boolean> {
  return (await sql`SELECT 1 FROM tenant_directory WHERE tenant_id = ${tenantId}`).length > 0;
}

/** Enters a workspace for the rest of the transaction (row-level security binds the table owner too). */
export async function enterWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

// --- Counting ---------------------------------------------------------------------------------------

/**
 * How many records the workspace holds, archived ones included: the sum of record_counts, which a
 * trigger on record_registry keeps (migration 029). It includes what this transaction added or removed.
 * `rows` is how many rows were summed: past a few hundred they are worth folding together.
 */
export async function recordCount(tx: Tx): Promise<{ n: number; rows: number }> {
  const [r] = await tx<{ n: number; rows: number }[]>`SELECT coalesce(sum(delta), 0)::float8 AS n, count(*)::int AS rows FROM record_counts`;
  return r!;
}

/**
 * Makes transactions that are about to commit new records in this workspace go one at a time, from
 * here to their commit: whoever holds it has seen every earlier one's records.
 */
export async function lockRecordCount(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`records:${tenantId}`}, 0))`;
}

/** The same lock, only if it is free now (the worker's tidy-up doesn't wait for it). */
export async function tryLockRecordCount(tx: Tx, tenantId: string): Promise<boolean> {
  const [r] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`records:${tenantId}`}, 0)) AS ok`;
  return r!.ok;
}

/**
 * Folds the committed rows of record_counts into the workspace's total row (txid 0). Rows of
 * transactions still running are invisible here and stay; this transaction's own row stays too. The
 * sum is the same before and after, for every reader. Call it holding lockRecordCount.
 */
export async function foldRecordCounts(tx: Tx, tenantId: string): Promise<void> {
  await tx`
    WITH gone AS (DELETE FROM record_counts WHERE txid <> 0 AND txid <> pg_current_xact_id()::text::bigint RETURNING delta)
    INSERT INTO record_counts (tenant_id, txid, delta) SELECT ${tenantId}, 0, coalesce(sum(delta), 0) FROM gone
    ON CONFLICT (tenant_id, txid) DO UPDATE SET delta = record_counts.delta + EXCLUDED.delta`;
}

/** Makes requests that add one kind of thing to this workspace go one at a time, so a count and the insert after it can't be passed by another. */
export async function lockLimit(tx: Tx, tenantId: string, key: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`limit:${tenantId}:${key}`}, 0))`;
}

/** People who can sign in: members who aren't disabled. */
export async function countActiveUsers(tx: Tx): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE disabled_at IS NULL`;
  return r!.n;
}

/** Service accounts that aren't disabled. */
export async function countActiveServiceAccounts(tx: Tx): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM service_accounts WHERE disabled_at IS NULL`;
  return r!.n;
}

/** API keys that still work: not revoked and not expired. */
export async function countUsableKeys(tx: Tx): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
  return r!.n;
}

/** Everything the usage report counts with a query, in one statement. */
export interface UsageCounts { members: number; service_accounts: number; api_keys: number; webhooks: number; automations: number; file_bytes: number }
export async function usageCounts(tx: Tx): Promise<UsageCounts> {
  const [r] = await tx<UsageCounts[]>`
    SELECT (SELECT count(*) FROM users WHERE disabled_at IS NULL)::int AS members,
           (SELECT count(*) FROM service_accounts WHERE disabled_at IS NULL)::int AS service_accounts,
           (SELECT count(*) FROM api_keys WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::int AS api_keys,
           (SELECT count(*) FROM webhooks WHERE archived_at IS NULL)::int AS webhooks,
           (SELECT count(*) FROM automations WHERE archived_at IS NULL)::int AS automations,
           (SELECT coalesce(sum(size), 0) FROM files WHERE deleted_at IS NULL)::float8 AS file_bytes`;
  return r!;
}

/** What automations have used of an hourly cap in the window that started at `start`. */
export async function automationUsageIn(tx: Tx, buckets: string[], start: Date): Promise<{ bucket: string; n: number }[]> {
  return tx<{ bucket: string; n: number }[]>`SELECT bucket, n FROM automation_usage WHERE bucket = ANY (${buckets}) AND window_start = ${start}`;
}
