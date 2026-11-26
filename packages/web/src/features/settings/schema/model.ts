import type { FieldMeta, KnownFieldType, ObjectSummary, SchemaChangeRow, SchemaOrigin } from "@/lib/api/types";

/** The surface a change came through, as people name it. Both MCP servers read as "MCP". */
const SURFACES: Record<string, string> = { web: "Web", "admin-mcp": "MCP", "ops-mcp": "MCP", cli: "CLI", api: "API", system: "System" };
export const surfaceLabel = (surface: string) => SURFACES[surface] ?? surface;

export type PillTone = "neutral" | "accent" | "info" | "warning";
export const surfaceTone = (surface: string): PillTone =>
  surface === "admin-mcp" || surface === "ops-mcp" ? "info" : surface === "cli" ? "accent" : "neutral";

/** Origin as the server sends it, with a fallback for an older server that doesn't send it. */
export function originOf(x: { origin?: SchemaOrigin; pack?: string; standard?: boolean }): { origin: SchemaOrigin; pack?: string } {
  if (x.origin) return { origin: x.origin, ...(x.pack ? { pack: x.pack } : {}) };
  return { origin: x.standard ? "standard" : "custom" };
}
export const originLabel = (x: { origin: SchemaOrigin; pack?: string }) => (x.origin === "pack" ? `${x.pack ?? "Schema"} pack` : x.origin === "custom" ? "Custom" : "Standard");

const MODULES: Record<string, string> = { core: "Core", sales: "Sales", commerce: "Commerce" };
const MODULE_ORDER = ["core", "sales", "commerce"];

export interface ObjectGroup { key: string; name: string; pack: boolean; objects: ObjectSummary[] }

/** Objects the caller can read, grouped by module, then custom objects, then one group per pack that made objects. */
export function groupObjects(all: ObjectSummary[]): ObjectGroup[] {
  const groups = new Map<string, ObjectGroup>();
  const add = (key: string, name: string, pack: boolean, o: ObjectSummary) => {
    const g = groups.get(key) ?? { key, name, pack, objects: [] };
    g.objects.push(o);
    groups.set(key, g);
  };
  for (const o of all) {
    if (!o.access.read || o.hidden) continue;
    const { origin, pack } = originOf(o);
    if (origin === "pack") add(`pack:${pack ?? ""}`, pack ?? "Pack", true, o);
    else if (origin === "custom") add("custom", "Custom", false, o);
    else add(`module:${o.module ?? ""}`, o.module ? (MODULES[o.module] ?? o.module.replace(/^./, (c) => c.toUpperCase())) : "Other", false, o);
  }
  const rank = (g: ObjectGroup) => {
    if (g.key.startsWith("module:")) {
      const i = MODULE_ORDER.indexOf(g.key.slice(7));
      return i === -1 ? MODULE_ORDER.length : i;
    }
    return g.key === "custom" ? 10 : 20;
  };
  return [...groups.values()]
    .map((g) => ({ ...g, objects: [...g.objects].sort((a, b) => a.label.localeCompare(b.label)) }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The types the Add field form offers: the app's known field types, as the server accepts them. */
export const ADDABLE_TYPES: { type: KnownFieldType; label: string }[] = [
  { type: "text", label: "Text" }, { type: "long_text", label: "Long text" }, { type: "number", label: "Number" }, { type: "currency", label: "Currency" },
  { type: "percent", label: "Percent" }, { type: "rating", label: "Rating" }, { type: "duration", label: "Duration" }, { type: "boolean", label: "Yes / no" },
  { type: "date", label: "Date" }, { type: "datetime", label: "Date and time" }, { type: "single_select", label: "Single select" },
  { type: "multi_select", label: "Multi select" }, { type: "status", label: "Status" }, { type: "email", label: "Email" }, { type: "phone", label: "Phone" },
  { type: "url", label: "URL" }, { type: "relation", label: "Relation" }, { type: "address", label: "Address" }, { type: "json", label: "JSON" },
];
export const typeLabel = (type: string) => ADDABLE_TYPES.find((t) => t.type === type)?.label ?? type.replace(/_/g, " ");
export const hasValues = (type: string) => type === "single_select" || type === "multi_select" || type === "status";

/** "Renewal risk" → "renewal_risk": the API name the server accepts (lowercase letters, digits and underscores, starting with a letter). */
export function apiNameFrom(label: string): string {
  const base = label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
  return /^[a-z]/.test(base) ? base : base ? `f_${base}`.slice(0, 63) : "";
}

/** Option labels typed as a comma or line separated list → the {key, label} values the server takes. */
export function parseValues(text: string): { key: string; label: string }[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((label) => ({ key: label.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63) || "value", label }));
}

export interface FieldDraft {
  label: string; apiName: string; type: KnownFieldType; required: boolean; values: string;
  to: string; cardinality: "many_to_one" | "many_to_many"; max: string;
}
export const EMPTY_DRAFT: FieldDraft = { label: "", apiName: "", type: "text", required: false, values: "", to: "", cardinality: "many_to_one", max: "" };

/** The body of POST /v1/objects/{object}/fields (without dry_run), from the form. */
export function fieldBody(d: FieldDraft): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (hasValues(d.type)) options.values = parseValues(d.values);
  if (d.type === "relation") {
    options.to = d.to;
    options.cardinality = d.cardinality;
  }
  if (d.type === "rating" && d.max.trim() !== "") options.max = Number(d.max);
  return {
    api_name: d.apiName.trim(), type: d.type, ...(d.label.trim() ? { label: d.label.trim() } : {}), ...(d.required ? { required: true } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

/** What the server's change type means, in words. */
const CHANGES: Record<string, string> = {
  object_created: "created the object", object_updated: "changed the object", field_added: "added the field", field_updated: "changed the field",
  field_archived: "archived the field", field_retyped: "changed the type of the field", modules_updated: "changed the turned-on modules",
};
export function changeWords(c: Pick<SchemaChangeRow, "change" | "field" | "object">): string {
  const what = CHANGES[c.change] ?? c.change.replace(/_/g, " ");
  return c.field ? `${what} ${c.field}` : what;
}

/** A short text for a value that is simple enough to read inline: text, a number, a yes/no. Anything else gives null. */
function simple(v: unknown): string | null {
  if (typeof v === "string") return v.length <= 40 ? v : null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** "sensitivity: standard → restricted" for the keys that changed between two flat definitions; null when nothing simple changed or one side is missing. */
export function compactDiff(before: unknown, after: unknown): string | null {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(before) || !isObj(after)) {
    const b = simple(before), a = simple(after);
    return b !== null && a !== null && b !== a ? `${b} → ${a}` : null;
  }
  const parts: string[] = [];
  for (const k of Object.keys(after)) {
    const b = simple(before[k]), a = simple(after[k]);
    if (b !== null && a !== null && b !== a) parts.push(`${k}: ${b} → ${a}`);
  }
  return parts.length ? parts.slice(0, 3).join(" · ") : null;
}

/** The text of a "Last change" cell for a field that was never changed: built in, or the pack that made it. Custom fields say nothing. */
export function neverChanged(f: Pick<FieldMeta, "origin" | "pack" | "standard">): string | null {
  const o = originOf(f);
  return o.origin === "standard" ? "Built in" : o.origin === "pack" ? `${o.pack ?? "Schema"} pack` : null;
}
