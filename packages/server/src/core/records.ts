import type { Tx } from "../db/pool.js";
import { txState } from "../db/tx.js";
import { ApiError, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { accessGuard, assertObject, assertWritable, canObject, fieldAccess, internalReader } from "./access.js";
import { audit } from "./audit.js";
import { ENTITIES, isEntity, own, STATUS_CATEGORY_COLUMNS, STATUS_MACHINES } from "./catalog.js";
import { actorUserId, can, type Ctx } from "./context.js";
import { decryptValue, encryptValue } from "./encryption.js";
import { emit } from "./events.js";
import { FieldValueError, fromStorage, normalizeInput, searchString, toStorage } from "./fieldtypes.js";
import { compileQuery, COUNT_CAP, encodeCursor, type QueryInput } from "./query.js";
import {
  archiveRecordRow, associationsOf, clearRecordLinks, compiledCount, compiledRows, customRowsById, entityRowExists, insertRecordLink, insertRecordRow,
  jsonValueTaken, lockUniqueField, mergeChainRows, recordLinksFrom, registeredRecordExists, registerRecord, restoreRecordRow, standardRowsById,
  updateRecordRow, valueHeldElsewhere, type RecordRow,
} from "./queries/records.js";
import { getObject, loadSchema, quoteIdent, SEARCH_TEXT_TYPES, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";
import { afterArchive, afterCreate, afterUpdate, beforeArchive, beforeCreate, beforeUpdate, type Draft } from "./standard.js";

export type RecordOut = Record<string, unknown> & { id: string; object: string };
type Row = RecordRow;

const VIRTUAL_INPUTS: Record<string, string[]> = { activity: ["related_to"], task: ["related_to"] };

// ----------------------------------------------------------------------------------------------
// Helpers

export function prefixFor(schema: Schema, target: string): string {
  if (isEntity(target)) return ENTITIES[target].prefix;
  const o = schema.objects.get(target);
  if (!o) throw new Error(`unknown relation target ${target}`);
  return o.id_prefix;
}

/** Resolves a public ID to a UUID, checking its type and that it exists in this workspace. */
export async function resolveRef(tx: Tx, schema: Schema, target: string, publicId: string, field: string): Promise<string> {
  const decoded = decodeId(publicId);
  if (!decoded || decoded.prefix !== prefixFor(schema, target)) {
    throw unprocessable(`"${field}" must be a ${target} ID (${prefixFor(schema, target)}_…); got "${publicId}"`, { field });
  }
  let found: boolean;
  if (isEntity(target)) {
    found = await entityRowExists(tx, ENTITIES[target].table, decoded.uuid);
  } else {
    found = await registeredRecordExists(tx, decoded.uuid, schema.objects.get(target)!.id);
  }
  if (!found) throw unprocessable(`"${field}": ${target} ${publicId} was not found`, { field });
  return decoded.uuid;
}

export function displayName(obj: ObjectMeta, rec: Record<string, unknown>): string {
  const s = (k: string) => (typeof rec[k] === "string" ? (rec[k] as string) : "");
  switch (obj.api_name) {
    case "contact": return [s("first_name"), s("last_name")].filter(Boolean).join(" ") || s("email") || "Unnamed contact";
    case "account": case "deal": return s("name");
    case "task": return s("title");
    case "activity": return s("subject") || s("type");
    case "lead": return s("interest") || s("campaign") || "Lead";
    case "account_contact": case "deal_contact": return s("role") || obj.label;
    default: return (obj.display_field && rec[obj.display_field] != null ? String(rec[obj.display_field]) : "") || obj.label;
  }
}

function searchText(obj: ObjectMeta, values: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const f of obj.fields) {
    if (f.sensitivity === "restricted") continue;
    if (!SEARCH_TEXT_TYPES.includes(f.type)) continue;
    const v = searchString(f.type, values[f.api_name]);
    if (v !== null) parts.push(v);
  }
  return parts.join(" ").toLowerCase().slice(0, 4000);
}

function storageColumns(obj: ObjectMeta) {
  return obj.is_system ? { json: "custom", enc: "custom_encrypted" } : { json: "data", enc: "encrypted" };
}

// ----------------------------------------------------------------------------------------------
// Serialization

export interface SerializeOpts { includeHidden?: boolean; /** Leave out `related` names (used when resolving them, so it doesn't recurse). */ shallow?: boolean }

/**
 * Records as the caller may see them: fields the caller can't read are left out (not nulled), and
 * display_name is built from what remains. Refuses an object the caller can't read at all.
 */
export async function serialize(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, rows: Row[], opts: SerializeOpts = {}): Promise<RecordOut[]> {
  if (rows.length === 0) return [];
  assertObject(ctx, obj, "read");
  const fields = obj.fields.filter((f) => (!f.hidden || opts.includeHidden) && fieldAccess(ctx, obj, f) !== "none");
  const linkFields = fields.filter((f) => f.type === "relation" && !f.column_name);
  const links = new Map<string, Map<string, string[]>>();
  if (linkFields.length) {
    const rs = await recordLinksFrom(tx, rows.map((r) => r.id), linkFields.map((f) => f.id));
    for (const l of rs) {
      const byField = links.get(l.from_id) ?? new Map<string, string[]>();
      byField.set(l.field_id, [...(byField.get(l.field_id) ?? []), l.to_id]);
      links.set(l.from_id, byField);
    }
  }
  const canSeeRestricted = can(ctx, "restricted:read");
  const { json, enc } = storageColumns(obj);
  const mergedInto = await mergedTargets(tx, rows);
  const out: RecordOut[] = [];
  for (const row of rows) {
    const rec: RecordOut = { id: encodeId(obj.id_prefix, row.id), object: obj.api_name, display_name: "" };
    const jsonVals = (row[json] ?? {}) as Record<string, unknown>;
    const encVals = (row[enc] ?? {}) as Record<string, string>;
    for (const f of fields) {
      let value: unknown;
      if (f.type === "relation") {
        const target = f.options.to!;
        if (f.column_name) {
          const raw = row[f.column_name] as string | null;
          value = raw ? encodeId(prefixFor(schema, target), raw) : null;
        } else {
          const ids = (links.get(row.id)?.get(f.id) ?? []).map((u) => encodeId(prefixFor(schema, target), u));
          value = f.options.cardinality === "many_to_many" ? ids : ids[0] ?? null;
        }
      } else if (f.sensitivity === "restricted" && !f.column_name) {
        const stored = encVals[f.storage_key];
        if (stored === undefined) value = null;
        else value = canSeeRestricted ? fromStorage(f.type, await decryptValue(tx, ctx.tenantId, row.id, f.storage_key, stored)) : "[restricted]";
      } else if (f.column_name) {
        value = fromStorage(f.type, row[f.column_name]);
      } else {
        value = fromStorage(f.type, jsonVals[f.storage_key]);
      }
      rec[f.api_name] = value;
    }
    rec.display_name = displayName(obj, rec);
    rec.created_at = fromStorage("datetime", row.created_at);
    rec.updated_at = fromStorage("datetime", row.updated_at);
    rec.version = row.version;
    if (row.archived_at) rec.archived_at = fromStorage("datetime", row.archived_at);
    // Erased for good (core/erasure.ts): the row stays so references to it hold, its values are gone.
    if (row.anonymized_at) rec.erased_at = fromStorage("datetime", row.anonymized_at);
    const chain = mergedInto.get(row.id);
    if (chain) {
      rec.merged_into = encodeId(obj.id_prefix, chain[chain.length - 1]!);
      rec.merge_chain = chain.map((id) => encodeId(obj.id_prefix, id));
    }
    out.push(rec);
  }
  if (obj.api_name === "activity" || obj.api_name === "task") await attachRelated(tx, ctx, schema, obj, rows, out, opts);
  return out;
}

/** Survivors of merged records (core/merge.ts): one query, and only when the page holds an archived record. */
async function mergedTargets(tx: Tx, rows: Row[]): Promise<Map<string, string[]>> {
  const archived = rows.filter((r) => r.archived_at).map((r) => r.id);
  return archived.length ? mergeChains(tx, archived) : new Map();
}

/** Merges a chain may follow (A into B, B into C, ...) before it stops; a merged record can't be merged again, so real chains are short. */
const MERGE_HOPS = 10;

/**
 * For each merged record, the survivors it was merged into, in order: [B] when A went into B, [B, C]
 * when B was later merged into C. The last one is where its references are now.
 */
export async function mergeChains(tx: Tx, ids: string[]): Promise<Map<string, string[]>> {
  const found = await mergeChainRows(tx, ids, MERGE_HOPS);
  return new Map(found.map((f) => [f.start, f.chain]));
}

/**
 * The records an activity or task is about: `related_to` (IDs) and `related` (ID, object and display
 * name). Names are resolved as the reader's role sees them: null for an object the reader can't read,
 * and built only from fields they can read. This is how history activities show what they are about
 * without copying a value into their subject. One query for the links, one per related object.
 */
async function attachRelated(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, rows: Row[], out: RecordOut[], opts: SerializeOpts) {
  const [table, key] = obj.api_name === "activity" ? ["activity_associations", "activity_id"] as const : ["task_associations", "task_id"] as const;
  const assoc = await associationsOf(tx, table, key, rows.map((r) => r.id));
  const names = new Map<string, string>();
  if (!opts.shallow) {
    const byObject = new Map<string, string[]>();
    for (const a of assoc) byObject.set(a.object_id, [...(byObject.get(a.object_id) ?? []), a.record_id]);
    for (const [objectId, ids] of byObject) {
      const target = schema.byId.get(objectId);
      if (!target || !canObject(ctx, target, "read")) continue;
      for (const r of await serialize(tx, ctx, schema, target, await fetchRows(tx, target, [...new Set(ids)]), { shallow: true })) {
        names.set(decodeId(r.id)!.uuid, String(r.display_name));
      }
    }
  }
  out.forEach((rec, i) => {
    const mine = assoc.filter((a) => a.owner_id === rows[i]!.id);
    rec.related_to = mine.map((x) => encodeId(schema.byId.get(x.object_id)?.id_prefix ?? "rec", x.record_id));
    if (!opts.shallow) {
      rec.related = mine.map((x) => {
        const target = schema.byId.get(x.object_id);
        return { id: encodeId(target?.id_prefix ?? "rec", x.record_id), object: target?.api_name ?? null, display_name: names.get(x.record_id) ?? null };
      });
    }
  });
}

export async function fetchRows(tx: Tx, obj: ObjectMeta, ids: string[], forUpdate = false): Promise<Row[]> {
  if (obj.is_system) {
    return standardRowsById(tx, obj.table_name!, ids, forUpdate);
  }
  return customRowsById(tx, obj.id, ids, forUpdate);
}

function parseRecordId(obj: ObjectMeta, publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== obj.id_prefix) throw notFound(`${obj.label} ${publicId}`);
  return d.uuid;
}

// ----------------------------------------------------------------------------------------------
// Input handling

interface Prepared {
  columns: Map<string, unknown>;        // typed columns
  json: Record<string, unknown>;        // custom / data
  encrypted: Record<string, unknown>;   // restricted values (plaintext until stored)
  links: Map<FieldMeta, string[]>;      // custom relation values (resolved UUIDs)
  values: Record<string, unknown>;      // normalized API-level values, for events and search text
}

async function prepare(tx: Tx, schema: Schema, obj: ObjectMeta, input: Record<string, unknown>, mode: "create" | "update"): Promise<Prepared> {
  const p: Prepared = { columns: new Map(), json: {}, encrypted: {}, links: new Map(), values: {} };
  const errors: { field: string; message: string }[] = [];
  const virtual = new Set(own(VIRTUAL_INPUTS, obj.api_name) ?? []);
  for (const [key, raw] of Object.entries(input)) {
    if (virtual.has(key)) continue;
    const f = obj.byName.get(key);
    if (!f) {
      errors.push({ field: key, message: `is not a field of ${obj.api_name}` });
      continue;
    }
    if (f.read_only) {
      errors.push({ field: key, message: "is read-only" });
      continue;
    }
    if (mode === "update" && f.create_only) {
      errors.push({ field: key, message: obj.api_name === "deal" && (key === "stage" || key === "pipeline")
        ? "cannot be changed directly; use the move_deal_stage operation" : "can only be set when the record is created" });
      continue;
    }
    try {
      if (f.type === "relation" && obj.api_name === "deal" && key === "stage" && typeof raw === "string" && !decodeId(raw)) {
        p.values[key] = raw; // a stage name; resolved by the deal hook
        continue;
      }
      const value = normalizeInput(f, raw);
      if (value === null && f.required) throw new FieldValueError(key, "is required");
      p.values[key] = value;
      if (f.type === "relation") {
        const target = f.options.to!;
        const list = value === null ? [] : Array.isArray(value) ? (value as string[]) : [value as string];
        const ids: string[] = [];
        for (const v of list) ids.push(await resolveRef(tx, schema, target, v, key));
        if (f.column_name) p.columns.set(f.column_name, ids[0] ?? null);
        else p.links.set(f, ids);
      } else if (f.column_name) {
        p.columns.set(f.column_name, toStorage(f.type, value));
      } else if (f.sensitivity === "restricted") {
        p.encrypted[f.storage_key] = toStorage(f.type, value);
      } else {
        p.json[f.storage_key] = toStorage(f.type, value);
      }
    } catch (e) {
      if (e instanceof FieldValueError) errors.push({ field: e.field, message: e.message });
      else if (e instanceof ApiError) errors.push({ field: key, message: e.message });
      else throw e;
    }
  }
  if (errors.length) {
    throw unprocessable(`Invalid ${obj.api_name}: ${errors.map((e) => `${e.field} ${e.message}`).join("; ")}`, { errors });
  }
  return p;
}

async function checkUnique(tx: Tx, obj: ObjectMeta, p: Prepared, selfId: string | null): Promise<void> {
  for (const f of obj.fields) {
    if (!f.is_unique || f.column_name || !Object.hasOwn(p.json, f.storage_key) || p.json[f.storage_key] === null) continue;
    // Serialises writers of this field until commit. A preview (an import dry run) commits nothing, so it only reads.
    if (!txState()?.preview) await lockUniqueField(tx, f.id);
    const { json } = storageColumns(obj);
    const table = obj.table_name ?? "records";
    const taken = await jsonValueTaken(tx, { table, json, key: f.storage_key, value: String(p.json[f.storage_key]), selfId, objectId: obj.is_system ? null : obj.id });
    if (taken) throw conflict(`Another ${obj.api_name} already has ${f.api_name} = ${String(p.values[f.api_name])}`, { field: f.api_name });
  }
}

/** Maps Postgres errors to client errors. Messages name no tables, columns or constraints: those are internals. */
export function translateDbError(e: unknown, obj: ObjectMeta): never {
  const err = e as { code?: string; constraint_name?: string };
  if (err.code === "23505") {
    const field = err.constraint_name === "contacts_email" ? "email" : err.constraint_name === "accounts_domain" ? "domain" : undefined;
    const hint = field === "email" ? "a contact with this email already exists"
      : field === "domain" ? "an account with this domain already exists"
      : "a record with these values already exists";
    throw conflict(`Duplicate ${obj.api_name}: ${hint}`, field ? { field } : undefined);
  }
  if (err.code === "23503") throw unprocessable(`Invalid ${obj.api_name}: a referenced record does not exist`);
  if (err.code === "23514") throw unprocessable(`Invalid ${obj.api_name}: a value is outside the allowed range`);
  // Class 22 (data exception): a value Postgres cannot store, e.g. a number too large for its column.
  if (typeof err.code === "string" && err.code.startsWith("22")) throw unprocessable(`Invalid ${obj.api_name}: a value is out of range or malformed`);
  throw e;
}

/** Fields that are absent from a create but required, after defaults and hooks. */
function missingRequired(obj: ObjectMeta, prepared: Prepared): string[] {
  return obj.fields
    .filter((f) => f.required && !f.read_only)
    .filter((f) => {
      if (f.type === "relation" && !f.column_name) return (prepared.links.get(f) ?? []).length === 0;
      if (f.column_name) return prepared.columns.get(f.column_name) == null;
      return prepared.json[f.storage_key] == null && prepared.encrypted[f.storage_key] == null;
    })
    .map((f) => f.api_name);
}

function publicValues(obj: ObjectMeta, values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const f = obj.byName.get(k);
    if (f && f.sensitivity !== "restricted") out[k] = v;
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// Operations

/**
 * Every field the caller sends must be writable by them, and every record it links to must be on an
 * object they can read: otherwise a write could probe IDs they can't see.
 */
export function assertInputAllowed(ctx: Ctx, schema: Schema, obj: ObjectMeta, input: Record<string, unknown>): void {
  assertWritable(ctx, obj, Object.keys(input).filter((k) => !own(VIRTUAL_INPUTS, obj.api_name)?.includes(k)));
  for (const [k, v] of Object.entries(input)) {
    const f = obj.byName.get(k);
    const target = f?.type === "relation" && v !== null && v !== undefined ? schema.objects.get(f.options.to!) : undefined;
    if (target && !canObject(ctx, target, "read")) throw forbidden(`This key can't read ${target.api_name} records, so it can't set ${obj.api_name}.${k}`);
  }
}

export async function createRecord(tx: Tx, ctx: Ctx, objectName: string, input: Record<string, unknown>): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw unprocessable("Record values must be an object");
  assertInputAllowed(ctx, schema, obj, input);
  const id = uuidv7();
  const prepared = await prepare(tx, schema, obj, input, "create");

  for (const f of obj.fields) {
    if (f.default_value !== null && f.default_value !== undefined && !Object.hasOwn(prepared.values, f.api_name)) {
      const sub = await prepare(tx, schema, obj, { [f.api_name]: f.default_value }, "create");
      Object.assign(prepared.json, sub.json);
      Object.assign(prepared.encrypted, sub.encrypted);
      for (const [k, v] of sub.columns) prepared.columns.set(k, v);
      for (const [k, v] of sub.links) prepared.links.set(k, v);
      Object.assign(prepared.values, sub.values);
    }
  }

  const draft: Draft = { id, obj, schema, input, prepared, extra: new Map() };
  await beforeCreate(tx, ctx, draft);
  applyStatusCategories(obj, prepared, draft.extra, null);
  const missing = missingRequired(obj, prepared);
  // A required field the caller can't write, with no default, means this caller can't create these records.
  const unwritable = missing.filter((n) => fieldAccess(ctx, obj, obj.byName.get(n)!) !== "write");
  if (unwritable.length) {
    throw forbidden(`${unwritable.map((n) => `${obj.api_name}.${n}`).join(", ")} ${unwritable.length === 1 ? "is" : "are"} required and this key can't write ${unwritable.length === 1 ? "it" : "them"}; a default value would let it create ${obj.plural_label.toLowerCase()}`);
  }
  if (missing.length) throw unprocessable(`Missing required field(s) for ${obj.api_name}: ${missing.join(", ")}`, { missing });
  await checkUnique(tx, obj, prepared, null);

  const encrypted: Record<string, string> = {};
  for (const [k, v] of Object.entries(prepared.encrypted)) {
    if (v !== null) encrypted[k] = await encryptValue(tx, ctx.tenantId, id, k, v);
  }
  const search = searchText(obj, prepared.values);
  const { json, enc } = storageColumns(obj);
  const cols = new Map<string, unknown>([...prepared.columns, ...draft.extra]);
  cols.set(json, prepared.json);
  cols.set(enc, encrypted);
  cols.set("search_text", search);
  cols.set("created_by", ctx.actor.id);
  cols.set("updated_by", ctx.actor.id);

  try {
    if (!obj.is_system) {
      await registerRecord(tx, ctx.tenantId, id, obj.id);
      cols.set("object_id", obj.id);
      if (obj.owned && !cols.has("owner_id")) cols.set("owner_id", actorUserId(ctx));
    }
    const names = ["tenant_id", "id", ...cols.keys()];
    const params = [ctx.tenantId, id, ...cols.values()];
    const placeholders = names.map((n, i) => `$${i + 1}${n === json || n === enc ? "::jsonb" : n === "domains" ? "::text[]" : ""}`);
    await insertRecordRow(tx, obj.table_name ?? "records", names, placeholders, params);
    for (const [f, ids] of prepared.links) {
      for (const to of ids) {
        await insertRecordLink(tx, { tenantId: ctx.tenantId, fieldId: f.id, fromId: id, toId: to, createdBy: ctx.actor.id });
      }
    }
  } catch (e) {
    translateDbError(e, obj);
  }

  await afterCreate(tx, ctx, draft);
  await audit(tx, ctx, { action: `${obj.api_name}.created`, objectType: obj.api_name, recordId: id, details: { fields: Object.keys(prepared.values) } });
  await emit(tx, ctx, { type: `${obj.api_name}.created`, objectType: obj.api_name, recordId: id, data: { after: publicValues(obj, prepared.values) } });
  const [row] = await fetchRows(tx, obj, [id]);
  return (await serialize(tx, ctx, schema, obj, [row!]))[0]!;
}

function applyStatusCategories(obj: ObjectMeta, p: Prepared, extra: Map<string, unknown>, current: Row | null): void {
  for (const f of obj.fields) {
    if (f.type !== "status") continue;
    const key = `${obj.api_name}.${f.api_name}`;
    const catColumn = own(STATUS_CATEGORY_COLUMNS, key);
    let value = f.column_name ? (p.columns.get(f.column_name) as string | undefined) : (p.json[f.storage_key] as string | undefined);
    if (value === undefined && current === null && f.options.initial) {
      value = f.options.initial;
      if (f.column_name) p.columns.set(f.column_name, value);
      else p.json[f.storage_key] = value;
    }
    if (value === undefined || value === null) continue;
    const def = f.options.values?.find((v) => v.key === value);
    const category = def?.category ?? value;
    if (f.options.operation_only_categories?.includes(category)) {
      throw forbidden(`${obj.api_name}.${f.api_name} cannot be set to "${value}" directly; use the named operation (leads: convert_lead; quotes: send_quote, accept_quote, revise_quote)`);
    }
    if (current) {
      const stored = (current[storageColumns(obj).json] ?? {}) as Record<string, unknown>;
      const prevValue = (f.column_name ? current[f.column_name] : stored[f.storage_key]) as string | undefined;
      const prevCategory = catColumn
        ? (current[catColumn] as string)
        : f.options.values?.find((v) => v.key === prevValue)?.category ?? prevValue ?? "";
      if (prevValue !== undefined && prevValue !== value) {
        const machine = own(STATUS_MACHINES, key);
        if (machine) {
          const allowed = own(machine, prevCategory) ?? [];
          if (prevCategory !== category && !allowed.includes(category)) {
            throw unprocessable(`${obj.api_name}.${f.api_name} cannot move from "${prevValue}" to "${value}"`, { allowed_categories: allowed });
          }
        } else if (f.options.transitions) {
          const allowed = own(f.options.transitions, prevValue) ?? [];
          if (!allowed.includes(value)) {
            throw unprocessable(`${obj.api_name}.${f.api_name} cannot move from "${prevValue}" to "${value}"`, { allowed });
          }
        }
      }
    }
    if (catColumn) extra.set(catColumn, category);
  }
}

export async function getRecord(tx: Tx, ctx: Ctx, objectName: string, publicId: string, opts: SerializeOpts = {}): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  assertObject(ctx, obj, "read");
  const [row] = await fetchRows(tx, obj, [parseRecordId(obj, publicId)]);
  if (!row) throw notFound(`${obj.label} ${publicId}`);
  return (await serialize(tx, ctx, schema, obj, [row], opts))[0]!;
}

/** Finds any record by its public ID; the prefix says which object it is. */
export async function getAnyRecord(tx: Tx, ctx: Ctx, publicId: string, opts: SerializeOpts = {}): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const d = decodeId(publicId);
  const obj = d ? schema.byPrefix.get(d.prefix) : undefined;
  if (!obj) throw notFound(`Record ${publicId}`);
  return getRecord(tx, ctx, obj.api_name, publicId, opts);
}

export async function updateRecord(
  tx: Tx, ctx: Ctx, objectName: string, publicId: string, input: Record<string, unknown>, expectedVersion?: number,
): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  if (typeof input === "object" && input !== null && !Array.isArray(input)) assertInputAllowed(ctx, schema, obj, input);
  else assertObject(ctx, obj, "write");
  const id = parseRecordId(obj, publicId);
  const [current] = await fetchRows(tx, obj, [id], true);
  if (!current) throw notFound(`${obj.label} ${publicId}`);
  if (current.archived_at) throw conflict(`${obj.label} ${publicId} is archived`);
  if (expectedVersion !== undefined && Number(current.version) !== expectedVersion) {
    throw new ApiError(412, "version_mismatch", `${obj.label} ${publicId} has changed (now version ${current.version}); re-read it and retry`);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw unprocessable("Record values must be an object");
  const prepared = await prepare(tx, schema, obj, input, "update");
  const draft: Draft = { id, obj, schema, input, prepared, extra: new Map(), current };
  await beforeUpdate(tx, ctx, draft);
  applyStatusCategories(obj, prepared, draft.extra, current);
  await checkUnique(tx, obj, prepared, id);

  const { json, enc } = storageColumns(obj);
  const mergedJson = { ...((current[json] ?? {}) as object), ...prepared.json };
  const mergedEnc: Record<string, unknown> = { ...((current[enc] ?? {}) as object) };
  for (const [k, v] of Object.entries(prepared.encrypted)) {
    if (v === null) delete mergedEnc[k];
    else mergedEnc[k] = await encryptValue(tx, ctx.tenantId, id, k, v);
  }
  // Search text and the event's before-values need the full record, whatever the caller may see.
  const before = (await serialize(tx, internalReader(ctx), schema, obj, [current], { includeHidden: true }))[0]!;
  const merged = { ...before, ...prepared.values };

  const cols = new Map<string, unknown>([...prepared.columns, ...draft.extra]);
  cols.set(json, mergedJson);
  cols.set(enc, mergedEnc);
  cols.set("search_text", searchText(obj, merged));
  cols.set("updated_by", ctx.actor.id);
  const names = [...cols.keys()];
  const sets = names.map((n, i) => `${quoteIdent(n)} = $${i + 1}${n === json || n === enc ? "::jsonb" : n === "domains" ? "::text[]" : ""}`);
  try {
    await updateRecordRow(tx, obj.table_name ?? "records", sets, [...cols.values(), id]);
    for (const [f, ids] of prepared.links) {
      await clearRecordLinks(tx, f.id, id);
      for (const to of ids) {
        await insertRecordLink(tx, { tenantId: ctx.tenantId, fieldId: f.id, fromId: id, toId: to, createdBy: ctx.actor.id });
      }
    }
  } catch (e) {
    translateDbError(e, obj);
  }
  await afterUpdate(tx, ctx, draft);
  const changed = Object.keys(prepared.values);
  await audit(tx, ctx, { action: `${obj.api_name}.updated`, objectType: obj.api_name, recordId: id, details: { fields: changed } });
  const beforePublic = publicValues(obj, Object.fromEntries(changed.map((k) => [k, before[k]])));
  await emit(tx, ctx, { type: `${obj.api_name}.updated`, objectType: obj.api_name, recordId: id, data: { before: beforePublic, after: publicValues(obj, prepared.values) } });
  return getRecord(tx, ctx, obj.api_name, publicId);
}

export async function archiveRecord(tx: Tx, ctx: Ctx, objectName: string, publicId: string): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  assertObject(ctx, obj, "archive");
  const id = parseRecordId(obj, publicId);
  const [current] = await fetchRows(tx, obj, [id], true);
  if (!current) throw notFound(`${obj.label} ${publicId}`);
  if (!current.archived_at) {
    await beforeArchive(tx, ctx, schema, obj, current);
    await archiveRecordRow(tx, obj.table_name ?? "records", id, ctx.actor.id);
    await afterArchive(tx, ctx, obj, current);
    await audit(tx, ctx, { action: `${obj.api_name}.archived`, objectType: obj.api_name, recordId: id });
    await emit(tx, ctx, { type: `${obj.api_name}.archived`, objectType: obj.api_name, recordId: id });
  }
  return getRecord(tx, ctx, obj.api_name, publicId);
}

/** Fields whose values must be unique among records that are not archived: unique custom fields, and the two the database keeps unique. */
export function uniqueFields(obj: ObjectMeta): FieldMeta[] {
  return obj.fields.filter((f) => f.is_unique || (obj.api_name === "contact" && f.api_name === "email") || (obj.api_name === "account" && f.api_name === "domain"));
}

export interface RestoreWarning { field: string; message: string }

/**
 * Un-archives a record, undoing what archiving did: it is listed, searched and writable again, and
 * alert deadlines follow from its `restored` event. Archiving freed its unique values, so they are
 * checked again (another record may hold one now); the search text is rebuilt with today's rules;
 * relations to records archived meanwhile are kept, and named in `warnings` where the caller can read
 * them. A merged record is refused: its references now belong to the survivor (core/merge.ts).
 */
export async function restoreRecord(tx: Tx, ctx: Ctx, objectName: string, publicId: string): Promise<{ data: RecordOut; warnings: RestoreWarning[] }> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  assertObject(ctx, obj, "archive");
  const id = parseRecordId(obj, publicId);
  const [current] = await fetchRows(tx, obj, [id], true);
  if (!current) throw notFound(`${obj.label} ${publicId}`);
  if (!current.archived_at) throw conflict(`${obj.label} ${publicId} is not archived`);
  if (current.anonymized_at) throw conflict(`${obj.label} ${publicId} was erased, so there is nothing to restore`);
  const chain = (await mergeChains(tx, [id])).get(id);
  if (chain) {
    const into = encodeId(obj.id_prefix, chain[chain.length - 1]!);
    throw conflict(`${obj.label} ${publicId} was merged into ${into}, which now holds its references, so it can't be restored`, { merged_into: into });
  }
  const table = obj.table_name ?? "records";
  const { json } = storageColumns(obj);
  for (const f of uniqueFields(obj)) {
    const raw = f.column_name ? current[f.column_name] : ((current[json] ?? {}) as Record<string, unknown>)[f.storage_key];
    if (raw === null || raw === undefined || f.sensitivity === "restricted") continue;
    if (!txState()?.preview) await lockUniqueField(tx, f.id);
    const taken = await valueHeldElsewhere(tx, heldElsewhereSql(table, f.column_name ?? json, !f.column_name, !obj.is_system),
      [f.column_name ? raw : String(raw), id, ...(f.column_name ? [] : [f.storage_key]), ...(obj.is_system ? [] : [obj.id])]);
    if (taken) {
      // The value is never quoted. Naming a field the caller can't read would still say a value matches, so it isn't named.
      const named = fieldAccess(ctx, obj, f) !== "none" ? `${obj.api_name}.${f.api_name}` : "a unique field this key can't read";
      throw conflict(`${obj.label} ${publicId} can't be restored: another ${obj.api_name} that is not archived has the same value in ${named}. Change one of them first`,
        fieldAccess(ctx, obj, f) !== "none" ? { field: f.api_name } : undefined);
    }
  }
  const full = (await serialize(tx, internalReader(ctx), schema, obj, [current], { includeHidden: true }))[0]!;
  await beforeArchive(tx, ctx, schema, obj, current);
  try {
    await restoreRecordRow(tx, table, id, ctx.actor.id, searchText(obj, full));
  } catch (e) {
    translateDbError(e, obj);
  }
  await afterArchive(tx, ctx, obj, current);
  const warnings = await archivedTargets(tx, ctx, schema, obj, full);
  await audit(tx, ctx, { action: `${obj.api_name}.restored`, objectType: obj.api_name, recordId: id });
  await emit(tx, ctx, { type: `${obj.api_name}.restored`, objectType: obj.api_name, recordId: id });
  return { data: await getRecord(tx, ctx, obj.api_name, publicId), warnings };
}

/**
 * "Does another live record hold this value?", built from identifiers only (quoteIdent) and fixed
 * placeholders: $1 the value, $2 the record, then the JSON key (for a value kept in JSON) and the object (custom objects).
 */
function heldElsewhereSql(table: string, column: string, inJson: boolean, custom: boolean): string {
  const expr = inJson ? `${quoteIdent(column)}->>$3` : quoteIdent(column);
  const ofObject = custom ? (inJson ? " AND object_id = $4" : " AND object_id = $3") : "";
  return `SELECT 1 FROM ${quoteIdent(table)} WHERE ${expr} = $1 AND archived_at IS NULL AND id <> $2::uuid${ofObject} LIMIT 1`;
}

/** Relations of `rec` that point at archived records, for fields and target objects the caller can read. One query per target object. */
async function archivedTargets(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, rec: RecordOut): Promise<RestoreWarning[]> {
  const byTarget = new Map<ObjectMeta, { field: string; uuid: string }[]>();
  for (const f of obj.fields) {
    const target = f.type === "relation" ? schema.objects.get(f.options.to!) : undefined;
    if (!target || fieldAccess(ctx, obj, f) === "none" || !canObject(ctx, target, "read")) continue;
    const v = rec[f.api_name];
    for (const pid of Array.isArray(v) ? v : v ? [v] : []) {
      const d = decodeId(String(pid));
      if (d) byTarget.set(target, [...(byTarget.get(target) ?? []), { field: f.api_name, uuid: d.uuid }]);
    }
  }
  const out: RestoreWarning[] = [];
  for (const [target, refs] of byTarget) {
    const gone = new Set((await fetchRows(tx, target, refs.map((r) => r.uuid))).filter((r) => r.archived_at).map((r) => r.id));
    for (const r of refs) if (gone.has(r.uuid)) out.push({ field: r.field, message: `points to an archived ${target.api_name} (${encodeId(target.id_prefix, r.uuid)})` });
  }
  return out;
}

export interface Page { data: RecordOut[]; next_cursor: string | null; total?: number; total_capped?: boolean }

export async function queryRecords(tx: Tx, ctx: Ctx, q: QueryInput, opts: SerializeOpts = {}): Promise<Page> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, q.object);
  assertObject(ctx, obj, "read");
  const compiled = compileQuery(schema, q, accessGuard(ctx, schema));
  let rows: Row[];
  let count: number | undefined;
  try {
    rows = await compiledRows(tx, compiled.text, compiled.params);
    // Same filter and access as the page, without the cursor; capped, so never an unbounded count(*).
    if (q.count) count = await compiledCount(tx, compiled.countText, compiled.countParams);
  } catch (e) {
    // The compiler checks values, so this is a backstop: a value Postgres cannot cast is the caller's error.
    if (typeof (e as { code?: string }).code === "string" && (e as { code: string }).code.startsWith("22")) {
      throw unprocessable("A filter or cursor value is not valid for its field");
    }
    throw e;
  }
  const page = rows.slice(0, compiled.limit);
  const next = rows.length > compiled.limit ? encodeCursor(page[page.length - 1]!, compiled) : null;
  const counted = count === undefined ? {} : { total: Math.min(count, COUNT_CAP), total_capped: count > COUNT_CAP };
  return { data: await serialize(tx, ctx, schema, obj, page, opts), next_cursor: next, ...counted };
}

/** Throws unless the object's module is on and the record exists. Used by operations. */
export async function requireRecord(tx: Tx, schema: Schema, objectName: string, publicId: string, field = "id"): Promise<string> {
  getObject(schema, objectName);
  return resolveRef(tx, schema, objectName, publicId, field);
}
