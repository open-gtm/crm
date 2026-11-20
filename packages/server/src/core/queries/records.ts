import type { Tx } from "../../db/pool.js";
import { ENTITIES } from "../catalog.js";
import { quoteIdent } from "../schema.js";

/**
 * The SQL of records (ADR 0012): reading, writing, archiving and restoring them (core/records.ts), and
 * the record reads of shaped responses, bulk changes, aggregates and the schema summary (core/reads.ts,
 * core/bulk.ts, core/aggregate.ts, core/describe.ts). The code that calls these keeps its checks,
 * errors, audits and the order of statements in its transaction.
 *
 * Table and column names come from metadata only (objects.table_name, a field's column_name, the
 * catalog's ENTITIES) and are quoted here with quoteIdent. SQL built at run time (the query compiler,
 * aggregates, the unique-value check) is built by its caller and only executed here: those functions
 * take the finished text and its parameters.
 */

/** A row of a record table (a standard object's table, or `records`), every column. */
export type RecordRow = Record<string, unknown> & { id: string };

// --- Existence and rows by ID -----------------------------------------------------------------------

/** Whether a row with this ID exists in an entity's table (users, pipelines, stages). */
export async function entityRowExists(tx: Tx, table: string, id: string): Promise<boolean> {
  return (await tx.unsafe(`SELECT 1 FROM ${quoteIdent(table)} WHERE id = $1`, [id])).length > 0;
}

/** Whether a record with this ID is registered for this object. */
export async function registeredRecordExists(tx: Tx, id: string, objectId: string): Promise<boolean> {
  return (await tx`SELECT 1 FROM record_registry WHERE id = ${id} AND object_id = ${objectId}`).length > 0;
}

/** Rows of a standard object's table by ID, optionally locked. */
export async function standardRowsById(tx: Tx, table: string, ids: string[], forUpdate: boolean): Promise<RecordRow[]> {
  return tx.unsafe<RecordRow[]>(`SELECT * FROM ${quoteIdent(table)} WHERE id = ANY($1::uuid[])${forUpdate ? " FOR UPDATE" : ""}`, [ids]);
}

/** Rows of a custom object by ID, optionally locked. */
export async function customRowsById(tx: Tx, objectId: string, ids: string[], forUpdate: boolean): Promise<RecordRow[]> {
  return tx.unsafe<RecordRow[]>(`SELECT * FROM records WHERE object_id = $1 AND id = ANY($2::uuid[])${forUpdate ? " FOR UPDATE" : ""}`, [objectId, ids]);
}

// --- Links, associations and merge chains -----------------------------------------------------------

export interface RecordLinkRow { field_id: string; from_id: string; to_id: string }

/** The custom relation links of these records, in these fields. */
export async function recordLinksFrom(tx: Tx, fromIds: string[], fieldIds: string[]): Promise<RecordLinkRow[]> {
  return tx<RecordLinkRow[]>`
      SELECT field_id, from_id, to_id FROM record_links
      WHERE from_id = ANY(${fromIds}::uuid[]) AND field_id = ANY(${fieldIds}::uuid[])`;
}

/** Links a record to another through a custom relation field. */
export async function insertRecordLink(tx: Tx, l: { tenantId: string; fieldId: string; fromId: string; toId: string; createdBy: string | null }): Promise<void> {
  await tx`INSERT INTO record_links (tenant_id, field_id, from_id, to_id, created_by) VALUES (${l.tenantId}, ${l.fieldId}, ${l.fromId}, ${l.toId}, ${l.createdBy})`;
}

/** Removes a record's links in one custom relation field. */
export async function clearRecordLinks(tx: Tx, fieldId: string, fromId: string): Promise<void> {
  await tx`DELETE FROM record_links WHERE field_id = ${fieldId} AND from_id = ${fromId}`;
}

/**
 * For each merged record, the chain of survivors it was merged into, following at most `maxHops`
 * merges and stopping at a cycle: the longest chain per record.
 */
export async function mergeChainRows(tx: Tx, ids: string[], maxHops: number): Promise<{ start: string; chain: string[] }[]> {
  return tx<{ start: string; chain: string[] }[]>`
    WITH RECURSIVE hop AS (
      SELECT m.merged AS start, m.survivor_id AS cur, ARRAY[m.survivor_id] AS chain
      FROM (SELECT survivor_id, unnest(merged_ids) AS merged FROM merges WHERE tenant_id = app.tenant_id() AND merged_ids && ${ids}::uuid[]) m
      WHERE m.merged = ANY (${ids}::uuid[])
      UNION ALL
      SELECT h.start, n.survivor_id, h.chain || n.survivor_id FROM hop h
      JOIN merges n ON n.tenant_id = app.tenant_id() AND n.merged_ids @> ARRAY[h.cur]
      WHERE cardinality(h.chain) < ${maxHops} AND NOT n.survivor_id = ANY (h.chain)
    )
    SELECT DISTINCT ON (start) start, chain FROM hop ORDER BY start, cardinality(chain) DESC`;
}

export interface AssociationRow { owner_id: string; record_id: string; object_id: string }

/** The records that these activities (or tasks) are about, with each record's object. */
export async function associationsOf(tx: Tx, table: "activity_associations" | "task_associations", key: "activity_id" | "task_id",
  ownerIds: string[]): Promise<AssociationRow[]> {
  return tx<AssociationRow[]>`
    SELECT a.${tx(key)} AS owner_id, a.record_id, rr.object_id FROM ${tx(table)} a
    JOIN record_registry rr ON rr.tenant_id = a.tenant_id AND rr.id = a.record_id
    WHERE a.${tx(key)} = ANY(${ownerIds}::uuid[])`;
}

// --- Unique values ----------------------------------------------------------------------------------

/** Serialises writers of one unique field until commit. */
export async function lockUniqueField(tx: Tx, fieldId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`unique:${fieldId}`}))`;
}

/**
 * Whether another live record holds `value` under `key` in the JSON column `json`, other than `selfId`.
 * `objectId` is the custom object whose records are checked, or null for a standard object's table.
 */
export async function jsonValueTaken(tx: Tx, q: { table: string; json: string; key: string; value: string; selfId: string | null; objectId: string | null }): Promise<boolean> {
  const rows = await tx.unsafe(
    `SELECT id FROM ${quoteIdent(q.table)} WHERE ${quoteIdent(q.json)}->>$1 = $2 AND archived_at IS NULL${q.objectId === null ? "" : " AND object_id = $4"} AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
    q.objectId === null ? [q.key, q.value, q.selfId] : [q.key, q.value, q.selfId, q.objectId],
  );
  return rows.length > 0;
}

/** Runs a "does another live record hold this value?" query built by core/records.ts (heldElsewhereSql). */
export async function valueHeldElsewhere(tx: Tx, text: string, params: unknown[]): Promise<boolean> {
  return (await tx.unsafe(text, params as never[])).length > 0;
}

// --- Writes -----------------------------------------------------------------------------------------

/** Registers a custom object's record, before its row is inserted. */
export async function registerRecord(tx: Tx, tenantId: string, id: string, objectId: string): Promise<void> {
  await tx`INSERT INTO record_registry (tenant_id, id, object_id) VALUES (${tenantId}, ${id}, ${objectId})`;
}

/**
 * Inserts a record row. `names` are the columns (from metadata), `placeholders` their `$n` placeholders
 * with casts, built by core/records.ts, and `params` the values in the same order.
 */
export async function insertRecordRow(tx: Tx, table: string, names: string[], placeholders: string[], params: unknown[]): Promise<void> {
  await tx.unsafe(
    `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")}) VALUES (${placeholders.join(", ")})`,
    params as never[],
  );
}

/**
 * Updates a record row and bumps its version. `sets` are the `"column" = $n` assignments built by
 * core/records.ts, and `params` their values followed by the record's ID.
 */
export async function updateRecordRow(tx: Tx, table: string, sets: string[], params: unknown[]): Promise<void> {
  await tx.unsafe(
    `UPDATE ${quoteIdent(table)} SET ${sets.join(", ")}, version = version + 1 WHERE id = $${sets.length + 1}`,
    params as never[],
  );
}

/** Archives a record. */
export async function archiveRecordRow(tx: Tx, table: string, id: string, actorId: string | null): Promise<void> {
  await tx.unsafe(`UPDATE ${quoteIdent(table)} SET archived_at = now(), version = version + 1, updated_by = $2 WHERE id = $1`, [id, actorId]);
}

/** Un-archives a record, with its rebuilt search text. */
export async function restoreRecordRow(tx: Tx, table: string, id: string, actorId: string | null, searchText: string): Promise<void> {
  await tx.unsafe(`UPDATE ${quoteIdent(table)} SET archived_at = NULL, search_text = $3, version = version + 1, updated_by = $2 WHERE id = $1`,
    [id, actorId, searchText]);
}

// --- Compiled queries (core/query.ts) ---------------------------------------------------------------

/** Runs a page query built by the query compiler. */
export async function compiledRows(tx: Tx, text: string, params: unknown[]): Promise<RecordRow[]> {
  return tx.unsafe<RecordRow[]>(text, params as never[]);
}

/** Runs a capped count built by the query compiler. */
export async function compiledCount(tx: Tx, text: string, params: unknown[]): Promise<number> {
  return (await tx.unsafe<{ n: number }[]>(text, params as never[]))[0]!.n;
}

/** Runs a bulk change's selection of record IDs, built by core/bulk.ts. */
export async function matchingIds(tx: Tx, text: string, params: unknown[]): Promise<{ id: string }[]> {
  return tx.unsafe<{ id: string }[]>(text, params as never[]);
}

/** Runs an aggregate built by core/aggregate.ts. */
export async function aggregateRows(tx: Tx, text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return tx.unsafe<Record<string, unknown>[]>(text, params as never[]);
}

// --- Entities by ID ---------------------------------------------------------------------------------

/** Related entity rows by ID (an include in a shaped response): the columns a response shows of a user, stage or other entity. */
export async function includedEntityRows(tx: Tx, to: keyof typeof ENTITIES, uuids: string[]): Promise<Record<string, unknown>[]> {
  const cols = to === "user" ? "id, name, CASE WHEN disabled_at IS NULL THEN email::text END AS email" : to === "stage" ? "id, name, category" : "id, name";
  return tx.unsafe<Record<string, unknown>[]>(`SELECT ${cols} FROM ${quoteIdent(ENTITIES[to].table)} WHERE id = ANY($1::uuid[])`, [uuids]);
}

/** IDs and names of entity rows (an aggregate's group keys). */
export async function entityNames(tx: Tx, table: string, uuids: string[]): Promise<{ id: string; name: string }[]> {
  return tx.unsafe<{ id: string; name: string }[]>(`SELECT id, name FROM ${quoteIdent(table)} WHERE id = ANY($1::uuid[])`, [uuids]);
}

// --- Counts for the schema summary ------------------------------------------------------------------


/** Live records of each of these custom objects, each counted up to `cap` + 1. */
export async function countLiveCustomRecordsCapped(tx: Tx, objectIds: string[], cap: number): Promise<{ id: string; n: number }[]> {
  return tx<{ id: string; n: number }[]>`
      SELECT o.id, (SELECT count(*)::int FROM (SELECT 1 FROM records r WHERE r.object_id = o.id AND r.archived_at IS NULL LIMIT ${cap + 1}) s) AS n
      FROM unnest(${objectIds}::uuid[]) AS o(id)`;
}
