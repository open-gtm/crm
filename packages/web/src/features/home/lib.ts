import type { AggregateResult, ObjectSummary, Where } from "@/lib/api/types";
import { TEAMS, type TeamKey } from "./teams";

/**
 * Pure helpers for Home: which team a member sees, the dates the requests are built from, and the
 * small pieces of filter and result handling the cards and tables share. Dates are computed from the
 * clock when a request is made, never fixed in the code.
 */

/** The team Home shows: the stored one, if it is offered here (its object is readable, or its permission is held). */
export function availableTeam(team: TeamKey | null, objects: Pick<ObjectSummary, "name" | "access">[], can: (permission: string) => boolean): TeamKey | null {
  if (!team) return null;
  const def = TEAMS.find((t) => t.key === team);
  if (!def) return null;
  if ("needsObject" in def && !objects.some((o) => o.name === def.needsObject && o.access.read)) return null;
  if ("needsPermission" in def && !can(def.needsPermission)) return null;
  return team;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A calendar date as the API takes date fields: YYYY-MM-DD, in the member's own calendar. */
export const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A date as YYYY-MM-DD in UTC: the key of a week or month bucket in an aggregate. */
export const utcDate = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const startOfDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());
/** Monday 00:00 of this week, local. */
export const startOfWeek = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
export const startOfMonth = (now: Date) => new Date(now.getFullYear(), now.getMonth(), 1);
export const startOfNextMonth = (now: Date) => new Date(now.getFullYear(), now.getMonth() + 1, 1);
export const startOfQuarter = (now: Date) => new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
export const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);
export const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000);
export const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** The Monday (UTC) that starts the week an aggregate's `week` bucket names, `back` weeks before `now`'s. */
export const utcWeekStart = (now: Date, back = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7) - 7 * back));
/** The first day (UTC) of the month `back` months before `now`'s. */
export const utcMonthStart = (now: Date, back = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));

// Filters.
export const eq = (field: string, value: unknown): Where => ({ field, op: "eq", value });
export const isIn = (field: string, value: string[]): Where => ({ field, op: "in", value });
export const gte = (field: string, value: string): Where => ({ field, op: "gte", value });
export const lt = (field: string, value: string): Where => ({ field, op: "lt", value });
export const lte = (field: string, value: string): Where => ({ field, op: "lte", value });
export const and = (...w: Where[]): Where => ({ and: w });
export const or = (...w: Where[]): Where => ({ or: w });
export const empty = (field: string): Where => ({ field, op: "is_null", value: true });

/** One total per currency from an aggregate that grouped by `currency` (or whose server-side total carries one). */
export interface Money { currency: string; amount: number; count: number }
export function moneyOf(r: AggregateResult, measure: string, fallbackCurrency: string): Money[] {
  const byCurrency = new Map<string, Money>();
  for (const g of r.data) {
    const key = r.group_by.some((x) => x.field === "currency") && typeof g.group.currency === "string" ? g.group.currency : g.currency ?? fallbackCurrency;
    const m = byCurrency.get(key) ?? { currency: key, amount: 0, count: 0 };
    const v = g.values[measure];
    m.amount += typeof v === "number" ? v : 0;
    m.count += g.count;
    byCurrency.set(key, m);
  }
  return [...byCurrency.values()];
}

export const totalCount = (r: AggregateResult) => r.data.reduce((n, g) => n + g.count, 0);

/** The count of the group whose key (as text) is `key`, 0 when there is none. */
export const countOf = (r: AggregateResult, field: string, key: string) => r.data.filter((g) => String(g.group[field] ?? "") === key).reduce((n, g) => n + g.count, 0);

const words = (s: string) => s.replace(/[_.]/g, " ");
export const sentence = (s: string) => { const t = words(s); return t.charAt(0).toUpperCase() + t.slice(1); };

/** How a change arrived, for people: MCP, API or CLI (the automation engine and the system are not agents). */
const SURFACE_LABEL: Record<string, string> = { api: "API", cli: "CLI", "admin-mcp": "MCP", "ops-mcp": "MCP", web: "Web app", automation: "Automation", system: "System" };
export const surfaceLabel = (surface: string) => SURFACE_LABEL[surface] ?? surface;
/** "via Claude" when the API names the app or key, else the surface. */
export const sourceText = (surface: string, via: string | null | undefined) => (via ? `via ${via}` : surfaceLabel(surface));
