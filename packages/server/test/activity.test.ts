import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { runQueuedOnce } from "../src/core/automation-runner.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/**
 * Who and what is changing the workspace: the app or key behind an event, the events list narrowed to
 * "mine, by agents, since", and the two summaries an admin's Home reads (activity per key, automation runs).
 */

interface Ev { id: string; type: string; record_id: string | null; actor: { type: string; id: string | null; surface: string; via?: string | null } }
let ws: Workspace;
let opsKeyName: string;
const events = async (key: string, query: string) => {
  const r = await call("GET", `/v1/events${query}`, { key });
  if (r.status !== 200) throw new Error(`${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as Ev[];
};
const mcp = { "x-hlcrm-surface": "ops-mcp" };

beforeEach(() => resetRateLimiter());
beforeAll(async () => {
  ws = await newWorkspace("Activity");
  const keys = (await call("GET", "/v1/api-keys", { key: ws.keys.admin })).json.data as { name: string; scopes: string[] }[];
  opsKeyName = keys.find((k) => !k.scopes.includes("admin"))!.name;
});

describe("the source of an event", () => {
  it("names the key a change came through, to the member it acted for and to audit readers only", async () => {
    const c = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, headers: mcp, body: { first_name: "Via", email: `via-${Date.now()}@example.com` } });
    expect(c.status).toBe(201);
    // The owner's own key: the name is shown (their own event, and they read the audit log too).
    const [mine] = await events(ws.keys.ops, `?record=${c.json.data.id}`);
    expect(mine!.actor).toMatchObject({ surface: "ops-mcp", via: opsKeyName });
    expect(mine!.actor.id).toBe(ws.ownerId);
    // Another member who can read the record sees the surface, not the name of someone else's key.
    const other = await memberWithKey(ws, "member", ["ops:read"]);
    const [theirs] = await events(other.key, `?record=${c.json.data.id}`);
    expect(theirs!.actor.surface).toBe("ops-mcp");
    expect(theirs!.actor).not.toHaveProperty("via");
    expect(JSON.stringify(theirs)).not.toContain(opsKeyName);
  });

  it("narrows the list to my own changes, to changes by agents, and to a time", async () => {
    const m = await memberWithKey(ws, "member", ["ops:write"]);
    const start = new Date(Date.now() - 1000).toISOString();
    const byMember = await create(m.key, "contact", { first_name: "Theirs", email: `theirs-${Date.now()}@example.com` });
    const byOwnerCli = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, headers: { "x-hlcrm-surface": "cli" }, body: { first_name: "Cli", email: `cli-${Date.now()}@example.com` } });
    expect(byOwnerCli.status).toBe(201);

    const mine = await events(m.key, "?actor=me&limit=200");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.actor.id === m.id)).toBe(true);
    expect(mine.map((e) => e.record_id)).toContain(byMember.id);
    expect(mine.map((e) => e.record_id)).not.toContain(byOwnerCli.json.data.id);

    const byId = await events(ws.keys.admin, `?actor=${m.id}&limit=200`);
    expect(byId.every((e) => e.actor.id === m.id)).toBe(true);

    const agents = await events(ws.keys.admin, "?surface=agents&limit=200");
    expect(agents.every((e) => ["api", "cli", "admin-mcp", "ops-mcp"].includes(e.actor.surface))).toBe(true);
    const cliOnly = await events(ws.keys.admin, "?surface=cli&limit=200");
    expect(cliOnly.map((e) => e.record_id)).toContain(byOwnerCli.json.data.id);
    expect(cliOnly.every((e) => e.actor.surface === "cli")).toBe(true);

    const recent = await events(ws.keys.admin, `?since=${encodeURIComponent(start)}&limit=200`);
    expect(recent.map((e) => e.record_id)).toEqual(expect.arrayContaining([byMember.id, byOwnerCli.json.data.id]));
    expect(await events(ws.keys.admin, `?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual([]);

    expect((await call("GET", "/v1/events?actor=nonsense", { key: ws.keys.admin })).status).toBe(400);
    expect((await call("GET", "/v1/events?since=yesterday", { key: ws.keys.admin })).status).toBe(400);
    expect((await call("GET", "/v1/events?surface=fax", { key: ws.keys.admin })).status).toBe(422);
  });
});

describe("GET /v1/events/summary", () => {
  it("counts changes per member, surface and key, for audit readers only", async () => {
    const fresh = await newWorkspace("Activity summary");
    const keys = (await call("GET", "/v1/api-keys", { key: fresh.keys.admin })).json.data as { name: string; scopes: string[] }[];
    const ops = keys.find((k) => !k.scopes.includes("admin"))!.name;
    const a = await call("POST", "/v1/objects/contact/records", { key: fresh.keys.ops, headers: mcp, body: { first_name: "A", email: `a-${Date.now()}@example.com` } });
    await call("PATCH", `/v1/objects/contact/records/${a.json.data.id}`, { key: fresh.keys.ops, headers: mcp, body: { job_title: "x" } });
    await call("POST", "/v1/objects/contact/records", { key: fresh.keys.ops, headers: mcp, body: { first_name: "B", email: `b-${Date.now()}@example.com` } });
    await call("POST", "/v1/objects/contact/records", { key: fresh.keys.ops, headers: { "x-hlcrm-surface": "cli" }, body: { first_name: "C", email: `c-${Date.now()}@example.com` } });

    const r = await call("GET", "/v1/events/summary", { key: fresh.keys.admin });
    expect(r.status).toBe(200);
    const sources = r.json.data.sources as { actor: string; surface: string; via: string | null; changes: number; records: number; last_at: string }[];
    expect(sources.find((s) => s.surface === "ops-mcp")).toMatchObject({ actor: fresh.ownerId, via: ops, changes: 3, records: 2 });
    expect(sources.find((s) => s.surface === "cli")).toMatchObject({ via: ops, changes: 1, records: 1 });
    expect(sources.every((s) => ["api", "cli", "admin-mcp", "ops-mcp"].includes(s.surface))).toBe(true);
    expect(Date.parse(r.json.data.since)).toBeLessThan(Date.now() - 23 * 3_600_000);
    // Busiest first.
    expect(sources[0]!.changes).toBeGreaterThanOrEqual(sources.at(-1)!.changes);

    expect((await call("GET", "/v1/events/summary", { key: fresh.keys.ops })).status).toBe(403);
    expect((await call("GET", "/v1/events/summary?hours=0", { key: fresh.keys.admin })).status).toBe(422);
    expect((await call("GET", "/v1/events/summary?hours=169", { key: fresh.keys.admin })).status).toBe(422);
    // Another workspace's activity is not in it.
    const elsewhere = await call("GET", "/v1/events/summary", { key: ws.keys.admin });
    expect(JSON.stringify(elsewhere.json)).not.toContain(fresh.ownerId);
  });
});

describe("GET /v1/automations/runs/summary", () => {
  it("counts every automation's runs by status and names the newest failure", async () => {
    const fresh = await newWorkspace("Runs summary");
    const make = async (name: string, actions: unknown[]) => {
      const r = await call("POST", "/v1/automations", { key: fresh.keys.admin, body: { name, trigger: { type: "manual", object: "contact" }, actions } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.automation.id as string;
    };
    const good = await make("Sets a title", [{ type: "update_record", values: { job_title: "ran" } }]);
    // Its second step names a record ID that isn't one, so every run of it fails.
    const bad = await make("Fails", [{ type: "find_records", id: "f", object: "contact", limit: 1 }, { type: "update_record", record: "{{steps.f.first.id}}x", object: "contact", values: { job_title: "never" } }]);
    const c = await create(fresh.keys.ops, "contact", { first_name: "Run", email: `run-${Date.now()}@example.com` });
    for (const id of [good, good, bad]) expect((await call("POST", `/v1/automations/${id}/run`, { key: fresh.keys.admin, body: { records: [c.id] } })).status).toBe(202);
    for (let i = 0; i < 30; i++) if ((await processEvents(fresh.tenantId)) + (await runQueuedOnce(fresh.tenantId) ? 1 : 0) === 0) break;

    const r = await call("GET", "/v1/automations/runs/summary", { key: fresh.keys.admin });
    expect(r.status).toBe(200);
    const d = r.json.data as { totals: Record<string, number>; automations: { id: string; name: string; succeeded: number; failed: number; open: number; last_failed_at: string | null; last_failure: string | null }[] };
    expect(d.totals).toMatchObject({ succeeded: 2, failed: 1, queued: 0, running: 0 });
    // The one with a failure comes first.
    expect(d.automations[0]).toMatchObject({ id: bad, name: "Fails", failed: 1, succeeded: 0 });
    expect(d.automations[0]!.last_failed_at).not.toBeNull();
    expect(d.automations[0]!.last_failure).toBeTruthy();
    expect(d.automations.find((x) => x.id === good)).toMatchObject({ succeeded: 2, failed: 0, last_failed_at: null, last_failure: null });

    expect((await call("GET", "/v1/automations/runs/summary", { key: fresh.keys.ops })).status).toBe(403);
    const other = await call("GET", "/v1/automations/runs/summary", { key: ws.keys.admin });
    expect(other.json.data.automations).toEqual([]);
  });
});
