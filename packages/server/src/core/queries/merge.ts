import type { Tx } from "../../db/pool.js";
import { quoteIdent } from "../schema.js";

/**
 * The SQL of merging duplicate records (core/merge.ts, ADR 0012). The per-reference statements and the
 * version bump of link holders are built from identifiers only by core/merge.ts (statements, bumpSql)
 * and only executed here. The merge keeps its checks, errors, audits, events and the order of
 * statements in its transaction.
 */

/** What a reference statement returns per row: its holder (h), the duplicate it pointed at (old) and the row's key (k). */
export interface ReferenceRow { h: string; old: string; k: string[] }

/** One merge at a time per workspace: two merges touching the same rows in different orders would deadlock. */
export async function lockMerges(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`merge:${tenantId}`}))`;
}

/** Which of these records were merged, and into which survivor. */
export async function mergedInto(tx: Tx, ids: string[]): Promise<{ survivor_id: string; merged_id: string }[]> {
  return tx<{ survivor_id: string; merged_id: string }[]>`
    SELECT survivor_id, unnest(merged_ids) AS merged_id FROM merges WHERE tenant_id = app.tenant_id() AND merged_ids && ${ids}::uuid[]`;
}

/** Archives the duplicates of a merge. */
export async function archiveMergedRecords(tx: Tx, table: string, ids: string[], actorId: string | null): Promise<void> {
  await tx.unsafe(`UPDATE ${quoteIdent(table)} SET archived_at = now(), version = version + 1, updated_by = $2
      WHERE tenant_id = app.tenant_id() AND id = ANY ($1::uuid[])`, [ids, actorId] as never[]);
}

/** Records a merge. `survivorBefore` is the survivor's previous values, already encrypted, or null when none change. */
export async function insertMerge(tx: Tx, m: { tenantId: string; id: string; objectId: string; survivorId: string; mergedIds: string[];
  fieldSources: Record<string, string>; survivorBefore: string | null; repointed: unknown; mergedBy: string | null }): Promise<void> {
  await tx`INSERT INTO merges (tenant_id, id, object_id, survivor_id, merged_ids, field_sources, survivor_before, repointed, merged_by)
            VALUES (${m.tenantId}, ${m.id}, ${m.objectId}, ${m.survivorId}, ${m.mergedIds}::uuid[], ${tx.json(m.fieldSources as never)},
                    ${m.survivorBefore},
                    ${tx.json(m.repointed as never)}, ${m.mergedBy})`;
}

/** Runs a reference's count statement (statements(r).count) over the duplicates. */
export async function countReferenceRows(tx: Tx, text: string, dups: string[]): Promise<number> {
  return (await tx.unsafe<{ n: number }[]>(text, [dups] as never[]))[0]!.n;
}

/** Alert deadlines and notifications that hold one of these records. */
export async function countAlertReferences(tx: Tx, dups: string[]): Promise<number> {
  const [other] = await tx<{ n: number }[]>`SELECT ((SELECT count(*) FROM rule_deadlines WHERE tenant_id = app.tenant_id() AND record_id = ANY (${dups}::uuid[]))
    + (SELECT count(*) FROM notifications WHERE tenant_id = app.tenant_id() AND record_id = ANY (${dups}::uuid[])))::int AS n`;
  return other!.n;
}

/** Runs one of a reference's statements (statements(r).self, .dedupe or .move), returning the rows it changed. */
export async function runReferenceStatement(tx: Tx, text: string, params: unknown[]): Promise<ReferenceRow[]> {
  return tx.unsafe<ReferenceRow[]>(text, params as never[]);
}

/** Moves the references in a table the immutability triggers guard, through app.merge_move, which also bumps `holders`. */
export async function moveGuardedReferences(tx: Tx, table: string, survivor: string, dups: string[], holders: string[], actorId: string | null):
  Promise<{ row_id: string; col: string | null; ref: string | null }[]> {
  return tx<{ row_id: string; col: string | null; ref: string | null }[]>`
      SELECT row_id, col, ref FROM app.merge_move(${table}, ${survivor}, ${dups}::uuid[], ${holders}::uuid[], ${actorId})`;
}

/** Runs a version bump built by bumpSql for these records. */
export async function bumpLinkHolders(tx: Tx, text: string, ids: string[], actorId: string | null): Promise<void> {
  await tx.unsafe(text, [ids, actorId] as never[]);
}

/** Deletes a duplicate's alert deadline for a rule the survivor (or an earlier duplicate) already has one for. */
export async function dropDuplicateDeadlines(tx: Tx, survivor: string, dups: string[]): Promise<{ rule_id: string; record_id: string }[]> {
  return tx<{ rule_id: string; record_id: string }[]>`
    WITH c AS (SELECT rule_id, record_id, row_number() OVER (PARTITION BY rule_id ORDER BY (record_id = ${survivor}) DESC, array_position(${dups}::uuid[], record_id)) AS n
               FROM rule_deadlines WHERE tenant_id = app.tenant_id() AND (record_id = ${survivor} OR record_id = ANY (${dups}::uuid[])))
    DELETE FROM rule_deadlines d USING c WHERE d.tenant_id = app.tenant_id() AND d.rule_id = c.rule_id AND d.record_id = c.record_id AND c.n > 1 AND c.record_id <> ${survivor}
    RETURNING d.rule_id, d.record_id`;
}

/** Moves the duplicates' remaining alert deadlines to the survivor. */
export async function moveDeadlines(tx: Tx, survivor: string, dups: string[]): Promise<{ rule_id: string; old: string }[]> {
  return tx<{ rule_id: string; old: string }[]>`
    UPDATE rule_deadlines d SET record_id = ${survivor} FROM (SELECT rule_id, record_id AS old FROM rule_deadlines WHERE tenant_id = app.tenant_id() AND record_id = ANY (${dups}::uuid[])) o
    WHERE d.tenant_id = app.tenant_id() AND d.rule_id = o.rule_id AND d.record_id = o.old RETURNING d.rule_id, o.old`;
}

/** Resolves a duplicate's open notification where the survivor (or an earlier duplicate) has one for the same member and rule or automation. */
export async function resolveDuplicateNotifications(tx: Tx, survivor: string, dups: string[]): Promise<{ id: string; record_id: string }[]> {
  return tx<{ id: string; record_id: string }[]>`
    WITH c AS (SELECT id, record_id, row_number() OVER (PARTITION BY user_id, rule_id, automation_id
                 ORDER BY (record_id = ${survivor}) DESC, array_position(${dups}::uuid[], record_id), id) AS n
               FROM notifications WHERE tenant_id = app.tenant_id() AND state <> 'resolved' AND (record_id = ${survivor} OR record_id = ANY (${dups}::uuid[])))
    UPDATE notifications n SET state = 'resolved', resolved_at = now() FROM c
    WHERE n.tenant_id = app.tenant_id() AND n.id = c.id AND c.n > 1 AND c.record_id <> ${survivor} RETURNING n.id, n.record_id`;
}

/** Moves the duplicates' notifications to the survivor. */
export async function moveNotifications(tx: Tx, survivor: string, dups: string[]): Promise<{ id: string; old: string }[]> {
  return tx<{ id: string; old: string }[]>`
    UPDATE notifications n SET record_id = ${survivor} FROM (SELECT id, record_id AS old FROM notifications WHERE tenant_id = app.tenant_id() AND record_id = ANY (${dups}::uuid[])) o
    WHERE n.tenant_id = app.tenant_id() AND n.id = o.id RETURNING n.id, o.old`;
}
