import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { LayoutChange, LayoutDoc, LayoutDraft, LayoutVersion } from "@/features/record/pageLayout";
import { field, objectMeta, renderRoute, SESSION, type Call } from "./utils";

const STAGES = [{ key: "open", label: "Open", category: "open" }, { key: "won", label: "Won", category: "won" }];
const DEAL = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", standard: true, fields: [
  field({ name: "name", label: "Name", type: "text", standard: true }),
  field({ name: "amount", label: "Amount", type: "currency", standard: true }),
  field({ name: "stage", label: "Stage", type: "status", values: STAGES, standard: true }),
  field({ name: "owner", label: "Owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } }),
  field({ name: "summary", label: "Summary", type: "long_text" }),
  field({ name: "secret", label: "Secret", type: "text", access: "none" }),
] });
const QUOTE = objectMeta({ name: "quote", label: "Quote", plural_label: "Quotes", standard: true, fields: [
  field({ name: "deal", label: "Deal", type: "relation", relation: { to: "deal", cardinality: "many_to_one" } }),
] });
const TASK = objectMeta({ name: "task", label: "Task", plural_label: "Tasks", standard: true, fields: [field({ name: "title", label: "Title", type: "text" })] });
const OBJECTS = [DEAL, QUOTE, TASK].map((o) => ({ name: o.name, label: o.label, plural_label: o.plural_label, standard: true, access: o.access, id_prefix: o.id_prefix, owned: false, field_count: o.fields.length }));
const METAS: Record<string, unknown> = { deal: DEAL, quote: QUOTE, task: TASK };

const RECORD_ID = `deal_${"A".repeat(26)}`;
const RECORD = { id: RECORD_ID, object: "deal", display_name: "Acme renewal", version: 1, name: "Acme renewal", amount: 5000, stage: "open", owner: null, summary: null };

const LAYOUT: LayoutDoc = {
  header: { key_facts: ["amount"] },
  top: [{ id: "stage_path", type: "stage_path", field: null }],
  columns: {
    left: [{ id: "details", type: "fields", name: "Details", columns: 1, collapsed: false, fields: ["name", "amount"] }],
    main: [{ id: "timeline", type: "timeline" }],
    right: [{ id: "tasks", type: "tasks", rows: 5 }],
  },
};
const SRC_WEB = { surface: "web", actor: "usr_ME", via: null };
const SRC_AGENT = { surface: "admin-mcp", actor: "usr_ROBIN", via: "Claude Desktop" };
const change = (n: number, extra: Partial<LayoutChange> = {}): LayoutChange => ({
  id: `lch_${n}`, revision: n, summary: `Change ${n}`, changes: [`Sentence ${n}`], note: null, source: SRC_WEB, at: new Date(Date.now() - n * 60_000).toISOString(), reviewed: false, can_undo: false, ...extra });
const draftOf = (extra: Partial<LayoutDraft> = {}): LayoutDraft => ({
  object: "deal", has_draft: true, revision: 4, layout: LAYOUT, published_version: 3, published_custom: true, stale: false, diff: [], updated_at: null,
  changes: [change(4, { can_undo: true }), change(3, { source: SRC_AGENT, reviewed: true })], ...extra });
const version = (n: number, extra: Partial<LayoutVersion> = {}): LayoutVersion => ({
  version: n, current: false, summary: `Version ${n} summary`, changes: [], restored_from: null, source: SRC_WEB, at: new Date(Date.now() - n * 86_400_000).toISOString(), default_page: false,
  contributors: [{ actor: "usr_ME", surface: "web", via: null, summary: "x", note: null, at: new Date().toISOString() }], ...extra });

type Reply = { status?: number; body?: unknown } | undefined;
/** A fake layout server: one draft that PUTs replace, with hooks for the answers a test wants to change. */
function server(init: { draft?: LayoutDraft; versions?: LayoutVersion[]; put?: (c: Call, state: { draft: LayoutDraft }) => Reply; extra?: (c: Call, state: { draft: LayoutDraft }) => Reply; recordFails?: boolean } = {}) {
  const state = { draft: init.draft ?? draftOf() };
  const versions = init.versions ?? [version(3, { current: true, source: SRC_AGENT, summary: "Published v3" }), version(2, { source: { surface: "cli", actor: "usr_ME", via: null } }), version(1)];
  const handler = (c: Call): Reply => {
    const own = init.extra?.(c, state);
    if (own) return own;
    const m = c.path.match(/^\/v1\/objects\/([a-z_]+)$/);
    if (m && METAS[m[1]!]) return { body: { data: METAS[m[1]!] } };
    if (c.path === `/v1/objects/deal/records/${RECORD_ID}`) return init.recordFails ? { status: 404, body: { code: "not_found", detail: "No such record", status: 404 } } : { body: { data: RECORD } };
    if (c.path === "/v1/users") return { body: { data: [{ id: "usr_ME", name: "Mia Example", email: "me@example.com" }, { id: "usr_ROBIN", name: "Robin Avery", email: "r@example.com" }] } };
    if (c.path === "/v1/roles") return { body: { data: [{ id: "role_1", key: "member", name: "Member", archived_at: null, permissions: [], active_members: 1 }] } };
    if (c.path === "/v1/roles/member/access") return { body: { data: { permissions: [], objects: [{ object: "deal", read: true, write: false, archive: false, rule: null, fields: { amount: "none" }, restricted_fields: [] }, { object: "quote", read: false, write: false, archive: false, rule: null, fields: {}, restricted_fields: [] }] } } };
    if (c.path === "/v1/objects/deal/layout/draft") {
      if (c.method === "GET") return { body: { data: state.draft } };
      if (c.method === "PUT") {
        const own2 = init.put?.(c, state);
        if (own2) return own2;
        const b = c.body as { layout: LayoutDoc; revision: number };
        state.draft = { ...state.draft, has_draft: true, revision: b.revision + 1, layout: b.layout, changes: [change(b.revision + 1, { can_undo: true }), ...state.draft.changes] };
        return { body: { data: { dry_run: false, saved: true, revision: state.draft.revision, object: "deal", layout: b.layout, changes: ["x"], warnings: [], diff_from_published: [] } } };
      }
      if (c.method === "DELETE") {
        state.draft = draftOf({ has_draft: false, revision: 0, changes: [] });
        return { body: { data: state.draft } };
      }
    }
    if (c.path === "/v1/objects/deal/layout/versions") return { body: { data: versions } };
    return undefined;
  };
  return { handler, state };
}

const EDITOR = { session: { ...SESSION, permissions: ["records:read", "schema:manage"] }, objects: OBJECTS };
const open = (handler: (c: Call) => Reply, path = `/o/deal/customize?record=${RECORD_ID}`, opts = EDITOR) => renderRoute(path, handler as never, opts);
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT" && c.path === "/v1/objects/deal/layout/draft");

describe("layout editor: the page and its status", () => {
  it("loads the shared draft, says where it stands, and shows the record's values on the canvas", async () => {
    const { handler } = server();
    open(handler);
    expect(await screen.findByRole("heading", { name: "Customize the Deal page" })).toBeInTheDocument();
    expect(await screen.findByText((_, el) => el?.tagName === "P" && el.textContent === "Shown with Acme renewal")).toBeInTheDocument();
    // Two changes, by two different people (the web member and the agent's member).
    expect(screen.getByText("Draft · 2 changes, 2 people")).toBeInTheDocument();
    const details = screen.getByRole("region", { name: "Details" });
    expect(await within(details).findByText("Acme renewal")).toBeInTheDocument();
    expect(within(details).getByText("Amount")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Publish to everyone" })).toBeEnabled();
  });

  it("with no draft, shows the published version and leaves Discard and Publish disabled", async () => {
    const { handler } = server({ draft: draftOf({ has_draft: false, revision: 0, changes: [] }) });
    open(handler);
    expect(await screen.findByText("Published v3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Publish to everyone" })).toBeDisabled();
  });

  it("calls the page with nothing published the default page, and shows labels only without a record", async () => {
    const { handler } = server({ draft: draftOf({ has_draft: false, revision: 0, changes: [], published_version: 0, published_custom: false }) });
    open(handler, "/o/deal/customize");
    expect(await screen.findByText("Default page")).toBeInTheDocument();
    expect(screen.getByText(/Showing field labels only/)).toBeInTheDocument();
    expect(screen.queryByText("Acme renewal")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the Deal schema" })).toHaveAttribute("href", "/settings/schema/deal");
  });

  it("goes back to the record when it was opened from one, and has no personal-layout controls at all", async () => {
    const { handler } = server();
    open(handler);
    expect(await screen.findByRole("link", { name: "Back to the record" })).toHaveAttribute("href", `/o/deal/${RECORD_ID}`);
    expect(screen.queryByText(/Just me/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Everyone")).not.toBeInTheDocument();
  });

  it("shows only the no-access state without permission to manage the schema, and asks the layout API for nothing", async () => {
    const { handler } = server();
    const { calls } = open(handler, undefined, { session: { ...SESSION, permissions: ["records:read"] }, objects: OBJECTS });
    expect(await screen.findByText("You can't customize this page")).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes("/layout"))).toBe(false);
  });
});

describe("layout editor: editing", () => {
  it("adds a field to a section with one PUT of the whole layout and the revision, and keeps what the server answers", async () => {
    const { handler } = server({
      // The server fills things in: here it renames the section it was given, to show the answer wins.
      put: (c, s) => {
        const b = c.body as { layout: LayoutDoc; revision: number };
        const layout = { ...b.layout, columns: { ...b.layout.columns, left: b.layout.columns.left.map((x) => (x.type === "fields" ? { ...x, name: "Details (saved)" } : x)) } };
        s.draft = { ...s.draft, revision: b.revision + 1, layout };
        return { body: { data: { dry_run: false, saved: true, revision: b.revision + 1, object: "deal", layout, changes: [], warnings: [], diff_from_published: [] } } };
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Add Owner to Details" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    const body = puts(calls)[0]!.body as { layout: LayoutDoc; revision: number };
    expect(body.revision).toBe(4);
    expect(body.layout.columns.left[0]).toMatchObject({ id: "details", fields: ["name", "amount", "owner"] });
    // The whole layout goes, not just the change.
    expect(body.layout.columns.main).toEqual(LAYOUT.columns.main);
    expect(body.layout.top).toEqual(LAYOUT.top);
    expect(body.layout.header).toEqual(LAYOUT.header);
    expect(await screen.findByRole("region", { name: "Details (saved)" })).toBeInTheDocument();
    // The field left the "not on the page" list.
    expect(screen.queryByRole("button", { name: "Add Owner to Details (saved)" })).not.toBeInTheDocument();
  });

  it("never offers a field the member can't see", async () => {
    const { handler } = server();
    open(handler);
    await screen.findByRole("button", { name: "Add Owner to Details" });
    expect(screen.queryByText("Secret")).not.toBeInTheDocument();
  });

  it("moves a block up, down and between columns with buttons, each a PUT carrying the newest revision", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: /^Activity timeline/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move to the column on the right" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    let body = puts(calls)[0]!.body as { layout: LayoutDoc; revision: number };
    expect(body.layout.columns.main).toEqual([]);
    expect(body.layout.columns.right.map((c) => c.id)).toEqual(["timeline", "tasks"]);

    await waitFor(() => expect(screen.getByRole("button", { name: "Move down" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Move down" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    body = puts(calls)[1]!.body as { layout: LayoutDoc; revision: number };
    expect(body.layout.columns.right.map((c) => c.id)).toEqual(["tasks", "timeline"]);
    expect(body.revision).toBe(5);

    await userEvent.click(screen.getByRole("button", { name: "Move to the column on the left" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(3));
    body = puts(calls)[2]!.body as { layout: LayoutDoc; revision: number };
    expect(body.layout.columns.main.map((c) => c.id)).toEqual(["timeline"]);
    expect(screen.getByRole("button", { name: "Move to the column on the right" })).toBeEnabled();
  });

  it("removes a block from the page, and a section's fields can be reordered and taken off", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: /^Details/ }));
    await userEvent.click(screen.getByRole("button", { name: "Move Name down" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0]!.body as { layout: LayoutDoc }).layout.columns.left[0]).toMatchObject({ fields: ["amount", "name"] });
    await userEvent.click(screen.getByRole("button", { name: "Take Amount off the page" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect((puts(calls)[1]!.body as { layout: LayoutDoc }).layout.columns.left[0]).toMatchObject({ fields: ["name"] });
    await userEvent.click(screen.getByRole("button", { name: "Remove from page" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(3));
    expect((puts(calls)[2]!.body as { layout: LayoutDoc }).layout.columns.left).toEqual([]);
  });

  it("saves a section's name once, when the box loses focus, not on every key", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: /^Details/ }));
    const input = screen.getByRole("textbox", { name: "Section name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Plan");
    expect(puts(calls)).toHaveLength(0);
    await userEvent.tab();
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0]!.body as { layout: LayoutDoc }).layout.columns.left[0]).toMatchObject({ name: "Plan" });
    await userEvent.click(screen.getByRole("switch", { name: "Collapsed by default" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect((puts(calls)[1]!.body as { layout: LayoutDoc }).layout.columns.left[0]).toMatchObject({ collapsed: true });
  });

  it("adds and removes key facts in the header, with at most six", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Add a key fact" }), "stage");
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0]!.body as { layout: LayoutDoc }).layout.header.key_facts).toEqual(["amount", "stage"]);
    // Long text doesn't fit in a header, so it isn't offered.
    const options = within(screen.getByRole("combobox", { name: "Add a key fact" })).getAllByRole("option").map((o) => o.textContent);
    expect(options).not.toContain("Summary");
    await userEvent.click(screen.getByRole("button", { name: "Remove Amount from the header" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(2));
    expect((puts(calls)[1]!.body as { layout: LayoutDoc }).layout.header.key_facts).toEqual(["stage"]);
  });
});

describe("layout editor: the library", () => {
  it("won't add a once-only component twice, or one that doesn't apply, and says why", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    // The page already has a timeline, tasks and a stage path.
    expect(await screen.findByRole("button", { name: "Add Activity timeline" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Open tasks" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add Stage path" })).toBeDisabled();
    expect(screen.getAllByText("Already on the page").length).toBeGreaterThanOrEqual(3);
    const notes = screen.getByRole("button", { name: "Add Notes" });
    expect(notes).toBeEnabled();
    await userEvent.click(notes);
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0]!.body as { layout: LayoutDoc }).layout.columns.main.map((c) => c.type)).toEqual(["timeline", "notes"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Notes" })).toBeDisabled());
    // A quote relates to a deal, so quotes can be added.
    expect(screen.getByRole("button", { name: "Add Quotes" })).toBeEnabled();
  });

  it("disables Quotes when no quote relates to the object", async () => {
    const own = (c: Call): Reply => (c.path === "/v1/objects/quote" ? { body: { data: { ...QUOTE, fields: [] } } } : undefined);
    const { handler } = server({ extra: own });
    open(handler);
    const quotes = await screen.findByRole("button", { name: "Add Quotes" });
    await waitFor(() => expect(quotes).toBeDisabled());
    expect(screen.getByText("Quotes aren't made for deals")).toBeInTheDocument();
  });

  it("asks which relation a related list shows, and leaves out the ones already placed", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Add Related list" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByRole("combobox", { name: /Records and the relation/ });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Quotes · Deal"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Add list" }));
    await waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect((puts(calls)[0]!.body as { layout: LayoutDoc }).layout.columns.right.at(-1)).toMatchObject({ type: "related", object: "quote", field: "deal", rows: 5 });
    // That relation is now placed, so nothing is left to add.
    await waitFor(() => expect(screen.getByRole("button", { name: "Add Related list" })).toBeDisabled());
  });

  it("filters both lists with the search box", async () => {
    const { handler } = server();
    open(handler);
    await userEvent.type(await screen.findByRole("searchbox", { name: "Find a field or component" }), "own");
    expect(screen.getByRole("button", { name: "Add Owner to Details" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Stage to Details" })).not.toBeInTheDocument();
  });
});

describe("layout editor: publishing and discarding", () => {
  it("previews what publishing changes before doing it, then publishes the revision it read", async () => {
    const { handler } = server({
      extra: (c) => {
        if (c.path === "/v1/objects/deal/layout/publish") {
          const b = c.body as { dry_run?: boolean };
          return b.dry_run
            ? { body: { data: { dry_run: true, published: false, version: 3, would_publish: 4, changes: ["Moved Timeline to the right column", "Added Notes to the main column"], stale: false, layout: LAYOUT } } }
            : { body: { data: { dry_run: false, published: true, version: 4, changes: [], stale: false, layout: LAYOUT } } };
        }
        return undefined;
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Publish to everyone" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Moved Timeline to the right column")).toBeInTheDocument();
    expect(within(dialog).getByText("Added Notes to the main column")).toBeInTheDocument();
    const publishes = () => calls.filter((c) => c.path === "/v1/objects/deal/layout/publish");
    expect(publishes()).toHaveLength(1);
    expect(publishes()[0]!.body).toMatchObject({ dry_run: true, revision: 4 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Publish to everyone" }));
    await waitFor(() => expect(publishes()).toHaveLength(2));
    expect(publishes()[1]!.body).toEqual({ revision: 4 });
    expect(await screen.findByText("Published version 4")).toBeInTheDocument();
  });

  it("warns when the published layout changed since the draft began, and publishes over it only when ticked", async () => {
    const { handler } = server({
      extra: (c) => {
        if (c.path === "/v1/objects/deal/layout/publish") {
          const b = c.body as { dry_run?: boolean };
          return b.dry_run
            ? { body: { data: { dry_run: true, published: false, version: 3, would_publish: 4, changes: ["Collapsed Details"], stale: true, layout: LAYOUT } } }
            : { body: { data: { dry_run: false, published: true, version: 4, changes: [], stale: false, layout: LAYOUT } } };
        }
        return undefined;
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Publish to everyone" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/published layout changed after this draft was started/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Publish to everyone" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Publish over it" }));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    await waitFor(() => expect(calls.filter((c) => c.path === "/v1/objects/deal/layout/publish")).toHaveLength(2));
    expect(calls.filter((c) => c.path === "/v1/objects/deal/layout/publish")[1]!.body).toEqual({ revision: 4, overwrite: true });
  });

  it("discards the draft only after confirming", async () => {
    const { handler } = server();
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Discard draft" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/objects/deal/layout/draft")).toBe(true));
    expect(await screen.findByText("Published v3")).toBeInTheDocument();
  });
});

describe("layout editor: when someone else changes the draft", () => {
  it("reads the draft again, names who changed it, and doesn't re-apply the edit", async () => {
    let conflicted = false;
    const { handler, state } = server({
      put: (c, s) => {
        conflicted = true;
        s.draft = { ...s.draft, revision: 7, changes: [change(7, { source: SRC_AGENT, summary: "Collapsed Details" }), ...s.draft.changes] };
        return { status: 409, body: { code: "layout_draft_changed", status: 409, detail: "The draft changed", details: { revision: 7 } } };
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Add Owner to Details" }));
    const alert = await screen.findByText(/changed this draft while you were editing/);
    expect(alert).toHaveTextContent("Claude Desktop for Robin Avery through Admin MCP");
    expect(conflicted).toBe(true);
    // One PUT only: nothing was retried, and the page shows the draft as the server has it.
    expect(puts(calls)).toHaveLength(1);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/objects/deal/layout/draft").length).toBeGreaterThanOrEqual(2);
    expect(state.draft.revision).toBe(7);
    expect(screen.getByRole("button", { name: "Add Owner to Details" })).toBeInTheDocument();
  });

  it("shows the server's message and puts the page back when the layout is refused", async () => {
    const { handler } = server({ put: () => ({ status: 422, body: { code: "validation_failed", status: 422, detail: "Two sections are called “Plan”" } }) });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Add Owner to Details" }));
    expect(await screen.findByText(/Two sections are called/)).toBeInTheDocument();
    expect(puts(calls)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Add Owner to Details" })).toBeInTheDocument();
  });
});

describe("layout editor: what agents changed", () => {
  const agentDraft = (can_undo: boolean) => draftOf({ changes: [change(4, { source: SRC_AGENT, reviewed: false, can_undo, summary: "Added Amount to the header", changes: ["Added Amount to the header"], note: "Put Amount in the header" })] });

  it("shows an unreviewed agent change above the canvas, with Keep, and Undo only when it can be undone", async () => {
    const { handler, state } = server({
      draft: agentDraft(true),
      extra: (c, s) => {
        if (c.path === "/v1/objects/deal/layout/draft/review") {
          s.draft = { ...s.draft, changes: s.draft.changes.map((x) => ({ ...x, reviewed: true })) };
          return { body: { data: s.draft } };
        }
        return undefined;
      },
    });
    const { calls } = open(handler);
    const text = await screen.findByText(/Claude Desktop changed this draft through Admin MCP/);
    expect(text.closest("div")).toHaveTextContent("for Robin Avery");
    expect(text.closest("div")).toHaveTextContent("“Put Amount in the header”");
    expect(screen.getAllByText("Added Amount to the header").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Undo this change" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/objects/deal/layout/draft/review" && (c.body as { change: string }).change === "lch_4")).toBe(true));
    await waitFor(() => expect(screen.queryByText(/changed this draft through Admin MCP/)).not.toBeInTheDocument());
    expect(state.draft.changes[0]!.reviewed).toBe(true);
  });

  it("undoes the agent's change when asked", async () => {
    const { handler } = server({
      draft: agentDraft(true),
      extra: (c, s) => {
        if (c.path === "/v1/objects/deal/layout/draft/undo") {
          s.draft = draftOf({ has_draft: false, revision: 0, changes: [] });
          return { body: { data: s.draft } };
        }
        return undefined;
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("button", { name: "Undo this change" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/objects/deal/layout/draft/undo" && (c.body as { change: string }).change === "lch_4")).toBe(true));
    expect(await screen.findByText("Published v3")).toBeInTheDocument();
  });

  it("offers no Undo for a change that can't be undone any more", async () => {
    const { handler } = server({ draft: agentDraft(false) });
    open(handler);
    expect(await screen.findByRole("button", { name: "Keep" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo this change" })).not.toBeInTheDocument();
  });

  it("shows no banner for changes made on the web or already reviewed", async () => {
    const { handler } = server();
    open(handler);
    await screen.findByText("Draft · 2 changes, 2 people");
    expect(screen.queryByRole("button", { name: "Keep" })).not.toBeInTheDocument();
  });
});

describe("layout editor: History, As code and Preview as", () => {
  it("lists the draft's changes and the published versions with where each came from, and previews a restore before applying it", async () => {
    const { handler } = server({
      extra: (c) => {
        if (c.path === "/v1/objects/deal/layout/restore") {
          const b = c.body as { dry_run?: boolean };
          return { body: { data: { dry_run: Boolean(b.dry_run), saved: !b.dry_run, revision: 5, object: "deal", layout: LAYOUT, changes: ["Moved Timeline to the main column"], warnings: [], diff_from_published: [] } } };
        }
        return undefined;
      },
    });
    const { calls } = open(handler);
    await userEvent.click(await screen.findByRole("tab", { name: "History" }));
    const draftList = await screen.findByRole("region", { name: "Draft changes" });
    expect(within(draftList).getByText("Change 4")).toBeInTheDocument();
    expect(within(draftList).getByText("Admin MCP")).toBeInTheDocument();
    // Only the newest change has an Undo.
    expect(within(draftList).getAllByRole("button", { name: /^Undo/ })).toHaveLength(1);
    const published = await screen.findByRole("region", { name: "Published versions" });
    expect(await within(published).findByText("v3")).toBeInTheDocument();
    expect(within(published).getByText("current")).toBeInTheDocument();
    expect(within(published).getByText("CLI")).toBeInTheDocument();
    expect(within(published).queryByRole("button", { name: "Restore v3" })).not.toBeInTheDocument();
    await userEvent.click(within(published).getByRole("button", { name: "Restore v2" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Moved Timeline to the main column")).toBeInTheDocument();
    expect(within(dialog).getByText(/goes into the draft/)).toBeInTheDocument();
    const restores = () => calls.filter((c) => c.path === "/v1/objects/deal/layout/restore");
    expect(restores()).toHaveLength(1);
    expect(restores()[0]!.body).toEqual({ version: 2, revision: 4, dry_run: true });
    await userEvent.click(within(dialog).getByRole("button", { name: "Put it in the draft" }));
    await waitFor(() => expect(restores()).toHaveLength(2));
    expect(restores()[1]!.body).toEqual({ version: 2, revision: 4 });
    expect(await screen.findByText("Version 2 is now in the draft")).toBeInTheDocument();
  });

  it("shows the draft as JSON with the object's real name, and the equivalent calls", async () => {
    const { handler } = server();
    open(handler);
    await userEvent.click(await screen.findByRole("tab", { name: "As code" }));
    expect(await screen.findByText("Ask your agent instead")).toBeInTheDocument();
    const json = screen.getByRole("region", { name: "The draft as JSON" });
    expect(json).toHaveTextContent('"object": "deal"');
    expect(json).toHaveTextContent('"key_facts"');
    expect(JSON.parse(json.textContent ?? "")).toMatchObject({ object: "deal", columns: { left: [{ id: "details" }] } });
    expect(screen.getByRole("button", { name: /Copy/ })).toBeInTheDocument();
    expect(screen.getByText("PUT /v1/objects/deal/layout/draft")).toBeInTheDocument();
    expect(screen.getByText("POST /v1/objects/deal/layout/publish")).toBeInTheDocument();
    expect(screen.getByText("set_page_layout")).toBeInTheDocument();
    expect(screen.getByText("publish_page_layout")).toBeInTheDocument();
    expect(screen.getByText("crm schema pull")).toBeInTheDocument();
    expect(screen.getByText("crm schema apply")).toBeInTheDocument();
    // The example is built from this object's own labels, never invented ones.
    expect(screen.getByText(/On the Deal page, put Name and Stage in the header, and collapse Details\./)).toBeInTheDocument();
  });

  it("marks what a previewed role can't read, and does nothing for 'As me'", async () => {
    const { handler } = server();
    open(handler);
    const details = await screen.findByRole("region", { name: "Details" });
    expect(within(details).queryByText(/Hidden from/)).not.toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Preview as role" }), "Member");
    expect(await within(details).findByText("Hidden from Member")).toBeInTheDocument();
    // A role that can't read quotes hides them wherever they are placed (the page has none yet, so the key fact stays visible).
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Preview as role" }), "");
    await waitFor(() => expect(within(details).queryByText(/Hidden from/)).not.toBeInTheDocument());
  });

  it("hides the Preview as control when roles can't be read", async () => {
    const { handler } = server({ extra: (c) => (c.path === "/v1/roles" ? { status: 403, body: { code: "forbidden", status: 403, detail: "No" } } : undefined) });
    open(handler);
    await screen.findByRole("heading", { name: "Customize the Deal page" });
    await screen.findByText("Draft · 2 changes, 2 people");
    expect(screen.queryByRole("combobox", { name: "Preview as role" })).not.toBeInTheDocument();
  });
});

describe("Settings → an object: the Record page section", () => {
  const published = (custom: boolean) => ({ object: "deal", custom, version: custom ? 3 : 0, layout: LAYOUT, sections: [], updated_at: null });
  const settings = (opts: { custom: boolean; session?: typeof SESSION; draft?: LayoutDraft }) => renderRoute("/settings/schema/deal", (c: Call) => {
    if (c.path === "/v1/objects/deal" && c.method === "GET") return { body: { data: DEAL } };
    if (c.path === "/v1/objects/deal/layout") return { body: { data: published(opts.custom) } };
    if (c.path === "/v1/objects/deal/layout/draft") return { body: { data: opts.draft ?? draftOf({ has_draft: false, revision: 0, changes: [] }) } };
    return undefined;
  }, { objects: OBJECTS, session: opts.session ?? EDITOR.session });

  it("shows the published version and a waiting draft, with the way into the editor", async () => {
    settings({ custom: true });
    await userEvent.click(await screen.findByRole("tab", { name: "Page layout" }));
    const region = await screen.findByRole("region", { name: "Record page" });
    expect(await within(region).findByText("Published v3")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "Customize page" })).toHaveAttribute("href", "/o/deal/customize");
    expect(within(region).queryByText(/Draft waiting/)).not.toBeInTheDocument();
  });

  it("says when a draft is waiting, and calls an unpublished layout the default page", async () => {
    settings({ custom: false, draft: draftOf() });
    await userEvent.click(await screen.findByRole("tab", { name: "Page layout" }));
    const region = await screen.findByRole("region", { name: "Record page" });
    expect(await within(region).findByText("Default page")).toBeInTheDocument();
    expect(await within(region).findByText("Draft waiting · 2 changes")).toBeInTheDocument();
  });

  it("offers no way into the editor, and asks for no draft, without permission to manage the schema", async () => {
    const { calls } = settings({ custom: true, session: { ...SESSION, permissions: ["records:read"] } });
    await userEvent.click(await screen.findByRole("tab", { name: "Page layout" }));
    const region = await screen.findByRole("region", { name: "Record page" });
    expect(await within(region).findByText("Published v3")).toBeInTheDocument();
    expect(within(region).queryByRole("link", { name: "Customize page" })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path.endsWith("/draft"))).toBe(false);
  });
});
