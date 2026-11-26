import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { resetConfig } from "../src/config.js";
import { verifyTenant } from "../src/core/auditchain.js";
import { deletedWorkspace, deleteWorkspaceNow, purgeDueWorkspaces } from "../src/core/disposal.js";
import { db } from "../src/db/pool.js";
import { blobStore } from "../src/providers/blobs.js";
import { setFileStore, type FileStore } from "../src/providers/files.js";
import { sealAll } from "../src/worker/index.js";
import { app, call, create, memberWithKey, newWorkspace, signedIn, type Workspace } from "./helpers.js";

/**
 * Deleting a workspace (ADR 0020): every row in every tenant table goes, another workspace is not
 * touched, a tombstone with no customer content stays, and only an owner (after typing the name, and
 * after the grace period) or the server's operator can do it.
 */

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrator = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
afterAll(() => migrator.end());
beforeEach(() => resetRateLimiter());

/** Tables that hold no tenant's rows by design: each is a decision, so a new one is added here on purpose. */
const NOT_TENANT_TABLES = ["deleted_workspaces", "oauth_assertions", "oauth_clients", "schema_migrations", "sign_in_flows", "tenant_directory"];

async function tenantTables(): Promise<string[]> {
  const rows = await migrator<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      AND c.relname <> 'tenant_directory' ORDER BY 1`;
  return rows.map((r) => r.relname);
}

/** Rows per tenant table as the workspace itself sees them (row-level security is forced on every role). */
async function rowCounts(tenantId: string): Promise<Record<string, number>> {
  const tables = await tenantTables();
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = Number((await tx.unsafe<{ n: string }[]>(`SELECT count(*)::text AS n FROM "${t}" WHERE tenant_id = $1`, [tenantId]))[0]!.n);
    return out;
  }) as Promise<Record<string, number>>;
}

/** A workspace with something in as many tables as the API reaches: records of every kind, history, files, config, members and sessions. */
async function busyWorkspace(name: string): Promise<Workspace> {
  const ws = await newWorkspace(name);
  const ops = ws.keys.ops;
  const admin = ws.keys.admin;
  const ok = (r: { status: number; json: unknown }, what: string) => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };
  const acct = await create(ops, "account", { name: `${name} Corp`, domain: `${name.toLowerCase().replace(/\W/g, "")}-${Date.now()}.example` });
  const contact = await create(ops, "contact", { first_name: "Pat", last_name: "Purged", email: `pat-${Date.now()}@purge.example`, account: acct.id });
  const dup = await create(ops, "contact", { first_name: "Pat", last_name: "Duplicate" });
  const lead = await create(ops, "lead", { contact: contact.id, status: "qualified", interest: "Purge me" });
  // A converted lead and its deal refer to each other: the purge has to take both in one statement.
  const converted = ok(await call("POST", "/v1/ops/convert_lead", { key: ops, body: { lead: lead.id } }), "convert");
  const dealId = (converted.json as { result: { deal: { id: string } } }).result.deal.id;
  ok(await call("POST", "/v1/ops/move_deal_stage", { key: ops, body: { deal: dealId, stage: "Proposal" } }), "stage");
  ok(await call("POST", "/v1/ops/log_activity", { key: ops, body: { type: "note", subject: "A note", body: "Text", related_to: [contact.id, dealId] } }), "note");
  await create(ops, "task", { title: "Call Pat", related_to: [contact.id] });
  const dry = ok(await call("POST", "/v1/ops/merge_records", { key: ops, body: { survivor: contact.id, duplicates: [dup.id] } }), "merge dry run");
  ok(await call("POST", "/v1/ops/merge_records", { key: ops, body: { survivor: contact.id, duplicates: [dup.id], dry_run: false,
    confirm_token: (dry.json as { confirm_token: string }).confirm_token } }), "merge");
  // A sent quote's lines and an order's lines refuse deletes; the purge is the one exception.
  const quote = ok(await call("POST", "/v1/ops/create_quote", { key: ops, body: { deal: dealId, lines: [{ description: "Thing", unit_price: 5 }] } }), "quote");
  const quoteId = (quote.json as { result: { quote: { id: string } } }).result.quote.id;
  ok(await call("POST", "/v1/ops/send_quote", { key: ops, body: { quote: quoteId } }), "send quote");
  ok(await call("POST", "/v1/ops/accept_quote", { key: ops, body: { quote: quoteId } }), "accept quote");
  const file = await app.request(`/v1/records/${contact.id}/files?name=pat.txt`, { method: "POST", headers: { Authorization: `Bearer ${ops}` },
    body: new TextEncoder().encode("Pat's file") });
  if (file.status !== 201) throw new Error(`file: ${file.status}`);
  ok(await call("POST", "/v1/objects", { key: admin, body: { api_name: "pet", fields: [{ api_name: "name", type: "text" },
    { api_name: "keeper", type: "relation", options: { to: "contact", cardinality: "many_to_many" } }] } }), "object");
  await create(ops, "pet", { name: "Rex", keeper: [contact.id] });
  ok(await call("POST", "/v1/webhooks", { key: admin, body: { url: "https://hooks.example/purge", events: ["contact.*"] } }), "webhook");
  ok(await call("POST", "/v1/roles", { key: admin, body: { key: "limited", name: "Limited", permissions: ["records:read"], objects: { deal: { read: false } },
    fields: { contact: { phone: "none" } } } }), "role");
  await memberWithKey(ws, "member", ["ops:read"]);
  ok(await call("POST", "/v1/views", { key: ops, body: { object: "contact", name: "Mine" } }), "view");
  ok(await call("PUT", "/v1/me/preferences", { key: ops, body: { "ui.theme": "dark" } }), "preference");
  await signedIn(ws.ownerEmail, ws.id);
  return ws;
}

describe("the catalog rules the purge relies on", () => {
  it("every table with a tenant_id column refers to tenant_directory, which is how the purge finds it", async () => {
    const missing = await migrator<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'tenant_directory'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
        AND NOT EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
                        WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = 'tenant_directory'::regclass
                          AND cardinality(k.conkey) = 1 AND a.attname = 'tenant_id')`;
    expect(missing.map((r) => r.relname), "a tenant table without a foreign key to tenant_directory is never purged").toEqual([]);
  });

  it("every other table is one decided to hold no tenant's rows", async () => {
    const others = await migrator<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        AND (c.relname = 'tenant_directory' OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
      ORDER BY 1`;
    expect(others.map((r) => r.relname), "a new table without tenant_id: say here why it holds nothing of a workspace, or give it tenant_id").toEqual(NOT_TENANT_TABLES);
  });

  it("every trigger that fires before a row is deleted stands aside for a purge", async () => {
    const triggers = await migrator<{ tbl: string; tgname: string; src: string }[]>`
      SELECT c.relname AS tbl, t.tgname, p.prosrc AS src FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND (t.tgtype & 8) = 8 AND (t.tgtype & 2) = 2 AND (t.tgtype & 1) = 1`;
    expect(triggers.length).toBeGreaterThan(5);
    const deaf = triggers.filter((t) => !t.src.includes("app.purging()")).map((t) => `${t.tbl}.${t.tgname}`);
    expect(deaf, "a BEFORE DELETE row trigger must return OLD when app.purging(), or deleting a workspace fails or half-runs").toEqual([]);
  });

  it("the app role can't write a tombstone, delete audit rows, or pass itself off as the purge", async () => {
    const ws = await newWorkspace("Guards");
    await expect(db()`INSERT INTO deleted_workspaces (workspace_id, created_at, requested_at, requested_by_type, audit_rows, rows_deleted)
      VALUES (${ws.tenantId}, now(), now(), 'operator', 0, '{}')`).rejects.toThrow(/permission denied/);
    await expect(db()`DELETE FROM deleted_workspaces`).rejects.toThrow(/permission denied/);
    await expect(db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true), set_config('app.purging', 'on', true)`;
      await tx`DELETE FROM audit_log`;
    })).rejects.toThrow(/permission denied/);
    // The table's owner can't write a tombstone either: only the purge's own insert passes the policy.
    await expect(migrator`INSERT INTO deleted_workspaces (workspace_id, created_at, requested_at, requested_by_type, audit_rows, rows_deleted)
      VALUES (${ws.tenantId}, now(), now(), 'operator', 0, '{}')`).rejects.toThrow(/row-level security/);
    // Even a role that could delete is refused by the trigger: the setting alone is not the purge.
    await expect(migrator.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true), set_config('app.purging', 'on', true)`;
      await tx`DELETE FROM audit_log`;
    })).rejects.toThrow(/append-only/);
    // And the purge refuses bad arguments and an unsealed log.
    await expect(db()`SELECT app.purge_tenant(${ws.tenantId}, 'someone', NULL, now())`).rejects.toThrow(/invalid arguments/);
    await expect(db()`SELECT app.purge_tenant(${ws.tenantId}, 'operator', NULL, now())`).rejects.toThrow(/unsealed/);
    expect((await call("GET", "/v1/me", { key: ws.keys.admin })).status).toBe(200);
  });
});

describe("deleting a workspace", () => {
  it("removes every row of the workspace from every table and leaves another workspace exactly as it was", async () => {
    const a = await busyWorkspace("Purged");
    const b = await busyWorkspace("Kept");
    await sealAll();
    const before = await rowCounts(a.tenantId);
    // The fixture reaches most tables; the ones it doesn't are still deleted by the same statement (the catalog tests above).
    const filled = Object.entries(before).filter(([, n]) => n > 0).map(([t]) => t);
    for (const t of ["contacts", "leads", "deals", "activities", "tasks", "records", "record_links", "merges", "quotes", "quote_line_items", "orders",
      "order_line_items", "files", "file_blobs", "audit_log", "outbox_events", "api_keys", "sessions", "users", "roles", "role_object_permissions",
      "role_field_permissions", "views", "member_preferences", "webhooks", "tenant_keys", "tenants", "deal_stage_history", "sign_in_identities"]) {
      expect(filled, `the fixture should put rows in ${t}`).toContain(t);
    }
    const bBefore = await rowCounts(b.tenantId);

    const gone = await deleteWorkspaceNow(a.tenantId, { type: "operator" });

    const after = await rowCounts(a.tenantId);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    expect(await db()`SELECT 1 FROM tenant_directory WHERE tenant_id = ${a.tenantId}`).toHaveLength(0);
    expect(await rowCounts(b.tenantId)).toEqual(bBefore);
    expect((await call("GET", "/v1/objects/contact/records", { key: b.keys.ops })).json.data.length).toBeGreaterThan(0);
    expect((await verifyTenant(b.tenantId)).ok).toBe(true);

    // The deleted workspace's keys no longer open anything.
    expect((await call("GET", "/v1/me", { key: a.keys.admin })).status).toBe(401);

    // The tombstone: counts and the end of the audit chain, nothing of the customer's.
    expect(gone).toMatchObject({ id: a.id, requested_by_type: "operator" });
    expect(gone.audit_rows).toBe(before.audit_log! + 1); // the workspace.deleted entry itself
    expect(gone.audit_chain_pos).toBe(gone.audit_rows);
    expect(gone.audit_head_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(gone.rows_deleted.contacts).toBe(before.contacts);
    expect(gone.rows_deleted.tenant_directory).toBe(1);
    const [raw] = await db()`SELECT to_jsonb(d)::text AS row FROM deleted_workspaces d WHERE workspace_id = ${a.tenantId}`;
    expect(raw!.row).not.toMatch(/Purged|purge\.example|Pat/);
    const stored = JSON.parse((await blobStore().get(`deleted-workspaces/${a.tenantId}.json`))!) as Record<string, unknown>;
    expect(stored).toMatchObject({ workspace_id: a.tenantId, audit_head_hash: gone.audit_head_hash, audit_chain_pos: gone.audit_chain_pos });
    expect(await deletedWorkspace(b.tenantId)).toBeNull();

    // Deleting it again finds nothing.
    await expect(deleteWorkspaceNow(a.tenantId, { type: "operator" })).rejects.toMatchObject({ status: 404 });
  });

  it("deletes the bytes of files kept in an outside store, and rolls everything back if that store fails", async () => {
    const deleted: string[] = [];
    let fail = true;
    const kept = new Map<string, Buffer>();
    const store: FileStore = { name: "s3", external: true,
      put: async (_tx, tenantId, fileId, data) => { kept.set(`${tenantId}/${fileId}`, data); },
      get: async (_tx, tenantId, fileId) => kept.get(`${tenantId}/${fileId}`) ?? null,
      delete: async (_tx, tenantId, fileId) => {
        if (fail) throw new Error("store unavailable");
        deleted.push(`${tenantId}/${fileId}`);
        kept.delete(`${tenantId}/${fileId}`);
      } };
    const { resetConfig: reset } = await import("../src/config.js");
    process.env.FILE_STORE = "s3";
    reset();
    setFileStore(store);
    try {
      const ws = await newWorkspace("Outside files");
      const contact = await create(ws.keys.ops, "contact", { first_name: "Flo" });
      const up = await app.request(`/v1/records/${contact.id}/files?name=flo.txt`, { method: "POST", headers: { Authorization: `Bearer ${ws.keys.ops}` },
        body: new TextEncoder().encode("Flo's file") });
      expect(up.status).toBe(201);
      expect(kept.size).toBe(1);
      await expect(deleteWorkspaceNow(ws.tenantId, { type: "operator" })).rejects.toThrow(/store unavailable/);
      expect((await call("GET", `/v1/objects/contact/records/${contact.id}`, { key: ws.keys.ops })).status).toBe(200);
      expect(await deletedWorkspace(ws.tenantId)).toBeNull();
      fail = false;
      await deleteWorkspaceNow(ws.tenantId, { type: "operator" });
      expect(deleted).toHaveLength(1);
      expect(deleted[0]).toMatch(new RegExp(`^${ws.tenantId}/`));
      expect(kept.size).toBe(0);
    } finally {
      setFileStore(null);
      delete process.env.FILE_STORE;
      reset();
    }
  });
});

describe("an owner asks for their workspace to be deleted", () => {
  afterEach(() => {
    delete process.env.WORKSPACE_DELETION_GRACE_DAYS;
    resetConfig();
  });

  it("needs an owner in person and the workspace's name; waits out the grace period; can be withdrawn", async () => {
    const ws = await newWorkspace("Owner asks");
    const body = { confirm_name: ws.name };
    // Not an ops key (admin routes need the admin scope), not an admin who isn't an owner, not an MCP server.
    expect((await call("POST", "/v1/workspace/deletion", { key: ws.keys.ops, body })).status).toBe(403);
    const admin = await memberWithKey(ws, "admin", ["admin", "ops:read"]);
    const refused = await call("POST", "/v1/workspace/deletion", { key: admin.key, body });
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toMatch(/Only an owner/);
    for (const surface of ["admin-mcp", "ops-mcp"]) {
      const viaMcp = await call("POST", "/v1/workspace/deletion", { key: ws.keys.admin, body, headers: { "X-Hlcrm-Surface": surface } });
      expect(viaMcp.status, surface).toBe(403);
    }
    // The name, exactly.
    expect((await call("POST", "/v1/workspace/deletion", { key: ws.keys.admin, body: { confirm_name: ws.name.toUpperCase() } })).status).toBe(422);
    expect((await call("GET", "/v1/workspace", { key: ws.keys.ops })).json.data.deletion).toBeNull();

    const asked = await call("POST", "/v1/workspace/deletion", { key: ws.keys.admin, body });
    expect(asked.status, JSON.stringify(asked.json)).toBe(202);
    const due = new Date(asked.json.data.scheduled_for).getTime();
    expect(Math.round((due - Date.now()) / 86_400_000)).toBe(7);
    expect(asked.json.data.requested_by).toBe(ws.ownerId);
    // Every member can see it coming, and the workspace works as before.
    expect((await call("GET", "/v1/workspace", { key: ws.keys.ops })).json.data.deletion).toMatchObject({ scheduled_for: asked.json.data.scheduled_for });
    await create(ws.keys.ops, "contact", { first_name: "Still", last_name: "Working" });
    expect((await call("POST", "/v1/workspace/deletion", { key: ws.keys.admin, body })).status).toBe(409);
    // Not due, so the worker leaves it.
    expect(await purgeDueWorkspaces()).toBe(0);
    expect((await call("GET", "/v1/me", { key: ws.keys.admin })).status).toBe(200);

    // Withdrawn: by an owner only.
    expect((await call("DELETE", "/v1/workspace/deletion", { key: admin.key })).status).toBe(403);
    const cancelled = await call("DELETE", "/v1/workspace/deletion", { key: ws.keys.admin });
    expect(cancelled.status).toBe(200);
    expect((await call("GET", "/v1/workspace", { key: ws.keys.ops })).json.data.deletion).toBeNull();
    expect((await call("DELETE", "/v1/workspace/deletion", { key: ws.keys.admin })).status).toBe(409);
    const log = await call("GET", "/v1/audit-log?limit=20", { key: ws.keys.admin });
    const actions = (log.json.data as { action: string }[]).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["workspace.deletion_scheduled", "workspace.deletion_cancelled"]));
  });

  it("a signed-in owner can ask too, from a browser session", async () => {
    const ws = await newWorkspace("Browser asks");
    const b = await signedIn(ws.ownerEmail, ws.id);
    const asked = await b.request("POST", "/v1/workspace/deletion", { body: { confirm_name: ws.name } });
    expect(asked.status, asked.text).toBe(202);
    expect((await b.request("DELETE", "/v1/workspace/deletion")).status).toBe(200);
  });

  it("with no grace period the worker deletes it on its next pass, and a withdrawn request is never carried out", async () => {
    process.env.WORKSPACE_DELETION_GRACE_DAYS = "0";
    resetConfig();
    const ws = await newWorkspace("No grace");
    const kept = await newWorkspace("Withdrawn");
    await create(ws.keys.ops, "contact", { first_name: "Gone", last_name: "Soon" });
    expect((await call("POST", "/v1/workspace/deletion", { key: kept.keys.admin, body: { confirm_name: kept.name } })).status).toBe(202);
    expect((await call("DELETE", "/v1/workspace/deletion", { key: kept.keys.admin })).status).toBe(200);
    expect((await call("POST", "/v1/workspace/deletion", { key: ws.keys.admin, body: { confirm_name: ws.name } })).status).toBe(202);
    expect(await purgeDueWorkspaces()).toBe(1);
    expect((await call("GET", "/v1/me", { key: ws.keys.admin })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: kept.keys.admin })).status).toBe(200);
    const gone = await deletedWorkspace(ws.tenantId);
    expect(gone).toMatchObject({ id: ws.id, requested_by_type: "owner" });
    const [raw] = await db()`SELECT requested_by FROM deleted_workspaces WHERE workspace_id = ${ws.tenantId}`;
    expect(raw!.requested_by).toBeTruthy();
    expect(await purgeDueWorkspaces()).toBe(0);
  });
});

describe("the operator's delete-workspace command", () => {
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "delete-workspace", ...args], { cwd: SERVER, encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "silent" } });

  it("wants the workspace ID twice, and deletes at once", async () => {
    const ws = await newWorkspace("Operator");
    const missing = run(["--workspace", ws.id]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/Usage: delete-workspace/);
    const mismatch = run(["--workspace", ws.id, "--confirm", "ws_other"]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toMatch(/--confirm must repeat/);
    expect((await call("GET", "/v1/me", { key: ws.keys.admin })).status).toBe(200);

    const done = run(["--workspace", ws.id, "--confirm", ws.id]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(new RegExp(`Deleted workspace ${ws.id}: \\d+ rows in \\d+ tables`));
    expect((await call("GET", "/v1/me", { key: ws.keys.admin })).status).toBe(401);
    const again = run(["--workspace", ws.id, "--confirm", ws.id]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/not found/);
  });
});
