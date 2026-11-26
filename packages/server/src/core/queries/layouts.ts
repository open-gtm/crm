import type { Tx } from "../../db/pool.js";

/** The SQL of record page layouts, their shared draft and their history (core/layouts.ts; ADR 0012, ADR 0017). */

/** A layout as stored: fields and objects by ID, so a rename keeps their place. Version 1 is sections only (ADR 0015). */
export type StoredLayout = Record<string, unknown>;
export interface LayoutRow { layout: StoredLayout | null; version: number; updated_at: Date }
export interface DraftRow { layout: StoredLayout; revision: number; base_version: number; created_at: Date; updated_at: Date }
export interface Source { actorType: string; actorId: string | null; surface: string; via: string | null }
export interface VersionRow {
  version: number; layout: StoredLayout | null; summary: string; changes: string[]; contributors: Contributor[]; restored_from: number | null;
  actor_type: string; actor_id: string | null; surface: string; via: string | null; created_at: Date;
}
export interface Contributor { actor: string | null; surface: string; via: string | null; summary: string; note: string | null; at: string }
export interface ChangeRow {
  id: string; revision: number; summary: string; changes: string[]; note: string | null; before: StoredLayout; after: StoredLayout;
  actor_type: string; actor_id: string | null; surface: string; via: string | null; created_at: Date; reviewed_at: Date | null;
}

// --- Published ----------------------------------------------------------------------------------------

export async function pageLayout(tx: Tx, objectId: string, forUpdate = false): Promise<LayoutRow | undefined> {
  const [row] = forUpdate
    ? await tx<LayoutRow[]>`SELECT layout, version, updated_at FROM page_layouts WHERE object_id = ${objectId} FOR UPDATE`
    : await tx<LayoutRow[]>`SELECT layout, version, updated_at FROM page_layouts WHERE object_id = ${objectId}`;
  return row;
}

/** Publishes a layout (null: the default page) as the object's next version, and returns that version's number. */
export async function publishPageLayout(tx: Tx, l: { tenantId: string; objectId: string; layout: StoredLayout | null; updatedBy: string | null }): Promise<number> {
  const [row] = await tx<{ version: number }[]>`
    INSERT INTO page_layouts (tenant_id, object_id, layout, updated_by) VALUES (${l.tenantId}, ${l.objectId}, ${l.layout === null ? null : tx.json(l.layout as never)}, ${l.updatedBy})
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by, version = page_layouts.version + 1
    RETURNING version`;
  return row!.version;
}

// --- Versions -----------------------------------------------------------------------------------------

export async function insertVersion(tx: Tx, v: Source & { tenantId: string; objectId: string; version: number; layout: StoredLayout | null; summary: string;
  changes: string[]; contributors: Contributor[]; restoredFrom: number | null }): Promise<void> {
  await tx`
    INSERT INTO page_layout_versions (tenant_id, object_id, version, layout, summary, changes, contributors, restored_from, actor_type, actor_id, surface, via)
    VALUES (${v.tenantId}, ${v.objectId}, ${v.version}, ${v.layout === null ? null : tx.json(v.layout as never)}, ${v.summary}, ${tx.json(v.changes)},
            ${tx.json(v.contributors as never)}, ${v.restoredFrom}, ${v.actorType}, ${v.actorId}, ${v.surface}, ${v.via})`;
}

/** An object's versions, newest first. */
export async function versionsOf(tx: Tx, objectId: string, limit: number): Promise<VersionRow[]> {
  return tx<VersionRow[]>`SELECT version, layout, summary, changes, contributors, restored_from, actor_type, actor_id, surface, via, created_at
                          FROM page_layout_versions WHERE object_id = ${objectId} ORDER BY version DESC LIMIT ${limit}`;
}

export async function versionOf(tx: Tx, objectId: string, version: number): Promise<VersionRow | undefined> {
  const [row] = await tx<VersionRow[]>`SELECT version, layout, summary, changes, contributors, restored_from, actor_type, actor_id, surface, via, created_at
                                       FROM page_layout_versions WHERE object_id = ${objectId} AND version = ${version}`;
  return row;
}

/** Keeps an object's newest `keep` versions. */
export async function trimVersions(tx: Tx, objectId: string, keep: number): Promise<void> {
  await tx`DELETE FROM page_layout_versions WHERE object_id = ${objectId}
           AND version <= (SELECT max(version) FROM page_layout_versions WHERE object_id = ${objectId}) - ${keep}`;
}

// --- The draft and its changes ------------------------------------------------------------------------

export async function draftOf(tx: Tx, objectId: string, forUpdate = false): Promise<DraftRow | undefined> {
  const [row] = forUpdate
    ? await tx<DraftRow[]>`SELECT layout, revision, base_version, created_at, updated_at FROM page_layout_drafts WHERE object_id = ${objectId} FOR UPDATE`
    : await tx<DraftRow[]>`SELECT layout, revision, base_version, created_at, updated_at FROM page_layout_drafts WHERE object_id = ${objectId}`;
  return row;
}

/** Starts the draft at revision 1, or moves it on by one. Returns the revision it now has. */
export async function saveDraft(tx: Tx, d: { tenantId: string; objectId: string; layout: StoredLayout; baseVersion: number }): Promise<number> {
  const [row] = await tx<{ revision: number }[]>`
    INSERT INTO page_layout_drafts (tenant_id, object_id, layout, base_version) VALUES (${d.tenantId}, ${d.objectId}, ${tx.json(d.layout as never)}, ${d.baseVersion})
    ON CONFLICT (tenant_id, object_id) DO UPDATE SET layout = EXCLUDED.layout, revision = page_layout_drafts.revision + 1
    RETURNING revision`;
  return row!.revision;
}

/** Removes the draft and, with it, its changes. True when there was one. */
export async function deleteDraft(tx: Tx, objectId: string): Promise<boolean> {
  const rows = await tx`DELETE FROM page_layout_drafts WHERE object_id = ${objectId} RETURNING object_id`;
  return rows.length > 0;
}

export async function insertChange(tx: Tx, c: Source & { tenantId: string; id: string; objectId: string; revision: number; summary: string; changes: string[];
  note: string | null; before: StoredLayout; after: StoredLayout }): Promise<void> {
  await tx`
    INSERT INTO page_layout_changes (tenant_id, id, object_id, revision, summary, changes, note, before, after, actor_type, actor_id, surface, via)
    VALUES (${c.tenantId}, ${c.id}, ${c.objectId}, ${c.revision}, ${c.summary}, ${tx.json(c.changes)}, ${c.note}, ${tx.json(c.before as never)},
            ${tx.json(c.after as never)}, ${c.actorType}, ${c.actorId}, ${c.surface}, ${c.via})`;
}

/** A draft's changes, newest first. */
export async function changesOf(tx: Tx, objectId: string): Promise<ChangeRow[]> {
  return tx<ChangeRow[]>`SELECT id, revision, summary, changes, note, before, after, actor_type, actor_id, surface, via, created_at, reviewed_at
                         FROM page_layout_changes WHERE object_id = ${objectId} ORDER BY revision DESC`;
}

export async function changeById(tx: Tx, id: string): Promise<(ChangeRow & { object_id: string }) | undefined> {
  const [row] = await tx<(ChangeRow & { object_id: string })[]>`
    SELECT id, object_id, revision, summary, changes, note, before, after, actor_type, actor_id, surface, via, created_at, reviewed_at
    FROM page_layout_changes WHERE id = ${id}`;
  return row;
}

export async function markChangeReviewed(tx: Tx, id: string, by: string | null): Promise<void> {
  await tx`UPDATE page_layout_changes SET reviewed_at = now(), reviewed_by = ${by} WHERE id = ${id} AND reviewed_at IS NULL`;
}

/** Keeps a draft's newest `keep` changes: a long-lived draft doesn't grow without bound. */
export async function trimChanges(tx: Tx, objectId: string, keep: number): Promise<void> {
  await tx`DELETE FROM page_layout_changes WHERE object_id = ${objectId}
           AND revision <= (SELECT max(revision) FROM page_layout_changes WHERE object_id = ${objectId}) - ${keep}`;
}

// --- Where a change came from --------------------------------------------------------------------------

export async function apiKeyName(tx: Tx, id: string): Promise<string | undefined> {
  const [row] = await tx<{ name: string }[]>`SELECT name FROM api_keys WHERE id = ${id}`;
  return row?.name;
}

export async function oauthClientName(tx: Tx, grantId: string): Promise<string | undefined> {
  const [row] = await tx<{ client_name: string }[]>`SELECT client_name FROM oauth_grants WHERE id = ${grantId}`;
  return row?.client_name;
}
