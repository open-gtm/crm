import type { Tx } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { ApiError, conflict, deadline, forbidden, notFound, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { decodeId, encodeId, VIEW_ID_PREFIX } from "../lib/ids.js";
import { SERVER_VERSION } from "../lib/version.js";
import { loadRoleRules } from "./access.js";
import type { GroupBy } from "./aggregate.js";
import { audit } from "./audit.js";
import { issueConfirm, readConfirm, spendConfirm } from "./confirm.js";
import { can, type Ctx, type Permission } from "./context.js";
import { dependencies, fieldOfName, writes } from "./automation-access.js";
import type { AutomationRow } from "./automation-defs.js";
import { DISGUISING } from "./fieldtypes.js";
import { listPipelines } from "./pipelines.js";
import type { SortInput, Where } from "./query.js";
import { archiveRole, createRole, publicRules, resolveRole, updateRole } from "./roles.js";
import {
  archiveField, confirmToken, countValues, loadSchema, lockSchema, MAX_CUSTOM_OBJECTS, MAX_FIELDS, recordChange, type FieldMeta, type ObjectMeta, type Schema,
} from "./schema.js";
import { runSchemaDocument, type DocObject, type DocPipeline, type PlannedChange, type Problem } from "./schemadoc.js";
import { createView, deleteView, updateView } from "./views.js";
import { actorRef } from "./webhooks.js";

/**
 * Schema packs: a shareable bundle (a manifest, a schema document, and optionally roles and shared views)
 * that sets a workspace up for a use case. The server is the only place a pack is checked and applied:
 * the CLI reads the files and sends them; plan runs the whole install in a savepoint and rolls it back,
 * and apply makes it in the request's one transaction, through the same functions every other surface
 * uses (schema document apply, role and view editing), so every rule those enforce holds here too.
 *
 * What a pack owns is recorded in installed_packs by ID, from pack-local names: an upgrade changes only
 * that, an uninstall archives only that, and a pack never touches an object, field, role, view or pipeline
 * it didn't create (a same-named one is reported, not adopted). With each, the pack records what it last
 * wrote (a fingerprint of the properties it sets; a view's version): a re-apply or upgrade keeps what a
 * person changed since then (a role tightened, a view edited), and reports it, unless the request says
 * overwrite_changes, which lists each overwritten item before and after and needs confirm_access_changes
 * when it would widen access. Standard objects can gain fields from a
 * pack but are never changed by one. A pack is untrusted input: its names and descriptions are data, it
 * can't grant more than its installer holds, and it can't carry automations, webhooks, keys or members.
 *
 * Extension point (not built): automations. A later version can add an "automations" part once their
 * format settles: it would need a stable automation identity for owned-ID tracking, a check that its
 * actions send nothing outside (no send_webhook or email to addresses the pack names), the escalation
 * check automations:manage implies (it needs full record access), and archive-on-uninstall.
 */

export type PackPart = "schema" | "roles" | "views";
export const PACK_PARTS: readonly PackPart[] = ["schema", "roles", "views"];

export interface PackManifest {
  name: string;
  version: string;
  description?: string;
  min_server_version?: string;
  modules?: string[];
  parts: PackPart[];
  license?: string;
}
export interface PackRole {
  key: string;
  name: string;
  description?: string;
  permissions: string[];
  objects?: Record<string, { read?: boolean | null; write?: boolean | null; archive?: boolean | null }>;
  fields?: Record<string, Record<string, "none" | "read">>;
}
export interface PackView { name: string; object: string; where?: Where; sort?: SortInput[]; columns?: string[]; group_by?: GroupBy[] }
export interface Pack { manifest: PackManifest; schema?: { objects?: DocObject[]; pipelines?: DocPipeline[] }; roles?: PackRole[]; views?: PackView[] }

/** Bounds on what one pack can ask for, so a hostile pack can't make one request do unbounded work. */
export const PACK_LIMITS = {
  objects: 30, fieldsPerObject: 100, fields: 600, pipelines: 5, stagesPerPipeline: 30, roles: 20, views: 50,
  description: 1_000, version: 20, license: 100, modules: 10, module: 20, parts: 5, part: 20, idPrefix: 8,
  roleKey: 40, roleName: 100, permissionsPerRole: 20, permission: 40,
  viewName: 100, viewSortKeys: 3, viewColumns: 100, viewGroupKeys: 2,
} as const;
/**
 * What a pack's roles may grant: record work and shared views. Roles that manage members, keys, roles,
 * webhooks, automations, alerts, the schema or the audit log are a workspace's own decision, not a pack's.
 */
export const PACK_ROLE_PERMISSIONS: readonly Permission[] = ["records:read", "records:write", "records:archive", "restricted:read", "views:manage"];
const SYSTEM_ROLE_KEYS = new Set(["owner", "admin", "member", "read_only"]);
const NEEDS: Record<PackPart, Permission> = { schema: "schema:manage", roles: "roles:manage", views: "views:manage" };

const NAME = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

/** What a pack last wrote to something it owns: a fingerprint of the properties it sets (roles: with their access_version). */
interface Written { objects: Record<string, string>; fields: Record<string, string>; pipelines: Record<string, string>; roles: Record<string, { access_version: string; fp: string }> }
/** Who owns what, by pack-local name: what an upgrade may change and an uninstall archives. */
interface Owned {
  objects: Record<string, string>;
  fields: Record<string, string>;
  pipelines: Record<string, string>;
  roles: Record<string, string>;
  /** A view's version is what the pack last wrote to it. */
  views: Record<string, { id: string; version: number }>;
  written: Written;
}
type OwnedKind = Exclude<keyof Owned, "written">;
interface PackRow { name: string; version: string; status: "installed" | "uninstalled"; description: string; owned: Owned; installed_at: Date; installed_by: string | null; updated_at: Date }

const nullMap = <T>(src: unknown): Record<string, T> => {
  const m = Object.create(null) as Record<string, T>;
  for (const [name, v] of Object.entries(src && typeof src === "object" ? src : {})) m[name] = v as T;
  return m;
};
/**
 * A copy with null-prototype maps: keys are pack-local names, which may be anything a pack author typed. A row
 * written before fingerprints were kept has no `written`: everything in it counts as possibly changed (kept).
 */
function ownedFrom(raw: unknown): Owned {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const w = (src.written && typeof src.written === "object" ? src.written : {}) as Record<string, unknown>;
  return {
    objects: nullMap(src.objects), fields: nullMap(src.fields), pipelines: nullMap(src.pipelines), roles: nullMap(src.roles), views: nullMap(src.views),
    written: { objects: nullMap(w.objects), fields: nullMap(w.fields), pipelines: nullMap(w.pipelines), roles: nullMap(w.roles) },
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)?.slice(1).map(Number) ?? [0, 0, 0];
  const pb = SEMVER.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}

/**
 * Text a pack shows (its description): plain, bounded, no control characters but line breaks and tabs, and none
 * of the characters that make text display as something else (C1 controls, line separators, bidi controls).
 */
function plainText(v: unknown, what: string, max: number): void {
  if (v === undefined) return;
  if (typeof v !== "string" || v.length > max || [...v].some((c) => (c < " " && c !== "\n" && c !== "\t") || c === "\u007f") || DISGUISING.test(v)) {
    throw unprocessable(`${what} must be plain text of at most ${max} characters`);
  }
}

/** Checks a pack's manifest and parts before anything is read from the workspace. Every refusal is a 422 naming what to fix. */
export function validatePack(pack: Pack): void {
  const m = pack.manifest;
  if (!m || typeof m !== "object") throw unprocessable("A pack needs a manifest");
  if (typeof m.name !== "string" || !NAME.test(m.name)) throw unprocessable("manifest.name must be 2 to 63 lowercase letters, digits and hyphens, starting with a letter");
  if (typeof m.version !== "string" || !SEMVER.test(m.version)) throw unprocessable("manifest.version must be MAJOR.MINOR.PATCH, e.g. 1.0.0");
  plainText(m.description, "manifest.description", PACK_LIMITS.description);
  plainText(m.license, "manifest.license", PACK_LIMITS.license);
  if (m.min_server_version !== undefined) {
    if (!SEMVER.test(m.min_server_version)) throw unprocessable("manifest.min_server_version must be MAJOR.MINOR.PATCH");
    if (SEMVER.test(SERVER_VERSION) && compareVersions(SERVER_VERSION, m.min_server_version) < 0) {
      throw unprocessable(`This pack needs server version ${m.min_server_version} or later; this server is ${SERVER_VERSION}`);
    }
  }
  if (!Array.isArray(m.parts) || m.parts.length === 0) throw unprocessable("manifest.parts lists the parts the pack holds: schema, roles, views");
  for (const p of m.parts as string[]) {
    if (p === "automations") throw unprocessable("Packs can't carry automations in this version; leave them out of the pack");
    if (!(PACK_PARTS as string[]).includes(p)) throw unprocessable(`manifest.parts: "${String(p).slice(0, 40)}" is not a part; use schema, roles or views`);
  }
  if (new Set(m.parts).size !== m.parts.length) throw unprocessable("manifest.parts names a part twice");
  // The manifest says what the pack holds: a part it lists must be there, and one it doesn't list must not be.
  for (const p of PACK_PARTS) {
    const present = pack[p] !== undefined;
    if (present !== m.parts.includes(p)) {
      throw unprocessable(present ? `The pack holds a ${p} part that its manifest doesn't list` : `The manifest lists a ${p} part that the pack doesn't hold`);
    }
  }
  const objects = pack.schema?.objects ?? [];
  if (objects.length > PACK_LIMITS.objects) throw unprocessable(`A pack can define at most ${PACK_LIMITS.objects} objects`);
  let fields = 0;
  for (const o of objects) {
    if ((o.fields ?? []).length > PACK_LIMITS.fieldsPerObject) throw unprocessable(`objects.${o.name}: a pack can define at most ${PACK_LIMITS.fieldsPerObject} fields per object`);
    fields += (o.fields ?? []).length;
  }
  if (fields > PACK_LIMITS.fields) throw unprocessable(`A pack can define at most ${PACK_LIMITS.fields} fields`);
  if ((pack.schema?.pipelines ?? []).length > PACK_LIMITS.pipelines) throw unprocessable(`A pack can define at most ${PACK_LIMITS.pipelines} pipelines`);
  // The default pipeline is the workspace's choice: a pack's pipeline never replaces it.
  if ((pack.schema?.pipelines ?? []).some((p) => p.is_default)) throw unprocessable("A pack's pipeline can't be the default pipeline");
  const roles = pack.roles ?? [];
  if (roles.length > PACK_LIMITS.roles) throw unprocessable(`A pack can define at most ${PACK_LIMITS.roles} roles`);
  const keys = new Set<string>();
  for (const r of roles) {
    if (keys.has(r.key)) throw unprocessable(`roles: "${r.key}" appears twice`);
    keys.add(r.key);
    if (SYSTEM_ROLE_KEYS.has(r.key)) throw unprocessable(`roles.${r.key}: system roles can't be changed by a pack; give the role another key`);
    plainText(r.description, `roles.${r.key}.description`, PACK_LIMITS.description);
    const extra = (r.permissions ?? []).filter((p) => !(PACK_ROLE_PERMISSIONS as string[]).includes(p));
    if (extra.length) {
      throw unprocessable(`roles.${r.key}: a pack's roles can hold only ${PACK_ROLE_PERMISSIONS.join(", ")}; not ${extra.map((p) => String(p).slice(0, 40)).join(", ")}`);
    }
  }
  const views = pack.views ?? [];
  if (views.length > PACK_LIMITS.views) throw unprocessable(`A pack can define at most ${PACK_LIMITS.views} views`);
  // A pack that holds nothing would own nothing, so nothing would check who may install or uninstall it.
  if (objects.length + (pack.schema?.pipelines ?? []).length + roles.length + views.length === 0) {
    throw unprocessable("A pack must hold at least one object, pipeline, role or view");
  }
  const viewKeys = new Set<string>();
  for (const v of views) {
    const k = `${v.object}/${v.name}`;
    if (viewKeys.has(k)) throw unprocessable(`views: "${v.name}" on ${v.object} appears twice`);
    viewKeys.add(k);
  }
}

/** The permissions installing (or uninstalling) these parts needs, all of them: a pack is applied whole or not at all. */
function requireParts(ctx: Ctx, parts: Iterable<PackPart>, verb: string): void {
  const missing = [...new Set([...parts].map((p) => NEEDS[p]))].filter((p) => !can(ctx, p));
  if (missing.length) throw forbidden(`${verb} this pack needs ${missing.join(", ")}, which this key doesn't have`);
}

/**
 * Any pack request needs one of the three manage permissions first (the routes check it at the gate too), before
 * any lock or row read: so a caller without them learns nothing, not even whether a pack of that name exists.
 */
function requireAnyPart(ctx: Ctx, verb: string): void {
  if (!PACK_PARTS.some((p) => can(ctx, NEEDS[p]))) throw forbidden(`${verb} packs needs schema:manage, roles:manage or views:manage`);
}

async function loadRow(tx: Tx, name: string, lock: boolean): Promise<PackRow | undefined> {
  const [row] = lock
    ? await tx<PackRow[]>`SELECT * FROM installed_packs WHERE name = ${name} FOR UPDATE`
    : await tx<PackRow[]>`SELECT * FROM installed_packs WHERE name = ${name}`;
  return row ? { ...row, owned: ownedFrom(row.owned) } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Install, upgrade and re-apply

/** Something a person changed since the pack wrote it, left as it is. */
export interface Kept { path: string; message: string }
/** Something a person changed that overwrite_changes replaces: the workspace's copy and the pack's, and what of it widens access. */
export interface Overwrite { path: string; before: unknown; after: unknown; widens_access?: string[] }
interface PackRun { changes: PlannedChange[]; unsupported: Problem[]; notes: string[]; kept: Kept[]; overwritten: Overwrite[]; owned: Owned }

/** JSON with sorted keys, so equal definitions compare equal whatever order a file gave them in. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined && (v as Record<string, unknown>)[k] !== null).sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const fingerprint = (v: unknown) => sha256(canon(v)).toString("hex").slice(0, 32);
/** IDs a dry run makes up (a new stage's) differ between two runs of the same plan; a plan's hash leaves them out. */
const ID_LIKE = /^(?:(?:[a-z]{2,8}|v)_[0-9A-Za-z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const withoutIds = (v: unknown): unknown => (typeof v === "string" ? (ID_LIKE.test(v) ? "#id" : v) : Array.isArray(v) ? v.map(withoutIds)
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutIds(x)])) : v);
const planHash = (v: unknown) => sha256(canon(withoutIds(v))).toString("hex");

// --- What a pack sets on each thing it owns, as the workspace has it now --------------------------------

const objectProps = (o: ObjectMeta) => ({ label: o.label, plural_label: o.plural_label, description: o.description, display_field: o.display_field, hidden: o.hidden });
const fieldProps = (f: FieldMeta) => ({
  name: f.api_name, type: f.type, label: f.label, description: f.description, required: f.required, hidden: f.hidden, sensitivity: f.sensitivity,
  default: f.default_value, validation: f.validation, options: f.options,
});
type Pipe = Awaited<ReturnType<typeof listPipelines>>[number];
const pipelineProps = (p: Pipe) => ({ name: p.name, stages: p.stages.map((s) => ({ name: s.name, category: s.category, probability: s.default_probability })) });
type RuleAction = "read" | "write" | "archive";
interface RoleProps { name: string; description: string; permissions: string[]; objects: Record<string, Partial<Record<RuleAction, boolean | null>>>; fields: Record<string, Record<string, string>> }

interface Snap { props: unknown; fp: string; accessVersion?: string }

/**
 * Each live thing the pack owns, keyed by path (objects.x, fields.x.y, pipelines.x, roles.x, views.x/y): what it
 * looks like now, and its fingerprint (a view: its version). A role's is taken over its rules by ID, so renaming
 * a field it limits doesn't look like a change to the role.
 */
async function snapshot(tx: Tx, ctx: Ctx, owned: Owned): Promise<Map<string, Snap>> {
  const out = new Map<string, Snap>();
  const schema = await loadSchema(tx);
  for (const [name, id] of Object.entries(owned.objects)) {
    const o = schema.byId.get(id);
    if (o) out.set(`objects.${name}`, { props: objectProps(o), fp: fingerprint(objectProps(o)) });
  }
  for (const [key, id] of Object.entries(owned.fields)) {
    const f = [...schema.objects.values()].flatMap((o) => o.fields).find((x) => x.id === id);
    if (f) out.set(`fields.${key}`, { props: fieldProps(f), fp: fingerprint(fieldProps(f)) });
  }
  if (Object.keys(owned.pipelines).length) {
    const pipes = await listPipelines(tx);
    for (const [name, id] of Object.entries(owned.pipelines)) {
      const p = pipes.find((x) => x.id === id);
      if (p) out.set(`pipelines.${name}`, { props: pipelineProps(p), fp: fingerprint(pipelineProps(p)) });
    }
  }
  for (const [key, id] of Object.entries(owned.roles)) {
    const [r] = await tx<{ id: string; name: string; description: string; permissions: string[]; access_version: string }[]>`
      SELECT id, name, description, permissions, access_version::text FROM roles WHERE id = ${id} AND archived_at IS NULL`;
    if (!r) continue;
    const rules = await loadRoleRules(tx, ctx.tenantId, r.id, r.access_version);
    const pub = publicRules(schema, rules);
    const props: RoleProps = { name: r.name, description: r.description, permissions: [...r.permissions].sort(), objects: pub.objects, fields: pub.fields };
    const fp = fingerprint({ name: r.name, description: r.description, permissions: props.permissions,
      objects: [...rules.objects].sort(([a], [b]) => a.localeCompare(b)), fields: [...rules.fields].sort(([a], [b]) => a.localeCompare(b)) });
    out.set(`roles.${key}`, { props, fp, accessVersion: r.access_version });
  }
  for (const [key, v] of Object.entries(owned.views)) {
    const [r] = await tx<{ name: string; definition: unknown; version: number }[]>`SELECT name, definition, version FROM views WHERE id = ${v.id}`;
    if (r) out.set(`views.${key}`, { props: { name: r.name, ...(r.definition as object) }, fp: String(r.version) });
  }
  return out;
}

const kindOf = (path: string) => path.slice(0, path.indexOf(".")) as OwnedKind;
const keyOf = (path: string) => path.slice(path.indexOf(".") + 1);
/** What the pack last wrote at `path`, as snapshot() fingerprints it; undefined when it never recorded it. */
function writtenAt(owned: Owned, path: string): string | undefined {
  const kind = kindOf(path);
  const key = keyOf(path);
  if (kind === "views") return owned.views[key] ? String(owned.views[key]!.version) : undefined;
  if (kind === "roles") return owned.written.roles[key]?.fp;
  return owned.written[kind][key];
}
function recordWritten(owned: Owned, path: string, s: Snap): void {
  const kind = kindOf(path);
  const key = keyOf(path);
  if (kind === "views") owned.views[key] = { ...owned.views[key]!, version: Number(s.fp) };
  else if (kind === "roles") owned.written.roles[key] = { access_version: s.accessVersion!, fp: s.fp };
  else owned.written[kind][key] = s.fp;
}
/** Drops what the pack no longer owns from `written`, so it stays the size of what it owns. */
function pruneWritten(owned: Owned): void {
  for (const kind of ["objects", "fields", "pipelines", "roles"] as const) {
    for (const key of Object.keys(owned.written[kind])) if (!Object.hasOwn(owned[kind], key)) delete owned.written[kind][key];
  }
}

const FIELD_RANK: Record<string, number> = { none: 0, read: 1 };
const SENSITIVITY_RANK: Record<string, number> = { standard: 0, confidential: 1, restricted: 2 };
/** How `after` gives more access than `before`: a permission added, a deny removed, an allow added, a field limit loosened or removed. */
function widening(path: string, before: unknown, after: unknown): string[] {
  const out: string[] = [];
  if (path.startsWith("fields.")) {
    const b = (before as { sensitivity: string }).sensitivity;
    const a = (after as { sensitivity: string }).sensitivity;
    if ((SENSITIVITY_RANK[a] ?? 0) < (SENSITIVITY_RANK[b] ?? 0)) out.push(`lowers ${keyOf(path)} from ${b} to ${a}`);
    return out;
  }
  if (!path.startsWith("roles.")) return out;
  const b = before as RoleProps;
  const a = after as RoleProps;
  for (const p of a.permissions) if (!b.permissions.includes(p)) out.push(`grants ${p}`);
  for (const o of new Set([...Object.keys(b.objects), ...Object.keys(a.objects)])) {
    for (const act of ["read", "write", "archive"] as const) {
      const x = b.objects[o]?.[act] ?? null;
      const y = a.objects[o]?.[act] ?? null;
      if (x === false && y !== false) out.push(`removes the ${act} deny on ${o}`);
      else if (y === true && x !== true) out.push(`allows ${act} on ${o}`);
    }
  }
  for (const o of new Set([...Object.keys(b.fields), ...Object.keys(a.fields)])) {
    for (const f of new Set([...Object.keys(b.fields[o] ?? {}), ...Object.keys(a.fields[o] ?? {})])) {
      const x = b.fields[o]?.[f];
      const y = a.fields[o]?.[f];
      if ((y === undefined ? 2 : FIELD_RANK[y] ?? 2) > (x === undefined ? 2 : FIELD_RANK[x] ?? 2)) {
        out.push(y === undefined ? `removes the ${x} limit on ${o}.${f}` : `loosens ${o}.${f} from ${x} to ${y}`);
      }
    }
  }
  return out;
}

/**
 * The pack's schema as a schema document for this workspace: what the pack owns gets its workspace ID (so
 * it is matched, and changed, by ID); a standard object takes only new fields; anything else of the same
 * name that the pack didn't create is reported, never adopted. What a person changed since the pack wrote it
 * (`skip`) is left out: an object keeps its own properties (its fields still follow the pack), a field or
 * pipeline is left out whole.
 */
function toDocument(schema: Schema, pack: Pack, owned: Owned, pipelines: { id: string; name: string }[], unsupported: Problem[], skip: Set<string>) {
  const objects: DocObject[] = [];
  for (const o of pack.schema?.objects ?? []) {
    const path = `objects.${o.name}`;
    const ownedId = owned.objects[o.name];
    const ws = ownedId ? schema.byId.get(ownedId) : schema.objects.get(o.name);
    let entry: DocObject;
    if (ownedId && ws) entry = skip.has(path) ? { name: o.name, id: encodeId("obj", ownedId) } : { ...o, id: encodeId("obj", ownedId) };
    else if (ws?.is_system) {
      const changed = Object.keys(o).filter((k) => k !== "name" && k !== "fields");
      if (changed.length) unsupported.push({ path, message: `A pack can add fields to the standard object ${o.name} but not change it (${changed.join(", ")})` });
      entry = { name: o.name };
    } else if (ws) {
      unsupported.push({ path, message: `An object named "${o.name}" already exists in this workspace and this pack didn't create it` });
      continue;
    } else entry = { ...o };
    entry.fields = [];
    for (const f of o.fields ?? []) {
      const fid = owned.fields[`${o.name}.${f.name}`];
      if (fid && ws?.fields.some((x) => x.id === fid)) {
        if (!skip.has(`fields.${o.name}.${f.name}`)) entry.fields.push({ ...f, id: encodeId("fld", fid) });
      } else if (ws?.byName.has(f.name)) {
        unsupported.push({ path: `${path}.fields.${f.name}`, message: `A field named "${f.name}" already exists on ${o.name} and this pack didn't create it` });
      } else entry.fields.push({ ...f });
    }
    objects.push(entry);
  }
  const pipes: DocPipeline[] = [];
  for (const p of pack.schema?.pipelines ?? []) {
    const ownedId = owned.pipelines[p.name];
    const found = ownedId ? pipelines.find((x) => x.id === ownedId) : pipelines.find((x) => x.name === p.name);
    if (!ownedId && found) {
      unsupported.push({ path: `pipelines.${p.name}`, message: `A pipeline named "${p.name}" already exists in this workspace and this pack didn't create it` });
      continue;
    }
    if (found && skip.has(`pipelines.${p.name}`)) continue;
    pipes.push(found ? { ...p, id: found.id } : { ...p });
  }
  return { objects, pipelines: pipes };
}

/**
 * Brings back what an uninstall archived, but only what the pack being applied still lists, within the
 * workspace's limits: an older or smaller pack of the same name restores no more than its own manifest
 * describes. Records and values coming back are data changes (they need confirm_data_changes). Roles and
 * views an uninstall archived or deleted are made again by the steps that follow.
 */
async function restore(tx: Tx, ctx: Ctx, pack: Pack, owned: Owned, run: PackRun): Promise<void> {
  const listed = new Set((pack.schema?.objects ?? []).map((o) => o.name));
  const listedFields = new Set((pack.schema?.objects ?? []).flatMap((o) => (o.fields ?? []).map((f) => `${o.name}.${f.name}`)));
  let live = [...(await loadSchema(tx)).objects.values()].filter((o) => !o.is_system).length;
  for (const [name, id] of Object.entries(owned.objects)) {
    const [o] = await tx<{ archived_at: Date | null }[]>`SELECT archived_at FROM objects WHERE id = ${id}`;
    if (!o) {
      delete owned.objects[name];
      continue;
    }
    if (!o.archived_at) continue;
    if (!listed.has(name)) {
      run.notes.push(`objects.${name}: archived when the pack was uninstalled, and not in this version of it; left archived`);
      continue;
    }
    if (live >= MAX_CUSTOM_OBJECTS) throw unprocessable(`objects.${name}: restoring it would pass the limit of ${MAX_CUSTOM_OBJECTS} custom objects`);
    live++;
    const [held] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM records WHERE object_id = ${id} AND archived_at IS NULL LIMIT 10001) s`;
    await tx`UPDATE objects SET archived_at = NULL, updated_at = now() WHERE id = ${id}`;
    const change = { change: "object_restored", object: name };
    await recordChange(tx, ctx, { ...change, object_id: id });
    run.changes.push({ ...change, ...(held!.n ? { warning: `${held!.n} record(s) come back with it`, data_affecting: true } : {}) });
  }
  for (const [key, id] of Object.entries(owned.fields)) {
    const [f] = await tx<(FieldMeta & { archived_at: Date | null })[]>`
      SELECT id, api_name, object_id, type, storage_key, sensitivity, archived_at FROM fields WHERE id = ${id}`;
    if (!f) {
      delete owned.fields[key];
      continue;
    }
    if (!f.archived_at) continue;
    if (!listedFields.has(key)) {
      run.notes.push(`fields.${key}: archived when the pack was uninstalled, and not in this version of it; left archived`);
      continue;
    }
    const [taken] = await tx`SELECT 1 FROM fields WHERE object_id = ${f.object_id} AND api_name = ${f.api_name} AND archived_at IS NULL`;
    if (taken) {
      delete owned.fields[key];
      run.notes.push(`fields.${key}: its name was taken while the pack was uninstalled; its old values stay archived`);
      continue;
    }
    const obj = (await loadSchema(tx)).byId.get(f.object_id);
    if (!obj) continue; // its object is archived: the field comes back with it
    if (obj.fields.length >= MAX_FIELDS) throw unprocessable(`fields.${key}: restoring it would pass the limit of ${MAX_FIELDS} fields on ${obj.api_name}`);
    const values = await countValues(tx, obj, f);
    await tx`UPDATE fields SET archived_at = NULL, updated_at = now() WHERE id = ${id}`;
    const [object, field] = key.split(".");
    const change = { change: "field_restored", object: object!, field: field! };
    await recordChange(tx, ctx, { ...change, object_id: f.object_id, field_id: id });
    run.changes.push({ ...change, ...(values ? { warning: `${values} record(s) have their value back`, data_affecting: true } : {}) });
  }
  for (const [key, id] of Object.entries(owned.roles)) {
    const [r] = await tx`SELECT 1 FROM roles WHERE id = ${id} AND archived_at IS NULL`;
    if (!r) delete owned.roles[key];
  }
  for (const [key, v] of Object.entries(owned.views)) {
    const [r] = await tx`SELECT 1 FROM views WHERE id = ${v.id}`;
    if (!r) delete owned.views[key];
  }
}

const rulesOf = (r: PackRole) => {
  const objects: Record<string, { read: boolean | null; write: boolean | null; archive: boolean | null }> = {};
  for (const [o, v] of Object.entries(r.objects ?? {})) {
    const rule = { read: v.read ?? null, write: v.write ?? null, archive: v.archive ?? null };
    if (rule.read !== null || rule.write !== null || rule.archive !== null) objects[o] = rule;
  }
  return { objects, fields: r.fields ?? {} };
};

/** Permissions and rules a role update adds and removes, for the plan. */
function roleDiff(b: RoleProps, a: RoleProps) {
  const changed = (x: Record<string, unknown>, y: Record<string, unknown>) =>
    Object.fromEntries([...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => canon(x[k]) !== canon(y[k])).map((k) => [k, { before: x[k] ?? null, after: y[k] ?? null }]));
  return {
    ...(b.name !== a.name ? { name: { before: b.name, after: a.name } } : {}),
    ...(b.description !== a.description ? { description: { before: b.description, after: a.description } } : {}),
    permissions_added: a.permissions.filter((p) => !b.permissions.includes(p)), permissions_removed: b.permissions.filter((p) => !a.permissions.includes(p)),
    objects: changed(b.objects, a.objects), fields: changed(b.fields, a.fields),
  };
}

async function runRoles(tx: Tx, ctx: Ctx, pack: Pack, owned: Owned, run: PackRun, prune: boolean, skip: Set<string>): Promise<void> {
  const schema = await loadSchema(tx);
  const wanted = new Set<string>();
  for (const r of pack.roles ?? []) {
    wanted.add(r.key);
    const path = `roles.${r.key}`;
    const desired = rulesOf(r);
    const ownedId = owned.roles[r.key];
    const at = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError) e.message = `${path}: ${e.message}`;
        throw e;
      }
    };
    if (!ownedId) {
      const [taken] = await tx`SELECT 1 FROM roles WHERE key = ${r.key} AND archived_at IS NULL`;
      if (taken) {
        run.unsupported.push({ path, message: `A role with key "${r.key}" already exists in this workspace and this pack didn't create it` });
        continue;
      }
      const made = await at(() => createRole(tx, ctx, { key: r.key, name: r.name, description: r.description ?? "", permissions: r.permissions, ...desired }));
      owned.roles[r.key] = decodeId(made.id)!.uuid;
      run.changes.push({ change: "role_created", object: "role", after: { key: r.key, name: r.name, permissions: made.permissions, objects: desired.objects, fields: desired.fields } });
      continue;
    }
    if (skip.has(path)) continue;
    const role = await resolveRole(tx, encodeId("role", ownedId));
    const current = publicRules(schema, await loadRoleRules(tx, ctx.tenantId, role.id, role.access_version));
    const same = role.name === r.name && role.description === (r.description ?? "") && canon([...role.permissions].sort()) === canon([...r.permissions].sort())
      && canon(current.objects) === canon(desired.objects) && canon(current.fields) === canon(desired.fields);
    if (same) continue;
    // Rules the new version leaves out are cleared: the pack's version of the role replaces the old one.
    const objects: Record<string, unknown> = { ...desired.objects };
    for (const o of Object.keys(current.objects)) if (!Object.hasOwn(desired.objects, o)) objects[o] = null;
    const fields: Record<string, unknown> = {};
    for (const o of new Set([...Object.keys(current.fields), ...Object.keys(desired.fields)])) {
      if (!Object.hasOwn(desired.fields, o)) fields[o] = null;
      else fields[o] = { ...Object.fromEntries(Object.keys(current.fields[o] ?? {}).map((f) => [f, null])), ...desired.fields[o] };
    }
    await at(() => updateRole(tx, ctx, encodeId("role", ownedId), { name: r.name, description: r.description ?? "", permissions: r.permissions, objects, fields } as never));
    const was: RoleProps = { name: role.name, description: role.description, permissions: [...role.permissions].sort(), ...current };
    const now = (await snapshot(tx, ctx, { ...owned, roles: { [r.key]: ownedId }, objects: {}, fields: {}, pipelines: {}, views: {} })).get(path)!.props as RoleProps;
    const wider = widening(path, was, now);
    run.changes.push({ change: "role_updated", object: "role", before: { key: r.key }, after: { key: r.key, ...roleDiff(was, now) },
      ...(wider.length ? { widens_access: wider, warning: `Gives more access: ${wider.join("; ")}` } : {}) });
  }
  for (const [key, id] of Object.entries(owned.roles)) {
    if (wanted.has(key)) continue;
    if (!prune) {
      run.notes.push(`roles.${key}: no longer in the pack; kept (apply with prune, or uninstall, to archive it)`);
      continue;
    }
    if (skip.has(`roles.${key}`)) {
      run.notes.push(`roles.${key}: no longer in the pack, but changed in this workspace since the pack wrote it; kept`);
      continue;
    }
    await archiveRole(tx, ctx, encodeId("role", id));
    delete owned.roles[key];
    run.changes.push({ change: "role_archived", object: "role", before: { key } });
  }
}

async function runViews(tx: Tx, ctx: Ctx, pack: Pack, owned: Owned, run: PackRun, prune: boolean, skip: Set<string>): Promise<void> {
  const wanted = new Set<string>();
  for (const v of pack.views ?? []) {
    const key = `${v.object}/${v.name}`;
    wanted.add(key);
    const def = { where: v.where ?? null, sort: v.sort ?? null, columns: v.columns ?? null, group_by: v.group_by ?? null };
    const at = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ApiError) e.message = `views.${key}: ${e.message}`;
        throw e;
      }
    };
    const mine = owned.views[key];
    const [row] = mine ? await tx<{ definition: unknown; name: string; version: number }[]>`SELECT definition, name, version FROM views WHERE id = ${mine.id}` : [];
    if (!row) {
      const made = await at(() => createView(tx, ctx, { object: v.object, name: v.name, shared: true, ...Object.fromEntries(Object.entries(def).filter(([, x]) => x !== null)) }));
      owned.views[key] = { id: decodeId(made.id)!.uuid, version: made.version };
      run.changes.push({ change: "view_created", object: v.object, after: { name: v.name, ...def } });
      continue;
    }
    if (skip.has(`views.${key}`)) continue;
    if (row.name === v.name && canon(row.definition) === canon(def)) continue;
    const made = await at(() => updateView(tx, ctx, encodeId(VIEW_ID_PREFIX, mine!.id), { name: v.name, ...def } as never));
    owned.views[key] = { id: mine!.id, version: made.version };
    run.changes.push({ change: "view_updated", object: v.object, before: { name: row.name, ...(row.definition as object) }, after: { name: v.name, ...def } });
  }
  for (const [key, v] of Object.entries(owned.views)) {
    if (wanted.has(key)) continue;
    if (!prune) {
      run.notes.push(`views.${key}: no longer in the pack; kept (apply with prune, or uninstall, to delete it)`);
      continue;
    }
    if (await dropView(tx, ctx, v, run, key)) delete owned.views[key];
  }
}

/** Deletes a pack view unless someone changed it since the pack wrote it; a changed one is kept and named. */
async function dropView(tx: Tx, ctx: Ctx, v: { id: string; version: number }, run: PackRun, key: string): Promise<boolean> {
  const [row] = await tx<{ version: number }[]>`SELECT version FROM views WHERE id = ${v.id}`;
  if (!row) return true;
  if (Number(row.version) !== v.version) {
    run.notes.push(`views.${key}: changed since the pack wrote it; kept`);
    return false;
  }
  await deleteView(tx, ctx, encodeId(VIEW_ID_PREFIX, v.id));
  run.changes.push({ change: "view_deleted", object: key.split("/")[0]!, before: { name: key.slice(key.indexOf("/") + 1) } });
  return true;
}

const CHANGED_HERE = "changed in this workspace since the pack installed it; kept (apply with overwrite_changes to replace it with the pack's version)";
const UNTRACKED = "installed before changes were tracked, so it may have been changed in this workspace; kept (apply with overwrite_changes to replace it)";

interface RunOptions { prune: boolean; overwrite: boolean }

/**
 * Makes the workspace match the pack, recording what it changed and the IDs it owns now. What a person changed
 * since the pack last wrote it is kept and listed (`kept`), unless `overwrite`: then it is replaced, and each such
 * item is listed with the workspace's copy and the pack's (`overwritten`). Afterwards the pack records what it
 * wrote, so the next run can tell.
 */
async function runPack(tx: Tx, ctx: Ctx, pack: Pack, row: PackRow | undefined, opts: RunOptions, check: () => void): Promise<PackRun> {
  const owned = ownedFrom(row?.owned);
  const run: PackRun = { changes: [], unsupported: [], notes: [], kept: [], overwritten: [], owned };
  if (row?.status === "uninstalled") await restore(tx, ctx, pack, owned, run);
  const before = await snapshot(tx, ctx, owned);
  const changedHere = new Set<string>();
  for (const [path, s] of before) {
    const was = writtenAt(owned, path);
    if (was === s.fp) continue;
    changedHere.add(path);
    if (!opts.overwrite) run.kept.push({ path, message: was === undefined ? UNTRACKED : CHANGED_HERE });
  }
  const skip = opts.overwrite ? new Set<string>() : changedHere;
  if (pack.schema) {
    let schema = await loadSchema(tx);
    const doc = toDocument(schema, pack, owned, await listPipelines(tx), run.unsupported, skip);
    if (run.unsupported.length) return run;
    const r = await runSchemaDocument(tx, ctx, doc, check);
    run.changes.push(...r.changes);
    run.unsupported.push(...r.unsupported);
    if (run.unsupported.length) return run;
    schema = await loadSchema(tx);
    const wantedFields = new Set<string>();
    for (const o of pack.schema.objects ?? []) {
      const obj = schema.objects.get(o.name)!;
      if (!obj.is_system) owned.objects[o.name] = obj.id;
      for (const f of o.fields ?? []) {
        const key = `${o.name}.${f.name}`;
        wantedFields.add(key);
        if (!skip.has(`fields.${key}`)) owned.fields[key] = obj.byName.get(f.name)!.id;
      }
    }
    for (const p of await listPipelines(tx)) {
      if ((pack.schema.pipelines ?? []).some((x) => x.name === p.name) && !skip.has(`pipelines.${p.name}`)) owned.pipelines[p.name] = p.id;
    }
    // What an earlier version created and this one leaves out: archived with prune (fields), otherwise kept and named.
    for (const [key, id] of Object.entries(owned.fields)) {
      if (wantedFields.has(key)) continue;
      const obj = [...schema.objects.values()].find((o) => o.fields.some((f) => f.id === id));
      const f = obj?.fields.find((x) => x.id === id);
      if (!obj || !f) continue;
      if (!opts.prune || owned.objects[obj.api_name] && !(pack.schema.objects ?? []).some((o) => o.name === obj.api_name)) {
        run.notes.push(`fields.${key}: no longer in the pack; kept (apply with prune to archive it)`);
        continue;
      }
      if (skip.has(`fields.${key}`)) {
        run.notes.push(`fields.${key}: no longer in the pack, but changed in this workspace since the pack wrote it; kept`);
        continue;
      }
      const token = confirmToken(ctx, (await loadSchema(tx)).version, "archive_field", obj.api_name, f.api_name);
      const res = await archiveField(tx, ctx, obj.api_name, f.api_name, { dryRun: false, confirm: token });
      run.changes.push(...res.changes.map((c) => ({ ...c, data_affecting: true })));
      delete owned.fields[key];
    }
    for (const name of Object.keys(owned.objects)) {
      if (!(pack.schema.objects ?? []).some((o) => o.name === name)) run.notes.push(`objects.${name}: no longer in the pack; kept (uninstall archives it)`);
    }
  }
  if (pack.roles || Object.keys(owned.roles).length) await runRoles(tx, ctx, pack, owned, run, opts.prune && pack.roles !== undefined, skip);
  if (pack.views || Object.keys(owned.views).length) await runViews(tx, ctx, pack, owned, run, opts.prune && pack.views !== undefined, skip);
  check();
  const after = await snapshot(tx, ctx, owned);
  for (const [path, s] of after) if (!skip.has(path)) recordWritten(owned, path, s);
  for (const path of opts.overwrite ? changedHere : []) {
    const b = before.get(path)!;
    const a = after.get(path);
    if (!a || a.fp === b.fp) continue;
    const wider = widening(path, b.props, a.props);
    run.overwritten.push({ path, before: b.props, after: a.props, ...(wider.length ? { widens_access: wider } : {}) });
  }
  pruneWritten(owned);
  return run;
}

class Rollback extends Error {
  constructor(readonly value: PackRun) {
    super("rollback");
  }
}

/** Runs `fn` for real in a savepoint and rolls it back: a plan is exactly what apply would do. */
async function dry(tx: Tx, fn: (sp: Tx) => Promise<PackRun>): Promise<PackRun> {
  try {
    await tx.savepoint(async (sp) => {
      throw new Rollback(await fn(sp as unknown as Tx));
    });
    throw new Error("unreachable");
  } catch (e) {
    if (e instanceof Rollback) return e.value;
    throw e;
  }
}

export interface PackApplyOptions {
  dryRun: boolean; prune?: boolean; overwriteChanges?: boolean; allowDowngrade?: boolean;
  confirmDataChanges?: boolean; confirmAccessChanges?: boolean;
  /** The plan_token a plan returned: apply refuses (409) when what it would do now differs from that plan. */
  planToken?: string;
}

/**
 * Plans (dryRun) or applies a pack in one transaction. Installing the version already installed, unchanged,
 * writes nothing; an older version than the one last installed (also after an uninstall) is refused without
 * allow_downgrade; anything that archives fields, converts values or brings records back needs
 * confirm_data_changes, and anything that widens access needs confirm_access_changes. A plan returns a
 * plan_token, bound to the caller's credential and to everything the plan depended on; apply needs it.
 */
export async function applyPack(tx: Tx, ctx: Ctx, pack: Pack, opts: PackApplyOptions) {
  requireAnyPart(ctx, "Installing");
  validatePack(pack);
  const m = pack.manifest;
  await lockSchema(tx);
  const row = await loadRow(tx, m.name, true);
  // What the pack holds now, and anything an earlier version left that this one would prune or restore.
  const touches = new Set<PackPart>(m.parts);
  if (row && Object.keys(row.owned.objects).length + Object.keys(row.owned.fields).length) touches.add("schema");
  if (row && Object.keys(row.owned.roles).length) touches.add("roles");
  if (row && Object.keys(row.owned.views).length) touches.add("views");
  requireParts(ctx, touches, "Installing");
  const schema = await loadSchema(tx);
  const off = (m.modules ?? []).filter((x) => !schema.modules.includes(x));
  if (off.length) throw unprocessable(`This pack expects the ${off.join(", ")} module(s), which are turned off in this workspace`);
  // Versions only go forward, also across an uninstall: an older pack of the same name can't come back in through it.
  if (row && compareVersions(row.version, m.version) > 0 && !opts.allowDowngrade) {
    throw conflict(`Version ${row.version} of ${m.name} was ${row.status === "installed" ? "installed" : "installed before its uninstall"}; ${m.version} is older. `
      + "Apply it with allow_downgrade: true to go back");
  }
  const action = !row ? "install" : row.status === "uninstalled" ? "reinstall" : row.version === m.version ? "reapply" : "upgrade";
  const check = deadline(WORK_BUDGET_MS.schema, "Applying the pack");
  const ro: RunOptions = { prune: opts.prune ?? false, overwrite: opts.overwriteChanges ?? false };
  const plan = await dry(tx, (sp) => runPack(sp, ctx, pack, row, ro, check));
  const summary = {
    pack: { name: m.name, version: m.version, description: m.description ?? "" },
    installed: row ? { version: row.version, status: row.status } : null,
    action, changes: plan.changes, unsupported: plan.unsupported, notes: plan.notes, kept: plan.kept, overwritten: plan.overwritten,
  };
  const hash = planHash({ pack, opts: { ...ro, downgrade: opts.allowDowngrade ?? false }, schema: schema.version,
    row: row ? { version: row.version, status: row.status, owned: row.owned } : null, plan: { ...summary, installed: null } });
  if (opts.dryRun) return { dry_run: true, applied: false, ...summary, plan_token: issueConfirm(ctx, "pack_apply", { h: hash }) };
  if (opts.planToken === undefined) throw new ApiError(400, "plan_required", "Applying a pack needs the plan_token of a plan: plan it first (POST /v1/packs/plan), review it, and pass its plan_token");
  let token: { body: { h: string }; exp: number };
  try {
    token = readConfirm<{ h: string }>(ctx, "pack_apply", opts.planToken, "plan the pack again (POST /v1/packs/plan) and pass its plan_token");
  } catch (e) {
    if (e instanceof ApiError) e.message = e.message.replace(/^confirm_token/, "plan_token");
    throw e;
  }
  if (token.body.h !== hash) {
    throw new ApiError(409, "plan_changed", "What applying the pack would do has changed since it was planned (the workspace or the pack changed); plan it again and review the new plan");
  }
  if (plan.unsupported.length) {
    throw new ApiError(422, "pack_unsupported", `The pack asks for ${plan.unsupported.length} thing(s) this workspace can't take; see errors`, plan.unsupported);
  }
  if (plan.changes.length === 0 && row?.status === "installed" && row.version === m.version) {
    // Nothing in the workspace changes. Only a row from before fingerprints were kept gains them here (overwrite_changes); otherwise nothing is written.
    if (canon(plan.owned) !== canon(row.owned)) {
      await spendConfirm(tx, ctx, opts.planToken, token.exp);
      await tx`UPDATE installed_packs SET owned = ${tx.json(plan.owned as never)}, updated_by = ${ctx.actor.id} WHERE name = ${m.name}`;
    }
    return { dry_run: false, applied: false, ...summary };
  }
  const affecting = plan.changes.filter((c) => c.data_affecting);
  if (affecting.length && !opts.confirmDataChanges) {
    throw new ApiError(409, "confirmation_required", `${affecting.length} change(s) archive fields, convert stored values or bring records back; apply with confirm_data_changes: true`, affecting);
  }
  const wider = [...plan.changes.filter((c) => (c as { widens_access?: unknown }).widens_access), ...plan.overwritten.filter((o) => o.widens_access)];
  if (wider.length && !opts.confirmAccessChanges) {
    throw new ApiError(409, "confirmation_required", `${wider.length} change(s) give more access than the workspace has now; review them and apply with confirm_access_changes: true`, wider);
  }
  await spendConfirm(tx, ctx, opts.planToken, token.exp);
  const done = await runPack(tx, ctx, pack, row, ro, check);
  await tx`
    INSERT INTO installed_packs (tenant_id, name, version, status, description, owned, installed_by, updated_by)
    VALUES (${ctx.tenantId}, ${m.name}, ${m.version}, 'installed', ${m.description ?? ""}, ${tx.json(done.owned as never)}, ${ctx.actor.id}, ${ctx.actor.id})
    ON CONFLICT (tenant_id, name) DO UPDATE SET version = EXCLUDED.version, status = 'installed', description = EXCLUDED.description,
      owned = EXCLUDED.owned, updated_by = EXCLUDED.updated_by`;
  await audit(tx, ctx, { action: `pack.${action === "reapply" ? "reapplied" : action === "install" ? "installed" : action === "reinstall" ? "reinstalled" : "upgraded"}`,
    objectType: "pack", details: { name: m.name, version: m.version, from_version: row?.version ?? null, changes: done.changes.length, prune: ro.prune,
      kept: done.kept.length, overwritten: done.overwritten.map((o) => o.path) } });
  return { dry_run: false, applied: true, ...summary, changes: done.changes, notes: done.notes, kept: done.kept, overwritten: done.overwritten };
}

// ---------------------------------------------------------------------------------------------
// List and uninstall

const countOwned = (o: Owned): Record<OwnedKind, string[]> => ({
  objects: Object.keys(o.objects).sort(), fields: Object.keys(o.fields).sort(), pipelines: Object.keys(o.pipelines).sort(),
  roles: Object.keys(o.roles).sort(), views: Object.keys(o.views).sort(),
});

const packOut = (r: PackRow) => ({
  name: r.name, version: r.version, status: r.status, description: r.description, owns: countOwned(ownedFrom(r.owned)),
  installed_at: r.installed_at.toISOString(), installed_by: actorRef("user", r.installed_by), updated_at: r.updated_at.toISOString(),
});

/** Installed packs (and uninstalled ones, which keep what they owned so a reinstall restores it). */
export async function listPacks(tx: Tx, ctx: Ctx) {
  requireAnyPart(ctx, "Listing");
  const rows = await tx<PackRow[]>`SELECT * FROM installed_packs ORDER BY name`;
  return rows.map(packOut);
}

/** Records in the objects a pack created, and values in the fields it added to other objects: what an uninstall would hide. Capped. */
async function recordsHeld(tx: Tx, schema: Schema, owned: Owned): Promise<{ records: number; values: number }> {
  const ids = Object.values(owned.objects);
  const [r] = ids.length ? await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT 1 FROM records WHERE object_id = ANY(${ids}::uuid[]) AND archived_at IS NULL LIMIT 10001) s` : [{ n: 0 }];
  let values = 0;
  for (const id of Object.values(owned.fields)) {
    const obj = [...schema.objects.values()].find((o) => o.fields.some((f) => f.id === id));
    if (!obj || ids.includes(obj.id)) continue;
    values += await countValues(tx, obj, obj.fields.find((f) => f.id === id)!);
  }
  return { records: r!.n, values };
}

/** Field names a filter looks at (the field a part, path or relation hop starts from). */
function whereFields(w: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (!w || typeof w !== "object" || depth > 20) return out;
  if (Array.isArray(w)) {
    for (const x of w) whereFields(x, out, depth + 1);
    return out;
  }
  const o = w as Record<string, unknown>;
  for (const k of ["and", "or"]) if (Array.isArray(o[k])) whereFields(o[k], out, depth + 1);
  if (o.not) whereFields(o.not, out, depth + 1);
  if (typeof o.field === "string") out.add(o.field.split(".")[0]!);
  if (Array.isArray(o.path) && typeof o.path[0] === "string") out.add(o.path[0].split(".")[0]!);
  return out;
}

export interface PackInUse { kind: "automation" | "alert"; id: string; name: string; uses: string[] }

/**
 * Automations and alert rules (not archived) that use what an uninstall would archive: an object the pack
 * created, a field it added (an address part or json path counts as its field), or a role it created named in
 * an automation's run_roles. Each would fail on every run once those are archived (an automation would pause),
 * or a run_roles entry would name an archived role, so the uninstall refuses while any is listed, as it refuses
 * while a field the pack didn't create relates to its objects. Webhooks subscribed to its objects' events only
 * stop receiving them, which a note says.
 */
async function packInUse(tx: Tx, schema: Schema, owned: Owned): Promise<{ inUse: PackInUse[]; notes: string[] }> {
  const objects = new Set(Object.values(owned.objects).map((id) => schema.byId.get(id)?.api_name).filter((n): n is string => Boolean(n)));
  const fields = new Map<string, Set<string>>();
  for (const id of Object.values(owned.fields)) {
    const o = [...schema.objects.values()].find((x) => x.fields.some((f) => f.id === id));
    if (!o || objects.has(o.api_name)) continue;
    const set = fields.get(o.api_name) ?? new Set<string>();
    set.add(o.fields.find((f) => f.id === id)!.api_name);
    fields.set(o.api_name, set);
  }
  const roleIds = Object.values(owned.roles);
  const roleKeys = new Set(roleIds.length ? (await tx<{ key: string }[]>`SELECT key FROM roles WHERE id = ANY(${roleIds}::uuid[]) AND archived_at IS NULL`).map((r) => r.key) : []);
  const uses = new Set<string>();
  const useObject = (o: string | undefined) => {
    if (o && objects.has(o)) uses.add(`${o} records`);
  };
  const useField = (o: ObjectMeta | string | undefined, f: string) => {
    const obj = typeof o === "string" ? schema.objects.get(o) : o;
    if (!obj) return;
    const name = fieldOfName(obj, f);
    if (fields.get(obj.api_name)?.has(name)) uses.add(`${obj.api_name}.${name}`);
  };
  const inUse: PackInUse[] = [];
  const autos = await tx<AutomationRow[]>`SELECT * FROM automations WHERE archived_at IS NULL ORDER BY name, id LIMIT 1000`;
  for (const a of autos) {
    uses.clear();
    const d = dependencies(schema, a);
    if (d.trigger) {
      useObject(d.trigger.object.api_name);
      for (const f of d.trigger.changed_fields ?? []) useField(d.trigger.object, f);
    }
    for (const [o, names] of d.fields) {
      useObject(o);
      for (const f of names) useField(o, f);
    }
    for (const f of d.filters) {
      useObject(f.object.api_name);
      for (const n of whereFields(f.where)) useField(f.object, n);
    }
    for (const w of writes(schema, a)) {
      useObject(w.object.api_name);
      for (const f of w.fields) useField(w.object, f);
    }
    for (const r of a.run_roles) if (roleKeys.has(r)) uses.add(`run_roles: ${r}`);
    if (uses.size) inUse.push({ kind: "automation", id: encodeId("auto", a.id), name: a.name, uses: [...uses].sort() });
  }
  // A personal rule's name is its owner's: it is listed without it.
  const alerts = await tx<{ id: string; name: string; scope: string; object: string; trigger: Record<string, unknown>; condition: unknown }[]>`
    SELECT id, name, scope, object, trigger, condition FROM alert_rules WHERE archived_at IS NULL ORDER BY name, id LIMIT 1000`;
  for (const r of alerts) {
    uses.clear();
    useObject(r.object);
    if (typeof r.trigger.field === "string") useField(r.object, r.trigger.field);
    if (Array.isArray(r.trigger.changed_fields)) for (const f of r.trigger.changed_fields) if (typeof f === "string") useField(r.object, f);
    for (const n of whereFields(r.condition)) useField(r.object, n);
    if (uses.size) inUse.push({ kind: "alert", id: encodeId("alr", r.id), name: r.scope === "personal" ? "(a personal alert rule)" : r.name, uses: [...uses].sort() });
  }
  const notes: string[] = [];
  if (objects.size) {
    const patterns = [...objects].flatMap((o) => [`${o}.*`]);
    const hooks = await tx<{ id: string; events: string[] }[]>`SELECT id, events FROM webhooks WHERE archived_at IS NULL ORDER BY id LIMIT 1000`;
    for (const h of hooks) {
      const hit = h.events.filter((e) => patterns.some((p) => e === p || e.startsWith(p.slice(0, -1))));
      if (hit.length) notes.push(`webhook ${encodeId("whk", h.id)} subscribes to ${hit.join(", ")}; it will receive no such events once the objects are archived`);
    }
  }
  return { inUse, notes };
}

export interface UninstallOptions { dryRun: boolean; confirmToken?: string; confirmRecords?: boolean }

/**
 * Archives what a pack created: its objects (records kept, hidden with them), the fields it added to other
 * objects (values kept), its roles, and its views unless changed since. Nothing is deleted but those
 * unchanged views; reinstalling the pack restores the objects and fields. A dry run by default: the real
 * run needs the dry run's confirm_token, and confirm_records when records or values would be hidden.
 * Refused while a field the pack didn't create relates to one of its objects, or a member holds one of its roles.
 */
export async function uninstallPack(tx: Tx, ctx: Ctx, name: string, opts: UninstallOptions) {
  requireAnyPart(ctx, "Uninstalling");
  if (typeof name !== "string" || !NAME.test(name)) throw notFound(`Pack ${String(name).slice(0, 63)}`);
  await lockSchema(tx);
  const row = await loadRow(tx, name, true);
  if (!row) throw notFound(`Pack ${name}`);
  if (row.status !== "installed") throw conflict(`Pack ${name} is not installed`);
  const owned = row.owned;
  const parts = new Set<PackPart>();
  if (Object.keys(owned.objects).length + Object.keys(owned.fields).length + Object.keys(owned.pipelines).length) parts.add("schema");
  if (Object.keys(owned.roles).length) parts.add("roles");
  if (Object.keys(owned.views).length) parts.add("views");
  requireParts(ctx, parts, "Uninstalling");
  const schema = await loadSchema(tx);
  const packObjects = new Set(Object.values(owned.objects));
  const packFields = new Set(Object.values(owned.fields));
  const blockers = [...schema.objects.values()].flatMap((o) => o.fields
    .filter((f) => f.type === "relation" && !packFields.has(f.id) && !packObjects.has(o.id) && [...packObjects].some((id) => schema.byId.get(id)?.api_name === f.options.to))
    .map((f) => `${o.api_name}.${f.api_name}`));
  if (blockers.length) {
    throw conflict(`Fields this pack didn't create relate to its objects: ${blockers.slice(0, 10).join(", ")}. Archive them first`, { fields: blockers });
  }
  const held = await recordsHeld(tx, schema, owned);
  const used = await packInUse(tx, schema, owned);
  const run = async (t: Tx): Promise<PackRun> => {
    const r: PackRun = { changes: [], unsupported: [], notes: [], kept: [], overwritten: [], owned: ownedFrom(owned) };
    for (const [key, id] of Object.entries(owned.fields)) {
      const s = await loadSchema(t);
      const obj = [...s.objects.values()].find((o) => o.fields.some((f) => f.id === id));
      if (!obj || packObjects.has(obj.id)) continue; // gone already, or archived with its object below
      const f = obj.fields.find((x) => x.id === id)!;
      const res = await archiveField(t, ctx, obj.api_name, f.api_name, { dryRun: false, confirm: confirmToken(ctx, s.version, "archive_field", obj.api_name, f.api_name) });
      r.changes.push(...res.changes);
      r.notes.push(`fields.${key}: archived (values kept)`);
    }
    for (const [objName, id] of Object.entries(owned.objects)) {
      const [o] = await t<{ archived_at: Date | null }[]>`SELECT archived_at FROM objects WHERE id = ${id}`;
      if (!o || o.archived_at) continue;
      await t`UPDATE objects SET archived_at = now(), updated_at = now() WHERE id = ${id}`;
      const change = { change: "object_archived", object: objName };
      await recordChange(t, ctx, { ...change, object_id: id });
      r.changes.push(change);
    }
    for (const [key, id] of Object.entries(owned.roles)) {
      const [live] = await t`SELECT 1 FROM roles WHERE id = ${id} AND archived_at IS NULL`;
      if (!live) continue;
      try {
        await archiveRole(t, ctx, encodeId("role", id));
      } catch (e) {
        if (e instanceof ApiError) e.message = `roles.${key}: ${e.message}`;
        throw e;
      }
      r.changes.push({ change: "role_archived", object: "role", before: { key } });
    }
    for (const [key, v] of Object.entries(owned.views)) await dropView(t, ctx, v, r, key);
    for (const p of Object.keys(owned.pipelines)) r.notes.push(`pipelines.${p}: kept (pipelines are not archived; deals may use them)`);
    return r;
  };
  const preview = await dry(tx, run);
  const out = {
    pack: { name, version: row.version }, records: held.records, values: held.values, changes: preview.changes, notes: [...preview.notes, ...used.notes],
    in_use: used.inUse,
    ...(held.records || held.values ? { warning: `${held.records} record(s) in the pack's objects and ${held.values} record(s) with values in its fields will be hidden (kept, not deleted)` } : {}),
  };
  // The token binds the caller's credential to what the dry run showed: the pack row as it was, the schema version and the preview.
  const hash = planHash({ name, version: row.version, owned, schema: schema.version, out });
  if (opts.dryRun) return { dry_run: true, ...out, confirm_token: issueConfirm(ctx, "pack_uninstall", { h: hash }) };
  if (opts.confirmToken === undefined) throw new ApiError(400, "confirmation_required", "Uninstalling needs confirmation: run it as a dry run first and pass back its confirm_token");
  const token = readConfirm<{ h: string }>(ctx, "pack_uninstall", opts.confirmToken, "run the uninstall as a dry run again for a new one");
  if (token.body.h !== hash) throw new ApiError(409, "plan_changed", "What uninstalling would do has changed since the dry run; run the dry run again and review it");
  if (used.inUse.length) {
    throw new ApiError(409, "pack_in_use", `Automations or alert rules use what uninstalling would archive: ${used.inUse.slice(0, 10).map((u) => `${u.kind} ${u.id} "${u.name.slice(0, 100)}" (${u.uses.join(", ")})`).join("; ")}. `
      + "Change or archive them first, then run the dry run again", { in_use: used.inUse });
  }
  if ((held.records || held.values) && !opts.confirmRecords) {
    throw new ApiError(409, "records_exist", `${out.warning}; pass confirm_records: true to uninstall anyway`, { records: held.records, values: held.values });
  }
  await spendConfirm(tx, ctx, opts.confirmToken, token.exp);
  const done = await run(tx);
  await tx`UPDATE installed_packs SET status = 'uninstalled', updated_by = ${ctx.actor.id} WHERE name = ${name}`;
  await audit(tx, ctx, { action: "pack.uninstalled", objectType: "pack", details: { name, version: row.version, changes: done.changes.length, records: held.records } });
  return { dry_run: false, ...out, changes: done.changes, notes: done.notes };
}
