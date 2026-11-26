import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Board } from "@/features/board/DealsBoard";
import { BulkDialog } from "@/features/list/BulkDialog";
import { isStale, STALE_AFTER_DAYS } from "@/features/list/stale";
import type { Pipeline } from "@/lib/api/types";
import { field, objectMeta, renderApp, renderRoute, type Call } from "./utils";

const STAGES = [{ key: "idea", label: "Idea" }, { key: "doing", label: "Doing" }];
const owner = field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } });
const PROJECT = objectMeta({ name: "project", label: "Project", plural_label: "Projects", owned: true, fields: [
  field({ name: "title", type: "text" }),
  field({ name: "phase", type: "single_select", values: STAGES }),
  field({ name: "budget", type: "currency" }),
  field({ name: "due", type: "date" }),
  owner,
] });
const OBJECTS = [{ name: "project", label: "Project", plural_label: "Projects", standard: false, access: { read: true, write: true, archive: true }, id_prefix: "pro", owned: true, field_count: 5 }];
const rec = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, object: "project", display_name: title, title, version: 1, ...extra });
const FILTER = { o: "and", c: [["phase", "eq", "idea"], ["due", "not_empty"]] };

function listApi(extra: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
  return (c: Call) => extra(c) ?? (
    c.path === "/v1/objects/project" ? { body: { data: PROJECT } }
      : c.path === "/v1/objects/project/views" ? { body: { data: [] } }
      : c.path === "/v1/query" ? { body: { data: [rec("pro_1", "Website", { budget: 1200 }), rec("pro_2", "Rebrand", { budget: 1800 })], next_cursor: null, total: 2 } }
      : c.path === "/v1/me/preferences" && c.method === "PUT" ? { body: { data: c.body } }
      : undefined);
}
const total = (data: unknown[], extra: Record<string, unknown> = {}) => ({ body: { data, group_by: [], measures: [{ key: "count", op: "count", field: null }, { key: "sum_budget", op: "sum", field: "budget" }], truncated: false, rows_capped: false, ...extra } });

describe("the layout choice in the list header", () => {
  it("is a segmented control that changes only the layout and keeps filter, sort and columns in the address", async () => {
    const path = `/o/project?filter=${encodeURIComponent(JSON.stringify(FILTER))}&sort=-title&cols=title,budget`;
    const { router } = renderRoute(path, listApi((c) => (c.path === "/v1/aggregate" ? total([{ group: {}, count: 2, values: { sum_budget: 3000 }, currency: "USD" }]) : undefined)), { objects: OBJECTS });
    const group = await screen.findByRole("group", { name: "Show as" });
    expect(within(group).getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(group).getByRole("button", { name: "Calendar" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ layout: "calendar", sort: "-title", cols: "title,budget", filter: FILTER }));
    expect(within(screen.getByRole("group", { name: "Show as" })).getByRole("button", { name: "Calendar" })).toHaveAttribute("aria-pressed", "true");
    // Back to the table, with the group-by choice still reachable there.
    await userEvent.click(screen.getByRole("button", { name: "Table" }));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("layout"));
    expect(router.state.location.search).toMatchObject({ sort: "-title", filter: FILTER });
    expect(await screen.findByRole("combobox", { name: "Group by" })).toBeInTheDocument();
  });

  it("links a deals list's Board choice to the deals board page", async () => {
    const DEAL = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", owned: true,
      pipelines: [{ id: "pipe_1", name: "Sales", is_default: true, stages: [{ id: "stg_a", name: "Discovery", category: "open", default_probability: 10 }] }],
      fields: [field({ name: "name", type: "text" }), field({ name: "status", type: "single_select", values: [{ key: "open", label: "Open" }] })] });
    renderRoute("/o/deal", (c) => (c.path === "/v1/objects/deal" ? { body: { data: DEAL } } : c.path === "/v1/objects/deal/views" ? { body: { data: [] } } : c.path === "/v1/query" ? { body: { data: [], next_cursor: null, total: 0 } } : undefined),
      { objects: [{ ...OBJECTS[0], name: "deal", label: "Deal", plural_label: "Deals" }] });
    const board = await screen.findByRole("link", { name: "Board" });
    expect(board.getAttribute("href")).toBe("/board");
  });
});

describe("active filters as chips", () => {
  it("shows each condition and removes only that one from the filter in the address", async () => {
    const { router } = renderRoute(`/o/project?filter=${encodeURIComponent(JSON.stringify(FILTER))}`, listApi(), { objects: OBJECTS });
    const chips = await screen.findByRole("group", { name: "Active filters" });
    expect(within(chips).getByText("Idea")).toBeInTheDocument();
    await userEvent.click(within(chips).getByRole("button", { name: "Remove filter: phase is" }));
    await waitFor(() => expect(router.state.location.search.filter).toEqual({ o: "and", c: [["due", "not_empty"]] }));
    expect(within(screen.getByRole("group", { name: "Active filters" })).queryByText("Idea")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove filter: due is not empty" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Active filters" })).not.toBeInTheDocument());
    expect(router.state.location.search).not.toHaveProperty("filter");
  });

  it("shows nothing when the list has no filter", async () => {
    renderRoute("/o/project", listApi(), { objects: OBJECTS });
    await screen.findByRole("group", { name: "Show as" });
    expect(screen.queryByRole("group", { name: "Active filters" })).not.toBeInTheDocument();
  });
});

describe("totals under a list", () => {
  it("sums a number column over the whole filtered list from the aggregate, in a footer row", async () => {
    const { calls } = renderRoute(`/o/project?cols=title,budget&filter=${encodeURIComponent(JSON.stringify({ o: "and", c: [["phase", "eq", "idea"]] }))}`,
      listApi((c) => (c.path === "/v1/aggregate" ? total([{ group: {}, count: 2, values: { sum_budget: 3000 }, currency: "USD" }]) : undefined)), { objects: OBJECTS });
    const grid = await screen.findByRole("grid");
    expect(await within(grid).findByText(/3,000\.00/)).toBeInTheDocument();
    const agg = calls.find((c) => c.path === "/v1/aggregate")!.body as { object: string; where: unknown; measures: unknown; group_by?: unknown };
    expect(agg).toMatchObject({ object: "project", where: { field: "phase", op: "eq", value: "idea" }, measures: [{ op: "sum", field: "budget" }] });
    expect(agg.group_by).toBeUndefined();
    expect(screen.queryByText(/Totals cover the 100,000/)).not.toBeInTheDocument();
  });

  it("gives one total per currency when they mix, and says when the totals are capped", async () => {
    renderRoute("/o/project?cols=title,budget", listApi((c) => {
      if (c.path !== "/v1/aggregate") return undefined;
      const by = (c.body as { group_by?: unknown[] }).group_by;
      if (!by) return { status: 422, body: { code: "mixed_currencies", detail: "more than one currency" } };
      return total([{ group: { currency: "USD" }, count: 1, values: { sum_budget: 3000 }, currency: "USD" }, { group: { currency: "EUR" }, count: 1, values: { sum_budget: 200 }, currency: "EUR" }], { rows_capped: true });
    }), { objects: OBJECTS });
    const grid = await screen.findByRole("grid");
    expect(await within(grid).findByText(/3,000\.00/)).toBeInTheDocument();
    expect(within(grid).getByText(/€200\.00/)).toBeInTheDocument();
    expect(await screen.findByText(/Totals cover the 100,000 most recently changed records/)).toBeInTheDocument();
  });

  it("leaves the footer out when no number column is shown", async () => {
    const { calls } = renderRoute("/o/project?cols=title", listApi(), { objects: OBJECTS });
    await screen.findByRole("grid");
    expect(calls.some((c) => c.path === "/v1/aggregate")).toBe(false);
  });
});

describe("stale deals", () => {
  it("are those whose last activity is older than 14 days, and never those with no recorded activity", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const day = 86_400_000;
    expect(STALE_AFTER_DAYS).toBe(14);
    expect(isStale(ago(14 * day), now)).toBe(false);
    expect(isStale(ago(14 * day + 60_000), now)).toBe(true);
    expect(isStale(ago(2 * day), now)).toBe(false);
    expect(isStale(null, now)).toBe(false);
    expect(isStale("not a date", now)).toBe(false);
  });

  it("show a pill on the board's cards only when the field exists and the deal is stale", async () => {
    const pipelines: Pipeline[] = [{ id: "pipe_1", name: "Sales", is_default: true, stages: [{ id: "stg_a", name: "Discovery", category: "open", default_probability: 10 }, { id: "stg_b", name: "Proposal", category: "open", default_probability: 50 }] }];
    const base = [field({ name: "name", type: "text" }), field({ name: "amount", type: "currency" }),
      field({ name: "stage", type: "relation", create_only: true, relation: { to: "stage", cardinality: "many_to_one" } }),
      field({ name: "pipeline", type: "relation", create_only: true, relation: { to: "pipeline", cardinality: "many_to_one" } })];
    const withField = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", pipelines, fields: [...base, field({ name: "last_activity_at", type: "datetime", read_only: true, access: "read" })] });
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const fresh = new Date(Date.now() - 86_400_000).toISOString();
    const deals = [{ id: "deal_1", object: "deal", display_name: "Old one", stage: "stg_a", amount: 1, version: 1, last_activity_at: old }, { id: "deal_2", object: "deal", display_name: "Fresh one", stage: "stg_a", amount: 1, version: 1, last_activity_at: fresh },
      { id: "deal_3", object: "deal", display_name: "Silent one", stage: "stg_a", amount: 1, version: 1 }];
    const answer = (c: Call) => (c.path === "/v1/query" ? { body: { data: deals, next_cursor: null } }
      : c.path === "/v1/aggregate" ? { body: { data: [], group_by: [], measures: [], truncated: false, rows_capped: false } } : undefined);
    const first = renderApp(<Board meta={withField} pipelines={pipelines} search={{}} setSearch={() => {}} />, answer);
    const discovery = await screen.findByRole("region", { name: /^Discovery/ });
    await within(discovery).findByRole("link", { name: "Old one" });
    expect(within(within(discovery).getByRole("article", { name: "Old one" })).getByText("Stale")).toBeInTheDocument();
    expect(within(within(discovery).getByRole("article", { name: "Fresh one" })).queryByText("Stale")).not.toBeInTheDocument();
    expect(within(within(discovery).getByRole("article", { name: "Silent one" })).queryByText("Stale")).not.toBeInTheDocument();
    first.unmount();

    const without = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", pipelines, fields: base });
    renderApp(<Board meta={without} pipelines={pipelines} search={{}} setSearch={() => {}} />, answer);
    await screen.findByRole("link", { name: "Old one" });
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });
});

describe("the deals board", () => {
  const pipelines: Pipeline[] = [{ id: "pipe_1", name: "Sales", is_default: true, stages: [{ id: "stg_a", name: "Discovery", category: "open", default_probability: 10 }, { id: "stg_b", name: "Proposal", category: "open", default_probability: 50 }] }];
  const meta = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", pipelines, fields: [field({ name: "name", type: "text" }),
    field({ name: "stage", type: "relation", create_only: true, relation: { to: "stage", cardinality: "many_to_one" } }),
    field({ name: "pipeline", type: "relation", create_only: true, relation: { to: "pipeline", cardinality: "many_to_one" } })] });

  it("adds a deal at the foot of a column with that stage already chosen", async () => {
    const created: Call[] = [];
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, (c) => {
      if (c.path === "/v1/query") return { body: { data: [], next_cursor: null } };
      if (c.path === "/v1/aggregate") return { body: { data: [], group_by: [], measures: [], truncated: false, rows_capped: false } };
      if (c.path === "/v1/objects/deal" && c.method === "GET") return { body: { data: meta } };
      if (c.path === "/v1/objects/deal/records" && c.method === "POST") {
        created.push(c);
        return { status: 201, body: { data: { id: "deal_9", object: "deal", display_name: "New" } } };
      }
      return undefined;
    });
    await userEvent.click(await screen.findByRole("button", { name: "Add deal to Proposal" }));
    await screen.findByRole("dialog", { name: "New deal" });
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Pilot");
    await userEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toMatchObject({ name: "Pilot", pipeline: "pipe_1", stage: "stg_b" });
  });

  it("links back to the deals list from its own layout choice", async () => {
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, (c) => (c.path === "/v1/query" ? { body: { data: [], next_cursor: null } } : { body: { data: [], group_by: [], measures: [], truncated: false, rows_capped: false } }));
    const group = await screen.findByRole("group", { name: "Show as" });
    expect(within(group).getByRole("link", { name: "Table" }).getAttribute("href")).toBe("/o/deal");
    expect(within(group).getByText("Board").closest("[aria-current]")).not.toBeNull();
  });
});

describe("bulk change", () => {
  it("opens on the owner field for the Assign owner shortcut", async () => {
    renderApp(<BulkDialog meta={PROJECT} ids={["pro_1", "pro_2"]} mode="update" initialField="owner" onClose={() => {}} onDone={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Assign owner to 2 selected" });
    expect(within(dialog).getByRole("combobox", { name: "Field" })).toHaveValue("owner");
  });
});
