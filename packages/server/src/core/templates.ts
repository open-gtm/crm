import { ApiError, unprocessable } from "../lib/errors.js";
import { formatDuration } from "./fieldtypes.js";

/**
 * Placeholders in automation steps: `{{record.name}}`, `{{steps.lookup.count}}`, `{{item.email}}`,
 * `{{today+3d}}`, with optional filters: `{{record.amount | number:2}}`, `{{record.due_at | add_days:7 | date}}`.
 *
 * Nothing is ever evaluated as code. A placeholder is a path through the documented context (own
 * properties of plain objects and arrays only, never a prototype), then a fixed list of filters. Each
 * output context escapes what it inserts: URL parts are percent-encoded, header values may not hold
 * line breaks, email subjects are one line, JSON bodies take values as values (never spliced into JSON
 * text). A placeholder that is the whole value keeps its type (a number stays a number).
 */

export interface TemplateScope {
  record: Record<string, unknown> | null;
  event: { type: string; id: string } | null;
  item?: Record<string, unknown> | null;
  steps?: Record<string, unknown>;
  run?: { id: string } | null;
  automation?: { id: string; name: string } | null;
}

/** Where a filled string goes, which decides how a value is escaped. */
export type Target = "value" | "text" | "url" | "header" | "subject" | "email";

export const ROOTS = ["record", "event", "item", "steps", "run", "automation"] as const;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
// Capitals are allowed for the keys of another system's JSON (an HTTP reply: {{steps.fetch.json.records.0.Id}}); field names are lowercase.
const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,3})$/;
const DATE_EXPR = /^(today|now)(?:([+-])(\d{1,4})([mhd]))?$/;
const PLACEHOLDER = /\{\{([^{}]{1,300})\}\}/g;
const WHOLE = /^\{\{([^{}]{1,300})\}\}$/;
/** Most placeholders one string may hold, checked when an automation is saved. */
export const MAX_PLACEHOLDERS = 50;

/**
 * A value the automation may not read (a restricted field), as the runner holds it: an object, not the
 * text "[restricted]", so a record whose text is literally "[restricted]" is not taken for one. It is
 * not a plain object, so a path can't walk into it; in saved progress it is {"$restricted": true}.
 */
class Restricted {
  toJSON() {
    return { $restricted: true };
  }
}
export const RESTRICTED: unknown = Object.freeze(new Restricted());
/** Turns saved {"$restricted": true} back into the marker (progress read back after a restart). */
export function reviveRestricted(v: unknown, depth = 0): unknown {
  if (depth > 30 || !v || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => reviveRestricted(x, depth + 1));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === "$restricted" && o.$restricted === true) return RESTRICTED;
  return Object.fromEntries(keys.map((k) => [k, reviveRestricted(o[k], depth + 1)]));
}

/**
 * A value from a record that a step can't use (too long, not a date, a header it can't carry, an address
 * that can't be emailed). The step fails, but the run is not counted towards the automatic pause: outside
 * content (a web form, an import) must not be able to switch an admin's automation off.
 */
export class DataError extends ApiError {
  constructor(message: string) {
    super(422, "data_error", message);
  }
}

/** A cap on what one fill may produce, in characters: checked as it goes, so a template can't build megabytes first. */
export interface Budget { left: number; readonly max: number; readonly what: string }
export const budget = (max: number, what: string): Budget => ({ left: max, max, what });
function charge(b: Budget | undefined, n: number): void {
  if (!b) return;
  b.left -= n;
  if (b.left < 0) throw new DataError(`${b.what} would be longer than ${b.max.toLocaleString("en-US")} characters once its placeholders are filled`);
}
/** Characters a value takes once written out, without writing out more than the budget allows. */
const sizeOf = (v: unknown): number => (typeof v === "string" ? v.length : v === null || v === undefined ? 0 : JSON.stringify(v)?.length ?? 0);

const FILTERS: Record<string, { args: "none" | "int" | "str" | "int?"; fn: (v: unknown, arg: string | number | undefined) => unknown }> = {
  upper: { args: "none", fn: (v) => (v == null ? v : asText(v).toUpperCase()) },
  lower: { args: "none", fn: (v) => (v == null ? v : asText(v).toLowerCase()) },
  trim: { args: "none", fn: (v) => (v == null ? v : asText(v).trim()) },
  default: { args: "str", fn: (v, a) => (v == null || v === "" || (Array.isArray(v) && v.length === 0) ? a : v) },
  truncate: { args: "int", fn: (v, a) => (v == null ? v : [...asText(v)].slice(0, Number(a)).join("")) },
  count: { args: "none", fn: (v) => (Array.isArray(v) ? v.length : v == null ? 0 : 1) },
  join: { args: "str", fn: (v, a) => (Array.isArray(v) ? v.map(asText).join(String(a)) : v) },
  number: { args: "int?", fn: (v, a) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? (a === undefined ? n : n.toFixed(Math.min(Number(a), 10))) : null;
  } },
  date: { args: "none", fn: (v) => toDate(v)?.toISOString().slice(0, 10) ?? null },
  datetime: { args: "none", fn: (v) => toDate(v)?.toISOString() ?? null },
  // Milliseconds since 1970, the form some APIs take dates in: {{now-1h | epoch_ms}}.
  epoch_ms: { args: "none", fn: (v) => toDate(v)?.getTime() ?? null },
  add_days: { args: "int", fn: (v, a) => {
    const d = toDate(v);
    if (!d) return null;
    const out = new Date(d.getTime() + Number(a) * 86_400_000);
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? out.toISOString().slice(0, 10) : out.toISOString();
  } },
  json: { args: "none", fn: (v) => JSON.stringify(v ?? null) },
  // A duration field holds whole seconds: 5400 reads as "1h 30m". A percent field holds percentage points: 12.5 reads as "12.5%".
  duration: { args: "none", fn: (v) => (typeof v === "number" ? formatDuration(v) : v) },
  percent: { args: "int?", fn: (v, a) => (typeof v === "number" && Number.isFinite(v) ? `${a === undefined ? String(v) : v.toFixed(Math.min(Number(a), 10))}%` : v) },
};

function asText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(asText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Parsed { path: string[]; date: RegExpExecArray | null; filters: { name: string; arg: string | number | undefined }[] }

/** Splits `path | f:arg | g` on pipes outside double quotes. */
function splitPipes(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of s) {
    if (ch === "\"") quoted = !quoted;
    if (ch === "|" && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (quoted) throw unprocessable("A placeholder has an unclosed quote");
  out.push(cur);
  return out.map((x) => x.trim());
}

const parseCache = new Map<string, Parsed>();

/** Parses the inside of one placeholder, or throws a 422 naming what is wrong. */
export function parsePlaceholder(inner: string): Parsed {
  const hit = parseCache.get(inner);
  if (hit) return hit;
  const [head, ...rest] = splitPipes(inner);
  if (!head) throw unprocessable(`Empty placeholder {{${inner}}}`);
  const date = DATE_EXPR.exec(head);
  const path = date ? [] : head.split(".");
  if (!date) {
    if (!(ROOTS as readonly string[]).includes(path[0]!)) {
      throw unprocessable(`Unknown placeholder {{${head}}}. Use {{record.<field>}}, {{item.<field>}}, {{steps.<id>.<output>}}, {{event.type}}, {{run.id}}, {{automation.name}}, {{today}}, {{today+3d}} or {{now}}`);
    }
    if (path.length < 2 || path.length > 6 || path.some((p) => !SEGMENT.test(p) || FORBIDDEN_KEYS.has(p))) {
      throw unprocessable(`Placeholder {{${head}}} is not a valid path: use names and numbers separated by dots`);
    }
  }
  if (rest.length > 5) throw unprocessable(`Placeholder {{${inner}}} has more than 5 filters`);
  const filters = rest.map((f) => {
    const m = /^([a-z_]+)(?::(?:"([^"]{0,200})"|(-?\d{1,6})))?$/.exec(f);
    const spec = m ? FILTERS[m[1]!] : undefined;
    if (!m || !spec || !Object.hasOwn(FILTERS, m[1]!)) throw unprocessable(`Unknown filter "${f}" in {{${inner}}}. Filters: ${Object.keys(FILTERS).join(", ")}`);
    const arg = m[2] !== undefined ? m[2] : m[3] !== undefined ? Number(m[3]) : undefined;
    const ok = spec.args === "none" ? arg === undefined : spec.args === "int" ? typeof arg === "number" : spec.args === "int?" ? arg === undefined || typeof arg === "number" : typeof arg === "string";
    if (!ok) throw unprocessable(`Filter "${m[1]}" in {{${inner}}} takes ${spec.args === "none" ? "no argument" : spec.args === "str" ? "a quoted text argument" : "a whole-number argument"}`);
    if (m[1] === "truncate" && (Number(arg) < 0 || Number(arg) > 10_000)) throw unprocessable("truncate takes 0 to 10000");
    if ((m[1] === "number" || m[1] === "percent") && arg !== undefined && (Number(arg) < 0 || Number(arg) > 10)) throw unprocessable(`${m[1]} takes 0 to 10 decimal places`);
    if (m[1] === "add_days" && Math.abs(Number(arg)) > 36_500) throw unprocessable("add_days takes -36500 to 36500");
    return { name: m[1]!, arg };
  });
  const parsed = { path, date, filters };
  if (parseCache.size > 5000) parseCache.clear();
  parseCache.set(inner, parsed);
  return parsed;
}

/** Every placeholder in a string, parsed (validation at save time). */
export function placeholders(s: string): Parsed[] {
  return [...s.matchAll(PLACEHOLDER)].map((m) => parsePlaceholder(m[1]!));
}

/** Every string inside a JSON-like value (for validating bodies and value maps). */
export function strings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out, depth + 1);
  return out;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** Walks a path through own properties of plain objects and arrays; anything else ends it with null. */
function walk(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    // A part of a restricted value (a restricted address's city) is restricted too: the marker, which resolve refuses.
    if (cur instanceof Restricted) return cur;
    if (cur === null || cur === undefined || FORBIDDEN_KEYS.has(seg)) return null;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return null;
      cur = cur[Number(seg)];
    } else if (isPlain(cur)) {
      cur = Object.hasOwn(cur, seg) ? cur[seg] : null;
    } else return null;
  }
  return cur === undefined ? null : cur;
}

function resolve(p: Parsed, scope: TemplateScope, now: Date): unknown {
  let v = lookup(p, scope, now);
  // Checked before the filters too: `| json` would turn the marker into text.
  if (containsRestricted(v)) throw unprocessable("A placeholder refers to a restricted value, which automations never read or send");
  for (const f of p.filters) {
    try {
      v = FILTERS[f.name]!.fn(v, f.arg);
    } catch {
      throw new DataError(`The ${f.name} filter can't use this value`);
    }
  }
  return v;
}

function lookup(p: Parsed, scope: TemplateScope, now: Date): unknown {
  let v: unknown;
  if (p.date) {
    const [, base, sign, n, unit] = p.date;
    const ms = n ? Number(n) * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000) * (sign === "-" ? -1 : 1) : 0;
    const at = new Date(now.getTime() + ms);
    v = base === "today" ? at.toISOString().slice(0, 10) : at.toISOString();
  } else {
    const [root, ...rest] = p.path as [(typeof ROOTS)[number], ...string[]];
    const base = root === "record" ? scope.record : root === "event" ? scope.event : root === "item" ? scope.item
      : root === "steps" ? scope.steps : root === "run" ? scope.run : scope.automation;
    v = walk(base ?? null, rest);
  }
  return v;
}

export function containsRestricted(v: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (v instanceof Restricted) return true;
  if (Array.isArray(v)) return v.some((x) => containsRestricted(x, depth + 1));
  if (isPlain(v)) return Object.values(v).some((x) => containsRestricted(x, depth + 1));
  return false;
}

/** True for C0 control characters and DEL. `keep` lists the ones allowed through (line breaks in an email body). */
const isControl = (ch: string, keep = "") => {
  const c = ch.charCodeAt(0);
  return (c < 32 || c === 127) && !keep.includes(ch);
};
export const stripControl = (s: string, keep = "") => [...s].filter((ch) => !isControl(ch, keep)).join("");
export const hasControl = (s: string) => [...s].some((ch) => isControl(ch));

function escapeFor(target: Target, text: string): string {
  switch (target) {
    case "url": return encodeURIComponent(text);
    case "header": return stripControl(text); // a line break from a record can't start another header
    case "subject": return stripControl(text.replace(/[\r\n\t]+/g, " "));
    case "email": return stripControl(text.replace(/\r\n?/g, "\n"), "\n\t");
    default: return text;
  }
}

export interface FillOpts {
  target?: Target;
  /** What the filled result may add up to; shared by every string of one fill (a JSON body, a value map). */
  budget?: Budget;
  now?: Date;
}

/**
 * Fills one string. In "value" position a string that is only a placeholder keeps the value's type.
 * A restricted value anywhere in what a placeholder yields is refused, whatever the step: written to a
 * record, the marker would replace the real value. The budget is charged per placeholder, as it goes.
 */
export function fillString(s: string, scope: TemplateScope, opts: FillOpts = {}): unknown {
  const target = opts.target ?? "value";
  const now = opts.now ?? new Date();
  const whole = WHOLE.exec(s);
  if (whole && target === "value") {
    const v = resolve(parsePlaceholder(whole[1]!), scope, now);
    charge(opts.budget, sizeOf(v));
    return v;
  }
  let out = "";
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER)) {
    const literal = s.slice(last, m.index);
    charge(opts.budget, literal.length);
    const text = escapeFor(target, asText(resolve(parsePlaceholder(m[1]!), scope, now)));
    charge(opts.budget, text.length);
    out += literal + text;
    last = m.index + m[0].length;
  }
  charge(opts.budget, s.length - last);
  return out + s.slice(last);
}

/** A template's path and query as written: the path split into segments, the query after `?` (outside placeholders). */
function splitUrl(template: string): { origin: string; segments: string[]; query: string | null } {
  let q = -1;
  let depth = 0;
  for (let i = 0; i < template.length && q < 0; i++) {
    if (template.startsWith("{{", i)) depth++;
    else if (template.startsWith("}}", i) && depth > 0) depth--;
    else if (depth === 0 && (template[i] === "?" || template[i] === "#")) q = i;
  }
  const head = q < 0 ? template : template.slice(0, q);
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(head)?.[0] ?? "";
  return { origin, segments: head.slice(origin.length).split("/"), query: q < 0 ? null : template.slice(q) };
}

/** A filled path segment the URL parser would drop or climb out of: empty, `.` or `..`, also when percent-encoded. */
const DOT_SEGMENT = /^(?:\.|%2e){0,2}$/i;

/**
 * Fills a URL template: the origin is as written, each path segment is filled on its own (values are
 * percent-encoded, so a value can't add a segment), and a filled segment may not be empty, `.` or `..`
 * (the parser would remove it or the one before, moving the request to another path of the same host
 * with the same secret headers). The query is filled as one part per placeholder.
 */
export function fillUrl(template: string, scope: TemplateScope, opts: Omit<FillOpts, "target"> = {}): string {
  const { origin, segments, query } = splitUrl(template);
  charge(opts.budget, origin.length);
  const path = segments.map((seg, i) => {
    if (!seg.includes("{{")) {
      charge(opts.budget, seg.length + 1);
      return seg;
    }
    const filled = fillString(seg, scope, { ...opts, target: "url" }) as string;
    charge(opts.budget, 1);
    if (DOT_SEGMENT.test(filled)) throw new DataError(`Path segment ${i} of the request URL would be ${filled ? `"${filled}"` : "empty"} once filled, which would change the path`);
    return filled;
  });
  return origin + path.join("/") + (query === null ? "" : fillString(query, scope, { ...opts, target: "url" }) as string);
}

/**
 * True when a filled, parsed URL kept the template's path: the same number of segments, and every
 * segment written without placeholders unchanged. The parser normalises some forms fillUrl can't see.
 */
export function samePath(template: string, pathname: string): boolean {
  const { segments } = splitUrl(template);
  const got = pathname.split("/");
  if (got.length !== segments.length) return false;
  return segments.every((seg, i) => seg.includes("{{") || new URL(`https://x${seg.startsWith("/") ? "" : "/"}${seg}`).pathname.slice(1) === got[i]);
}

/** The part of an http_request URL a secret header is bound to: the origin and the path as written up to its first placeholder. */
export function secretScope(template: string): string {
  const { origin, segments } = splitUrl(template);
  const path = segments.join("/");
  const cut = path.indexOf("{{");
  return (origin + (cut < 0 ? path : path.slice(0, cut))).toLowerCase();
}

/** Fills every string in a JSON-like value (a JSON body, an array of values), keeping its structure. Keys are never filled. */
export function fillDeep(v: unknown, scope: TemplateScope, opts: FillOpts = {}, depth = 0): unknown {
  if (depth > 20) throw unprocessable("A template is nested too deeply (at most 20 levels)");
  if (typeof v === "string") return fillString(v, scope, opts);
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, scope, opts, depth + 1));
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, scope, opts, depth + 1)]));
  return v;
}

/**
 * Fills {{record.field}}, {{event.type}}, {{today}} and {{today+3d}} placeholders in a value map. A value
 * that is only a placeholder keeps its type. An object (an address's parts, a json value) is filled
 * throughout, keys never. `budgets` gives each key its own cap (a field's longest value).
 */
export function fillTemplates(values: Record<string, unknown>, scope: TemplateScope, opts: FillOpts & { budgets?: (key: string) => Budget } = {}): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => {
    const o = opts.budgets ? { ...opts, budget: opts.budgets(k) } : opts;
    return [k, typeof v === "string" ? fillString(v, scope, o) : Array.isArray(v) || isPlain(v) ? fillDeep(v, scope, o) : v];
  }));
}
