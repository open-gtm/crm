import { beforeAll, describe, expect, it, vi } from "vitest";
import { runQueuedOnce } from "../src/core/automation-runner.js";
import { fillString, parsePlaceholder } from "../src/core/templates.js";
import { processEvents } from "../src/worker/events.js";
import { call, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/**
 * Bringing another system's records in: the single-request upsert it can call, and a scheduled automation
 * that fetches a list and goes through it. The other system is a stand-in for the outbound request (the
 * URL checks stay real), so replies are kept as they are on a deployment without private targets.
 */
interface Sent { url: string; method: string; headers: Record<string, string>; body?: string }
const sent: Sent[] = [];
const replies = new Map<string, { status: number; body: string }>();
vi.mock("../src/lib/outbound.js", async (original) => {
  const real = await original<typeof import("../src/lib/outbound.js")>();
  return { ...real, safeRequest: vi.fn(async (url: string, opts: { method: string; headers?: Record<string, string>; body?: string }, policy: { allowInsecure: boolean }) => {
    real.checkUrl(url, policy);
    sent.push({ url, method: opts.method, headers: opts.headers ?? {}, body: opts.body });
    const r = replies.get(new URL(url).pathname) ?? { status: 404, body: "{}" };
    return { status: r.status, body: r.body, headers: {} };
  }) };
});

async function drain(ws: Workspace) {
  for (let i = 0; i < 30; i++) {
    const n = (await processEvents(ws.tenantId)) + (await runQueuedOnce(ws.tenantId) ? 1 : 0);
    if (n === 0) return;
  }
}
const contacts = async (ws: Workspace) => ((await call("GET", "/v1/objects/contact/records?limit=200&fields=email,first_name,last_name,ext_id", { key: ws.keys.ops })).json.data as Record<string, unknown>[])
  .sort((a, b) => String(a.ext_id).localeCompare(String(b.ext_id)));

describe("POST /v1/objects/{object}/records/upsert", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Upsert");
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "ext_id", type: "text", unique: true } })).status).toBe(201);
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tier", type: "text" } })).status).toBe(201);
  });
  const upsert = (key: string, body: unknown) => call("POST", "/v1/objects/contact/records/upsert", { key, body });

  it("creates, then updates the record with the same key value, then says when nothing changed", async () => {
    const made = await upsert(ws.keys.ops, { key: "ext_id", values: { ext_id: "003A", first_name: "Ada", email: "ada-upsert@example.com" } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ action: "created", data: { ext_id: "003A", first_name: "Ada" } });
    const again = await upsert(ws.keys.ops, { key: "ext_id", values: { ext_id: "003A", first_name: "Ada", last_name: "Lovelace" } });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ action: "updated", data: { id: made.json.data.id, last_name: "Lovelace", email: "ada-upsert@example.com" } });
    const same = await upsert(ws.keys.ops, { key: "ext_id", values: { ext_id: "003A", last_name: "Lovelace" } });
    expect(same.json).toMatchObject({ action: "unchanged", data: { id: made.json.data.id } });
    // A contact's email is unique too, compared as the field compares (case ignored).
    const byEmail = await upsert(ws.keys.ops, { key: "email", values: { email: "ADA-upsert@example.com", tier: "gold" } });
    expect(byEmail.json).toMatchObject({ action: "updated", data: { id: made.json.data.id, tier: "gold" } });
    expect((await contacts(ws)).filter((c) => c.ext_id === "003A")).toHaveLength(1);
  });

  it("refuses a key that isn't unique or has no value, and an unknown field", async () => {
    expect((await upsert(ws.keys.ops, { key: "first_name", values: { first_name: "Ada" } })).status).toBe(422);
    expect((await upsert(ws.keys.ops, { key: "id", values: { id: "con_x" } })).status).toBe(422);
    expect((await upsert(ws.keys.ops, { key: "ext_id", values: { first_name: "No key" } })).status).toBe(422);
    expect((await upsert(ws.keys.ops, { key: "ext_id", values: { ext_id: "003B", nope: 1 } })).status).toBe(422);
    expect((await upsert(ws.keys.ops, { key: "ext_id", values: { ext_id: "003B" }, extra: true })).status).toBe(422);
  });

  it("needs write and read on the object, a readable key and writable fields, checked before anything is matched", async () => {
    const role = async (key: string, rules: Record<string, unknown>) => {
      const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key, name: key, permissions: ["records:read", "records:write"], ...rules } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return (await memberWithKey(ws, key, ["ops:write"])).key;
    };
    const readOnly = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await upsert(readOnly.key, { key: "ext_id", values: { ext_id: "003A", tier: "x" } })).status).toBe(403);
    // The key field hidden from the role: which record matches would tell it a value.
    const noKey = await role("no_ext", { fields: { contact: { ext_id: "none" } } });
    const hiddenKey = await upsert(noKey, { key: "ext_id", values: { ext_id: "003A", tier: "x" } });
    expect(hiddenKey.status).toBe(403);
    // A field it can only read: refused whether or not the value would change, so "unchanged" can't be used to test it.
    const readTier = await role("read_tier", { fields: { contact: { tier: "read" } } });
    for (const tier of ["gold", "other"]) {
      const r = await upsert(readTier, { key: "ext_id", values: { ext_id: "003A", tier } });
      expect(r.status).toBe(403);
      expect(r.json.detail).toMatch(/contact\.tier/);
    }
    expect((await upsert(readTier, { key: "ext_id", values: { ext_id: "003A", first_name: "Ada" } })).json.action).toBe("unchanged");
  });
});

describe("a schedule that pulls a list from another system", () => {
  let ws: Workspace;
  const page = (rows: unknown[]) => ({ status: 200, body: JSON.stringify({ totalSize: rows.length, records: rows }) });
  beforeAll(async () => {
    ws = await newWorkspace("Pull");
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "ext_id", type: "text", unique: true } })).status).toBe(201);
    expect((await call("POST", "/v1/connections", { key: ws.keys.admin, body: { key: "other", name: "Other CRM", type: "static_token", base_url: "https://api.other-crm.example", secret: "tok-pull" } })).status).toBe(201);
  });
  const pull = { name: "Pull contacts", trigger: { type: "manual" }, actions: [
    { type: "http_request", id: "fetch", method: "GET", connection: "other", url: "/v1/query?since={{now-1h}}" },
    { type: "for_each", items: "{{steps.fetch.json.records}}", steps: [
      { type: "upsert_record", object: "contact", key: "ext_id",
        values: { ext_id: "{{item.Id}}", first_name: "{{item.FirstName}}", last_name: "{{item.LastName}}", email: "{{item.attributes.Email}}" } },
    ] },
  ] };
  const runOnce = async (id: string) => {
    expect((await call("POST", `/v1/automations/${id}/run`, { key: ws.keys.admin, body: {} })).status).toBe(202);
    await drain(ws);
    return (await call("GET", `/v1/automations/${id}/runs`, { key: ws.keys.admin })).json.data[0] as { status: string; reason: string | null; results: { action: string; detail: Record<string, unknown> }[] };
  };

  it("reads keys as the other system writes them (capitals too), and goes through the list creating then updating", async () => {
    expect(parsePlaceholder("steps.fetch.json.records.0.Id").path).toEqual(["steps", "fetch", "json", "records", "0", "Id"]);
    expect(() => parsePlaceholder("steps.fetch.json.__proto__.x")).toThrow();
    expect(() => parsePlaceholder("Steps.fetch.json")).toThrow();
    expect(fillString("{{record.at | epoch_ms}}", { record: { at: "2026-11-25T10:00:00.000Z" }, event: null })).toBe(1795600800000);
    const made = await call("POST", "/v1/automations", { key: ws.keys.admin, body: pull });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.summary).toContain("for each element of {{steps.fetch.json.records}}");
    const id = made.json.automation.id;

    replies.set("/v1/query", page([
      { Id: "003A", FirstName: "Ada", LastName: "Lovelace", attributes: { Email: "ada-pull@example.com" } },
      { Id: "003B", FirstName: "Grace", LastName: "Hopper", attributes: { Email: "grace-pull@example.com" } },
    ]));
    const first = await runOnce(id);
    expect(first.status, first.reason ?? "").toBe("succeeded");
    expect(sent.at(-1)).toMatchObject({ method: "GET", headers: { Authorization: "Bearer tok-pull" } });
    expect(sent.at(-1)!.url).toMatch(/^https:\/\/api\.other-crm\.example\/v1\/query\?since=20\d\d-/);
    expect(first.results.find((r) => r.action === "for_each")!.detail).toMatchObject({ count: 2 });
    expect((await contacts(ws)).map((c) => [c.ext_id, c.first_name, c.email])).toEqual([["003A", "Ada", "ada-pull@example.com"], ["003B", "Grace", "grace-pull@example.com"]]);

    // The next run: one changed, one new, one the same. No duplicates.
    replies.set("/v1/query", page([
      { Id: "003A", FirstName: "Ada", LastName: "King", attributes: { Email: "ada-pull@example.com" } },
      { Id: "003B", FirstName: "Grace", LastName: "Hopper", attributes: { Email: "grace-pull@example.com" } },
      { Id: "003C", FirstName: "Mary", LastName: "Jackson", attributes: { Email: "mary-pull@example.com" } },
    ]));
    const second = await runOnce(id);
    expect(second.status, second.reason ?? "").toBe("succeeded");
    expect(second.results.filter((r) => r.action === "upsert_record").map((r) => r.detail.action)).toEqual(["updated", "unchanged", "created"]);
    const after = await contacts(ws);
    expect(after.map((c) => c.ext_id)).toEqual(["003A", "003B", "003C"]);
    expect(after[0]!.last_name).toBe("King");
  });

  it("fails the run, without writing, when the reply holds no list there; and stops at 200 elements", async () => {
    const made = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { ...pull, name: "Pull, no list" } });
    const id = made.json.automation.id;
    replies.set("/v1/query", { status: 200, body: JSON.stringify({ records: { not: "a list" } }) });
    const run = await runOnce(id);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/is not a list/);
    replies.set("/v1/query", page(Array.from({ length: 205 }, (_, i) => ({ Id: `BULK${i}`, FirstName: "B", LastName: String(i), attributes: { Email: `bulk${i}-pull@example.com` } }))));
    const big = await runOnce(id);
    expect(big.status, big.reason ?? "").toBe("succeeded");
    expect(big.results.find((r) => r.action === "for_each")!.detail).toMatchObject({ count: 200, truncated: true });
    expect((await contacts(ws)).filter((c) => String(c.ext_id).startsWith("BULK")).length).toBeGreaterThanOrEqual(190); // a page of the list; the step log has the exact count
    expect(big.results.filter((r) => r.action === "upsert_record")).toHaveLength(200);
  });

  it("refuses a list that isn't one placeholder into an HTTP reply, and steps that need a record", async () => {
    const bad = async (forEach: Record<string, unknown>, before: unknown[] = [pull.actions[0]]) => {
      const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Bad", trigger: { type: "manual" }, actions: [...before, { type: "for_each", steps: pull.actions[1]!.steps, ...forEach }] } });
      return r.status === 422 ? (r.json.detail as string) : `status ${r.status}`;
    };
    expect(await bad({ items: "{{steps.fetch.status}}" })).toMatch(/items must be one placeholder/);
    expect(await bad({ items: "x {{steps.fetch.json.records}}" })).toMatch(/items must be one placeholder/);
    expect(await bad({ items: "{{steps.nope.json.records}}" })).toMatch(/names no earlier step/);
    expect(await bad({ items: "{{steps.found.records}}" }, [{ type: "find_records", id: "found", object: "contact" }])).toMatch(/items must be one placeholder/);
    expect(await bad({ items: "{{steps.fetch.json.records}}", query: { object: "contact" } })).toMatch(/exactly one of/);
    expect(await bad({ items: "{{steps.fetch.json.records}}", steps: [{ type: "update_record", values: { first_name: "x" } }] })).toMatch(/needs a record/);
    expect(await bad({ items: "{{steps.fetch.json.records}}", steps: [{ type: "notify", title: "x", recipients: { record_owner: true } }] })).toMatch(/needs a record/);
  });
});
