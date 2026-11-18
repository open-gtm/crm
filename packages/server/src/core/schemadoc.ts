import type { Tx } from "../db/pool.js";
import { ApiError, deadline, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { describeAccess } from "./access.js";
import { audit } from "./audit.js";
import { CATALOG, type FieldType, type JsonShape, type SelectValue, type Sensitivity } from "./catalog.js";
import { ratingMax, TYPE_INFO } from "./fieldtypes.js";
import type { Ctx } from "./context.js";
import { actorRef } from "./webhooks.js";
import { schemaChangesSince, type DriftRow } from "./queries/schema.js";
import { addStage, createPipeline, listPipelines, reorderStages, updatePipeline, updateStage } from "./pipelines.js";
import {
  addField, archiveField, confirmToken, createObject, isModuleOn, loadSchema, lockSchema, retypeField, SAFE_RETYPES, setModules, updateField,
  updateObject, type Change, type FieldInput, type FieldMeta, type FieldPatch, type ObjectMeta, type ObjectPatch,
} from "./schema.js";

/**
 * Schema-as-code: one document describes a workspace's configurable schema (modules, objects,
 * fields, pipelines and stages). Export writes it; plan diffs a document against the workspace;
 * apply makes the workspace match it through the same schema functions every other surface uses.
 *
 * Identity: every object, field, pipeline and stage carries its immutable ID (obj_, fld_, pipe_,
 * stg_), so changing a name is planned as a rename. Entries without an ID, or with an ID from
 * another workspace, are matched by name, and the plan says so.
 *
 * Properties left out of an entry are left as they are. Nothing in the workspace is archived
 * unless the caller asks to prune, and archiving or converting stored values needs confirmation.
 *
 * Plan and apply take the schema lock (lockSchema) before they read the schema version, so drift is
 * measured against the schema they run on: a change committed while apply waited for the lock shows
 * up as drift (and a 412), never as a silent overwrite.
 */

export const SCHEMA_FORMAT = "hl-crm-db/schema@1";

export interface DocField {
  id?: string;
  name: string;
  type: FieldType;
  label?: string;
  description?: string;
  required?: boolean;
  unique?: boolean;
  hidden?: boolean;
  sensitivity?: Sensitivity;
  default?: unknown;
  validation?: FieldMeta["validation"];
  values?: SelectValue[];
  relation?: { to: string; cardinality?: "many_to_one" | "many_to_many" };
  initial?: string;
  transitions?: Record<string, string[]>;
  /** rating: the highest rating. */
  max?: number;
  /** json: the shape check. */
  shape?: JsonShape;
  /** Informational on export (standard field, read-only field); ignored on input. */
  standard?: boolean;
  read_only?: boolean;
}

export interface DocObject {
  id?: string;
  name: string;
  label?: string;
  plural_label?: string;
  description?: string;
  id_prefix?: string;
  display_field?: string;
  owned?: boolean;
  hidden?: boolean;
  /** Informational on export; ignored on input. */
  standard?: boolean;
  module?: string;
  fields?: DocField[];
}

export interface DocStage { id?: string; name: string; category?: "open" | "won" | "lost"; probability?: number | null }
export interface DocPipeline { id?: string; name: string; is_default?: boolean; stages: DocStage[] }

export interface SchemaDoc {
  format?: string;
  /** The workspace schema version the document was exported at. Drift is measured from it. */
  schema_version?: number;
  modules?: string[];
  objects?: DocObject[];
  pipelines?: DocPipeline[];
  /** On export, the caller's record access when it is limited (as in GET /v1/me/access). Ignored on input. */
  access?: unknown;
}

export type PlannedChange = Change & { data_affecting?: boolean };
export interface Problem { path: string; message: string }
export interface DriftEntry {
  version: number; changed_at: string; change: string; object: string | null; field: string | null;
  actor: string; surface: string; conflicts: boolean;
}

export interface Plan {
  schema_version: number;
  document_version: number | null;
  changes: PlannedChange[];
  /** What the document asks for that schema apply cannot do. Apply refuses while this is non-empty. */
  unsupported: Problem[];
  /** Things left alone, e.g. fields in the workspace but not in the document when not pruning. */
  notes: string[];
  matched_by_name: { path: string; reason: string }[];
  /** Schema changes made since document_version. `conflicts` marks those this plan would overwrite. */
  drift: DriftEntry[];
  drift_truncated?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Export

const nonEmpty = <T extends object>(o: T | null | undefined): T | undefined => (o && Object.keys(o).length ? o : undefined);

function docField(f: FieldMeta): DocField {
  return {
    id: encodeId("fld", f.id), name: f.api_name, type: f.type, label: f.label,
    description: f.description || undefined, required: f.required || undefined, unique: f.is_unique || undefined,
    hidden: f.hidden || undefined, sensitivity: f.sensitivity === "standard" ? undefined : f.sensitivity,
    default: f.default_value ?? undefined, validation: nonEmpty(f.validation), values: f.options.values,
    relation: f.type === "relation" ? { to: f.options.to!, cardinality: f.options.cardinality ?? "many_to_one" } : undefined,
    initial: f.options.initial, transitions: f.options.transitions,
    max: f.type === "rating" ? ratingMax(f) : undefined, shape: f.options.shape,
    standard: f.is_system || undefined, read_only: f.read_only || undefined,
  };
}

/** Standard objects in catalog order, then custom objects by name, so exports diff cleanly. */
function objectOrder(a: ObjectMeta, b: ObjectMeta): number {
  const rank = (o: ObjectMeta) => { const i = CATALOG.findIndex((c) => c.api_name === o.api_name); return i < 0 ? CATALOG.length : i; };
  return rank(a) - rank(b) || a.api_name.localeCompare(b.api_name);
}

/**
 * The schema document. Names are not data (ADR 0008), so it lists every object and field whatever
 * the caller can read, as GET /v1/objects/{object}?include_hidden=true does. When the caller can't
 * read, write and archive everything, `access` says what it can, so a document pulled with a limited
 * key isn't mistaken for what that key can work with. Unrestricted callers (anyone who can apply,
 * since schema:manage needs unrestricted access) get none, so their files don't change with the key.
 */
export async function exportSchema(tx: Tx, ctx: Ctx): Promise<SchemaDoc & { schema_version: number }> {
  const schema = await loadSchema(tx);
  // Objects of a module that is off are left out, as GET /v1/objects does; apply leaves objects a document omits alone.
  const objects: DocObject[] = [...schema.objects.values()].filter((o) => isModuleOn(schema, o)).sort(objectOrder).map((o) => ({
    id: encodeId("obj", o.id), name: o.api_name, label: o.label, plural_label: o.plural_label, description: o.description || undefined,
    id_prefix: o.id_prefix, display_field: o.display_field ?? undefined, owned: o.owned, hidden: o.hidden || undefined,
    standard: o.is_system || undefined, module: o.module ?? undefined, fields: o.fields.map(docField),
  }));
  const pipelines: DocPipeline[] = (await listPipelines(tx)).map((p) => ({
    id: p.id, name: p.name, is_default: p.is_default,
    stages: p.stages.map((s) => ({ id: s.id, name: s.name, category: s.category as DocStage["category"], probability: s.default_probability ?? undefined })),
  }));
  const access = describeAccess(ctx, schema);
  const limited = access.some((a) => !a.read || !a.write || !a.archive || Object.keys(a.fields).length > 0);
  return { format: SCHEMA_FORMAT, schema_version: schema.version, modules: schema.modules, objects, pipelines, ...(limited ? { access } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Running a document

/** JSON with sorted keys, so equal values compare equal whatever order a YAML file gave them in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => canon(a) === canon(b);
const valuesOf = (vs: SelectValue[] | undefined) => (vs ?? []).map((v) => ({ key: v.key, label: v.label, ...(v.category ? { category: v.category } : {}) }));

interface Run {
  changes: PlannedChange[];
  unsupported: Problem[];
  notes: string[];
  matched_by_name: { path: string; reason: string }[];
  /** What this run changed: object:<uuid>, field:<uuid>, pipeline:<public id>, modules. Drift is checked against it. */
  touched: Set<string>;
  /**
   * Names this run gives to something new or renamed (see names): an add matches nothing by ID, so a
   * concurrent archive, rename or create of the same name is caught by name instead.
   */
  added: Set<string>;
  /** Throws once the request's work budget is spent. Called after every change. */
  check: () => void;
}

/** Name keys shared by Run.added and drift entries. Stage names are unique per pipeline ignoring case, as addStage checks. */
const names = {
  object: (o: string) => `object:${o}`,
  field: (o: string, f: string) => `field:${o}.${f}`,
  pipeline: (p: string) => `pipeline:${p}`,
  stage: (pipelineId: string, s: string) => `stage:${pipelineId}:${s.toLowerCase()}`,
};

/** The most changes one document may make: apply makes them all in one transaction, holding the schema lock. */
export const MAX_DOCUMENT_CHANGES = 500;

/** Prefixes errors from the schema functions with where in the document they came from. */
async function at<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) e.message = `${path}: ${e.message}`;
    throw e;
  }
}

/** Matches a document entry by ID, else by name. Records name matches, and never matches one thing twice. */
function resolve<T extends { id: string }>(
  run: Run, path: string, id: string | undefined, prefix: string, claimed: Set<string>,
  byId: (uuid: string) => T | undefined, byName: () => T | undefined, publicIds = false,
): T | undefined {
  if (id !== undefined) {
    const d = decodeId(id);
    const hit = d?.prefix === prefix ? byId(publicIds ? id : d.uuid) : undefined;
    if (hit && !claimed.has(hit.id)) return claim(hit);
  }
  const named = byName();
  if (!named || claimed.has(named.id)) return undefined;
  run.matched_by_name.push({ path, reason: id === undefined ? "no id in the document" : "its id is not in this workspace" });
  return claim(named);
  function claim(x: T): T {
    claimed.add(x.id);
    return x;
  }
}

function fieldInput(f: DocField): FieldInput {
  const options = Object.fromEntries(Object.entries({
    values: f.values, to: f.relation?.to, cardinality: f.relation?.cardinality, initial: f.initial, transitions: f.transitions,
    max: f.max, shape: f.shape,
  }).filter(([, v]) => v !== undefined));
  return {
    api_name: f.name, type: f.type, label: f.label, description: f.description, required: f.required, unique: f.unique,
    default: f.default, sensitivity: f.sensitivity, hidden: f.hidden, validation: f.validation, options,
  };
}

function checkNames(doc: SchemaDoc): void {
  const dup = (what: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) throw unprocessable(`${what} "${n}" appears twice in the document`);
      seen.add(n);
    }
  };
  if (doc.format !== undefined && doc.format !== SCHEMA_FORMAT) throw unprocessable(`Unknown document format "${doc.format}"; expected ${SCHEMA_FORMAT}`);
  dup("Object", (doc.objects ?? []).map((o) => o.name));
  for (const o of doc.objects ?? []) dup(`Field of ${o.name}`, (o.fields ?? []).map((f) => f.name));
  dup("Pipeline", (doc.pipelines ?? []).map((p) => p.name));
  for (const p of doc.pipelines ?? []) dup(`Stage of ${p.name}`, p.stages.map((s) => s.name.toLowerCase()));
}

const pushAll = (run: Run, changes: Change[], dataAffecting = false) => {
  for (const c of changes) run.changes.push(dataAffecting ? { ...c, data_affecting: true } : c);
  if (run.changes.length > MAX_DOCUMENT_CHANGES) {
    throw unprocessable(`The document makes more than ${MAX_DOCUMENT_CHANGES} changes; apply it in parts (entries left out of a document are left as they are)`);
  }
  run.check();
};

/** Makes the workspace match `doc`, recording what it did. Plan runs this inside a savepoint and rolls it back. */
async function runDocument(tx: Tx, ctx: Ctx, doc: SchemaDoc, opts: { prune: boolean; check: () => void }): Promise<Run> {
  const run: Run = { changes: [], unsupported: [], notes: [], matched_by_name: [], touched: new Set(), added: new Set(), check: opts.check };
  const unsupported = (path: string, message: string) => run.unsupported.push({ path, message });
  let schema = await loadSchema(tx);

  if (doc.modules) {
    const want = [...new Set(doc.modules)].sort();
    if (want.join() !== [...schema.modules].sort().join()) {
      pushAll(run, (await at("modules", () => setModules(tx, ctx, want, false))).changes);
      run.touched.add("modules");
      schema = await loadSchema(tx);
    }
  }

  // Match objects first, so relations between new objects can be ordered.
  const claimedObjects = new Set<string>();
  const entries = (doc.objects ?? []).map((o) => {
    const path = `objects.${o.name}`;
    const obj = resolve(run, path, o.id, "obj", claimedObjects, (u) => schema.byId.get(u), () => schema.objects.get(o.name));
    return { o, obj, path };
  });

  // New objects, created so a relation's target exists first where possible; relations in a cycle are added afterwards.
  const pendingNew = entries.filter((e) => !e.obj);
  const created = new Set<string>();
  const deferred: { obj: string; f: DocField; path: string }[] = [];
  const newNames = new Set(pendingNew.map((e) => e.o.name));
  const waitsOn = (e: (typeof pendingNew)[number]) => (e.o.fields ?? []).filter((f) =>
    f.type === "relation" && f.relation && f.relation.to !== e.o.name && newNames.has(f.relation.to) && !created.has(f.relation.to));
  while (pendingNew.length) {
    const i = Math.max(0, pendingNew.findIndex((e) => waitsOn(e).length === 0));
    const { o, path } = pendingNew.splice(i, 1)[0]!;
    const later = new Set(waitsOn({ o, obj: undefined, path }));
    for (const f of later) deferred.push({ obj: o.name, f, path: `${path}.fields.${f.name}` });
    const r = await at(path, () => createObject(tx, ctx, {
      api_name: o.name, label: o.label, plural_label: o.plural_label, description: o.description, id_prefix: o.id_prefix,
      display_field: o.display_field, owned: o.owned, fields: (o.fields ?? []).filter((f) => !later.has(f)).map(fieldInput),
    }, false));
    pushAll(run, r.changes);
    created.add(o.name);
    run.added.add(names.object(o.name));
    for (const f of o.fields ?? []) run.added.add(names.field(o.name, f.name));
    if (o.hidden) pushAll(run, (await at(path, () => updateObject(tx, ctx, o.name, { hidden: true }, false))).changes);
  }
  for (const d of deferred) pushAll(run, (await at(d.path, () => addField(tx, ctx, d.obj, fieldInput(d.f), false))).changes);
  schema = await loadSchema(tx);

  for (const { o, obj, path } of entries) {
    if (!obj) continue;
    if (o.name !== obj.api_name) unsupported(path, `Objects cannot be renamed (this is "${obj.api_name}"); change its label instead`);
    if (o.id_prefix !== undefined && o.id_prefix !== obj.id_prefix) unsupported(`${path}.id_prefix`, "An object's id_prefix cannot change");
    if (o.owned !== undefined && o.owned !== obj.owned) unsupported(`${path}.owned`, "Whether an object is owned cannot change");
    const patch: ObjectPatch = {};
    for (const k of ["label", "plural_label", "description", "hidden"] as const) {
      if (o[k] !== undefined && o[k] !== obj[k]) (patch as Record<string, unknown>)[k] = o[k];
    }
    if (o.display_field !== undefined && o.display_field !== obj.display_field) {
      if (obj.is_system) unsupported(`${path}.display_field`, "Standard objects have a fixed display field");
      else patch.display_field = o.display_field;
    }
    if (Object.keys(patch).length) {
      pushAll(run, (await at(path, () => updateObject(tx, ctx, obj.api_name, patch, false))).changes);
      run.touched.add(`object:${obj.id}`);
    }
    await runFields(tx, ctx, run, obj, o, path, opts);
  }
  if (doc.objects) {
    for (const obj of (await loadSchema(tx)).objects.values()) {
      if (obj.is_system || claimedObjects.has(obj.id) || created.has(obj.api_name)) continue;
      if (opts.prune) unsupported(`objects.${obj.api_name}`, "Schema apply does not archive objects; set hidden: true on it instead");
      else run.notes.push(`objects.${obj.api_name}: in the workspace but not in the document; left as it is`);
    }
  }

  await runPipelines(tx, ctx, run, doc, opts);
  return run;
}

async function runFields(tx: Tx, ctx: Ctx, run: Run, obj: ObjectMeta, o: DocObject, opath: string, opts: { prune: boolean }): Promise<void> {
  const claimed = new Set<string>();
  const updates: { field: FieldMeta; patch: FieldPatch; path: string }[] = [];
  const retypes: { name: string; field: FieldMeta; type: FieldType; path: string }[] = [];
  const adds: { f: DocField; path: string }[] = [];
  const unsupported = (path: string, message: string) => run.unsupported.push({ path, message });

  for (const f of o.fields ?? []) {
    const path = `${opath}.fields.${f.name}`;
    const field = resolve(run, path, f.id, "fld", claimed, (u) => obj.fields.find((x) => x.id === u), () => obj.byName.get(f.name));
    if (!field) {
      adds.push({ f, path });
      continue;
    }
    const patch: FieldPatch = {};
    if (f.name !== field.api_name) {
      if (field.is_system) unsupported(path, `Standard fields cannot be renamed (this is "${field.api_name}"); change its label instead`);
      else {
        patch.api_name = f.name;
        run.added.add(names.field(obj.api_name, f.name));
      }
    }
    for (const k of ["label", "description", "required", "hidden"] as const) {
      if (f[k] !== undefined && f[k] !== field[k]) (patch as Record<string, unknown>)[k] = f[k];
    }
    if (f.sensitivity !== undefined && f.sensitivity !== field.sensitivity) {
      if (f.sensitivity === "restricted" || field.sensitivity === "restricted") {
        unsupported(`${path}.sensitivity`, "A field cannot become or stop being restricted; add a new restricted field instead");
      } else patch.sensitivity = f.sensitivity;
    }
    if (f.default !== undefined && !same(f.default, field.default_value)) patch.default = f.default;
    if (f.validation !== undefined && !same(f.validation ?? {}, field.validation ?? {})) patch.validation = f.validation;
    if (f.values !== undefined && !same(valuesOf(f.values), valuesOf(field.options.values))) patch.values = f.values;
    if (f.max !== undefined && (field.type !== "rating" || f.max !== ratingMax(field))) patch.max = f.max;
    if (f.shape !== undefined && !same(f.shape, field.options.shape ?? null)) patch.shape = f.shape;
    if (f.type !== field.type) {
      if (!field.is_system && SAFE_RETYPES[field.type] === f.type) retypes.push({ name: f.name, field, type: f.type, path });
      else unsupported(`${path}.type`, `Cannot change ${field.type} to ${f.type}. Safe changes are ${Object.entries(SAFE_RETYPES).map(([a, b]) => `${a} → ${b}`).join(", ")} `
        + "on custom fields; for anything else add a new field");
    }
    if (f.unique !== undefined && f.unique !== field.is_unique) unsupported(`${path}.unique`, "Uniqueness is set when a field is created and cannot change");
    if (f.relation && (f.relation.to !== field.options.to || (f.relation.cardinality ?? "many_to_one") !== (field.options.cardinality ?? "many_to_one"))) {
      unsupported(`${path}.relation`, "A relation's target and cardinality cannot change; add a new field instead");
    }
    if (f.initial !== undefined && f.initial !== field.options.initial) unsupported(`${path}.initial`, "A status field's initial value cannot change yet");
    if (f.transitions !== undefined && !same(f.transitions, field.options.transitions ?? {})) {
      unsupported(`${path}.transitions`, "Status transitions cannot change yet");
    }
    if (Object.keys(patch).length) updates.push({ field, patch, path });
  }

  // Renames and updates first (a new field may take a name another one is giving up), then retypes, archives and adds.
  for (const u of updates) {
    pushAll(run, (await at(u.path, () => updateField(tx, ctx, obj.api_name, u.field.api_name, u.patch, false))).changes);
    run.touched.add(`field:${u.field.id}`);
  }
  for (const r of retypes) {
    const token = confirmToken(ctx, (await loadSchema(tx)).version, "retype_field", obj.api_name, r.name, r.type);
    const res = await at(r.path, () => retypeField(tx, ctx, obj.api_name, r.name, r.type, { dryRun: false, confirm: token }));
    pushAll(run, res.changes, TYPE_INFO[r.field.type].retype?.rewrite ?? true);
    run.touched.add(`field:${r.field.id}`);
  }
  for (const f of o.fields ? obj.fields : []) {
    if (f.is_system || claimed.has(f.id)) continue;
    const path = `${opath}.fields.${f.api_name}`;
    if (!opts.prune) {
      run.notes.push(`${path}: in the workspace but not in the document; kept (prune would archive it)`);
      continue;
    }
    const token = confirmToken(ctx, (await loadSchema(tx)).version, "archive_field", obj.api_name, f.api_name);
    pushAll(run, (await at(path, () => archiveField(tx, ctx, obj.api_name, f.api_name, { dryRun: false, confirm: token }))).changes, true);
    run.touched.add(`field:${f.id}`);
  }
  for (const a of adds) {
    run.added.add(names.field(obj.api_name, a.f.name));
    pushAll(run, (await at(a.path, () => addField(tx, ctx, obj.api_name, fieldInput(a.f), false))).changes);
  }
}

async function runPipelines(tx: Tx, ctx: Ctx, run: Run, doc: SchemaDoc, opts: { prune: boolean }): Promise<void> {
  if (!doc.pipelines) return;
  const existing = await listPipelines(tx);
  const claimed = new Set<string>();
  for (const p of doc.pipelines) {
    const path = `pipelines.${p.name}`;
    const pipe = resolve(run, path, p.id, "pipe", claimed, (id) => existing.find((x) => x.id === id), () => existing.find((x) => x.name === p.name), true);
    if (!pipe) {
      const stages = p.stages.map((s) => ({ name: s.name, category: s.category, probability: s.probability ?? undefined }));
      await at(path, () => createPipeline(tx, ctx, { name: p.name, is_default: p.is_default, stages }, false));
      run.added.add(names.pipeline(p.name));
      pushAll(run, [{ change: "pipeline_created", object: "pipeline", after: { name: p.name, is_default: p.is_default ?? false, stages: p.stages.map((s) => s.name) } }]);
      continue;
    }
    const touch = (changes: Change[]) => {
      pushAll(run, changes);
      if (changes.length) run.touched.add(`pipeline:${pipe.id}`);
    };
    if (p.name !== pipe.name) run.added.add(names.pipeline(p.name));
    touch(await at(path, () => updatePipeline(tx, ctx, pipe.id, { name: p.name, ...(p.is_default ? { is_default: true } : {}) })));
    const claimedStages = new Set<string>();
    const order: string[] = [];
    for (const s of p.stages) {
      const spath = `${path}.stages.${s.name}`;
      const stage = resolve(run, spath, s.id, "stg", claimedStages, (id) => pipe.stages.find((x) => x.id === id),
        () => pipe.stages.find((x) => x.name.toLowerCase() === s.name.toLowerCase()), true);
      if (!stage || s.name.toLowerCase() !== stage.name.toLowerCase()) run.added.add(names.stage(pipe.id, s.name));
      if (!stage) {
        const added = await at(spath, () => addStage(tx, ctx, pipe.id, { name: s.name, category: s.category, probability: s.probability ?? undefined }));
        touch(added);
        order.push((added[0]!.after as { stage: string }).stage);
        continue;
      }
      if (s.category !== undefined && s.category !== stage.category) {
        run.unsupported.push({ path: `${spath}.category`, message: "A stage's category cannot change: deals in it depend on it. Add a new stage instead" });
      }
      touch(await at(spath, () => updateStage(tx, ctx, stage.id, { name: s.name, ...(s.probability !== undefined ? { probability: s.probability } : {}) })));
      order.push(stage.id);
    }
    for (const s of pipe.stages) {
      if (claimedStages.has(s.id)) continue;
      order.push(s.id);
      if (opts.prune) run.unsupported.push({ path: `${path}.stages.${s.name}`, message: "Schema apply does not remove stages" });
      else run.notes.push(`${path}.stages.${s.name}: in the workspace but not in the document; kept at the end of the pipeline`);
    }
    touch(await at(`${path}.stages`, () => reorderStages(tx, ctx, pipe.id, order)));
  }
  for (const p of existing) {
    if (claimed.has(p.id)) continue;
    if (opts.prune) run.unsupported.push({ path: `pipelines.${p.name}`, message: "Schema apply does not remove pipelines" });
    else run.notes.push(`pipelines.${p.name}: in the workspace but not in the document; left as it is`);
  }
}

/**
 * Runs a document in the caller's transaction, without pruning, for schema packs (core/packs.ts): the same
 * name checks and schema functions as apply. The caller holds the schema lock and decides about drift.
 */
export async function runSchemaDocument(tx: Tx, ctx: Ctx, doc: SchemaDoc, check: () => void): Promise<Pick<Run, "changes" | "unsupported" | "notes">> {
  checkNames(doc);
  const run = await runDocument(tx, ctx, doc, { prune: false, check });
  return { changes: run.changes, unsupported: run.unsupported, notes: run.notes };
}

// ---------------------------------------------------------------------------------------------
// Drift, plan and apply

const DRIFT_LIMIT = 500;


/** The names a schema change touched, before and after, as Run.added keys them. */
function namesOf(r: DriftRow): string[] {
  const str = (v: unknown) => (typeof v === "string" ? [v] : []);
  const pipeline = typeof r.after?.pipeline === "string" ? r.after.pipeline : null;
  if (r.field_id && r.object_name) {
    return [r.field_name, ...str(r.before?.api_name), ...str(r.after?.api_name)].filter((n): n is string => n !== null).map((f) => names.field(r.object_name!, f));
  }
  if (r.object_name) return [names.object(r.object_name)];
  const named = [...str(r.before?.name), ...str(r.after?.name)];
  if (r.change_type.startsWith("pipeline_")) return named.map(names.pipeline);
  if (r.change_type.startsWith("stage_") && pipeline) return named.map((n) => names.stage(pipeline, n));
  return [];
}

async function driftSince(tx: Tx, since: number, run: Pick<Run, "touched" | "added">): Promise<{ entries: DriftEntry[]; truncated: boolean }> {
  const rows = await schemaChangesSince(tx, since, DRIFT_LIMIT + 1);
  const entries = rows.slice(0, DRIFT_LIMIT).map((r) => {
    const pipeline = typeof r.after?.pipeline === "string" ? r.after.pipeline : null;
    // By ID: this run changes what was changed. By name: it adds (or renames to) a name that was archived, renamed or created.
    const conflicts = (r.field_id ? run.touched.has(`field:${r.field_id}`)
      : r.object_id ? run.touched.has(`object:${r.object_id}`)
      : pipeline ? run.touched.has(`pipeline:${pipeline}`)
      : r.change_type === "modules_updated" && run.touched.has("modules"))
      || namesOf(r).some((n) => run.added.has(n));
    return {
      version: Number(r.version), changed_at: r.changed_at.toISOString(), change: r.change_type,
      object: r.object_name ?? (pipeline ? "pipeline" : r.change_type === "modules_updated" ? "workspace" : null), field: r.field_name,
      actor: actorRef(r.actor_type, r.actor_id) ?? r.actor_type, surface: r.surface, conflicts,
    };
  });
  // Past the limit we cannot say what drifted, so assume the worst.
  return { entries, truncated: rows.length > DRIFT_LIMIT };
}

class Rollback extends Error {
  constructor(readonly run: Run) {
    super("rollback");
  }
}

/** Runs the document for real inside a savepoint, then rolls it back: the plan is exactly what apply would do. */
async function dryRun(tx: Tx, ctx: Ctx, doc: SchemaDoc, opts: { prune: boolean; check: () => void }): Promise<Run> {
  try {
    await tx.savepoint(async (sp) => {
      throw new Rollback(await runDocument(sp as unknown as Tx, ctx, doc, opts));
    });
    throw new Error("unreachable");
  } catch (e) {
    if (e instanceof Rollback) return e.run;
    throw e;
  }
}

const budget = () => deadline(WORK_BUDGET_MS.schema, "Running the schema document");

export async function planSchema(
  tx: Tx, ctx: Ctx, doc: SchemaDoc, opts: { prune?: boolean; since?: number; check?: () => void } = {},
): Promise<Plan> {
  checkNames(doc);
  // Locked before the version is read, so the drift below is measured against the schema the dry run (and apply) sees.
  await lockSchema(tx);
  const version = (await loadSchema(tx)).version;
  const run = await dryRun(tx, ctx, doc, { prune: opts.prune ?? false, check: opts.check ?? budget() });
  const since = opts.since ?? doc.schema_version;
  // A version this workspace hasn't reached: the document came from elsewhere, so what changed here can't be told; assume the worst.
  const ahead = since !== undefined && since > version;
  if (ahead) {
    run.notes.push(`The document's schema_version (${since}) is newer than this workspace's (${version}): it was not pulled from this workspace, `
      + "so changes made here can't be told apart from the document's; treat them all as drift");
  }
  const drift = ahead ? { entries: [], truncated: true }
    : since !== undefined && since < version ? await driftSince(tx, since, run) : { entries: [], truncated: false };
  return {
    schema_version: version, document_version: since ?? null, changes: run.changes, unsupported: run.unsupported, notes: run.notes,
    matched_by_name: run.matched_by_name, drift: drift.entries, ...(drift.truncated ? { drift_truncated: true } : {}),
  };
}

export interface ApplyOptions { ifMatch?: number; acceptDrift?: boolean; prune?: boolean; confirmDataChanges?: boolean }

export async function applySchema(tx: Tx, ctx: Ctx, doc: SchemaDoc, opts: ApplyOptions) {
  await lockSchema(tx);
  const current = (await loadSchema(tx)).version;
  if (opts.ifMatch !== undefined && opts.ifMatch > current) {
    throw new ApiError(412, "schema_version_ahead", `If-Match names schema version ${opts.ifMatch}, but this workspace is at ${current}: `
      + "the document was not pulled from this workspace. Pull it again, or apply without If-Match and with accept_drift: true");
  }
  const check = budget();
  const plan = await planSchema(tx, ctx, doc, { prune: opts.prune, since: opts.ifMatch, check });
  if (plan.unsupported.length) {
    throw new ApiError(422, "schema_unsupported", `The document asks for ${plan.unsupported.length} change(s) schema apply cannot make; see errors`, plan.unsupported);
  }
  if (plan.changes.length === 0) return { applied: false, ...plan };
  if (opts.ifMatch === undefined && !opts.acceptDrift) {
    throw new ApiError(428, "if_match_required", "Send If-Match with the schema_version your document was exported at, or accept_drift: true");
  }
  const conflicts = plan.drift.filter((d) => d.conflicts);
  if ((conflicts.length || plan.drift_truncated) && !opts.acceptDrift) {
    throw new ApiError(412, "schema_drift", `The schema changed since version ${opts.ifMatch} in ways this document would overwrite `
      + `(${plan.drift_truncated ? "too many changes to list" : `${conflicts.length} change(s)`}). Pull it again, or apply with accept_drift: true to overwrite them`, conflicts);
  }
  const affecting = plan.changes.filter((c) => c.data_affecting);
  if (affecting.length && !opts.confirmDataChanges) {
    throw new ApiError(409, "confirmation_required", `${affecting.length} change(s) archive fields or convert stored values; `
      + "apply with confirm_data_changes: true", affecting);
  }
  const run = await runDocument(tx, ctx, doc, { prune: opts.prune ?? false, check });
  const version = (await loadSchema(tx)).version;
  await audit(tx, ctx, { action: "schema.applied", objectType: "workspace", details: {
    from_version: plan.schema_version, to_version: version, changes: run.changes.length, prune: opts.prune ?? false,
    accept_drift: opts.acceptDrift ?? false, drift_overwritten: opts.acceptDrift ? conflicts.length : 0,
  } });
  return { applied: true, ...plan, schema_version: version, changes: run.changes, notes: run.notes };
}
