import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { availableTeam, localDate, startOfMonth, startOfNextMonth, utcDate, utcMonthStart, utcWeekStart } from "@/features/home/lib";
import { TEAMS } from "@/features/home/teams";
import type { AggregateResult } from "@/lib/api/types";
import { field, objectMeta, renderRoute, SESSION, type Call, type Handler } from "./utils";

const ME = "usr_ME";
const summary = (name: string) => ({ name, label: name[0]!.toUpperCase() + name.slice(1), plural_label: `${name[0]!.toUpperCase()}${name.slice(1)}s`, id_prefix: name.slice(0, 3), standard: true, owned: true, field_count: 5, access: { read: true, write: true, archive: true } });
const OBJECTS = ["deal", "lead", "task", "quote", "order", "ticket", "account"].map(summary);
const NO_TICKETS = OBJECTS.filter((o) => o.name !== "ticket");
const ADMIN = { ...SESSION, permissions: [...SESSION.permissions, "audit:read", "members:manage", "webhooks:manage", "keys:manage"] };

const agg = (data: AggregateResult["data"] = [{ group: {}, count: 0, values: {} }], group_by: AggregateResult["group_by"] = []): { body: AggregateResult } => ({
  body: { data, group_by, measures: [], truncated: false, rows_capped: false },
});
const whereOf = (c: Call) => JSON.stringify((c.body as { where?: unknown }).where ?? null);
const aggregates = (calls: Call[]) => calls.filter((c) => c.path === "/v1/aggregate");
const queries = (calls: Call[]) => calls.filter((c) => c.path === "/v1/query");

const DEAL = objectMeta({ name: "deal", fields: [field({ name: "account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }), field({ name: "amount", type: "currency" }), field({ name: "currency", type: "text" }),
  field({ name: "last_activity_at", type: "datetime" }), field({ name: "status", type: "single_select", values: [{ key: "open", label: "Open" }] })] });
const LEAD = objectMeta({ name: "lead", fields: [field({ name: "status", type: "status", values: [{ key: "new", label: "New" }, { key: "working", label: "Working" }] }), field({ name: "source", type: "text" }), field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } })] });

/** The app's Home for a member whose team preference is `team`; `extra` answers first. */
function home(team: string | null, extra: Handler = () => undefined, opts: { session?: typeof SESSION; objects?: unknown[]; prefs?: Record<string, unknown> } = {}) {
  const prefs: Record<string, unknown> = { ...(team ? { "home.team": team } : {}), ...(opts.prefs ?? {}) };
  return renderRoute("/", (c) => extra(c) ?? (
    c.path === "/v1/me/preferences" ? { body: { data: c.method === "PUT" ? Object.assign(prefs, c.body) : prefs } }
    : c.path === "/v1/aggregate" ? agg()
    : c.path === "/v1/query" ? { body: { data: [], next_cursor: null } }
    : c.path === "/v1/objects/deal" ? { body: { data: DEAL } }
    : c.path === "/v1/objects/lead" ? { body: { data: LEAD } }
    : c.path === "/v1/me/tasks" ? { body: { data: [] } }
    : c.path === "/v1/events" ? { body: { data: [], next_before: null } }
    : c.path === "/v1/views" ? { body: { data: [] } }
    : undefined
  ), { session: opts.session ?? SESSION, objects: opts.objects ?? OBJECTS });
}

describe("Home: which one a member sees", () => {
  it("shows the general Home, with a way to choose a team, when none is chosen", async () => {
    const { calls } = home(null);
    expect(await screen.findByRole("link", { name: "Choose your team to see its numbers here." })).toHaveAttribute("href", "/settings/account");
    expect(await screen.findByRole("heading", { name: "Records" })).toBeInTheDocument();
    expect(aggregates(calls)).toHaveLength(0);
  });

  it("falls back to it when the chosen team isn't available here (support without the ticket object)", async () => {
    const { calls } = home("support", () => undefined, { objects: NO_TICKETS });
    expect(await screen.findByRole("link", { name: "Choose your team to see its numbers here." })).toBeInTheDocument();
    expect(screen.queryByText(/support-desk pack/)).not.toBeInTheDocument();
    expect(aggregates(calls)).toHaveLength(0);
  });

  it("offers a team only when its object is readable or its permission is held", () => {
    const can = (p: string) => p === "audit:read";
    expect(availableTeam("sales", [], can)).toBe("sales");
    expect(availableTeam("finance", [], can)).toBeNull();
    expect(availableTeam("finance", [{ name: "quote", access: { read: false, write: false, archive: false } }], can)).toBeNull();
    expect(availableTeam("finance", [{ name: "quote", access: { read: true, write: false, archive: false } }], can)).toBe("finance");
    expect(availableTeam("admin", [], can)).toBe("admin");
    expect(availableTeam("admin", [], () => false)).toBeNull();
    expect(availableTeam(null, [], can)).toBeNull();
  });

  it("has no IT team", () => {
    expect(TEAMS.map((t) => t.key)).not.toContain("it");
    expect(TEAMS.map((t) => t.label.toLowerCase())).not.toContain("it");
  });
});

describe("Home: Sales", () => {
  it("shows four headline numbers asked for with the member's ID and today's dates, and the member's open deals", async () => {
    const { calls } = home("sales", (c) => {
      if (c.path !== "/v1/aggregate") return undefined;
      const w = whereOf(c);
      if (w.includes('"won"')) return agg([{ group: { currency: "USD" }, count: 3, values: { sum_amount: 9000 }, currency: "USD" }], [{ field: "currency" }]);
      if (w.includes("last_activity_at")) return agg([{ group: {}, count: 4, values: {} }]);
      if (w.includes("expected_close_date")) return agg([{ group: { currency: "USD" }, count: 2, values: { sum_amount: 500 } }], [{ field: "currency" }]);
      return agg([{ group: { currency: "USD" }, count: 5, values: { sum_amount: 12345.5 } }, { group: { currency: "EUR" }, count: 1, values: { sum_amount: 70 } }], [{ field: "currency" }]);
    });
    const pipeline = await screen.findByRole("region", { name: "Open pipeline" });
    expect(await within(pipeline).findByText(/12,345\.50/)).toBeInTheDocument();
    expect(within(pipeline).getByText(/€70\.00/)).toBeInTheDocument(); // one line per currency
    expect(within(pipeline).getByText("6 open deals")).toBeInTheDocument();
    expect(await within(screen.getByRole("region", { name: "Won this quarter" })).findByText("3")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "No activity in 14 days" })).getByText("4")).toBeInTheDocument();

    await waitFor(() => expect(aggregates(calls)).toHaveLength(4));
    const now = new Date();
    const closing = aggregates(calls).find((c) => whereOf(c).includes("expected_close_date"))!;
    expect(whereOf(closing)).toContain(ME);
    expect(whereOf(closing)).toContain(localDate(startOfMonth(now)));
    expect(whereOf(closing)).toContain(localDate(startOfNextMonth(now)));
    for (const c of aggregates(calls)) expect(whereOf(c)).toContain(`"value":"${ME}"`);
    const quiet = aggregates(calls).find((c) => whereOf(c).includes("last_activity_at"))!;
    const cutoff = JSON.parse(whereOf(quiet)).and[1].or[0].value as string;
    expect(Math.abs(Date.now() - 14 * 86_400_000 - new Date(cutoff).getTime())).toBeLessThan(60_000);

    await waitFor(() => expect(queries(calls).length).toBeGreaterThan(0));
    const q = queries(calls)[0]!.body as { object: string; sort: unknown; where: unknown; include: string[]; fields: string[] };
    expect(q.object).toBe("deal");
    expect(q.sort).toEqual([{ field: "last_activity_at", dir: "asc" }]);
    expect(JSON.stringify(q.where)).toContain(ME);
    expect(q.include).toEqual(["account"]); // only readable columns are asked for (the describe above has no stage)
    expect(q.fields).not.toContain("stage");
    expect(screen.getByRole("heading", { name: "Your open deals" })).toBeInTheDocument();
  });

  it("leaves out only the card whose request is refused with 403", async () => {
    home("sales", (c) => (c.path === "/v1/aggregate" && whereOf(c).includes('"won"') ? { status: 403, body: { code: "forbidden", detail: "stage_entered_at is not visible to this key", status: 403 } } : undefined));
    expect(await screen.findByRole("region", { name: "Open pipeline" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Won this quarter" })).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Closing this month" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "No activity in 14 days" })).toBeInTheDocument();
  });

  it("lists deals with their account, amount and last activity, and links each to its record", async () => {
    home("sales", (c) => (c.path === "/v1/query" ? { body: { data: [{ id: "deal_1", object: "deal", display_name: "Renewal Q4", amount: 100, currency: "USD", last_activity_at: null, included: { account: { id: "acct_1", object: "account", display_name: "Harbor Ltd" } } }], next_cursor: null } } : undefined));
    expect(await screen.findByRole("link", { name: "Renewal Q4" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Harbor Ltd" })).toBeInTheDocument();
  });
});

describe("Home: Marketing", () => {
  it("compares this week's new leads with last week's from one request, and asks who has waited over 48 hours", async () => {
    const now = new Date();
    const { calls } = home("marketing", (c) => {
      if (c.path !== "/v1/aggregate") return undefined;
      const w = whereOf(c);
      if (w.includes("created_at") && !w.includes('"new"')) {
        return agg([{ group: { created_at: utcDate(utcWeekStart(now, 1)) }, count: 2, values: {} }, { group: { created_at: utcDate(utcWeekStart(now)) }, count: 5, values: {} }], [{ field: "created_at", bucket: "week" }]);
      }
      if ((c.body as { group_by?: unknown[] }).group_by) return agg([{ group: { status: "new" }, count: 7, values: {} }, { group: { status: "working" }, count: 2, values: {} }], [{ field: "status" }]);
      return agg([{ group: {}, count: 9, values: {} }]);
    });
    expect(await screen.findByText("+3 vs last week (2)")).toBeInTheDocument();
    const status = screen.getByRole("region", { name: "Leads by status" });
    expect(await within(status).findByText("Working")).toBeInTheDocument(); // option label from describe
    await waitFor(() => expect(aggregates(calls)).toHaveLength(4));
    const waiting = aggregates(calls).find((c) => whereOf(c).includes('"new"'))!;
    const cutoff = JSON.parse(whereOf(waiting)).and[1].value as string;
    expect(Math.abs(Date.now() - 48 * 3_600_000 - new Date(cutoff).getTime())).toBeLessThan(60_000);
    expect(screen.getByRole("region", { name: "Converted this month" })).toBeInTheDocument();
  });
});

describe("Home: Customer support", () => {
  it("is labelled as a pack's, asks for three things once each, and lists the member's tickets", async () => {
    const { calls } = home("support", (c) => (c.path === "/v1/query" ? { body: { data: [], next_cursor: null } } : undefined));
    expect(await screen.findByText("Tickets · support-desk pack")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Open tickets" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Open, by priority" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "New today" })).toBeInTheDocument();
    const solved = screen.getByRole("region", { name: "Solved this week" });
    expect(within(solved).getByText("Solved, by last update")).toBeInTheDocument();
    await waitFor(() => expect(aggregates(calls).length).toBeGreaterThanOrEqual(3));
    expect(aggregates(calls)).toHaveLength(3); // "open" and "by priority" are one request
  });
});

describe("Home: Finance and Operations", () => {
  it("finance counts quotes sent and orders, with the member's dates", async () => {
    const { calls } = home("finance");
    expect(await screen.findByRole("region", { name: "Quotes awaiting an answer" })).toBeInTheDocument();
    for (const name of ["Quotes expiring in 7 days", "Orders in progress", "Booked this month"]) expect(screen.getByRole("region", { name: name })).toBeInTheDocument();
    await waitFor(() => expect(aggregates(calls)).toHaveLength(4));
    const booked = aggregates(calls).find((c) => (c.body as { object: string }).object === "order" && whereOf(c).includes("created_at"))!;
    expect(whereOf(booked)).toContain(utcMonthStart(new Date(), 1).toISOString());
    expect(booked.body).toMatchObject({ group_by: [{ field: "created_at", bucket: "month" }, { field: "currency" }] });
  });

  it("operations shows three numbers, the overdue tasks for the member's own ID", async () => {
    const { calls } = home("ops");
    expect(await screen.findByRole("region", { name: "My overdue tasks" })).toBeInTheDocument();
    expect(await screen.findByText("Fulfilled, by last update")).toBeInTheDocument();
    await waitFor(() => expect(aggregates(calls)).toHaveLength(3));
    const overdue = aggregates(calls).find((c) => (c.body as { object: string }).object === "task")!;
    expect(whereOf(overdue)).toContain(`"field":"assignee","op":"eq","value":"${ME}"`);
  });

  it("drops cards whose object the member can't read", async () => {
    const readOnlyOrders = OBJECTS.map((o) => (o.name === "order" ? { ...o, access: { read: false, write: false, archive: false } } : o));
    home("finance", () => undefined, { objects: readOnlyOrders });
    expect(await screen.findByRole("region", { name: "Quotes awaiting an answer" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Orders in progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Booked this month" })).not.toBeInTheDocument();
  });
});

describe("Home: Your agents and Pinned views", () => {
  it("asks for the member's own agent events of the last 7 days and says how each came in", async () => {
    const { calls } = home("sales", (c) => (c.path === "/v1/events" ? { body: { data: [
      { id: "evt_1", type: "deal.updated", occurred_at: new Date().toISOString(), object: "deal", record_id: "deal_1", actor: { type: "user", id: ME, surface: "ops-mcp", via: "Claude" }, data: {} },
      { id: "evt_2", type: "deal.created", occurred_at: new Date().toISOString(), object: "deal", record_id: "deal_2", actor: { type: "user", id: ME, surface: "cli" }, data: {} },
    ], next_before: null } } : undefined));
    const card = await screen.findByRole("region", { name: "Your agents" });
    expect(within(card).getByText("Changes made through your keys and connected apps, last 7 days")).toBeInTheDocument();
    expect(await within(card).findByText(/via Claude/)).toBeInTheDocument();
    expect(within(card).getByText(/^CLI/)).toBeInTheDocument();
    expect(within(card).getAllByRole("link", { name: /Open deal/ })).toHaveLength(2);
    const call = calls.find((c) => c.path === "/v1/events")!;
    expect(call.query.get("actor")).toBe("me");
    expect(call.query.get("surface")).toBe("agents");
    expect(call.query.get("limit")).toBe("20");
    expect(Math.abs(Date.now() - 7 * 86_400_000 - new Date(call.query.get("since")!).getTime())).toBeLessThan(60_000);
  });

  it("says so when there are none, and never calls the section anything about records you own", async () => {
    home("sales");
    expect(await screen.findByText(/No changes through your keys or connected apps/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/records you own/i);
  });

  it("reads pinned views from the preference and writes it back on pin and unpin", async () => {
    const views = [
      { id: "v_1", object: "deal", name: "Big deals", shared: false, owner: ME, mine: true, status: "ok", version: 1 },
      { id: "v_2", object: "lead", name: "Hot leads", shared: false, owner: ME, mine: true, status: "ok", version: 1 },
    ];
    const { calls } = home("sales", (c) => (c.path === "/v1/views" ? { body: { data: views } } : undefined), { prefs: { "home.pinned": ["v_1", "v_gone"] } });
    const link = await screen.findByRole("link", { name: "Big deals" });
    expect(link).toHaveAttribute("href", expect.stringContaining("view=v_1"));
    expect(screen.queryByText("Hot leads")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /pin a view/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Hot leads/ }));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy());
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ "home.pinned": ["v_1", "v_2"] });
    expect(await screen.findByRole("link", { name: "Hot leads" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Unpin Big deals" }));
    await userEvent.click(screen.getByRole("button", { name: "Unpin Hot leads" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3));
    expect(calls.filter((c) => c.method === "PUT")[2]!.body).toEqual({ "home.pinned": null });
  });
});

describe("Home: Admin", () => {
  const AUTOMATIONS = [
    { id: "auto_1", name: "Notify owner", enabled: true, status: "enabled", consecutive_failures: 0, trigger: { type: "event" }, hourly_cap: 10, run_roles: [], version: 1 },
    { id: "auto_2", name: "Sync to billing", enabled: false, status: "paused", paused_reason: "Too many failures", consecutive_failures: 3, trigger: { type: "event" }, hourly_cap: 10, run_roles: [], version: 1 },
  ];
  const admin = (extra: Handler = () => undefined) => home("admin", (c) => extra(c) ?? (
    c.path === "/v1/automations/runs/summary" ? { body: { data: { since: "", totals: { succeeded: 40, failed: 2, skipped: 1, queued: 0, running: 0 }, automations: [
      { id: "auto_1", name: "Notify owner", succeeded: 40, failed: 0, skipped: 1, open: 0, last_failed_at: null, last_failure: null },
      { id: "auto_3", name: "Create invoice", succeeded: 0, failed: 2, skipped: 0, open: 0, last_failed_at: new Date().toISOString(), last_failure: "Target answered HTTP 500" }] } } }
    : c.path === "/v1/events/summary" ? { body: { data: { since: "", sources: [{ actor: ME, surface: "ops-mcp", via: "Claude", changes: 12, records: 7, last_at: new Date().toISOString() }, { actor: "svc_9", surface: "api", via: null, changes: 3, records: 3, last_at: new Date().toISOString() }] } } }
    : c.path === "/v1/automations" ? { body: { data: AUTOMATIONS } }
    : c.path === "/v1/members" ? { body: { data: { users: [{ id: ME, active: true }, { id: "usr_2", active: true }, { id: "usr_3", active: false }], service_accounts: [{ id: "svc_9", active: true }] } } }
    : c.path === "/v1/webhooks" ? { body: { data: [{ id: "wh_1", url: "https://example.com/hook", status: "paused", consecutive_failures: 5, enabled: true, events: [], description: null, created_at: "" }, { id: "wh_2", url: "https://ok.example.com", status: "active", consecutive_failures: 0, enabled: true, events: [], description: null, created_at: "" }] } }
    : c.path === "/v1/api-keys" ? { body: { data: [{ id: "key_1", name: "Reporting key", expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), revoked_at: null }, { id: "key_2", name: "Far key", expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(), revoked_at: null }] } }
    : c.path === "/v1/schema/changes" ? { body: { data: [{ version: 4, changed_at: new Date().toISOString(), change: "field_added", object: "deal", field: "region", surface: "cli", via: null, pack: null, actor: ME }] } }
    : c.path === "/v1/users" ? { body: { data: [{ id: ME, name: "Mia Example", email: "me@example.com" }] } }
    : undefined
  ), { session: ADMIN });

  it("is not shown without audit:read: the general Home appears instead", async () => {
    home("admin");
    expect(await screen.findByRole("link", { name: "Choose your team to see its numbers here." })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Needs attention", level: 2, description: /as of/ })).not.toBeInTheDocument();
  });

  it("renders its cards and sections from the summaries, composing what needs attention now", async () => {
    admin();
    await waitFor(() => expect(screen.getByRole("region", { name: "Members" })).toHaveTextContent(/^Members2.*1 service account/));
    await waitFor(() => expect(screen.getByRole("region", { name: "Automations" })).toHaveTextContent("1 paused, 1 with failures"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Runs in 24h" })).toHaveTextContent("40 / 2"));
    await waitFor(() => expect(screen.getByRole("region", { name: "Changes by agents in 24h" })).toHaveTextContent(/^Changes by agents in 24h15/));

    const attention = await screen.findByRole("region", { name: "Needs attention" });
    expect(within(attention).getByText(/as of /)).toBeInTheDocument();
    expect(attention).not.toHaveTextContent(/checks run every/i);
    await waitFor(() => expect(within(attention).getByText("Create invoice")).toBeInTheDocument());
    expect(within(attention).getByText(/2 failed runs in 24 hours: Target answered HTTP 500/)).toBeInTheDocument();
    expect(within(attention).getByText("Sync to billing")).toBeInTheDocument();
    expect(within(attention).getByText("https://example.com/hook")).toBeInTheDocument();
    expect(within(attention).queryByText("https://ok.example.com")).not.toBeInTheDocument();
    expect(within(attention).getByText("Reporting key")).toBeInTheDocument();
    expect(within(attention).queryByText("Far key")).not.toBeInTheDocument();

    const runs = screen.getByRole("region", { name: "Automation runs · 24h" });
    const items = within(runs).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Create invoice"); // failures first

    const activity = await screen.findByRole("table", { name: "Agent and API activity" });
    expect(within(activity).getByText(/via Claude/)).toBeInTheDocument();
    expect(await within(activity).findByText("Mia Example")).toBeInTheDocument();
    expect(within(activity).getByText("API")).toBeInTheDocument();
    expect(within(activity).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Who", "Source", "Changes", "Records", "Last active"]);
    expect(document.body.textContent).not.toMatch(/\bReads\b|\bDenied\b/);

    const changes = screen.getByRole("region", { name: "Recent schema changes" });
    expect(await within(changes).findByText("Field added")).toBeInTheDocument();
  });

  it("hides a section whose request is refused, and says nothing needs attention when all is well", async () => {
    admin((c) => (c.path === "/v1/automations/runs/summary" || c.path === "/v1/automations" || c.path === "/v1/events/summary"
      ? { status: 403, body: { code: "forbidden", detail: "no", status: 403 } }
      : c.path === "/v1/webhooks" || c.path === "/v1/api-keys" ? { body: { data: [] } } : undefined));
    expect(await screen.findByText("Nothing needs attention.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Automation runs · 24h" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agent and API activity" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Runs in 24h" })).not.toBeInTheDocument();
  });
});

describe("Home: wording", () => {
  it("never calls the alerts 'mentions' and never offers an IT Home", async () => {
    home("sales");
    await screen.findByRole("region", { name: "Alerts" });
    expect(document.body.textContent).not.toMatch(/mention/i);
    expect(screen.queryByText(/^IT$/)).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Today" })).toBeInTheDocument();
  });
});
