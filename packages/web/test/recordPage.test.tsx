import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { eventWords, agentEvents } from "@/features/record/AgentChanges";
import { columnClasses, byDue, isOpenTask, relatedPlacedElsewhere } from "@/features/record/PageBody";
import { arrangePage, headerFactFields, type LayoutComponent, type LayoutDoc, type PageLayout } from "@/features/record/pageLayout";
import type { Pipeline, RecordData } from "@/lib/api/types";
import { field, objectMeta, renderRoute, SESSION, type Call } from "./utils";

const ID = `deal_${"A".repeat(26)}`;
const NOW = Date.now();
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const PIPELINES: Pipeline[] = [{ id: "pipe_1", name: "Sales", is_default: true, stages: [
  { id: "st_1", name: "Qualify", category: "open", default_probability: 10 },
  { id: "st_2", name: "Propose", category: "open", default_probability: 40 },
  { id: "st_3", name: "Closed won", category: "won", default_probability: 100 },
  { id: "st_4", name: "Closed lost", category: "lost", default_probability: 0 },
] }];
const PHASES = [{ key: "idea", label: "Idea" }, { key: "doing", label: "Doing" }, { key: "done", label: "Done" }];
const dealFields = () => [
  field({ name: "name", type: "text", standard: true, label: "Name" }),
  field({ name: "amount", type: "currency", standard: true, label: "Amount" }),
  field({ name: "stage", type: "relation", relation: { to: "stage", cardinality: "many_to_one" }, standard: true, label: "Stage" }),
  field({ name: "pipeline", type: "relation", relation: { to: "pipeline", cardinality: "many_to_one" }, standard: true, label: "Pipeline", access: "read" }),
  field({ name: "stage_entered_at", type: "datetime", read_only: true, standard: true, label: "Stage entered at", access: "read" }),
  field({ name: "lost_reason", type: "text", standard: true, label: "Lost reason" }),
  field({ name: "tier", type: "text", label: "Tier" }),
  field({ name: "region", type: "text", label: "Region" }),
  field({ name: "secret", type: "text", label: "Secret", access: "none" }),
  field({ name: "phase", type: "single_select", values: PHASES, label: "Phase", transitions: { idea: ["doing"], doing: ["done"], done: [] } } as never),
];
const DEAL = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", standard: true, pipelines: PIPELINES, fields: dealFields(), id_prefix: "deal" });
const QUOTE = objectMeta({ name: "quote", label: "Quote", plural_label: "Quotes", standard: true, fields: [
  field({ name: "number", type: "text", label: "Number" }), field({ name: "deal", type: "relation", relation: { to: "deal", cardinality: "many_to_one" }, label: "Deal" })] });
const TASK = objectMeta({ name: "task", label: "Task", plural_label: "Tasks", standard: true, fields: [
  field({ name: "title", type: "text" }),
  field({ name: "status", type: "status", values: [{ key: "open", label: "Open", category: "open" }, { key: "done", label: "Done", category: "done" }, { key: "cancelled", label: "Cancelled", category: "cancelled" }] }),
  field({ name: "due_at", type: "datetime", label: "Due" })] });
const access = { read: true, write: true, archive: true };
const summary = (name: string, label: string, extra = {}) => ({ name, label, plural_label: `${label}s`, standard: true, access, id_prefix: name.slice(0, 4), owned: false, field_count: 3, ...extra });
const OBJECTS = [summary("deal", "Deal"), summary("quote", "Quote"), summary("task", "Task")];

const comp = {
  fields: (id: string, name: string, fields: string[], extra: Partial<Extract<LayoutComponent, { type: "fields" }>> = {}): LayoutComponent => ({ id, type: "fields", name, columns: 1, collapsed: false, fields, ...extra }),
  simple: (type: "timeline" | "notes" | "files" | "related_lists"): LayoutComponent => ({ id: type, type }),
};
const docOf = (p: Partial<LayoutDoc> & { left?: LayoutComponent[]; main?: LayoutComponent[]; right?: LayoutComponent[] } = {}): LayoutDoc => ({
  header: p.header ?? { key_facts: null }, top: p.top ?? [], columns: { left: p.left ?? [], main: p.main ?? [], right: p.right ?? [] },
});
const page = (doc: LayoutDoc | undefined, custom = true): PageLayout => ({ object: "deal", custom, version: 1, ...(doc ? { layout: doc } : {}), sections: [], updated_at: null });

interface World { layout?: PageLayout; record?: Record<string, unknown>; events?: unknown[] | { status: number }; timeline?: unknown[]; related?: (c: Call) => unknown }
function world(w: World = {}) {
  let rec: RecordData = { id: ID, object: "deal", display_name: "Big deal", name: "Big deal", amount: 5000, stage: "st_2", pipeline: "pipe_1", stage_entered_at: ago(3), tier: "gold", region: "EU", phase: "idea", version: 3,
    created_at: ago(30), updated_at: ago(1), ...w.record } as RecordData;
  return (c: Call) => {
    if (c.method === "GET" && c.path === "/v1/objects/deal") return { body: { data: DEAL } };
    if (c.method === "GET" && c.path === "/v1/objects/quote") return { body: { data: QUOTE } };
    if (c.method === "GET" && c.path === "/v1/objects/task") return { body: { data: TASK } };
    if (c.path === "/v1/objects/deal/layout") return { body: { data: w.layout ?? page(undefined, false) } };
    if (c.method === "GET" && c.path === `/v1/objects/deal/records/${ID}`) return { body: { data: rec } };
    if (c.method === "PATCH" && c.path === `/v1/objects/deal/records/${ID}`) {
      rec = { ...rec, ...(c.body as object), version: 4 } as RecordData;
      return { body: { data: rec } };
    }
    if (c.path === `/v1/records/${ID}/timeline`) return { body: { data: { record: rec, items: w.timeline ?? [] } } };
    if (c.path === `/v1/records/${ID}/files`) return { body: { data: [] } };
    if (c.path === "/v1/files/limits") return { body: { data: { max_bytes: 1, quota_bytes: 1, max_files_per_record: 1 } } };
    if (c.path === "/v1/users") return { body: { data: [{ id: "usr_ANA", name: "Ana Agent", email: "ana@example.com" }] } };
    if (c.path === "/v1/events") return Array.isArray(w.events) || w.events === undefined ? { body: { data: w.events ?? [], next_before: null } } : { status: w.events.status, body: { code: "forbidden", detail: "No", status: w.events.status } };
    if (c.path === "/v1/query" && w.related) return { body: w.related(c) };
    if (c.path === "/v1/query") return { body: { data: [], next_cursor: null, total: 0 } };
    return undefined;
  };
}
const MANAGER = { ...SESSION, permissions: [...SESSION.permissions, "schema:manage"] };
const DEFAULT_DOC = docOf({ top: [{ id: "stage_path", type: "stage_path", field: null }],
  left: [comp.fields("details", "Details", ["name", "amount", "stage", "pipeline", "stage_entered_at", "lost_reason"]), comp.fields("custom_fields", "Custom fields", ["tier", "region", "phase", "secret"])],
  main: [comp.simple("timeline"), comp.simple("notes"), comp.simple("files")], right: [comp.simple("related_lists"), { id: "tasks", type: "tasks", rows: 5 }] });

const names = (items: { kind: string; fields: { name: string }[] }[]) => items.map((i) => [i.kind, i.fields.map((f) => f.name)]);

describe("arrangePage", () => {
  const fields = dealFields().filter((f) => f.access !== "none");
  it("puts placed fields in their sections, in the layout's order, and never a field the member can't see", () => {
    const doc = docOf({ left: [comp.fields("a", "Plan", ["tier", "secret", "name"]), comp.fields("b", "Nothing visible", ["secret"])], main: [comp.fields("c", "Reach", ["region"])] });
    const a = arrangePage(fields, doc);
    expect(a.left.map((i) => (i.kind === "component" ? [i.component.id, i.fields.map((f) => f.name)] : i.kind))).toEqual([["a", ["tier", "name"]], "other"]);
    expect(a.main.map((i) => (i.kind === "component" ? i.fields.map((f) => f.name) : null))).toEqual([["region"]]);
  });

  it("leaves a section out when none of its fields can be shown", () => {
    const a = arrangePage(fields, docOf({ left: [comp.fields("x", "Empty", []), comp.fields("y", "Hidden", ["secret"]), comp.fields("z", "Real", ["name"])] }));
    expect(a.left.filter((i) => i.kind === "component").map((i) => i.kind === "component" && i.component.id)).toEqual(["z"]);
  });

  it("collects what the layout places nowhere as Other fields, after the last fields section of the left column", () => {
    const doc = docOf({ left: [comp.fields("a", "One", ["name"]), comp.fields("b", "Two", ["amount"]), { id: "tl", type: "timeline" }] });
    const a = arrangePage(fields, doc);
    expect(a.left.map((i) => (i.kind === "component" ? i.component.id : "other"))).toEqual(["a", "b", "other", "tl"]);
    const other = a.left.find((i) => i.kind === "other")!;
    expect(other.fields.map((f) => f.name)).toEqual(["stage", "pipeline", "stage_entered_at", "lost_reason", "tier", "region", "phase"]);
  });

  it("puts Other fields at the end of the left column when it has no fields section, wherever else sections are", () => {
    const a = arrangePage(fields, docOf({ left: [{ id: "tl", type: "timeline" }], main: [comp.fields("m", "Main", ["name"])] }));
    expect(a.left.map((i) => (i.kind === "component" ? i.component.id : "other"))).toEqual(["tl", "other"]);
    const none = arrangePage(fields, docOf());
    expect(names(none.left)).toEqual([["other", fields.map((f) => f.name)]]);
  });

  it("shows no Other fields when everything is placed, and leaves out fields the caller took for the header", () => {
    const shown = fields.filter((f) => f.name !== "amount");
    const a = arrangePage(shown, docOf({ left: [comp.fields("a", "All", fields.map((f) => f.name))] }));
    expect(a.left).toHaveLength(1);
    expect(a.left[0]).toMatchObject({ kind: "component", fields: expect.not.arrayContaining([expect.objectContaining({ name: "amount" })]) });
    const unplacedKeyFact = arrangePage(shown, docOf({ left: [comp.fields("a", "Some", ["name"])] }));
    expect(unplacedKeyFact.left.find((i) => i.kind === "other")!.fields.map((f) => f.name)).not.toContain("amount");
  });

  it("keeps a field that two sections name in the first one", () => {
    const a = arrangePage(fields, docOf({ left: [comp.fields("a", "A", ["name"]), comp.fields("b", "B", ["name", "tier"])] }));
    expect(names(a.left.slice(0, 2) as never)).toEqual([["component", ["name"]], ["component", ["tier"]]]);
  });
});

describe("header key facts", () => {
  const rec = { id: ID, name: "Big deal", amount: 10, tier: "gold", region: "", stage: "st_1" } as unknown as RecordData;
  it("are the layout's own list: in its order, only fields the member can see and that have a value", () => {
    const f = headerFactFields(DEAL, rec, docOf({ header: { key_facts: ["tier", "secret", "region", "amount", "tier"] } }));
    expect(f.map((x) => x.name)).toEqual(["tier", "amount"]);
  });
  it("are picked automatically when the layout leaves them to the page", () => {
    expect(headerFactFields(DEAL, rec, docOf()).map((x) => x.name)).toContain("amount");
    expect(headerFactFields(DEAL, rec, undefined).map((x) => x.name)).toContain("amount");
    expect(headerFactFields(DEAL, rec, docOf({ header: { key_facts: [] } }))).toEqual([]);
  });
});

describe("page helpers", () => {
  it("sizes the columns by which ones have something in them", () => {
    expect(columnClasses({ left: true, main: true, right: true }).grid).toContain("min-[1360px]:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(16rem,22rem)]");
    expect(columnClasses({ left: true, main: true, right: false }).grid).toContain("min-[1360px]:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]");
    expect(columnClasses({ left: true, main: false, right: false }).grid).toBe("");
    expect(columnClasses({ left: true, main: true, right: true }).right).toContain("md:row-start-2");
    expect(columnClasses({ left: false, main: true, right: true }).right).toContain("md:row-start-1");
  });
  it("leaves out of the related-list group what the layout draws on its own", () => {
    const ex = relatedPlacedElsewhere(docOf({ right: [{ id: "r", type: "related", object: "quote", field: "deal", rows: 3 }, { id: "q", type: "quotes", rows: 3 }] }));
    expect([...ex.lists!]).toEqual(["quote.deal"]);
    expect([...ex.objects!]).toEqual(["quote"]);
    expect(relatedPlacedElsewhere(docOf()).objects).toBeUndefined();
  });
  it("counts a task as open until it is done or cancelled, and orders by due date", () => {
    const status = TASK.fields.find((f) => f.name === "status");
    expect(isOpenTask({ id: "t", status: "open" } as unknown as RecordData, status)).toBe(true);
    expect(isOpenTask({ id: "t", status: "done" } as unknown as RecordData, status)).toBe(false);
    expect(isOpenTask({ id: "t", status: "cancelled" } as unknown as RecordData, status)).toBe(false);
    expect(isOpenTask({ id: "t" } as unknown as RecordData, undefined)).toBe(true);
    const sorted = [{ id: "n" }, { id: "late", due_at: "2027-02-01T00:00:00Z" }, { id: "soon", due_at: "2027-01-01T00:00:00Z" }] as RecordData[];
    expect(sorted.sort(byDue).map((t) => t.id)).toEqual(["soon", "late", "n"]);
  });
  it("tells agent events from everything else, within the window, and puts an event in words", () => {
    const ev = (surface: string, at: string, type = "deal.updated") => ({ id: surface + at, type, occurred_at: at, actor: { type: "service_account", id: "svc_1", surface }, data: {} });
    const all = [ev("web", ago(1)), ev("api", ago(1)), ev("cli", ago(2)), ev("admin-mcp", ago(3)), ev("ops-mcp", ago(3)), ev("automation", ago(1)), ev("system", ago(1)), ev("api", ago(40))];
    expect(agentEvents(all, 30, NOW).map((e) => e.actor.surface)).toEqual(["api", "cli", "admin-mcp", "ops-mcp"]);
    expect(eventWords({ type: "deal.updated", data: {} }, DEAL)).toBe("Changed");
    expect(eventWords({ type: "deal.created", data: {} }, DEAL)).toBe("Created this deal");
    expect(eventWords({ type: "deal.stage_changed", data: { to_stage: "Closed won" } }, DEAL)).toBe("Moved to Closed won");
    expect(eventWords({ type: "quote.accepted", data: {} }, QUOTE)).toBe("Accepted");
  });
});

describe("a record page drawn from its layout", () => {
  it("draws a custom layout's top and three columns in order, with Other fields and the record's details last on the left", async () => {
    const doc = docOf({
      top: [{ id: "path", type: "stage_path", field: null }],
      left: [comp.fields("plan", "Plan", ["name", "tier", "secret"], { columns: 2 })],
      main: [comp.simple("timeline")],
      right: [{ id: "tasks", type: "tasks", rows: 5 }],
    });
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc) }), { objects: OBJECTS });
    const plan = await screen.findByRole("region", { name: "Plan" });
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    const tasks = await screen.findByRole("region", { name: "Open tasks" });
    const other = screen.getByRole("region", { name: "Other fields" });
    const info = screen.getByRole("region", { name: "Record information" });
    const path = screen.getByRole("group", { name: "Stage" });
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(path, plan) && before(plan, other) && before(other, info) && before(info, timeline) && before(timeline, tasks)).toBe(true);
    // Left column: the Plan section, the unplaced fields, the record's details, in one column; the other two are separate.
    expect(plan.parentElement).toBe(other.parentElement);
    expect(other.parentElement).toBe(info.parentElement);
    expect(timeline.parentElement).not.toBe(plan.parentElement);
    expect(tasks.parentElement).not.toBe(timeline.parentElement);
    // The hidden field is nowhere; the placed ones are in Plan and not repeated in Other fields.
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
    expect(within(plan).getByText("Tier")).toBeInTheDocument();
    expect(within(other).queryByText("Tier")).not.toBeInTheDocument();
    expect(within(other).getByText("Region")).toBeInTheDocument();
  });

  it("starts a section collapsed when the layout says so, and opens it with its button", async () => {
    const doc = docOf({ left: [comp.fields("plan", "Plan", ["tier"], { collapsed: true }), comp.fields("more", "More", ["region", "phase", "name", "lost_reason"])], main: [comp.simple("timeline")] });
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc) }), { objects: OBJECTS });
    const plan = await screen.findByRole("region", { name: "Plan" });
    const toggle = within(plan).getByRole("button", { name: "Plan" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(plan).queryByText("Tier")).not.toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(plan).getByText("Tier")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "More" })).getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "true");
  });

  it("draws the default layout the server describes", async () => {
    renderRoute(`/o/deal/${ID}`, world({ layout: page(DEFAULT_DOC, false), timeline: [{ kind: "task", at: ago(1), item: { id: "task_1", object: "task", display_name: "Send contract", status: "open", due_at: ago(-2), version: 1 } }] }), { objects: OBJECTS });
    expect(await screen.findByRole("region", { name: "Details" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Custom fields" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Timeline" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Files" })).toBeInTheDocument();
    const tasks = await screen.findByRole("region", { name: "Open tasks" });
    expect(await within(tasks).findByRole("link", { name: "Send contract" })).toBeInTheDocument();
    // The stage path is on the page, so the header has no stage select; and a member who can't manage the schema gets no Customize button.
    expect(screen.queryByRole("combobox", { name: "Stage" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Propose" })).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("link", { name: /Customize page/ })).not.toBeInTheDocument();
    // The amount and other key facts are in the header, not repeated in a section.
    expect(within(screen.getByRole("region", { name: "Details" })).queryByText("Amount")).not.toBeInTheDocument();
  });

  it("falls back to the page as it was when the server sends no layout", async () => {
    const legacy: PageLayout = { object: "deal", custom: true, sections: [{ title: "Plan", fields: ["tier"] }], updated_at: null };
    renderRoute(`/o/deal/${ID}`, world({ layout: legacy }), { objects: OBJECTS });
    expect(await screen.findByRole("region", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Other fields" })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Timeline" })).toBeInTheDocument();
    // With no layout, the header keeps its stage select.
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeInTheDocument();
  });

  it("shows the Customize button only to someone who can manage the schema, linking to the editor for this record", async () => {
    const first = renderRoute(`/o/deal/${ID}`, world({ layout: page(DEFAULT_DOC, false) }), { objects: OBJECTS, session: MANAGER });
    const link = await screen.findByRole("link", { name: /Customize page/ });
    expect(link).toHaveAttribute("href", `/o/deal/customize?record=${ID}`);
    first.unmount();
    renderRoute(`/o/deal/${ID}`, world({ layout: page(DEFAULT_DOC, false) }), { objects: OBJECTS });
    await screen.findByRole("region", { name: "Details" });
    expect(screen.queryByRole("link", { name: /Customize page/ })).not.toBeInTheDocument();
  });

  it("shows exactly the layout's key facts in the header, and the stage as a fact only without a stage select", async () => {
    const doc = docOf({ header: { key_facts: ["tier", "amount"] }, left: [comp.fields("d", "Details", ["name", "tier", "amount", "region"])] });
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc) }), { objects: OBJECTS });
    const details = await screen.findByRole("region", { name: "Details" });
    const heading = screen.getByRole("heading", { level: 1 });
    const header = heading.closest("div.border-b")!;
    expect(within(header as HTMLElement).getByText("Tier")).toBeInTheDocument();
    expect(within(header as HTMLElement).getByText("Amount")).toBeInTheDocument();
    expect(within(header as HTMLElement).queryByText("Region")).not.toBeInTheDocument();
    // Shown in the header, so not repeated in the section; the others stay.
    expect(within(details).queryByText("Tier")).not.toBeInTheDocument();
    expect(within(details).getByText("Region")).toBeInTheDocument();
  });
});

describe("a related component", () => {
  it("lists only its rows, asks for that many, and links to see all of them", async () => {
    const rows = [{ id: "quot_1", object: "quote", display_name: "Q-1", number: "Q-1" }, { id: "quot_2", object: "quote", display_name: "Q-2", number: "Q-2" }];
    const doc = docOf({ left: [comp.fields("d", "Details", ["name"])], right: [{ id: "rel", type: "related", object: "quote", field: "deal", rows: 2 }, comp.simple("related_lists")] });
    const { calls } = renderRoute(`/o/deal/${ID}`, world({ layout: page(doc), related: (c) => ((c.body as { object: string }).object === "quote" ? { data: rows, next_cursor: null, total: 5 } : { data: [], total: 0 }) }), { objects: OBJECTS });
    const lists = await screen.findAllByRole("region", { name: "Quotes" });
    // Placed on its own, so the group of every related list doesn't repeat it.
    expect(lists).toHaveLength(1);
    expect(await within(lists[0]!).findByRole("link", { name: "Q-1" })).toBeInTheDocument();
    expect(within(lists[0]!).getAllByRole("listitem")).toHaveLength(2);
    expect(within(lists[0]!).getByRole("link", { name: "View all 5" })).toBeInTheDocument();
    const q = calls.find((c) => c.path === "/v1/query" && (c.body as { object: string }).object === "quote")!;
    expect((q.body as { limit: number; where: unknown }).limit).toBe(2);
    expect((q.body as { where: unknown }).where).toEqual({ field: "deal", op: "eq", value: ID });
  });

  it("draws nothing when the member can't read that object", async () => {
    const doc = docOf({ left: [comp.fields("d", "Details", ["name"])], right: [{ id: "rel", type: "related", object: "quote", field: "deal", rows: 2 }, { id: "q", type: "quotes", rows: 3 }] });
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc) }), { objects: OBJECTS.filter((o) => o.name !== "quote") });
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(screen.getByRole("region", { name: "Record information" })).toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Quotes" })).not.toBeInTheDocument();
  });
});

describe("a tasks component", () => {
  it("lists open tasks, soonest due first, up to its rows", async () => {
    const task = (id: string, title: string, status: string, due: string | null) => ({ kind: "task", at: ago(1), item: { id, object: "task", display_name: title, status, due_at: due, version: 1 } });
    const doc = docOf({ left: [comp.fields("d", "Details", ["name"])], main: [{ id: "tasks", type: "tasks", rows: 2 }] });
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc), timeline: [task("task_1", "Later", "open", ago(-9)), task("task_2", "Done one", "done", ago(-1)), task("task_3", "Soonest", "open", ago(-1)), task("task_4", "No date", "open", null), task("task_5", "Soon too", "open", ago(-3))] }), { objects: OBJECTS });
    const region = await screen.findByRole("region", { name: "Open tasks" });
    await within(region).findByRole("link", { name: "Soonest" });
    expect(within(region).getAllByRole("link").map((l) => l.textContent)).toEqual(["Soonest", "Soon too"]);
    expect(within(region).queryByRole("link", { name: "Done one" })).not.toBeInTheDocument();
    expect(within(region).getByText(/2 more open tasks/)).toBeInTheDocument();
  });
});

describe("an agent_changes component", () => {
  const ev = (id: string, surface: string, at: string, data: Record<string, unknown> = {}, type = "deal.updated", actorId: string | null = "usr_ANA") =>
    ({ id, type, occurred_at: at, object: "deal", record_id: ID, actor: { type: "user", id: actorId, surface }, data });
  const doc = docOf({ left: [comp.fields("d", "Details", ["name"])], right: [{ id: "agents", type: "agent_changes", days: 30 }] });

  it("shows changes made through the API, CLI and MCP in the window, not the web, automations or older ones", async () => {
    const events = [
      ev("e1", "web", ago(1), { before: { tier: "a" }, after: { tier: "b" } }),
      ev("e2", "api", ago(1), { before: { amount: 100, secret: "x", tier: "gold" }, after: { amount: 250, secret: "y", tier: "gold" } }),
      ev("e3", "cli", ago(2), { after: { name: "Big deal" } }, "deal.created", "svc_KEY"),
      ev("e4", "admin-mcp", ago(3), {}, "deal.archived"),
      ev("e5", "automation", ago(1)),
      ev("e6", "api", ago(45), { before: { tier: "a" }, after: { tier: "z" } }),
    ];
    const { calls } = renderRoute(`/o/deal/${ID}`, world({ layout: page(doc), events }), { objects: OBJECTS });
    const region = await screen.findByRole("region", { name: "Changes by agents" });
    const items = await within(region).findAllByRole("listitem");
    const top = items.filter((li) => li.parentElement === region.querySelector("ul"));
    expect(top).toHaveLength(3);
    expect(within(top[0]!).getByText("API")).toBeInTheDocument();
    expect(within(top[1]!).getByText("CLI")).toBeInTheDocument();
    expect(within(top[2]!).getByText("MCP")).toBeInTheDocument();
    expect(within(top[0]!).getByText("Changed")).toBeInTheDocument();
    expect(within(top[0]!).getByText(/Ana Agent/)).toBeInTheDocument();
    // The changed field with before and after; the field the member can't read is never named, and an unchanged one isn't listed.
    expect(within(top[0]!).getByText("Amount")).toBeInTheDocument();
    expect(within(top[0]!).getByText(/100/)).toBeInTheDocument();
    expect(within(top[0]!).getByText(/250/)).toBeInTheDocument();
    expect(within(top[0]!).queryByText("Secret")).not.toBeInTheDocument();
    expect(within(top[0]!).queryByText("Tier")).not.toBeInTheDocument();
    // A key with no directory entry shows its id, and no client is ever named.
    expect(within(top[1]!).getByText(/svc_KEY/)).toBeInTheDocument();
    expect(within(top[1]!).getByText("Created this deal")).toBeInTheDocument();
    const asked = calls.find((c) => c.path === "/v1/events")!;
    expect(asked.query.get("record")).toBe(ID);
  });

  it("says so when agents changed nothing", async () => {
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc), events: [ev("e1", "web", ago(1))] }), { objects: OBJECTS });
    expect(await screen.findByText("No changes by agents in the last 30 days.")).toBeInTheDocument();
  });

  it("is not drawn when the member's role can't read events", async () => {
    renderRoute(`/o/deal/${ID}`, world({ layout: page(doc), events: { status: 403 } }), { objects: OBJECTS });
    await screen.findByRole("region", { name: "Details" });
    await waitFor(() => expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Changes by agents" })).not.toBeInTheDocument();
  });
});

describe("a stage_path component", () => {
  const top = docOf({ top: [{ id: "path", type: "stage_path", field: null }], left: [comp.fields("d", "Details", ["name"])] });

  it("shows a deal's pipeline as steps with the current one marked, and how long it has been there", async () => {
    renderRoute(`/o/deal/${ID}`, world({ layout: page(top) }), { objects: OBJECTS });
    const group = await screen.findByRole("group", { name: "Stage" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Qualify", "Propose", "Closed won", "Closed lost"]);
    expect(within(group).getByRole("button", { name: "Propose" })).toHaveAttribute("aria-current", "step");
    expect(await screen.findByText("In this stage for 3 days")).toBeInTheDocument();
  });

  it("moves the deal with the move_deal_stage operation, and asks why before marking it lost", async () => {
    const w = world({ layout: page(top) });
    const { calls } = renderRoute(`/o/deal/${ID}`, (c) => (c.method === "POST" && c.path === "/v1/ops/move_deal_stage" ? { body: { dry_run: false, result: null } } : w(c)), { objects: OBJECTS });
    const group = await screen.findByRole("group", { name: "Stage" });
    await userEvent.click(within(group).getByRole("button", { name: "Closed won" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/ops/move_deal_stage")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/ops/move_deal_stage")!.body).toEqual({ deal: ID, stage: "st_3" });
    // The current stage is not a move.
    await userEvent.click(within(group).getByRole("button", { name: "Propose" }));
    expect(calls.filter((c) => c.path === "/v1/ops/move_deal_stage")).toHaveLength(1);

    await userEvent.click(within(group).getByRole("button", { name: "Closed lost" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as lost" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Why was it lost/ }), "Too pricey");
    await userEvent.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/ops/move_deal_stage")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/v1/ops/move_deal_stage")[1]!.body).toEqual({ deal: ID, stage: "st_4", lost_reason: "Too pricey" });
  });

  it("is read-only for someone who can't change the stage, and for an archived deal", async () => {
    const first = renderRoute(`/o/deal/${ID}`, (c) => (c.path === "/v1/objects/deal" ? { body: { data: { ...DEAL, fields: DEAL.fields.map((f) => (f.name === "stage" ? { ...f, access: "read" } : f)) } } } : world({ layout: page(top) })(c)), { objects: OBJECTS });
    const group = await screen.findByRole("group", { name: "Stage" });
    for (const b of within(group).getAllByRole("button")) expect(b).toBeDisabled();
    first.unmount();
    renderRoute(`/o/deal/${ID}`, world({ layout: page(top), record: { archived_at: ago(1) } }), { objects: OBJECTS });
    const archived = await screen.findByRole("group", { name: "Stage" });
    for (const b of within(archived).getAllByRole("button")) expect(b).toBeDisabled();
  });

  it("moves any other record along a status field, offering only the moves its transitions allow, with the usual write", async () => {
    const doc = docOf({ top: [{ id: "path", type: "stage_path", field: "phase" }], left: [comp.fields("d", "Details", ["name"])] });
    const { calls } = renderRoute(`/o/deal/${ID}`, world({ layout: page(doc) }), { objects: OBJECTS });
    const group = await screen.findByRole("group", { name: "Phase" });
    expect(within(group).getByRole("button", { name: "Idea" })).toHaveAttribute("aria-current", "step");
    expect(within(group).getByRole("button", { name: "Doing" })).toBeEnabled();
    expect(within(group).getByRole("button", { name: "Done" })).toBeDisabled();
    await userEvent.click(within(group).getByRole("button", { name: "Doing" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!;
    expect(sent.body).toEqual({ phase: "doing" });
    expect(sent.headers["if-match"]).toBe('"v3"');
  });
});

describe("the default page of an object with only custom fields to show", () => {
  it("calls its one section Details, as before layouts", async () => {
    const { arrangePage } = await import("@/features/record/pageLayout");
    const f = (name: string, standard: boolean) => ({ name, label: name, type: "text", standard }) as never;
    const doc = { header: { key_facts: null }, top: [], columns: {
      left: [{ id: "details", type: "fields" as const, name: "Details", columns: 1 as const, collapsed: false, fields: ["name"] },
        { id: "custom_fields", type: "fields" as const, name: "Custom fields", columns: 1 as const, collapsed: false, fields: ["hq"] }], main: [], right: [] } };
    const titles = (fields: never[], defaultPage: boolean) => arrangePage(fields, doc, { defaultPage }).left.map((x) => (x.kind === "component" && x.component.type === "fields" ? x.component.name : "other"));
    // The name is in the header, so only the custom field is left to show.
    expect(titles([f("hq", false)], true)).toEqual(["Details"]);
    expect(titles([f("name", true), f("hq", false)], true)).toEqual(["Details", "Custom fields"]);
    // A published layout keeps the names its author gave.
    expect(titles([f("hq", false)], false)).toEqual(["Custom fields"]);
  });
});
