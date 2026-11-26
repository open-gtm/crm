import type { Tx } from "../db/pool.js";
import { ApiError, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { assertObject } from "./access.js";
import { audit } from "./audit.js";
import { can, type Ctx } from "./context.js";
import { DISGUISING } from "./fieldtypes.js";
import {
  apiKeyName, changeById, changesOf, deleteDraft, draftOf, insertChange, insertVersion, markChangeReviewed, oauthClientName, pageLayout, publishPageLayout,
  saveDraft, trimChanges, trimVersions, versionOf, versionsOf, type ChangeRow, type Contributor, type Source, type StoredLayout, type VersionRow,
} from "./queries/layouts.js";
import { getObject, isModuleOn, loadSchema, lockSchema, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";
import { actorRef } from "./webhooks.js";

/**
 * Record page layouts (ADR 0015, ADR 0017): how an object's record page is arranged. A layout has key
 * facts in the header, an optional band on top, and three columns of components: sections of fields,
 * related lists, the timeline, notes, files, quotes, open tasks, the stage path and the changes agents made.
 *
 * One layout per object is published, for the whole workspace. People and agents edit one shared draft,
 * each change recorded with where it came from, and publish it as the next version; every version is kept
 * and any can be put back. A change is always shown as a diff before it is made.
 *
 * A layout arranges; it grants nothing. A field a member can't read stays hidden wherever the layout puts
 * it, and a field the layout leaves out is still shown, so adding a field never needs the layout changed.
 */

export const LAYOUT_LIMITS = { sections: 20, fieldsPerSection: 100, title: 80, components: 30, keyFacts: 6, rows: 25, days: 90, note: 500, versions: 50, draftChanges: 100 };

const ZONES = ["top", "left", "main", "right"] as const;
export type Zone = (typeof ZONES)[number];
/** Components a page holds once at most. */
const SINGLE = ["timeline", "notes", "files", "tasks", "quotes", "stage_path", "agent_changes", "related_lists"] as const;
export const COMPONENT_TYPES = ["fields", "related", ...SINGLE] as const;

export type Component =
  | { id: string; type: "fields"; name: string; columns: 1 | 2; collapsed: boolean; fields: string[] }
  | { id: string; type: "related"; object: string; field: string; rows: number }
  | { id: string; type: "tasks" | "quotes"; rows: number }
  | { id: string; type: "stage_path"; field: string | null }
  | { id: string; type: "agent_changes"; days: number }
  | { id: string; type: "timeline" | "notes" | "files" | "related_lists" };

type WithoutId<C> = C extends unknown ? Omit<C, "id"> : never;

/** A layout by name, as the API gives and takes it. `key_facts: null` leaves the header's facts to the page (a status, money, the owner). */
export interface LayoutDoc {
  header: { key_facts: string[] | null };
  top: Component[];
  columns: { left: Component[]; main: Component[]; right: Component[] };
}

export interface LayoutSection { title: string; fields: string[] }
export interface SourceOut { surface: string; actor: string | null; via: string | null }
export interface LayoutOut {
  object: string;
  /** False: no layout is published, and the record page is the default one. */
  custom: boolean;
  version: number;
  layout: LayoutDoc;
  /** The layout's field sections, as before components existed (ADR 0015). Empty when no layout is published. */
  sections: LayoutSection[];
  updated_at: string | null;
}

// ----------------------------------------------------------------------------------------------
// Stored form (IDs) and API form (names)

const zoneOf = (doc: LayoutDoc, z: Zone) => (z === "top" ? doc.top : doc.columns[z]);
const all = (doc: LayoutDoc) => ZONES.flatMap((z) => zoneOf(doc, z).map((c) => ({ zone: z, c })));
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects with a to-one or to-many relation to `obj`: what a related list can show. */
function relationsTo(schema: Schema, obj: ObjectMeta): { object: ObjectMeta; field: FieldMeta }[] {
  return [...schema.objects.values()].filter((o) => isModuleOn(schema, o))
    .flatMap((o) => o.fields.filter((f) => f.type === "relation" && f.options.to === obj.api_name).map((field) => ({ object: o, field })));
}

/** The page an object has with no layout published: every field, then the parts every record page had. */
export function defaultLayout(schema: Schema, obj: ObjectMeta): LayoutDoc {
  const standard = obj.fields.filter((f) => f.is_system).map((f) => f.api_name);
  const custom = obj.fields.filter((f) => !f.is_system).map((f) => f.api_name);
  const section = (id: string, name: string, fields: string[]): Component => ({ id, type: "fields", name, columns: 1, collapsed: false, fields });
  const left = standard.length && custom.length ? [section("details", "Details", standard), section("custom_fields", "Custom fields", custom)]
    : [section("details", "Details", standard.length ? standard : custom)];
  const activity = obj.api_name === "task" || obj.api_name === "activity";
  return {
    header: { key_facts: null },
    top: obj.api_name === "deal" ? [{ id: "stage_path", type: "stage_path", field: null }] : [],
    columns: {
      left,
      main: [{ id: "timeline", type: "timeline" }, { id: "notes", type: "notes" }, { id: "files", type: "files" }],
      right: [{ id: "related_lists", type: "related_lists" }, ...(activity ? [] : [{ id: "tasks", type: "tasks" as const, rows: 5 }])],
    },
  };
}

/** A stored layout by name. What it names that no longer exists (an archived field, a removed object) is left out. */
function toDoc(schema: Schema, obj: ObjectMeta, stored: StoredLayout): LayoutDoc {
  const fieldName = new Map(obj.fields.map((f) => [f.id, f.api_name]));
  const names = (ids: unknown) => (Array.isArray(ids) ? ids.map((id) => fieldName.get(String(id))).filter((n): n is string => n !== undefined) : []);
  if (stored.v !== 2) {
    // Version 1 (ADR 0015): sections of fields only. They take the left column of the default page.
    const doc = defaultLayout(schema, obj);
    const sections = Array.isArray(stored.sections) ? stored.sections as { title: string; fields: string[] }[] : [];
    const used = new Set<string>();
    doc.columns.left = sections.map((s) => ({ id: uniqueId(slug(s.title) || "fields", used), type: "fields" as const, name: s.title, columns: 1 as const, collapsed: false, fields: names(s.fields) }));
    return doc;
  }
  const comp = (raw: unknown): Component | null => {
    const c = raw as Record<string, unknown>;
    const id = String(c.id);
    switch (c.type) {
      case "fields": return { id, type: "fields", name: String(c.name), columns: c.columns === 2 ? 2 : 1, collapsed: c.collapsed === true, fields: names(c.fields) };
      case "related": {
        const o = schema.byId.get(String(c.object));
        const f = o?.fields.find((x) => x.id === c.field);
        return o && f && isModuleOn(schema, o) ? { id, type: "related", object: o.api_name, field: f.api_name, rows: Number(c.rows) } : null;
      }
      case "tasks": case "quotes": return { id, type: c.type, rows: Number(c.rows) };
      case "stage_path": {
        if (c.field === null || c.field === undefined) return { id, type: "stage_path", field: null };
        const f = fieldName.get(String(c.field));
        return f ? { id, type: "stage_path", field: f } : null;
      }
      case "agent_changes": return { id, type: "agent_changes", days: Number(c.days) };
      case "timeline": case "notes": case "files": case "related_lists": return { id, type: c.type };
      default: return null;
    }
  };
  const zone = (z: unknown) => (Array.isArray(z) ? z.map(comp).filter((c): c is Component => c !== null) : []);
  const header = isPlain(stored.header) ? stored.header : {};
  return {
    header: { key_facts: Array.isArray(header.key_facts) ? names(header.key_facts) : null },
    top: zone(stored.top), columns: { left: zone(stored.left), main: zone(stored.main), right: zone(stored.right) },
  };
}

/** A checked layout as it is stored: fields and objects by ID. */
function toStored(schema: Schema, obj: ObjectMeta, doc: LayoutDoc): StoredLayout {
  const fid = (n: string) => obj.byName.get(n)!.id;
  const comp = (c: Component): Record<string, unknown> => {
    switch (c.type) {
      case "fields": return { ...c, fields: c.fields.map(fid) };
      case "related": {
        const o = schema.objects.get(c.object)!;
        return { ...c, object: o.id, field: o.byName.get(c.field)!.id };
      }
      case "stage_path": return { ...c, field: c.field === null ? null : fid(c.field) };
      default: return { ...c };
    }
  };
  return { v: 2, header: { key_facts: doc.header.key_facts === null ? null : doc.header.key_facts.map(fid) },
    top: doc.top.map(comp), left: doc.columns.left.map(comp), main: doc.columns.main.map(comp), right: doc.columns.right.map(comp) };
}

// ----------------------------------------------------------------------------------------------
// Checking a layout someone sent

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

function title(raw: unknown, where: string): string {
  const name = typeof raw === "string" ? raw.normalize("NFC").trim() : "";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!name || name.length > LAYOUT_LIMITS.title || /[\x00-\x1f\x7f]/.test(name) || DISGUISING.test(name)) {
    throw unprocessable(`${where} must be one line of 1 to ${LAYOUT_LIMITS.title} characters`);
  }
  return name;
}

function whole(raw: unknown, fallback: number, max: number, where: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > max) throw unprocessable(`${where} must be a whole number from 1 to ${max}`);
  return raw;
}

function onlyKeys(c: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(c).find((k) => !allowed.includes(k));
  if (extra) throw unprocessable(`${where}: unknown key "${extra}"`);
}

/**
 * Checks a layout by name against the object and returns it complete: every component with an id and its
 * defaults filled in. Warnings say what will surprise someone (a restricted field most roles won't see).
 */
export function checkLayout(schema: Schema, obj: ObjectMeta, raw: unknown): { doc: LayoutDoc; warnings: string[] } {
  if (!isPlain(raw)) throw unprocessable("layout must be an object with header, top and columns");
  onlyKeys(raw, ["header", "top", "columns", "object"], "layout");
  if (raw.object !== undefined && raw.object !== obj.api_name) throw unprocessable(`This layout is for ${String(raw.object)}, not ${obj.api_name}`);
  const warnings: string[] = [];
  const fieldOf = (n: unknown, where: string): FieldMeta => {
    const f = typeof n === "string" ? obj.byName.get(n) : undefined;
    if (!f) throw unprocessable(`${where}: "${String(n)}" is not a field of ${obj.api_name}`);
    return f;
  };
  const sensitive = (f: FieldMeta, where: string) => {
    if (f.sensitivity === "restricted") warnings.push(`${where}: ${f.label} is restricted, so only members who may see restricted values will see it there.`);
    else if (f.hidden) warnings.push(`${where}: ${f.label} is a hidden field, so it is not shown there.`);
  };

  const header = raw.header === undefined ? {} : raw.header;
  if (!isPlain(header)) throw unprocessable("header must be an object");
  onlyKeys(header, ["key_facts"], "header");
  let keyFacts: string[] | null = null;
  if (header.key_facts !== undefined && header.key_facts !== null) {
    if (!Array.isArray(header.key_facts)) throw unprocessable("header.key_facts must be a list of field names, or null to leave them to the page");
    if (header.key_facts.length > LAYOUT_LIMITS.keyFacts) throw unprocessable(`The header shows at most ${LAYOUT_LIMITS.keyFacts} key facts`);
    keyFacts = header.key_facts.map((n) => {
      const f = fieldOf(n, "header.key_facts");
      if (f.type === "long_text" || f.type === "json" || f.type === "address" || f.options.cardinality === "many_to_many") throw unprocessable(`header.key_facts: ${f.api_name} is a ${f.type} field, which doesn't fit in the header`);
      sensitive(f, "The header");
      return f.api_name;
    });
    if (new Set(keyFacts).size !== keyFacts.length) throw unprocessable("header.key_facts names a field twice");
  }

  const columns = raw.columns === undefined ? {} : raw.columns;
  if (!isPlain(columns)) throw unprocessable("columns must be an object with left, main and right");
  onlyKeys(columns, ["left", "main", "right"], "columns");
  const ids = new Set<string>();
  const placed = new Set<string>();
  const sectionNames = new Set<string>();
  const single = new Set<string>();
  const lists = new Set<string>();
  const pending: { zone: Zone; c: Component; given: boolean }[] = [];
  const related = relationsTo(schema, obj);

  const component = (rawC: unknown, where: string): WithoutId<Component> => {
    if (!isPlain(rawC) || typeof rawC.type !== "string") throw unprocessable(`${where} must be an object with a type: ${COMPONENT_TYPES.join(", ")}`);
    const type = rawC.type as Component["type"];
    if ((SINGLE as readonly string[]).includes(type)) {
      if (single.has(type)) throw unprocessable(`${where}: the page already has a ${type} component`);
      single.add(type);
    }
    switch (type) {
      case "fields": {
        onlyKeys(rawC, ["id", "type", "name", "columns", "collapsed", "fields"], where);
        const name = title(rawC.name, `${where}.name`);
        if (sectionNames.has(name.toLowerCase())) throw unprocessable(`Two sections are called "${name}"`);
        sectionNames.add(name.toLowerCase());
        if (rawC.columns !== undefined && rawC.columns !== 1 && rawC.columns !== 2) throw unprocessable(`${where}.columns must be 1 or 2`);
        if (rawC.collapsed !== undefined && typeof rawC.collapsed !== "boolean") throw unprocessable(`${where}.collapsed must be true or false`);
        const list = rawC.fields ?? [];
        if (!Array.isArray(list)) throw unprocessable(`${where}.fields must be a list of field names`);
        if (list.length > LAYOUT_LIMITS.fieldsPerSection) throw unprocessable(`A section has at most ${LAYOUT_LIMITS.fieldsPerSection} fields`);
        const fields = list.map((n) => {
          const f = fieldOf(n, where);
          if (placed.has(f.id)) throw unprocessable(`"${f.api_name}" is in the layout twice`);
          placed.add(f.id);
          sensitive(f, name);
          return f.api_name;
        });
        return { type, name, columns: rawC.columns === 2 ? 2 : 1, collapsed: rawC.collapsed === true, fields };
      }
      case "related": {
        onlyKeys(rawC, ["id", "type", "object", "field", "rows"], where);
        const candidates = related.filter((r) => r.object.api_name === rawC.object);
        if (!candidates.length) {
          throw unprocessable(`${where}: ${String(rawC.object)} has no relation to ${obj.api_name}. Related lists here can show: ${[...new Set(related.map((r) => r.object.api_name))].join(", ") || "nothing"}`);
        }
        const hit = rawC.field === undefined ? (candidates.length === 1 ? candidates[0] : undefined) : candidates.find((r) => r.field.api_name === rawC.field);
        if (!hit) {
          throw unprocessable(`${where}: say which relation with "field": ${candidates.map((r) => r.field.api_name).join(" or ")}`);
        }
        const key = `${hit.object.id}.${hit.field.id}`;
        if (lists.has(key)) throw unprocessable(`${where}: the page already has that related list`);
        lists.add(key);
        return { type, object: hit.object.api_name, field: hit.field.api_name, rows: whole(rawC.rows, 5, LAYOUT_LIMITS.rows, `${where}.rows`) };
      }
      case "tasks": case "quotes": {
        onlyKeys(rawC, ["id", "type", "rows"], where);
        if (type === "tasks" && (obj.api_name === "task" || obj.api_name === "activity")) throw unprocessable(`${where}: ${obj.api_name} records have no tasks of their own`);
        if (type === "quotes" && !related.some((r) => r.object.api_name === "quote")) throw unprocessable(`${where}: quotes aren't made for ${obj.plural_label.toLowerCase()} (or the commerce module is off)`);
        return { type, rows: whole(rawC.rows, 5, LAYOUT_LIMITS.rows, `${where}.rows`) };
      }
      case "stage_path": {
        onlyKeys(rawC, ["id", "type", "field"], where);
        if (rawC.field === undefined || rawC.field === null) {
          if (obj.api_name === "deal") return { type, field: null };
          const statuses = obj.fields.filter((f) => f.type === "status");
          if (statuses.length !== 1) throw unprocessable(`${where}: a stage path follows a deal's pipeline or a status field; ${statuses.length ? `say which with "field": ${statuses.map((f) => f.api_name).join(" or ")}` : `${obj.api_name} has no status field`}`);
          return { type, field: statuses[0]!.api_name };
        }
        const f = fieldOf(rawC.field, where);
        if (f.type !== "status") throw unprocessable(`${where}: ${f.api_name} is not a status field`);
        return { type, field: f.api_name };
      }
      case "agent_changes":
        onlyKeys(rawC, ["id", "type", "days"], where);
        return { type, days: whole(rawC.days, 7, LAYOUT_LIMITS.days, `${where}.days`) };
      case "timeline": case "notes": case "files": case "related_lists":
        onlyKeys(rawC, ["id", "type"], where);
        return { type };
      default:
        throw unprocessable(`${where}: unknown component type "${String(rawC.type)}". Types: ${COMPONENT_TYPES.join(", ")}`);
    }
  };

  for (const z of ZONES) {
    const list = z === "top" ? raw.top : columns[z];
    if (list === undefined) continue;
    const where = z === "top" ? "top" : `columns.${z}`;
    if (!Array.isArray(list)) throw unprocessable(`${where} must be a list of components`);
    for (const [i, rawC] of list.entries()) {
      const c = component(rawC, `${where}[${i}]`);
      if (z === "top" && c.type !== "stage_path") throw unprocessable(`${where}[${i}]: only a stage_path goes across the top; put ${c.type} in a column`);
      const given = (rawC as Record<string, unknown>).id;
      if (given !== undefined) {
        if (typeof given !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(given)) throw unprocessable(`${where}[${i}].id must be lowercase letters, digits and underscores, starting with a letter`);
        if (ids.has(given)) throw unprocessable(`Two components have the id "${given}"`);
        ids.add(given);
      }
      pending.push({ zone: z, c: { ...c, id: typeof given === "string" ? given : "" } as Component, given: given !== undefined });
    }
  }
  if (pending.length === 0) throw unprocessable("A layout needs at least one component in a column");
  if (pending.length > LAYOUT_LIMITS.components) throw unprocessable(`A layout has at most ${LAYOUT_LIMITS.components} components`);
  if (pending.filter((p) => p.c.type === "fields").length > LAYOUT_LIMITS.sections) throw unprocessable(`A layout has at most ${LAYOUT_LIMITS.sections} sections`);
  // Components sent without an id get one from what they are, so later changes and diffs can name them.
  for (const p of pending) {
    if (!p.given) p.c.id = uniqueId(p.c.type === "fields" ? slug(p.c.name) || "fields" : p.c.type === "related" ? `${p.c.object}_list` : p.c.type, ids);
  }
  const doc: LayoutDoc = { header: { key_facts: keyFacts }, top: [], columns: { left: [], main: [], right: [] } };
  for (const p of pending) zoneOf(doc, p.zone).push(p.c);
  return { doc, warnings };
}

// ----------------------------------------------------------------------------------------------
// What changed between two layouts, in words

const ZONE_LABEL: Record<Zone, string> = { top: "the top of the page", left: "the left column", main: "the main column", right: "the right column" };
const quoted = (s: string) => `“${s}”`;

/** One sentence per change, for the dry run, the draft's change list and a version's summary. Empty when the two are the same. */
export function diffLayouts(schema: Schema, obj: ObjectMeta, before: LayoutDoc, after: LayoutDoc): string[] {
  const label = (n: string) => obj.byName.get(n)?.label ?? n;
  const labels = (ns: string[]) => ns.map(label).join(", ");
  const name = (c: Component): string => {
    switch (c.type) {
      case "fields": return `the ${quoted(c.name)} section`;
      case "related": return `the ${schema.objects.get(c.object)?.plural_label ?? c.object} list`;
      case "tasks": return "Open tasks";
      case "quotes": return "Quotes";
      case "stage_path": return "the stage path";
      case "agent_changes": return "Changes by agents";
      case "timeline": return "the activity timeline";
      case "notes": return "Notes";
      case "files": return "Files";
      case "related_lists": return "the other related lists";
    }
  };
  const out: string[] = [];
  const kb = before.header.key_facts;
  const ka = after.header.key_facts;
  if (kb === null && ka !== null) out.push(`Set the header's key facts: ${labels(ka) || "none"}`);
  else if (kb !== null && ka === null) out.push("Left the header's key facts to the page");
  else if (kb && ka) {
    const added = ka.filter((n) => !kb.includes(n));
    const removed = kb.filter((n) => !ka.includes(n));
    if (added.length) out.push(`Added ${labels(added)} to the header`);
    if (removed.length) out.push(`Removed ${labels(removed)} from the header`);
    if (!added.length && !removed.length && ka.join() !== kb.join()) out.push("Reordered the header's key facts");
  }
  const b = new Map(all(before).map((x) => [x.c.id, x]));
  const a = new Map(all(after).map((x) => [x.c.id, x]));
  for (const [id, x] of a) if (!b.has(id)) out.push(`Added ${name(x.c)} to ${ZONE_LABEL[x.zone]}${x.c.type === "fields" && x.c.fields.length ? `, with ${labels(x.c.fields)}` : ""}`);
  for (const [id, x] of b) if (!a.has(id)) out.push(`Removed ${name(x.c)}`);
  for (const [id, x] of a) {
    const was = b.get(id);
    if (!was) continue;
    const c = x.c;
    const p = was.c;
    if (was.zone !== x.zone) out.push(`Moved ${name(c)} from ${ZONE_LABEL[was.zone]} to ${ZONE_LABEL[x.zone]}`);
    if (c.type !== p.type) {
      out.push(`Replaced ${name(p)} with ${name(c)}`);
      continue;
    }
    if (c.type === "fields" && p.type === "fields") {
      if (c.name !== p.name) out.push(`Renamed the ${quoted(p.name)} section to ${quoted(c.name)}`);
      if (c.columns !== p.columns) out.push(`${quoted(c.name)}: ${c.columns} column${c.columns === 1 ? "" : "s"}`);
      if (c.collapsed !== p.collapsed) out.push(`${quoted(c.name)}: ${c.collapsed ? "collapsed by default" : "open by default"}`);
      const added = c.fields.filter((n) => !p.fields.includes(n));
      const removed = p.fields.filter((n) => !c.fields.includes(n));
      if (added.length) out.push(`${quoted(c.name)}: added ${labels(added)}`);
      if (removed.length) out.push(`${quoted(c.name)}: took off ${labels(removed)}`);
      if (!added.length && !removed.length && c.fields.join() !== p.fields.join()) out.push(`${quoted(c.name)}: reordered its fields`);
    } else if ((c.type === "related" || c.type === "tasks" || c.type === "quotes") && "rows" in p && c.rows !== p.rows) {
      out.push(`${name(c)}: shows ${c.rows} row${c.rows === 1 ? "" : "s"}`);
    } else if (c.type === "agent_changes" && p.type === "agent_changes" && c.days !== p.days) {
      out.push(`Changes by agents: the last ${c.days} day${c.days === 1 ? "" : "s"}`);
    } else if (c.type === "stage_path" && p.type === "stage_path" && c.field !== p.field) {
      out.push(`The stage path follows ${c.field ? label(c.field) : "the pipeline"}`);
    }
  }
  // Order within a column, among the components that stayed in it.
  for (const z of ZONES) {
    const stay = (doc: LayoutDoc, other: Map<string, { zone: Zone }>) => zoneOf(doc, z).map((c) => c.id).filter((id) => other.get(id)?.zone === z);
    if (stay(before, a).join() !== stay(after, b).join()) out.push(`Reordered ${ZONE_LABEL[z]}`);
  }
  return out;
}

const summarize = (changes: string[]) => {
  const s = changes.length <= 2 ? changes.join("; ") : `${changes[0]}; ${changes[1]}; and ${changes.length - 2} more`;
  return s.length > 480 ? `${s.slice(0, 479)}…` : s;
};

// ----------------------------------------------------------------------------------------------
// Reading

const manager = (ctx: Ctx) => {
  if (!can(ctx, "schema:manage")) throw forbidden("Changing a record page's layout needs the schema:manage permission");
};

/** Where a change comes from: the surface the request arrived through, and the connected app or key by name. */
async function sourceOf(tx: Tx, ctx: Ctx): Promise<Source> {
  const via = ctx.oauth ? await oauthClientName(tx, ctx.oauth.grantId) : ctx.keyId ? await apiKeyName(tx, ctx.keyId) : undefined;
  return { actorType: ctx.actor.type, actorId: ctx.actor.id, surface: ctx.surface, via: via ?? null };
}
const sourceOut = (r: { actor_type: string; actor_id: string | null; surface: string; via: string | null }): SourceOut =>
  ({ surface: r.surface, actor: actorRef(r.actor_type, r.actor_id), via: r.via });

const sectionsOf = (doc: LayoutDoc): LayoutSection[] =>
  all(doc).flatMap(({ c }) => (c.type === "fields" ? [{ title: c.name, fields: c.fields }] : []));

async function published(tx: Tx, schema: Schema, obj: ObjectMeta, forUpdate = false) {
  const row = await pageLayout(tx, obj.id, forUpdate);
  const custom = Boolean(row?.layout);
  return { row, custom, version: row?.version ?? 0, doc: row?.layout ? toDoc(schema, obj, row.layout) : defaultLayout(schema, obj) };
}

/** An object's published layout by name: what its record page shows. Anyone who can read the object reads it. */
export async function getLayout(tx: Tx, ctx: Ctx, objectName: string): Promise<LayoutOut> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  assertObject(ctx, obj, "read");
  const p = await published(tx, schema, obj);
  return { object: obj.api_name, custom: p.custom, version: p.version, layout: p.doc, sections: p.custom ? sectionsOf(p.doc) : [],
    updated_at: p.custom ? p.row!.updated_at.toISOString() : null };
}

const changeOut = (c: ChangeRow, newest: number) => ({
  id: encodeId("lch", c.id), revision: c.revision, summary: c.summary, changes: c.changes, note: c.note, source: sourceOut(c), at: c.created_at.toISOString(),
  reviewed: c.reviewed_at !== null,
  /** Only the newest change can be undone: later ones were made on top of it. */
  can_undo: c.revision === newest,
});

/**
 * The shared draft of an object's layout, with what it changes and who changed it. With no draft, the
 * published layout (or the default page) is what a first change starts from.
 */
export async function getDraft(tx: Tx, ctx: Ctx, objectName: string) {
  manager(ctx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const p = await published(tx, schema, obj);
  const draft = await draftOf(tx, obj.id);
  const doc = draft ? toDoc(schema, obj, draft.layout) : p.doc;
  const changes = draft ? await changesOf(tx, obj.id) : [];
  return {
    object: obj.api_name, has_draft: Boolean(draft), revision: draft?.revision ?? 0, layout: doc,
    published_version: p.version, published_custom: p.custom,
    /** The published layout moved on since the draft was started: publishing would overwrite it. */
    stale: Boolean(draft && draft.base_version !== p.version),
    diff: draft ? diffLayouts(schema, obj, p.doc, doc) : [],
    changes: changes.map((c) => changeOut(c, draft?.revision ?? 0)),
    updated_at: draft ? draft.updated_at.toISOString() : null,
  };
}

// ----------------------------------------------------------------------------------------------
// Changing the draft

export interface DraftInput { layout: unknown; revision?: number; note?: string | null; dry_run?: boolean }

function noteOf(raw: string | null | undefined): string | null {
  const note = raw?.normalize("NFC").trim() ?? "";
  if (note.length > LAYOUT_LIMITS.note) throw unprocessable(`note is at most ${LAYOUT_LIMITS.note} characters`);
  return note || null;
}

/**
 * Sets the shared draft. `revision` is the draft revision the caller read (0: no draft): a draft someone
 * else changed since is not overwritten. With dry_run nothing is saved and the answer is what would change.
 */
export async function setDraft(tx: Tx, ctx: Ctx, objectName: string, input: DraftInput) {
  manager(ctx);
  await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const { doc, warnings } = checkLayout(schema, obj, input.layout);
  const note = noteOf(input.note);
  const p = await published(tx, schema, obj);
  const draft = await draftOf(tx, obj.id, true);
  const current = draft?.revision ?? 0;
  if (input.revision !== undefined && input.revision !== current) {
    const last = draft ? (await changesOf(tx, obj.id))[0] : undefined;
    throw new ApiError(409, "layout_draft_changed", `The draft is at revision ${current}, not ${input.revision}`
      + `${last ? `: ${actorRef(last.actor_type, last.actor_id) ?? last.actor_type} changed it through ${last.surface}${last.via ? ` (${last.via})` : ""}` : draft ? "" : ": it was published or discarded"}. `
      + "Read the draft again and make your change on top of it.", { revision: current });
  }
  if (input.revision === undefined && draft && !input.dry_run) {
    throw new ApiError(428, "layout_revision_required", `A draft exists at revision ${current}. Read it and send "revision": ${current} with your change, so nobody's work is overwritten unseen.`, { revision: current });
  }
  const before = draft ? toDoc(schema, obj, draft.layout) : p.doc;
  const changes = diffLayouts(schema, obj, before, doc);
  const base = { object: obj.api_name, layout: doc, changes, warnings, diff_from_published: diffLayouts(schema, obj, p.doc, doc) };
  if (input.dry_run) return { dry_run: true, saved: false, revision: current, ...base };
  if (changes.length === 0) return { dry_run: false, saved: false, revision: current, ...base };
  const source = await sourceOf(tx, ctx);
  const revision = await saveDraft(tx, { tenantId: ctx.tenantId, objectId: obj.id, layout: toStored(schema, obj, doc), baseVersion: draft?.base_version ?? p.version });
  await insertChange(tx, { ...source, tenantId: ctx.tenantId, id: uuidv7(), objectId: obj.id, revision, summary: summarize(changes), changes, note,
    before: toStored(schema, obj, before), after: toStored(schema, obj, doc) });
  await trimChanges(tx, obj.id, LAYOUT_LIMITS.draftChanges);
  await audit(tx, ctx, { action: "page_layout.draft_changed", objectType: obj.api_name, details: { revision, changes: changes.length, via: source.via } });
  return { dry_run: false, saved: true, revision, ...base };
}

/** Throws the draft away. The published layout is untouched. */
export async function discardDraft(tx: Tx, ctx: Ctx, objectName: string) {
  manager(ctx);
  const obj = getObject(await loadSchema(tx), objectName);
  if (await deleteDraft(tx, obj.id)) await audit(tx, ctx, { action: "page_layout.draft_discarded", objectType: obj.api_name });
  return getDraft(tx, ctx, objectName);
}

async function loadChange(tx: Tx, obj: ObjectMeta, publicId: string) {
  const d = decodeId(publicId);
  const row = d?.prefix === "lch" ? await changeById(tx, d.uuid) : undefined;
  if (!row || row.object_id !== obj.id) throw notFound(`Layout change ${publicId}`);
  return row;
}

/** Takes back the newest change to the draft: the draft is as it was before it. Recorded as a change of its own. */
export async function undoChange(tx: Tx, ctx: Ctx, objectName: string, changeId: string) {
  manager(ctx);
  await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const draft = await draftOf(tx, obj.id, true);
  const change = await loadChange(tx, obj, changeId);
  if (!draft || change.revision !== draft.revision) {
    throw conflict("Only the newest change to a draft can be undone: later changes were made on top of this one. Change the draft by hand, or discard it.");
  }
  const before = toDoc(schema, obj, change.before);
  const after = toDoc(schema, obj, draft.layout);
  const changes = diffLayouts(schema, obj, after, before);
  const source = await sourceOf(tx, ctx);
  const revision = await saveDraft(tx, { tenantId: ctx.tenantId, objectId: obj.id, layout: change.before, baseVersion: draft.base_version });
  await insertChange(tx, { ...source, tenantId: ctx.tenantId, id: uuidv7(), objectId: obj.id, revision, summary: summarize([`Undid: ${change.summary}`]), changes,
    note: null, before: draft.layout, after: change.before });
  await audit(tx, ctx, { action: "page_layout.draft_changed", objectType: obj.api_name, details: { revision, undid: changeId } });
  return getDraft(tx, ctx, objectName);
}

/** Marks a change as looked at and kept: for a person reviewing what an agent did to the draft. */
export async function reviewChange(tx: Tx, ctx: Ctx, objectName: string, changeId: string) {
  manager(ctx);
  const obj = getObject(await loadSchema(tx), objectName);
  const change = await loadChange(tx, obj, changeId);
  await markChangeReviewed(tx, change.id, ctx.actor.id);
  return getDraft(tx, ctx, objectName);
}

// ----------------------------------------------------------------------------------------------
// Publishing, history and putting a version back

async function publishVersion(tx: Tx, ctx: Ctx, obj: ObjectMeta, v: { stored: StoredLayout | null; changes: string[]; summary: string; contributors: Contributor[]; restoredFrom?: number }) {
  const source = await sourceOf(tx, ctx);
  const version = await publishPageLayout(tx, { tenantId: ctx.tenantId, objectId: obj.id, layout: v.stored, updatedBy: ctx.actor.id });
  await insertVersion(tx, { ...source, tenantId: ctx.tenantId, objectId: obj.id, version, layout: v.stored, summary: v.summary, changes: v.changes,
    contributors: v.contributors, restoredFrom: v.restoredFrom ?? null });
  await trimVersions(tx, obj.id, LAYOUT_LIMITS.versions);
  return { version, source };
}

/**
 * Publishes the draft as the object's next version: every record page shows it from then on. Refused when
 * the published layout moved on since the draft was started, unless `overwrite` says to publish over it.
 */
export async function publishDraft(tx: Tx, ctx: Ctx, objectName: string, input: { note?: string | null; dry_run?: boolean; overwrite?: boolean; revision?: number } = {}) {
  manager(ctx);
  await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const note = noteOf(input.note);
  const draft = await draftOf(tx, obj.id, true);
  if (!draft) throw conflict(`There is no draft of the ${obj.api_name} page to publish`);
  if (input.revision !== undefined && input.revision !== draft.revision) {
    throw new ApiError(409, "layout_draft_changed", `The draft is at revision ${draft.revision}, not ${input.revision}: it changed since you read it. Read it again before publishing.`, { revision: draft.revision });
  }
  const p = await published(tx, schema, obj, true);
  const doc = toDoc(schema, obj, draft.layout);
  const changes = diffLayouts(schema, obj, p.doc, doc);
  const stale = draft.base_version !== p.version;
  if (input.dry_run) return { dry_run: true, published: false, object: obj.api_name, version: p.version, would_publish: p.version + 1, changes, stale, layout: doc };
  if (stale && !input.overwrite) {
    throw new ApiError(409, "layout_draft_stale", `The published ${obj.api_name} layout changed (it is version ${p.version}) since this draft was started from version ${draft.base_version}. `
      + "Publishing would replace it. Compare them, then publish with overwrite: true, or discard the draft.", { published_version: p.version, base_version: draft.base_version });
  }
  const contributors: Contributor[] = (await changesOf(tx, obj.id)).reverse().map((c) => ({
    actor: actorRef(c.actor_type, c.actor_id), surface: c.surface, via: c.via, summary: c.summary, note: c.note, at: c.created_at.toISOString() }));
  const summary = note ?? (changes.length ? summarize(changes) : "Published with no changes");
  const { version, source } = await publishVersion(tx, ctx, obj, { stored: toStored(schema, obj, doc), changes, summary, contributors });
  await deleteDraft(tx, obj.id);
  await audit(tx, ctx, { action: "page_layout.published", objectType: obj.api_name, details: { version, changes: changes.length, contributors: contributors.length, via: source.via } });
  return { dry_run: false, published: true, object: obj.api_name, version, changes, stale: false, layout: doc };
}

/**
 * Publishes a layout in one step, without a draft: schema-as-code (`crm schema apply`) and scripts, which
 * bring their own review. `sections` is the form from before components (ADR 0015): it replaces the page's
 * field sections and keeps the rest. A draft that exists is left alone, and becomes stale.
 */
export async function setLayout(tx: Tx, ctx: Ctx, objectName: string, input: { sections?: unknown; layout?: unknown; note?: string | null; dry_run?: boolean }) {
  manager(ctx);
  await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const p = await published(tx, schema, obj, true);
  if ((input.sections === undefined) === (input.layout === undefined)) throw unprocessable("Send either layout (header, top and columns) or sections");
  let raw = input.layout;
  if (input.sections !== undefined) {
    if (!Array.isArray(input.sections) || input.sections.length === 0) throw unprocessable("sections must be a list with at least one section");
    const rest = (z: Component[]) => z.filter((c) => c.type !== "fields");
    raw = { header: p.doc.header, top: p.doc.top, columns: {
      left: [...input.sections.map((s: unknown) => (isPlain(s) ? { type: "fields", name: s.title, fields: s.fields } : s)), ...rest(p.doc.columns.left)],
      main: rest(p.doc.columns.main), right: rest(p.doc.columns.right) } };
  }
  const { doc, warnings } = checkLayout(schema, obj, raw);
  const changes = diffLayouts(schema, obj, p.doc, doc);
  if (input.dry_run) return { dry_run: true, published: false, version: p.version, changes, warnings, layout: doc };
  // The first layout of an object is recorded even when it arranges the page as the default does: from then on new fields go to "Other fields".
  if (changes.length === 0 && p.custom) return { dry_run: false, published: false, version: p.version, changes, warnings, layout: doc };
  const { version } = await publishVersion(tx, ctx, obj, { stored: toStored(schema, obj, doc), changes,
    summary: noteOf(input.note) ?? (changes.length ? summarize(changes) : "Set the layout"), contributors: [] });
  await audit(tx, ctx, { action: "page_layout.updated", objectType: obj.api_name, details: { version, changes: changes.length, sections: sectionsOf(doc).length, fields: sectionsOf(doc).reduce((n, s) => n + s.fields.length, 0) } });
  return { dry_run: false, published: true, version, changes, warnings, layout: doc };
}

/** Publishes the default page as the next version: the object has no layout of its own again. */
export async function resetLayout(tx: Tx, ctx: Ctx, objectName: string): Promise<LayoutOut> {
  manager(ctx);
  await lockSchema(tx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const p = await published(tx, schema, obj, true);
  if (p.custom) {
    const changes = diffLayouts(schema, obj, p.doc, defaultLayout(schema, obj));
    const { version } = await publishVersion(tx, ctx, obj, { stored: null, changes, summary: "Reset to the default page", contributors: [] });
    await audit(tx, ctx, { action: "page_layout.reset", objectType: obj.api_name, details: { version } });
  }
  return getLayout(tx, ctx, objectName);
}

const versionOut = (schema: Schema, obj: ObjectMeta, v: VersionRow, current: number, withLayout: boolean) => ({
  version: v.version, current: v.version === current, summary: v.summary, changes: v.changes, contributors: v.contributors, restored_from: v.restored_from,
  source: sourceOut(v), at: v.created_at.toISOString(), default_page: v.layout === null,
  ...(withLayout ? { layout: v.layout ? toDoc(schema, obj, v.layout) : defaultLayout(schema, obj) } : {}),
});

/** An object's published versions, newest first, each with who published it and through what. */
export async function listVersions(tx: Tx, ctx: Ctx, objectName: string, limit = LAYOUT_LIMITS.versions) {
  manager(ctx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const current = (await pageLayout(tx, obj.id))?.version ?? 0;
  return (await versionsOf(tx, obj.id, Math.min(Math.max(limit, 1), LAYOUT_LIMITS.versions))).map((v) => versionOut(schema, obj, v, current, false));
}

async function loadVersion(tx: Tx, obj: ObjectMeta, version: number): Promise<VersionRow> {
  const row = Number.isInteger(version) && version > 0 ? await versionOf(tx, obj.id, version) : undefined;
  if (!row) throw notFound(`Version ${version} of the ${obj.api_name} layout`);
  return row;
}

export async function getVersion(tx: Tx, ctx: Ctx, objectName: string, version: number) {
  manager(ctx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const current = (await pageLayout(tx, obj.id))?.version ?? 0;
  return versionOut(schema, obj, await loadVersion(tx, obj, version), current, true);
}

/**
 * Puts an earlier version into the draft, to be looked at and published like any change. Fields and
 * lists it had that no longer exist are left out.
 */
export async function restoreVersion(tx: Tx, ctx: Ctx, objectName: string, input: { version: number; revision?: number; dry_run?: boolean }) {
  manager(ctx);
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const v = await loadVersion(tx, obj, input.version);
  const layout = v.layout ? toDoc(schema, obj, v.layout) : defaultLayout(schema, obj);
  const out = await setDraft(tx, ctx, objectName, { layout, revision: input.revision, note: `Restored version ${v.version}`, dry_run: input.dry_run });
  return { ...out, restored_from: v.version };
}

// ----------------------------------------------------------------------------------------------
// Schema-as-code

/** The published layout for the schema document, or undefined when the object has the default page. */
export async function exportLayout(tx: Tx, schema: Schema, obj: ObjectMeta): Promise<LayoutDoc | undefined> {
  const p = await published(tx, schema, obj);
  return p.custom ? p.doc : undefined;
}
