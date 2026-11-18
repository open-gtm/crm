import type { Tx } from "../db/pool.js";
import { encodeId } from "../lib/ids.js";
import { canObject, fieldAccess } from "./access.js";
import { own, STATUS_MACHINES } from "./catalog.js";
import type { Ctx } from "./context.js";
import { ADDRESS_PART_NAMES, PERCENT, ratingMax } from "./fieldtypes.js";
import { listPipelines } from "./pipelines.js";
import { getObject, isModuleOn, loadSchema, quoteIdent, type FieldMeta, type ObjectMeta } from "./schema.js";
import { countLiveCustomRecordsCapped } from "./queries/records.js";
import { activeMembersForPicking, activityTypeList, schemaChangeLog } from "./queries/schema.js";

/**
 * Field metadata as agents and clients see it. Names are not data, so every field is listed to
 * anyone who can use the schema; `access` says what this caller can do with it (none, read, write).
 */
export function describeField(f: FieldMeta, access?: "none" | "read" | "write", objectName?: string) {
  // Standard status fields move between system categories (catalog.ts); a client offers only the moves the server allows.
  const machine = f.type === "status" && objectName ? own(STATUS_MACHINES, `${objectName}.${f.api_name}`) : undefined;
  return {
    name: f.api_name,
    label: f.label,
    type: f.type,
    description: f.description || undefined,
    required: f.required || undefined,
    read_only: f.read_only || undefined,
    create_only: f.create_only || undefined,
    unique: f.is_unique || undefined,
    hidden: f.hidden || undefined,
    sensitivity: f.sensitivity === "standard" ? undefined : f.sensitivity,
    standard: f.is_system || undefined,
    values: f.options.values,
    relation: f.type === "relation" ? { to: f.options.to, cardinality: f.options.cardinality ?? "many_to_one" } : undefined,
    initial: f.options.initial,
    transitions: f.options.transitions,
    category_transitions: machine,
    operation_only_categories: f.options.operation_only_categories,
    default: f.default_value ?? undefined,
    validation: Object.keys(f.validation ?? {}).length ? f.validation : undefined,
    ...typeDetails(f),
    access,
  };
}

/** What a client needs to show and edit the newer types: a rating's scale, a json field's shape, an address's parts, a number's unit. */
function typeDetails(f: FieldMeta): Record<string, unknown> {
  switch (f.type) {
    case "rating": return { max: ratingMax(f) };
    case "json": return { shape: f.options.shape, path_filters: true };
    case "address": return { parts: ADDRESS_PART_NAMES };
    case "percent": return { unit: "percent", min: f.validation.min ?? PERCENT.defaultMin, max: f.validation.max ?? PERCENT.defaultMax };
    case "duration": return { unit: "seconds" };
    default: return {};
  }
}

/** What the caller can do with an object's records. */
const objectAccess = (ctx: Ctx, o: ObjectMeta) => ({ read: canObject(ctx, o, "read"), write: canObject(ctx, o, "write"), archive: canObject(ctx, o, "archive") });

function describeObjectMeta(o: ObjectMeta) {
  return {
    name: o.api_name,
    label: o.label,
    plural_label: o.plural_label,
    description: o.description || undefined,
    id_prefix: o.id_prefix,
    standard: o.is_system,
    module: o.module ?? undefined,
    owned: o.owned,
    display_field: o.display_field ?? undefined,
  };
}

export async function describeObject(tx: Tx, ctx: Ctx, name: string, opts: { includeHidden?: boolean } = {}) {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, name);
  const fields = obj.fields.filter((f) => opts.includeHidden || !f.hidden).map((f) => describeField(f, fieldAccess(ctx, obj, f), obj.api_name));
  const extra: Record<string, unknown> = {};
  if (obj.api_name === "deal") extra.pipelines = await listPipelines(tx);
  if (obj.api_name === "activity") {
    extra.activity_types = await activityTypeList(tx);
  }
  if (obj.api_name === "activity" || obj.api_name === "task") {
    extra.virtual_fields = [{ name: "related_to", type: "array of record IDs", description: "Records this item is about (contacts, accounts, deals, any custom object). Set on create." }];
  }
  // Users are listed for picking an owner or assignee, so only to a caller who can read such a field here (as GET /v1/users).
  if ((obj.owned || obj.api_name === "task") && obj.fields.some((f) => f.type === "relation" && f.options.to === "user" && fieldAccess(ctx, obj, f) !== "none")) {
    const users = await activeMembersForPicking(tx);
    extra.users = users.map((u) => ({ id: encodeId("usr", u.id), name: u.name, email: u.email }));
  }
  return {
    ...describeObjectMeta(obj),
    access: objectAccess(ctx, obj),
    currency: schema.currency,
    system_fields: ["id", "display_name", "created_at", "updated_at", "version", "archived_at"],
    fields,
    ...extra,
  };
}

export async function listObjects(tx: Tx, ctx: Ctx) {
  const schema = await loadSchema(tx);
  return [...schema.objects.values()].filter((o) => isModuleOn(schema, o)).map((o) => ({
    ...describeObjectMeta(o), hidden: o.hidden || undefined, field_count: o.fields.length, access: objectAccess(ctx, o),
  }));
}

const COUNT_CAP = 10_000;

/** A compact map of the workspace for an agent's first call. Record counts are data, so they are given only for objects the caller can read. */
export async function schemaSummary(tx: Tx, ctx: Ctx) {
  const schema = await loadSchema(tx);
  const listed = [...schema.objects.values()].filter((o) => isModuleOn(schema, o) && !o.hidden);
  const visible = listed.filter((o) => canObject(ctx, o, "read"));
  // Counts stop at COUNT_CAP so a large table cannot make this first call slow. Custom objects share
  // `records` and are counted in one query, however many there are.
  const counts = new Map<string, number>();
  for (const o of visible.filter((x) => x.is_system)) {
    const [c] = await tx.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${quoteIdent(o.table_name!)} WHERE archived_at IS NULL LIMIT ${COUNT_CAP + 1}) s`);
    counts.set(o.id, c?.n ?? 0);
  }
  const custom = visible.filter((x) => !x.is_system).map((x) => x.id);
  if (custom.length) {
    const rows = await countLiveCustomRecordsCapped(tx, custom, COUNT_CAP);
    for (const r of rows) counts.set(r.id, r.n);
  }
  const objects = [];
  for (const o of listed) {
    const n = counts.get(o.id);
    objects.push({
      name: o.api_name, label: o.label, standard: o.is_system, id_prefix: o.id_prefix, records: n === undefined ? null : Math.min(n, COUNT_CAP),
      ...(n !== undefined && n > COUNT_CAP ? { records_capped: true } : {}), access: objectAccess(ctx, o),
      description: o.description || undefined,
      required_fields: o.fields.filter((f) => f.required && !f.read_only).map((f) => f.api_name),
      relations: o.fields.filter((f) => f.type === "relation" && !f.hidden).map((f) => `${f.api_name} → ${f.options.to}`),
      custom_fields: o.fields.filter((f) => !f.is_system && !f.hidden).map((f) => `${f.api_name} (${f.type})`),
    });
  }
  const pipelines = await listPipelines(tx);
  return {
    schema_version: schema.version,
    currency: schema.currency,
    modules: schema.modules,
    objects,
    pipelines: pipelines.map((p) => ({ name: p.name, is_default: p.is_default, stages: p.stages.map((s) => `${s.name} (${s.category})`) })),
    tips: [
      "Call describe_object before creating records of an object you have not used yet.",
      "Relations take record IDs (e.g. acct_…); find them with search or query_records.",
      "Deal stages change only through move_deal_stage; leads become deals through convert_lead.",
    ],
  };
}

export async function schemaChanges(tx: Tx, limit = 50) {
  const rows = await schemaChangeLog(tx, Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({
    version: Number(r.version), changed_at: r.changed_at.toISOString(), change: r.change_type, object: r.object_name,
    field: r.field_name, surface: r.surface, actor: r.actor_id ? encodeId(r.actor_type === "user" ? "usr" : "svc", r.actor_id) : r.actor_type,
    before: r.before, after: r.after,
  }));
}
