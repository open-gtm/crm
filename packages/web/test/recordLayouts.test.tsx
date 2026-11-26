import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { boardFields, calendarFields, dayOf, groupFields, monthGrid, monthOf, monthStart, totalFields, whereForKey, whereForMonth, ymd } from "@/features/list/layouts";
import { arrangeFields } from "@/features/record/pageLayout";
import { validateListSearch } from "@/router";
import { field, objectMeta, renderRoute, type Call } from "./utils";

const STAGES = [{ key: "idea", label: "Idea" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }];
const PROJECT = objectMeta({ name: "project", label: "Project", plural_label: "Projects", fields: [
  field({ name: "title", type: "text" }),
  field({ name: "phase", type: "single_select", values: STAGES }),
  field({ name: "budget", type: "currency" }),
  field({ name: "due", type: "date" }),
  field({ name: "kickoff", type: "datetime" }),
  field({ name: "urgent", type: "boolean" }),
  field({ name: "client", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }),
  field({ name: "tags", type: "multi_select", values: [{ key: "a", label: "A" }] }),
  field({ name: "secret_phase", type: "single_select", values: STAGES, access: "none" }),
] });
const OBJECTS = [{ name: "project", label: "Project", plural_label: "Projects", standard: false, access: { read: true, write: true, archive: true }, id_prefix: "pro", owned: false, field_count: 9 }];
const rec = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, object: "project", display_name: title, title, version: 1, ...extra });

describe("layout helpers", () => {
  it("offer each layout only the fields it can use, and never a field the member can't see", () => {
    expect(boardFields(PROJECT).map((f) => f.name)).toEqual(["phase"]);
    expect(calendarFields(PROJECT).map((f) => f.name)).toEqual(["due", "kickoff", "created_at"]);
    expect(groupFields(PROJECT).map((f) => f.name)).toEqual(["phase", "urgent", "client"]);
    expect(totalFields(PROJECT, ["title", "budget", "phase"]).map((f) => f.name)).toEqual(["budget"]);
  });

  it("turn a group or a board column into the filter for its records", () => {
    expect(whereForKey("phase", "doing")).toEqual({ field: "phase", op: "eq", value: "doing" });
    expect(whereForKey("phase", null)).toEqual({ field: "phase", op: "is_null", value: true });
    expect(whereForKey("client", { id: "acct_1", display_name: "Acme" })).toEqual({ field: "client", op: "eq", value: "acct_1" });
    expect(whereForKey("urgent", false)).toEqual({ field: "urgent", op: "eq", value: false });
  });

  it("lay a month out in whole weeks from Monday, and bound it for dates and date-times", () => {
    const grid = monthGrid("2027-02"); // 1 February 2027 is a Monday
    expect(grid).toHaveLength(4);
    expect(ymd(grid[0]![0]!)).toBe("2027-02-01");
    expect(ymd(grid[3]![6]!)).toBe("2027-02-28");
    const march = monthGrid("2026-03"); // starts on a Sunday: six days of February before it
    expect(ymd(march[0]![0]!)).toBe("2026-02-23");
    expect(march.every((w) => w.length === 7)).toBe(true);
    expect(march.flat().filter((d) => d.getMonth() === 2)).toHaveLength(31);
    expect(monthOf(monthStart("2026-12", 1))).toBe("2027-01");
    const due = PROJECT.fields.find((f) => f.name === "due")!;
    const kickoff = PROJECT.fields.find((f) => f.name === "kickoff")!;
    expect(whereForMonth(due, "2027-02")).toEqual({ and: [{ field: "due", op: "gte", value: "2027-02-01" }, { field: "due", op: "lt", value: "2027-03-01" }] });
    const dt = whereForMonth(kickoff, "2027-02") as { and: { value: string }[] };
    expect(new Date(dt.and[0]!.value).getTime()).toBe(new Date(2027, 1, 1).getTime());
    expect(dayOf(due, "2027-02-14")).toBe("2027-02-14");
    expect(dayOf(kickoff, new Date(2027, 1, 14, 23, 30).toISOString())).toBe("2027-02-14");
    expect(dayOf(due, null)).toBeNull();
  });

  it("the list's address takes a layout only in its known forms", () => {
    expect(validateListSearch({ layout: "board", by: "phase", group: "urgent", month: "2027-02" })).toEqual({ layout: "board", by: "phase", group: "urgent", month: "2027-02" });
    expect(validateListSearch({ layout: "pie", by: "Phase; drop", group: "x".repeat(70), month: "2027-13" })).toEqual({});
  });
});

describe("record page sections", () => {
  const fields = [field({ name: "name", type: "text", standard: true }), field({ name: "email", type: "email", standard: true }), field({ name: "tier", type: "text" }), field({ name: "notes", type: "long_text" })];
  it("default to the object's own fields and its custom ones", () => {
    expect(arrangeFields(fields, undefined).map((s) => [s.title, s.fields.map((f) => f.name)])).toEqual([["Details", ["name", "email"]], ["Custom fields", ["tier", "notes"]]]);
    expect(arrangeFields(fields.slice(2), { object: "x", custom: false, sections: [], updated_at: null }).map((s) => s.title)).toEqual(["Details"]);
  });
  it("follow a layout, skip what the member can't see, and never lose a field the layout leaves out", () => {
    const layout = { object: "x", custom: true, updated_at: null, sections: [
      { title: "Plan", fields: ["tier", "hidden_from_me", "name"] }, { title: "Nothing visible", fields: ["hidden_from_me"] }, { title: "Reach", fields: ["email", "tier"] }] };
    expect(arrangeFields(fields, layout).map((s) => [s.title, s.fields.map((f) => f.name)])).toEqual([["Plan", ["tier", "name"]], ["Reach", ["email"]], ["Other fields", ["notes"]]]);
  });
});

function listApi(extra: (c: Call) => { status?: number; body?: unknown } | undefined) {
  return (c: Call) => extra(c) ?? (
    c.path === "/v1/objects/project" ? { body: { data: PROJECT } }
      : c.path === "/v1/objects/project/views" ? { body: { data: [] } }
      : c.path === "/v1/me/preferences" && c.method === "PUT" ? { body: { data: c.body } }
      : undefined);
}

describe("a list as a board", () => {
  it("has a column per value with its count and cards, and moves a card by setting the field", async () => {
    let phaseOfOne = "idea";
    const { calls } = renderRoute("/o/project?layout=board", listApi((c) => {
      if (c.path === "/v1/aggregate") return { body: { data: [{ group: { phase: "idea" }, count: 2, values: {} }, { group: { phase: null }, count: 1, values: {} }], group_by: [{ field: "phase" }], measures: [], truncated: false, rows_capped: false } };
      if (c.path === "/v1/query") {
        const w = JSON.stringify((c.body as { where?: unknown }).where);
        if (w.includes('"idea"')) return { body: { data: [rec("pro_1", "Website", { phase: phaseOfOne, budget: 1200 }), rec("pro_2", "Rebrand", { phase: "idea" })], next_cursor: null } };
        if (w.includes("is_null")) return { body: { data: [rec("pro_3", "Unsorted", { phase: null })], next_cursor: null } };
        return { body: { data: [], next_cursor: null } };
      }
      if (c.method === "PATCH" && c.path === "/v1/objects/project/records/pro_1") {
        phaseOfOne = (c.body as { phase: string }).phase;
        return { body: { data: rec("pro_1", "Website", { phase: phaseOfOne, version: 2 }) } };
      }
      return undefined;
    }), { objects: OBJECTS });
    const board = await screen.findByRole("group", { name: "Projects by phase" });
    const idea = await within(board).findByRole("region", { name: "Idea, 2" });
    expect(within(board).getByRole("region", { name: "Doing, 0" })).toBeInTheDocument();
    expect(within(board).getByRole("region", { name: "No phase, 1" })).toBeInTheDocument();
    expect(await within(idea).findByRole("link", { name: "Website" })).toHaveAttribute("href", "/o/project/pro_1");
    expect(within(idea).getByText(/1,200/)).toBeInTheDocument();
    // The table isn't fetched while the board shows.
    expect(calls.filter((c) => c.path === "/v1/query").every((c) => (c.body as { limit: number }).limit === 30)).toBe(true);
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(within(idea).getByRole("button", { name: "Move Website" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Doing" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!;
    expect(sent.body).toEqual({ phase: "doing" });
    expect(sent.headers["if-match"]).toBe('"v1"');
  });

  it("offers no moves to someone who can't change the field, and no board to an object without a select field", async () => {
    const readOnly = { ...PROJECT, fields: PROJECT.fields.map((f) => (f.name === "phase" ? { ...f, access: "read" as const } : f)) };
    const first = renderRoute("/o/project?layout=board", listApi((c) => {
      if (c.path === "/v1/objects/project") return { body: { data: readOnly } };
      if (c.path === "/v1/aggregate") return { body: { data: [{ group: { phase: "idea" }, count: 1, values: {} }], group_by: [], measures: [], truncated: false, rows_capped: false } };
      if (c.path === "/v1/query") return { body: { data: JSON.stringify((c.body as { where?: unknown }).where).includes('"idea"') ? [rec("pro_1", "Website", { phase: "idea" })] : [], next_cursor: null } };
      return undefined;
    }), { objects: OBJECTS });
    expect(await screen.findByRole("link", { name: "Website" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Website" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Drag Website" })).not.toBeInTheDocument();
    first.unmount();

    const plain = { ...PROJECT, fields: PROJECT.fields.filter((f) => f.type !== "single_select") };
    renderRoute("/o/project?layout=board", listApi((c) => {
      if (c.path === "/v1/objects/project") return { body: { data: plain } };
      if (c.path === "/v1/query") return { body: { data: [rec("pro_1", "Website")], next_cursor: null, total: 1 } };
      return undefined;
    }), { objects: OBJECTS });
    expect(await screen.findByRole("grid")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Calendar" })).toBeInTheDocument();
  });
});

describe("a list as a calendar", () => {
  it("places records on their day, opens a busy day, and moves between months", async () => {
    const { calls, router } = renderRoute("/o/project?layout=calendar&by=due&month=2027-02", listApi((c) => {
      if (c.path === "/v1/query") {
        const w = JSON.stringify((c.body as { where?: unknown }).where);
        if (!w.includes("2027-02-01")) return { body: { data: [], next_cursor: null } };
        return { body: { data: [
          rec("pro_1", "Website", { due: "2027-02-14" }), rec("pro_2", "Rebrand", { due: "2027-02-14" }), rec("pro_3", "Audit", { due: "2027-02-14" }),
          rec("pro_4", "Launch", { due: "2027-02-14" }), rec("pro_5", "Retro", { due: "2027-02-14" }), rec("pro_6", "Kickoff", { due: "2027-02-01" })], next_cursor: null } };
      }
      return undefined;
    }), { objects: OBJECTS });
    const table = await screen.findByRole("table", { name: /Projects in February 2027, by due/ });
    expect(await within(table).findByRole("link", { name: "Kickoff" })).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Launch" })).toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "Retro" })).not.toBeInTheDocument();
    await userEvent.click(within(table).getByRole("button", { name: "1 more" }));
    expect(within(table).getByRole("link", { name: "Retro" })).toBeInTheDocument();
    const q = calls.find((c) => c.path === "/v1/query")!.body as { where: unknown; sort: unknown; limit: number };
    expect(q.where).toEqual({ and: [{ field: "due", op: "gte", value: "2027-02-01" }, { field: "due", op: "lt", value: "2027-03-01" }] });
    expect(q.sort).toEqual([{ field: "due", dir: "asc" }]);

    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ month: "2027-03" }));
    expect(await screen.findByRole("heading", { name: "March 2027" })).toBeInTheDocument();
    // Another date field is one choice away.
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Calendar date" }), "kickoff");
    await waitFor(() => expect(router.state.location.search).toMatchObject({ by: "kickoff" }));
  });
});

describe("a list grouped by a field", () => {
  it("shows each group with its count and totals, and loads a group's records when it is opened", async () => {
    const { calls, router } = renderRoute("/o/project?group=phase&cols=budget,due", listApi((c) => {
      if (c.path === "/v1/aggregate") return { body: { data: [
        { group: { phase: "idea" }, count: 2, values: { sum_budget: 3000 }, currency: "USD" }, { group: { phase: null }, count: 1, values: { sum_budget: null } }],
        group_by: [{ field: "phase" }], measures: [{ key: "sum_budget", op: "sum", field: "budget" }], truncated: false, rows_capped: false } };
      if (c.path === "/v1/query") return { body: { data: [rec("pro_1", "Website", { budget: 1200, due: "2027-02-14" }), rec("pro_2", "Rebrand", { budget: 1800 })], next_cursor: null } };
      return undefined;
    }), { objects: OBJECTS });
    const idea = await screen.findByRole("button", { name: /Idea.*2 projects.*3,000/ });
    expect(screen.getByRole("button", { name: /No phase.*1 project/ })).toBeInTheDocument();
    expect(idea).toHaveAttribute("aria-expanded", "false");
    // Nothing but the groups is fetched until one is opened.
    expect(calls.some((c) => c.path === "/v1/query")).toBe(false);
    expect((calls.find((c) => c.path === "/v1/aggregate")!.body as { measures: unknown }).measures).toEqual([{ op: "sum", field: "budget" }]);
    await userEvent.click(idea);
    const table = await screen.findByRole("table", { name: "Projects: Idea" });
    expect(within(table).getByRole("link", { name: "Website" })).toBeInTheDocument();
    expect((calls.find((c) => c.path === "/v1/query")!.body as { where: unknown }).where).toEqual({ field: "phase", op: "eq", value: "idea" });

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Group by" }), "");
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("group"));
    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });
});
