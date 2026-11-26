import { randomBytes } from "node:crypto";
import { assertSchemaRoom } from "./limits.js";
import type { Tx } from "../db/pool.js";
import { txState } from "../db/tx.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { hmac } from "../lib/crypto.js";
import { ID_PREFIX_PATTERN, uuidv7 } from "../lib/ids.js";
import { pluralize } from "../lib/plural.js";
import { masterKey } from "../config.js";
import { audit } from "./audit.js";
import {
  CATALOG, ENTITIES, isEntity, OWNER_FIELD,
  type CatalogObject, type FieldOptions, type FieldType, type JsonShape, type Sensitivity,
} from "./catalog.js";
import type { Ctx } from "./context.js";
import { emit } from "./events.js";
import { ADDRESS_PART_NAMES, FIELD_TYPES, fieldRulesProblem, isFieldType, PERCENT, ratingMax, TYPE_INFO } from "./fieldtypes.js";
import {
  archivedObjectNames, archiveFieldRow, bumpSchemaVersion, countFieldsEver, countLinkingRecords, insertCustomField, insertCustomObject, insertSchemaChange,
  insertStandardField, insertStandardObject, liveFields, liveObjects, lockWorkspaceSchema, retypeFieldRow, schemaHead, setWorkspaceModules, updateFieldRow,
  updateObjectRow, viewsOfObject,
} from "./queries/schema.js";

export interface FieldMeta {
  id: string;
  object_id: string;
  api_name: string;
  storage_key: string;
  label: string;
  description: string;
  type: FieldType;
  is_system: boolean;
  column_name: string | null;
  read_only: boolean;
  create_only: boolean;
  required: boolean;
  is_unique: boolean;
  default_value: unknown;
  validation: { min?: number; max?: number; max_length?: number; pattern?: string };
  options: FieldOptions & { transitions?: Record<string, string[]> };
  sensitivity: Sensitivity;
  hidden: boolean;
  position: number;
}

export interface ObjectMeta {
  id: string;
  api_name: string;
  label: string;
  plural_label: string;
  description: string;
  id_prefix: string;
  module: string | null;
  is_system: boolean;
  table_name: string | null;
  display_field: string | null;
  owned: boolean;
  hidden: boolean;
  fields: FieldMeta[];
  byName: Map<string, FieldMeta>;
}

export interface Schema {
  version: number;
  /** The cache key: changes whenever the schema does and is never reused (migration 009). */
  token: string;
  currency: string;
  modules: string[];
  objects: Map<string, ObjectMeta>;
  byPrefix: Map<string, ObjectMeta>;
  byId: Map<string, ObjectMeta>;
}

const MODULES = ["core", "sales", "commerce"] as const;
/** Names that collide with Object.prototype members; lookups keyed by them misbehave in plain objects. */
const PROTOTYPE_NAMES = ["constructor", "prototype", "__proto__", "tostring", "valueof", "hasownproperty", "isprototypeof",
  "propertyisenumerable", "tolocalestring", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"];
const RESERVED_NAMES = new Set([
  ...Object.keys(ENTITIES), ...PROTOTYPE_NAMES, "record", "records", "object", "objects", "field", "fields", "schema", "workspace",
  "member", "api_key", "audit", "event", "query", "search", "me", "ops",
  "product", "price", "price_book", "quote", "quote_line_item", "order", "order_line_item", "contract", "entitlement", "payment_schedule", "invoice", "payment",
]);
const RESERVED_FIELD_NAMES = new Set(["id", "object", "created_at", "updated_at", "created_by", "updated_by", "version",
  "archived_at", "external_ids", "related_to", "display_name", "included", "merged_into", "merge_chain", ...PROTOTYPE_NAMES]);
/** One object's fields. How many custom objects and custom fields a workspace may have in all is a workspace limit (core/limits.ts). */
export const MAX_FIELDS = 300;
/** The types an object's display_field can be: a record's name is one line of text. */
const DISPLAY_TYPES: readonly FieldType[] = ["text", "email", "phone", "url"];
/** Archived fields stay in metadata, so archive-and-re-add cannot grow it without bound. */
const MAX_FIELDS_EVER = 500;
const RESERVED_PREFIXES = new Set([...CATALOG.map((o) => o.id_prefix), ...Object.values(ENTITIES).map((e) => e.prefix),
  "prod", "price", "quote", "ord", "ctr", "ent", "psch", "inv", "pay", "qli", "oli", "cli", "sitm", "ili", "palloc", "fld", "obj",
  "evt", "whk", "dlv", "auto", "run", "key", "usr", "svc", "alr", "ntf", "ws", "file", "role", "pset"]);

/** Per-process cache, one schema per workspace, keyed by schema_token (migration 009): a value never reused, even after a rollback. */
const cache = new Map<string, Schema>();

/** For tests: the schema_token this process holds in its shared cache for a workspace. */
export const cachedSchemaToken = (tenantId: string): string | undefined => cache.get(tenantId)?.token;

/**
 * Serialises schema changes in a workspace. Every schema writer, and schema plan and apply, takes
 * this lock before it reads the schema, so what it checked still holds when it writes, and a change
 * committed meanwhile is seen rather than overwritten. NO KEY UPDATE, like the schema_version bump
 * every change makes anyway, so foreign-key checks on the row are not blocked.
 */
export async function lockSchema(tx: Tx): Promise<void> {
  await lockWorkspaceSchema(tx);
}

/**
 * Loads the tenant's metadata, cached per schema_token. A schema this transaction changed is not
 * committed yet, so it is kept with the transaction (txState), never in the shared cache.
 */
export async function loadSchema(tx: Tx): Promise<Schema> {
  const t = await schemaHead(tx);
  if (!t) throw notFound("Workspace");
  const version = Number(t.schema_version);
  const own = txState()?.ownSchemas;
  const mine = own?.has(t.schema_token) ?? false;
  const hit = mine ? own!.get(t.schema_token) as Schema | undefined : cache.get(t.tenant_id);
  if (hit && hit.token === t.schema_token) return hit;

  const objects = await liveObjects(tx);
  const fields = await liveFields(tx);

  const schema: Schema = { version, token: t.schema_token, currency: t.currency, modules: t.modules, objects: new Map(), byPrefix: new Map(), byId: new Map() };
  for (const o of objects) {
    const meta: ObjectMeta = { ...o, fields: [], byName: new Map() };
    schema.objects.set(o.api_name, meta);
    schema.byPrefix.set(o.id_prefix, meta);
    schema.byId.set(o.id, meta);
  }
  for (const f of fields) {
    const obj = schema.byId.get(f.object_id);
    if (!obj) continue;
    const meta: FieldMeta = { ...f, create_only: Boolean((f.options as { create_only?: boolean }).create_only) };
    obj.fields.push(meta);
    obj.byName.set(f.api_name, meta);
  }
  if (mine) own!.set(t.schema_token, schema);
  else cache.set(t.tenant_id, schema);
  return schema;
}

/** Finds an object the caller may use: it must exist, and its module must be on. */
export function getObject(schema: Schema, apiName: string): ObjectMeta {
  const obj = schema.objects.get(apiName);
  if (!obj) throw notFound(`Object "${apiName}"`);
  if (obj.module && !schema.modules.includes(obj.module)) {
    throw notFound(`Object "${apiName}" (its module "${obj.module}" is turned off)`);
  }
  return obj;
}

export const isModuleOn = (schema: Schema, obj: ObjectMeta) => !obj.module || schema.modules.includes(obj.module);

/** Seeds the standard objects into a new workspace. */
export async function seedStandardObjects(tx: Tx, tenantId: string, objects: readonly CatalogObject[] = CATALOG): Promise<void> {
  for (const o of objects) {
    const objectId = uuidv7();
    await insertStandardObject(tx, { tenantId, id: objectId, apiName: o.api_name, label: o.label, pluralLabel: o.plural_label, description: o.description,
      idPrefix: o.id_prefix, module: o.module, table: o.table, owned: o.owned });
    let position = 0;
    for (const f of o.fields) {
      const options = { ...(f.options ?? {}), ...(f.create_only ? { create_only: true } : {}) };
      await insertStandardField(tx, { tenantId, id: uuidv7(), objectId, apiName: f.api_name, storageKey: `sys_${f.column}`, label: f.label,
        description: f.description ?? "", type: f.type, column: f.column, readOnly: f.read_only ?? false, required: f.required ?? false, options,
        sensitivity: f.sensitivity ?? "standard", position: position++ });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema changes (admin surfaces). Every change supports dry-run and is versioned in schema_changes.

export interface FieldInput {
  api_name: string;
  label?: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  unique?: boolean;
  default?: unknown;
  sensitivity?: Sensitivity;
  hidden?: boolean;
  options?: FieldOptions & { transitions?: Record<string, string[]> };
  validation?: FieldMeta["validation"];
}

export interface ObjectInput {
  api_name: string;
  label?: string;
  plural_label?: string;
  description?: string;
  id_prefix?: string;
  display_field?: string;
  owned?: boolean;
  fields?: FieldInput[];
}

export interface Change {
  change: string;
  object: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  warning?: string;
}

export interface ChangeResult {
  dry_run: boolean;
  schema_version: number;
  changes: Change[];
  /** Present on dry runs of destructive changes; pass it back to apply. */
  confirm_token?: string;
}

const titleCase = (s: string) => s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** Labels and descriptions are free text that every schema read returns, so they are bounded. */
function checkText(what: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(what)) {
    if (v === undefined || v === null) continue;
    const max = k.includes("description") ? 2_000 : 200;
    if (typeof v !== "string" || v.length > max) throw unprocessable(`${k} must be text of at most ${max} characters`);
  }
}

function validateFieldInput(schema: Schema, input: FieldInput, existing: ObjectMeta | null): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(input.api_name)) {
    throw unprocessable(`Field name "${input.api_name}" must be lowercase letters, digits and underscores, starting with a letter`);
  }
  if (RESERVED_FIELD_NAMES.has(input.api_name)) throw unprocessable(`Field name "${input.api_name}" is reserved`);
  if (existing?.byName.has(input.api_name)) throw conflict(`Field "${input.api_name}" already exists on ${existing.api_name}`);
  if (!isFieldType(input.type)) throw unprocessable(`Unknown field type "${String(input.type).slice(0, 40)}". Use one of: ${FIELD_TYPES.join(", ")}`);
  checkText({ label: input.label, description: input.description });
  const opts = input.options ?? {};
  if (["single_select", "multi_select", "status"].includes(input.type)) {
    if (!opts.values?.length) throw unprocessable(`Field "${input.api_name}" needs options.values`);
    const keys = new Set<string>();
    for (const v of opts.values) {
      checkText({ "option label": v.label });
      if (!/^[a-z0-9][a-z0-9_]{0,62}$/.test(v.key)) throw unprocessable(`Option key "${v.key}" must be lowercase letters, digits and underscores`);
      if (keys.has(v.key)) throw unprocessable(`Option key "${v.key}" is repeated`);
      keys.add(v.key);
    }
    if (input.type === "status" && opts.initial && !keys.has(opts.initial)) throw unprocessable(`Initial status "${opts.initial}" is not one of the values`);
  }
  if (input.type === "relation") {
    if (!opts.to) throw unprocessable(`Relation field "${input.api_name}" needs options.to (an object api_name or "user")`);
    if (opts.to !== "user" && !schema.objects.has(opts.to) && opts.to !== existing?.api_name) {
      throw unprocessable(`Relation target "${opts.to}" is not an object in this workspace`);
    }
    if (opts.to === "pipeline" || opts.to === "stage") throw unprocessable("Relations to pipelines or stages are not supported");
  }
  if (input.unique && !TYPE_INFO[input.type].unique) {
    throw unprocessable(`Only ${FIELD_TYPES.filter((t) => TYPE_INFO[t].unique).join(", ")} fields can be unique`);
  }
  if (input.sensitivity === "restricted" && (input.unique || input.type === "relation")) {
    throw unprocessable("Restricted fields are encrypted, so they cannot be unique or relations");
  }
  if (opts.transitions !== undefined) {
    if (input.type !== "status") throw unprocessable("options.transitions only applies to status fields");
    const keys = new Set((opts.values ?? []).map((v) => v.key));
    if (typeof opts.transitions !== "object" || opts.transitions === null || Array.isArray(opts.transitions)) {
      throw unprocessable("options.transitions maps each status to the statuses it can move to");
    }
    for (const [from, to] of Object.entries(opts.transitions)) {
      if (!keys.has(from) || !Array.isArray(to) || to.some((t) => typeof t !== "string" || !keys.has(t))) {
        throw unprocessable(`options.transitions.${from} must list statuses of this field`);
      }
    }
  }
  const problem = fieldRulesProblem({ api_name: input.api_name, type: input.type, options: opts, validation: input.validation ?? {} }, input.default);
  if (problem) throw unprocessable(`Field "${input.api_name}": ${problem}`);
}

function newPrefix(schema: Schema, apiName: string, requested?: string, archived: Set<string> = new Set()): string {
  const taken = (p: string) => schema.byPrefix.has(p) || RESERVED_PREFIXES.has(p) || archived.has(p);
  if (requested) {
    if (!ID_PREFIX_PATTERN.test(requested)) throw unprocessable("id_prefix must be 2 to 8 lowercase letters");
    if (taken(requested)) throw conflict(`id_prefix "${requested}" is already used`);
    return requested;
  }
  const letters = apiName.replace(/[^a-z]/g, "");
  for (let len = 4; len <= 8; len++) {
    const p = letters.slice(0, len).padEnd(2, "x");
    if (p.length >= 2 && !taken(p)) return p;
  }
  for (let i = 0; i < 100; i++) {
    const p = `${letters.slice(0, 3)}${String.fromCharCode(97 + (i % 26))}`.slice(0, 8);
    if (!taken(p)) return p;
  }
  throw conflict("Could not choose an id_prefix; pass one explicitly");
}

/** Bumps the schema version and logs the change (schema_changes, audit, event). Every schema write goes through here. */
export async function recordChange(tx: Tx, ctx: Ctx, change: Change & { object_id?: string; field_id?: string }): Promise<number> {
  const row = await bumpSchemaVersion(tx);
  const version = Number(row.schema_version);
  txState()?.ownSchemas.set(row.schema_token, undefined);
  await insertSchemaChange(tx, { tenantId: ctx.tenantId, version, actorType: ctx.actor.type, actorId: ctx.actor.id, surface: ctx.surface, change: change.change,
    objectId: change.object_id ?? null, fieldId: change.field_id ?? null, before: change.before, after: change.after });
  await audit(tx, ctx, { action: `schema.${change.change}`, objectType: change.object, details: { field: change.field, version } });
  await emit(tx, ctx, { type: `schema.${change.change}`, objectType: change.object, data: { field: change.field, version } });
  return version;
}

async function insertField(tx: Tx, ctx: Ctx, obj: { id: string }, input: FieldInput, position: number): Promise<string> {
  const id = uuidv7();
  const storageKey = `f_${randomBytes(5).toString("hex")}`;
  await insertCustomField(tx, { tenantId: ctx.tenantId, id, objectId: obj.id, apiName: input.api_name, storageKey, label: input.label ?? titleCase(input.api_name),
    description: input.description ?? "", type: input.type, required: input.required ?? false, unique: input.unique ?? false,
    defaultValue: input.default, validation: input.validation ?? {}, options: input.options ?? {},
    sensitivity: input.sensitivity ?? "standard", hidden: input.hidden ?? false, position, createdBy: ctx.actor.id });
  return id;
}

function fieldSummary(f: FieldInput | FieldMeta) {
  return {
    api_name: f.api_name, type: f.type, required: f.required ?? false,
    sensitivity: f.sensitivity ?? "standard", options: f.options ?? {},
  };
}

export async function createObject(tx: Tx, ctx: Ctx, input: ObjectInput, dryRun: boolean): Promise<ChangeResult> {
  if (!dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(input.api_name)) {
    throw unprocessable("api_name must be 2 to 63 lowercase letters, digits and underscores, starting with a letter");
  }
  if (schema.objects.has(input.api_name)) throw conflict(`Object "${input.api_name}" already exists`);
  if (RESERVED_NAMES.has(input.api_name)) throw unprocessable(`"${input.api_name}" is reserved`);
  // An archived object (from an uninstalled schema pack) keeps its name and ID prefix, so reinstalling the pack restores it.
  const archived = await archivedObjectNames(tx);
  if (archived.some((a) => a.api_name === input.api_name)) throw conflict(`Object "${input.api_name}" exists, archived (an uninstalled pack's object); choose another name`);
  checkText({ label: input.label, plural_label: input.plural_label, description: input.description });
  await assertSchemaRoom(tx, schema, { objects: 1, fields: (input.fields ?? []).length });
  const prefix = newPrefix(schema, input.api_name, input.id_prefix, new Set(archived.map((a) => a.id_prefix)));
  const draft: ObjectMeta = {
    id: "", api_name: input.api_name, label: input.label ?? titleCase(input.api_name),
    // The one place a default plural is made; an explicit plural_label always wins, and stored labels never change here.
    plural_label: input.plural_label ?? pluralize(input.label ?? titleCase(input.api_name)), description: input.description ?? "",
    id_prefix: prefix, module: null, is_system: false, table_name: null, display_field: null,
    owned: input.owned ?? false, hidden: false, fields: [], byName: new Map(),
  };
  // An owned object has an owner field of its own (below). A document that lists it (an export does) may relabel and place it, nothing else.
  const ownerInput = draft.owned ? (input.fields ?? []).find((f) => f.api_name === OWNER_FIELD.api_name) : undefined;
  if (ownerInput && (ownerInput.type !== "relation" || ownerInput.options?.to !== "user" || (ownerInput.options.cardinality ?? "many_to_one") !== "many_to_one")) {
    throw unprocessable(`An owned object already has an "${OWNER_FIELD.api_name}" field (the member who owns the record); give this field another name`);
  }
  checkText({ label: ownerInput?.label, description: ownerInput?.description });
  const ownerField = { api_name: OWNER_FIELD.api_name, type: OWNER_FIELD.type, label: ownerInput?.label ?? OWNER_FIELD.label,
    description: ownerInput?.description ?? OWNER_FIELD.description ?? "", options: OWNER_FIELD.options ?? {} };
  const fields = (input.fields ?? []).filter((f) => f !== ownerInput);
  // Where the owner goes among the fields: where the document lists it, otherwise last.
  const ownerAt = !draft.owned ? -1 : ownerInput ? input.fields!.indexOf(ownerInput) : fields.length;
  if (fields.length > 200) throw unprocessable("An object can have at most 200 fields");
  for (const f of fields) {
    validateFieldInput(schema, f, draft);
    draft.byName.set(f.api_name, f as unknown as FieldMeta);
  }
  const displayField = input.display_field ?? fields.find((f) => f.type === "text")?.api_name ?? null;
  if (displayField && !draft.byName.has(displayField)) throw unprocessable(`display_field "${displayField}" is not one of the fields`);
  // A record's name is text, chosen from the same types as updateObject allows.
  if (displayField && !DISPLAY_TYPES.includes(draft.byName.get(displayField)!.type)) {
    throw unprocessable(`display_field "${displayField}" must be a text-like field (${DISPLAY_TYPES.join(", ")})`);
  }

  const changes: Change[] = [
    { change: "object_created", object: input.api_name, after: { label: draft.label, id_prefix: prefix, display_field: displayField, owned: draft.owned } },
    ...fields.map((f) => ({ change: "field_added", object: input.api_name, field: f.api_name, after: fieldSummary(f) })),
  ];
  if (draft.owned) changes.splice(1 + ownerAt, 0, { change: "field_added", object: input.api_name, field: ownerField.api_name, after: fieldSummary(ownerField) });
  if (dryRun) return { dry_run: true, schema_version: schema.version, changes };

  const objectId = uuidv7();
  await insertCustomObject(tx, { tenantId: ctx.tenantId, id: objectId, apiName: input.api_name, label: draft.label, pluralLabel: draft.plural_label,
    description: draft.description, idPrefix: prefix, displayField, owned: draft.owned, createdBy: ctx.actor.id });
  let version = await recordChange(tx, ctx, { ...changes[0]!, object_id: objectId });
  // The fields in the order of `changes`, the owner among them.
  const ordered: (FieldInput | null)[] = [...fields];
  if (draft.owned) ordered.splice(ownerAt, 0, null);
  for (const [position, f] of ordered.entries()) {
    let fieldId: string;
    if (f) fieldId = await insertField(tx, ctx, { id: objectId }, f, position);
    else {
      // Kept in records.owner_id, as a standard object's owner is in its table's owner_id: the same field to set, filter and show.
      fieldId = uuidv7();
      await insertStandardField(tx, { tenantId: ctx.tenantId, id: fieldId, objectId, apiName: ownerField.api_name, storageKey: `sys_${OWNER_FIELD.column}`,
        label: ownerField.label, description: ownerField.description, type: ownerField.type, column: OWNER_FIELD.column, readOnly: false, required: false,
        options: ownerField.options, sensitivity: "standard", position });
    }
    version = await recordChange(tx, ctx, { ...changes[1 + position]!, object_id: objectId, field_id: fieldId });
  }
  return { dry_run: false, schema_version: version, changes };
}

export async function addField(tx: Tx, ctx: Ctx, objectName: string, input: FieldInput, dryRun: boolean): Promise<ChangeResult> {
  if (!dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  validateFieldInput(schema, input, obj);
  if (obj.fields.length >= MAX_FIELDS) throw unprocessable(`An object can have at most ${MAX_FIELDS} fields`);
  await assertSchemaRoom(tx, schema, { fields: 1 });
  if ((await countFieldsEver(tx, obj.id)) >= MAX_FIELDS_EVER) throw unprocessable(`This object has reached ${MAX_FIELDS_EVER} fields, archived ones included`);
  const change: Change = { change: "field_added", object: obj.api_name, field: input.api_name, after: fieldSummary(input) };
  if (input.required) change.warning = "Existing records have no value for this field; it is enforced on new and updated records.";
  if (dryRun) return { dry_run: true, schema_version: schema.version, changes: [change] };
  const fieldId = await insertField(tx, ctx, obj, input, obj.fields.length);
  const version = await recordChange(tx, ctx, { ...change, object_id: obj.id, field_id: fieldId });
  return { dry_run: false, schema_version: version, changes: [change] };
}

export interface FieldPatch {
  api_name?: string;
  label?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  sensitivity?: Sensitivity;
  default?: unknown;
  validation?: FieldMeta["validation"];
  /** Picklist or status values. Existing keys must be kept; new keys may be added and labels changed. */
  values?: { key: string; label: string; category?: string }[];
  /** rating: a higher maximum (stored ratings stay valid, so it can't go down). */
  max?: number;
  /** json: a new shape check for new writes, or null to remove it. */
  shape?: JsonShape | null;
}

export async function updateField(tx: Tx, ctx: Ctx, objectName: string, fieldName: string, patch: FieldPatch, dryRun: boolean): Promise<ChangeResult> {
  if (!dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const field = obj.byName.get(fieldName);
  if (!field) throw notFound(`Field "${fieldName}" on ${objectName}`);
  checkText({ label: patch.label, description: patch.description });
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const warnings: string[] = [];

  if (patch.api_name !== undefined && patch.api_name !== field.api_name) {
    if (field.is_system) throw forbidden("Standard fields can be relabeled but not renamed; change the label instead");
    validateFieldInput(schema, { api_name: patch.api_name, type: field.type, options: field.options }, obj);
    before.api_name = field.api_name;
    after.api_name = patch.api_name;
    warnings.push(`Clients that use the name "${field.api_name}" must switch to "${patch.api_name}".`);
  }
  for (const key of ["label", "description", "hidden"] as const) {
    if (patch[key] !== undefined && patch[key] !== field[key]) {
      before[key] = field[key];
      after[key] = patch[key];
    }
  }
  if (patch.required !== undefined && patch.required !== field.required) {
    if (field.is_system && field.required && !patch.required) throw forbidden(`"${fieldName}" is required by the platform`);
    if (field.read_only) throw forbidden(`"${fieldName}" is read-only`);
    before.required = field.required;
    after.required = patch.required;
    if (patch.required) warnings.push("Existing records without a value are not changed; the rule applies to new and updated records.");
  }
  if (patch.sensitivity !== undefined && patch.sensitivity !== field.sensitivity) {
    const rank = { standard: 0, confidential: 1, restricted: 2 } as const;
    if (patch.sensitivity === "restricted" || field.sensitivity === "restricted") {
      throw forbidden("Changing a field to or from restricted is not supported; create a new restricted field instead");
    }
    if (field.is_system && rank[patch.sensitivity] < rank[field.sensitivity]) {
      throw forbidden("The sensitivity of a standard field can be raised but not lowered");
    }
    before.sensitivity = field.sensitivity;
    after.sensitivity = patch.sensitivity;
  }
  if (patch.default !== undefined) {
    before.default = field.default_value;
    after.default = patch.default;
  }
  if (patch.validation !== undefined) {
    before.validation = field.validation;
    after.validation = patch.validation;
  }
  if (patch.default !== undefined || patch.validation !== undefined) {
    // Check the rules and the default together, as they will be stored.
    const problem = fieldRulesProblem({ ...field, validation: patch.validation ?? field.validation ?? {} },
      patch.default !== undefined ? patch.default : field.default_value);
    if (problem) throw unprocessable(`Field "${field.api_name}": ${problem}`);
  }
  let newOptions = field.options;
  if (patch.values !== undefined) {
    if (!["single_select", "multi_select", "status"].includes(field.type) || field.column_name === "type_key") {
      throw unprocessable(`"${fieldName}" has no editable values`);
    }
    const old = field.options.values ?? [];
    const missing = old.filter((o) => !patch.values!.some((n) => n.key === o.key));
    if (missing.length) throw unprocessable(`Values cannot be removed (records may use them): ${missing.map((m) => m.key).join(", ")}`);
    if (field.type === "status" && field.is_system) {
      const categories = new Set(old.map((o) => o.category));
      const bad = patch.values.filter((v) => !v.category || !categories.has(v.category));
      if (bad.length) {
        throw unprocessable(`Each status needs a category from: ${[...categories].join(", ")}`, { values: bad.map((b) => b.key) });
      }
      const recategorized = patch.values.filter((v) => old.some((o) => o.key === v.key && o.category !== v.category));
      if (recategorized.length) throw unprocessable("The category of an existing status cannot change");
    }
    validateFieldInput(schema, { api_name: field.api_name, type: field.type, options: { ...field.options, values: patch.values } }, null);
    before.values = old;
    after.values = patch.values;
    newOptions = { ...field.options, values: patch.values };
  }
  // Options another type takes are refused, not ignored: max: 5 on a number field is a mistake to point out.
  if (patch.max !== undefined && field.type !== "rating") throw unprocessable(`"${fieldName}" is a ${field.type} field; only rating fields have a max`);
  if (patch.shape !== undefined && field.type !== "json") throw unprocessable(`"${fieldName}" is a ${field.type} field; only json fields have a shape`);
  if (patch.max !== undefined && patch.max !== ratingMax(field)) {
    if (typeof patch.max === "number" && patch.max < ratingMax(field)) {
      throw unprocessable(`A rating's max can be raised but not lowered (it is ${ratingMax(field)}): stored ratings above the new max would no longer be valid`);
    }
    newOptions = { ...newOptions, max: patch.max };
    before.max = ratingMax(field);
    after.max = patch.max;
  }
  if (patch.shape !== undefined && JSON.stringify(patch.shape) !== JSON.stringify(field.options.shape ?? null)) {
    const rest = Object.fromEntries(Object.entries(newOptions).filter(([k]) => k !== "shape")) as FieldMeta["options"];
    newOptions = patch.shape === null ? rest : { ...rest, shape: patch.shape };
    before.shape = field.options.shape ?? null;
    after.shape = patch.shape;
    warnings.push("Stored values are not re-checked; the shape applies to values written from now on.");
  }
  if (after.max !== undefined || after.shape !== undefined) {
    const problem = fieldRulesProblem({ ...field, options: newOptions }, null);
    if (problem) throw unprocessable(`Field "${field.api_name}": ${problem}`);
  }
  const change: Change = { change: "field_updated", object: obj.api_name, field: field.api_name, before, after };
  if (warnings.length) change.warning = warnings.join(" ");
  if (Object.keys(after).length === 0) return { dry_run: dryRun, schema_version: schema.version, changes: [] };
  if (dryRun) return { dry_run: true, schema_version: schema.version, changes: [change] };

  await updateFieldRow(tx, {
    id: field.id,
    apiName: (after.api_name as string) ?? field.api_name,
    label: (after.label as string) ?? field.label,
    description: (after.description as string) ?? field.description,
    hidden: (after.hidden as boolean) ?? field.hidden,
    required: (after.required as boolean) ?? field.required,
    sensitivity: (after.sensitivity as string) ?? field.sensitivity,
    defaultValue: "default" in after ? { json: after.default } : field.default_value === null ? null : { json: field.default_value },
    validation: (after.validation as object) ?? field.validation,
    options: newOptions,
  });
  const version = await recordChange(tx, ctx, { ...change, object_id: obj.id, field_id: field.id });
  return { dry_run: false, schema_version: version, changes: [change] };
}

/** Tokens bind a confirmation to the exact change and schema version shown in the dry run. */
export function confirmToken(ctx: Ctx, version: number, ...parts: string[]): string {
  return hmac(masterKey(), ["confirm", ctx.tenantId, String(version), ...parts].join("|")).slice(0, 24);
}

export async function archiveField(tx: Tx, ctx: Ctx, objectName: string, fieldName: string, opts: { dryRun: boolean; confirm?: string }): Promise<ChangeResult> {
  if (!opts.dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const field = obj.byName.get(fieldName);
  if (!field) throw notFound(`Field "${fieldName}" on ${objectName}`);
  if (field.is_system) throw forbidden("Standard fields cannot be archived. Hide the field instead (update_field with hidden: true).");
  const count = await countValues(tx, obj, field);
  const change: Change = {
    change: "field_archived", object: obj.api_name, field: field.api_name, before: fieldSummary(field),
    warning: `${count} record(s) have a value. Values are kept but hidden and unwritable. Nothing removes them, short of erasing a record.`,
  };
  const token = confirmToken(ctx, schema.version, "archive_field", obj.api_name, field.api_name);
  if (opts.dryRun) return { dry_run: true, schema_version: schema.version, changes: [change], confirm_token: token };
  if (opts.confirm !== token) {
    throw badRequest("Archiving a field needs confirmation: run it with dry_run first and pass back its confirm_token");
  }
  await archiveFieldRow(tx, field.id);
  const version = await recordChange(tx, ctx, { ...change, object_id: obj.id, field_id: field.id });
  return { dry_run: false, schema_version: version, changes: [change] };
}

/** Records holding a value in `field` (relations: records linking somewhere). */
export async function countValues(tx: Tx, obj: ObjectMeta, field: FieldMeta): Promise<number> {
  if (field.type === "relation") {
    return countLinkingRecords(tx, field.id);
  }
  const col = obj.is_system ? (field.sensitivity === "restricted" ? "custom_encrypted" : "custom") : (field.sensitivity === "restricted" ? "encrypted" : "data");
  const table = obj.table_name ?? "records";
  const [r] = await tx.unsafe<{ n: number }[]>( // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
    `SELECT count(*)::int AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(col)} ? $1${obj.is_system ? "" : " AND object_id = $2"}`,
    obj.is_system ? [field.storage_key] : [field.storage_key, obj.id],
  );
  return r?.n ?? 0;
}

/** The type changes that keep every stored value's meaning, from the field type registry. Anything else needs a new field. */
export const SAFE_RETYPES: Partial<Record<FieldType, FieldType>> = Object.fromEntries(
  FIELD_TYPES.filter((t) => TYPE_INFO[t].retype).map((t) => [t, TYPE_INFO[t].retype!.to]));
const SAFE_RETYPE_LIST = FIELD_TYPES.filter((t) => TYPE_INFO[t].retype).map((t) => `${t} → ${TYPE_INFO[t].retype!.to}`).join(", ");

/** The field types whose values go into a record's search_text (records.ts), restricted fields aside. */
export const SEARCH_TEXT_TYPES: readonly FieldType[] = FIELD_TYPES.filter((t) => TYPE_INFO[t].search);

/**
 * Changes a custom field's type along a safe path. text → long_text keeps every value but takes the
 * field out of search_text, which is rebuilt for the object's records in one statement. number →
 * currency and single_select → multi_select rewrite stored values (currency is kept in minor units,
 * multi-selects as lists), so like archiving they need the confirm_token from a dry run. Restricted
 * values are encrypted and never rewritten: only text → long_text is allowed on them (and they are
 * never in search_text). Unique fields are refused, so no uniqueness check sees a changed value.
 * Field rules are keyed by field ID and stay; schema:manage callers have unrestricted access anyway.
 */
export async function retypeField(
  tx: Tx, ctx: Ctx, objectName: string, fieldName: string, type: FieldType, opts: { dryRun: boolean; confirm?: string },
): Promise<ChangeResult> {
  if (!opts.dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const field = obj.byName.get(fieldName);
  if (!field) throw notFound(`Field "${fieldName}" on ${objectName}`);
  if (field.type === type) return { dry_run: opts.dryRun, schema_version: schema.version, changes: [] };
  if (field.is_system) throw forbidden("Standard fields cannot be retyped; add a custom field instead");
  if (SAFE_RETYPES[field.type] !== type) {
    throw unprocessable(`"${fieldName}" cannot change from ${field.type} to ${String(type).slice(0, 40)}. Safe changes are ${SAFE_RETYPE_LIST}; `
      + "for anything else add a new field");
  }
  if (field.is_unique) throw unprocessable(`"${fieldName}" is unique, and ${type} fields cannot be`);
  const rewrites = TYPE_INFO[field.type].retype!.rewrite;
  if (rewrites && field.sensitivity === "restricted") throw unprocessable("Restricted values are encrypted and cannot be converted; add a new field instead");
  const newDefault = field.default_value == null ? null : field.type === "single_select" ? [field.default_value] : field.default_value;
  // Options only the old type takes (a rating's max) go. The old type's implicit bounds become explicit rules, so
  // stored values stay valid and new ones keep to them: a percent's 0 to 100, a duration's 0 and up, a rating's 1 to max.
  const newOptions = Object.fromEntries(Object.entries(field.options).filter(([k]) => !(["max", "shape"].includes(k) && !(TYPE_INFO[type].options as string[]).includes(k))));
  const newValidation = field.type === "percent" ? { ...field.validation, min: field.validation.min ?? PERCENT.defaultMin, max: field.validation.max ?? PERCENT.defaultMax }
    : field.type === "duration" ? { ...field.validation, min: field.validation.min ?? 0 }
    : field.type === "rating" ? { min: 1, max: ratingMax(field) } : field.validation;
  const problem = fieldRulesProblem({ ...field, type, options: newOptions, validation: newValidation }, newDefault);
  if (problem) throw unprocessable(`Field "${field.api_name}": ${problem}`);
  const change: Change & { data_affecting?: boolean } = { change: "field_retyped", object: obj.api_name, field: field.api_name, before: { type: field.type }, after: { type } };
  if (JSON.stringify(newValidation) !== JSON.stringify(field.validation)) Object.assign(change, { before: { type: field.type, validation: field.validation }, after: { type, validation: newValidation } });
  const warnings: string[] = [];
  if (rewrites) warnings.push(`${await countValues(tx, obj, field)} stored value(s) will be converted to ${type}.`);
  // Saved views that use the field in a way the new type doesn't support stop working: named, and confirmed like a data change.
  const broken = await viewsBrokenByRetype(tx, obj, field, type);
  if (broken.shared.length || broken.personal) {
    warnings.push(`${[broken.shared.length ? `shared view(s) ${broken.shared.map((n) => `"${n}"`).join(", ")}` : "", broken.personal ? `${broken.personal} personal view(s)` : ""]
      .filter(Boolean).join(" and ")} use it in a way a ${type} field doesn't support (${broken.why.join(", ")}) and will stop working until changed. `
      + `Aggregates that group by it will be refused too.`);
  }
  const needsConfirm = rewrites || broken.shared.length > 0 || broken.personal > 0;
  if (needsConfirm) change.data_affecting = true;
  if (warnings.length) change.warning = warnings.join(" ");
  const token = confirmToken(ctx, schema.version, "retype_field", obj.api_name, field.api_name, type);
  if (opts.dryRun) return { dry_run: true, schema_version: schema.version, changes: [change], ...(needsConfirm ? { confirm_token: token } : {}) };
  if (needsConfirm && opts.confirm !== token) {
    throw badRequest(rewrites ? "Converting stored values needs confirmation: run it with dry_run first and pass back its confirm_token"
      : "Saved views would stop working: run it with dry_run first, read which, and pass back its confirm_token");
  }
  await retypeFieldRow(tx, { id: field.id, type, defaultValue: newDefault, options: newOptions, validation: newValidation });
  if (rewrites) {
    const col = quoteIdent(storageColumn(obj));
    const value = type === "currency" ? `to_jsonb(round((${col}->>$1)::numeric * 100))` : `jsonb_build_array(${col}->$1)`;
    const from = type === "currency" ? "number" : "string";
    // Reviewed: `col` is a quoted identifier, and `value` and `from` are built above from fixed strings only.
    // nosemgrep: hlcrm-no-interpolated-sql-in-unsafe
    await tx.unsafe( // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
      `UPDATE ${quoteIdent(obj.table_name ?? "records")} SET ${col} = jsonb_set(${col}, ARRAY[$1], ${value})
       WHERE jsonb_typeof(${col}->$1) = '${from}'${obj.is_system ? "" : " AND object_id = $2"}`,
      obj.is_system ? [field.storage_key] : [field.storage_key, obj.id],
    );
  }
  if (SEARCH_TEXT_TYPES.includes(field.type) && !SEARCH_TEXT_TYPES.includes(type) && field.sensitivity !== "restricted") {
    await rebuildSearchText(tx, obj, obj.fields.filter((f) => f.id !== field.id));
  }
  const version = await recordChange(tx, ctx, { ...change, object_id: obj.id, field_id: field.id });
  return { dry_run: false, schema_version: version, changes: [change] };
}

/**
 * Saved views of `obj` that use `field` in a way `type` doesn't support: grouping by it (rating → number), sorting by
 * it, or a filter operator the new type lacks. Shared views by name; personal ones only counted (their names are their owners').
 */
async function viewsBrokenByRetype(tx: Tx, obj: ObjectMeta, field: FieldMeta, type: FieldType): Promise<{ shared: string[]; personal: number; why: string[] }> {
  const info = TYPE_INFO[type];
  const rows = await viewsOfObject(tx, obj.id);
  const why = new Set<string>();
  const ops = (w: unknown, depth: number): boolean => {
    if (typeof w !== "object" || w === null || depth > 10) return false;
    const n = w as Record<string, unknown>;
    if (Array.isArray(n.and) || Array.isArray(n.or)) return ((n.and ?? n.or) as unknown[]).some((x) => ops(x, depth + 1));
    if (Object.hasOwn(n, "not")) return ops(n.not, depth + 1);
    const path = Array.isArray(n.path) ? n.path : [n.field];
    const bad = path.length === 1 && path[0] === field.api_name && typeof n.op === "string" && !(info.ops as string[]).includes(n.op);
    if (bad) why.add(`filter ${String(n.op)}`);
    return bad;
  };
  const uses = (list: unknown) => Array.isArray(list) && list.some((x) => typeof x === "object" && x !== null && (x as { field?: unknown }).field === field.api_name);
  const out = { shared: [] as string[], personal: 0 };
  for (const r of rows) {
    const grouped = !info.group && uses(r.definition.group_by);
    const sorted = !info.sort && uses(r.definition.sort);
    if (grouped) why.add("group by");
    if (sorted) why.add("sort");
    if (!(ops(r.definition.where, 0) || grouped || sorted)) continue;
    if (r.shared) out.shared.push(r.name);
    else out.personal++;
  }
  return { ...out, why: [...why] };
}

/** Where an object keeps its unencrypted custom values. */
const storageColumn = (obj: ObjectMeta) => (obj.is_system ? "custom" : "data");

/** Sets search_text as records.ts builds it (lower-cased, space-joined, at most 4,000 characters) from `fields`, for every record of `obj`. */
async function rebuildSearchText(tx: Tx, obj: ObjectMeta, fields: FieldMeta[]): Promise<void> {
  const params: string[] = obj.is_system ? [] : [obj.id];
  const parts = fields.filter((f) => f.sensitivity !== "restricted" && SEARCH_TEXT_TYPES.includes(f.type)).map((f) => {
    if (f.column_name) return `${quoteIdent(f.column_name)}::text`;
    params.push(f.storage_key);
    // An address adds its parts, space-joined, as searchString (core/fieldtypes.ts) does; part names are a fixed list.
    if (f.type === "address") return `concat_ws(' ', ${ADDRESS_PART_NAMES.map((p) => `nullif(${quoteIdent(storageColumn(obj))}->$${params.length}->>'${p}', '')`).join(", ")})`;
    return `${quoteIdent(storageColumn(obj))}->>$${params.length}`;
  });
  const text = parts.length ? `left(lower(concat_ws(' ', ${parts.join(", ")})), 4000)` : "''";
  // Reviewed: `text` holds only quoted column names and $n placeholders.
  // nosemgrep: hlcrm-no-interpolated-sql-in-unsafe
  await tx.unsafe(`UPDATE ${quoteIdent(obj.table_name ?? "records")} SET search_text = ${text}${obj.is_system ? "" : " WHERE object_id = $1"}`, params); // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
}

export interface ObjectPatch { label?: string; plural_label?: string; description?: string; hidden?: boolean; display_field?: string }

export async function updateObject(tx: Tx, ctx: Ctx, objectName: string, patch: ObjectPatch, dryRun: boolean): Promise<ChangeResult> {
  if (!dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  checkText({ label: patch.label, plural_label: patch.plural_label, description: patch.description });
  if (patch.display_field !== undefined) {
    if (obj.is_system) throw forbidden("Standard objects have a fixed display field");
    const f = obj.byName.get(patch.display_field);
    if (!f || !DISPLAY_TYPES.includes(f.type)) throw unprocessable(`display_field must be a text-like field of this object (${DISPLAY_TYPES.join(", ")})`);
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of ["label", "plural_label", "description", "hidden", "display_field"] as const) {
    if (patch[key] !== undefined && patch[key] !== obj[key]) {
      before[key] = obj[key];
      after[key] = patch[key];
    }
  }
  const change: Change = { change: "object_updated", object: obj.api_name, before, after };
  if (Object.keys(after).length === 0) return { dry_run: dryRun, schema_version: schema.version, changes: [] };
  if (dryRun) return { dry_run: true, schema_version: schema.version, changes: [change] };
  await updateObjectRow(tx, { id: obj.id, label: (after.label as string) ?? obj.label, pluralLabel: (after.plural_label as string) ?? obj.plural_label,
    description: (after.description as string) ?? obj.description, hidden: (after.hidden as boolean) ?? obj.hidden,
    displayField: (after.display_field as string) ?? obj.display_field });
  const version = await recordChange(tx, ctx, { ...change, object_id: obj.id });
  return { dry_run: false, schema_version: version, changes: [change] };
}

export async function setModules(tx: Tx, ctx: Ctx, modules: string[], dryRun: boolean): Promise<ChangeResult> {
  if (!dryRun) await lockSchema(tx);
  const schema = await loadSchema(tx);
  const unknown = modules.filter((m) => !(MODULES as readonly string[]).includes(m));
  if (unknown.length) throw unprocessable(`Unknown or unavailable modules: ${unknown.join(", ")}. Available: ${MODULES.join(", ")}`);
  if (!modules.includes("core")) throw unprocessable("The core module cannot be turned off");
  if (modules.includes("commerce") && !modules.includes("sales")) throw unprocessable("The commerce module needs the sales module: a quote is made for a deal");
  const turningOff = schema.modules.filter((m) => !modules.includes(m));
  for (const m of turningOff) {
    for (const o of schema.objects.values()) {
      if (o.module !== m || !o.table_name) continue;
      const [r] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${quoteIdent(o.table_name)} WHERE archived_at IS NULL`); // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
      if ((r?.n ?? 0) > 0) throw conflict(`Module "${m}" has ${o.plural_label.toLowerCase()} with data; archive them before turning it off`);
    }
  }
  const change: Change = { change: "modules_updated", object: "workspace", before: schema.modules, after: modules };
  if (dryRun) return { dry_run: true, schema_version: schema.version, changes: [change] };
  await setWorkspaceModules(tx, modules);
  const version = await recordChange(tx, ctx, change);
  return { dry_run: false, schema_version: version, changes: [change] };
}

/** Quotes an identifier that came from system metadata. Rejects anything unusual. */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

export { isEntity };
