import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeId } from "../src/lib/ids.js";
import { call, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/** Record page layouts: the shared draft, publishing, version history and restore. */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const AGENT = { "x-hlcrm-surface": "admin-mcp" };
const CLI = { "x-hlcrm-surface": "cli" };

const base = (o: string) => `/v1/objects/${o}/layout`;
const admin = (ws: Workspace) => ws.keys.admin;
const getDraft = (ws: Workspace, o = "contact") => call("GET", `${base(o)}/draft`, { key: admin(ws) });
const putDraft = (ws: Workspace, body: Record<string, unknown>, o = "contact", headers?: Record<string, string>) =>
  call("PUT", `${base(o)}/draft`, { key: admin(ws), body, headers });
const publish = (ws: Workspace, body: Record<string, unknown> = {}, o = "contact", headers?: Record<string, string>) =>
  call("POST", `${base(o)}/publish`, { key: admin(ws), body, headers });
const putLayout = (ws: Workspace, layout: unknown, o = "contact", headers?: Record<string, string>) =>
  call("PUT", base(o), { key: admin(ws), body: { layout }, headers });
const getPublished = (ws: Workspace, o = "contact", key = admin(ws)) => call("GET", base(o), { key });
const versions = (ws: Workspace, o = "contact") => call("GET", `${base(o)}/versions`, { key: admin(ws) });

/** A small valid layout: one section of fields and a timeline. */
const lay = (fields: string[] = ["first_name", "email"], extra: Record<string, unknown[]> = {}, header?: unknown) => ({
  ...(header ? { header } : {}),
  columns: { left: [{ type: "fields", name: "Who", fields }], main: [{ type: "timeline" }], right: [], ...extra },
});
const fresh = async (name: string, withFields = true) => {
  const ws = await newWorkspace(name);
  if (withFields) {
    for (const f of [{ api_name: "shoe_size", type: "number" }, { api_name: "bio", type: "long_text" }, { api_name: "ssn", type: "text", sensitivity: "restricted" }]) {
      const r = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: f });
      if (r.status !== 201) throw new Error(JSON.stringify(r.json));
    }
  }
  return ws;
};
const types = (list: Json[]) => list.map((c) => c.type);

describe("the draft of an untouched object", () => {
  it("has no draft, revision 0 and the default page", async () => {
    const ws = await fresh("Default page", false);
    const r = await getDraft(ws);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ object: "contact", has_draft: false, revision: 0, published_version: 0, published_custom: false, stale: false, diff: [], changes: [], updated_at: null });
    const { layout } = r.json.data;
    expect(layout.top).toEqual([]);
    expect(layout.columns.left[0]).toMatchObject({ id: "details", type: "fields", name: "Details", columns: 1, collapsed: false });
    expect(layout.columns.left[0].fields.length).toBeGreaterThan(0);
    expect(layout.columns.left[0].fields).toContain("email");
    expect(types(layout.columns.main)).toEqual(["timeline", "notes", "files"]);
    expect(types(layout.columns.right)).toEqual(["related_lists", "tasks"]);
    const deal = (await getDraft(ws, "deal")).json.data.layout;
    expect(deal.top).toEqual([{ id: "stage_path", type: "stage_path", field: null }]);
  });
});

describe("writing the draft", () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await fresh("Draft writes"); });

  it("saves nothing on a dry run and says what would change", async () => {
    const r = await putDraft(ws, { layout: lay(), dry_run: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ dry_run: true, saved: false, revision: 0, object: "contact", warnings: [] });
    expect(r.json.data.changes.length).toBeGreaterThan(0);
    expect(r.json.data.changes.every((c: unknown) => typeof c === "string")).toBe(true);
    const after = (await getDraft(ws)).json.data;
    expect(after).toMatchObject({ has_draft: false, revision: 0, changes: [] });
  });

  it("saves revision 1 and records the change with its source", async () => {
    const r = await putDraft(ws, { layout: lay(), note: "Put names first" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ dry_run: false, saved: true, revision: 1 });
    const d = (await getDraft(ws)).json.data;
    expect(d).toMatchObject({ has_draft: true, revision: 1, published_version: 0, stale: false });
    expect(d.diff.length).toBeGreaterThan(0);
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({ revision: 1, note: "Put names first", reviewed: false, can_undo: true, source: { surface: "api" } });
    expect(typeof d.changes[0].source.via).toBe("string");
    expect(d.changes[0].id).toMatch(/^lch_/);
    expect(d.changes[0].summary.length).toBeGreaterThan(0);
  });

  it("does not save a write that changes nothing", async () => {
    const d = (await getDraft(ws)).json.data;
    const r = await putDraft(ws, { layout: d.layout, revision: d.revision });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ saved: false, revision: d.revision, changes: [] });
  });
});

describe("component ids and defaults", () => {
  it("gives components ids, keeps them on later writes and fills defaults", async () => {
    const ws = await fresh("Ids");
    const r = await putDraft(ws, { layout: { columns: {
      left: [{ type: "fields", name: "Who we talk to", fields: ["first_name"] }],
      main: [{ type: "timeline" }, { type: "agent_changes" }],
      right: [{ type: "tasks" }],
    } } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const { columns } = r.json.data.layout;
    const section = columns.left[0];
    expect(section).toMatchObject({ type: "fields", name: "Who we talk to", columns: 1, collapsed: false, fields: ["first_name"] });
    expect(section.id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(columns.main[0]).toEqual({ id: "timeline", type: "timeline" });
    expect(columns.main[1]).toEqual({ id: "agent_changes", type: "agent_changes", days: 7 });
    expect(columns.right[0]).toEqual({ id: "tasks", type: "tasks", rows: 5 });
    const draft = (await getDraft(ws)).json.data;
    expect(draft.layout.columns).toEqual(columns);
    // Send the layout back with one more field: every id stays.
    const next = structuredClone(draft.layout);
    next.columns.left[0].fields.push("email");
    const again = await putDraft(ws, { layout: next, revision: draft.revision });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json.data.layout.columns.left[0].id).toBe(section.id);
    expect(again.json.data.layout.columns.main.map((c: Json) => c.id)).toEqual(["timeline", "agent_changes"]);
    expect(again.json.data.changes).toHaveLength(1);
    // An id given by the caller is kept as it is.
    const named = structuredClone(next);
    named.columns.main[0].id = "history";
    const third = await putDraft(ws, { layout: named, revision: again.json.data.revision });
    expect(third.json.data.layout.columns.main[0].id).toBe("history");
  });
});

describe("concurrent writers", () => {
  it("refuses a write without a revision (428), a stale one (409) and accepts the right one", async () => {
    const ws = await fresh("Concurrency");
    expect((await putDraft(ws, { layout: lay(["first_name"]) })).json.data.revision).toBe(1);
    const missing = await putDraft(ws, { layout: lay(["first_name", "email"]) });
    expect(missing.status).toBe(428);
    expect(missing.json.code).toBe("layout_revision_required");
    const stale = await putDraft(ws, { layout: lay(["first_name", "email"]), revision: 0 });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe("layout_draft_changed");
    const ok = await putDraft(ws, { layout: lay(["first_name", "email"]), revision: 1 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.data).toMatchObject({ saved: true, revision: 2 });
    expect((await getDraft(ws)).json.data.revision).toBe(2);
    // A dry run needs no revision.
    expect((await putDraft(ws, { layout: lay(["email"]), dry_run: true })).status).toBe(200);
  });
});

describe("two actors, review and undo", () => {
  let ws: Workspace;
  let ids: string[];
  beforeAll(async () => {
    ws = await fresh("Actors");
    expect((await putDraft(ws, { layout: lay(["first_name"]), note: "Agent: names only" }, "contact", AGENT)).status).toBe(200);
    expect((await putDraft(ws, { layout: lay(["first_name", "email"]), revision: 1 })).status).toBe(200);
  });

  it("lists both changes newest first, each with its source, and only the newest can be undone", async () => {
    const d = (await getDraft(ws)).json.data;
    expect(d.changes.map((c: Json) => c.revision)).toEqual([2, 1]);
    expect(d.changes[0]).toMatchObject({ note: null, can_undo: true, source: { surface: "api" } });
    expect(d.changes[1]).toMatchObject({ note: "Agent: names only", can_undo: false, source: { surface: "admin-mcp" } });
    expect(d.changes[0].source.via).toBeTruthy();
    expect(d.changes[1].source.via).toBeTruthy();
    ids = d.changes.map((c: Json) => c.id);
  });

  it("marks a change reviewed", async () => {
    const r = await call("POST", `${base("contact")}/draft/review`, { key: admin(ws), body: { change: ids[1] } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.changes.map((c: Json) => c.reviewed)).toEqual([false, true]);
    expect((await call("POST", `${base("contact")}/draft/review`, { key: admin(ws), body: { change: encodeId("lch", randomUUID()) } })).status).toBe(404);
  });
});

describe("undo", () => {
  it("puts the draft back and records an Undid change; older or unknown changes are refused", async () => {
    const ws = await fresh("Undo");
    const first = (await putDraft(ws, { layout: lay(["first_name"]) })).json.data;
    const second = (await putDraft(ws, { layout: lay(["first_name", "email"]), revision: first.revision })).json.data;
    const d = (await getDraft(ws)).json.data;
    const [newest, oldest] = d.changes.map((c: Json) => c.id);
    const undoUrl = `${base("contact")}/draft/undo`;
    const notNewest = await call("POST", undoUrl, { key: admin(ws), body: { change: oldest } });
    expect(notNewest.status).toBe(409);
    const unknown = await call("POST", undoUrl, { key: admin(ws), body: { change: encodeId("lch", randomUUID()) } });
    expect(unknown.status).toBe(404);
    expect((await call("POST", undoUrl, { key: admin(ws), body: { change: "nonsense" } })).status).toBe(404);
    const undone = await call("POST", undoUrl, { key: admin(ws), body: { change: newest } });
    expect(undone.status, JSON.stringify(undone.json)).toBe(200);
    expect(undone.json.data.layout).toEqual(first.layout);
    expect(undone.json.data.revision).toBe(second.revision + 1);
    expect(undone.json.data.changes).toHaveLength(3);
    expect(undone.json.data.changes[0].summary).toMatch(/^Undid: /);
    expect(undone.json.data.changes[0].can_undo).toBe(true);
    // The change that was undone is no longer the newest.
    expect((await call("POST", undoUrl, { key: admin(ws), body: { change: newest } })).status).toBe(409);
  });
});

describe("publishing", () => {
  let ws: Workspace;
  beforeAll(async () => { ws = await fresh("Publish"); });

  it("publishes nothing on a dry run", async () => {
    await putDraft(ws, { layout: lay(["first_name"]), note: "Names" }, "contact", AGENT);
    const r = await publish(ws, { dry_run: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ dry_run: true, published: false, version: 0, would_publish: 1, stale: false });
    expect(r.json.data.changes.length).toBeGreaterThan(0);
    expect((await getPublished(ws)).json.data).toMatchObject({ custom: false, version: 0 });
    expect((await getDraft(ws)).json.data.has_draft).toBe(true);
  });

  it("publishes the draft as version 1 with every contributor, oldest first, and clears the draft", async () => {
    const second = await putDraft(ws, { layout: lay(["first_name", "email"]), revision: 1, note: "Add email" });
    expect(second.status).toBe(200);
    const r = await publish(ws, { revision: 2 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data).toMatchObject({ dry_run: false, published: true, version: 1, stale: false });
    const pub = (await getPublished(ws)).json.data;
    expect(pub).toMatchObject({ object: "contact", custom: true, version: 1 });
    expect(pub.layout).toEqual(r.json.data.layout);
    expect(pub.sections).toEqual([{ title: "Who", fields: ["first_name", "email"] }]);
    expect((await getDraft(ws)).json.data).toMatchObject({ has_draft: false, revision: 0, published_version: 1, changes: [] });
    const list = (await versions(ws)).json.data as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ version: 1, current: true, default_page: false, restored_from: null, source: { surface: "api" } });
    expect(list[0].contributors).toHaveLength(2);
    expect(list[0].contributors[0]).toMatchObject({ surface: "admin-mcp", note: "Names" });
    expect(list[0].contributors[1]).toMatchObject({ surface: "api", note: "Add email" });
    expect(list[0].source.via).toBeTruthy();
  });

  it("lists versions newest first", async () => {
    await putDraft(ws, { layout: lay(["first_name"]) });
    expect((await publish(ws, { note: "Back to one field" })).json.data.version).toBe(2);
    const list = (await versions(ws)).json.data as Json[];
    expect(list.map((v) => v.version)).toEqual([2, 1]);
    expect(list.map((v) => v.current)).toEqual([true, false]);
    expect(list[0].summary).toBe("Back to one field");
  });

  it("refuses to publish with no draft (409)", async () => {
    const r = await publish(ws);
    expect(r.status).toBe(409);
  });

  it("refuses to publish with a wrong revision (409 layout_draft_changed)", async () => {
    await putDraft(ws, { layout: lay(["email"]) });
    const r = await publish(ws, { revision: 7 });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("layout_draft_changed");
    expect((await getDraft(ws)).json.data.has_draft).toBe(true);
  });
});

describe("a stale draft", () => {
  it("is flagged when the layout was published meanwhile, and publishes only with overwrite", async () => {
    const ws = await fresh("Stale");
    await putDraft(ws, { layout: lay(["first_name"]) });
    const direct = await putLayout(ws, lay(["last_name"]));
    expect(direct.status, JSON.stringify(direct.json)).toBe(200);
    expect(direct.json.data).toMatchObject({ published: true, version: 1 });
    const d = (await getDraft(ws)).json.data;
    expect(d).toMatchObject({ has_draft: true, stale: true, published_version: 1 });
    const refused = await publish(ws);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("layout_draft_stale");
    const dry = await publish(ws, { dry_run: true });
    expect(dry.json.data).toMatchObject({ stale: true, would_publish: 2 });
    const ok = await publish(ws, { overwrite: true });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.data.version).toBe(2);
    expect((await getPublished(ws)).json.data.sections).toEqual([{ title: "Who", fields: ["first_name"] }]);
  });
});

describe("history and restore", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await fresh("Restore");
    expect((await putLayout(ws, lay(["first_name"]))).json.data.version).toBe(1);
    expect((await putLayout(ws, lay(["first_name", "email", "phone"]))).json.data.version).toBe(2);
  });

  it("reads one version with its layout and refuses unknown or malformed ones", async () => {
    const v1 = await call("GET", `${base("contact")}/versions/1`, { key: admin(ws) });
    expect(v1.status).toBe(200);
    expect(v1.json.data).toMatchObject({ version: 1, current: false, default_page: false });
    expect(v1.json.data.layout.columns.left[0]).toMatchObject({ name: "Who", fields: ["first_name"] });
    expect((await call("GET", `${base("contact")}/versions/2`, { key: admin(ws) })).json.data.current).toBe(true);
    expect((await call("GET", `${base("contact")}/versions/999`, { key: admin(ws) })).status).toBe(404);
    expect((await call("GET", `${base("contact")}/versions/abc`, { key: admin(ws) })).status).toBe(422);
  });

  it("restores a version into the draft only when not a dry run, and publishing it makes version 3", async () => {
    const url = `${base("contact")}/restore`;
    const dry = await call("POST", url, { key: admin(ws), body: { version: 1, dry_run: true } });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json.data).toMatchObject({ dry_run: true, saved: false, restored_from: 1 });
    expect(dry.json.data.changes.length).toBeGreaterThan(0);
    expect((await getDraft(ws)).json.data.has_draft).toBe(false);

    const real = await call("POST", url, { key: admin(ws), body: { version: 1 } });
    expect(real.status, JSON.stringify(real.json)).toBe(200);
    expect(real.json.data).toMatchObject({ dry_run: false, saved: true, revision: 1, restored_from: 1 });
    const v1 = (await call("GET", `${base("contact")}/versions/1`, { key: admin(ws) })).json.data;
    const d = (await getDraft(ws)).json.data;
    expect(d.layout).toEqual(v1.layout);
    expect(d.changes[0]).toMatchObject({ note: "Restored version 1" });

    const p = await publish(ws);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.data.version).toBe(3);
    expect((await versions(ws)).json.data.map((v: Json) => v.version)).toEqual([3, 2, 1]);
    expect((await call("POST", url, { key: admin(ws), body: { version: 999 } })).status).toBe(404);
  });
});

describe("discarding and resetting", () => {
  it("discards the draft without touching the published layout, and reset publishes the default page", async () => {
    const ws = await fresh("Discard");
    await putLayout(ws, lay(["first_name"]));
    await putDraft(ws, { layout: lay(["email"]) });
    const gone = await call("DELETE", `${base("contact")}/draft`, { key: admin(ws) });
    expect(gone.status).toBe(200);
    expect(gone.json.data).toMatchObject({ has_draft: false, revision: 0, published_version: 1, changes: [] });
    expect((await getPublished(ws)).json.data).toMatchObject({ custom: true, version: 1, sections: [{ title: "Who", fields: ["first_name"] }] });
    // Discarding again is harmless.
    expect((await call("DELETE", `${base("contact")}/draft`, { key: admin(ws) })).status).toBe(200);

    const reset = await call("DELETE", base("contact"), { key: admin(ws) });
    expect(reset.status).toBe(200);
    expect(reset.json.data).toMatchObject({ custom: false, version: 2, sections: [] });
    const list = (await versions(ws)).json.data as Json[];
    expect(list.map((v) => [v.version, v.default_page])).toEqual([[2, true], [1, false]]);
  });
});

describe("validation", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await fresh("Validation");
    const w = await call("POST", "/v1/objects", { key: admin(ws), body: { api_name: "widget", label: "Widget", plural_label: "Widgets", id_prefix: "wdg", owned: true } });
    if (w.status !== 201) throw new Error(JSON.stringify(w.json));
  });
  const main = (...c: unknown[]) => ({ columns: { main: c } });
  const cases: [string, string, unknown][] = [
    ["an unknown component type", "contact", main({ type: "carousel" })],
    ["a field that does not exist", "contact", lay(["no_such_field"])],
    ["the same field in two sections", "contact", { columns: { left: [{ type: "fields", name: "A", fields: ["email"] }, { type: "fields", name: "B", fields: ["email"] }] } }],
    ["two sections with the same name", "contact", { columns: { left: [{ type: "fields", name: "A", fields: [] }, { type: "fields", name: "a", fields: [] }] } }],
    ["a second timeline", "contact", main({ type: "timeline" }, { type: "timeline" })],
    ["a component other than a stage path across the top", "contact", { top: [{ type: "timeline" }], columns: { main: [{ type: "notes" }] } }],
    ["more than six key facts", "contact", lay(["first_name"], {}, { key_facts: ["first_name", "last_name", "email", "phone", "job_title", "shoe_size", "ssn"] })],
    ["a long text field as a key fact", "contact", lay(["first_name"], {}, { key_facts: ["bio"] })],
    ["a related list of an object with no relation", "contact", main({ type: "related", object: "widget" })],
    ["zero rows", "contact", main({ type: "tasks", rows: 0 })],
    ["26 rows", "contact", main({ type: "tasks", rows: 26 })],
    ["91 days", "contact", main({ type: "agent_changes", days: 91 })],
    ["a tasks component on the task object", "task", main({ type: "tasks" })],
    ["an unknown key on a component", "contact", main({ type: "timeline", colour: "red" })],
    ["no components at all", "contact", { columns: { left: [], main: [], right: [] } }],
  ];
  for (const [what, object, layout] of cases) {
    it(`refuses ${what} with 422`, async () => {
      const r = await putDraft(ws, { layout, dry_run: true }, object);
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(JSON.stringify(r.json).length).toBeGreaterThan(10);
      expect((await getDraft(ws, object)).json.data.has_draft).toBe(false);
    });
  }
});

describe("related lists", () => {
  it("accepts a deal list on an account, naming the relation field, and asks for field when it is ambiguous", async () => {
    const ws = await fresh("Related", false);
    const lists = (extra: Record<string, unknown>) => ({ columns: { main: [{ type: "timeline" }, { type: "related", object: "deal", ...extra }] } });
    const plain = await putDraft(ws, { layout: lists({}), dry_run: true }, "account");
    const named = await putDraft(ws, { layout: lists({ field: "account" }), dry_run: true }, "account");
    const wrong = await putDraft(ws, { layout: lists({ field: "no_such_relation" }), dry_run: true }, "account");
    expect(wrong.status).toBe(422);
    expect(named.status, JSON.stringify(named.json)).toBe(200);
    const stored = named.json.data.layout.columns.main[1];
    expect(stored).toMatchObject({ id: "deal_list", type: "related", object: "deal", field: "account", rows: 5 });
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    expect(plain.json.data.layout.columns.main[1]).toMatchObject({ object: "deal", field: "account" });
    // Once a second relation from deal points at account, the server asks which one.
    const second = await call("POST", "/v1/objects/deal/fields", { key: admin(ws), body: { api_name: "partner_account", type: "relation", options: { to: "account" } } });
    expect(second.status, JSON.stringify(second.json)).toBe(201);
    const ambiguous = await putDraft(ws, { layout: lists({}), dry_run: true }, "account");
    expect(ambiguous.status).toBe(422);
    expect(JSON.stringify(ambiguous.json)).toMatch(/account or partner_account|partner_account or account/);
    const chosen = await putDraft(ws, { layout: lists({ field: "partner_account" }), dry_run: true }, "account");
    expect(chosen.status, JSON.stringify(chosen.json)).toBe(200);
    expect(chosen.json.data.layout.columns.main[1]).toMatchObject({ object: "deal", field: "partner_account" });
  });
});

describe("warnings", () => {
  it("warns about a restricted field in a section, and the write still succeeds", async () => {
    const ws = await fresh("Warnings");
    const r = await putDraft(ws, { layout: lay(["first_name", "ssn"]) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.saved).toBe(true);
    expect(r.json.data.warnings).toHaveLength(1);
    expect(r.json.data.warnings[0]).toMatch(/ssn/i);
    expect(r.json.data.warnings[0]).toMatch(/restricted/);
    expect((await getDraft(ws)).json.data.layout.columns.left[0].fields).toEqual(["first_name", "ssn"]);
  });
});

describe("renaming and archiving fields", () => {
  it("keeps a renamed field's place in the draft and in a published version, and drops an archived one", async () => {
    const ws = await fresh("Rename");
    await putLayout(ws, lay(["first_name", "shoe_size"]));
    await putDraft(ws, { layout: lay(["shoe_size", "email"]) });
    const renamed = await call("PATCH", "/v1/objects/contact/fields/shoe_size", { key: admin(ws), body: { api_name: "boot_size", dry_run: false } });
    expect(renamed.status, JSON.stringify(renamed.json)).toBeLessThan(300);
    expect((await getDraft(ws)).json.data.layout.columns.left[0].fields).toEqual(["boot_size", "email"]);
    expect((await getPublished(ws)).json.data.sections).toEqual([{ title: "Who", fields: ["first_name", "boot_size"] }]);
    const v1 = await call("GET", `${base("contact")}/versions/1`, { key: admin(ws) });
    expect(v1.json.data.layout.columns.left[0].fields).toEqual(["first_name", "boot_size"]);

    const dry = await call("POST", "/v1/objects/contact/fields/boot_size/archive", { key: admin(ws), body: { dry_run: true } });
    const archived = await call("POST", "/v1/objects/contact/fields/boot_size/archive", { key: admin(ws), body: { dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(archived.status, JSON.stringify(archived.json)).toBeLessThan(300);
    expect((await getDraft(ws)).json.data.layout.columns.left[0].fields).toEqual(["email"]);
    expect((await getPublished(ws)).json.data.sections).toEqual([{ title: "Who", fields: ["first_name"] }]);
    expect((await call("GET", `${base("contact")}/versions/1`, { key: admin(ws) })).json.data.layout.columns.left[0].fields).toEqual(["first_name"]);
  });
});

describe("permissions", () => {
  it("refuses every draft, publish, history, restore, undo and review route without schema:manage", async () => {
    const ws = await fresh("Permissions", false);
    await putLayout(ws, lay(["first_name"]));
    const member = await memberWithKey(ws, "member", ["ops:write"]);
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    const fakeChange = encodeId("lch", randomUUID());
    const b = base("contact");
    const routes: [string, string, unknown?][] = [
      ["GET", `${b}/draft`],
      ["PUT", `${b}/draft`, { layout: lay(["email"]) }],
      ["DELETE", `${b}/draft`],
      ["POST", `${b}/draft/undo`, { change: fakeChange }],
      ["POST", `${b}/draft/review`, { change: fakeChange }],
      ["POST", `${b}/publish`, {}],
      ["GET", `${b}/versions`],
      ["GET", `${b}/versions/1`],
      ["POST", `${b}/restore`, { version: 1 }],
    ];
    for (const [method, path, body] of routes) {
      for (const [who, key] of [["a member without schema:manage", member.key], ["the ops key", ws.keys.ops]] as const) {
        const r = await call(method, path, { key, body });
        expect(r.status, `${method} ${path} as ${who}: ${JSON.stringify(r.json)}`).toBe(403);
      }
    }
    expect((await getDraft(ws)).json.data.has_draft).toBe(false);
    for (const key of [reader.key, ws.keys.ops, member.key]) {
      const r = await getPublished(ws, "contact", key);
      expect(r.status).toBe(200);
      expect(r.json.data).toMatchObject({ custom: true, version: 1 });
    }
  });
});

describe("audit log", () => {
  it("records draft changes, publishing and discarding", async () => {
    const ws = await fresh("Audit", false);
    await putDraft(ws, { layout: lay(["first_name"]) });
    await publish(ws);
    await putDraft(ws, { layout: lay(["email"]) });
    await call("DELETE", `${base("contact")}/draft`, { key: admin(ws) });
    const r = await call("GET", "/v1/audit-log?action=page_layout.", { key: admin(ws) });
    expect(r.status).toBe(200);
    const actions = (r.json.data as { action: string }[]).map((e) => e.action);
    expect(actions.filter((a) => a === "page_layout.draft_changed")).toHaveLength(2);
    expect(actions).toContain("page_layout.published");
    expect(actions).toContain("page_layout.draft_discarded");
  });
});

describe("schema as code", () => {
  type Doc = { schema_version: number; objects: { name: string; layout?: Json; [k: string]: unknown }[] };
  const pull = async (ws: Workspace) => {
    const r = await call("GET", "/v1/schema/export", { key: admin(ws) });
    expect(r.status).toBe(200);
    return r.json as Doc;
  };
  const objectOf = (doc: Doc, name: string) => doc.objects.find((o) => o.name === name)!;
  const plan = (ws: Workspace, document: unknown) => call("POST", "/v1/schema/plan", { key: admin(ws), body: { document } });
  const apply = (ws: Workspace, document: Doc, headers: Record<string, string> = {}) =>
    call("POST", "/v1/schema/apply", { key: admin(ws), body: { document }, headers: { "If-Match": `"${document.schema_version}"`, ...headers } });

  it("exports the published layout and omits it for the default page", async () => {
    const ws = await fresh("Export", false);
    const before = await pull(ws);
    expect("layout" in objectOf(before, "contact")).toBe(false);
    await putLayout(ws, lay(["first_name"]));
    const after = await pull(ws);
    expect(objectOf(after, "contact").layout).toEqual((await getPublished(ws)).json.data.layout);
    expect("layout" in objectOf(after, "deal")).toBe(false);
  });

  it("plans and applies a changed layout through the cli surface, resets on null and leaves a missing key alone", async () => {
    const ws = await fresh("Apply", false);
    await putLayout(ws, lay(["first_name"]));
    const doc = await pull(ws);
    const edited = structuredClone(doc);
    objectOf(edited, "contact").layout.columns.left[0].fields.push("email");

    const planned = await plan(ws, edited);
    expect(planned.status, JSON.stringify(planned.json)).toBe(200);
    const change = (planned.json.changes as Json[]).find((c) => c.change === "layout_published");
    expect(change, JSON.stringify(planned.json)).toMatchObject({ object: "contact" });
    expect((await getPublished(ws)).json.data.version).toBe(1);

    const applied = await apply(ws, edited, CLI);
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.applied).toBe(true);
    expect((await getPublished(ws)).json.data).toMatchObject({ version: 2, sections: [{ title: "Who", fields: ["first_name", "email"] }] });
    const list = (await versions(ws)).json.data as Json[];
    expect(list[0]).toMatchObject({ version: 2, source: { surface: "cli" } });
    expect(list[1].source.surface).toBe("api");

    // A document without the key leaves the layout alone.
    const keep = await pull(ws);
    delete objectOf(keep, "contact").layout;
    const keepPlan = await plan(ws, keep);
    expect((keepPlan.json.changes as Json[]).some((c) => c.change === "layout_reset" || c.change === "layout_published")).toBe(false);
    await apply(ws, keep, CLI);
    expect((await getPublished(ws)).json.data).toMatchObject({ custom: true, version: 2 });

    // layout: null resets it to the default page.
    const reset = await pull(ws);
    objectOf(reset, "contact").layout = null;
    const resetPlan = await plan(ws, reset);
    expect((resetPlan.json.changes as Json[]).some((c) => c.change === "layout_reset" && c.object === "contact")).toBe(true);
    const resetApply = await apply(ws, reset, CLI);
    expect(resetApply.status, JSON.stringify(resetApply.json)).toBe(200);
    expect((await getPublished(ws)).json.data).toMatchObject({ custom: false, version: 3 });
    expect((await versions(ws)).json.data[0]).toMatchObject({ version: 3, default_page: true, source: { surface: "cli" } });
  });
});
