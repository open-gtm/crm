import type { Tx } from "../db/pool.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { assertObject, canObject, fieldAccess } from "./access.js";
import { aggregate, type AggregateInput } from "./aggregate.js";
import { ENTITIES, isEntity, own } from "./catalog.js";
import type { Ctx } from "./context.js";
import type { QueryInput } from "./query.js";
import { fetchRows, getAnyRecord, getRecord, queryRecords, serialize, type Page, type RecordOut, type SerializeOpts } from "./records.js";
import { getObject, loadSchema, type ObjectMeta, type Schema } from "./schema.js";
import { includedEntityRows } from "./queries/records.js";
import { resolveView } from "./views.js";

/**
 * Read shaping for tables and boards: `fields` (only these fields, plus id, object and version) and
 * `include` (many-to-one relations inline: the related record's display name and a few of its fields).
 * Everything goes through the reader's access, and an include costs one query per relation, never one
 * per record.
 */

export const SHAPE_LIMITS = { maxFields: 100, maxIncludes: 5, maxIncludeFields: 5 } as const;
/** Fields every record has besides its object's fields. id, object and version are always returned. */
const RECORD_FIELDS = new Set(["id", "object", "version", "display_name", "created_at", "updated_at", "archived_at", "merged_into", "merge_chain"]);
/** Kept on a record whatever `fields` asks for, when present: a merged record always says where it went (core/merge.ts). */
const ALWAYS_KEPT = ["merged_into", "merge_chain"];
/**
 * What an include can show of a platform entity. Users are listed with name and email to anyone who can read
 * an owner-like field (see the directory); a disabled user keeps their name, which records still refer to,
 * but not their email, which the directory no longer lists.
 */
const ENTITY_FIELDS: Record<string, string[]> = { user: ["name", "email"], pipeline: ["name"], stage: ["name", "category"] };

export interface ReadShape { fields?: string[]; include?: string[] }
interface Include { field: string; to: string; fields: string[] }
export interface ShapePlan { fields: Set<string> | null; includes: Include[]; includeHidden: boolean }

const names = (v: unknown, what: string, max: number): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 200)) {
    throw unprocessable(`${what} takes a list of at most ${max} names`);
  }
  return v as string[];
};

/**
 * Checks a shape before any query runs. Asking for a field the caller can't read is a 403 naming it, as
 * for a filter; `lenient` (a saved view's columns) drops such fields instead, since a view is not a grant.
 */
export function planShape(ctx: Ctx, schema: Schema, obj: ObjectMeta, shape: ReadShape, lenient = false): ShapePlan {
  let fields: Set<string> | null = null;
  let includeHidden = false;
  if (shape.fields !== undefined) {
    fields = new Set();
    for (const name of names(shape.fields, "fields", SHAPE_LIMITS.maxFields)) {
      if (RECORD_FIELDS.has(name) || ((obj.api_name === "activity" || obj.api_name === "task") && (name === "related_to" || name === "related"))) {
        fields.add(name);
        continue;
      }
      const f = obj.byName.get(name);
      if (!f) {
        if (lenient) continue;
        throw unprocessable(`"${name}" is not a field of ${obj.api_name}`, { field: name });
      }
      if (fieldAccess(ctx, obj, f) === "none") {
        if (lenient) continue;
        throw forbidden(`"${name}" is not visible to this key`);
      }
      if (f.hidden) includeHidden = true;
      fields.add(name);
    }
  }
  const includes = new Map<string, Include>();
  const asked = names(shape.include ?? [], "include", SHAPE_LIMITS.maxIncludes * (SHAPE_LIMITS.maxIncludeFields + 1));
  // `included` is reserved for new fields, but a field may hold the name from before; its value must not be overwritten.
  if (asked.length && obj.byName.has("included")) {
    throw unprocessable(`include: ${obj.api_name} has a field named "included", where included records would go; rename that field to use include`);
  }
  for (const entry of asked) {
    const [rel, sub, ...rest] = entry.split(".");
    const f = rel ? obj.byName.get(rel) : undefined;
    if (!rel || rest.length || !f || f.type !== "relation") throw unprocessable(`include: "${entry}" is not a relation of ${obj.api_name} (or relation.field)`);
    if (f.options.cardinality === "many_to_many") throw unprocessable(`include: "${rel}" holds many records; include takes many-to-one relations`);
    if (fieldAccess(ctx, obj, f) === "none") throw forbidden(`"${rel}" is not visible to this key`);
    const to = f.options.to!;
    const inc = includes.get(rel) ?? { field: rel, to, fields: [] };
    includes.set(rel, inc);
    if (sub === undefined || inc.fields.includes(sub)) continue;
    if (isEntity(to)) {
      if (!own(ENTITY_FIELDS, to)!.includes(sub)) throw unprocessable(`include: ${to} has ${own(ENTITY_FIELDS, to)!.join(", ")}`);
    } else {
      const target = schema.objects.get(to);
      if (!target || !canObject(ctx, target, "read")) throw forbidden(`"${rel}" leads to ${to} records, which this key can't read`);
      const tf = target.byName.get(sub);
      if (!tf && !RECORD_FIELDS.has(sub)) throw unprocessable(`include: "${sub}" is not a field of ${to}`);
      if (tf && fieldAccess(ctx, target, tf) === "none") throw forbidden(`"${to}.${sub}" is not visible to this key`);
    }
    inc.fields.push(sub);
    if (inc.fields.length > SHAPE_LIMITS.maxIncludeFields) throw unprocessable(`include: at most ${SHAPE_LIMITS.maxIncludeFields} fields of "${rel}"`);
  }
  if (includes.size > SHAPE_LIMITS.maxIncludes) throw unprocessable(`include: at most ${SHAPE_LIMITS.maxIncludes} relations`);
  return { fields, includes: [...includes.values()], includeHidden };
}

const pick = (rec: Record<string, unknown>, keep: Iterable<string>) => {
  const out: Record<string, unknown> = {};
  for (const k of keep) if (Object.hasOwn(rec, k)) out[k] = rec[k];
  return out;
};

/** Related entities by ID: one query per entity table. */
async function entityRows(tx: Tx, to: keyof typeof ENTITIES, uuids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const rows = await includedEntityRows(tx, to, uuids);
  return new Map(rows.map((r) => [encodeId(ENTITIES[to].prefix, r.id as string), { ...r, id: encodeId(ENTITIES[to].prefix, r.id as string), display_name: r.name }]));
}

/** Applies a plan to serialized records: includes first (they read relation values), then the field selection. */
export async function shapeRecords(tx: Tx, ctx: Ctx, schema: Schema, records: RecordOut[], plan: ShapePlan): Promise<RecordOut[]> {
  if (records.length === 0) return records;
  const included = records.map(() => ({} as Record<string, unknown>));
  for (const inc of plan.includes) {
    const ids = [...new Set(records.map((r) => r[inc.field]).filter((v): v is string => typeof v === "string"))];
    const found = new Map<string, Record<string, unknown>>();
    const keep = ["id", "object", "display_name", ...inc.fields];
    if (ids.length && isEntity(inc.to)) {
      for (const [id, row] of await entityRows(tx, inc.to, ids.map((i) => decodeId(i)!.uuid))) found.set(id, pick({ ...row, object: inc.to }, keep));
    } else if (ids.length) {
      const target = schema.objects.get(inc.to);
      // A related record on an object the reader can't read is its ID only, as everywhere else.
      if (target && canObject(ctx, target, "read")) {
        const rows = await fetchRows(tx, target, ids.map((i) => decodeId(i)?.uuid).filter((u): u is string => Boolean(u)));
        for (const r of await serialize(tx, ctx, schema, target, rows, { shallow: true })) found.set(r.id, pick(r, keep));
      }
    }
    records.forEach((r, i) => {
      const v = r[inc.field];
      included[i]![inc.field] = typeof v === "string" ? found.get(v) ?? { id: v, object: inc.to, display_name: null } : null;
    });
  }
  return records.map((r, i) => {
    const out = (plan.fields ? pick(r, ["id", "object", ...plan.fields, "version", ...ALWAYS_KEPT]) : r) as RecordOut;
    if (plan.includes.length) out.included = included[i];
    return out;
  });
}

export interface ListInput extends QueryInput, ReadShape { view?: string }

/** A list or query page: a saved view's settings (request parameters override them), then the shape. */
export async function listRecords(tx: Tx, ctx: Ctx, input: ListInput, opts: SerializeOpts = {}): Promise<Page> {
  const schema = await loadSchema(tx);
  let q: ListInput = input;
  let lenient = false;
  if (input.view !== undefined) {
    const view = await resolveView(tx, ctx, schema, input.view, input.object);
    q = { ...input, object: view.object, where: input.where ?? view.where, sort: input.sort ?? view.sort, fields: input.fields ?? view.columns };
    lenient = input.fields === undefined;
  }
  const obj = getObject(schema, q.object);
  assertObject(ctx, obj, "read");
  const plan = planShape(ctx, schema, obj, q, lenient);
  const page = await queryRecords(tx, ctx, q, { ...opts, includeHidden: opts.includeHidden || plan.includeHidden });
  return { ...page, data: await shapeRecords(tx, ctx, schema, page.data, plan) };
}

/** One record by object and ID, or by ID alone, with a shape. */
export async function readRecord(tx: Tx, ctx: Ctx, objectName: string | null, publicId: string, shape: ReadShape, opts: SerializeOpts = {}): Promise<RecordOut> {
  const schema = await loadSchema(tx);
  const obj = objectName === null ? schema.byPrefix.get(decodeId(publicId)?.prefix ?? "") : getObject(schema, objectName);
  const plan = obj && (shape.fields !== undefined || shape.include !== undefined) ? (assertObject(ctx, obj, "read"), planShape(ctx, schema, obj, shape)) : null;
  const o = { ...opts, includeHidden: opts.includeHidden || Boolean(plan?.includeHidden) };
  const rec = objectName === null ? await getAnyRecord(tx, ctx, publicId, o) : await getRecord(tx, ctx, objectName, publicId, o);
  return plan ? (await shapeRecords(tx, ctx, schema, [rec], plan))[0]! : rec;
}

/** Aggregates with a saved view's filter and grouping when one is named (request parameters override them). */
export async function aggregateRecords(tx: Tx, ctx: Ctx, input: AggregateInput & { view?: string }) {
  if (input.view === undefined) return aggregate(tx, ctx, input);
  const schema = await loadSchema(tx);
  const view = await resolveView(tx, ctx, schema, input.view, input.object);
  return aggregate(tx, ctx, { ...input, object: view.object, where: input.where ?? view.where, group_by: input.group_by ?? view.group_by });
}
