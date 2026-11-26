import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runQueuedOnce } from "../src/core/automation-runner.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, signedIn, type Workspace } from "./helpers.js";

// The token endpoint and the API are a local receiver, which needs the self-hosted "insecure targets" switch.
process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = "true";

interface Received { method: string; path: string; headers: IncomingMessage["headers"]; body: string }
type Reply = { status: number; body: string };
let server: Server;
let base = "";
const received: Received[] = [];
/** A fixed reply, or a function of the request, per path. Anything else answers 200 {"ok": true, "id": "ext-1"}. */
const replies = new Map<string, Reply | ((r: Received) => Reply)>();
const at = (p: string) => received.filter((r) => r.path.split("?")[0] === p);
const json = (status: number, body: unknown): Reply => ({ status, body: JSON.stringify(body) });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const got = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      received.push(got);
      const r = replies.get(got.path.split("?")[0]!);
      const reply = typeof r === "function" ? r(got) : r ?? json(200, { ok: true, id: "ext-1" });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(reply.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function drain(ws: Workspace) {
  for (let i = 0; i < 30; i++) {
    const n = (await processEvents(ws.tenantId)) + (await runQueuedOnce(ws.tenantId) ? 1 : 0);
    if (n === 0) return;
  }
}
const runsOf = async (ws: Workspace, id: string) => (await call("GET", `/v1/automations/${id}/runs`, { key: ws.keys.admin })).json.data as {
  status: string; reason: string | null; results: { ok: boolean; detail: Record<string, unknown> }[];
}[];
async function automation(ws: Workspace, body: Record<string, unknown>) {
  const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body });
  if (r.status !== 201) throw new Error(`create automation: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.automation as { id: string; actions: Record<string, unknown>[] };
}
async function connection(ws: Workspace, body: Record<string, unknown>) {
  const r = await call("POST", "/v1/connections", { key: ws.keys.admin, body });
  if (r.status !== 201) throw new Error(`create connection: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string } & Record<string, unknown>;
}
/** Runs an automation for a record and returns its newest run. */
async function runFor(ws: Workspace, automationId: string, record: string) {
  const r = await call("POST", `/v1/automations/${automationId}/run`, { key: ws.keys.admin, body: { records: [record] } });
  expect(r.status).toBe(202);
  await drain(ws);
  return (await runsOf(ws, automationId))[0]!;
}
const pushStep = (key: string, path: string) => ({ type: "http_request", id: "push", method: "POST", connection: key, url: path, body: { email: "{{record.email}}" } });
const row = (ws: Workspace, publicId: string) => withTenant(ws.tenantId, async (tx) =>
  (await tx<Record<string, string | null>[]>`SELECT secret, refresh_token, access_token FROM connections WHERE id = ${decodeId(publicId)!.uuid}`)[0]!);

describe("connections: managing them", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Conn manage");
  });

  it("creates, lists and reads a connection without ever returning a secret, and keeps it encrypted", async () => {
    const c = await connection(ws, { key: "hubspot", name: "HubSpot", type: "static_token", base_url: `${base}/hub/`, secret: "pat-very-secret-token" });
    expect(c).toMatchObject({ key: "hubspot", type: "static_token", base_url: `${base}/hub`, header_name: "Authorization", header_prefix: "Bearer ",
      has_secret: true, has_refresh_token: false, status: "active", used_by: [] });
    expect(c.id).toMatch(/^conn_/);
    const list = await call("GET", "/v1/connections", { key: ws.keys.admin });
    const one = await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin });
    for (const r of [c, list.json, one.json]) expect(JSON.stringify(r)).not.toContain("pat-very-secret-token");
    expect(list.json.data.map((x: { key: string }) => x.key)).toContain("hubspot");
    const stored = await row(ws, c.id);
    expect(stored.secret).toMatch(/^v\d+:/);
    expect(stored.secret).not.toContain("pat-very-secret-token");
    const auditLog = await call("GET", "/v1/audit-log?action=connection.created", { key: ws.keys.admin });
    expect(auditLog.json.data[0].details).toMatchObject({ connection: c.id, key: "hubspot", type: "static_token" });
    expect(JSON.stringify(auditLog.json)).not.toContain("pat-very-secret-token");
  });

  it("refuses what a connection can't be", async () => {
    const bad = async (body: Record<string, unknown>) => (await call("POST", "/v1/connections", { key: ws.keys.admin,
      body: { key: "x1", name: "X", type: "static_token", base_url: `${base}/x`, secret: "s", ...body } })).status;
    expect(await bad({ key: "hubspot" })).toBe(409);
    expect(await bad({ key: "Has-Caps" })).toBe(422);
    expect(await bad({ secret: undefined })).toBe(422);
    expect(await bad({ secret: "line\nbreak" })).toBe(422);
    expect(await bad({ base_url: `${base}/x?token=1` })).toBe(422);
    expect(await bad({ base_url: "http://169.254.169.254/latest" })).toBe(422);
    expect(await bad({ base_url: `${base}/{{record.id}}` })).toBe(422);
    expect(await bad({ header_name: "Host" })).toBe(422);
    expect(await bad({ header_name: "hlcrm-run" })).toBe(422);
    expect(await bad({ token_url: `${base}/token` })).toBe(422);
    expect(await bad({ test_path: "no-slash" })).toBe(422);
    expect(await bad({ test_path: "/a/../b" })).toBe(422);
    expect(await bad({ refresh_token: "r" })).toBe(422);
    expect(await bad({ type: "oauth_client_credentials" })).toBe(422);
    expect(await bad({ type: "oauth_client_credentials", token_url: `${base}/token` })).toBe(422);
    expect(await bad({ type: "oauth_client_credentials", token_url: `${base}/token`, client_id: "id", token_params: { grant_type: "password" } })).toBe(422);
    expect(await bad({ type: "oauth_refresh_token", token_url: `${base}/token`, client_id: "id" })).toBe(422);
    expect(await bad({ unknown_field: 1 })).toBe(422);
  });

  it("needs connections:manage, and changes never come through MCP", async () => {
    const roles = (await call("GET", "/v1/roles", { key: ws.keys.admin })).json.data as { key: string; permissions: string[] }[];
    const holds = (key: string) => roles.find((r) => r.key === key)!.permissions.includes("connections:manage");
    expect([holds("owner"), holds("admin"), holds("member"), holds("read_only")]).toEqual([true, true, false, false]);
    expect((await call("GET", "/v1/connections", { key: ws.keys.ops })).status).toBe(403);
    // A role that writes automations but holds no connections:manage can't read or change connections.
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "automator", name: "Automator",
      permissions: ["records:read", "records:write", "records:archive", "automations:manage"] } });
    expect(role.status).toBe(201);
    const m = await memberWithKey(ws, "automator", ["admin", "ops:write"]);
    expect((await call("GET", "/v1/connections", { key: m.key })).status).toBe(403);
    expect((await call("POST", "/v1/connections", { key: m.key, body: { key: "mine", name: "M", type: "static_token", base_url: `${base}/m`, secret: "s" } })).status).toBe(403);
    // It can still name a connection an admin made.
    const made = await call("POST", "/v1/automations", { key: m.key, body: { name: "By automator", trigger: { type: "manual", object: "contact" },
      actions: [pushStep("hubspot", "/contacts")] } });
    expect(made.status).toBe(201);
    await call("DELETE", `/v1/automations/${made.json.automation.id}`, { key: m.key });

    const mcp = { "x-hlcrm-surface": "admin-mcp" };
    const viaMcp = await call("POST", "/v1/connections", { key: ws.keys.admin, headers: mcp, body: { key: "agent", name: "A", type: "static_token", base_url: "https://attacker.example", secret: "s" } });
    expect(viaMcp.status).toBe(403);
    expect(viaMcp.json.detail).toMatch(/MCP/);
    const list = await call("GET", "/v1/connections", { key: ws.keys.admin, headers: mcp });
    expect(list.status).toBe(200);
    const id = list.json.data[0].id;
    expect((await call("PATCH", `/v1/connections/${id}`, { key: ws.keys.admin, headers: mcp, body: { base_url: "https://attacker.example", secret: "s" } })).status).toBe(403);
    expect((await call("DELETE", `/v1/connections/${id}`, { key: ws.keys.admin, headers: mcp })).status).toBe(403);
    expect((await call("POST", `/v1/connections/${id}/test`, { key: ws.keys.admin, headers: mcp })).status).toBe(403);
  });

  it("from a browser, entering a secret needs a recent sign-in; renaming does not", async () => {
    const o = await signedIn(ws.ownerEmail);
    const made = await o.request("POST", "/v1/connections", { body: { key: "fresh", name: "Fresh", type: "static_token", base_url: `${base}/fresh`, secret: "s1" } });
    expect(made.status).toBe(201);
    const sid = decodeId((await o.request("GET", "/v1/auth/session")).json.session.id)!.uuid;
    await withTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '1 hour' WHERE id = ${sid}`);
    const id = made.json.data.id;
    expect((await o.request("POST", "/v1/connections", { body: { key: "stale", name: "S", type: "static_token", base_url: `${base}/s`, secret: "s" } })).json.code).toBe("recent_sign_in_required");
    expect((await o.request("PATCH", `/v1/connections/${id}`, { body: { secret: "s2" } })).json.code).toBe("recent_sign_in_required");
    expect((await o.request("PATCH", `/v1/connections/${id}`, { body: { base_url: `${base}/elsewhere`, secret: "s2" } })).json.code).toBe("recent_sign_in_required");
    // An unchanged base_url sent along (as the web form does) moves nothing, so it needs no fresh sign-in.
    expect((await o.request("PATCH", `/v1/connections/${id}`, { body: { name: "Renamed", base_url: `${base}/fresh` } })).status).toBe(200);
  });

  it("a moved base URL needs the secret again; archiving is refused while an automation uses it, and forgets the secrets", async () => {
    const c = await connection(ws, { key: "mover", name: "Mover", type: "static_token", base_url: `${base}/one`, secret: "mover-secret" });
    const moved = await call("PATCH", `/v1/connections/${c.id}`, { key: ws.keys.admin, body: { base_url: "https://attacker.example/collect" } });
    expect(moved.status).toBe(422);
    expect(moved.json.detail).toMatch(/must be given again/);
    expect((await call("PATCH", `/v1/connections/${c.id}`, { key: ws.keys.admin, body: { base_url: `${base}/two`, secret: "mover-secret-2" } })).json.data.base_url).toBe(`${base}/two`);
    expect((await call("PATCH", `/v1/connections/${c.id}`, { key: ws.keys.admin, body: { name: "Moved", secret: null } })).json.data).toMatchObject({ name: "Moved", has_secret: true });
    const sets = await call("GET", "/v1/audit-log?action=connection.secret_set", { key: ws.keys.admin });
    expect(sets.json.data[0].details).toMatchObject({ connection: c.id, secrets: ["secret"] });

    const a = await automation(ws, { name: "Uses mover", trigger: { type: "manual", object: "contact" }, actions: [pushStep("mover", "/contacts")] });
    expect((await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json.data.used_by).toEqual([{ id: a.id, name: "Uses mover" }]);
    const refused = await call("DELETE", `/v1/connections/${c.id}`, { key: ws.keys.admin });
    expect(refused.status).toBe(409);
    expect(refused.json.detail).toMatch(/Uses mover/);
    await call("DELETE", `/v1/automations/${a.id}`, { key: ws.keys.admin });
    const gone = await call("DELETE", `/v1/connections/${c.id}`, { key: ws.keys.admin });
    expect(gone.json.data).toMatchObject({ status: "archived", has_secret: false });
    expect(await row(ws, c.id)).toEqual({ secret: null, refresh_token: null, access_token: null });
    // The key is free again, and a step naming an archived connection is refused.
    expect((await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Late", trigger: { type: "manual", object: "contact" }, actions: [pushStep("mover", "/x")] } })).status).toBe(422);
    await connection(ws, { key: "mover", name: "Mover again", type: "static_token", base_url: `${base}/three`, secret: "s" });
  });
});

describe("connections: used by http_request steps", () => {
  let ws: Workspace;
  let contact: { id: string };
  beforeAll(async () => {
    ws = await newWorkspace("Conn use");
    contact = await create(ws.keys.admin, "contact", { first_name: "Ada", email: `ada-${Date.now()}@example.com` });
  });

  it("a static token goes to the base URL plus the step's path, hidden in dry runs and logs", async () => {
    const c = await connection(ws, { key: "hubspot", name: "HubSpot", type: "static_token", base_url: `${base}/hub`, secret: "pat-static-secret" });
    const a = await automation(ws, { name: "Push", trigger: { type: "manual", object: "contact" },
      actions: [{ ...pushStep("hubspot", "/crm/v3/contacts/{{record.id}}?src=crm"), headers: { "X-Source": "crm" } }] });
    expect(a.actions[0]).toMatchObject({ connection: "hubspot", url: "/crm/v3/contacts/{{record.id}}?src=crm" });
    const dry = await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id], dry_run: true } });
    const would = dry.json.data.runs[0].actions[0].detail.would_send;
    expect(would.url).toBe(`${base}/hub/crm/v3/contacts/${contact.id}?src=crm`);
    expect(would.headers).toEqual({ "X-Source": "crm", Authorization: "(secret, not shown)" });
    expect(at(`/hub/crm/v3/contacts/${contact.id}`)).toHaveLength(0);

    const run = await runFor(ws, a.id, contact.id);
    expect(run.status).toBe("succeeded");
    const hit = at(`/hub/crm/v3/contacts/${contact.id}`).at(-1)!;
    expect(hit.headers.authorization).toBe("Bearer pat-static-secret");
    expect(hit.headers["x-source"]).toBe("crm");
    expect(JSON.stringify(run)).not.toContain("pat-static-secret");
    expect(run.results[0]!.detail.headers).toEqual(["X-Source", "Authorization"]);
    const auditLog = await call("GET", "/v1/audit-log?action=automation.http_request", { key: ws.keys.admin });
    expect(auditLog.json.data[0].details).toMatchObject({ connection: c.id, status: 200 });
    expect((await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json.data.last_used_at).not.toBeNull();
  });

  it("refuses steps that would carry the credential elsewhere or add their own", async () => {
    const bad = async (step: Record<string, unknown>) => {
      const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Bad", trigger: { type: "manual", object: "contact" },
        actions: [{ type: "http_request", id: "s", method: "GET", connection: "hubspot", url: "/x", ...step }] } });
      return r.status === 422 ? (r.json.detail as string) : `status ${r.status}`;
    };
    expect(await bad({ connection: "nope" })).toMatch(/no connection/);
    expect(await bad({ url: "https://attacker.example/x" })).toMatch(/path starting with/);
    expect(await bad({ url: "//attacker.example/x" })).toMatch(/path starting with/);
    expect(await bad({ url: "/a/../../admin" })).toMatch(/"\.\."/);
    expect(await bad({ url: "/a/%2E%2e/admin" })).toMatch(/"\.\."/);
    expect(await bad({ url: "/a/{{record.first_name}}/../x" })).toMatch(/"\.\."/);
    expect(await bad({ headers: { authorization: "Bearer mine" } })).toMatch(/set by connection/);
    expect(await bad({ secret_headers: { "X-Key": "k" } })).toMatch(/can't have secret_headers/);
  });

  it("a turned-off connection fails the step without sending", async () => {
    const c = await connection(ws, { key: "offline", name: "Off", type: "static_token", base_url: `${base}/off`, secret: "s" });
    const a = await automation(ws, { name: "Off push", trigger: { type: "manual", object: "contact" }, actions: [pushStep("offline", "/contacts")] });
    await call("PATCH", `/v1/connections/${c.id}`, { key: ws.keys.admin, body: { enabled: false } });
    const run = await runFor(ws, a.id, contact.id);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/turned off/);
    expect(at("/off/contacts")).toHaveLength(0);
  });

  it("client credentials: fetches a token with the form the provider expects, caches it, and refreshes once on a 401", async () => {
    let issued = 0;
    replies.set("/cc/token", () => json(200, { access_token: `cc-token-${++issued}`, token_type: "Bearer", expires_in: 3600, instance_url: "https://attacker.example" }));
    const c = await connection(ws, { key: "salesforce", name: "Salesforce", type: "oauth_client_credentials", base_url: `${base}/sf`,
      token_url: `${base}/cc/token`, client_id: "client-1", secret: "client-secret-1", scope: "api", token_params: { audience: "crm" }, test_path: "/services/data/" });
    const a = await automation(ws, { name: "SF push", trigger: { type: "manual", object: "contact" }, actions: [pushStep("salesforce", "/sobjects/Contact")] });

    expect((await runFor(ws, a.id, contact.id)).status).toBe("succeeded");
    const form = new URLSearchParams(at("/cc/token")[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ audience: "crm", grant_type: "client_credentials", client_id: "client-1", client_secret: "client-secret-1", scope: "api" });
    expect(at("/cc/token")[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(at("/sf/sobjects/Contact").at(-1)!.headers.authorization).toBe("Bearer cc-token-1");
    // The reply's instance_url is ignored: requests go to base_url.
    expect(received.some((r) => r.headers.host?.includes("attacker"))).toBe(false);

    // A second run uses the cached token.
    expect((await runFor(ws, a.id, contact.id)).status).toBe("succeeded");
    expect(at("/cc/token")).toHaveLength(1);
    const cached = await row(ws, c.id);
    expect(cached.access_token).toMatch(/^v\d+:/);
    expect(cached.access_token).not.toContain("cc-token-1");
    const seen = (await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json;
    expect(seen.data.token_expires_at).not.toBeNull();
    expect(JSON.stringify(seen)).not.toMatch(/cc-token|client-secret-1/);

    // The provider ends the token early: a 401, one new token, one more try. The forced refresh is not reused
    // here because the first token is older than the reuse window only in real time, so age it.
    await withTenant(ws.tenantId, (tx) => tx`UPDATE connections SET access_token_fetched_at = now() - interval '1 minute' WHERE id = ${decodeId(c.id)!.uuid}`);
    replies.set("/sf/sobjects/Contact", (r) => (r.headers.authorization === "Bearer cc-token-1" ? json(401, { error: "expired" }) : json(200, { id: "003" })));
    const before = at("/sf/sobjects/Contact").length;
    const run = await runFor(ws, a.id, contact.id);
    expect(run.status).toBe("succeeded");
    expect(at("/cc/token")).toHaveLength(2);
    expect(at("/sf/sobjects/Contact").slice(before).map((r) => r.headers.authorization)).toEqual(["Bearer cc-token-1", "Bearer cc-token-2"]);
    expect(JSON.stringify(run)).not.toMatch(/cc-token|client-secret-1/);

    // The test route fetches a token and sends one GET to test_path, answering with statuses only.
    const test = await call("POST", `/v1/connections/${c.id}/test`, { key: ws.keys.admin });
    expect(test.json.data).toEqual({ ok: true, token: { ok: true, error: null }, request: { ok: true, status: 200, error: null } });
    expect(at("/sf/services/data/").at(-1)!.headers.authorization).toMatch(/^Bearer cc-token-/);
  });

  it("a token reply with no expires_in is kept for the connection's token lifetime", async () => {
    replies.set("/noexp/token", json(200, { access_token: "noexp-token" }));
    const c = await connection(ws, { key: "noexp", name: "No expiry", type: "oauth_client_credentials", base_url: `${base}/noexp`,
      token_url: `${base}/noexp/token`, client_id: "id", secret: "s", token_lifetime_minutes: 20 });
    expect((await call("POST", `/v1/connections/${c.id}/test`, { key: ws.keys.admin })).json.data).toMatchObject({ ok: true, token: { ok: true }, request: null });
    const until = Date.parse((await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json.data.token_expires_at);
    expect(Math.abs(until - (Date.now() + 20 * 60_000))).toBeLessThan(30_000);
  });

  it("refresh token: sends it, and keeps the one the provider gives in its place", async () => {
    const sent: string[] = [];
    replies.set("/rt/token", (r) => {
      const token = new URLSearchParams(r.body).get("refresh_token")!;
      sent.push(token);
      return json(200, { access_token: `rt-access-${sent.length}`, expires_in: 1, refresh_token: `rotated-${sent.length}` });
    });
    const c = await connection(ws, { key: "zoho", name: "Zoho", type: "oauth_refresh_token", base_url: `${base}/zoho`, token_url: `${base}/rt/token`,
      client_id: "zc", secret: "zs", refresh_token: "first-refresh-token", header_prefix: "Zoho-oauthtoken " });
    const a = await automation(ws, { name: "Zoho push", trigger: { type: "manual", object: "contact" }, actions: [pushStep("zoho", "/crm/v8/Contacts")] });
    expect((await runFor(ws, a.id, contact.id)).status).toBe("succeeded");
    expect(at("/zoho/crm/v8/Contacts").at(-1)!.headers.authorization).toBe("Zoho-oauthtoken rt-access-1");
    expect(new URLSearchParams(at("/rt/token")[0]!.body).get("grant_type")).toBe("refresh_token");
    // The token lasts a second, so the next run asks again, with the rotated refresh token.
    expect((await runFor(ws, a.id, contact.id)).status).toBe("succeeded");
    expect(sent).toEqual(["first-refresh-token", "rotated-1"]);
    const stored = await row(ws, c.id);
    expect(stored.refresh_token).not.toMatch(/rotated|first-refresh/);
    expect(JSON.stringify((await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json)).not.toMatch(/rotated|first-refresh|rt-access/);
  });

  it("a failed token request fails the step, is recorded on the connection, and shows nothing of the reply but its status and error code", async () => {
    replies.set("/bad/token", json(400, { error: "invalid_client", error_description: "the secret zs-leaky-detail is wrong" }));
    const c = await connection(ws, { key: "broken", name: "Broken", type: "oauth_client_credentials", base_url: `${base}/broken`, token_url: `${base}/bad/token`, client_id: "id", secret: "s" });
    const a = await automation(ws, { name: "Broken push", trigger: { type: "manual", object: "contact" }, actions: [pushStep("broken", "/contacts")] });
    const run = await runFor(ws, a.id, contact.id);
    expect(run.status).toBe("failed");
    expect(run.reason).toMatch(/connection broken: the token request was answered with HTTP 400 \(invalid_client\)/);
    expect(at("/broken/contacts")).toHaveLength(0);
    const seen = (await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json.data;
    expect(seen).toMatchObject({ status: "failing", last_error: "the token request was answered with HTTP 400 (invalid_client)" });
    const test = await call("POST", `/v1/connections/${c.id}/test`, { key: ws.keys.admin });
    expect(test.json.data).toMatchObject({ ok: false, token: { ok: false }, request: null });
    expect(JSON.stringify([run, seen, test.json])).not.toContain("leaky-detail");
    // Fixed at the provider: the next token clears the error.
    replies.set("/bad/token", json(200, { access_token: "now-fine", expires_in: 600 }));
    expect((await runFor(ws, a.id, contact.id)).status).toBe("succeeded");
    expect((await call("GET", `/v1/connections/${c.id}`, { key: ws.keys.admin })).json.data).toMatchObject({ status: "active", last_error: null });
  });
});

describe("the integration guides", () => {
  it("their automations are accepted as written, against connections made as they say", async () => {
    const ws = await newWorkspace("Conn guides");
    const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "integrations");
    for (const [file, key, field] of [["hubspot.md", "hubspot", "hubspot_id"], ["salesforce.md", "salesforce", "salesforce_id"]] as const) {
      const text = readFileSync(join(docs, file), "utf8");
      expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: field, type: "text", unique: true } })).status).toBe(201);
      await connection(ws, key === "hubspot"
        ? { key, name: key, type: "static_token", base_url: "https://api.hubapi.com", secret: "s" }
        : { key, name: key, type: "oauth_client_credentials", base_url: "https://acme.my.salesforce.com", token_url: "https://acme.my.salesforce.com/services/oauth2/token", client_id: "id", secret: "s" });
      const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>).filter((b) => b.trigger);
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const automation of blocks) {
        const dry = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { ...automation, dry_run: true } });
        expect(dry.status, `${file}: ${JSON.stringify(dry.json)}`).toBe(200);
        expect(dry.json.summary).toContain(`through connection ${key}`);
      }
      // One that pushes on a change and one that pulls on a schedule.
      expect(blocks.map((b) => (b.trigger as { type: string }).type).sort(), file).toEqual(["event", "schedule"]);
    }
  });
});
