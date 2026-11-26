import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { limitsReport } from "../src/cli-output.js";
import { resetConfig } from "../src/config.js";
import { CapReached, consume } from "../src/core/automation-runner.js";
import {
  compactRecordCount, LIMIT_KEYS, limitOf, parseLimitChanges, resetLimitCache, serverLimits, workspaceLimits, type LimitChange, type LimitKey,
} from "../src/core/limits.js";
import { foldRecordCounts, recordCount } from "../src/core/queries/limits.js";
import { withTenant } from "../src/db/tx.js";
import { ConfigError } from "../src/lib/errors.js";
import { buildMcpApp } from "../src/mcp/http.js";
import { app, call, create, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Per-workspace limits (ADR 0019), through real HTTP calls. Limits are set the way an operator sets
 * them: the `limits` command's function, connected as the migrator.
 */
const setLimits = (ws: Workspace, changes: Partial<Record<LimitKey, LimitChange>>) => workspaceLimits(process.env.TEST_MIGRATOR_URL!, ws.id, changes);

interface Line { key: LimitKey; used: number | null; limit: number | null; source: string; kind: string }
async function usage(ws: Workspace): Promise<Record<LimitKey, Line>> {
  const r = await call("GET", "/v1/workspace/usage", { key: ws.keys.admin });
  expect(r.status).toBe(200);
  return Object.fromEntries((r.json.data.limits as Line[]).map((l) => [l.key, l])) as Record<LimitKey, Line>;
}

const contact = (key: string, n: number | string) => call("POST", "/v1/objects/contact/records", { key, body: { first_name: `C${n}`, last_name: "Limit" } });
const reached = (limit: LimitKey, used: number, max: number, adding = 1) =>
  expect.objectContaining({ status: 409, code: "limit_reached", errors: { limit, used, max, adding } });

beforeEach(() => {
  resetRateLimiter();
  resetLimitCache();
});

describe("defaults", () => {
  it("leave a server as it was: nothing that had no ceiling gets one, and the fixed ceilings keep their values", () => {
    expect(serverLimits()).toEqual({
      records: null, members: null, service_accounts: null, api_keys: null, custom_objects: 100, custom_fields: null, webhooks: 50, automations: 200,
      file_storage_mb: 1024, requests_per_minute: null, automation_actions_per_hour: 5000, automation_http_per_hour: 500, automation_emails_per_hour: 200,
    });
  });

  it("read a number or \"unlimited\" from the environment, and refuse anything else", () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, { LIMIT_RECORDS: "250000", LIMIT_WEBHOOKS: "Unlimited", LIMIT_MEMBERS: "" });
      resetConfig();
      expect(serverLimits()).toMatchObject({ records: 250000, webhooks: null, members: null });
      for (const bad of [{ LIMIT_RECORDS: "many" }, { LIMIT_RECORDS: "-1" }, { LIMIT_RECORDS: "1.5" }, { LIMIT_MEMBERS: "0" }, { LIMIT_REQUESTS_PER_MINUTE: "0" }]) {
        Object.assign(process.env, { LIMIT_RECORDS: "", LIMIT_MEMBERS: "", LIMIT_REQUESTS_PER_MINUTE: "" }, bad);
        resetConfig();
        expect(() => serverLimits(), JSON.stringify(bad)).toThrow(ConfigError);
      }
    } finally {
      for (const k of ["LIMIT_RECORDS", "LIMIT_WEBHOOKS", "LIMIT_MEMBERS", "LIMIT_REQUESTS_PER_MINUTE"]) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
      resetConfig();
    }
  });

  it("a new workspace reports what it uses against every limit", async () => {
    const ws = await newWorkspace("Usage");
    const u = await usage(ws);
    expect(Object.keys(u)).toEqual(LIMIT_KEYS);
    expect(u.records).toMatchObject({ used: 0, limit: null, source: "server", kind: "count" });
    expect(u.members).toMatchObject({ used: 1, limit: null });
    expect(u.api_keys).toMatchObject({ used: 2 });
    expect(u.custom_objects).toMatchObject({ used: 0, limit: 100 });
    expect(u.webhooks).toMatchObject({ used: 0, limit: 50 });
    expect(u.file_storage_mb).toMatchObject({ used: 0, limit: 1024 });
    expect(u.requests_per_minute).toMatchObject({ used: null, limit: null, kind: "rate" });
    expect(u.automation_actions_per_hour).toMatchObject({ used: 0, limit: 5000, kind: "rate" });
    await create(ws.keys.ops, "contact", { first_name: "A", last_name: "B" });
    expect((await usage(ws)).records.used).toBe(1);
  });

  it("usage needs a configuration permission: a records-only key is refused, and so is the ops MCP surface", async () => {
    const ws = await newWorkspace("Usage access");
    expect((await call("GET", "/v1/workspace/usage", { key: ws.keys.ops })).status).toBe(403);
    expect((await call("GET", "/v1/workspace/usage", { key: ws.keys.admin, headers: { "X-Hlcrm-Surface": "ops-mcp" } })).status).toBe(403);
  });
});

describe("only the operator sets a limit", () => {
  it("the app's database role can read a workspace's limits and can't write them", async () => {
    const ws = await newWorkspace("Read only");
    await setLimits(ws, { records: 10 });
    const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
        expect(await tx`SELECT key, value::int AS value FROM tenant_limits`).toEqual([{ key: "records", value: 10 }]);
      });
      for (const write of [
        (tx: postgres.TransactionSql) => tx`INSERT INTO tenant_limits (tenant_id, key, value) VALUES (${ws.tenantId}, 'members', 99)`,
        (tx: postgres.TransactionSql) => tx`UPDATE tenant_limits SET value = NULL`,
        (tx: postgres.TransactionSql) => tx`DELETE FROM tenant_limits`,
      ]) {
        await expect(sql.begin(async (tx) => {
          await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
          await write(tx);
        })).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await sql.end();
    }
    expect((await usage(ws)).records).toMatchObject({ limit: 10, source: "workspace" });
  });

  it("no route changes a limit, and the workspace's own settings route ignores one", async () => {
    const ws = await newWorkspace("No route");
    for (const [method, path] of [["PATCH", "/v1/workspace/usage"], ["PUT", "/v1/workspace/usage"], ["POST", "/v1/workspace/usage"], ["PATCH", "/v1/workspace/limits"], ["POST", "/v1/workspace/limits"]] as const) {
      expect((await call(method, path, { key: ws.keys.admin, body: { records: 1_000_000 } })).status, `${method} ${path}`).toBe(404);
    }
  });

  it("the command shows where each value comes from, takes unlimited and default, and writes the change to the workspace's audit log", async () => {
    const ws = await newWorkspace("Operator");
    const set = await setLimits(ws, { records: 5, webhooks: null, members: 3 });
    expect(set.workspace).toBe(ws.id);
    expect(set.limits.find((l) => l.key === "records")).toEqual({ key: "records", limit: 5, source: "workspace" });
    expect(set.limits.find((l) => l.key === "webhooks")).toEqual({ key: "webhooks", limit: null, source: "workspace" });
    expect(set.limits.find((l) => l.key === "automations")).toEqual({ key: "automations", limit: 200, source: "server" });
    const back = await setLimits(ws, { webhooks: "default" });
    expect(back.limits.find((l) => l.key === "webhooks")).toEqual({ key: "webhooks", limit: 50, source: "server" });
    // Showing changes nothing.
    expect((await setLimits(ws, {})).limits).toEqual(back.limits);
    const log = await call("GET", "/v1/audit-log?limit=20", { key: ws.keys.admin });
    const changes = (log.json.data as { action: string; actor: string; surface: string; details: { limits: unknown } }[]).filter((e) => e.action === "workspace.limits_changed");
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.details.limits)).toEqual(expect.arrayContaining([
      { records: { from: null, to: 5 }, webhooks: { from: 50, to: null }, members: { from: null, to: 3 } }, { webhooks: { from: null, to: 50 } }]));
    expect(changes[0]).toMatchObject({ actor: "system", surface: "cli" });
    const report = limitsReport(back, true);
    expect(report).toContain("records");
    expect(report).toMatch(/records\s+5\s+set for this workspace/);
    expect(report).toMatch(/webhooks\s+50\s+server default/);
    expect(limitsReport(await setLimits(ws, { records: null }), false)).toMatch(/records\s+unlimited\s+set for this workspace/);
  });

  it("refuses a workspace that isn't there and arguments that aren't limits", async () => {
    await expect(workspaceLimits(process.env.TEST_MIGRATOR_URL!, "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV")).rejects.toThrow(/No workspace/);
    await expect(workspaceLimits(process.env.TEST_MIGRATOR_URL!, "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV")).rejects.toThrow(ConfigError);
    expect(parseLimitChanges(["records=50000", "Webhooks=UNLIMITED", "members=default"])).toEqual({ records: 50000, webhooks: null, members: "default" });
    for (const bad of ["records", "records=", "records=lots", "records=-1", "records=1.5", "nope=1", "members=0", "requests_per_minute=0", "records=99999999999999"]) {
      expect(() => parseLimitChanges([bad]), bad).toThrow(ConfigError);
    }
  });
});

describe("records", () => {
  it("refuses a record past the limit with what is full, counts archived records, and follows the limit up and down", async () => {
    const ws = await newWorkspace("Records");
    const other = await newWorkspace("Records other");
    await setLimits(ws, { records: 3 });
    const made = [];
    for (let i = 0; i < 3; i++) made.push((await contact(ws.keys.ops, i)).json.data.id as string);
    const full = await contact(ws.keys.ops, "x");
    expect(full.json).toEqual(reached("records", 3, 3));
    expect(full.json.detail).toBe("This workspace is at its limit of 3 records (3 in use). Free some up, or ask whoever runs the server to raise the limit.");
    // Archiving frees nothing: an archived record is still held, and can be restored.
    expect((await call("DELETE", `/v1/objects/contact/records/${made[0]}`, { key: ws.keys.ops })).status).toBe(200);
    expect((await contact(ws.keys.ops, "y")).json).toEqual(reached("records", 3, 3));
    expect((await usage(ws)).records).toMatchObject({ used: 3, limit: 3, source: "workspace" });
    // Another workspace is untouched.
    expect((await contact(other.keys.ops, 1)).status).toBe(201);
    // Raised, lowered below what is held (nothing is removed; nothing more fits), unlimited, then the server's default again.
    await setLimits(ws, { records: 4 });
    expect((await contact(ws.keys.ops, "z")).status).toBe(201);
    await setLimits(ws, { records: 2 });
    expect((await contact(ws.keys.ops, "w")).json).toEqual(reached("records", 4, 2));
    expect((await call("GET", "/v1/objects/contact/records", { key: ws.keys.ops })).status).toBe(200);
    await setLimits(ws, { records: null });
    expect((await contact(ws.keys.ops, "v")).status).toBe(201);
    await setLimits(ws, { records: "default" });
    expect((await contact(ws.keys.ops, "u")).status).toBe(201);
    expect((await usage(ws)).records).toMatchObject({ used: 6, limit: null, source: "server" });
  });

  it("holds through every way a record is made: batch, dry run, import, an operation, and what an operation adds on the side", async () => {
    const ws = await newWorkspace("Record paths");
    const account = await create(ws.keys.ops, "account", { name: "Acme" });
    await setLimits(ws, { records: 4 });
    const batch = (records: unknown[], dry_run?: boolean) => call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records, dry_run } });
    const three = [1, 2, 3].map((n) => ({ first_name: `B${n}`, last_name: "Batch" }));
    // A dry run says which rows would not fit, and writes nothing.
    const dry = await batch([...three, { first_name: "B4", last_name: "Batch" }], true);
    expect(dry.status).toBe(200);
    expect(dry.json.counts).toEqual({ create: 3, error: 1 });
    expect(dry.json.rows[3]).toMatchObject({ action: "error", errors: { limit: "records", used: 4, max: 4, adding: 1 } });
    expect((await usage(ws)).records.used).toBe(1);
    // The batch is all or nothing: four don't fit, so none are made.
    expect((await batch([...three, { first_name: "B4", last_name: "Batch" }])).status).toBe(409);
    expect((await usage(ws)).records.used).toBe(1);
    expect((await batch(three.slice(0, 2))).status).toBe(201);
    // An import is all or nothing too, and names the rows that didn't fit and why; its dry run says the same beforehand.
    const csv = `email\n${uniqueEmail("a")}\n${uniqueEmail("b")}\n${uniqueEmail("c")}\n`;
    const planned = await call("POST", "/v1/objects/contact/import", { key: ws.keys.ops, body: { csv } });
    expect(planned.json.rows.map((r: { action: string }) => r.action)).toEqual(["create", "error", "error"]);
    const imported = await call("POST", "/v1/objects/contact/import", { key: ws.keys.ops, body: { csv, dry_run: false } });
    expect(imported.json).toMatchObject({ status: 422, code: "import_failed" });
    expect(imported.json.errors.map((r: { row: number; errors: unknown }) => [r.row, r.errors])).toEqual([
      [2, { limit: "records", used: 4, max: 4, adding: 1 }], [3, { limit: "records", used: 4, max: 4, adding: 1 }]]);
    expect((await usage(ws)).records.used).toBe(3);
    expect((await call("POST", "/v1/objects/contact/import", { key: ws.keys.ops, body: { csv: `email\n${uniqueEmail("d")}\n`, dry_run: false } })).status).toBe(200);
    expect((await usage(ws)).records.used).toBe(4);
    // An activity is a record too.
    const logged = await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", subject: "Called", related_to: [account.id] } });
    expect(logged.json).toEqual(reached("records", 4, 4));
    // With room for the contact but not for the link to its account that comes with it, neither is made.
    await setLimits(ws, { records: 5 });
    const linked = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { first_name: "L", last_name: "Linked", account: account.id } });
    expect(linked.json).toMatchObject({ status: 409, code: "limit_reached", errors: { limit: "records", max: 5 } });
    expect((await usage(ws)).records.used).toBe(4);
    await setLimits(ws, { records: 6 });
    expect((await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { first_name: "L", last_name: "Linked", account: account.id } })).status).toBe(201);
    expect((await usage(ws)).records.used).toBe(6);
  });

  it("restoring an archived record needs no room: it was counted all along", async () => {
    const ws = await newWorkspace("Restore");
    const c = await create(ws.keys.ops, "contact", { first_name: "R", last_name: "Restore" });
    await setLimits(ws, { records: 1 });
    expect((await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).status).toBe(200);
    expect((await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: ws.keys.ops, body: {} })).status).toBe(200);
    expect((await usage(ws)).records.used).toBe(1);
  });

  it("of many requests at once for the last place, exactly one gets it", async () => {
    const ws = await newWorkspace("Race");
    await create(ws.keys.ops, "contact", { first_name: "First", last_name: "Race" });
    await setLimits(ws, { records: 2 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => contact(ws.keys.ops, `race${i}`)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.json).toMatchObject({ code: "limit_reached", errors: { limit: "records", max: 2 } });
    expect((await usage(ws)).records.used).toBe(2);
    expect((await call("GET", "/v1/objects/contact/records?count=true", { key: ws.keys.ops })).json.total).toBe(2);
  });

  it("the count is a sum that can be folded into one row without changing", async () => {
    const ws = await newWorkspace("Fold");
    for (let i = 0; i < 4; i++) await contact(ws.keys.ops, i);
    const before = await withTenant(ws.tenantId, (tx) => recordCount(tx));
    expect(before).toEqual({ n: 4, rows: 4 });
    // The worker leaves a short count alone.
    expect(await compactRecordCount(ws.tenantId)).toBe(false);
    await withTenant(ws.tenantId, (tx) => foldRecordCounts(tx, ws.tenantId));
    expect(await withTenant(ws.tenantId, (tx) => recordCount(tx))).toEqual({ n: 4, rows: 1 });
    await contact(ws.keys.ops, "after");
    await withTenant(ws.tenantId, (tx) => foldRecordCounts(tx, ws.tenantId));
    expect(await withTenant(ws.tenantId, (tx) => recordCount(tx))).toEqual({ n: 5, rows: 1 });
    expect((await usage(ws)).records.used).toBe(5);
  });

  it("an agent is told which limit is full, and can read the usage, through the MCP servers", async () => {
    const ws = await newWorkspace("MCP limits");
    await setLimits(ws, { records: 1 });
    await contact(ws.keys.ops, 1);
    const apiFetch: typeof fetch = async (input, init) => app.request(input instanceof Request ? input : String(input), init);
    const mcpApp = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch });
    const connect = async (surface: "ops" | "admin", key: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://mcp.local/mcp/${surface}`), {
        fetch: async (input, init) => mcpApp.request(input instanceof Request ? input : String(input), init), requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      return client;
    };
    const ops = await connect("ops", ws.keys.ops);
    const refused = await ops.callTool({ name: "create_record", arguments: { object: "contact", values: { first_name: "No", last_name: "Room" } } }) as { isError?: boolean; content: { text: string }[] };
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("Error 409 limit_reached: This workspace is at its limit of 1 records (1 in use)");
    expect(refused.content[0]!.text).toContain('Details: {"limit":"records","used":1,"max":1,"adding":1}');
    expect((await ops.listTools()).tools.map((t) => t.name)).not.toContain("get_usage");
    const admin = await connect("admin", ws.keys.admin);
    const got = JSON.parse((await admin.callTool({ name: "get_usage", arguments: {} }) as { content: { text: string }[] }).content[0]!.text).result as { limits: Line[] };
    expect(got.limits.find((l) => l.key === "records")).toMatchObject({ used: 1, limit: 1, source: "workspace" });
  });
});

describe("members, service accounts and keys", () => {
  it("members: adding and re-enabling take a place, disabling gives one back", async () => {
    const ws = await newWorkspace("Members");
    await setLimits(ws, { members: 2 });
    const add = (email = uniqueEmail("m")) => call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "M", role: "member" } });
    const first = await add();
    expect(first.status).toBe(201);
    expect((await add()).json).toEqual(reached("members", 2, 2));
    expect((await call("PATCH", `/v1/members/${first.json.data.id}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(200);
    const second = await add();
    expect(second.status).toBe(201);
    expect((await call("PATCH", `/v1/members/${first.json.data.id}`, { key: ws.keys.admin, body: { active: true } })).json).toEqual(reached("members", 2, 2));
    // A change that isn't a re-enable still goes through at the limit.
    expect((await call("PATCH", `/v1/members/${second.json.data.id}`, { key: ws.keys.admin, body: { role: "read_only" } })).status).toBe(200);
    expect((await usage(ws)).members).toMatchObject({ used: 2, limit: 2 });
  });

  it("members: two added at once for the last place, one gets it", async () => {
    const ws = await newWorkspace("Member race");
    await setLimits(ws, { members: 2 });
    const results = await Promise.all([1, 2, 3, 4].map(() => call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("race"), name: "R", role: "member" } })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it("service accounts and API keys; rotating a key at the limit still works", async () => {
    const ws = await newWorkspace("Keys");
    await setLimits(ws, { service_accounts: 1, api_keys: 3 });
    const bot = await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: "Bot", role: "member" } });
    expect(bot.status).toBe(201);
    expect((await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: "Bot 2", role: "member" } })).json).toEqual(reached("service_accounts", 1, 1));
    const key = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "bot key", scopes: ["ops:read"], owner: bot.json.data.id } });
    expect(key.status).toBe(201);
    expect((await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "one more", scopes: ["ops:read"] } })).json).toEqual(reached("api_keys", 3, 3));
    expect((await call("POST", `/v1/api-keys/${key.json.data.id}/rotate`, { key: ws.keys.admin, body: { overlap_hours: 0 } })).status).toBe(200);
    // Revoking one makes room.
    const keys = await call("GET", "/v1/api-keys", { key: ws.keys.admin });
    const live = (keys.json.data as { id: string; name: string; revoked_at: string | null; expires_at: string | null }[]).find((k) => k.name === "bot key" && !k.revoked_at && !k.expires_at)!;
    expect((await call("POST", `/v1/api-keys/${live.id}/revoke`, { key: ws.keys.admin, body: {} })).status).toBe(200);
    expect((await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "one more", scopes: ["ops:read"] } })).status).toBe(201);
  });
});

describe("configuration", () => {
  it("custom objects and custom fields, through the API and a schema document", async () => {
    const ws = await newWorkspace("Schema limits");
    await setLimits(ws, { custom_objects: 1, custom_fields: 3 });
    const object = (api_name: string, fields: unknown[] = [], dry_run = false) => call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name, fields, dry_run } });
    const text = (api_name: string) => ({ api_name, type: "text" });
    expect((await object("project", [text("code"), text("phase"), text("colour"), text("extra")])).json).toEqual(reached("custom_fields", 0, 3, 4));
    expect((await object("project", [text("code"), text("phase")])).status).toBe(201);
    // A dry run is refused the same way, so a plan shows the limit before anything is applied.
    expect((await object("venue", [], true)).json).toEqual(reached("custom_objects", 1, 1));
    expect((await object("venue")).json).toEqual(reached("custom_objects", 1, 1));
    const field = (obj: string, api_name: string) => call("POST", `/v1/objects/${obj}/fields`, { key: ws.keys.admin, body: { api_name, type: "text", dry_run: false } });
    expect((await field("contact", "nickname")).status).toBe(201);
    expect((await field("project", "budget")).json).toEqual(reached("custom_fields", 3, 3));
    // Archiving a field makes room for another.
    const plan = await call("POST", "/v1/objects/contact/fields/nickname/archive", { key: ws.keys.admin, body: { dry_run: true } });
    expect((await call("POST", "/v1/objects/contact/fields/nickname/archive", { key: ws.keys.admin, body: { dry_run: false, confirm_token: plan.json.confirm_token } })).status).toBe(200);
    expect((await field("project", "budget")).status).toBe(201);
    const u = await usage(ws);
    expect(u.custom_objects).toMatchObject({ used: 1, limit: 1, source: "workspace" });
    expect(u.custom_fields).toMatchObject({ used: 3, limit: 3 });
    // The server's ceiling of 100 custom objects can be raised for one workspace, and lifted.
    await setLimits(ws, { custom_objects: null, custom_fields: null });
    expect((await object("venue")).status).toBe(201);
  });

  it("webhooks and automations keep their ceilings, which the operator can now move", async () => {
    const ws = await newWorkspace("Config limits");
    await setLimits(ws, { webhooks: 1, automations: 1 });
    const hook = (n: number) => call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `https://hooks.example.com/${n}`, events: ["contact.created"] } });
    const first = await hook(1);
    expect(first.status).toBe(201);
    expect((await hook(2)).json).toEqual(reached("webhooks", 1, 1));
    expect((await call("DELETE", `/v1/webhooks/${first.json.data.id}`, { key: ws.keys.admin })).status).toBe(200);
    expect((await hook(3)).status).toBe(201);
    const automation = (name: string, dry_run = false) => call("POST", "/v1/automations", { key: ws.keys.admin, body: { name, dry_run,
      trigger: { type: "event", event: "contact.created" }, actions: [{ type: "update_record", values: { job_title: "New" } }] } });
    expect((await automation("One")).status).toBe(201);
    expect((await automation("Two")).json).toEqual(reached("automations", 1, 1));
    await setLimits(ws, { automations: "default" });
    expect((await automation("Two")).status).toBe(201);
  });

  it("file storage: the workspace's own quota, in place of the server's", async () => {
    const ws = await newWorkspace("File limits");
    const c = await create(ws.keys.ops, "contact", { first_name: "F", last_name: "Files" });
    await setLimits(ws, { file_storage_mb: 1 });
    expect((await call("GET", "/v1/files/limits", { key: ws.keys.ops })).json.data).toMatchObject({ quota_bytes: 1024 * 1024 });
    const upload = async (name: string, bytes: number) => {
      const res = await app.request(`/v1/records/${c.id}/files?name=${name}`, { method: "POST",
        headers: { Authorization: `Bearer ${ws.keys.ops}`, "Content-Type": "application/octet-stream" }, body: new Uint8Array(Buffer.alloc(bytes, 7)) });
      return { status: res.status, json: JSON.parse(await res.text()) };
    };
    expect((await upload("a.bin", 700 * 1024)).status).toBe(201);
    const over = await upload("b.bin", 700 * 1024);
    expect(over.json).toMatchObject({ status: 409, code: "limit_reached", errors: { limit: "file_storage_mb", used: 0.69, max: 1, adding: 0.69 } });
    expect((await usage(ws)).file_storage_mb).toMatchObject({ used: 0.69, limit: 1, source: "workspace" });
    await setLimits(ws, { file_storage_mb: null });
    expect((await upload("b.bin", 700 * 1024)).status).toBe(201);
    expect((await call("GET", "/v1/files/limits", { key: ws.keys.ops })).json.data).toMatchObject({ quota_bytes: null });
  });

  it("automation caps: the workspace's own, and none at all when unlimited", async () => {
    const ws = await newWorkspace("Automation caps");
    await setLimits(ws, { automation_http_per_hour: 2 });
    const spend = () => withTenant(ws.tenantId, async (tx) => consume(tx, ws.tenantId, "http", await limitOf(tx, "automation_http_per_hour"), 3_600_000, "the cap"));
    await spend();
    await spend();
    await expect(spend()).rejects.toBeInstanceOf(CapReached);
    expect((await usage(ws)).automation_http_per_hour).toMatchObject({ used: 2, limit: 2, source: "workspace" });
    await setLimits(ws, { automation_http_per_hour: null });
    await spend();
    expect((await usage(ws)).automation_http_per_hour).toMatchObject({ used: 3, limit: null });
    await setLimits(ws, { automation_http_per_hour: 0 });
    await expect(spend()).rejects.toBeInstanceOf(CapReached);
  });
});

describe("request rate", () => {
  it("is shared by every credential of the workspace, says so when it is passed, and leaves other workspaces alone", async () => {
    const ws = await newWorkspace("Rate");
    const other = await newWorkspace("Rate other");
    await setLimits(ws, { requests_per_minute: 6 });
    resetLimitCache();
    const statuses: number[] = [];
    // Two keys, one bucket.
    for (let i = 0; i < 6; i++) statuses.push((await call("GET", "/v1/me", { key: i % 2 ? ws.keys.ops : ws.keys.admin })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    const refused = await call("GET", "/v1/me", { key: ws.keys.ops });
    expect(refused.status).toBe(429);
    expect(refused.json).toMatchObject({ code: "rate_limited", errors: { limit: "requests_per_minute", max: 6 } });
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("GET", "/v1/me", { key: other.keys.ops })).status).toBe(200);
    // Lifted by the operator: in this process at once (the command forgets the remembered rate), elsewhere within 30 seconds.
    await setLimits(ws, { requests_per_minute: null });
    expect((await call("GET", "/v1/me", { key: ws.keys.ops })).status).toBe(200);
  });

  it("a request that counts as several takes that many from the workspace too", async () => {
    const ws = await newWorkspace("Rate cost");
    await setLimits(ws, { requests_per_minute: 4 });
    resetLimitCache();
    // A dry-run batch of many records costs several tokens: more than this workspace has left after one request.
    const records = Array.from({ length: 100 }, (_, i) => ({ first_name: `R${i}`, last_name: "Cost" }));
    const first = await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records, dry_run: true } });
    expect(first.status).toBe(200);
    const next = await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records, dry_run: true } });
    expect(next.status).toBe(429);
    expect(next.json.errors).toEqual({ limit: "requests_per_minute", max: 4 });
  });
});
