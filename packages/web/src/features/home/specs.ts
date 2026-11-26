import type { AggregateRequest, AggregateResult, ObjectMeta, Sort, Where } from "@/lib/api/types";
import { formatMoney, formatNumber } from "@/lib/format";
import {
  addDays, and, countOf, daysAgo, empty, eq, gte, hoursAgo, isIn, localDate, lt, lte, moneyOf, or, sentence, startOfDay, startOfMonth,
  startOfNextMonth, startOfQuarter, startOfWeek, totalCount, utcDate, utcMonthStart, utcWeekStart, type Money,
} from "./lib";
import type { TeamKey } from "./teams";

/**
 * What each team's Home asks for. Every request is built in the client from the member's own ID and the
 * clock when it is sent; every field name and status value below is one the standard objects
 * (packages/server/src/core/catalog.ts) or the support-desk pack (packs/support-desk/schema.yaml) define.
 * The server decides what the member may read: a request it refuses with 403 hides its card.
 */

export interface Ctx { me: string; now: Date; currency: string }

export interface CardView {
  /** The big number(s): one per currency when amounts are in more than one. Empty for a card that is only a list. */
  values: string[];
  sub?: string;
  /** A small list under the number (counts per status or priority). */
  lines?: { label: string; value: string }[];
  /** How the number is worked out, when the label alone doesn't say. */
  note?: string;
}

export interface CardSpec {
  key: string;
  label: string;
  /** The object it counts: the card is left out when the member can't read it. */
  object: string;
  /** Cards that show different views of one request share its key, so it is asked once. */
  shared?: string;
  request: (c: Ctx) => AggregateRequest;
  view: (r: AggregateResult, c: Ctx, meta: ObjectMeta | undefined) => CardView;
}

export interface ColSpec { field: string; /** A many-to-one relation, shown by the related record's name (asked for with `include`). */ rel?: boolean; label?: string }

export interface TableSpec {
  object: string;
  title: string;
  sub: string;
  where: (c: Ctx) => Where | undefined;
  /** What the rows are ordered by; `updated_at` stands in when the member can't read it. */
  sort: Sort;
  cols: ColSpec[];
}

export interface TeamSpec { cards: CardSpec[]; table: TableSpec; section?: string }

const iso = (d: Date) => d.toISOString();
const count = (r: AggregateResult): CardView => ({ values: [formatNumber(totalCount(r))] });
const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;
const amounts = (m: Money[]) => m.filter((x) => x.count > 0).map((x) => formatMoney(x.amount, x.currency)).join(" · ");
const optionLabel = (meta: ObjectMeta | undefined, field: string, key: string) => meta?.fields.find((f) => f.name === field)?.values?.find((v) => v.key === key)?.label ?? sentence(key);

/** Counts per value of a select or status field, as a small list in the field's own order. */
const byValue = (r: AggregateResult, field: string, meta: ObjectMeta | undefined) =>
  r.data.filter((g) => g.group[field] != null).map((g) => ({ label: optionLabel(meta, field, String(g.group[field])), value: formatNumber(g.count) }));

const withAmount = (r: AggregateResult, c: Ctx, field: string, label: string): CardView => {
  const m = moneyOf(r, `sum_${field}`, c.currency);
  return { values: [formatNumber(totalCount(r))], ...(amounts(m) ? { sub: `${label}: ${amounts(m)}` } : {}) };
};

/** This period's count against the previous one, from the buckets of one aggregate. */
const signed = (n: number) => (n > 0 ? `+${formatNumber(n)}` : formatNumber(n));

// --- Sales: the member's own deals --------------------------------------------------------------

const mine = (c: Ctx) => eq("owner", c.me);
const openDeals = (c: Ctx) => and(mine(c), eq("status", "open"));

const sales: TeamSpec = {
  cards: [
    {
      key: "sales-pipeline", label: "Open pipeline", object: "deal",
      request: (c) => ({ object: "deal", where: openDeals(c), group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "amount" }], limit: 50 }),
      view: (r, c) => {
        const m = moneyOf(r, "sum_amount", c.currency);
        return { values: m.length ? m.map((x) => formatMoney(x.amount, x.currency)) : [formatMoney(0, c.currency)], sub: plural(totalCount(r), "open deal", "open deals") };
      },
    },
    {
      key: "sales-closing", label: "Closing this month", object: "deal",
      request: (c) => ({
        object: "deal", group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "amount" }], limit: 50,
        where: and(openDeals(c), gte("expected_close_date", localDate(startOfMonth(c.now))), lt("expected_close_date", localDate(startOfNextMonth(c.now)))),
      }),
      view: (r, c) => withAmount(r, c, "amount", "Worth"),
    },
    {
      key: "sales-won", label: "Won this quarter", object: "deal",
      // A deal has no "won on" date of its own: the time it entered its (won) stage is the nearest real one.
      request: (c) => ({
        object: "deal", group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "amount" }], limit: 50,
        where: and(mine(c), eq("status", "won"), gte("stage_entered_at", iso(startOfQuarter(c.now)))),
      }),
      view: (r, c) => ({ ...withAmount(r, c, "amount", "Worth"), note: "By when the deal entered its won stage" }),
    },
    {
      key: "sales-quiet", label: "No activity in 14 days", object: "deal",
      request: (c) => ({ object: "deal", where: and(openDeals(c), or(lt("last_activity_at", iso(daysAgo(c.now, 14))), empty("last_activity_at"))) }),
      view: (r) => ({ ...count(r), sub: "Open deals, including those never touched" }),
    },
  ],
  table: {
    object: "deal", title: "Your open deals", sub: "Least recently active first", where: openDeals,
    sort: { field: "last_activity_at", dir: "asc" },
    cols: [{ field: "account", rel: true }, { field: "stage", rel: true }, { field: "amount" }, { field: "expected_close_date", label: "Close date" }, { field: "last_activity_at", label: "Last activity" }],
  },
};

// --- Marketing: leads ---------------------------------------------------------------------------

const marketing: TeamSpec = {
  cards: [
    {
      key: "mkt-new", label: "New leads this week", object: "lead",
      // One request: leads created since the start of last week, in weekly buckets (Monday, UTC).
      request: (c) => ({ object: "lead", where: gte("created_at", iso(utcWeekStart(c.now, 1))), group_by: [{ field: "created_at", bucket: "week" }] }),
      view: (r, c) => {
        const now = countOf(r, "created_at", utcDate(utcWeekStart(c.now)));
        const before = countOf(r, "created_at", utcDate(utcWeekStart(c.now, 1)));
        return { values: [formatNumber(now)], sub: `${signed(now - before)} vs last week (${formatNumber(before)})` };
      },
    },
    {
      key: "mkt-status", label: "Leads by status", object: "lead",
      request: () => ({ object: "lead", group_by: [{ field: "status" }] }),
      view: (r, _c, meta) => ({ values: [formatNumber(totalCount(r))], sub: "All leads", lines: byValue(r, "status", meta) }),
    },
    {
      key: "mkt-converted", label: "Converted this month", object: "lead",
      request: (c) => ({ object: "lead", where: gte("converted_at", iso(startOfMonth(c.now))) }),
      view: count,
    },
    {
      key: "mkt-waiting", label: "Waiting over 48 hours", object: "lead",
      request: (c) => ({ object: "lead", where: and(eq("status", "new"), lt("created_at", iso(hoursAgo(c.now, 48)))) }),
      view: (r) => ({ ...count(r), sub: "New, and not yet picked up" }),
    },
  ],
  table: {
    object: "lead", title: "Newest leads", sub: "Most recently created first", where: () => undefined,
    sort: { field: "created_at", dir: "desc" },
    cols: [{ field: "status" }, { field: "source" }, { field: "owner", rel: true }, { field: "created_at", label: "Created" }],
  },
};

// --- Customer support: tickets (the support-desk pack) -------------------------------------------

const OPEN_TICKET = ["new", "open", "pending"];
const openTickets = isIn("status", OPEN_TICKET);

const support: TeamSpec = {
  section: "Tickets · support-desk pack",
  cards: [
    {
      key: "sup-open", label: "Open tickets", object: "ticket", shared: "sup-open-by-priority",
      request: () => ({ object: "ticket", where: openTickets, group_by: [{ field: "priority" }] }),
      view: (r) => ({ ...count(r), sub: "New, open or pending" }),
    },
    {
      key: "sup-priority", label: "Open, by priority", object: "ticket", shared: "sup-open-by-priority",
      request: () => ({ object: "ticket", where: openTickets, group_by: [{ field: "priority" }] }),
      view: (r, _c, meta) => ({ values: [], lines: byValue(r, "priority", meta) }),
    },
    {
      key: "sup-today", label: "New today", object: "ticket",
      request: (c) => ({ object: "ticket", where: gte("created_at", iso(startOfDay(c.now))) }),
      view: count,
    },
    {
      key: "sup-solved", label: "Solved this week", object: "ticket",
      request: (c) => ({ object: "ticket", where: and(eq("status", "solved"), gte("updated_at", iso(startOfWeek(c.now)))) }),
      view: (r) => ({ ...count(r), note: "Solved, by last update" }),
    },
  ],
  table: {
    object: "ticket", title: "Your open tickets", sub: "Oldest first", where: (c) => and(mine(c), openTickets),
    sort: { field: "created_at", dir: "asc" },
    cols: [{ field: "priority" }, { field: "status" }, { field: "customer", rel: true }, { field: "created_at", label: "Opened" }],
  },
};

// --- Finance: quotes and orders ------------------------------------------------------------------

const sent = eq("status", "sent");
const inProgress = isIn("status", ["pending", "active"]);

const finance: TeamSpec = {
  cards: [
    {
      key: "fin-sent", label: "Quotes awaiting an answer", object: "quote",
      request: () => ({ object: "quote", where: sent, group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "total" }], limit: 50 }),
      view: (r, c) => withAmount(r, c, "total", "Worth"),
    },
    {
      key: "fin-expiring", label: "Quotes expiring in 7 days", object: "quote",
      request: (c) => ({
        object: "quote", group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "total" }], limit: 50,
        where: and(sent, gte("valid_until", localDate(startOfDay(c.now))), lte("valid_until", localDate(addDays(startOfDay(c.now), 7)))),
      }),
      view: (r, c) => withAmount(r, c, "total", "Worth"),
    },
    {
      key: "fin-orders", label: "Orders in progress", object: "order",
      request: () => ({ object: "order", where: inProgress }),
      view: (r) => ({ ...count(r), sub: "Pending or active" }),
    },
    {
      key: "fin-booked", label: "Booked this month", object: "order",
      // Order totals by creation month, per currency, from last month on: one request gives this month and the one before.
      request: (c) => ({
        object: "order", group_by: [{ field: "created_at", bucket: "month" }, { field: "currency" }], measures: [{ op: "sum", field: "total" }], limit: 100,
        where: and(gte("created_at", iso(utcMonthStart(c.now, 1))), { not: eq("status", "cancelled") }),
      }),
      view: (r, c) => {
        const per = (back: number) => {
          const key = utcDate(utcMonthStart(c.now, back));
          const out = new Map<string, number>();
          for (const g of r.data) {
            if (String(g.group.created_at) !== key) continue;
            const cur = typeof g.group.currency === "string" ? g.group.currency : c.currency;
            const v = g.values.sum_total;
            out.set(cur, (out.get(cur) ?? 0) + (typeof v === "number" ? v : 0));
          }
          return out;
        };
        const now = per(0);
        const before = per(1);
        const currencies = [...new Set([...now.keys(), ...before.keys()])];
        if (!currencies.length) return { values: [formatMoney(0, c.currency)] };
        return {
          values: now.size ? [...now.keys()].map((k) => formatMoney(now.get(k) ?? 0, k)) : [formatMoney(0, c.currency)],
          sub: currencies.map((k) => `${(now.get(k) ?? 0) - (before.get(k) ?? 0) >= 0 ? "+" : "-"}${formatMoney(Math.abs((now.get(k) ?? 0) - (before.get(k) ?? 0)), k)} vs last month (${formatMoney(before.get(k) ?? 0, k)})`).join(" · "),
          note: "Orders created this month, not counting cancelled ones",
        };
      },
    },
  ],
  table: {
    object: "quote", title: "Sent quotes", sub: "Soonest to expire first", where: () => sent,
    sort: { field: "valid_until", dir: "asc" },
    cols: [{ field: "account", rel: true }, { field: "total" }, { field: "valid_until", label: "Valid until" }, { field: "sent_at", label: "Sent" }],
  },
};

// --- Operations: orders and the member's tasks ---------------------------------------------------

const ops: TeamSpec = {
  cards: [
    {
      key: "ops-open", label: "Orders to fulfil", object: "order",
      request: () => ({ object: "order", where: inProgress }),
      view: (r) => ({ ...count(r), sub: "Pending or active" }),
    },
    {
      key: "ops-done", label: "Fulfilled this week", object: "order",
      request: (c) => ({ object: "order", where: and(eq("status", "fulfilled"), gte("updated_at", iso(startOfWeek(c.now)))) }),
      view: (r) => ({ ...count(r), note: "Fulfilled, by last update" }),
    },
    {
      key: "ops-overdue", label: "My overdue tasks", object: "task",
      request: (c) => ({ object: "task", where: and(eq("assignee", c.me), isIn("status", ["open", "in_progress"]), lt("due_at", iso(c.now))) }),
      view: count,
    },
  ],
  table: {
    object: "order", title: "Open orders", sub: "Oldest first", where: () => inProgress,
    sort: { field: "created_at", dir: "asc" },
    cols: [{ field: "account", rel: true }, { field: "status" }, { field: "total" }, { field: "effective_date", label: "Effective" }, { field: "created_at", label: "Created" }],
  },
};

/** The end-user teams. The admin team has its own Home (AdminHome.tsx). */
export const TEAM_SPECS: Record<Exclude<TeamKey, "admin">, TeamSpec> = { sales, marketing, support, finance, ops };
