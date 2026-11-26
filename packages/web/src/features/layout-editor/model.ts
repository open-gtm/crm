import type { LayoutComponent, LayoutDoc, LayoutDraft, LayoutSource } from "@/features/record/pageLayout";
import type { FieldMeta, ObjectMeta, ObjectSummary, RecordData } from "@/lib/api/types";
import { isVisible } from "@/meta/fields";

/** Where a component sits: across the top, or in one of the three columns. */
export type Zone = "top" | "left" | "main" | "right";
export const COLUMNS = ["left", "main", "right"] as const;
export type Column = (typeof COLUMNS)[number];
export const COLUMN_LABEL: Record<Column, string> = { left: "Left column", main: "Main column", right: "Right column" };

/** What the page may hold once (the server refuses a second one). */
export const SINGLE_USE = ["timeline", "notes", "files", "tasks", "quotes", "stage_path", "agent_changes", "related_lists"] as const;
export type SingleUse = (typeof SINGLE_USE)[number];
export const LIMITS = { keyFacts: 6, rows: 25, days: 90 } as const;

/** The header block is selectable like a component; its key can't clash with a component id (ids start with a letter). */
export const HEADER_KEY = "~header";

export const zoneList = (doc: LayoutDoc, z: Zone): LayoutComponent[] => (z === "top" ? doc.top : doc.columns[z]);
const withZone = (doc: LayoutDoc, z: Zone, list: LayoutComponent[]): LayoutDoc =>
  z === "top" ? { ...doc, top: list } : { ...doc, columns: { ...doc.columns, [z]: list } };
export const allComponents = (doc: LayoutDoc): { zone: Zone; c: LayoutComponent }[] =>
  (["top", ...COLUMNS] as Zone[]).flatMap((zone) => zoneList(doc, zone).map((c) => ({ zone, c })));

export function locate(doc: LayoutDoc, id: string): { zone: Zone; index: number } | null {
  for (const zone of ["top", ...COLUMNS] as Zone[]) {
    const index = zoneList(doc, zone).findIndex((c) => c.id === id);
    if (index !== -1) return { zone, index };
  }
  return null;
}
export const findComponent = (doc: LayoutDoc, id: string): LayoutComponent | undefined => allComponents(doc).find((x) => x.c.id === id)?.c;
export const hasType = (doc: LayoutDoc, type: LayoutComponent["type"]) => allComponents(doc).some((x) => x.c.type === type);

/** Changes one component in place; the same document comes back when nothing changed. */
export function updateComponent(doc: LayoutDoc, id: string, fn: (c: LayoutComponent) => LayoutComponent): LayoutDoc {
  const at = locate(doc, id);
  if (!at) return doc;
  const list = zoneList(doc, at.zone);
  const next = fn(list[at.index]!);
  return next === list[at.index] ? doc : withZone(doc, at.zone, list.map((c, i) => (i === at.index ? next : c)));
}

export function removeComponent(doc: LayoutDoc, id: string): LayoutDoc {
  const at = locate(doc, id);
  return at ? withZone(doc, at.zone, zoneList(doc, at.zone).filter((c) => c.id !== id)) : doc;
}

export function addComponent(doc: LayoutDoc, c: LayoutComponent, zone: Zone): LayoutDoc {
  return withZone(doc, zone, [...zoneList(doc, zone), c]);
}

/** One place up or down inside its own list. */
export function moveWithin(doc: LayoutDoc, id: string, d: -1 | 1): LayoutDoc {
  const at = locate(doc, id);
  if (!at) return doc;
  const list = [...zoneList(doc, at.zone)];
  const j = at.index + d;
  if (j < 0 || j >= list.length) return doc;
  [list[at.index], list[j]] = [list[j]!, list[at.index]!];
  return withZone(doc, at.zone, list);
}

/** To the neighbouring column, at the same place in it (or its end when that is shorter). Only column components move this way. */
export function moveAcross(doc: LayoutDoc, id: string, d: -1 | 1): LayoutDoc {
  const at = locate(doc, id);
  if (!at || at.zone === "top") return doc;
  const target = COLUMNS[COLUMNS.indexOf(at.zone) + d];
  if (!target) return doc;
  const c = zoneList(doc, at.zone)[at.index]!;
  const into = [...zoneList(doc, target)];
  into.splice(Math.min(at.index, into.length), 0, c);
  return withZone(withZone(doc, at.zone, zoneList(doc, at.zone).filter((x) => x.id !== id)), target, into);
}

/** Drops a component into a column: before `beforeId`, or at the end when none is given. */
export function moveInto(doc: LayoutDoc, id: string, zone: Column, beforeId: string | null): LayoutDoc {
  const at = locate(doc, id);
  if (!at || at.zone === "top" || id === beforeId) return doc;
  const c = zoneList(doc, at.zone)[at.index]!;
  const without = removeComponent(doc, id);
  const into = [...zoneList(without, zone)];
  const index = beforeId === null ? into.length : into.findIndex((x) => x.id === beforeId);
  into.splice(index === -1 ? into.length : index, 0, c);
  const next = withZone(without, zone, into);
  return JSON.stringify(next) === JSON.stringify(doc) ? doc : next;
}

/** An id the server accepts (lowercase letters, digits, underscores, starting with a letter, at most 40) and no other component uses. */
export function newId(doc: LayoutDoc, base: string): string {
  const taken = new Set(allComponents(doc).map((x) => x.c.id));
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 30) || "component";
  for (let n = 1; ; n++) {
    const id = n === 1 ? root : `${root}_${n}`;
    if (!taken.has(id)) return id;
  }
}

/** A section name no other section has (the server compares them without regard to case). */
export function newSectionName(doc: LayoutDoc): string {
  const names = new Set(allComponents(doc).flatMap((x) => (x.c.type === "fields" ? [x.c.name.toLowerCase()] : [])));
  for (let n = 1; ; n++) {
    const name = n === 1 ? "New section" : `New section ${n}`;
    if (!names.has(name.toLowerCase())) return name;
  }
}

export const sections = (doc: LayoutDoc): Extract<LayoutComponent, { type: "fields" }>[] =>
  allComponents(doc).flatMap((x) => (x.c.type === "fields" ? [x.c] : []));
export const placedFields = (doc: LayoutDoc): Set<string> => new Set(sections(doc).flatMap((s) => s.fields));

/** Fields the header may show as key facts (the server refuses long text, JSON, addresses and many-to-many relations). */
export const eligibleKeyFact = (f: FieldMeta) =>
  isVisible(f) && !f.hidden && f.type !== "long_text" && f.type !== "json" && f.type !== "address" && f.relation?.cardinality !== "many_to_many";

/** The fields the member can see and the page can place: never one the API didn't return for them. */
export const placeableFields = (meta: ObjectMeta): FieldMeta[] => meta.fields.filter((f) => isVisible(f) && !f.hidden);

export const typeLabel = (f: FieldMeta) => f.type.replace(/_/g, " ");

/** One relation that points at the object being customized: the records of `object` whose `field` is the page's record. */
export interface RelationOption { object: string; objectLabel: string; field: string; fieldLabel: string }

export function relationOptions(object: string, metas: (ObjectMeta | undefined)[]): RelationOption[] {
  return metas.flatMap((m) => (m ? m.fields.filter((f) => f.type === "relation" && f.relation?.to === object && isVisible(f)).map((f) => ({
    object: m.name, objectLabel: m.plural_label, field: f.name, fieldLabel: f.label })) : []));
}

/** Everything the editor needs to describe and offer components: the object, and the workspace's objects by name. */
export interface Env {
  meta: ObjectMeta;
  objects: ObjectSummary[];
  relations: RelationOption[];
}

export const objectLabel = (env: Env, name: string, plural = false) => {
  const o = env.objects.find((x) => x.name === name);
  return o ? (plural ? o.plural_label : o.label) : name;
};
export const fieldLabel = (meta: ObjectMeta, name: string) => meta.fields.find((f) => f.name === name)?.label ?? name;

export interface Described { kind: string; name: string; summary: string; help: string }

/** What a component is called and says about itself, from the real object and field labels. */
export function describe(c: LayoutComponent, env: Env): Described {
  switch (c.type) {
    case "fields": return { kind: "Field section", name: c.name, summary: `${c.fields.length} field${c.fields.length === 1 ? "" : "s"}`,
      help: "A named group of this object's fields. A field can be in one section only." };
    case "related": {
      const rel = env.relations.find((r) => r.object === c.object && r.field === c.field);
      const same = env.relations.filter((r) => r.object === c.object).length > 1;
      return { kind: "Related list", name: `${objectLabel(env, c.object, true)}${same ? ` · ${rel?.fieldLabel ?? c.field}` : ""}`, summary: `${c.rows} row${c.rows === 1 ? "" : "s"}`,
        help: `Records of ${objectLabel(env, c.object, true)} whose ${rel?.fieldLabel ?? c.field} is this record.` };
    }
    case "related_lists": return { kind: "Other related lists", name: "Other related lists", summary: "every related list not placed on its own",
      help: "Every related list that isn't placed on its own elsewhere on the page." };
    case "timeline": return { kind: "Activity timeline", name: "Activity timeline", summary: "activities, tasks and stage changes", help: "Activities, tasks and stage changes on this record, newest first." };
    case "notes": return { kind: "Notes", name: "Notes", summary: "notes on this record", help: "The notes written on this record." };
    case "files": return { kind: "Files", name: "Files", summary: "files attached to this record", help: "The files attached to this record." };
    case "tasks": return { kind: "Open tasks", name: "Open tasks", summary: `${c.rows} row${c.rows === 1 ? "" : "s"}`, help: "Open tasks linked to this record." };
    case "quotes": return { kind: "Quotes", name: "Quotes", summary: `${c.rows} row${c.rows === 1 ? "" : "s"}`, help: `Quotes made for this ${env.meta.label.toLowerCase()}.` };
    case "stage_path": return { kind: "Stage path", name: "Stage path", summary: c.field ? `follows ${fieldLabel(env.meta, c.field)}` : "follows the deal's pipeline",
      help: c.field ? `Shows the stages of ${fieldLabel(env.meta, c.field)} and where this record is.` : "Shows the pipeline's stages and where this record is." };
    case "agent_changes": return { kind: "Changes by agents", name: "Changes by agents", summary: `last ${c.days} day${c.days === 1 ? "" : "s"}`,
      help: "Changes made to this record through API keys, MCP clients and the CLI." };
  }
}
// --- Sources and people -------------------------------------------------------------------------

const SURFACES: Record<string, string> = { web: "Web", "admin-mcp": "Admin MCP", cli: "CLI", api: "API", unknown: "Unknown" };
export const surfaceLabel = (surface: string) => SURFACES[surface] ?? (surface === "system" ? "System" : "Unknown");
export const isAgentSurface = (s: LayoutSource) => s.surface !== "web";

/** "<app or key> for <member>", the member alone, the app or key alone, or nothing known. */
export function whoLabel(s: LayoutSource, name: (actor: string) => string): string {
  const person = s.actor ? name(s.actor) : null;
  return s.via && person ? `${s.via} for ${person}` : person ?? s.via ?? "Unknown";
}

/** The draft's changes newest first, whatever order the server sent them in. */
export const changesNewestFirst = (d: LayoutDraft) => [...d.changes].sort((a, b) => b.revision - a.revision);

/** The change an agent made that nobody has looked at yet: the newest one, if there is one. */
export const unreviewedAgentChange = (d: LayoutDraft) => changesNewestFirst(d).find((c) => isAgentSurface(c.source) && !c.reviewed);

export const distinctActors = (d: LayoutDraft) => new Set(d.changes.map((c) => c.source.actor ?? `${c.source.surface}:${c.source.via ?? ""}`)).size;

export function draftStatus(d: LayoutDraft): string {
  if (!d.has_draft) return d.published_custom || d.published_version > 0 ? `Published v${d.published_version}` : "Default page";
  const n = d.changes.length;
  const people = distinctActors(d);
  return `Draft · ${n} change${n === 1 ? "" : "s"}, ${people} ${people === 1 ? "person" : "people"}`;
}

// --- What every panel shares ----------------------------------------------------------------------

/** What choosing "Preview as" a role hides: the fields and objects that role can't read. Nothing here changes the layout. */
export interface RolePreview { roleName: string; hiddenFields: Set<string>; hiddenObjects: Set<string> }

export interface EditorCtx {
  env: Env;
  doc: LayoutDoc;
  edit: (fn: (doc: LayoutDoc) => LayoutDoc) => void;
  selected: string | null;
  select: (id: string | null) => void;
  /** The record the page is shown with: its values fill the canvas. None: labels only. */
  record: RecordData | undefined;
  preview: RolePreview | null;
}

/** Components that read another object are hidden from a role that can't read it. */
export function hiddenFrom(c: LayoutComponent, preview: RolePreview | null): boolean {
  if (!preview) return false;
  const object = c.type === "related" ? c.object : c.type === "quotes" ? "quote" : c.type === "tasks" ? "task" : null;
  return object !== null && preview.hiddenObjects.has(object);
}
