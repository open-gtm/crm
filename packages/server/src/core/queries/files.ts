import type { Tx } from "../../db/pool.js";

/**
 * The SQL of files attached to records (core/files.ts, providers/files.ts; ADR 0011, ADR 0012).
 * The code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

export interface FileRow {
  id: string; record_id: string; name: string; size: string; content_type: string; sha256: string; store: "postgres" | "s3";
  key_version: number | null; scan_status: string; uploaded_by: string | null; created_at: Date;
}

const columns = (tx: Tx) => tx`f.id, f.record_id, f.name, f.size::text, f.content_type, f.sha256, f.store, f.key_version, f.scan_status, f.uploaded_by, f.created_at`;

/** A record's files that haven't been removed, oldest first. */
export async function filesOfRecord(tx: Tx, recordId: string): Promise<FileRow[]> {
  return tx<FileRow[]>`SELECT ${columns(tx)} FROM files f WHERE f.record_id = ${recordId} AND f.deleted_at IS NULL ORDER BY f.created_at, f.id`;
}

/** One file that hasn't been removed, with the object of the record it is on; `lock` locks the file's row for the rest of the transaction. */
export async function liveFile(tx: Tx, id: string, lock = false): Promise<(FileRow & { object_id: string }) | undefined> {
  const [row] = await tx<(FileRow & { object_id: string })[]>`
    SELECT ${columns(tx)}, r.object_id FROM files f JOIN record_registry r ON r.tenant_id = f.tenant_id AND r.id = f.record_id
    WHERE f.id = ${id} AND f.deleted_at IS NULL ${lock ? tx`FOR UPDATE OF f` : tx``}`;
  return row;
}

/**
 * How many files a record holds and how many bytes the workspace's files hold, read under a lock on the
 * workspace's file usage, so two uploads at once can't both fit under the quota.
 */
export async function fileUsageForUpdate(tx: Tx, tenantId: string, recordId: string): Promise<{ on_record: number; bytes: string }> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`files:${tenantId}`}, 0))`;
  const [row] = await tx<{ on_record: number; bytes: string }[]>`
    SELECT (SELECT count(*) FROM files WHERE record_id = ${recordId} AND deleted_at IS NULL)::int AS on_record,
           (SELECT coalesce(sum(size), 0) FROM files WHERE deleted_at IS NULL)::text AS bytes`;
  return row!;
}

export async function insertFile(tx: Tx, f: { tenantId: string; id: string; recordId: string; name: string; size: number; contentType: string; sha256: string;
  store: "postgres" | "s3"; keyVersion: number | null; uploadedBy: string | null }): Promise<FileRow> {
  const [row] = await tx<FileRow[]>`
    INSERT INTO files (tenant_id, id, record_id, name, size, content_type, sha256, store, key_version, uploaded_by)
    VALUES (${f.tenantId}, ${f.id}, ${f.recordId}, ${f.name}, ${f.size}, ${f.contentType}, ${f.sha256}, ${f.store}, ${f.keyVersion}, ${f.uploadedBy})
    RETURNING id, record_id, name, size::text, content_type, sha256, store, key_version, scan_status, uploaded_by, created_at`;
  return row!;
}

/** Marks a file removed. Its bytes are deleted by the store. */
export async function markFileDeleted(tx: Tx, id: string, deletedBy: string | null): Promise<void> {
  await tx`UPDATE files SET deleted_at = now(), deleted_by = ${deletedBy} WHERE id = ${id}`;
}

// --- The postgres store's bytes ---------------------------------------------------------------------

export async function insertFileBlob(tx: Tx, tenantId: string, fileId: string, data: Buffer): Promise<void> {
  await tx`INSERT INTO file_blobs (tenant_id, file_id, data) VALUES (${tenantId}, ${fileId}, ${data})`;
}

export async function fileBlob(tx: Tx, fileId: string): Promise<Buffer | undefined> {
  const [row] = await tx<{ data: Buffer }[]>`SELECT data FROM file_blobs WHERE file_id = ${fileId}`;
  return row?.data;
}

export async function deleteFileBlob(tx: Tx, fileId: string): Promise<void> {
  await tx`DELETE FROM file_blobs WHERE file_id = ${fileId}`;
}

// --- Merges -----------------------------------------------------------------------------------------

/** How many files the records in a merge hold. */
export async function countFilesOf(tx: Tx, recordIds: string[]): Promise<number> {
  const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM files WHERE tenant_id = app.tenant_id() AND record_id = ANY (${recordIds}::uuid[])`;
  return row!.n;
}

/** Moves the duplicates' files to the survivor: a merge keeps every document (ADR 0011). */
export async function moveFiles(tx: Tx, survivor: string, dups: string[]): Promise<{ id: string; old: string }[]> {
  return tx<{ id: string; old: string }[]>`
    UPDATE files f SET record_id = ${survivor} FROM (SELECT id, record_id AS old FROM files WHERE tenant_id = app.tenant_id() AND record_id = ANY (${dups}::uuid[])) o
    WHERE f.tenant_id = app.tenant_id() AND f.id = o.id RETURNING f.id, o.old`;
}
