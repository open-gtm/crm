import type { Tx } from "../db/pool.js";
import { forbidden } from "../lib/errors.js";
import {
  RECORD_ACTIONS, without, type Ctx, type FieldLimit, type ObjectRule, type Permission, type RecordAccess, type RecordAction,
} from "./context.js";
import { roleRuleRows } from "./queries/roles.js";
import type { FieldMeta, ObjectMeta, Schema } from "./schema.js";

/**
 * Per-object and per-field record access (ADR 0008). A role's records:read/write/archive are the
 * default for every object; an object rule overrides one action for one object, either way; a field
 * rule only takes away (none: not visible, read: not writable). Contexts without `records` (system,
 * automations, alerts, the worker) follow their permissions alone, exactly as before.
 */

export type FieldAccess = "none" | "read" | "write";
export interface RoleRules { objects: Map<string, ObjectRule>; fields: Map<string, FieldLimit> }

const PERMISSION: Record<RecordAction, Permission> = { read: "records:read", write: "records:write", archive: "records:archive" };
const RANK: Record<FieldAccess, number> = { none: 0, read: 1, write: 2 };
const VERB: Record<RecordAction, string> = { read: "read", write: "create or change", archive: "archive" };

// ----------------------------------------------------------------------------------------------
// Loading

/** Rules per role, valid for one access_version (bumped with every rule change), so each process reloads on change. */
const cache = new Map<string, { version: string; rules: RoleRules }>();
const CACHE_MAX = 10_000;

/** A role's rules: one query on a cache miss, none on a hit. */
export async function loadRoleRules(tx: Tx, tenantId: string, roleId: string, accessVersion: string | number): Promise<RoleRules> {
  const key = `${tenantId}:${roleId}`;
  const version = String(accessVersion);
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.rules;
  const rows = await roleRuleRows(tx, roleId);
  const rules: RoleRules = { objects: new Map(), fields: new Map() };
  for (const r of rows) {
    if (r.kind === "o") rules.objects.set(r.id, { read: r.can_read, write: r.can_write, archive: r.can_archive });
    else rules.fields.set(r.id, r.access!);
  }
  cache.delete(key);
  cache.set(key, { version, rules });
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(k);
  }
  return rules;
}

export const hasRules = (r: RoleRules) => r.objects.size > 0 || r.fields.size > 0;

/** Record permissions some object rule grants: they make a key scope usable for the role. */
export function grantedPermissions(rules: RoleRules): Permission[] {
  return RECORD_ACTIONS.filter((a) => [...rules.objects.values()].some((r) => r[a] === true)).map((a) => PERMISSION[a]);
}

/** The record actions a permission set unlocks: for a key, what its scopes let an object rule grant. */
export const unlockedBy = (permissions: Iterable<string>): Set<RecordAction> => {
  const have = new Set(permissions);
  return new Set(RECORD_ACTIONS.filter((a) => have.has(PERMISSION[a])));
};

/** The `records` part of a context, or undefined when the role has no rules (its permissions then say everything). */
export function recordAccess(rules: RoleRules, unlocked: Iterable<RecordAction>, version: string): RecordAccess | undefined {
  return hasRules(rules) ? { objects: rules.objects, fields: rules.fields, unlocked: new Set(unlocked), version } : undefined;
}

/**
 * A context with a role's own access, not narrowed by any key: for checking what a role allows
 * (role editing, assignment, notification recipients). Never carries restricted values unless asked.
 */
export function roleCtx(base: Pick<Ctx, "tenantId" | "requestId">, role: { key: string; permissions: readonly string[] }, rules: RoleRules,
  version: string, opts: { restricted?: boolean } = {}): Ctx {
  const permissions = new Set(role.permissions as Permission[]);
  const ctx: Ctx = {
    tenantId: base.tenantId, actor: { type: "system", id: null, role: role.key }, keyId: null, permissions, scopes: new Set(),
    surface: "system", requestId: base.requestId, ...(hasRules(rules) ? { records: recordAccess(rules, RECORD_ACTIONS, version)! } : {}),
  };
  return opts.restricted ? ctx : without(ctx, "restricted:read");
}

/**
 * A context that reads every field of every object, without restricted values: for internal work on
 * behalf of a caller (search text, event before-values) whose result the caller never sees directly.
 */
export function internalReader(ctx: Ctx): Ctx {
  return { tenantId: ctx.tenantId, actor: ctx.actor, keyId: ctx.keyId, permissions: new Set(["records:read"]), scopes: new Set(["ops:read"]),
    surface: ctx.surface, requestId: ctx.requestId };
}

// ----------------------------------------------------------------------------------------------
// Decisions

function allows(ctx: Ctx, rule: ObjectRule, a: RecordAction): boolean {
  const v = rule[a];
  return v === null ? ctx.permissions.has(PERMISSION[a]) : v && ctx.records!.unlocked.has(a);
}

/** Can this caller do `action` on records of `obj`? Write needs read and archive needs write, on any object with a rule. */
export function canObject(ctx: Ctx, obj: { id: string }, action: RecordAction): boolean {
  const rule = ctx.records?.objects.get(obj.id);
  if (!rule) return ctx.permissions.has(PERMISSION[action]);
  if (!allows(ctx, rule, "read")) return false;
  if (action === "read") return true;
  if (!allows(ctx, rule, "write")) return false;
  return action === "write" || allows(ctx, rule, "archive");
}

/** Can the caller do `action` on at least one object? The route gate admits on this; the service layer decides per object. */
export function canAnyObject(ctx: Ctx, action: RecordAction): boolean {
  if (ctx.permissions.has(PERMISSION[action])) return true;
  for (const [id] of ctx.records?.objects ?? []) if (canObject(ctx, { id }, action)) return true;
  return false;
}

/** What the caller can do with one field: none (absent from responses), read, or write. Restricted values are governed separately by restricted:read. */
export function fieldAccess(ctx: Ctx, obj: ObjectMeta, f: FieldMeta): FieldAccess {
  if (!canObject(ctx, obj, "read")) return "none";
  const limit = ctx.records?.fields.get(f.id);
  if (limit === "none") return "none";
  if (limit === "read") return "read";
  return canObject(ctx, obj, "write") ? "write" : "read";
}

/**
 * True when some field of `obj` is hidden (`none`) for this caller. Search, event payloads and
 * notification titles take a stricter path then. A `read` rule only stops writes, so it doesn't count.
 */
export function hasHiddenFields(ctx: Ctx, obj: ObjectMeta): boolean {
  const fields = ctx.records?.fields;
  return Boolean(fields?.size) && obj.fields.some((f) => fields!.get(f.id) === "none");
}

/** True when the caller can read this field of `obj` (by name). Unknown names count as readable: validation reports them. */
export function canReadField(ctx: Ctx, obj: ObjectMeta, name: string): boolean {
  const f = obj.byName.get(name);
  return !f || fieldAccess(ctx, obj, f) !== "none";
}

export function assertObject(ctx: Ctx, obj: ObjectMeta, action: RecordAction): void {
  if (!canObject(ctx, obj, action)) throw forbidden(`This key can't ${VERB[action]} ${obj.api_name} records`);
}

/** Refuses writing any of `names` the caller can't write, naming them. Unknown names are left to validation. */
export function assertWritable(ctx: Ctx, obj: ObjectMeta, names: Iterable<string>): void {
  assertObject(ctx, obj, "write");
  const denied = [...names].filter((n) => {
    const f = obj.byName.get(n);
    return f && fieldAccess(ctx, obj, f) !== "write";
  });
  if (denied.length) throw forbidden(`This key can't write ${denied.map((n) => `${obj.api_name}.${n}`).join(", ")}`);
}

/** For the query compiler: which objects and fields a filter or sort may touch. Values could otherwise be inferred. */
export interface AccessGuard { object(name: string): boolean; field(object: string, field: string): boolean }

const BUILTIN_FIELDS = new Set(["id", "created_at", "updated_at"]);

export function accessGuard(ctx: Ctx, schema: Schema): AccessGuard | undefined {
  if (!ctx.records) return undefined;
  return {
    object: (name) => {
      const o = schema.objects.get(name);
      return !o || canObject(ctx, o, "read"); // user, pipeline and stage are entities, not record objects
    },
    field: (object, field) => {
      const o = schema.objects.get(object);
      const f = o?.byName.get(field);
      return !o || !f || BUILTIN_FIELDS.has(field) || fieldAccess(ctx, o, f) !== "none";
    },
  };
}

// ----------------------------------------------------------------------------------------------
// Comparing and describing access

/**
 * What `target` can do that `ctx` can't, per object and per field, e.g. ["deal: read", "contact.email: read"].
 * Used so nobody grants (by editing or assigning a role, or minting a key) record access they don't have.
 */
export function accessShortfall(ctx: Ctx, schema: Schema, target: Ctx): string[] {
  const out: string[] = [];
  for (const o of schema.objects.values()) {
    const missing = RECORD_ACTIONS.filter((a) => canObject(target, o, a) && !canObject(ctx, o, a));
    if (missing.length) {
      out.push(`${o.api_name}: ${missing.join(", ")}`);
      continue;
    }
    for (const f of o.fields) {
      const want = fieldAccess(target, o, f);
      if (RANK[want] > RANK[fieldAccess(ctx, o, f)]) out.push(`${o.api_name}.${f.api_name}: ${want}`);
    }
  }
  return out;
}

/** The access view for admins and agents: per object, read/write/archive and the fields that are limited or restricted. */
export function describeAccess(ctx: Ctx, schema: Schema) {
  const restricted = ctx.permissions.has("restricted:read");
  return [...schema.objects.values()].filter((o) => !o.module || schema.modules.includes(o.module)).map((o) => {
    const rule = ctx.records?.objects.get(o.id);
    const limited = o.fields.filter((f) => ctx.records?.fields.has(f.id));
    return {
      object: o.api_name,
      read: canObject(ctx, o, "read"), write: canObject(ctx, o, "write"), archive: canObject(ctx, o, "archive"),
      rule: rule ? { read: rule.read, write: rule.write, archive: rule.archive } : null,
      fields: Object.fromEntries(limited.map((f) => [f.api_name, fieldAccess(ctx, o, f)])),
      restricted_fields: o.fields.filter((f) => f.sensitivity === "restricted").map((f) => ({ field: f.api_name, values: restricted ? "visible" : "redacted" })),
    };
  });
}
