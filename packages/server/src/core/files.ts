import { config } from "../config.js";
import type { Tx } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { fileStore, storeNamed } from "../providers/files.js";
import { assertObject } from "./access.js";
import { audit } from "./audit.js";
import type { Ctx } from "./context.js";
import { openBytes, sealBytes } from "./encryption.js";
import { DISGUISING } from "./fieldtypes.js";
import { fileUsageForUpdate, filesOfRecord, insertFile, liveFile, markFileDeleted, type FileRow } from "./queries/files.js";
import { getAnyRecord } from "./records.js";
import { getObject, loadSchema, type ObjectMeta } from "./schema.js";

/**
 * Files attached to records (ADR 0011). A file belongs to one record of any object. It follows that
 * record's object access: read on the object lists and downloads its files, write attaches and removes
 * them. Knowing a file's ID gives nothing: every call finds the record first, as the caller may see it.
 *
 * No scanner is built in, so every file is `unscanned` and is only ever sent as a download
 * (Content-Disposition: attachment, nosniff, application/octet-stream), never shown inline. The content
 * type kept with a file is detected from its first bytes, for showing; it is never the uploader's word.
 */

/** A record holds at most this many files. */
export const MAX_FILES_PER_RECORD = 100;
export const fileLimits = () => ({ max_bytes: config().FILE_MAX_MB * 1024 * 1024, quota_bytes: config().FILE_QUOTA_MB * 1024 * 1024 });

const publicFile = (f: FileRow, record: string) => ({
  id: encodeId("file", f.id), record, name: f.name, size: Number(f.size), content_type: f.content_type, sha256: f.sha256,
  scan_status: f.scan_status, uploaded_by: f.uploaded_by ? encodeId("usr", f.uploaded_by) : null, created_at: f.created_at.toISOString(),
});
export type FileOut = ReturnType<typeof publicFile>;

/**
 * The name a file is kept under: one line, no path. A browser sends only the last part of a path, but
 * a script can send anything, so separators and control characters are refused rather than cleaned.
 */
function checkName(raw: unknown): string {
  if (typeof raw !== "string") throw unprocessable("name is required: the file's name, as a query parameter");
  const name = raw.normalize("NFC").trim();
  if (!name || name.length > 255) throw unprocessable("name must be 1 to 255 characters");
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[/\\\x00-\x1f\x7f]/.test(name) || DISGUISING.test(name)) throw unprocessable("name must be one line of text without / or \\");
  if (name === "." || name === "..") throw unprocessable("name is not a file name");
  return name;
}

/** The type a file's first bytes say it is, for showing in a list. Anything unrecognised is application/octet-stream. */
export function sniffContentType(data: Buffer): string {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  const ascii = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip"; // also docx, xlsx, pptx and odt, which are zip files
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "application/x-ole-storage"; // doc, xls, ppt, msg
  if (starts(0x1f, 0x8b)) return "application/gzip";
  // Text: valid UTF-8 with no NUL in the first 4 KB.
  const head = data.subarray(0, 4096);
  if (!head.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data.length > 4096 ? head.subarray(0, lastWholeChar(head)) : head);
      return "text/plain";
    } catch { /* not text */ }
  }
  return "application/octet-stream";
}

/** Where the last complete UTF-8 character of a cut buffer ends, so a cut inside a character isn't read as invalid text. */
function lastWholeChar(b: Buffer): number {
  let i = b.length;
  while (i > 0 && i > b.length - 4 && (b[i - 1]! & 0xc0) === 0x80) i--; // continuation bytes
  return i > 0 && (b[i - 1]! & 0x80) !== 0 ? i - 1 : b.length; // drop a lead byte whose character was cut
}

/** The record a file belongs to, as the caller may see it (404 or 403 otherwise), and its object. */
async function recordFor(tx: Tx, ctx: Ctx, recordPublicId: string): Promise<{ id: string; uuid: string; object: ObjectMeta; archived: boolean }> {
  const record = await getAnyRecord(tx, ctx, recordPublicId, { shallow: true });
  const object = getObject(await loadSchema(tx), record.object as string);
  return { id: record.id as string, uuid: decodeId(record.id as string)!.uuid, object, archived: Boolean(record.archived_at) };
}

export async function listFiles(tx: Tx, ctx: Ctx, recordPublicId: string): Promise<FileOut[]> {
  const record = await recordFor(tx, ctx, recordPublicId);
  return (await filesOfRecord(tx, record.uuid)).map((f) => publicFile(f, record.id));
}

/** Attaches a file to a record. Needs write on the record's object. */
export async function uploadFile(tx: Tx, ctx: Ctx, recordPublicId: string, input: { name: unknown; data: Buffer }): Promise<FileOut> {
  const record = await recordFor(tx, ctx, recordPublicId);
  assertObject(ctx, record.object, "write");
  if (record.archived) throw conflict("This record is archived; restore it to attach files");
  const name = checkName(input.name);
  const limits = fileLimits();
  if (input.data.length === 0) throw unprocessable("The file is empty");
  if (input.data.length > limits.max_bytes) throw unprocessable(`The file is larger than ${config().FILE_MAX_MB} MB`);
  const usage = await fileUsageForUpdate(tx, ctx.tenantId, record.uuid);
  if (usage.on_record >= MAX_FILES_PER_RECORD) throw conflict(`A record holds at most ${MAX_FILES_PER_RECORD} files`);
  if (Number(usage.bytes) + input.data.length > limits.quota_bytes) {
    throw conflict(`This workspace's files would pass its limit of ${config().FILE_QUOTA_MB} MB; remove files, or ask whoever runs the server to raise FILE_QUOTA_MB`);
  }
  const store = fileStore();
  const id = uuidv7();
  const sealed = store.external ? await sealBytes(tx, ctx.tenantId, id, input.data) : null;
  const row = await insertFile(tx, { tenantId: ctx.tenantId, id, recordId: record.uuid, name, size: input.data.length, contentType: sniffContentType(input.data),
    sha256: sha256(input.data).toString("hex"), store: store.name, keyVersion: sealed?.version ?? null, uploadedBy: ctx.actor.type === "user" ? ctx.actor.id : null });
  await store.put(tx, ctx.tenantId, id, sealed?.sealed ?? input.data);
  await audit(tx, ctx, { action: "file.uploaded", objectType: record.object.api_name, recordId: record.uuid,
    details: { file: encodeId("file", id), size: input.data.length, content_type: row.content_type, store: store.name } });
  return publicFile(row, record.id);
}

/** A file and the record it is on, for a caller who can read that record (404 otherwise, whatever the reason). */
async function fileFor(tx: Tx, ctx: Ctx, filePublicId: string, lock = false) {
  const d = decodeId(filePublicId);
  const row = d?.prefix === "file" ? await liveFile(tx, d.uuid, lock) : undefined;
  if (!row) throw notFound(`File ${filePublicId}`);
  const schema = await loadSchema(tx);
  // The record's object comes from the registry; a caller who can't read it is told the file doesn't exist.
  const object = [...schema.objects.values()].find((o) => o.id === row.object_id);
  if (!object) throw notFound(`File ${filePublicId}`);
  return { row, object };
}

export async function getFile(tx: Tx, ctx: Ctx, filePublicId: string): Promise<FileOut> {
  const { row, object } = await fileFor(tx, ctx, filePublicId);
  assertObject(ctx, object, "read");
  return publicFile(row, encodeId(object.id_prefix, row.record_id));
}

/** A file's bytes, checked against what was stored. Needs read on the record's object. Audited. */
export async function downloadFile(tx: Tx, ctx: Ctx, filePublicId: string): Promise<{ file: FileOut; data: Buffer }> {
  const { row, object } = await fileFor(tx, ctx, filePublicId);
  assertObject(ctx, object, "read");
  const stored = await storeNamed(row.store).get(tx, ctx.tenantId, row.id);
  if (!stored) throw notFound(`File ${filePublicId}`);
  const data = row.key_version !== null ? await openBytes(tx, ctx.tenantId, row.id, stored, row.key_version) : stored;
  if (sha256(data).toString("hex") !== row.sha256) throw new Error(`file ${row.id} does not match its stored hash`);
  await audit(tx, ctx, { action: "file.downloaded", objectType: object.api_name, recordId: row.record_id, details: { file: encodeId("file", row.id) } });
  return { file: publicFile(row, encodeId(object.id_prefix, row.record_id)), data };
}

/**
 * Removes a file: its row is kept, marked removed, and its bytes are deleted. Needs write on the record's
 * object. With a store outside the database the bytes go after the transaction commits (`after`).
 */
export async function deleteFile(tx: Tx, ctx: Ctx, filePublicId: string): Promise<{ result: { id: string; deleted: true }; after?: () => Promise<void> }> {
  const { row, object } = await fileFor(tx, ctx, filePublicId, true);
  assertObject(ctx, object, "read");
  assertObject(ctx, object, "write");
  await markFileDeleted(tx, row.id, ctx.actor.id);
  const store = storeNamed(row.store);
  await audit(tx, ctx, { action: "file.deleted", objectType: object.api_name, recordId: row.record_id, details: { file: encodeId("file", row.id), size: Number(row.size) } });
  const result = { id: encodeId("file", row.id), deleted: true as const };
  if (!store.external) {
    await store.delete(tx, ctx.tenantId, row.id);
    return { result };
  }
  const tenantId = ctx.tenantId;
  return { result, after: () => store.delete(tx, tenantId, row.id) };
}
