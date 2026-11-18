import type { Tx } from "../db/pool.js";
import { ApiError, forbidden, unprocessable } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { accessGuard, assertObject, canObject, fieldAccess } from "./access.js";
import { ENTITIES, isEntity, type FieldType } from "./catalog.js";
import { ADDRESS_GROUP_PARTS, FIELD_TYPES, isAddressPart, TYPE_INFO } from "./fieldtypes.js";
import type { Ctx } from "./context.js";
import { Compiler, targetFor, type Where } from "./query.js";
import { fetchRows, serialize } from "./records.js";
import { getObject, loadSchema, quoteIdent, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";
import { aggregateRows, entityNames } from "./queries/records.js";

/**
 * Counts and totals per group, for boards and summaries. One SQL statement does the grouping, under the
 * same filter compiler and access guard as a list, so a group or total reveals nothing a list of the same
 * records wouldn't. Grouping by or measuring a field the caller can't read is refused (403), restricted
 * fields never (422). Relation keys are IDs with display names resolved through the reader's access.
 *
 * The statement's work is bounded: it looks at the AGGREGATE_ROWS.max most recently updated matching
 * records, and says so (rows_capped) when there were more, so a total is never silently partial.
 */

export type Bucket = "day" | "week" | "month" | "quarter" | "year";
export interface GroupBy { field: string; bucket?: Bucket }
export interface Measure { op: "count" | "sum" | "avg" | "min" | "max"; field?: string }
export interface AggregateInput {
  object: string;
  where?: Where;
  group_by?: GroupBy[];
  measures?: Measure[];
  /** Groups returned at most (default 100, at most 1,000). */
  limit?: number;
  /** key (default): by the group keys, in pipeline order for stages and option order for selects. count: largest groups first. */
  order?: "key" | "count";
  include_archived?: boolean;
}

export const AGGREGATE_LIMITS = { maxGroupBy: 2, maxMeasures: 6, defaultGroups: 100, maxGroups: 1_000 } as const;
/** Records one aggregate looks at, at most: the newest by updated_at. Mutable for tests. */
export const AGGREGATE_ROWS = { max: 100_000 };
const BUCKETS: Bucket[] = ["day", "week", "month", "quarter", "year"];
/** What can be grouped and measured comes from the field type registry (core/fieldtypes.ts). */
const GROUP_TYPES: FieldType[] = FIELD_TYPES.filter((t) => TYPE_INFO[t].group);
const MEASURE_TYPES: Record<Measure["op"], FieldType[]> = {
  count: [], sum: FIELD_TYPES.filter((t) => TYPE_INFO[t].measures.includes("sum")), avg: FIELD_TYPES.filter((t) => TYPE_INFO[t].measures.includes("avg")),
  min: FIELD_TYPES.filter((t) => TYPE_INFO[t].measures.includes("min")), max: FIELD_TYPES.filter((t) => TYPE_INFO[t].measures.includes("max")),
};
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** created_at and updated_at, which every record has and every reader of the object can see. */
const builtin = (obj: ObjectMeta, name: string): FieldMeta | undefined => (name === "created_at" || name === "updated_at" ? {
  id: `builtin:${name}`, object_id: obj.id, api_name: name, storage_key: name, label: name, description: "", type: "datetime", is_system: true,
  column_name: name, read_only: true, create_only: false, required: false, is_unique: false, default_value: null, validation: {}, options: {},
  sensitivity: "standard", hidden: false, position: 0,
} : undefined);

/**
 * A part of an address field to group by (hq.country): a text field with the address's ID, so its access rules and
 * sensitivity are the address's own.
 */
const addressPart = (obj: ObjectMeta, name: string): FieldMeta | undefined => {
  const [parent, part, ...rest] = name.split(".");
  const f = parent ? obj.byName.get(parent) : undefined;
  if (!f || f.type !== "address" || rest.length || !part || !isAddressPart(part) || !ADDRESS_GROUP_PARTS.includes(part)) return undefined;
  return { ...f, api_name: name, type: "text", options: {}, validation: {} };
};

/** The field behind a group or measure: it must exist, be readable, and not be restricted. */
function usable(ctx: Ctx, obj: ObjectMeta, name: unknown, what: string): FieldMeta {
  const f = typeof name === "string" ? obj.byName.get(name) ?? builtin(obj, name) ?? addressPart(obj, name) : undefined;
  if (!f) throw unprocessable(`${what}: "${String(name).slice(0, 100)}" is not a field of ${obj.api_name}`);
  if (fieldAccess(ctx, obj, f) === "none") throw forbidden(`${what}: "${f.api_name}" is not visible to this key`);
  if (f.sensitivity === "restricted") throw unprocessable(`${what}: "${f.api_name}" is restricted and cannot be grouped or measured`);
  return f;
}

/** Checks a grouping against the object and the caller's access; shared by aggregate and saved views. */
export function checkGroupBy(ctx: Ctx, obj: ObjectMeta, groupBy: unknown): { f: FieldMeta; bucket: Bucket | null }[] {
  if (groupBy === undefined) return [];
  if (!Array.isArray(groupBy) || groupBy.length > AGGREGATE_LIMITS.maxGroupBy) throw unprocessable(`group_by takes at most ${AGGREGATE_LIMITS.maxGroupBy} fields`);
  const seen = new Set<string>();
  return groupBy.map((g: unknown) => {
    if (!isPlainObject(g)) throw unprocessable("Each group_by is {field, bucket?}");
    const f = usable(ctx, obj, g.field, "group_by");
    if (seen.has(f.api_name)) throw unprocessable(`group_by: "${f.api_name}" appears twice`);
    seen.add(f.api_name);
    if (!GROUP_TYPES.includes(f.type) || (f.type === "relation" && f.options.cardinality === "many_to_many")) {
      throw unprocessable(`group_by: "${f.api_name}" is a ${f.type} field; group by a select, status, boolean, text, rating, date, date-time or many-to-one relation`
        + (f.type === "address" ? `, or an address's ${ADDRESS_GROUP_PARTS.map((p) => `${f.api_name}.${p}`).join(", ")}` : ""));
    }
    const dated = f.type === "date" || f.type === "datetime";
    if (g.bucket !== undefined && (!dated || !BUCKETS.includes(g.bucket as Bucket))) {
      throw unprocessable(dated ? `group_by: bucket is one of ${BUCKETS.join(", ")}` : `group_by: only date fields take a bucket`);
    }
    return { f, bucket: dated ? (g.bucket as Bucket | undefined) ?? "day" : null };
  });
}

/** The per-record currency field of an object (deals have one), or null when amounts are in the workspace currency. */
const currencyField = (obj: ObjectMeta) => {
  const f = obj.byName.get("currency");
  return f && f.is_system && f.type === "text" && f.column_name ? f : null;
};

export async function aggregate(tx: Tx, ctx: Ctx, input: AggregateInput) {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, input.object);
  assertObject(ctx, obj, "read");
  const groups = checkGroupBy(ctx, obj, input.group_by);
  const measures = input.measures ?? [];
  if (!Array.isArray(measures) || measures.length > AGGREGATE_LIMITS.maxMeasures) throw unprocessable(`measures takes at most ${AGGREGATE_LIMITS.maxMeasures} entries`);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1)) throw unprocessable("limit must be a positive whole number");
  const limit = Math.min(input.limit ?? AGGREGATE_LIMITS.defaultGroups, AGGREGATE_LIMITS.maxGroups);
  if (input.order !== undefined && input.order !== "key" && input.order !== "count") throw unprocessable('order is "key" or "count"');

  const t = targetFor(schema, obj.api_name);
  const c = new Compiler(schema, accessGuard(ctx, schema));
  const a = "r";
  const conds: string[] = [];
  if (t.objectId) conds.push(`${a}.object_id = ${c.param(t.objectId, "uuid")}`);
  if (!input.include_archived) conds.push(`${a}.archived_at IS NULL`);
  if (input.where !== undefined) conds.push(c.compileWhere(t, a, input.where, 0));

  const keyExpr = (f: FieldMeta, bucket: Bucket | null): string => {
    const sf = t.fields.get(f.api_name)!;
    if (sf.linkFieldId) {
      return `(SELECT lk.to_id FROM record_links lk WHERE lk.field_id = ${c.param(sf.linkFieldId, "uuid")} AND lk.from_id = ${a}.id ORDER BY lk.to_id LIMIT 1)`;
    }
    const e = c.expr(a, sf);
    if (!bucket) return e;
    // Date-times are bucketed in UTC.
    return f.type === "datetime" ? `date_trunc('${bucket}', ${e} AT TIME ZONE 'UTC')::date` : `date_trunc('${bucket}', ${e})::date`;
  };
  const cols = groups.map((g, i) => `(${keyExpr(g.f, g.bucket)})::text AS __k${i}`);

  const outMeasures: { key: string; op: Measure["op"]; field: string | null; type: FieldType | null }[] = [];
  const mcols: string[] = [];
  for (const m of measures) {
    if (!isPlainObject(m) || typeof m.op !== "string" || !Object.hasOwn(MEASURE_TYPES, m.op)) throw unprocessable(`Each measure is {op, field}: op is one of ${Object.keys(MEASURE_TYPES).join(", ")}`);
    if (m.field === undefined) {
      if (m.op !== "count") throw unprocessable(`measure ${m.op} needs a field`);
      continue; // the group's count is always returned
    }
    const f = usable(ctx, obj, m.field, `measure ${m.op}`);
    if (m.op !== "count" && !MEASURE_TYPES[m.op].includes(f.type)) throw unprocessable(`measure ${m.op}: "${f.api_name}" is a ${f.type} field; ${m.op} takes ${MEASURE_TYPES[m.op].join(", ")} fields`);
    const key = `${m.op}_${f.api_name}`;
    if (outMeasures.some((x) => x.key === key)) throw unprocessable(`measure ${key} appears twice`);
    // count(field) counts records where the field is set.
    mcols.push(`${m.op}(${keyExpr(f, null)})::text AS __m${outMeasures.length}`);
    outMeasures.push({ key, op: m.op, field: f.api_name, type: f.type });
  }

  // Amounts in different currencies are never added up: an object with a per-record currency (deals) is
  // checked per group, and a group that mixes currencies is refused with a hint to group by currency.
  const money = outMeasures.some((m) => m.type === "currency" && m.op !== "count");
  const curField = money ? currencyField(obj) : null;
  if (curField && fieldAccess(ctx, obj, curField) === "none") {
    throw forbidden(`Totals of ${obj.api_name} amounts show their currency, and "${curField.api_name}" is not visible to this key`);
  }
  if (curField) mcols.push(`count(DISTINCT ${c.expr(a, t.fields.get(curField.api_name)!)})::int AS __ncur, min(${c.expr(a, t.fields.get(curField.api_name)!)}) AS __cur`);

  const order = (i: number, f: FieldMeta) => {
    const k = `g.__k${i}`;
    const rel = f.type === "relation" ? f.options.to : null;
    const rank = rel === "stage" ? `(SELECT s.position FROM stages s WHERE s.id = ${k}::uuid)`
      : rel === "pipeline" ? `(SELECT p.position FROM pipelines p WHERE p.id = ${k}::uuid)`
      : rel === "user" ? `(SELECT u.name FROM users u WHERE u.id = ${k}::uuid)`
      : f.options.values?.length ? `array_position(${c.param(f.options.values.map((v) => v.key), "text[]")}, ${k})`
      : null;
    // Other relations are ordered by ID, never by a name: the name could come from a field the reader can't see.
    return `(${k} IS NULL), ${rank ? `${rank}, ` : ""}${f.type === "boolean" ? `${k} DESC` : k}`;
  };
  const keyOrder = groups.map((g, i) => order(i, g.f));
  const orderBy = [...(input.order === "count" ? ["g.__count DESC"] : []), ...keyOrder].join(", ") || "1";
  const from = `FROM ${quoteIdent(t.table)} ${a} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}`;
  // Groups are built from the newest AGGREGATE_ROWS.max matching records (by updated_at, which custom objects index);
  // __seen counts matches up to one more, stopping there, to tell whether any were left out.
  const text = `SELECT g.*, (SELECT count(*) FROM (SELECT 1 ${from} LIMIT ${AGGREGATE_ROWS.max + 1}) x)::int AS __seen FROM (
      SELECT ${[...cols, "count(*)::int AS __count", ...mcols].join(", ")}
      FROM (SELECT ${a}.* ${from} ORDER BY ${a}.updated_at DESC, ${a}.id DESC LIMIT ${AGGREGATE_ROWS.max}) ${a}
      ${groups.length ? `GROUP BY ${groups.map((_, i) => i + 1).join(", ")}` : ""}
    ) g ORDER BY ${orderBy} LIMIT ${limit + 1}`;

  let rows: Record<string, unknown>[];
  try {
    rows = await aggregateRows(tx, text, c.params);
  } catch (e) {
    if (typeof (e as { code?: string }).code === "string" && (e as { code: string }).code.startsWith("22")) throw unprocessable("A filter value is not valid for its field");
    throw e;
  }
  const truncated = rows.length > limit;
  const rowsCapped = rows.some((r) => Number(r.__seen) > AGGREGATE_ROWS.max);
  rows = rows.slice(0, limit);
  if (curField && rows.some((r) => Number(r.__ncur) > 1)) {
    throw new ApiError(422, "mixed_currencies", `These ${obj.plural_label.toLowerCase()} are in more than one currency, so their amounts can't be added up; add {"field": "${curField.api_name}"} to group_by`);
  }
  const names = await keyNames(tx, ctx, schema, groups.map((g) => g.f), rows);
  const data = rows.map((r) => ({
    group: Object.fromEntries(groups.map((g, i) => [g.f.api_name, keyValue(schema, g.f, r[`__k${i}`] as string | null, names)])),
    count: Number(r.__count),
    values: Object.fromEntries(outMeasures.map((m, i) => [m.key, measureValue(m.op, m.type, r[`__m${i}`] as string | null)])),
    ...(money ? { currency: curField ? (r.__cur as string | null) ?? schema.currency : schema.currency } : {}),
  }));
  return {
    data,
    group_by: groups.map((g) => ({ field: g.f.api_name, ...(g.bucket ? { bucket: g.bucket } : {}) })),
    measures: [{ key: "count", op: "count", field: null }, ...outMeasures.map(({ key, op, field }) => ({ key, op, field }))],
    truncated,
    /** True when more records matched than AGGREGATE_ROWS.max: the groups and totals then cover only the newest AGGREGATE_ROWS.max. */
    rows_capped: rowsCapped,
  };
}

/** A measure from its SQL text: an empty group sums to 0 and has no average, minimum or maximum. */
function measureValue(op: Measure["op"], type: FieldType | null, v: string | null): number | string | null {
  if (v === null) return op === "count" || op === "sum" ? 0 : null;
  if (op === "count") return Number(v);
  if (type === "date") return v.slice(0, 10);
  if (type === "datetime") return new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).toISOString();
  // Currency is stored in minor units; an average is rounded to the nearest one.
  return type === "currency" ? Math.round(Number(v)) / 100 : Number(v);
}

const relationPrefix = (schema: Schema, to: string) => (isEntity(to) ? ENTITIES[to].prefix : schema.objects.get(to)?.id_prefix ?? "rec");

function keyValue(schema: Schema, f: FieldMeta, v: string | null, names: Map<string, string | null>): unknown {
  if (v === null) return null;
  if (f.type === "boolean") return v === "true";
  if (TYPE_INFO[f.type].cast === "numeric") return Number(v);
  if (f.type !== "relation") return v;
  const id = encodeId(relationPrefix(schema, f.options.to!), v);
  return { id, display_name: names.get(id) ?? null };
}

/** Display names of relation keys: one query per related object or entity, as the reader may see them. */
async function keyNames(tx: Tx, ctx: Ctx, schema: Schema, fields: FieldMeta[], rows: Record<string, unknown>[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const [i, f] of fields.entries()) {
    if (f.type !== "relation") continue;
    const uuids = [...new Set(rows.map((r) => r[`__k${i}`]).filter((v): v is string => typeof v === "string"))];
    const to = f.options.to!;
    if (isEntity(to)) {
      if (!uuids.length) continue;
      const found = await entityNames(tx, ENTITIES[to].table, uuids);
      for (const r of found) out.set(encodeId(ENTITIES[to].prefix, r.id), r.name);
      continue;
    }
    const target = schema.objects.get(to);
    if (!target || !uuids.length || !canObject(ctx, target, "read")) continue;
    for (const rec of await serialize(tx, ctx, schema, target, await fetchRows(tx, target, uuids), { shallow: true })) out.set(rec.id, String(rec.display_name));
  }
  return out;
}
