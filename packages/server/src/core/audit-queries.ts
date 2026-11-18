import type { Tx } from "../db/pool.js";

/**
 * Reading the audit log for GET /v1/audit-log (ADR 0012). Moved out of the route handler; core's other
 * audit SQL (audit.ts, auditchain.ts) moves when core/ is converted.
 */

export interface AuditLogRow { seq: string; occurred_at: Date; actor_type: string; actor_id: string | null; key_id: string | null; surface: string;
  action: string; object_type: string | null; record_id: string | null; request_id: string | null; details: unknown; sealed: boolean }

/** A page of the audit log, newest first: entries before `before` (a seq), whose action starts with `action`. */
export async function auditLogPage(tx: Tx, q: { before: number | null; action: string | null; limit: number }): Promise<AuditLogRow[]> {
  return tx<AuditLogRow[]>`
      SELECT seq::text, occurred_at, actor_type, actor_id, key_id, surface, action, object_type, record_id, request_id, details, hash IS NOT NULL AS sealed
      FROM audit_log
      WHERE (${q.before}::bigint IS NULL OR seq < ${q.before}::bigint)
        AND (${q.action}::text IS NULL OR action LIKE ${(q.action ?? "") + "%"})
      ORDER BY audit_log.seq DESC LIMIT ${q.limit}`;
}
