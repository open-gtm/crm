import type { Sql, Tx } from "../../db/pool.js";

/**
 * The SQL of deleting a workspace (core/disposal.ts; ADR 0020, ADR 0012). The code that calls these
 * keeps its checks, errors, audits and the order of statements in its transaction.
 */

export interface DeletionState { name: string; requested_at: Date | null; requested_by: string | null; delete_after: Date | null;
  /** Whether delete_after has passed, by the database's clock: the application's may differ. */
  due: boolean }

/** The workspace the transaction is in: its name, and its pending deletion if one was asked for. Locks the workspace's row. */
export async function deletionStateForUpdate(tx: Tx): Promise<DeletionState | undefined> {
  const [row] = await tx<DeletionState[]>`
    SELECT t.name, t.deletion_requested_at AS requested_at, t.deletion_requested_by AS requested_by, d.delete_after,
           COALESCE(d.delete_after <= now(), false) AS due
    FROM tenants t JOIN tenant_directory d ON d.tenant_id = t.tenant_id FOR UPDATE OF t`;
  return row;
}

/** The same, without a lock: for showing it. */
export async function deletionState(tx: Tx): Promise<DeletionState | undefined> {
  const [row] = await tx<DeletionState[]>`
    SELECT t.name, t.deletion_requested_at AS requested_at, t.deletion_requested_by AS requested_by, d.delete_after,
           COALESCE(d.delete_after <= now(), false) AS due
    FROM tenants t JOIN tenant_directory d ON d.tenant_id = t.tenant_id`;
  return row;
}

/** Records that an owner asked for the workspace to be deleted, due `graceDays` from now. Returns when it is due. */
export async function scheduleDeletion(tx: Tx, tenantId: string, userId: string, graceDays: number): Promise<Date> {
  await tx`UPDATE tenants SET deletion_requested_at = now(), deletion_requested_by = ${userId} WHERE tenant_id = ${tenantId}`;
  const [row] = await tx<{ delete_after: Date }[]>`
    UPDATE tenant_directory SET delete_after = now() + make_interval(days => ${graceDays}) WHERE tenant_id = ${tenantId} RETURNING delete_after`;
  return row!.delete_after;
}

/** Withdraws a pending deletion. */
export async function clearDeletion(tx: Tx, tenantId: string): Promise<void> {
  await tx`UPDATE tenants SET deletion_requested_at = NULL, deletion_requested_by = NULL WHERE tenant_id = ${tenantId}`;
  await tx`UPDATE tenant_directory SET delete_after = NULL WHERE tenant_id = ${tenantId}`;
}

/** Workspaces whose deletion is due, oldest first. The directory has no row-level security, so no workspace is entered. */
export async function dueDeletions(sql: Sql): Promise<string[]> {
  return (await sql<{ tenant_id: string }[]>`SELECT tenant_id FROM tenant_directory WHERE delete_after <= now() ORDER BY delete_after LIMIT 20`).map((r) => r.tenant_id);
}

/** Whether a workspace with this ID exists. */
export async function tenantExists(sql: Sql | Tx, tenantId: string): Promise<boolean> {
  return (await sql`SELECT 1 FROM tenant_directory WHERE tenant_id = ${tenantId}`).length > 0;
}

/**
 * Locks the workspace's directory row, so nothing new can be written to the workspace until this
 * transaction ends (every tenant row refers to it), and lifts the pool's statement and idle limits
 * for this transaction: deleting a large workspace is one long statement. False when it is gone.
 */
export async function lockWorkspaceForPurge(tx: Tx, tenantId: string): Promise<boolean> {
  await tx`SELECT set_config('statement_timeout', '0', true), set_config('idle_in_transaction_session_timeout', '0', true)`;
  return (await tx`SELECT 1 FROM tenant_directory WHERE tenant_id = ${tenantId} FOR UPDATE`).length > 0;
}

/** Files of the workspace the transaction is in whose bytes are in a store outside the database. */
export async function externalFiles(tx: Tx): Promise<{ id: string; store: "postgres" | "s3" }[]> {
  return tx<{ id: string; store: "postgres" | "s3" }[]>`SELECT id, store FROM files WHERE store <> 'postgres' AND deleted_at IS NULL ORDER BY id`;
}

/** Deletes every row of the workspace and writes its tombstone (app.purge_tenant, migration 027). Returns the rows deleted per table. */
export async function purgeTenant(tx: Tx, p: { tenantId: string; byType: "owner" | "operator"; by: string | null; requestedAt: Date }): Promise<Record<string, number>> {
  const [row] = await tx<{ deleted: Record<string, number> }[]>`
    SELECT app.purge_tenant(${p.tenantId}, ${p.byType}, ${p.by}, ${p.requestedAt}) AS deleted`;
  return row!.deleted;
}

export interface TombstoneRow { workspace_id: string; created_at: Date; deleted_at: Date; requested_at: Date; requested_by_type: "owner" | "operator";
  requested_by: string | null; audit_rows: string; audit_chain_pos: string | null; audit_head_hash: Buffer | null; rows_deleted: Record<string, number> }

/** What is left of a deleted workspace. */
export async function tombstone(sql: Sql | Tx, tenantId: string): Promise<TombstoneRow | undefined> {
  const [row] = await sql<TombstoneRow[]>`
    SELECT workspace_id, created_at, deleted_at, requested_at, requested_by_type, requested_by, audit_rows::text, audit_chain_pos::text, audit_head_hash, rows_deleted
    FROM deleted_workspaces WHERE workspace_id = ${tenantId}`;
  return row;
}
