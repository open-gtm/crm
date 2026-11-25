import type { Tx } from "../../db/pool.js";

/** The SQL of record page layouts (core/layouts.ts; ADR 0012). */

export interface StoredLayout { sections: { title: string; fields: string[] }[] }
export interface LayoutRow { layout: StoredLayout; version: number; updated_at: Date }

export async function pageLayout(tx: Tx, objectId: string): Promise<LayoutRow | undefined> {
  const [row] = await tx<LayoutRow[]>`SELECT layout, version, updated_at FROM page_layouts WHERE object_id = ${objectId}`;
  return row;
}

/** Sets an object's layout, replacing the one it had. */
export async function upsertPageLayout(tx: Tx, l: { tenantId: string; objectId: string; layout: StoredLayout; updatedBy: string | null }): Promise<void> {
  await tx`INSERT INTO page_layouts (tenant_id, object_id, layout, updated_by) VALUES (${l.tenantId}, ${l.objectId}, ${tx.json(l.layout as never)}, ${l.updatedBy})
           ON CONFLICT (tenant_id, object_id) DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by, version = page_layouts.version + 1`;
}

/** Removes an object's layout, so its record page is the default again. True when there was one. */
export async function deletePageLayout(tx: Tx, objectId: string): Promise<boolean> {
  const rows = await tx`DELETE FROM page_layouts WHERE object_id = ${objectId} RETURNING object_id`;
  return rows.length > 0;
}
