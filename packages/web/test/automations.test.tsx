import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { buildBody, draftFromJson, draftJson, draftOf, maskSecrets, restoreSecrets, shownStatus, textToValue, valueToText } from "@/features/settings/automations/model";
import { formatDuration } from "@/features/settings/automations/RunsTab";
import type { Automation, AutomationRun } from "@/lib/api/types";
import { renderRoute, SESSION, type Call, type Handler } from "./utils";

const OWNER = { ...SESSION, permissions: [...SESSION.permissions, "automations:manage", "webhooks:manage", "connections:manage"] };
const LIMITED = { ...SESSION, role: "field_limited", permissions: ["records:read", "records:write"] };
// The debounce before a dry run is real time, so waits are generous.
const SLOW = { timeout: 4000 };

const OBJECTS = ["contact", "deal", "account"].map((name) => ({
  name, label: name[0]!.toUpperCase() + name.slice(1), plural_label: `${name}s`, id_prefix: name.slice(0, 3), standard: true, owned: false, field_count: 3,
  access: { read: true, write: true, archive: true },
}));

const auto = (id: string, over: Partial<Automation> = {}): Automation => ({
  id, name: `Auto ${id}`, description: null, enabled: true, status: "enabled", consecutive_failures: 0, paused_reason: null, next_run_at: null,
  trigger: { type: "event", event: "deal.created" }, condition: null,
  actions: [{ type: "notify", title: "Big deal", recipients: { record_owner: true } }], hourly_cap: 100, run_roles: [], version: 1, ...over,
});

const written = (a: Automation, dry: boolean, extra: Record<string, unknown> = {}) => ({
  dry_run: dry, summary: "SERVER SUMMARY: tells the owner when a deal is created.", warnings: ["SERVER WARNING: sends data out"], automation: a, ...extra,
});

/** Answers the automation routes from `state`; `more` answers first. */
function server(state: { list?: Automation[]; runs?: AutomationRun[]; one?: Automation }, more: Handler = () => undefined): Handler {
  return (c: Call) => {
    const r = more(c);
    if (r) return r;
    if (c.path === "/v1/automations" && c.method === "GET") return { body: { data: state.list ?? [] } };
    if (c.path === "/v1/automation-settings") return { body: { data: { paused: false, paused_at: null, paused_reason: null, external_email: false, timezone: "UTC" } } };
    if (c.path === "/v1/webhooks" || c.path === "/v1/connections") return { body: { data: [] } };
    const m = /^\/v1\/automations\/([^/]+)(\/runs)?$/.exec(c.path);
    if (m && m[2] && c.method === "GET") return { body: { data: state.runs ?? [] } };
    if (m && c.method === "GET") return { body: { data: state.one ?? state.list?.find((a) => a.id === m[1]) } };
    if (m && c.method === "PATCH") return { body: written(state.one ?? auto(m[1]!), (c.body as { dry_run?: boolean }).dry_run === true) };
    return undefined;
  };
}

const run = (id: string, over: Partial<AutomationRun> = {}): AutomationRun => ({
  id, trigger: "event", status: "succeeded", reason: null, started_at: "2026-11-25T10:00:00Z", finished_at: "2026-11-25T10:00:01.500Z", record_id: null, results: [], ...over,
});

describe("Automations: list", () => {
  it("counts and filters from the real list", async () => {
    const list = [
      auto("auto_a"), auto("auto_b", { consecutive_failures: 2 }), auto("auto_c", { status: "paused", paused_reason: "Too many failures", consecutive_failures: 5 }),
      auto("auto_d", { status: "archived" }),
    ];
    renderRoute("/settings/automations", server({ list }), { session: OWNER });
    const group = await screen.findByRole("group", { name: "Filter automations" });
    expect(within(group).getByRole("button", { name: "All 3" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Active 2" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Failing 1" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Paused 1" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Automations" });
    expect(within(table).getAllByRole("link").map((l) => l.textContent)).toEqual(["Auto auto_a", "Auto auto_b", "Auto auto_c"]);
    expect(within(table).getByText("2 failed in a row")).toBeInTheDocument();
    expect(within(table).getAllByText("When a deal is created (deal.created)")).toHaveLength(3);
    await userEvent.click(within(group).getByRole("button", { name: "Failing 1" }));
    expect(within(table).getAllByRole("link").map((l) => l.textContent)).toEqual(["Auto auto_b"]);
    await userEvent.click(within(group).getByRole("button", { name: "Paused 1" }));
    expect(within(table).getAllByRole("link").map((l) => l.textContent)).toEqual(["Auto auto_c"]);
    expect(within(table).getByText("Too many failures")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new automation/i })).toHaveAttribute("href", "/settings/automations/new");
    expect(screen.getByRole("link", { name: "Auto auto_c" })).toHaveAttribute("href", "/settings/automations/auto_c");
  });

  it("shows the last run and the next run only where the API gives them", async () => {
    const list = [auto("auto_a", { next_run_at: new Date(Date.now() + 3 * 3_600_000).toISOString() }), auto("auto_b")];
    renderRoute("/settings/automations", server({ list }, (c) => {
      if (c.path === "/v1/automations/auto_a/runs") return { body: { data: [run("run_1", { status: "failed", failure: "target" })] } };
      return undefined;
    }), { session: OWNER });
    const table = await screen.findByRole("table", { name: "Automations" });
    expect(await within(table).findByText("failed")).toBeInTheDocument();
    expect(await within(table).findByText("Never run")).toBeInTheDocument();
    expect(within(table).getByText("in 3 hours")).toBeInTheDocument();
    expect(within(table).getByText("None")).toBeInTheDocument();
  });

  it.each(["/settings/automations", "/settings/automations/new", "/settings/automations/auto_1"])("without automations:manage %s is a no-access page and sends no automation request", async (path) => {
    const { calls } = renderRoute(path, () => undefined, { session: LIMITED });
    expect(await screen.findByText("You don't have access to automations")).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/v1/automations"))).toBe(false);
  });
});

describe("Automations: creating", () => {
  const create: Handler = (c) => {
    if (c.path === "/v1/automations" && c.method === "POST") {
      const dry = (c.body as { dry_run?: boolean }).dry_run === true;
      return dry ? { body: written(auto("auto_9"), true, { next_runs: [] }) } : { status: 201, body: written(auto("auto_9", { name: "Tell the owner" }), false) };
    }
    return undefined;
  };

  it("sends a dry run first, shows the server's summary and warnings, then saves the same request", async () => {
    const { calls } = renderRoute("/settings/automations/new", server({ list: [], one: auto("auto_9", { name: "Tell the owner" }) }, create), { session: OWNER, objects: OBJECTS });
    const save = await screen.findByRole("button", { name: "Create automation" });
    expect(save).toBeDisabled();
    expect(screen.getAllByText(/at least one step/i).length).toBeGreaterThan(0);
    await userEvent.type(screen.getByRole("textbox", { name: /^Name/ }), "Tell the owner");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of step" }), "notify");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.type(screen.getByRole("textbox", { name: /^Title/ }), "Big deal");
    expect(save).toBeDisabled(); // the server hasn't said yes to this version yet

    expect(await screen.findByText(/SERVER SUMMARY/, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText(/SERVER WARNING/)).toBeInTheDocument();
    expect(screen.getByText(/create_automation/)).toBeInTheDocument(); // the agent route, in words
    await waitFor(() => expect(save).toBeEnabled());
    const posts = () => calls.filter((c) => c.method === "POST" && c.path === "/v1/automations");
    expect(posts().length).toBeGreaterThan(0);
    for (const p of posts()) expect(p.body).toMatchObject({ dry_run: true });
    expect(posts().at(-1)!.body).toMatchObject({
      name: "Tell the owner", trigger: { type: "event", event: "contact.created" }, actions: [{ type: "notify", title: "Big deal", recipients: { record_owner: true } }],
    });

    await userEvent.click(save);
    // Saved: the automation's own page opens.
    expect(await screen.findByRole("heading", { name: /Tell the owner/ })).toBeInTheDocument();
    const last = posts().at(-1)!;
    expect(last.body).not.toHaveProperty("dry_run");
    expect(last.body).toMatchObject({ name: "Tell the owner", actions: [{ type: "notify", title: "Big deal" }] });
  });

  it("shows a 422 beside the form and on the step it names, and won't save it", async () => {
    renderRoute("/settings/automations/new", server({ list: [] }, (c) => {
      if (c.path === "/v1/automations" && c.method === "POST") {
        return { status: 422, body: { code: "validation_failed", status: 422, detail: "The automation is not valid", errors: [{ path: "actions.0.title", message: "Required" }, { path: "trigger.event", message: "Unknown event" }] } };
      }
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    await userEvent.type(await screen.findByRole("textbox", { name: /^Name/ }), "Broken");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of step" }), "notify");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(await screen.findByText("The server refused this version", undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByText("actions.0.title: Required")).toBeInTheDocument(); // on the step
    // Beside the form, for an error that names no step.
    expect(screen.getByText((_, el) => el?.tagName === "LI" && el.textContent === "trigger.event: Unknown event")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create automation" })).toBeDisabled();
  });

  it("changes the body sent when steps are moved or removed", async () => {
    const { calls } = renderRoute("/settings/automations/new", server({ list: [] }, create), { session: OWNER, objects: OBJECTS });
    await userEvent.type(await screen.findByRole("textbox", { name: /^Name/ }), "Order");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of step" }), "notify");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of step" }), "stop");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    const types = () => (calls.filter((c) => c.method === "POST").at(-1)?.body as { actions: { type: string }[] } | undefined)?.actions.map((a) => a.type);
    await waitFor(() => expect(types()).toEqual(["notify", "stop"]), SLOW);
    expect(screen.getByRole("button", { name: "Move step 1 up" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    await waitFor(() => expect(types()).toEqual(["stop", "notify"]), SLOW);
    await userEvent.click(screen.getByRole("button", { name: "Remove step 1" }));
    await waitFor(() => expect(types()).toEqual(["notify"]), SLOW);
  });

  it("round-trips through the whole-automation JSON view", async () => {
    renderRoute("/settings/automations/new", server({ list: [] }, create), { session: OWNER, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("switch", { name: "Edit the whole automation as JSON" }));
    const box = screen.getByRole("textbox", { name: "Automation as JSON" });
    expect(JSON.parse((box as HTMLTextAreaElement).value)).toMatchObject({ name: "", trigger: { type: "event", event: "contact.created" }, actions: [] });
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste(JSON.stringify({
      name: "From JSON", trigger: { type: "schedule", daily: { at: "08:30" }, timezone: "Europe/Berlin" },
      actions: [{ type: "stop", reason: "nothing to do" }], hourly_cap: 20,
    }));
    await userEvent.click(screen.getByRole("switch", { name: "Edit the whole automation as JSON" }));
    expect(screen.getByRole("textbox", { name: /^Name/ })).toHaveValue("From JSON");
    expect(screen.getByRole("combobox", { name: "Starts" })).toHaveValue("schedule");
    expect(screen.getByLabelText("At (24-hour time)")).toHaveValue("08:30");
    expect(screen.getByRole("textbox", { name: "Time zone" })).toHaveValue("Europe/Berlin");
    expect(screen.getByRole("spinbutton", { name: /^Runs at most per hour/ })).toHaveValue(20);
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("nothing to do");
  });

  it("says when the whole-automation JSON can't be read", async () => {
    renderRoute("/settings/automations/new", server({ list: [] }, create), { session: OWNER, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("switch", { name: "Edit the whole automation as JSON" }));
    const box = screen.getByRole("textbox", { name: "Automation as JSON" });
    await userEvent.clear(box);
    await userEvent.click(box);
    await userEvent.paste("{ nope");
    expect(await screen.findByText(/Not valid JSON/)).toBeInTheDocument();
  });
});

describe("Automations: one automation", () => {
  it("keeps secret header values write-only: (set) for null, null sent back, a typed value never echoed", async () => {
    const hook = auto("auto_1", {
      actions: [{ type: "http_request", id: "push", method: "POST", url: "https://api.example.com/contacts", secret_headers: { Authorization: null }, body: { a: 1 } }],
    });
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: hook }), { session: OWNER, objects: OBJECTS });
    expect(await screen.findByText("(set)")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Secret header value/)).not.toBeInTheDocument();
    const patches = () => calls.filter((c) => c.method === "PATCH");
    await waitFor(() => expect(patches().length).toBeGreaterThan(0), SLOW);
    expect(patches().at(-1)!.body).toMatchObject({ dry_run: true, actions: [{ id: "push", secret_headers: { Authorization: null } }] });

    // Changing something else saves the null: the server keeps the stored value.
    await userEvent.type(screen.getByRole("textbox", { name: /^Description/ }), "x");
    const save = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(save).toBeEnabled(), SLOW);
    await userEvent.click(save);
    await waitFor(() => expect(patches().some((c) => !(c.body as { dry_run?: boolean }).dry_run)).toBe(true));
    expect(patches().find((c) => !(c.body as { dry_run?: boolean }).dry_run)!.body).toMatchObject({ actions: [{ secret_headers: { Authorization: null } }] });

    // A new value is sent, and shows up in no text and no JSON view.
    await userEvent.click(await screen.findByRole("button", { name: "Replace secret header 1" }));
    await userEvent.type(screen.getByLabelText("Secret header value 1"), "TOPSECRET-123");
    expect(screen.getByLabelText("Secret header value 1")).toHaveAttribute("type", "password");
    await waitFor(() => expect(patches().at(-1)!.body).toMatchObject({ actions: [{ secret_headers: { Authorization: "TOPSECRET-123" } }] }), SLOW);
    await userEvent.click(screen.getByRole("switch", { name: "Edit step 1 as JSON" }));
    const json = (screen.getByRole("textbox", { name: "Step 1 as JSON" }) as HTMLTextAreaElement).value;
    expect(JSON.parse(json).secret_headers).toEqual({ Authorization: null });
    expect(document.body.textContent).not.toContain("TOPSECRET-123");
    expect(json).not.toContain("TOPSECRET-123");
  });

  it("tests the saved automation against a record and shows what the server returned", async () => {
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: auto("auto_1") }, (c) => {
      if (c.path === "/v1/automations/auto_1/test") {
        return { body: { data: {
          matched: true, explanation: "The record matches. These steps would run (nothing was changed or sent).", stopped: "nothing more to do",
          actions: [{ step: "1", action: "notify", ok: true, detail: { title: "Big deal", recipients: 1 } }, { step: "2", action: "send_email", ok: false, skipped: "no recipient address", detail: {} }],
        } } };
      }
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    const run = await screen.findByRole("button", { name: "Run test" });
    expect(screen.getByText(/Nothing is sent/)).toBeInTheDocument();
    expect(run).toBeDisabled(); // a record trigger needs a record
    await userEvent.type(screen.getByRole("textbox", { name: "Record ID" }), "dea_123");
    await userEvent.click(run);
    const result = await screen.findByRole("status", { name: "Test result" });
    expect(within(result).getByText("Matched")).toBeInTheDocument();
    expect(within(result).getByText(/These steps would run/)).toBeInTheDocument();
    expect(within(result).getByText(/nothing more to do/)).toBeInTheDocument();
    expect(within(result).getByText("notify")).toBeInTheDocument();
    expect(within(result).getByText("no recipient address")).toBeInTheDocument();
    expect(within(result).getByText(/"title": "Big deal"/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/automations/auto_1/test")!.body).toEqual({ record: "dea_123" });
  });

  it("tests a draft through /v1/automations/test, with no record for a schedule", async () => {
    const { calls } = renderRoute("/settings/automations/new", server({ list: [] }, (c) => {
      if (c.path === "/v1/automations/test") return { body: { data: { matched: true, explanation: "A step would fail: nope", actions: [], error: "nope" } } };
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    await userEvent.type(await screen.findByRole("textbox", { name: /^Name/ }), "Nightly");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Starts" }), "schedule");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Kind of step" }), "stop");
    await userEvent.click(screen.getByRole("button", { name: "Add step" }));
    expect(screen.queryByRole("textbox", { name: "Record ID" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText("Would fail")).toBeInTheDocument();
    const post = calls.find((c) => c.path === "/v1/automations/test")!;
    expect(post.body).toMatchObject({ automation: { name: "Nightly", trigger: { type: "schedule", daily: { at: "09:00" } } } });
    expect(post.body).not.toHaveProperty("record");
  });

  it("pauses and resumes with the Active switch, and archives after a confirmation", async () => {
    const list = auto("auto_1");
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: list }, (c) => {
      if (c.path === "/v1/automations/auto_1/pause") return { body: { data: { ...list, status: "paused" } } };
      if (c.path === "/v1/automations/auto_1" && c.method === "DELETE") return { body: { data: { ...list, status: "archived" } } };
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    const sw = await screen.findByRole("switch", { name: "Active" });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/automations/auto_1/pause" && c.method === "POST")).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: /Archive…/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive automation" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/v1/automations/auto_1")).toBe(true));
  });

  it("runs now on a record the person names, and lists the queued run IDs", async () => {
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: auto("auto_1") }, (c) => {
      if (c.path === "/v1/automations/auto_1/run") return { status: 202, body: { data: { automation: "auto_1", runs: [{ id: "run_QUEUED1", record: "dea_123", status: "queued" }], poll: "/v1/automations/auto_1/runs" } } };
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    const dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Run now" });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Record ID/ }), "dea_123");
    await userEvent.click(go);
    expect(await within(dialog).findByText("run_QUEUED1")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/automations/auto_1/run")!.body).toEqual({ records: ["dea_123"] });
  });

  it("runs a schedule now without a record", async () => {
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: auto("auto_1", { trigger: { type: "schedule", daily: { at: "09:00" } } }) }, (c) => {
      if (c.path === "/v1/automations/auto_1/run") return { status: 202, body: { data: { automation: "auto_1", runs: [{ id: "run_S1", record: null, status: "queued" }], poll: "" } } };
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("button", { name: "Run now" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Run now" }));
    expect(await within(dialog).findByText("run_S1")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/v1/automations/auto_1/run")!.body).toEqual({});
  });

  it("shows runs with their step log, filters by status, and runs failed records again", async () => {
    const runs = [
      run("run_1", { status: "failed", failure: "target", reason: "HTTP 502", record_id: "con_AAA", results: [{ step: "1", action: "http_request", ok: false, detail: { status: 502, error: "bad gateway" } }] }),
      run("run_2", { status: "failed", failure: "config", reason: "no key", record_id: "con_BBB" }),
      run("run_3", { status: "succeeded", record_id: "con_CCC" }),
      run("run_4", { status: "failed", trigger: "schedule" }),
      run("run_5", { status: "skipped", cap: "hourly", reason: "over the cap", finished_at: null }),
    ];
    const { calls } = renderRoute("/settings/automations/auto_1", server({ one: auto("auto_1"), runs }, (c) => {
      if (c.path === "/v1/automations/auto_1/run") return { status: 202, body: { data: { automation: "auto_1", runs: [{ id: "run_N1", record: "con_AAA", status: "queued" }, { id: "run_N2", record: "con_BBB", status: "queued" }], poll: "" } } };
      return undefined;
    }), { session: OWNER, objects: OBJECTS });
    await userEvent.click(await screen.findByRole("tab", { name: "Runs" }));
    const table = await screen.findByRole("table", { name: "Runs of this automation" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getAllByText("1.5 s").length).toBe(4);
    expect(within(table).getByText("HTTP 502 · failure: target")).toBeInTheDocument();
    expect(within(table).getByText("over the cap · cap: hourly")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "con_AAA" })).toHaveAttribute("href", "/o/contact/con_AAA");
    // Only failed runs on a record can be picked.
    expect(within(table).getAllByRole("checkbox")).toHaveLength(2);

    await userEvent.click(within(table).getByRole("button", { name: "Show steps of run run_1" }));
    const log = screen.getByRole("list", { name: "Step log of run run_1" });
    expect(within(log).getByText("http_request")).toBeInTheDocument();
    expect(within(log).getByText(/"error": "bad gateway"/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Status" }), "failed");
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/automations/auto_1/runs" && c.query.get("status") === "failed")).toBe(true));

    const again = screen.getByRole("button", { name: /Run again for these records/ });
    expect(again).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Select run run_1" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select run run_2" }));
    expect(again).toHaveTextContent("Run again for these records (2)");
    await userEvent.click(again);
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/not a retry of the failed runs/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Run again" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/v1/automations/auto_1/run")).toBe(true));
    expect(calls.find((c) => c.path === "/v1/automations/auto_1/run")!.body).toEqual({ records: ["con_AAA", "con_BBB"] });
  });
});

describe("Automations: the model", () => {
  it("names the shown state from the API's status and failure count", () => {
    expect(shownStatus({ status: "enabled", consecutive_failures: 0 })).toBe("active");
    expect(shownStatus({ status: "enabled", consecutive_failures: 1 })).toBe("failing");
    expect(shownStatus({ status: "paused", consecutive_failures: 5 })).toBe("paused");
    expect(shownStatus({ status: "disabled" })).toBe("off");
  });

  it("builds the request body, clearing an emptied condition only on a change", () => {
    const d = draftOf(auto("auto_1", { condition: { field: "amount", op: "gt", value: 1 } }));
    expect(buildBody(d, true).body).toMatchObject({ name: "Auto auto_1", condition: { field: "amount", op: "gt", value: 1 }, hourly_cap: 100 });
    expect(buildBody({ ...d, condition: "" }, true).body).toHaveProperty("condition", null);
    expect(buildBody({ ...d, condition: "" }, false).body).not.toHaveProperty("condition");
    const bad = buildBody({ ...d, condition: "{ nope" }, false);
    expect(bad.body).toBeNull();
    expect(bad.problems[0]).toMatch(/not valid JSON/);
    expect(buildBody({ ...d, steps: [] }, false).complete).toBe(false);
  });

  it("reads and writes an automation as JSON without changing it", () => {
    const d = draftOf(auto("auto_1", { description: "d", condition: { field: "a", op: "eq", value: 1 } }));
    const back = draftFromJson(draftJson(d), d);
    expect("draft" in back && buildBody(back.draft, true).body).toEqual(buildBody(d, true).body);
    expect(draftFromJson("[]", d)).toHaveProperty("error");
    expect(draftFromJson('{"name": 3, "trigger": {}}', d)).toHaveProperty("error");
  });

  it("hides secret header values in JSON and restores a typed one", () => {
    const step = { type: "http_request", secret_headers: { A: "typed", B: null } };
    expect(maskSecrets(step).secret_headers).toEqual({ A: null, B: null });
    expect(restoreSecrets({ type: "http_request", secret_headers: { A: null, B: null } }, step).secret_headers).toEqual({ A: "typed", B: null });
    expect(restoreSecrets({ type: "http_request", secret_headers: { A: "new" } }, step).secret_headers).toEqual({ A: "new" });
  });

  it("types values as text and reads them back", () => {
    expect(textToValue("5")).toBe(5);
    expect(textToValue("true")).toBe(true);
    expect(textToValue("hello {{record.name}}")).toBe("hello {{record.name}}");
    expect(textToValue('"5"')).toBe("5");
    for (const v of ["5", "abc", "true", 7, false, null, { a: 1 }, ["x"], "{{record.id}}"]) expect(textToValue(valueToText(v))).toEqual(v);
    expect(valueToText("5")).toBe('"5"');
  });

  it("measures a run's duration", () => {
    expect(formatDuration("2026-11-25T10:00:00Z", "2026-11-25T10:00:00.250Z")).toBe("250 ms");
    expect(formatDuration("2026-11-25T10:00:00Z", "2026-11-25T10:01:30Z")).toBe("1 min 30 s");
    expect(formatDuration("2026-11-25T10:00:00Z", null)).toBe("");
  });
});
