import type { Tx } from "../db/pool.js";
import { CsvError, csvRow, guardFormula, parseCsv, unguardFormula } from "../lib/csv.js";
import { asPreview } from "../db/tx.js";
import { ApiError, deadline, forbidden, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { assertObject, canObject, canReadField, fieldAccess } from "./access.js";
import { audit } from "./audit.js";
import { isEntity } from "./catalog.js";
import { can, type Ctx } from "./context.js";
import { ADDRESS_PART_NAMES, FieldValueError, isAddressPart, normalizeInput, sameStored, TYPE_INFO } from "./fieldtypes.js";
import type { Where } from "./query.js";
import { createRecord, getRecord, queryRecords, updateRecord, type RecordOut } from "./records.js";
import { getObject, loadSchema, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";
import { activeUsersByEmail } from "./queries/directory.js";
import { normalizeDomain } from "./standard.js";

/**
 * Bulk export and import of one object's records as CSV (or NDJSON for export).
 *
 * Export pages through the same query and serializer as the list route, so filters, permissions,
 * object and field access (ADR 0008) and restricted-field redaction are identical. One response
 * holds at most EXPORT_ROW_CAP rows; X-Next-Cursor continues it. Import checks the caller's object
 * and field access for every mapped column before it reads anything, runs each row through
 * createRecord/updateRecord, so every field rule applies, and is all or nothing per request.
 */

export const EXPORT_ROW_CAP = 5_000;
export const IMPORT_ROW_CAP = 500;
const PAGE = 200;

/** Fields that are not stored values but appear in exports. */
const META_COLUMNS = ["created_at", "updated_at", "version"];
const VIRTUAL: Record<string, string> = { activity: "related_to", task: "related_to" };

/** The value an export without restricted:read holds in a restricted field (records.ts serializes it so). */
const REDACTED = "[restricted]";

/**
 * The caller's columns. A field the caller can't read has no column: its name is metadata (describe
 * lists it), but an empty column would read as "no value" in the file and on a re-import.
 */
export function exportColumns(ctx: Ctx, obj: ObjectMeta, opts: { includeHidden?: boolean; includeArchived?: boolean }): string[] {
  return [
    "id", ...obj.fields.filter((f) => (opts.includeHidden || !f.hidden) && fieldAccess(ctx, obj, f) !== "none")
      // An address is one column per part (hq.line1 … hq.country), which import reads back the same way.
      .flatMap((f) => (TYPE_INFO[f.type].csv === "parts" ? ADDRESS_PART_NAMES.map((p) => `${f.api_name}.${p}`) : [f.api_name])),
    ...(Object.hasOwn(VIRTUAL, obj.api_name) ? [VIRTUAL[obj.api_name]!] : []),
    ...META_COLUMNS, ...(opts.includeArchived ? ["archived_at"] : []),
  ];
}

/** A column's value: a field's, or a part of an address (field.part). A redacted restricted address stays "[restricted]" in each part. */
function columnValue(r: RecordOut, column: string): unknown {
  if (Object.hasOwn(r, column)) return r[column];
  const [field, part] = column.split(".");
  const v = field ? r[field] : undefined;
  if (v === REDACTED) return REDACTED;
  return v && typeof v === "object" && part ? (v as Record<string, unknown>)[part] : undefined;
}

/** Lists join with ";" (option keys and record IDs cannot contain one). JSON values are one cell of JSON text. Text cells get the formula guard. */
function cell(v: unknown, json = false): string {
  if (v === null || v === undefined) return "";
  // "[restricted]" stays as it is, so a re-import leaves the value alone.
  if (json) return v === REDACTED ? v : guardFormula(JSON.stringify(v));
  if (Array.isArray(v)) return guardFormula(v.map(String).join(";"));
  if (typeof v === "string") return guardFormula(v);
  if (typeof v === "object") return guardFormula(JSON.stringify(v));
  return String(v);
}

export interface ExportInput {
  object: string;
  where?: Where;
  sort?: { field: string; dir?: "asc" | "desc" }[];
  cursor?: string;
  includeArchived?: boolean;
  includeHidden?: boolean;
  format: "csv" | "ndjson";
  limit?: number;
}

export async function exportRecords(tx: Tx, ctx: Ctx, input: ExportInput): Promise<{ body: string; rows: number; nextCursor: string | null }> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, input.object);
  assertObject(ctx, obj, "read");
  const cap = Math.min(Math.max(1, input.limit ?? EXPORT_ROW_CAP), EXPORT_ROW_CAP);
  const columns = exportColumns(ctx, obj, input);
  const jsonColumns = new Set(obj.fields.filter((f) => TYPE_INFO[f.type].csv === "json").map((f) => f.api_name));
  const parts: string[] = input.format === "csv" ? [csvRow(columns)] : [];
  let cursor = input.cursor;
  let rows = 0;
  let next: string | null;
  for (;;) {
    const page = await queryRecords(tx, ctx, {
      object: obj.api_name, where: input.where, sort: input.sort, cursor, include_archived: input.includeArchived, limit: Math.min(PAGE, cap - rows),
    }, { includeHidden: input.includeHidden });
    for (const r of page.data) {
      parts.push(input.format === "csv" ? csvRow(columns.map((c) => cell(columnValue(r, c), jsonColumns.has(c)))) : `${JSON.stringify(r)}\n`);
    }
    rows += page.data.length;
    next = page.next_cursor;
    if (!next || rows >= cap) break;
    cursor = next;
  }
  await audit(tx, ctx, { action: `${obj.api_name}.exported`, objectType: obj.api_name,
    details: { rows, format: input.format, filtered: input.where !== undefined, continued: input.cursor !== undefined } });
  return { body: parts.join(""), rows, nextCursor: next };
}

// ---------------------------------------------------------------------------------------------
// Import

export interface ImportInput {
  csv: string;
  /** CSV column → field, or field.lookup for relations (e.g. account.domain). "" ignores a column. */
  mapping?: Record<string, string>;
  /** Upsert key: "id" or a unique field. Without one every row is created (unless the file has an id column). */
  key?: string;
  dry_run?: boolean;
  /** Strip the apostrophe export adds before = + - @ (default true). */
  unescape_formulas?: boolean;
}

export interface RowOutcome {
  row: number;
  line: number;
  action: "create" | "update" | "skip" | "error";
  id?: string;
  reason?: string;
  errors?: unknown;
}

/** `part`: one part of an address field (column field.part); the row's parts are combined into one value. */
interface Column { index: number; header: string; field: FieldMeta | null; target: string; lookup: string | null; part?: string }

/** Fields a relation can be looked up by: the target's ID or a field whose values are unique. */
function lookupAllowed(target: ObjectMeta | "user", lookup: string): boolean {
  if (lookup === "id") return true;
  if (target === "user") return lookup === "email";
  return isUniqueKey(target, lookup);
}

/** Unique custom fields, plus the standard fields the database keeps unique. */
export function isUniqueKey(obj: ObjectMeta, name: string): boolean {
  const f = obj.byName.get(name);
  return Boolean(f && (f.is_unique || (obj.api_name === "contact" && name === "email") || (obj.api_name === "account" && name === "domain")));
}

/** A key value as the database compares it: normalised by its field (emails, and account domains as domains). */
export function keyValue(obj: ObjectMeta, f: FieldMeta, raw: unknown): unknown {
  const v = normalizeInput(f, raw);
  return obj.api_name === "account" && f.api_name === "domain" && typeof v === "string" ? normalizeDomain(v) : v;
}

function planColumns(schema: Schema, obj: ObjectMeta, header: string[], mapping: Record<string, string>): { columns: Column[]; ignored: { column: string; reason: string }[] } {
  const columns: Column[] = [];
  const ignored: { column: string; reason: string }[] = [];
  const names = header.map((h) => h.trim());
  for (const k of Object.keys(mapping)) if (!names.includes(k)) throw unprocessable(`mapping names column "${k}", which is not in the file's header`);
  const virtual = Object.hasOwn(VIRTUAL, obj.api_name) ? VIRTUAL[obj.api_name] : undefined;
  const seen = new Set<string>();
  for (const [index, header_] of names.entries()) {
    const explicit = Object.hasOwn(mapping, header_);
    const spec = explicit ? mapping[header_]! : header_;
    if (spec === "") {
      ignored.push({ column: header_, reason: "mapped to nothing" });
      continue;
    }
    const [target, lookup, extra] = spec.split(".");
    const field = target ? obj.byName.get(target) ?? null : null;
    const known = target === "id" || target === virtual || field;
    if (!known || extra !== undefined || (lookup !== undefined && target === "id")) {
      if (explicit) throw unprocessable(`Column "${header_}" is mapped to "${spec}", which is not a field of ${obj.api_name}`);
      ignored.push({ column: header_, reason: META_COLUMNS.includes(header_) || header_ === "archived_at" || header_ === "display_name" ? "set by the system" : "not a field" });
      continue;
    }
    if (field?.read_only) {
      if (explicit) throw unprocessable(`Column "${header_}" is mapped to "${target}", which is read-only`);
      ignored.push({ column: header_, reason: "read-only field" });
      continue;
    }
    if (field?.type === "address") {
      if (lookup === undefined || !isAddressPart(lookup)) {
        throw unprocessable(`Column "${header_}": an address is imported one part per column: ${ADDRESS_PART_NAMES.map((p) => `${target}.${p}`).join(", ")}`);
      }
      if (seen.has(spec)) throw unprocessable(`Two columns are mapped to "${spec}"`);
      seen.add(spec);
      columns.push({ index, header: header_, field, target: target!, lookup: null, part: lookup });
      continue;
    }
    if (lookup !== undefined) {
      if (field?.type !== "relation") throw unprocessable(`Column "${header_}": "${target}" is not a relation, so it cannot be looked up by ${lookup}`);
      const to = field.options.to!;
      const targetObj = to === "user" ? "user" : isEntity(to) ? null : getObject(schema, to);
      if (!targetObj || !lookupAllowed(targetObj, lookup)) {
        throw unprocessable(`Column "${header_}": ${to} records can be looked up by id${to === "user" ? " or email" : " or a unique field"}, not "${lookup}"`);
      }
    }
    if (seen.has(target!)) throw unprocessable(`Two columns are mapped to "${target}"`);
    seen.add(target!);
    columns.push({ index, header: header_, field, target: target!, lookup: lookup ?? null });
  }
  return { columns, ignored };
}

/**
 * Refuses, before anything is read, what the caller may not do (ADR 0008), naming every column at
 * once: write the object or a mapped field, match rows on a key it can't read, or set a relation to
 * (or look one up in) an object or by a field it can't read. Which rows match would reveal values.
 * Member lookups by email (owner.email) follow assign_owner: writing the field is enough.
 */
function assertImportAllowed(ctx: Ctx, schema: Schema, obj: ObjectMeta, columns: Column[], key: string | undefined): void {
  assertObject(ctx, obj, "write");
  if (key) assertObject(ctx, obj, "read");
  if (key && key !== "id" && !canReadField(ctx, obj, key)) throw forbidden(`This key can't read ${obj.api_name}.${key}, so it can't be the upsert key`);
  // The key column only has to be readable: with a key the caller can't write, rows can update the records they match, not create.
  const unwritable = columns.filter((c) => c.field && c.target !== key && fieldAccess(ctx, obj, c.field) !== "write");
  if (unwritable.length) {
    const one = unwritable.length === 1;
    throw forbidden(`This key can't write ${unwritable.map((c) => `${obj.api_name}.${c.target} (column "${c.header}")`).join(", ")}; `
      + `map ${one ? "that column" : "those columns"} to "" to leave ${one ? "it" : "them"} out`);
  }
  for (const c of columns) {
    const target = c.field?.type === "relation" ? schema.objects.get(c.field.options.to!) : undefined;
    if (!target) continue;
    if (!canObject(ctx, target, "read")) throw forbidden(`This key can't read ${target.api_name} records, so column "${c.header}" can't set ${obj.api_name}.${c.target}`);
    if (c.lookup && c.lookup !== "id" && !canReadField(ctx, target, c.lookup)) {
      throw forbidden(`This key can't read ${target.api_name}.${c.lookup}, so column "${c.header}" can't look ${target.api_name} records up by it`);
    }
  }
}

class Rollback extends Error {}

export async function importRecords(tx: Tx, ctx: Ctx, objectName: string, input: ImportInput) {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const dryRun = input.dry_run ?? true;
  let parsed;
  try {
    parsed = parseCsv(input.csv, { maxRows: IMPORT_ROW_CAP + 1 });
  } catch (e) {
    if (e instanceof CsvError) throw unprocessable(e.message.includes("more than") ? `A request can import at most ${IMPORT_ROW_CAP} rows; split the file` : e.message);
    throw e;
  }
  const [header, ...data] = parsed.rows;
  if (!header) throw unprocessable("The CSV is empty; the first row must name the columns");
  const { columns, ignored } = planColumns(schema, obj, header, input.mapping ?? {});
  if (columns.length === 0) throw unprocessable(`No column maps to a field of ${obj.api_name}`);
  const key = input.key ?? (columns.some((c) => c.target === "id") ? "id" : undefined);
  const keyColumn = key ? columns.find((c) => c.target === key && !c.lookup) : undefined;
  if (key && !keyColumn) throw unprocessable(`The upsert key "${key}" must be mapped from a column`);
  if (key && key !== "id" && !isUniqueKey(obj, key)) throw unprocessable(`The upsert key must be id or a unique field of ${obj.api_name}; "${key}" is not unique`);
  assertImportAllowed(ctx, schema, obj, columns, key);

  const lookups = new Map<string, string>();
  const outcomes: RowOutcome[] = [];
  const check = deadline(WORK_BUDGET_MS.import, "The import");
  const work = async (t: Tx) => {
    for (const [i, row] of data.entries()) {
      check(); // outside the row's try: running out of time fails the request, not the row
      const out: RowOutcome = { row: i + 1, line: parsed.lines[i + 1]!, action: "error" };
      try {
        if (row.length !== header.length) throw unprocessable(`has ${row.length} field(s); the header has ${header.length}`);
        await t.savepoint(async (sp) => Object.assign(out, await importRow(sp as unknown as Tx, ctx, schema, obj, columns, row, keyColumn, input, lookups)));
      } catch (e) {
        if (!(e instanceof ApiError || e instanceof FieldValueError)) throw e;
        out.action = "error";
        out.reason = e instanceof FieldValueError ? `${e.field} ${e.message}` : e.message;
        if (e instanceof ApiError && e.details !== undefined) out.errors = (e.details as { errors?: unknown }).errors ?? e.details;
      }
      outcomes.push(out);
    }
  };
  if (dryRun) {
    try {
      // A preview: it takes no unique-value locks (records.ts), which would be held until the request ends and block real writes meanwhile.
      await asPreview(() => tx.savepoint(async (sp) => {
        await work(sp as unknown as Tx);
        throw new Rollback();
      }));
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  } else {
    await work(tx);
  }
  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  for (const o of outcomes) counts[o.action]++;
  const failed = outcomes.filter((o) => o.action === "error");
  if (!dryRun && failed.length) {
    throw new ApiError(422, "import_failed", `${failed.length} of ${outcomes.length} row(s) failed, so nothing was imported`, failed);
  }
  if (!dryRun) {
    await audit(tx, ctx, { action: `${obj.api_name}.imported`, objectType: obj.api_name,
      details: { rows: outcomes.length, created: counts.create, updated: counts.update, skipped: counts.skip, key: key ?? null } });
  }
  return { dry_run: dryRun, object: obj.api_name, key: key ?? null, counts, rows: outcomes, ignored_columns: ignored };
}

async function importRow(
  tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, columns: Column[], row: string[], keyColumn: Column | undefined, input: ImportInput, lookups: Map<string, string>,
): Promise<Partial<RowOutcome>> {
  const values: Record<string, unknown> = {};
  /** Address part columns by field, cells as given (empty ones too): merged into the stored address below. */
  const parts = new Map<string, Record<string, string>>();
  let id: string | undefined;
  for (const c of columns) {
    let raw = (row[c.index] ?? "").trim();
    if (input.unescape_formulas !== false) raw = unguardFormula(raw);
    if (c.part) {
      if (raw === REDACTED && c.field?.sensitivity === "restricted") continue;
      parts.set(c.target, { ...parts.get(c.target), [c.part]: raw });
      continue;
    }
    // Empty cells leave a field as it is (and unset on create), and so does the placeholder an export
    // without restricted:read holds in a restricted field: it stands for a value, it isn't one.
    if (raw === "" || (raw === REDACTED && c.field?.sensitivity === "restricted")) continue;
    if (c.target === "id") {
      id = raw;
      continue;
    }
    values[c.target] = await coerce(tx, ctx, schema, c, raw, lookups);
  }
  // An address with every part cell empty is left as it is, as any empty cell is; otherwise its cells are applied below.
  for (const [k, given] of parts) if (Object.values(given).every((v) => v === "")) parts.delete(k);
  for (const [k, given] of parts) values[k] = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== ""));
  if (Object.keys(values).length === 0 && !id) return { action: "skip", reason: "empty row" };
  return upsertByKey(tx, ctx, obj, keyColumn?.target, values, id, parts);
}

/**
 * Creates or updates one record matched by an upsert key (id, or a unique field normalised as the
 * database compares it), the way an import row is: a match with nothing to change is skipped. Used by
 * import and by the automation upsert_record step, so both follow the same rules. `parts`: an import's
 * address part cells by field (empty cells too), merged into the stored address on an update; an
 * address in `values` without them (an automation step) replaces the stored one whole.
 */
export async function upsertByKey(tx: Tx, ctx: Ctx, obj: ObjectMeta, key: string | undefined, values: Record<string, unknown>, id?: string,
  parts: Map<string, Record<string, string>> = new Map()):
  Promise<Partial<RowOutcome> & { action: RowOutcome["action"] }> {
  let current: RecordOut | undefined;
  const keyField = key && key !== "id" ? obj.byName.get(key) : undefined;
  if (key === "id" && id) {
    current = await getRecord(tx, ctx, obj.api_name, id, { includeHidden: true });
  } else if (keyField && values[key!] !== undefined) {
    const value = keyValue(obj, keyField, values[key!]);
    const found = await queryRecords(tx, ctx, { object: obj.api_name, where: { field: key!, op: "eq", value }, limit: 2 }, { includeHidden: true });
    if (found.data.length > 1) return { action: "error", reason: `more than one ${obj.api_name} has ${key} = ${String(value)}` };
    current = found.data[0];
  }
  if (!current) {
    const created = await createRecord(tx, ctx, obj.api_name, values);
    return { action: "create", id: created.id };
  }
  // Every mapped field is one the caller can read (assertImportAllowed), so `current` holds it, except
  // a restricted value it can't read: comparing with that would tell it whether the value matches, so
  // such a cell always counts as a change.
  const redacted = !can(ctx, "restricted:read");
  // An update merges the address parts the file has columns for into the stored address: a part cell with a
  // value sets that part, an empty one clears it, and a part without a column keeps its stored value.
  for (const [k, given] of parts) {
    const f = obj.byName.get(k)!;
    const stored = current[k];
    if (f.sensitivity === "restricted" && redacted && ADDRESS_PART_NAMES.some((p) => !Object.hasOwn(given, p))) {
      return { action: "error", reason: `${k} is restricted, so its stored parts can't be read to merge into; give a column for every part (${ADDRESS_PART_NAMES.map((p) => `${k}.${p}`).join(", ")})` };
    }
    const base = (f.sensitivity === "restricted" && redacted) || !stored || typeof stored !== "object" ? null : stored as Record<string, unknown>;
    const merged: Record<string, unknown> = {};
    for (const p of ADDRESS_PART_NAMES) {
      const v = Object.hasOwn(given, p) ? given[p] : base?.[p];
      if (typeof v === "string" && v !== "") merged[p] = v;
    }
    values[k] = Object.keys(merged).length ? merged : null;
  }
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const f = obj.byName.get(k);
    if (f?.sensitivity === "restricted" && redacted) {
      changed[k] = v;
      continue;
    }
    if (f ? !sameStored(f, v, current[k]) : JSON.stringify(v) !== JSON.stringify(current[k] ?? null)) changed[k] = v;
  }
  if (Object.keys(changed).length === 0) return { action: "skip", id: current.id, reason: "no changes" };
  const updated = await updateRecord(tx, ctx, obj.api_name, current.id, changed);
  return { action: "update", id: updated.id };
}

async function coerce(tx: Tx, ctx: Ctx, schema: Schema, c: Column, raw: string, lookups: Map<string, string>): Promise<unknown> {
  const list = (s: string) => s.split(";").map((x) => x.trim()).filter(Boolean);
  if (!c.field) return list(raw); // related_to
  const f = c.field;
  switch (f.type) {
    case "boolean":
      if (/^(true|yes|y|1)$/i.test(raw)) return true;
      if (/^(false|no|n|0)$/i.test(raw)) return false;
      throw new FieldValueError(f.api_name, "must be true or false (or yes/no, 1/0)");
    case "multi_select":
      return list(raw);
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new FieldValueError(f.api_name, "must be JSON text (as export writes it), e.g. {\"a\": 1}");
      }
    case "relation": {
      const many = f.options.cardinality === "many_to_many";
      const ids: string[] = [];
      for (const v of many ? list(raw) : [raw]) ids.push(c.lookup && c.lookup !== "id" ? await lookup(tx, ctx, schema, f, c.lookup, v, lookups) : v);
      return many ? ids : ids[0];
    }
    default:
      return raw;
  }
}

/**
 * Resolves a relation cell by a unique field of the target (or a member's email). Cached per request,
 * keyed by the value as the lookup compares it: normalised by the field (emails and domains ignore
 * case), exact otherwise, so "abc" and "ABC" in a case-sensitive unique field are two records.
 */
async function lookup(tx: Tx, ctx: Ctx, schema: Schema, f: FieldMeta, by: string, value: string, cache: Map<string, string>): Promise<string> {
  const to = f.options.to!;
  let ids: string[];
  let cacheKey: string;
  if (to === "user") {
    cacheKey = `user|email|${value.toLowerCase()}`; // users.email is citext
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const rows = await activeUsersByEmail(tx, value);
    ids = rows.map((r) => encodeId("usr", r.id));
  } else {
    const target = getObject(schema, to);
    const tf = target.byName.get(by)!;
    let normal: unknown;
    try {
      normal = keyValue(target, tf, value);
    } catch (e) {
      if (e instanceof FieldValueError) throw new FieldValueError(f.api_name, `lookup value ${e.message}`);
      throw e;
    }
    cacheKey = `${to}|${by}|${JSON.stringify(normal)}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    const found = await queryRecords(tx, ctx, { object: to, where: { field: by, op: "eq", value: normal }, limit: 2 });
    ids = found.data.map((r) => r.id);
  }
  if (ids.length === 0) throw new FieldValueError(f.api_name, `has no match: no ${to} has ${by} = ${value}`);
  if (ids.length > 1) throw new FieldValueError(f.api_name, `is ambiguous: more than one ${to} has ${by} = ${value}`);
  cache.set(cacheKey, ids[0]!);
  return ids[0]!;
}
