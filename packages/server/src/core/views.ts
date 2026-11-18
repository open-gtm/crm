import type { Tx } from "../db/pool.js";
import { ApiError, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7, VIEW_ID_PREFIX } from "../lib/ids.js";
import { accessGuard, assertObject, canObject, fieldAccess } from "./access.js";
import { checkGroupBy, type GroupBy } from "./aggregate.js";
import { audit } from "./audit.js";
import { isEntity } from "./catalog.js";
import { can, type Ctx } from "./context.js";
import { compileQuery, type SortInput, type Where } from "./query.js";
import {
  countViews, definitionBytes, deleteViewRow, insertView, lockViewCap, sharedAndOwnViews, updateViewRow, viewById, type ViewRow,
} from "./queries/views.js";
import { isModuleOn, loadSchema, type ObjectMeta, type Schema } from "./schema.js";

/**
 * Saved views: an object, a filter, a sort, the columns to show and an optional grouping, kept by name.
 * A personal view belongs to one member; a shared one is listed to everyone who can read its object, and
 * creating or changing it needs views:manage.
 *
 * A view is not a grant. It runs with the reader's own access: a view whose filter, sort or grouping uses
 * something the reader can't read is refused for that reader (403, the same answer their own filter would
 * get), and its definition is not shown to them, since filter values typed by its author may come from
 * fields the reader can't see. Columns the reader can't read are left out. Whether a view is available
 * depends only on its definition and the reader's access, never on data, so it reveals nothing about values.
 * Who wrote a view never widens what is shown: anyone with views:manage can rewrite a shared view, so its
 * author may no longer be able to read what it says.
 */

/** definitionBytes is the CHECK in migration 012, measured the same way (the jsonb's text). */
export const VIEW_LIMITS = { name: 100, columns: 100, personalPerMember: 200, sharedPerWorkspace: 500, definitionBytes: 32_768 } as const;

export interface ViewDefinition { where?: Where; sort?: SortInput[]; columns?: string[]; group_by?: GroupBy[] }
export interface ViewInput extends ViewDefinition { object?: string; name?: string; shared?: boolean }

/** What a view needs to run, after the reader's access is applied. */
export interface ResolvedView { id: string; object: string; where?: Where; sort?: SortInput[]; columns?: string[]; group_by?: GroupBy[] }

const isMember = (ctx: Ctx) => (ctx.actor.type === "user" || ctx.actor.type === "service_account") && ctx.actor.id !== null;
const ownerRef = (type: string | null, id: string | null) => (type && id ? encodeId(type === "user" ? "usr" : "svc", id) : null);
const mine = (ctx: Ctx, row: ViewRow) => !row.shared && row.owner_type === ctx.actor.type && row.owner_id === ctx.actor.id;

function parseViewId(publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== VIEW_ID_PREFIX) throw notFound(`View ${String(publicId).slice(0, 60)}`);
  return d.uuid;
}

/** The view's object, if it still exists and its module is on. */
const objectOf = (schema: Schema, row: ViewRow): ObjectMeta | undefined => {
  const o = schema.byId.get(row.object_id);
  return o && isModuleOn(schema, o) ? o : undefined;
};

/**
 * Whether `ctx` may know the view exists: it is shared or theirs, and they can read its object (also while
 * its module is off). A view whose object is gone can't be checked against a rule, so it is seen only by
 * its owner and by schema managers.
 */
function canSee(ctx: Ctx, schema: Schema, row: ViewRow): boolean {
  if (!row.shared && !mine(ctx, row)) return false;
  const o = schema.byId.get(row.object_id);
  return o ? canObject(ctx, o, "read") : mine(ctx, row) || can(ctx, "schema:manage");
}

const BUILTIN_NAMES = new Set(["id", "object", "version", "display_name", "created_at", "updated_at", "archived_at"]);
const GENERIC_BROKEN = "The view refers to a field that no longer fits the schema (a field may have been renamed or archived); a views manager, or its owner for a personal view, can change or delete it";

/**
 * Why a view no longer fits the schema, for repairing it: the names of the fields it uses that no longer
 * exist, but only when the caller can read every other field and object it uses. Otherwise, or when no
 * field is missing (a value no longer fits its field), a generic message. Never a refusal's own text,
 * which may quote a filter value.
 */
function brokenProblem(ctx: Ctx, schema: Schema, obj: ObjectMeta, def: ViewDefinition): string {
  const missing = new Set<string>();
  let readable = true;
  let budget = 500; // a stored definition was checked when saved; this only bounds a hostile one
  const walk = (path: unknown) => {
    if (!Array.isArray(path) || --budget < 0) return void (readable = false);
    let o: ObjectMeta | null = obj;
    for (const [i, name] of path.entries()) {
      if (typeof name !== "string") return void (readable = false);
      if (o === null) return; // a platform entity (user, pipeline, stage): its few fields are listed to anyone
      // An address part or json path (hq.city) is its field's: a reader who can't see hq learns nothing about it.
      const dot = name.indexOf(".");
      const parent = dot > 0 ? o.byName.get(name.slice(0, dot)) : undefined;
      if (parent && (parent.type === "address" || parent.type === "json")) {
        if (fieldAccess(ctx, o, parent) === "none") return void (readable = false);
        return;
      }
      const f = o.byName.get(name);
      if (!f) {
        if (i > 0 || !BUILTIN_NAMES.has(name)) missing.add(path.slice(0, i + 1).join("."));
        return;
      }
      if (fieldAccess(ctx, o, f) === "none") return void (readable = false);
      if (i === path.length - 1 || f.type === "address" || f.type === "json") return;
      const to = f.options.to;
      if (!to) return;
      if (isEntity(to)) o = null;
      else {
        const t = schema.objects.get(to);
        if (!t || !isModuleOn(schema, t)) return void missing.add(path.slice(0, i + 1).join("."));
        if (!canObject(ctx, t, "read")) return void (readable = false);
        o = t;
      }
    }
  };
  const tree = (w: unknown, depth: number): void => {
    if (typeof w !== "object" || w === null || depth > 10 || --budget < 0) return void (readable = false);
    const n = w as Record<string, unknown>;
    if (Array.isArray(n.and) || Array.isArray(n.or)) for (const x of (n.and ?? n.or) as unknown[]) tree(x, depth + 1);
    else if (Object.hasOwn(n, "not")) tree(n.not, depth + 1);
    else walk(n.path ?? (typeof n.field === "string" ? [n.field] : null));
  };
  if (def.where !== undefined) tree(def.where, 0);
  for (const x of [...(Array.isArray(def.sort) ? def.sort : []), ...(Array.isArray(def.group_by) ? def.group_by : [])]) {
    walk([typeof x === "object" && x !== null ? (x as { field?: unknown }).field : null]);
  }
  for (const c of Array.isArray(def.columns) ? def.columns : []) walk([c]);
  if (!readable || missing.size === 0) return GENERIC_BROKEN;
  const names = [...missing];
  return `The view uses ${names.length === 1 ? "a field that no longer exists" : "fields that no longer exist"} (renamed or archived): `
    + `${names.slice(0, 10).map((x) => `"${x.slice(0, 100)}"`).join(", ")}${names.length > 10 ? ", …" : ""}; change or delete the view`;
}

/**
 * Checks a definition against the object and `ctx`'s access, exactly as running it would: the filter and
 * sort compile through the access guard, columns exist, and the grouping passes aggregate's checks.
 * `columnsStrict` (saving) refuses a column the caller can't read; running drops it instead.
 */
function check(ctx: Ctx, schema: Schema, obj: ObjectMeta, def: ViewDefinition, columnsStrict: boolean): string[] | undefined {
  compileQuery(schema, { object: obj.api_name, where: def.where, sort: def.sort, limit: 1 }, accessGuard(ctx, schema));
  checkGroupBy(ctx, obj, def.group_by);
  if (def.columns === undefined) return undefined;
  const out: string[] = [];
  for (const name of def.columns) {
    const f = obj.byName.get(name);
    if (!f && !["id", "object", "version", "display_name", "created_at", "updated_at", "archived_at"].includes(name)) throw unprocessable(`columns: "${name}" is not a field of ${obj.api_name}`);
    if (f && fieldAccess(ctx, obj, f) === "none") {
      if (columnsStrict) throw forbidden(`columns: "${name}" is not visible to this key`);
      continue;
    }
    out.push(name);
  }
  return out;
}

type Status = { status: "ok"; columns?: string[] } | { status: "unavailable" | "broken"; problem: string };

/** Whether the view runs for this reader. A 403 from the checks means unavailable; any other refusal means the view no longer fits the schema. */
function statusFor(ctx: Ctx, schema: Schema, row: ViewRow): Status {
  const obj = objectOf(schema, row);
  if (!obj) return { status: "broken", problem: "The view's object no longer exists or its module is turned off" };
  if (!canObject(ctx, obj, "read")) return { status: "unavailable", problem: `This key can't read ${obj.api_name} records` };
  try {
    return { status: "ok", columns: check(ctx, schema, obj, row.definition, false) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // Refusal messages name fields and objects only; other messages may quote filter values, so they are never shown.
    if (e.status === 403) return { status: "unavailable", problem: e.message };
    return { status: "broken", problem: brokenProblem(ctx, schema, obj, row.definition) };
  }
}

function viewOut(ctx: Ctx, schema: Schema, row: ViewRow) {
  const s = statusFor(ctx, schema, row);
  const obj = objectOf(schema, row);
  // The definition is shown only where it runs for this reader, under their access now: never because
  // they wrote it, since someone else may have changed it to use what they can't read.
  const d = row.definition;
  return {
    id: encodeId(VIEW_ID_PREFIX, row.id), object: obj?.api_name ?? null, name: row.name, shared: row.shared,
    owner: ownerRef(row.owner_type, row.owner_id), mine: mine(ctx, row), status: s.status, ...(s.status !== "ok" ? { problem: s.problem } : {}),
    ...(s.status === "ok" ? { where: d.where ?? null, sort: d.sort ?? null, columns: s.columns ?? null, group_by: d.group_by ?? null } : {}),
    version: row.version, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString(),
  };
}

/** A view this caller may see (canSee); anything else is not found. */
async function loadVisible(tx: Tx, ctx: Ctx, schema: Schema, publicId: string): Promise<ViewRow> {
  const row = await viewById(tx, parseViewId(publicId));
  if (!row || !canSee(ctx, schema, row)) throw notFound(`View ${publicId}`);
  return row;
}

export async function listViews(tx: Tx, ctx: Ctx, objectName?: string) {
  const schema = await loadSchema(tx);
  const obj = objectName === undefined ? undefined : schema.objects.get(objectName);
  if (objectName !== undefined) {
    if (!obj || !isModuleOn(schema, obj)) throw notFound(`Object "${objectName}"`);
    assertObject(ctx, obj, "read");
  }
  const rows = await sharedAndOwnViews(tx, { actorType: ctx.actor.type, actorId: ctx.actor.id, objectId: obj?.id ?? null,
    limit: VIEW_LIMITS.personalPerMember + VIEW_LIMITS.sharedPerWorkspace });
  return rows.filter((r) => canSee(ctx, schema, r)).map((r) => viewOut(ctx, schema, r));
}

export async function getView(tx: Tx, ctx: Ctx, publicId: string) {
  const schema = await loadSchema(tx);
  return viewOut(ctx, schema, await loadVisible(tx, ctx, schema, publicId));
}

function definitionOf(input: ViewDefinition): ViewDefinition {
  const def: ViewDefinition = {};
  if (input.where !== undefined && input.where !== null) def.where = input.where;
  if (input.sort !== undefined && input.sort !== null) def.sort = input.sort;
  if (input.columns !== undefined && input.columns !== null) {
    if (!Array.isArray(input.columns) || input.columns.length > VIEW_LIMITS.columns || input.columns.some((c) => typeof c !== "string")) {
      throw unprocessable(`columns takes at most ${VIEW_LIMITS.columns} field names`);
    }
    def.columns = [...new Set(input.columns)];
  }
  if (input.group_by !== undefined && input.group_by !== null) def.group_by = input.group_by;
  return def;
}

const needManage = (ctx: Ctx) => {
  if (!can(ctx, "views:manage")) throw forbidden('Creating or changing a shared view needs the "views:manage" permission');
};

const validName = (name: unknown) => {
  if (typeof name !== "string" || name.trim().length === 0 || name.length > VIEW_LIMITS.name) throw unprocessable(`name takes 1 to ${VIEW_LIMITS.name} characters`);
  return name.trim();
};

/** Measured as the database CHECK measures it (the jsonb's text, which is longer than JSON.stringify), so too big is a 422, not a 500. */
async function checkSize(tx: Tx, def: ViewDefinition): Promise<void> {
  if ((await definitionBytes(tx, def)) > VIEW_LIMITS.definitionBytes) throw unprocessable(`A view's filter, sort, columns and group_by can take at most ${VIEW_LIMITS.definitionBytes} bytes in all`);
}

/**
 * Refuses a view past the cap for where it is going (the workspace's shared views, or one member's own).
 * The advisory lock serialises writers to the same cap, so concurrent requests can't all pass the count.
 */
async function checkCap(tx: Tx, ctx: Ctx, shared: boolean, owner: { type: string | null; id: string | null }): Promise<void> {
  await lockViewCap(tx, ctx.tenantId, shared, owner);
  const counted = await countViews(tx, shared, owner);
  const cap = shared ? VIEW_LIMITS.sharedPerWorkspace : VIEW_LIMITS.personalPerMember;
  if (counted >= cap) throw unprocessable(`At most ${cap} ${shared ? "shared views per workspace" : "personal views per member"}`);
}

export async function createView(tx: Tx, ctx: Ctx, input: ViewInput) {
  const schema = await loadSchema(tx);
  const obj = typeof input.object === "string" ? schema.objects.get(input.object) : undefined;
  if (!obj || !isModuleOn(schema, obj)) throw notFound(`Object "${String(input.object).slice(0, 60)}"`);
  assertObject(ctx, obj, "read");
  const shared = input.shared === true;
  if (shared) needManage(ctx);
  else if (!isMember(ctx)) throw unprocessable("Personal views need a key that belongs to a member");
  const name = validName(input.name);
  const def = definitionOf(input);
  await checkSize(tx, def);
  check(ctx, schema, obj, def, true);
  await checkCap(tx, ctx, shared, ctx.actor);
  const id = uuidv7();
  const row = await insertView(tx, { tenantId: ctx.tenantId, id, objectId: obj.id, name, shared, ownerType: shared ? null : ctx.actor.type,
    ownerId: shared ? null : ctx.actor.id, definition: def, actorId: ctx.actor.id });
  // Names only, never the definition: its filter values are data.
  if (shared) await audit(tx, ctx, { action: "view.created", objectType: obj.api_name, details: { view: encodeId(VIEW_ID_PREFIX, id), name } });
  return viewOut(ctx, schema, row!);
}

/** Changes a view. Only its owner changes a personal view; a shared view, or sharing or unsharing one, needs views:manage. */
export async function updateView(tx: Tx, ctx: Ctx, publicId: string, input: Omit<ViewInput, "object">, expectedVersion?: number) {
  const schema = await loadSchema(tx);
  const row = await loadVisible(tx, ctx, schema, publicId);
  if (row.shared || input.shared !== undefined && input.shared !== row.shared) needManage(ctx);
  if (!row.shared && !mine(ctx, row)) throw notFound(`View ${publicId}`);
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw new ApiError(412, "version_mismatch", `View ${publicId} has changed (now version ${row.version}); re-read it and retry`);
  }
  const obj = objectOf(schema, row);
  if (!obj) throw unprocessable("The view's object no longer exists or its module is turned off; delete the view");
  const def = definitionOf({ ...row.definition, ...input });
  await checkSize(tx, def);
  check(ctx, schema, obj, def, true);
  const shared = input.shared ?? row.shared;
  if (!shared && !isMember(ctx)) throw unprocessable("Personal views need a key that belongs to a member");
  const name = input.name === undefined ? row.name : validName(input.name);
  // A shared view made personal becomes the caller's.
  const [owner_type, owner_id] = shared ? [null, null] : row.shared ? [ctx.actor.type, ctx.actor.id] : [row.owner_type, row.owner_id];
  if (shared !== row.shared) await checkCap(tx, ctx, shared, { type: owner_type, id: owner_id });
  const updated = await updateViewRow(tx, { id: row.id, name, shared, ownerType: owner_type, ownerId: owner_id, definition: def, actorId: ctx.actor.id });
  if (row.shared || shared) await audit(tx, ctx, { action: "view.updated", objectType: obj.api_name, details: { view: publicId, name, shared } });
  return viewOut(ctx, schema, updated!);
}

export async function deleteView(tx: Tx, ctx: Ctx, publicId: string) {
  const schema = await loadSchema(tx);
  const row = await loadVisible(tx, ctx, schema, publicId);
  if (row.shared) needManage(ctx);
  await deleteViewRow(tx, row.id);
  if (row.shared) await audit(tx, ctx, { action: "view.deleted", objectType: objectOf(schema, row)?.api_name ?? null, details: { view: publicId, name: row.name } });
  return { id: publicId, deleted: true };
}

/**
 * A view's settings for running it as `ctx`, or a refusal: 403 when it uses something the reader can't
 * read, 422 (view_invalid) when it no longer fits the schema. `object`, when given, must be the view's.
 */
export async function resolveView(tx: Tx, ctx: Ctx, schema: Schema, publicId: unknown, object?: string): Promise<ResolvedView> {
  if (typeof publicId !== "string") throw unprocessable(`view takes a view ID (${VIEW_ID_PREFIX}_…)`);
  const row = await loadVisible(tx, ctx, schema, publicId);
  const obj = objectOf(schema, row);
  if (!obj) throw new ApiError(422, "view_invalid", `View ${publicId} no longer works: its object no longer exists or its module is turned off`);
  if (object && object !== obj.api_name) throw unprocessable(`View ${publicId} is a view of ${obj.api_name}, not ${object}`);
  const s = statusFor(ctx, schema, row);
  if (s.status !== "ok") {
    throw s.status === "unavailable" ? forbidden(`View ${publicId} can't run for this key: ${s.problem}`)
      : new ApiError(422, "view_invalid", `View ${publicId} no longer works: ${s.problem}`);
  }
  const d = row.definition;
  return { id: publicId, object: obj.api_name, where: d.where, sort: d.sort, columns: s.columns, group_by: d.group_by };
}
