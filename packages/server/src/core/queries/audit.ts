import type { Sql, Tx } from "../../db/pool.js";

/**
 * The SQL of the audit log (ADR 0012): writing entries (core/audit.ts), reading them (GET /v1/audit-log),
 * and sealing, verifying and anchoring the hash chain (core/auditchain.ts). The code that calls these keeps
 * its checks, errors and the order of statements in its transaction.
 */

// --- Writing and reading entries --------------------------------------------------------------------

export interface AuditInsert { tenantId: string; id: string; actorType: string; actorId: string | null; keyId: string | null; surface: string;
  action: string; objectType: string | null; recordId: string | null; requestId: string; details: Record<string, unknown> }

/** Writes one unsealed audit entry. */
export async function insertAuditEntry(tx: Tx, e: AuditInsert): Promise<void> {
  await tx`
    INSERT INTO audit_log (tenant_id, id, actor_type, actor_id, key_id, surface, action, object_type, record_id, request_id, details)
    VALUES (${e.tenantId}, ${e.id}, ${e.actorType}, ${e.actorId}, ${e.keyId}, ${e.surface},
            ${e.action}, ${e.objectType}, ${e.recordId}, ${e.requestId},
            ${tx.json(e.details as never)})`;
}

export interface AuditLogRow { seq: string; occurred_at: Date; actor_type: string; actor_id: string | null; key_id: string | null; surface: string;
  action: string; object_type: string | null; record_id: string | null; request_id: string | null; details: unknown; sealed: boolean }

/** A page of the audit log, newest first: entries before `before` (a seq), whose action starts with `action`, about the record `record` (a UUID). */
export async function auditLogPage(tx: Tx, q: { before: number | null; action: string | null; record: string | null; limit: number }): Promise<AuditLogRow[]> {
  return tx<AuditLogRow[]>`
      SELECT seq::text, occurred_at, actor_type, actor_id, key_id, surface, action, object_type, record_id, request_id, details, hash IS NOT NULL AS sealed
      FROM audit_log
      WHERE (${q.before}::bigint IS NULL OR seq < ${q.before}::bigint)
        AND (${q.action}::text IS NULL OR action LIKE ${(q.action ?? "") + "%"})
        AND (${q.record}::uuid IS NULL OR record_id = ${q.record}::uuid)
      ORDER BY audit_log.seq DESC LIMIT ${q.limit}`;
}

// --- The hash chain ---------------------------------------------------------------------------------

/** An audit row as the chain hashes it. */
export interface AuditRow {
  seq: string;
  chain_pos: string | null;
  id: string;
  occurred_us: string;
  actor_type: string;
  actor_id: string | null;
  key_id: string | null;
  surface: string;
  action: string;
  object_type: string | null;
  record_id: string | null;
  request_id: string | null;
  details: unknown;
  prev_hash: Buffer | null;
  hash: Buffer | null;
}

/** The columns of an AuditRow, as a fragment of the query that selects them. */
const auditColumns = (tx: Tx) => tx`seq::text, chain_pos::text, id, (extract(epoch from occurred_at) * 1000000)::bigint::text AS occurred_us, actor_type,
  actor_id, key_id, surface, action, object_type, record_id, request_id, details, prev_hash, hash`;

/** Takes the tenant's sealing lock if it is free, without waiting. True when this transaction holds it. */
export async function trySealLock(tx: Tx, tenantId: string): Promise<boolean> {
  const [lock] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`audit-seal:${tenantId}`})) AS ok`;
  return Boolean(lock?.ok);
}

/** Waits for, and takes, the tenant's sealing lock: for the one caller that must seal everything before it goes on (deleting the workspace). */
export async function sealLock(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`audit-seal:${tenantId}`}))`;
}

/** The lock that keeps verification and anchoring apart, per tenant: storage and the anchors table are then seen in step. */
const anchorLock = (tenantId: string) => `audit-anchor:${tenantId}`;

/** Waits for, and takes, the tenant's anchor lock. */
export async function lockAnchors(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${anchorLock(tenantId)}))`;
}

/** Takes the tenant's anchor lock if it is free, without waiting. True when this transaction holds it. */
export async function tryLockAnchors(tx: Tx, tenantId: string): Promise<boolean> {
  const [lock] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${anchorLock(tenantId)})) AS ok`;
  return Boolean(lock?.ok);
}

/** The last sealed row's hash and chain position; undefined when nothing is sealed yet. */
export async function chainEnd(tx: Tx): Promise<{ hash: Buffer; chain_pos: string } | undefined> {
  const [last] = await tx<{ hash: Buffer; chain_pos: string }[]>`
      SELECT hash, chain_pos::text FROM audit_log WHERE audit_log.chain_pos IS NOT NULL ORDER BY audit_log.chain_pos DESC LIMIT 1`;
  return last;
}

/** Up to `batch` unsealed rows, oldest first. */
export async function unsealedRows(tx: Tx, batch: number): Promise<AuditRow[]> {
  return tx<AuditRow[]>`SELECT ${auditColumns(tx)} FROM audit_log WHERE hash IS NULL ORDER BY audit_log.seq LIMIT ${batch}`;
}

/** Seals one row with its hash and the previous one's. Returns the chain position the guard trigger gave it. */
export async function sealRow(tx: Tx, seq: string, prevHash: Buffer, hash: Buffer): Promise<string> {
  const [sealed] = await tx<{ chain_pos: string }[]>`
        UPDATE audit_log SET prev_hash = ${prevHash}, hash = ${hash}, sealed_at = now() WHERE seq = ${seq}::bigint RETURNING chain_pos::text`;
  return sealed!.chain_pos;
}

/** Every anchor in the database, by seq. */
export async function anchorRows(tx: Tx): Promise<{ seq: string; chain_pos: string | null; hash: Buffer }[]> {
  return tx<{ seq: string; chain_pos: string | null; hash: Buffer }[]>`
    SELECT seq::text, chain_pos::text, hash FROM audit_anchors ORDER BY audit_anchors.seq`;
}

/** The next (up to) 1000 sealed rows after chain position `afterPos`, in chain order. */
export async function chainRowsAfter(tx: Tx, afterPos: string): Promise<AuditRow[]> {
  return tx<AuditRow[]>`SELECT ${auditColumns(tx)} FROM audit_log WHERE audit_log.chain_pos > ${afterPos}::bigint ORDER BY audit_log.chain_pos LIMIT 1000`;
}

/** How many rows are unsealed, and how many are sealed without a chain position (or the reverse). */
export async function chainCounts(tx: Tx): Promise<{ unsealed: number; stray: number } | undefined> {
  const [counts] = await tx<{ unsealed: number; stray: number }[]>`
    SELECT count(*) FILTER (WHERE hash IS NULL)::int AS unsealed,
           count(*) FILTER (WHERE (hash IS NULL) <> (chain_pos IS NULL))::int AS stray FROM audit_log`;
  return counts;
}

/** The chain head (highest chain position): its seq, position and hash; undefined when nothing is sealed. */
export async function chainHead(tx: Tx): Promise<{ seq: string; chain_pos: string; hash: Buffer } | undefined> {
  const [head] = await tx<{ seq: string; chain_pos: string; hash: Buffer }[]>`
      SELECT seq::text, chain_pos::text, hash FROM audit_log WHERE audit_log.chain_pos IS NOT NULL ORDER BY audit_log.chain_pos DESC LIMIT 1`;
  return head;
}

/** True when an anchor at this seq already exists. */
export async function anchorExists(tx: Tx, seq: string): Promise<boolean> {
  const [exists] = await tx`SELECT 1 FROM audit_anchors WHERE seq = ${seq}::bigint`;
  return Boolean(exists);
}

export async function insertAnchor(tx: Tx, a: { tenantId: string; seq: string; chainPos: string; hash: Buffer; location: string }): Promise<void> {
  await tx`INSERT INTO audit_anchors (tenant_id, seq, chain_pos, hash, location)
             VALUES (${a.tenantId}, ${a.seq}::bigint, ${a.chainPos}::bigint, ${a.hash}, ${a.location})`;
}

/** Every workspace's ID, oldest first. */
export async function tenantDirectory(tx: Tx | Sql): Promise<{ tenant_id: string }[]> {
  return tx<{ tenant_id: string }[]>`SELECT tenant_id FROM tenant_directory ORDER BY created_at`;
}
