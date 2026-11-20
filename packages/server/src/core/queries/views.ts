import type { Tx } from "../../db/pool.js";
import type { ViewDefinition } from "../views.js";

/**
 * The SQL of saved views (core/views.ts; ADR 0012). The code that calls these keeps its checks, errors,
 * audits and the order of statements in its transaction.
 */

export interface ViewRow {
  id: string; object_id: string; name: string; shared: boolean; owner_type: string | null; owner_id: string | null;
  definition: ViewDefinition; created_by: string | null; updated_by: string | null; created_at: Date; updated_at: Date; version: number;
}

export async function viewById(tx: Tx, id: string): Promise<ViewRow | undefined> {
  const [row] = await tx<ViewRow[]>`SELECT * FROM views WHERE id = ${id}`;
  return row;
}

/** The shared views and the actor's own, of one object (or all, when `objectId` is null), at most `limit`. */
export async function sharedAndOwnViews(tx: Tx, q: { actorType: string; actorId: string | null; objectId: string | null; limit: number }): Promise<ViewRow[]> {
  return tx<ViewRow[]>`
    SELECT * FROM views
    WHERE (shared OR (owner_type = ${q.actorType} AND owner_id = ${q.actorId}::uuid)) AND (${q.objectId}::uuid IS NULL OR object_id = ${q.objectId}::uuid)
    ORDER BY shared, name, id LIMIT ${q.limit}`;
}

/** A definition's size as the database CHECK measures it: the length of the jsonb's text. */
export async function definitionBytes(tx: Tx, def: ViewDefinition): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT octet_length(${tx.json(def as never)}::jsonb::text)::int AS n`;
  return r!.n;
}

/** Serialises writers to one view cap: the workspace's shared views, or one member's own. */
export async function lockViewCap(tx: Tx, tenantId: string, shared: boolean, owner: { type: string | null; id: string | null }): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`views:${tenantId}:${shared ? "shared" : `${owner.type}:${owner.id}`}`}))`;
}

/** How many shared views the workspace has, or (not `shared`) how many personal views the owner has. */
export async function countViews(tx: Tx, shared: boolean, owner: { type: string | null; id: string | null }): Promise<number> {
  const [counted] = shared
    ? await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM views WHERE shared`
    : await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM views WHERE owner_type = ${owner.type} AND owner_id = ${owner.id}`;
  return counted!.n;
}

export async function insertView(tx: Tx, v: { tenantId: string; id: string; objectId: string; name: string; shared: boolean; ownerType: string | null;
  ownerId: string | null; definition: ViewDefinition; actorId: string | null }): Promise<ViewRow | undefined> {
  const [row] = await tx<ViewRow[]>`
    INSERT INTO views (tenant_id, id, object_id, name, shared, owner_type, owner_id, definition, created_by, updated_by)
    VALUES (${v.tenantId}, ${v.id}, ${v.objectId}, ${v.name}, ${v.shared}, ${v.ownerType}, ${v.ownerId},
            ${tx.json(v.definition as never)}, ${v.actorId}, ${v.actorId}) RETURNING *`;
  return row;
}

/** Rewrites a view and moves it to its next version. */
export async function updateViewRow(tx: Tx, v: { id: string; name: string; shared: boolean; ownerType: string | null; ownerId: string | null;
  definition: ViewDefinition; actorId: string | null }): Promise<ViewRow | undefined> {
  const [updated] = await tx<ViewRow[]>`
    UPDATE views SET name = ${v.name}, shared = ${v.shared}, owner_type = ${v.ownerType}, owner_id = ${v.ownerId}, definition = ${tx.json(v.definition as never)},
      updated_by = ${v.actorId}, version = version + 1 WHERE id = ${v.id} RETURNING *`;
  return updated;
}

export async function deleteViewRow(tx: Tx, id: string): Promise<void> {
  await tx`DELETE FROM views WHERE id = ${id}`;
}
