/** Display formatting for values, in the browser's locale. */

const numberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const compactFmt = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const currencyFmts = new Map<string, Intl.NumberFormat>();

export function formatNumber(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? numberFmt.format(n) : "";
}

export function formatCompact(n: number): string {
  return compactFmt.format(n);
}

/** A money amount in major units, with its ISO currency code. An unknown code falls back to "1,234.00 XYZ". */
export function formatMoney(n: unknown, currency: string | null | undefined, opts: { compact?: boolean } = {}): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "";
  const code = (currency ?? "").toUpperCase();
  const key = `${code}:${opts.compact ? "c" : "f"}`;
  let fmt = currencyFmts.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, code ? { style: "currency", currency: code, ...(opts.compact ? { notation: "compact", maximumFractionDigits: 1 } : {}) }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    currencyFmts.set(key, fmt);
  }
  return fmt.format(n);
}

/** A date-only value (YYYY-MM-DD) as a calendar date, never shifted by the time zone. */
export function formatDate(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return "";
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? v : dateFmt.format(d);
}

export function formatDateTime(v: unknown): string {
  if (typeof v !== "string") return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : dateTimeFmt.format(d);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];

/** "3 hours ago", "in 2 days"; "just now" within a minute. */
export function formatRelative(v: unknown, now = Date.now()): string {
  if (typeof v !== "string") return "";
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return "";
  const s = (t - now) / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "just now";
}

/** Today's date as YYYY-MM-DD in the local time zone. */
export function todayIso(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A datetime-local input's value (local time) from an ISO instant, and back. */
export function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A file's size for people: 512 B, 3.4 KB, 1.2 MB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

export function pluralize(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase() || "?";
}

/** A role's key as words ("field_limited" → "Field limited"), where its name isn't at hand. */
export const roleLabel = (r: string) => r.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
