import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { routes } from "../src/api/registry.js";
import { processEvents } from "../src/worker/events.js";
import { decodeId, encodeId, uuidv7 } from "../src/lib/ids.js";
import { app, call, create, newWorkspace, signedIn, type Browser, type Workspace } from "./helpers.js";

/**
 * Cross-tenant harness. Tenant A's keys are pointed at tenant B's records through every route
 * that takes an ID, and through every operation that takes IDs in its body. Every attempt must
 * fail without revealing B's data. A meta-test fails when a route is added without a case here.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

let a: Workspace;
let b: Workspace;
let bBrowser: Browser;
const bIds: Record<string, string> = {};

/** Routes that take no record IDs anywhere: they can only ever see the caller's own workspace. */
const NO_ID_ROUTES = new Set([
  "GET /v1/me", "GET /v1/me/access", "GET /v1/workspace", "PATCH /v1/workspace/modules", "GET /v1/schema", "GET /v1/schema/changes",
  "GET /v1/objects", "GET /v1/objects/:object", "POST /v1/objects", "PATCH /v1/objects/:object",
  "POST /v1/objects/:object/fields", "PATCH /v1/objects/:object/fields/:field", "POST /v1/objects/:object/fields/:field/archive",
  "GET /v1/pipelines", "POST /v1/pipelines", "GET /v1/objects/:object/records", "GET /v1/search", "GET /v1/me/tasks",
  "GET /v1/members", "GET /v1/api-keys", "GET /v1/audit-log", "GET /v1/audit/verify",
  "GET /v1/access-review", "GET /v1/permissions", "GET /v1/roles", "GET /v1/permission-sets",
  "GET /v1/webhooks", "POST /v1/webhooks", "GET /v1/automations",
  "GET /v1/me/notifications", "GET /v1/me/attention", "GET /v1/me/notification-preferences", "PATCH /v1/me/notification-preferences",
  "GET /v1/me/alerts", "GET /v1/alerts", "GET /v1/schema/export", "GET /v1/objects/:object/export",
  // The caller's own session and password, and this workspace's sign-in setting.
  "GET /v1/auth/session", "POST /v1/auth/sign-out", "GET /v1/auth/sessions", "POST /v1/auth/sessions/revoke-others",
  "POST /v1/auth/password", "DELETE /v1/auth/password", "DELETE /v1/auth/sso", "PATCH /v1/workspace/sign-in",
  // Views and preferences listed for the caller, and the caller's own workspace directory.
  "GET /v1/views", "GET /v1/objects/:object/views", "GET /v1/users", "GET /v1/me/preferences", "PUT /v1/me/preferences",
  "POST /v1/objects/:object/duplicates",
  // The caller's own connected apps (OAuth for MCP).
  "GET /v1/auth/apps",
  // Automation settings and the email suppression list (addresses, not IDs), and a draft schedule's preview.
  "GET /v1/automation-settings", "PATCH /v1/automation-settings", "POST /v1/automations/schedule-preview",
  "POST /v1/email-suppressions", "POST /v1/email-suppressions/check", "POST /v1/email-suppressions/remove",
  // Schema packs: bodies and paths name things (pack, object, field, role and view names), never IDs; what a pack owns is looked up in the caller's workspace.
  "GET /v1/packs", "POST /v1/packs/plan", "POST /v1/packs/apply", "POST /v1/packs/:name/uninstall",
]);

/** Routes whose request bodies carry IDs; each has explicit cases below. */
const BODY_ID_ROUTES = new Set([
  "POST /v1/objects/:object/records", "POST /v1/objects/:object/records/batch", "POST /v1/query",
  "POST /v1/ops/capture_interest", "POST /v1/ops/convert_lead", "POST /v1/ops/move_deal_stage", "POST /v1/ops/assign_owner",
  "POST /v1/ops/log_activity", "POST /v1/api-keys", "POST /v1/members", "POST /v1/service-accounts", "POST /v1/roles", "POST /v1/permission-sets", "POST /v1/automations", "POST /v1/automations/test", "GET /v1/events",
  "POST /v1/me/alerts", "POST /v1/me/alerts/backtest", "POST /v1/alerts", "POST /v1/alerts/backtest",
  "POST /v1/schema/plan", "POST /v1/schema/apply", "POST /v1/objects/:object/import", "POST /v1/aggregate", "POST /v1/views",
  "POST /v1/ops/merge_records", "POST /v1/objects/:object/records/bulk_update", "POST /v1/objects/:object/records/bulk_archive",
  // Takes a member ID in its query (?member=usr_…); its case is below.
  "GET /v1/apps",
]);

beforeAll(async () => {
  a = await newWorkspace("Tenant A");
  b = await newWorkspace("Tenant B");
  const acct = await create(b.keys.ops, "account", { name: "B Secret Corp", domain: "b-secret.example" });
  const contact = await create(b.keys.ops, "contact", { first_name: "Bea", email: "bea@b-secret.example", account: acct.id });
  const deal = await create(b.keys.ops, "deal", { name: "B deal", primary_contact: contact.id });
  const lead = await create(b.keys.ops, "lead", { contact: contact.id, status: "qualified" });
  const keys = await call("GET", "/v1/api-keys", { key: b.keys.admin });
  const hook = await call("POST", "/v1/webhooks", { key: b.keys.admin, body: { url: "https://b-secret.example/hook", events: ["contact.*"] } });
  const auto = await call("POST", "/v1/automations", { key: b.keys.admin, body: {
    name: "B Secret automation", trigger: { event: "contact.created" }, actions: [{ type: "send_webhook", webhook: hook.json.data.id }] } });
  await create(b.keys.ops, "contact", { first_name: "Bea2", email: "bea2@b-secret.example" });
  const role = await call("POST", "/v1/roles", { key: b.keys.admin, body: { key: "b_secret_role", name: "B Secret role", permissions: ["records:read"] } });
  const svc = await call("POST", "/v1/service-accounts", { key: b.keys.admin, body: { name: "B Secret bot", role: role.json.data.id } });
  const rules = await call("PATCH", `/v1/roles/${role.json.data.id}`, { key: b.keys.admin, body: {
    objects: { deal: { read: false } }, fields: { contact: { email: "none" } } } });
  if (rules.status !== 200) throw new Error(`setup: rules ${JSON.stringify(rules.json)}`);
  const pset = await call("POST", "/v1/permission-sets", { key: b.keys.admin, body: { key: "b_secret_set", name: "B Secret set", objects: { deal: { read: true } } } });
  if (pset.status !== 201) throw new Error(`setup: permission set ${JSON.stringify(pset.json)}`);
  bIds.permission_set = pset.json.data.id;
  const alert = await call("POST", "/v1/alerts", { key: b.keys.admin, body: {
    name: "B Secret alert", object: "contact", trigger: { type: "event", event: "contact.created" }, recipients: { record_owner: true } } });
  await create(b.keys.ops, "contact", { first_name: "Bea3", email: "bea3@b-secret.example" });
  await processEvents(b.tenantId);
  const inbox = await call("GET", "/v1/me/notifications", { key: b.keys.ops });
  const deliveries = await call("GET", `/v1/webhooks/${hook.json.data.id}/deliveries`, { key: b.keys.admin });
  if (!role.json.data?.id || !svc.json.data?.id || !auto.json.automation?.id || !deliveries.json.data?.[0]?.id || !alert.json.alert?.id || !inbox.json.data?.[0]?.id) {
    throw new Error("setup: tenant B needs an automation, a delivery, an alert and a notification");
  }
  bBrowser = await signedIn(b.ownerEmail);
  bIds.session = (await bBrowser.request("GET", "/v1/auth/session")).json.session.id;
  const view = await call("POST", "/v1/views", { key: b.keys.ops, body: { object: "contact", name: "B Secret view", shared: true,
    where: { field: "email", op: "eq", value: "bea@b-secret.example" } } });
  if (view.status !== 201) throw new Error(`setup: view ${JSON.stringify(view.json)}`);
  bIds.view = view.json.data.id;
  // An app B's owner connected over OAuth (the full flow is in test/oauth.test.ts; here only the row matters).
  const grant = uuidv7();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${b.tenantId}, true)`;
    await tx`INSERT INTO oauth_grants (tenant_id, id, user_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, expires_at)
             VALUES (${b.tenantId}, ${grant}, ${decodeId(b.ownerId)!.uuid}, 'oac_bsecret', 'B Secret app', 'registered', 'https://b-secret.example/cb',
                     ${["ops:read"]}, 'https://mcp.test/mcp/ops', now() + interval '1 day')`;
  });
  bIds.grant = encodeId("ogr", grant);
  const bSchema = (await call("GET", "/v1/schema/export", { key: b.keys.admin })).json;
  const bContact = bSchema.objects.find((o: { name: string }) => o.name === "contact");
  Object.assign(bIds, { contactObject: bContact.id, emailField: bContact.fields.find((f: { name: string }) => f.name === "email").id,
    pipeline: bSchema.pipelines[0].id, stage: bSchema.pipelines[0].stages[0].id });
  Object.assign(bIds, { account: acct.id, contact: contact.id, deal: deal.id, lead: lead.id, key: keys.json.data[0].id, user: b.ownerId,
    webhook: hook.json.data.id, automation: auto.json.automation.id, delivery: deliveries.json.data[0].id,
    alert: alert.json.alert.id, notification: inbox.json.data[0].id, role: role.json.data.id, service_account: svc.json.data.id });
});

function expectNoLeak(r: { status: number; json: unknown }) {
  expect([403, 404, 422]).toContain(r.status);
  expect(JSON.stringify(r.json)).not.toMatch(/B Secret|bea@b-secret|Bea/);
}

describe("cross-tenant isolation", () => {
  // The route-wide cases spend most of one key's 200-token burst (more with every merged branch's routes):
  // each case starts with a full bucket, so a 429 never stands in for the refusal being tested.
  beforeEach(() => resetRateLimiter());
  it("every route is classified for this harness", () => {
    const unclassified = routes
      .map((r) => `${r.method} ${r.path}`)
      .filter((k, i) => !NO_ID_ROUTES.has(k) && !BODY_ID_ROUTES.has(k) && !routes[i]!.idParams);
    expect(unclassified).toEqual([]);
  });

  it("path IDs from another tenant are not found, on every route that takes one", async () => {
    let checked = 0;
    for (const r of routes.filter((x) => x.idParams)) {
      for (const [object, id] of Object.entries({ contact: bIds.contact, account: bIds.account, deal: bIds.deal })) {
        const kind = Object.values(r.idParams!)[0];
        const byKind: Record<string, string | undefined> = { key: bIds.key, webhook: bIds.webhook, automation: bIds.automation, delivery: bIds.delivery,
          alert: bIds.alert, notification: bIds.notification, member: bIds.user, service_account: bIds.service_account, role: bIds.role,
          permission_set: bIds.permission_set, session: bIds.session, view: bIds.view, grant: bIds.grant };
        const path = r.path.replace(":object", object).replace(":id", byKind[kind!] ?? id!);
        const body = r.method === "GET" || r.method === "DELETE" ? undefined : r.path.endsWith("/records/:id") ? { name: "x" }
          : r.path.endsWith("/test") && r.path.includes("automations") ? { record: bIds.contact }
          : r.path.endsWith("/snooze") ? { until: new Date(Date.now() + 3_600_000).toISOString() }
          : kind === "member" || kind === "service_account" ? { active: false } : {};
        const res = await call(r.method, path, { key: a.keys.admin, body });
        expectNoLeak(res);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(54);
  });

  it("IDs from another tenant in request bodies are rejected", async () => {
    const cases: [string, string, unknown][] = [
      ["POST", "/v1/objects/contact/records", { email: "x@a.example", account: bIds.account }],
      ["POST", "/v1/objects/deal/records/batch", { records: [{ name: "x", primary_contact: bIds.contact }] }],
      ["POST", "/v1/objects/lead/records", { contact: bIds.contact }],
      ["POST", "/v1/query", { object: "contact", where: { field: "account", op: "eq", value: bIds.account } }],
      ["POST", "/v1/query", { object: "contact", where: { field: "id", op: "eq", value: bIds.contact } }],
      ["POST", "/v1/ops/convert_lead", { lead: bIds.lead }],
      ["POST", "/v1/ops/move_deal_stage", { deal: bIds.deal, stage: "Proposal" }],
      ["POST", "/v1/ops/assign_owner", { record: bIds.contact, owner: bIds.user }],
      ["POST", "/v1/ops/log_activity", { type: "note", related_to: [bIds.contact] }],
      ["POST", "/v1/ops/capture_interest", { email: "bea@b-secret.example" }],
      ["POST", "/v1/api-keys", { name: "x", scopes: ["ops:read"], owner: bIds.user }],
      ["POST", "/v1/api-keys", { name: "x", scopes: ["ops:read"], owner: bIds.service_account }],
      ["POST", "/v1/members", { email: "x@a.example", name: "x", role: bIds.role }],
      ["POST", "/v1/service-accounts", { name: "x", role: bIds.role }],
      ["POST", "/v1/roles", { key: "copied", name: "x", copy_from: bIds.role }],
      ["POST", "/v1/permission-sets", { key: "copied_set", name: "x", copy_from: bIds.permission_set }],
      ["POST", "/v1/members", { email: "y@a.example", name: "y", role: "member", permission_sets: [bIds.permission_set] }],
      ["POST", "/v1/service-accounts", { name: "y", role: "member", permission_sets: [bIds.permission_set] }],
      ["POST", "/v1/automations", { name: "x", trigger: { event: "contact.created" }, actions: [{ type: "send_webhook", webhook: bIds.webhook }] }],
      ["POST", "/v1/automations", { name: "x", trigger: { event: "contact.created" }, condition: { field: "account", op: "eq", value: bIds.account },
        actions: [{ type: "update_record", values: { first_name: "x" } }] }],
      ["POST", "/v1/automations/test", { record: bIds.contact, automation: { name: "x", trigger: { event: "contact.created" }, actions: [{ type: "update_record", values: { first_name: "x" } }] } }],
      ["GET", `/v1/events?record=${bIds.contact}`, undefined],
      ["GET", `/v1/apps?member=${bIds.user}`, undefined],
      ["POST", "/v1/alerts", { name: "x", object: "contact", trigger: { type: "event", event: "contact.created" }, recipients: { users: [bIds.user] } }],
      ["POST", "/v1/alerts", { name: "x", object: "contact", trigger: { type: "event", event: "contact.created" }, webhooks: [bIds.webhook] }],
      ["POST", "/v1/alerts/backtest", { name: "x", object: "contact", trigger: { type: "event", event: "contact.created" }, recipients: { users: [bIds.user] } }],
      ["POST", "/v1/me/alerts", { name: "x", object: "contact", trigger: { type: "inactive", days: 3 }, condition: { field: "account", op: "eq", value: bIds.account } }],
      ["POST", "/v1/me/alerts/backtest", { name: "x", object: "contact", trigger: { type: "inactive", days: 3 }, condition: { field: "id", op: "eq", value: bIds.contact } }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(method, path, { key: a.keys.admin, body });
      if (path.startsWith("/v1/events")) {
        expect(res.status).toBe(200);
        expect(res.json.data).toEqual([]);
      } else if (path.startsWith("/v1/me/alerts")) {
        // A condition naming another tenant's record is valid; it can never match here, so the backtest finds nothing.
        expect([200, 201]).toContain(res.status);
        expect(JSON.stringify(res.json)).not.toMatch(/B Secret|bea@b-secret|Bea/);
        expect(res.json.backtest?.samples ?? res.json.data?.backtest?.samples).toEqual([]);
      } else if (path === "/v1/automations" && JSON.stringify(body).includes("condition")) {
        // A condition naming another tenant's record is valid syntax; it simply can never match here.
        expect([200, 201]).toContain(res.status);
        expect(JSON.stringify(res.json)).not.toMatch(/B Secret|bea@b-secret/);
      } else if (path === "/v1/query") {
        expect(res.status).toBe(200);
        expect(res.json.data).toEqual([]);
      } else if (path === "/v1/ops/capture_interest") {
        // Same email in another tenant is a different person here: A gets a new contact, never B's.
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.json)).not.toContain(bIds.contact);
      } else {
        expectNoLeak(res);
      }
    }
    // Aggregates and saved filters naming another tenant's records are valid; they never match here.
    const agg = await call("POST", "/v1/aggregate", { key: a.keys.admin, body: { object: "contact", where: { field: "account", op: "eq", value: bIds.account },
      group_by: [{ field: "account" }] } });
    expect(agg.status).toBe(200);
    expect(agg.json.data).toEqual([]);
    const saved = await call("POST", "/v1/views", { key: a.keys.ops, body: { object: "contact", name: "x", where: { field: "account", op: "eq", value: bIds.account } } });
    expect(saved.status).toBe(201);
    expect((await call("GET", `/v1/objects/contact/records?view=${saved.json.data.id}`, { key: a.keys.ops })).json.data).toEqual([]);
    // Another tenant's view can't be run, listed or read.
    for (const [method, path, body] of [["POST", "/v1/query", { object: "contact", view: bIds.view }], ["POST", "/v1/aggregate", { view: bIds.view }],
      ["GET", `/v1/objects/contact/records?view=${bIds.view}`, undefined], ["GET", `/v1/objects/contact/export?view=${bIds.view}`, undefined]] as const) {
      const res = await call(method, path, { key: a.keys.admin, body });
      expect(res.status, path).toBe(404);
      expect(JSON.stringify(res.json)).not.toMatch(/B Secret|bea@b-secret/);
    }
    expect(JSON.stringify((await call("GET", "/v1/views", { key: a.keys.admin })).json)).not.toMatch(/B Secret|bea@b-secret/);
  });

  it("in SQL, RLS hides another tenant's object and field rules, WITH CHECK refuses writing them, and the FKs refuse pointing at theirs", async () => {
    const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        return fn(tx);
      }) as Promise<T>;
    const bRole = decodeId(bIds.role!)!.uuid;
    const counts = (tenant: string) => inTenant(tenant, (tx) => tx<{ o: number; f: number }[]>`
      SELECT (SELECT count(*) FROM role_object_permissions WHERE role_id = ${bRole})::int AS o,
             (SELECT count(*) FROM role_field_permissions WHERE role_id = ${bRole})::int AS f`);
    expect((await counts(b.tenantId))[0]).toEqual({ o: 1, f: 1 });
    expect((await counts(a.tenantId))[0]).toEqual({ o: 0, f: 0 });
    const [bObject] = await inTenant(b.tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM objects WHERE api_name = 'account'`);
    const [bField] = await inTenant(b.tenantId, (tx) => tx<{ id: string }[]>`SELECT f.id FROM fields f JOIN objects o ON o.id = f.object_id WHERE o.api_name = 'account' AND f.api_name = 'name'`);
    const [aRole] = await inTenant(a.tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM roles WHERE key = 'read_only'`);
    const [aObject] = await inTenant(a.tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM objects WHERE api_name = 'account'`);
    // Writing a row tagged with B's tenant, from A, is refused by WITH CHECK.
    await expect(inTenant(a.tenantId, (tx) => tx`
      INSERT INTO role_object_permissions (tenant_id, role_id, object_id, can_read) VALUES (${b.tenantId}, ${bRole}, ${bObject!.id}, true)`)).rejects.toThrow(/row-level security/);
    await expect(inTenant(a.tenantId, (tx) => tx`
      INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access) VALUES (${b.tenantId}, ${bRole}, ${bField!.id}, 'none')`)).rejects.toThrow(/row-level security/);
    // A's rows can't point at B's role, object or field.
    await expect(inTenant(a.tenantId, (tx) => tx`
      INSERT INTO role_object_permissions (tenant_id, role_id, object_id, can_read) VALUES (${a.tenantId}, ${bRole}, ${aObject!.id}, true)`)).rejects.toThrow(/foreign key/);
    await expect(inTenant(a.tenantId, (tx) => tx`
      INSERT INTO role_object_permissions (tenant_id, role_id, object_id, can_read) VALUES (${a.tenantId}, ${aRole!.id}, ${bObject!.id}, true)`)).rejects.toThrow(/foreign key/);
    await expect(inTenant(a.tenantId, (tx) => tx`
      INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access) VALUES (${a.tenantId}, ${aRole!.id}, ${bField!.id}, 'none')`)).rejects.toThrow(/foreign key/);
    // Updates and deletes from A reach none of B's rules.
    expect(await inTenant(a.tenantId, (tx) => tx`UPDATE role_object_permissions SET can_read = true WHERE role_id = ${bRole} RETURNING 1`)).toHaveLength(0);
    expect(await inTenant(a.tenantId, (tx) => tx`DELETE FROM role_field_permissions WHERE role_id = ${bRole} RETURNING 1`)).toHaveLength(0);
    expect((await counts(b.tenantId))[0]).toEqual({ o: 1, f: 1 });
    // Through the API, B's role and its access view are not found from A.
    for (const path of [`/v1/roles/${bIds.role}`, `/v1/roles/${bIds.role}/access`]) expect((await call("GET", path, { key: a.keys.admin })).status).toBe(404);
  });

  it("schema documents carrying another tenant's IDs only ever match this workspace, by name", async () => {
    const document = {
      objects: [{ id: bIds.contactObject, name: "contact", fields: [{ id: bIds.emailField, name: "email", type: "email", label: "Cross-tenant label" }] }],
      pipelines: [{ id: bIds.pipeline, name: "Sales", stages: [{ id: bIds.stage, name: "Cross-tenant stage" }] }],
    };
    const p = await call("POST", "/v1/schema/plan", { key: a.keys.admin, body: { document } });
    expect(p.status).toBe(200);
    expect(p.json.matched_by_name).toEqual(expect.arrayContaining([{ path: "objects.contact", reason: "its id is not in this workspace" }]));
    expect(JSON.stringify(p.json)).not.toMatch(/B Secret|bea@b-secret/);
    const r = await call("POST", "/v1/schema/apply", { key: a.keys.admin, body: { document, accept_drift: true } });
    expect(r.status).toBe(200);
    const bAfter = (await call("GET", "/v1/schema/export", { key: b.keys.admin })).json;
    const bEmail = bAfter.objects.find((o: { name: string }) => o.name === "contact").fields.find((f: { name: string }) => f.name === "email");
    expect(bEmail.label).not.toBe("Cross-tenant label");
    expect(JSON.stringify(bAfter.pipelines)).not.toContain("Cross-tenant stage");
    const aAfter = (await call("GET", "/v1/schema/export", { key: a.keys.admin })).json;
    expect(JSON.stringify(aAfter)).toContain("Cross-tenant label");
  });

  it("imports cannot reach another tenant's records, by ID or by lookup", async () => {
    const onlyB = `b-only-${Date.now()}.example`;
    await create(b.keys.ops, "account", { name: "B Secret Only", domain: onlyB });
    for (const [csv, mapping] of [
      [`email,account\nx1@a.example,${bIds.account}\n`, {}],
      [`email,account\nx2@a.example,${onlyB}\n`, { account: "account.domain" }],
      [`id,first_name\n${bIds.contact},Hijack\n`, {}],
    ] as const) {
      const res = await call("POST", "/v1/objects/contact/import", { key: a.keys.admin, body: { csv, mapping, dry_run: false } });
      expectNoLeak(res);
    }
    const exp = await app.request(`/v1/objects/contact/export?filter[account]=${bIds.account}`, { headers: { Authorization: `Bearer ${a.keys.admin}` } });
    expect(exp.status).toBe(200);
    expect(await exp.text()).not.toMatch(/Bea|b-secret/);
  });

  it("a browser session reaches only its own workspace: not another tenant's records, members or sessions", async () => {
    const aBrowser = await signedIn(a.ownerEmail);
    for (const [method, path] of [["GET", `/v1/records/${bIds.contact}`], ["GET", `/v1/members/${bIds.user}/sessions`],
      ["POST", `/v1/members/${bIds.user}/sessions/revoke`], ["DELETE", `/v1/sessions/${bIds.session}`], ["PATCH", `/v1/members/${bIds.user}`],
      ["DELETE", `/v1/auth/apps/${bIds.grant}`], ["DELETE", `/v1/apps/${bIds.grant}`], ["GET", `/v1/apps?member=${bIds.user}`]] as const) {
      const r = await aBrowser.request(method, path, method === "PATCH" ? { body: { active: false } } : {});
      expectNoLeak(r);
    }
    expect(JSON.stringify((await aBrowser.request("GET", "/v1/search?q=b-secret")).json)).not.toContain(bIds.contact);
    // B's session is untouched.
    expect((await bBrowser.request("GET", "/v1/me")).status).toBe(200);
    // A's admin sees none of B's sessions, and B's session cookie gives nothing in A.
    expect(JSON.stringify((await call("GET", "/v1/access-review", { key: a.keys.admin })).json)).not.toContain(b.ownerEmail);
    expect((await bBrowser.request("GET", "/v1/me")).json.actor.id).toBe(b.ownerId);
    // B's connected app is untouched, and appears in no list A can read.
    expect((await bBrowser.request("GET", "/v1/auth/apps")).json.data.map((g: { id: string }) => g.id)).toEqual([bIds.grant]);
    expect(JSON.stringify((await aBrowser.request("GET", "/v1/auth/apps")).json)).not.toMatch(/B Secret/);
  });

  it("merges, bulk changes and the duplicate finder never reach another tenant's records", async () => {
    const mine = await create(a.keys.ops, "contact", { first_name: "Ann", email: `ann-${Date.now()}@a.example` });
    for (const body of [
      { survivor: mine.id, duplicates: [bIds.contact] },
      { survivor: bIds.contact, duplicates: [mine.id] },
    ]) expectNoLeak(await call("POST", "/v1/ops/merge_records", { key: a.keys.admin, body }));
    // A real run needs a dry run's token, which a merge reaching another tenant never gets: refused before any lookup.
    const real = await call("POST", "/v1/ops/merge_records", { key: a.keys.admin, body: { survivor: mine.id, duplicates: [bIds.contact], dry_run: false } });
    expect(real.status).toBe(400);
    expect(JSON.stringify(real.json)).not.toMatch(/B Secret|bea@b-secret|Bea/);
    for (const op of ["bulk_update", "bulk_archive"]) {
      const res = await call("POST", `/v1/objects/contact/records/${op}`, { key: a.keys.admin, body: { ids: [bIds.contact], values: op === "bulk_update" ? { first_name: "Hijack" } : undefined, dry_run: false } });
      expectNoLeak(res);
      const byFilter = await call("POST", `/v1/objects/contact/records/${op}`, { key: a.keys.admin,
        body: { where: { field: "account", op: "eq", value: bIds.account }, ...(op === "bulk_update" ? { values: { first_name: "Hijack" } } : {}) } });
      expect(byFilter.status).toBe(200);
      expect(byFilter.json.count).toBe(0);
    }
    const restored = await call("POST", `/v1/objects/contact/records/${bIds.contact}/restore`, { key: a.keys.admin });
    expectNoLeak(restored);
    const dupes = await call("POST", "/v1/objects/contact/duplicates", { key: a.keys.admin, body: { fuzzy: true } });
    expect(dupes.status, JSON.stringify(dupes.json)).toBe(200);
    expect(JSON.stringify(dupes.json)).not.toMatch(/B Secret|bea@b-secret|Bea/);
    expect((await call("GET", `/v1/objects/contact/records/${bIds.contact}`, { key: b.keys.ops })).json.data).toMatchObject({ first_name: "Bea" });
  });

  it("schema packs: another tenant's installed pack is neither listed, uninstalled nor matched by its owned IDs", async () => {
    const pack = { manifest: { name: "b-secret-pack", version: "1.0.0", parts: ["schema"] },
      schema: { objects: [{ name: "b_secret_thing", fields: [{ name: "label", type: "text" }] }] } };
    const planned = async (key: string) => (await call("POST", "/v1/packs/plan", { key, body: { pack } })).json.plan_token as string;
    const bToken = await planned(b.keys.admin);
    // A plan_token is the planner's: another tenant's key can't apply with it.
    expect((await call("POST", "/v1/packs/apply", { key: a.keys.admin, body: { pack, plan_token: bToken } })).status).toBe(400);
    expect((await call("POST", "/v1/packs/apply", { key: b.keys.admin, body: { pack, plan_token: bToken } })).status).toBe(200);
    expect(JSON.stringify((await call("GET", "/v1/packs", { key: a.keys.admin })).json)).not.toContain("b-secret");
    expect((await call("POST", "/v1/packs/b-secret-pack/uninstall", { key: a.keys.admin, body: {} })).status).toBe(404);
    // The same pack in A is a fresh install of A's own: B's IDs are never reached.
    const mine = await call("POST", "/v1/packs/apply", { key: a.keys.admin, body: { pack, plan_token: await planned(a.keys.admin) } });
    expect(mine.status).toBe(200);
    expect(mine.json.action).toBe("install");
    expect((await call("GET", "/v1/packs", { key: b.keys.admin })).json.data).toEqual([expect.objectContaining({ name: "b-secret-pack", status: "installed" })]);
  });

  it("search never returns another tenant's records", async () => {
    const res = await call("GET", "/v1/search?q=b-secret", { key: a.keys.admin });
    expect(JSON.stringify(res.json.data)).not.toContain(bIds.account);
  });
});
