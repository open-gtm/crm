import type { Tx } from "../db/pool.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { accessShortfall, describeAccess, loadMemberAccess, loadRoleRules, roleCtx, type AccessPart, type RoleRules } from "./access.js";
import { audit } from "./audit.js";
import {
  ALL_PERMISSIONS, PERMISSION_REQUIRES, PERMISSIONS, RECORD_ACTIONS, can, isPermission, missingRequired,
  type Ctx, type FieldLimit, type ObjectRule, type Permission,
} from "./context.js";
import {
  activeMemberCount, archiveRoleRow, deleteFieldRule, deleteObjectRule, insertRole, insertSystemRoles, liveRole, rolesWithMemberCounts,
  updateRoleDefinition, upsertFieldRule, upsertObjectRule, type RoleKind, type RoleRow,
} from "./queries/roles.js";
import { loadSchema, type Schema } from "./schema.js";

export type { RoleKind, RoleRow } from "./queries/roles.js";

const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * Roles holding these configure work that runs with full record access, or (schema:manage) see per-field
 * value counts and whether objects hold data, so they must have full record access themselves (ADR 0008).
 */
const RECORD_MANAGERS: Permission[] = ["automations:manage", "webhooks:manage", "alerts:manage", "schema:manage"];
const MAX_OBJECT_RULES = 500;
const MAX_FIELD_RULES = 5_000;

/**
 * Roles and permission sets (ADR 0013) are built and checked the same way; these are the words and
 * identifiers that differ. A member holds one role and any number of sets, and a set only adds access.
 */
const KIND = {
  role: { prefix: "role", noun: "role", Noun: "Role", plural: "roles", audit: "role" },
  permission_set: { prefix: "pset", noun: "permission set", Noun: "Permission set", plural: "permission sets", audit: "permission_set" },
} as const;

/** The permissions catalog is in two areas: what a member may do with records (objects and fields), and features of the CRM. */
const RECORD_PERMISSIONS: Permission[] = ["records:read", "records:write", "records:archive", "restricted:read"];

/** The permission catalog, for clients building a role editor. `requires` lists what a role must also hold to have it. */
export const permissionCatalog = () => ALL_PERMISSIONS.map((key) => ({ key, description: PERMISSIONS[key],
  category: RECORD_PERMISSIONS.includes(key) ? "records" as const : "features" as const, requires: PERMISSION_REQUIRES[key] ?? [] }));

/** Seeds the system roles for the tenant in `app.tenant_id`. The definitions live in migration 006 (app.seed_system_roles). */
export async function seedSystemRoles(tx: Tx): Promise<void> {
  await insertSystemRoles(tx);
}

/** Rules by object and field api_name, as the API takes and returns them. Rules on archived objects or fields are dormant and left out. */
export function publicRules(schema: Schema, rules: RoleRules) {
  const objects: Record<string, ObjectRule> = {};
  for (const [id, r] of rules.objects) {
    const o = schema.byId.get(id);
    if (o) objects[o.api_name] = { read: r.read, write: r.write, archive: r.archive };
  }
  const fields: Record<string, Record<string, FieldLimit>> = {};
  for (const o of schema.objects.values()) {
    for (const f of o.fields) {
      const limit = rules.fields.get(f.id);
      if (limit) (fields[o.api_name] ??= {})[f.api_name] = limit;
    }
  }
  return { objects, fields };
}

export const publicRole = (r: RoleRow, members?: number, rules?: ReturnType<typeof publicRules>, kind: RoleKind = "role") => ({
  id: encodeId(KIND[kind].prefix, r.id), key: r.key, name: r.name, description: r.description,
  permissions: ALL_PERMISSIONS.filter((p) => r.permissions.includes(p)),
  // The same permissions in the two areas a set or role is edited in: records (with the object and field rules) and features.
  record_permissions: RECORD_PERMISSIONS.filter((p) => r.permissions.includes(p)),
  feature_permissions: ALL_PERMISSIONS.filter((p) => r.permissions.includes(p) && !RECORD_PERMISSIONS.includes(p)),
  ...(kind === "role" ? { is_system: r.is_system } : {}),
  ...(rules ? { objects: rules.objects, fields: rules.fields } : {}),
  created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(), archived_at: r.archived_at?.toISOString() ?? null,
  ...(members !== undefined ? { active_members: members } : {}),
});

/**
 * Finds a live role by key (`admin`) or ID (`role_…`). `lock` takes a row lock, so a role being
 * assigned can't be archived (and vice versa) by a concurrent request.
 */
export async function resolveRole(tx: Tx, ref: string, lock: "share" | "update" | null = null, kind: RoleKind = "role"): Promise<RoleRow> {
  const { Noun, prefix } = KIND[kind];
  if (typeof ref !== "string" || !ref) throw notFound(Noun);
  const d = decodeId(ref);
  if (d && d.prefix !== prefix) throw notFound(Noun);
  if (!d && !KEY_PATTERN.test(ref)) throw notFound(Noun);
  const row = await liveRole(tx, d ? { id: d.uuid } : { key: ref }, lock, kind);
  if (!row) throw notFound(Noun);
  return row;
}

/** A role (or a set), and optionally the permission sets a member holds on top of it. */
type RoleRef = Pick<RoleRow, "id" | "key" | "permissions" | "access_version"> & { sets?: readonly AccessPart[] };

/**
 * A role's own access (not narrowed by any key), as a context: to compare with a caller's, or to check
 * a recipient. With `sets` (a member's permission sets) it is that member's access: role and sets combined.
 */
export async function contextForRole(tx: Tx, ctx: Pick<Ctx, "tenantId" | "requestId">, role: RoleRef, opts: { restricted?: boolean } = {}): Promise<Ctx> {
  const access = await loadMemberAccess(tx, ctx.tenantId, role, role.sets ?? []);
  return roleCtx(ctx, { key: role.key, permissions: access.permissions }, access.rules, access.version, opts);
}

/** A member row as the member queries return it: their role's columns and the sets they hold. */
export interface MemberAccessRow { role_id: string; role_key?: string; role?: string; permissions: readonly string[]; access_version: string; sets: readonly AccessPart[] }

/** The RoleRef of a member: what contextForRole and assertCoversRole need to see everything the member can do. */
export const memberRef = (m: MemberAccessRow): RoleRef =>
  ({ id: m.role_id, key: m.role_key ?? m.role ?? "", permissions: m.permissions as Permission[], access_version: m.access_version, sets: m.sets });

/**
 * Refuses a role whose record access reaches beyond the caller's, per object and per field. `rules`
 * checks a role's rules before they are saved (never cached: the transaction may still roll back).
 */
export async function assertCoversRole(tx: Tx, ctx: Ctx, schema: Schema, role: RoleRef, what: string, rules?: RoleRules) {
  const target = rules ? roleCtx(ctx, role, rules, "draft", { restricted: true }) : await contextForRole(tx, ctx, role, { restricted: true });
  const short = accessShortfall(ctx, schema, target);
  if (short.length) throw forbidden(`${what} has record access you don't: ${short.slice(0, 10).join("; ")}${short.length > 10 ? "; …" : ""}`);
}

async function activeMembers(tx: Tx, roleId: string, kind: RoleKind = "role"): Promise<number> {
  return (await activeMemberCount(tx, roleId, kind)) ?? 0;
}

export async function listRoles(tx: Tx, ctx: Ctx, opts: { includeArchived?: boolean } = {}, kind: RoleKind = "role") {
  const schema = await loadSchema(tx);
  const rows = await rolesWithMemberCounts(tx, opts.includeArchived ?? false, kind);
  const out = [];
  for (const r of rows) out.push(publicRole(r, r.members, publicRules(schema, await loadRoleRules(tx, ctx.tenantId, r.id, r.access_version)), kind));
  return out;
}

export async function getRole(tx: Tx, ctx: Ctx, ref: string, kind: RoleKind = "role") {
  const r = await resolveRole(tx, ref, null, kind);
  const schema = await loadSchema(tx);
  return publicRole(r, await activeMembers(tx, r.id, kind), publicRules(schema, await loadRoleRules(tx, ctx.tenantId, r.id, r.access_version)), kind);
}

/** What a role's holders can do with records, per object: the role editor's way to check its work. For a set: what the set alone gives. */
export async function roleAccess(tx: Tx, ctx: Ctx, ref: string, kind: RoleKind = "role") {
  const r = await resolveRole(tx, ref, null, kind);
  const role = await contextForRole(tx, ctx, r, { restricted: true });
  return { [kind]: r.key, permissions: ALL_PERMISSIONS.filter((p) => r.permissions.includes(p)), objects: describeAccess(role, await loadSchema(tx)) };
}

function checkPermissions(list: unknown, noun = "role"): Permission[] {
  if (!Array.isArray(list) || list.some((p) => typeof p !== "string" || !isPermission(p))) {
    throw unprocessable(`permissions must be a list of: ${ALL_PERMISSIONS.join(", ")}`);
  }
  const out = ALL_PERMISSIONS.filter((p) => list.includes(p));
  const missing = missingRequired(out);
  if (missing.length) {
    const why = out.filter((p) => PERMISSION_REQUIRES[p]?.some((r) => missing.includes(r)));
    throw unprocessable(`${why.join(", ")} reach${why.length === 1 ? "es" : ""} record data, so the ${noun} must also hold: ${missing.join(", ")}`, { missing });
  }
  return out;
}

/** Refuses a grant the caller couldn't make themselves: nobody hands out a permission they don't hold. */
function assertCanGrant(ctx: Ctx, permissions: Iterable<string>, what: string) {
  const missing = [...permissions].filter((p) => !isPermission(p) || !ctx.permissions.has(p));
  if (missing.length) throw forbidden(`${what} would grant permissions you don't hold: ${missing.join(", ")}`);
}

const diff = (before: readonly string[], after: readonly string[]) => ({
  added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)),
});

// ----------------------------------------------------------------------------------------------
// Object and field rules

export interface RulesInput {
  /** Per object: read / write / archive as true (allow), false (deny) or null (inherit the role's records:* permission). null clears the object's rule. */
  objects?: Record<string, Partial<Record<"read" | "write" | "archive", boolean | null>> | null>;
  /** Per object, per field: "none", "read", or null (follow the object). null for an object clears all its field rules. */
  fields?: Record<string, Record<string, FieldLimit | null> | null>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Applies a patch of rules (by api_name) to a role's current rules (by ID). Unknown names are refused. */
function applyRules(schema: Schema, current: RoleRules, input: RulesInput, Noun = "Role"): RoleRules {
  const objects = new Map(current.objects);
  const fields = new Map(current.fields);
  const objectNamed = (name: string, where: string) => {
    const o = schema.objects.get(name);
    if (!o) throw unprocessable(`${where}: "${name}" is not an object`);
    return o;
  };
  if (input.objects !== undefined) {
    if (!isRecord(input.objects)) throw unprocessable("objects maps object names to {read, write, archive}");
    for (const [name, v] of Object.entries(input.objects)) {
      const o = objectNamed(name, "objects");
      if (v === null) {
        objects.delete(o.id);
        continue;
      }
      if (!isRecord(v) || Object.entries(v).some(([k, x]) => !(RECORD_ACTIONS as string[]).includes(k) || (x !== null && typeof x !== "boolean"))) {
        throw unprocessable(`objects.${name} takes read, write and archive, each true, false or null`);
      }
      const prior = objects.get(o.id) ?? { read: null, write: null, archive: null };
      const next = Object.fromEntries(RECORD_ACTIONS.map((a) => [a, v[a] === undefined ? prior[a] : v[a]])) as unknown as ObjectRule;
      if (RECORD_ACTIONS.every((a) => next[a] === null)) objects.delete(o.id);
      else objects.set(o.id, next);
    }
  }
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) throw unprocessable("fields maps object names to {field: \"none\" | \"read\" | null}");
    for (const [name, v] of Object.entries(input.fields)) {
      const o = objectNamed(name, "fields");
      if (v === null) {
        for (const f of o.fields) fields.delete(f.id);
        continue;
      }
      if (!isRecord(v)) throw unprocessable(`fields.${name} maps field names to "none", "read" or null`);
      for (const [fname, access] of Object.entries(v)) {
        const f = o.byName.get(fname);
        if (!f) throw unprocessable(`fields.${name}: "${fname}" is not a field of ${name}`);
        if (access === null) fields.delete(f.id);
        else if (access === "none" || access === "read") fields.set(f.id, access);
        else throw unprocessable(`fields.${name}.${fname} must be "none", "read" or null`);
      }
    }
  }
  if (objects.size > MAX_OBJECT_RULES || fields.size > MAX_FIELD_RULES) {
    throw unprocessable(`${Noun === "Role" ? "A role" : "A permission set"} can have at most ${MAX_OBJECT_RULES} object rules and ${MAX_FIELD_RULES} field rules`);
  }
  return { objects, fields };
}

/**
 * The rules must make sense with the permissions they sit on: on every object with a rule, write
 * needs read and archive needs write; and a role that manages automations, webhooks, alerts or the schema
 * can't be limited at all (those run with, or show signals from, full record access, so limits would be a fiction).
 */
function checkRules(schema: Schema, permissions: Permission[], rules: RoleRules, noun = "role"): void {
  const managers = RECORD_MANAGERS.filter((p) => permissions.includes(p));
  if (managers.length && ([...rules.objects.values()].some((r) => RECORD_ACTIONS.some((a) => r[a] === false)) || rules.fields.size)) {
    throw unprocessable(`A ${noun} with ${managers.join(", ")} must have unrestricted record access: remove its denying object rules and its field rules`);
  }
  const problems: string[] = [];
  for (const [id, r] of rules.objects) {
    const name = schema.byId.get(id)?.api_name ?? id;
    const has = (a: "read" | "write" | "archive") => r[a] ?? permissions.includes(`records:${a}`);
    if (has("write") && !has("read")) problems.push(`${name}: write needs read`);
    if (has("archive") && !has("write")) problems.push(`${name}: archive needs write`);
  }
  if (problems.length) throw unprocessable(`Invalid object rules: ${problems.join("; ")}`, { problems });
}

/**
 * Writes the rules that changed. Triggers on the rule tables (migration 008) move the role to a new
 * access_version, so every process reloads them on the next request, also after a change made in SQL.
 */
async function saveRules(tx: Tx, ctx: Ctx, schema: Schema, roleId: string, before: RoleRules, after: RoleRules) {
  const objectChanges: { object: string; read: boolean | null; write: boolean | null; archive: boolean | null }[] = [];
  const fieldChanges: { object: string; field: string; access: FieldLimit | null }[] = [];
  for (const id of new Set([...before.objects.keys(), ...after.objects.keys()])) {
    const b = before.objects.get(id);
    const a = after.objects.get(id);
    if (b && a && RECORD_ACTIONS.every((x) => b[x] === a[x])) continue;
    if (a) {
      await upsertObjectRule(tx, { tenantId: ctx.tenantId, roleId, objectId: id, read: a.read, write: a.write, archive: a.archive, updatedBy: ctx.actor.id });
    } else await deleteObjectRule(tx, roleId, id);
    objectChanges.push({ object: schema.byId.get(id)?.api_name ?? id, read: a?.read ?? null, write: a?.write ?? null, archive: a?.archive ?? null });
  }
  const fieldName = new Map([...schema.objects.values()].flatMap((o) => o.fields.map((f) => [f.id, { object: o.api_name, field: f.api_name }] as const)));
  for (const id of new Set([...before.fields.keys(), ...after.fields.keys()])) {
    const a = after.fields.get(id);
    if (before.fields.get(id) === a) continue;
    if (a) {
      await upsertFieldRule(tx, { tenantId: ctx.tenantId, roleId, fieldId: id, access: a, updatedBy: ctx.actor.id });
    } else await deleteFieldRule(tx, roleId, id);
    fieldChanges.push({ ...(fieldName.get(id) ?? { object: "?", field: id }), access: a ?? null });
  }
  return { objectChanges, fieldChanges };
}

const NO_RULES: RoleRules = { objects: new Map(), fields: new Map() };

// ----------------------------------------------------------------------------------------------
// Role changes

export interface CreateRoleInput extends RulesInput { key: string; name: string; description?: string; permissions?: string[]; copy_from?: string }

/** True when the caller holds this role or set themselves: nobody changes or archives what gives them their own access. */
const holds = (ctx: Ctx, kind: RoleKind, key: string) => (kind === "role" ? key === ctx.actor.role : (ctx.actor.permissionSets ?? []).includes(key));

export async function createRole(tx: Tx, ctx: Ctx, input: CreateRoleInput, kind: RoleKind = "role") {
  const { noun, Noun, plural, prefix, audit: auditName } = KIND[kind];
  if (!can(ctx, "roles:manage")) throw forbidden(`Creating ${plural} needs the roles:manage permission`);
  if (typeof input.key !== "string" || !KEY_PATTERN.test(input.key) || input.key.startsWith(`${prefix}_`)) {
    throw unprocessable(`key must be 2 to 40 lowercase letters, digits or underscores, start with a letter and not start with ${prefix}_`);
  }
  if (!input.name?.trim() || input.name.length > 100) throw unprocessable("name is required (up to 100 characters)");
  const schema = await loadSchema(tx);
  const source = input.copy_from !== undefined ? await resolveRole(tx, input.copy_from, null, kind) : null;
  const permissions = checkPermissions(input.permissions ?? source?.permissions ?? [], noun);
  assertCanGrant(ctx, permissions, `This ${noun}`);
  // Copying a role copies its object and field rules too; rules in the request apply on top.
  const base = source ? await loadRoleRules(tx, ctx.tenantId, source.id, source.access_version) : NO_RULES;
  const rules = applyRules(schema, base, input, Noun);
  checkRules(schema, permissions, rules, noun);
  await assertCoversRole(tx, ctx, schema, { id: "", key: input.key, permissions, access_version: "0" }, `This ${noun}`, rules);
  const description = input.description ?? source?.description ?? "";
  if (description.length > 1000) throw unprocessable("description is limited to 1000 characters");
  const id = uuidv7();
  try {
    await insertRole(tx, { tenantId: ctx.tenantId, id, key: input.key, name: input.name.trim(), description, permissions, createdBy: ctx.actor.id, kind });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict(`A ${noun} with key "${input.key}" already exists`);
    throw e;
  }
  const saved = await saveRules(tx, ctx, schema, id, NO_RULES, rules);
  await audit(tx, ctx, { action: `${auditName}.created`, objectType: auditName, recordId: id,
    details: { key: input.key, permissions, ...(source ? { copied_from: source.key } : {}),
      ...(saved.objectChanges.length ? { object_rules: saved.objectChanges } : {}), ...(saved.fieldChanges.length ? { field_rules: saved.fieldChanges } : {}) } });
  return publicRole(await resolveRole(tx, encodeId(prefix, id), null, kind), 0, publicRules(schema, rules), kind);
}

export interface UpdateRoleInput extends RulesInput { name?: string; description?: string; permissions?: string[] }

export async function updateRole(tx: Tx, ctx: Ctx, ref: string, patch: UpdateRoleInput, kind: RoleKind = "role") {
  const { noun, Noun, plural, prefix, audit: auditName } = KIND[kind];
  if (!can(ctx, "roles:manage")) throw forbidden(`Changing ${plural} needs the roles:manage permission`);
  const role = await resolveRole(tx, ref, "update", kind);
  if (role.is_system) throw forbidden("System roles can't be changed. Create a custom role (copy_from this one) instead");
  if (holds(ctx, kind, role.key)) throw forbidden(`You can't change a ${noun} you hold`);
  const schema = await loadSchema(tx);
  // Changing a role or set changes the access of everyone who holds it, so the caller must hold all of it, before and after.
  assertCanGrant(ctx, role.permissions, `Changing this ${noun}`);
  await assertCoversRole(tx, ctx, schema, role, `This ${noun}`);
  const permissions = patch.permissions !== undefined ? checkPermissions(patch.permissions, noun) : role.permissions;
  assertCanGrant(ctx, permissions, "This change");
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 100)) throw unprocessable("name must be 1 to 100 characters");
  if (patch.description !== undefined && patch.description.length > 1000) throw unprocessable("description is limited to 1000 characters");
  const before = await loadRoleRules(tx, ctx.tenantId, role.id, role.access_version);
  const rules = applyRules(schema, before, patch, Noun);
  checkRules(schema, permissions, rules, noun);
  await assertCoversRole(tx, ctx, schema, { ...role, permissions }, "This change", rules);
  const name = patch.name?.trim() ?? role.name;
  const description = patch.description ?? role.description;
  await updateRoleDefinition(tx, role.id, name, description, permissions);
  const saved = await saveRules(tx, ctx, schema, role.id, before, rules);
  const changed = diff(role.permissions, permissions);
  await audit(tx, ctx, { action: `${auditName}.updated`, objectType: auditName, recordId: role.id,
    details: { key: role.key, permissions_added: changed.added, permissions_removed: changed.removed,
      ...(saved.objectChanges.length ? { object_rules: saved.objectChanges } : {}), ...(saved.fieldChanges.length ? { field_rules: saved.fieldChanges } : {}),
      ...(name !== role.name ? { name_changed: true } : {}), ...(description !== role.description ? { description_changed: true } : {}) } });
  return publicRole(await resolveRole(tx, encodeId(prefix, role.id), null, kind), await activeMembers(tx, role.id, kind), publicRules(schema, rules), kind);
}

/**
 * Archives a custom role or a permission set. Refused while any active member holds it; disabled holders
 * keep a role until re-enabled with another one, and simply no longer have an archived set.
 */
export async function archiveRole(tx: Tx, ctx: Ctx, ref: string, kind: RoleKind = "role") {
  const { noun, plural, prefix, audit: auditName } = KIND[kind];
  if (!can(ctx, "roles:manage")) throw forbidden(`Archiving ${plural} needs the roles:manage permission`);
  const role = await resolveRole(tx, ref, "update", kind);
  if (role.is_system) throw forbidden("System roles can't be archived");
  if (holds(ctx, kind, role.key)) throw forbidden(`You can't archive a ${noun} you hold`);
  const n = await activeMembers(tx, role.id, kind);
  if (n > 0) throw conflict(kind === "role" ? `${n} active member(s) hold this role; give them another role first`
    : `${n} active member(s) hold this permission set; take it away from them first`);
  await archiveRoleRow(tx, role.id);
  await audit(tx, ctx, { action: `${auditName}.archived`, objectType: auditName, recordId: role.id, details: { key: role.key, permissions: role.permissions } });
  return { id: encodeId(prefix, role.id), key: role.key, archived: true };
}
