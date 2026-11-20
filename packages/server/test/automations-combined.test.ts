import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_LIMITS, resetAuthLimiter, resetRateLimiter } from "../src/api/app.js";
import { hit, LIMITS, resetSignInLimits } from "../src/auth/limits.js";
import { settleSignInTasks } from "../src/auth/signin.js";
import { runAutomationPass, runQueuedOnce, scheduleDue } from "../src/core/automation-runner.js";
import { runAutomationsForEvent } from "../src/core/automations.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId, uuidv7 } from "../src/lib/ids.js";
import { resetMcpLimiter } from "../src/mcp/http.js";
import { setMailer } from "../src/providers/mailer.js";
import { processEvents, processEventsRound } from "../src/worker/events.js";
import { Browser, call, create, FakeMailer, newWorkspace, signedIn, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";
import { asMcpProcess, connectApp, mcpClient, registerClient, tool } from "./oauth-client.js";

/**
 * The automation engine (step 5) together with people sign-in, the read and write sides and OAuth for MCP:
 * each credential kind running and managing automations, the dependency checks under scopes that narrow a
 * role, the write side's events (restore, merge, moved references, bulk changes) as triggers, the query
 * compiler in find_records, the email budgets, and the typed responses of the automation routes.
 */

const mailer = new FakeMailer();
let ws: Workspace;
let owner: Browser;
const appA = { clientId: "", redirectUri: "" };

beforeAll(async () => {
  setMailer(mailer);
  ws = await newWorkspace("Automations combined");
  owner = await signedIn(ws.ownerEmail);
  Object.assign(appA, await registerClient("Automations app"));
});
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
  resetMcpLimiter();
  resetRateLimiter();
});

/** Runs the worker until nothing is left for this tenant: events, then queued runs. */
async function drain(w: Workspace) {
  for (let i = 0; i < 60; i++) {
    const n = (await processEvents(w.tenantId)) + (await runQueuedOnce(w.tenantId) ? 1 : 0);
    if (n === 0) return;
  }
}

interface Run { id: string; status: string; reason: string | null; trigger: string; requested_by: string | null; requested_via: Record<string, string> | null;
  failure: string | null; cap: string | null; results: { step: string; action: string; ok: boolean; skipped?: string; detail: Record<string, unknown> }[] }
const runsOf = async (w: Workspace, id: string, limit = 200) =>
  (await call("GET", `/v1/automations/${id}/runs?limit=${limit}`, { key: w.keys.admin })).json.data as Run[];

async function automation(w: Workspace, body: Record<string, unknown>) {
  const r = await call("POST", "/v1/automations", { key: w.keys.admin, body });
  if (r.status !== 201) throw new Error(`create automation: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.automation as { id: string };
}

const grantOf = async (b: Browser) =>
  ((await b.request("GET", "/v1/auth/apps")).json.data as { id: string; client: { id: string } }[]).filter((g) => g.client.id === appA.clientId).map((g) => g.id);

/** A member with `role`, signed in in a browser. */
async function member(role: string) {
  const email = uniqueEmail(role);
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: `Combined ${role}`, role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  return { id: m.json.data.id as string, email, browser: await signedIn(email) };
}

describe("running on request with each kind of credential", () => {
  it("a key, a browser session (with its CSRF token) and an OAuth admin connection each queue runs, attributed to the member and the credential", async () => {
    const a = await automation(ws, { name: "Stamp", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "stamped" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Run", email: uniqueEmail("run") });
    const body = { records: [c.id] };

    expect((await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body })).status).toBe(202);
    // A session needs its CSRF token like every write.
    expect((await owner.request("POST", `/v1/automations/${a.id}/run`, { body, csrf: false })).status).toBe(403);
    const bySession = await owner.request("POST", `/v1/automations/${a.id}/run`, { body });
    expect(bySession.status, JSON.stringify(bySession.json)).toBe(202);
    const t = await connectApp(owner, appA, "admin", "admin ops:read ops:write");
    const byApp = await asMcpProcess(t.access_token, "admin", "POST", `/v1/automations/${a.id}/run`, body);
    expect(byApp.status, JSON.stringify(byApp.json)).toBe(202);
    await drain(ws);

    const runs = await runsOf(ws, a.id);
    expect(runs.map((r) => r.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    // requested_by names the member whatever the credential; requested_via names the credential (for OAuth, its grant and client).
    expect(new Set(runs.map((r) => r.requested_by))).toEqual(new Set([ws.ownerId]));
    const via = Object.fromEntries(runs.map((r) => [r.requested_via!.kind, r.requested_via!]));
    expect(Object.keys(via).sort()).toEqual(["key", "oauth", "session"]);
    expect(via.oauth).toMatchObject({ client: appA.clientId, surface: "admin-mcp" });
    expect(await grantOf(owner)).toContain(via.oauth!.grant);
    expect(via.session!.session).toMatch(/^ses_/);
    expect(via.key!.key).toMatch(/^key_/);
    // The audit log says the same: the member as actor, and the grant and client for the connected app.
    const audit = (await call("GET", "/v1/audit-log?action=automation.run_requested&limit=10", { key: ws.keys.admin })).json.data as
      { actor_id: string; surface: string; details: Record<string, unknown> }[];
    const fromApp = audit.find((e) => e.details.oauth_grant === via.oauth!.grant)!;
    expect(fromApp).toMatchObject({ surface: "admin-mcp", details: { oauth_client: appA.clientId, automation: a.id } });
    expect(audit.find((e) => e.details.session === via.session!.session)).toBeDefined();
    // The hourly cap counts runs, whoever asked.
    const capped = await automation(ws, { name: "Two an hour", trigger: { type: "manual", object: "contact" }, hourly_cap: 2, actions: [{ type: "update_record", values: { job_title: "x" } }] });
    expect((await call("POST", `/v1/automations/${capped.id}/run`, { key: ws.keys.admin, body })).status).toBe(202);
    expect((await owner.request("POST", `/v1/automations/${capped.id}/run`, { body })).status).toBe(202);
    expect((await asMcpProcess(t.access_token, "admin", "POST", `/v1/automations/${capped.id}/run`, body)).status).toBe(429);
    await drain(ws);
  });

  it("refuses an ops:read connection even when its member's role is in run_roles; ops:write runs only what the role may write", async () => {
    const clerkRole = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "clerk_ro_title", name: "Clerk", permissions: ["records:read", "records:write"],
      fields: { contact: { job_title: "read" } } } });
    expect(clerkRole.status, JSON.stringify(clerkRole.json)).toBe(201);
    const clerk = await member("clerk_ro_title");
    const c = await create(ws.keys.ops, "contact", { first_name: "Scoped", email: uniqueEmail("scoped") });
    const writesTitle = await automation(ws, { name: "Writes title", trigger: { type: "manual", object: "contact" }, run_roles: ["clerk_ro_title", "owner"],
      actions: [{ type: "update_record", values: { job_title: "set" } }] });
    const writesName = await automation(ws, { name: "Writes name", trigger: { type: "manual", object: "contact" }, run_roles: ["clerk_ro_title", "owner"],
      actions: [{ type: "update_record", values: { first_name: "Set" } }] });
    const body = { records: [c.id] };

    // ops:read: no records:write, so no run at all, for the clerk or even for the owner (whose role is in run_roles too).
    for (const b of [clerk.browser, owner]) {
      const ro = await connectApp(b, appA, "ops", "ops:read");
      for (const a of [writesTitle, writesName]) {
        const r = await asMcpProcess(ro.access_token, "ops", "POST", `/v1/automations/${a.id}/run`, body);
        expect(r.status, JSON.stringify(r.json)).toBe(403);
      }
    }
    // ops:write: the dependency and write checks use the member's record access, through a connection as through a session.
    const rw = await connectApp(clerk.browser, appA, "ops", "ops:read ops:write");
    const denied = await asMcpProcess(rw.access_token, "ops", "POST", `/v1/automations/${writesTitle.id}/run`, body);
    expect(denied.status).toBe(403);
    expect(denied.json.detail).toMatch(/can't write contact.job_title/);
    expect((await clerk.browser.request("POST", `/v1/automations/${writesTitle.id}/run`, { body })).status).toBe(403);
    const ok = await asMcpProcess(rw.access_token, "ops", "POST", `/v1/automations/${writesName.id}/run`, body);
    expect(ok.status, JSON.stringify(ok.json)).toBe(202);
    // A dry run shows what the automation would do with its own access: automations:manage only.
    expect((await asMcpProcess(rw.access_token, "ops", "POST", `/v1/automations/${writesName.id}/run`, { ...body, dry_run: true })).status).toBe(403);
    // Managing automations is admin: an ops connection can't reach those routes, nor the run log.
    expect((await asMcpProcess(rw.access_token, "ops", "GET", `/v1/automations/${writesName.id}/runs`)).status).toBe(403);
    expect((await asMcpProcess(rw.access_token, "ops", "POST", `/v1/automations/${writesName.id}/pause`, {})).status).toBe(403);
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.first_name).toBe("Set");
  });

  it("an admin connection manages automations through MCP: dry run first, then the run; pause and resume; MCP-only refusals key on the surface", async () => {
    const t = await connectApp(owner, appA, "admin", "admin ops:read ops:write");
    const mcp = await mcpClient("admin", t.access_token);
    const created = await tool(mcp, "create_automation", { name: "MCP stamp", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "update_record", values: { job_title: "via mcp" } }] });
    expect(created.isError, created.text).toBe(false);
    expect((created.result as { dry_run: boolean }).dry_run).toBe(true);
    const saved = await tool(mcp, "create_automation", { name: "MCP stamp", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "update_record", values: { job_title: "via mcp" } }], dry_run: false });
    const id = (saved.result as { automation: { id: string } }).automation.id;
    const c = await create(ws.keys.ops, "contact", { first_name: "Mcp", email: uniqueEmail("mcp") });

    const dry = await tool(mcp, "run_automation", { automation: id, records: [c.id] });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.result).toMatchObject({ dry_run: true, runs: [{ record: c.id }] });
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title).toBeNull();
    const real = await tool(mcp, "run_automation", { automation: id, records: [c.id], dry_run: false });
    expect(real.isError, real.text).toBe(false);
    expect((real.result as { runs: { status: string }[] }).runs[0]!.status).toBe("queued");
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("via mcp");
    expect((await runsOf(ws, id))[0]!.requested_via).toMatchObject({ kind: "oauth", surface: "admin-mcp" });

    expect((await tool(mcp, "pause_automation", { automation: id })).isError).toBe(false);
    expect((await asMcpProcess(t.access_token, "admin", "POST", `/v1/automations/${id}/run`, { records: [c.id] })).status).toBe(409);
    expect((await tool(mcp, "resume_automation", { automation: id })).isError).toBe(false);

    // A dry run is heavy: with no slot free the connection gets a 429, and the tool says when to retry.
    HEAVY_LIMITS.perCredential = 0;
    try {
      const busy = await tool(mcp, "run_automation", { automation: id, records: [c.id] });
      expect(busy.isError).toBe(true);
      expect(busy.text).toMatch(/Error 429 .*Retryable/s);
      expect(busy.meta).toMatchObject({ retryable: true });
    } finally {
      HEAVY_LIMITS.perCredential = 2;
    }

    // Email to non-members can't be turned on through MCP, nor an address taken off the suppression list:
    // refused for the connected app (whose surface its token fixes) and for a key that says it is MCP.
    const on = await asMcpProcess(t.access_token, "admin", "PATCH", "/v1/automation-settings", { external_email: true });
    expect(on.status).toBe(403);
    expect(on.json.detail).toMatch(/can't be turned on through MCP/);
    expect((await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true }, headers: { "X-Hlcrm-Surface": "admin-mcp" } })).status).toBe(403);
    expect((await asMcpProcess(t.access_token, "admin", "PATCH", "/v1/automation-settings", { timezone: "Europe/Paris" })).status).toBe(200);
    expect((await owner.request("PATCH", "/v1/automation-settings", { body: { external_email: true, timezone: "UTC" } })).json.data)
      .toEqual({ paused: false, paused_at: null, paused_reason: null, external_email: true, timezone: "UTC" });
    expect((await owner.request("PATCH", "/v1/automation-settings", { body: { external_email: false } })).status).toBe(200);
    const addr = uniqueEmail("optout");
    const sup = await tool(mcp, "suppress_email", { email: addr, reason: "asked" });
    expect(sup.isError, sup.text).toBe(false);
    expect((await asMcpProcess(t.access_token, "admin", "POST", "/v1/email-suppressions/remove", { email: addr })).status).toBe(403);
    expect((await call("POST", "/v1/email-suppressions/remove", { key: ws.keys.admin, body: { email: addr }, headers: { "X-Hlcrm-Surface": "admin-mcp" } })).status).toBe(403);
    expect((await call("POST", "/v1/email-suppressions/remove", { key: ws.keys.admin, body: { email: addr } })).json.data).toMatchObject({ removed: true });
    await mcp.close();
  });
});

describe("a schedule with find_records and send_email", () => {
  it("finds with several sort keys through the query compiler and skips a member whose role can't read a field the email uses", async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "no_title_mail", name: "No titles", permissions: ["records:read", "records:write"],
      fields: { contact: { job_title: "none" } } } });
    expect(role.status).toBe(201);
    const limited = await member("no_title_mail");
    const tag = `srt${Date.now()}`;
    for (const [first, last] of [["Amy", "Alpha"], ["Zed", "Alpha"], ["Bob", "Beta"]]) {
      await create(ws.keys.ops, "contact", { first_name: first, last_name: last, email: uniqueEmail(tag), source: tag, job_title: `${first}-title` });
    }
    const find = { type: "find_records", id: "f", object: "contact", where: { field: "source", op: "eq", value: tag },
      sort: [{ field: "last_name" }, { field: "first_name", dir: "desc" }], limit: 3 };
    // The sort is checked at save, by the compiler a run uses.
    const bad = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Bad sort", trigger: { type: "schedule", every: { hours: 1 } },
      actions: [{ ...find, sort: [{ field: "nope" }] }] } });
    expect(bad.status).toBe(422);
    expect(bad.json.detail).toMatch(/sort.*nope/);
    const a = await automation(ws, { name: "Morning list", trigger: { type: "schedule", every: { hours: 1 } }, actions: [find,
      { type: "send_email", to: { member: limited.id }, subject: "First: {{steps.f.first.first_name}}", body: "Title {{steps.f.first.job_title}}" },
      { type: "send_email", to: { member: ws.ownerId }, subject: "First: {{steps.f.first.first_name}} {{steps.f.first.last_name}} of {{steps.f.count}}",
        body: "Title {{steps.f.first.job_title}}" }] });
    await withTenant(ws.tenantId, (tx) => tx`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${decodeId(a.id)!.uuid}`);
    expect(await scheduleDue(ws.tenantId)).toBe(1);
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "succeeded", trigger: "schedule" });
    expect(r!.results[0]!.detail).toMatchObject({ count: 3 });
    expect(r!.results[1]!.skipped).toContain(limited.id);
    expect(mailer.lastTo(limited.email)).toBeUndefined();
    expect(mailer.lastTo(ws.ownerEmail)?.subject).toBe("First: Zed Alpha of 3");
  });
});

describe("the write side's events as triggers", () => {
  it("merge and restore trigger their automations; moved references only when asked; a merged record is not run on or updated", async () => {
    const onMerge = await automation(ws, { name: "On merge", trigger: { event: "contact.merged" }, actions: [{ type: "update_record", values: { job_title: "survivor" } }] });
    const onRestore = await automation(ws, { name: "On restore", trigger: { event: "contact.restored" }, actions: [{ type: "update_record", values: { job_title: "restored" } }] });
    const moves = await automation(ws, { name: "Moves", trigger: { event: "deal.updated", changed_fields: ["primary_contact"], include_reference_moves: true }, actions: [{ type: "update_record", values: { probability: 7 } }] });
    const noMoves = await automation(ws, { name: "No moves", trigger: { event: "deal.updated", changed_fields: ["primary_contact"] }, actions: [{ type: "update_record", values: { probability: 1 } }] });
    const keep = await create(ws.keys.ops, "contact", { first_name: "Keep", email: uniqueEmail("keep") });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Dup", email: uniqueEmail("dup") });
    const deal = await create(ws.keys.ops, "deal", { name: "Moved deal", primary_contact: dup.id });
    await drain(ws);
    const before = { moves: (await runsOf(ws, moves.id)).length, noMoves: (await runsOf(ws, noMoves.id)).length };

    // A run requested for the duplicate, still queued when the merge happens.
    const stamp = await automation(ws, { name: "Stamp later", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "late" } }] });
    expect((await call("POST", `/v1/automations/${stamp.id}/run`, { key: ws.keys.admin, body: { records: [dup.id] } })).status).toBe(202);

    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id] } });
    const merged = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${keep.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("survivor");
    expect((await runsOf(ws, onMerge.id))[0]!.status).toBe("succeeded");
    expect((await runsOf(ws, moves.id)).length).toBe(before.moves + 1);
    expect((await runsOf(ws, noMoves.id)).length).toBe(before.noMoves);
    expect((await call("GET", `/v1/objects/deal/records/${deal.id}`, { key: ws.keys.ops })).json.data.probability).toBe(7);
    // The queued run met a merged record: a data failure naming the survivor, which doesn't count towards the automatic pause.
    const [late] = await runsOf(ws, stamp.id);
    expect(late).toMatchObject({ status: "failed", failure: "data" });
    expect(late!.reason).toContain(`merged into ${keep.id}`);
    expect((await call("GET", `/v1/automations/${stamp.id}`, { key: ws.keys.admin })).json.data.consecutive_failures).toBe(0);
    // A new request for the merged record is refused and names the survivor.
    const again = await call("POST", `/v1/automations/${stamp.id}/run`, { key: ws.keys.admin, body: { records: [dup.id] } });
    expect(again.status).toBe(409);
    expect(again.json.detail).toContain(keep.id);

    const gone = await create(ws.keys.ops, "contact", { first_name: "Back", email: uniqueEmail("back") });
    await call("DELETE", `/v1/objects/contact/records/${gone.id}`, { key: ws.keys.ops });
    expect((await call("POST", `/v1/objects/contact/records/${gone.id}/restore`, { key: ws.keys.ops })).status).toBe(200);
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${gone.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("restored");
    expect((await runsOf(ws, onRestore.id))[0]!.status).toBe("succeeded");
  });

  it("include_reference_moves applies to *.updated and *.archived: a merge's archived second copy is skipped unless asked for", async () => {
    expect((await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "X", trigger: { event: "contact.created", include_reference_moves: true },
      actions: [{ type: "notify", title: "x", recipients: { record_owner: true } }] } })).status).toBe(422);
    const plain = await automation(ws, { name: "Archived", trigger: { event: "contact.archived" }, actions: [{ type: "create_record", object: "task", values: { title: "archived {{record.id}}" } }] });
    const asked = await automation(ws, { name: "Archived too", trigger: { event: "contact.archived", include_reference_moves: true },
      actions: [{ type: "create_record", object: "task", values: { title: "archived copy {{record.id}}" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Copy", email: uniqueEmail("copy") });
    // The event a merge emits for a second copy it archived (core/merge.ts repoint): the record's .archived, marked reference_move.
    const ran = await withTenant(ws.tenantId, (tx) => runAutomationsForEvent(tx, ws.tenantId, {
      id: uuidv7(), type: "contact.archived", object_type: "contact", record_id: decodeId(c.id)!.uuid, occurred_at: new Date(), actor_type: "user", actor_id: ws.ownerId ? decodeId(ws.ownerId)!.uuid : null,
      surface: "api", data: { reference_move: true, before: {}, after: {} }, causation_depth: 0, automation_id: null } as never));
    expect(ran).toBe(1);
    expect(await runsOf(ws, plain.id)).toHaveLength(0);
    expect(await runsOf(ws, asked.id)).toHaveLength(1);
  });
});

describe("bulk changes and fairness", () => {
  it("a bulk update of 200 records runs a simple automation inline for each, queues another up to its cap, and leaves another workspace's events and runs unblocked", async () => {
    const bulk = await newWorkspace("Automations bulk");
    const quiet = await newWorkspace("Automations quiet");
    const inline = await automation(bulk, { name: "Inline", trigger: { event: "contact.updated", changed_fields: ["job_title"] }, hourly_cap: 1000,
      actions: [{ type: "update_record", values: { first_name: "seen" } }] });
    const queued = await automation(bulk, { name: "Queued", trigger: { event: "contact.updated", changed_fields: ["job_title"] }, hourly_cap: 50,
      actions: [{ type: "find_records", id: "f", object: "contact", where: { field: "id", op: "eq", value: "{{record.id}}" }, limit: 1 }] });
    const tag = `bulk${Date.now()}`;
    for (let k = 0; k < 2; k++) {
      const r = await call("POST", "/v1/objects/contact/records/batch", { key: bulk.keys.ops, body: { records: Array.from({ length: 100 }, (_, i) => ({
        first_name: `B${k}-${i}`, email: uniqueEmail(`${tag}${k}${i}`), source: tag })) } });
      expect(r.status).toBe(201);
    }
    await drain(bulk);
    const where = { field: "source", op: "eq", value: tag };
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: bulk.keys.ops, body: { where, values: { job_title: "bulk" } } });
    expect(dry.json.count).toBe(200);
    const run = await call("POST", "/v1/objects/contact/records/bulk_update", { key: bulk.keys.ops, body: { where, values: { job_title: "bulk" }, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(run.status, JSON.stringify(run.json)).toBe(200);

    await automation(quiet, { name: "Quiet inline", trigger: { event: "contact.created" }, actions: [{ type: "update_record", values: { job_title: "seen" } }] });
    const quietQueued = await automation(quiet, { name: "Quiet queued", trigger: { event: "contact.created" }, actions: [{ type: "find_records", id: "f", object: "contact", limit: 1 }] });
    const q = await create(quiet.keys.ops, "contact", { first_name: "Quiet", email: uniqueEmail("quiet") });
    // One round of the events loop: the quiet workspace's event is handled in it, whatever the bulk backlog.
    await processEventsRound([bulk.tenantId, quiet.tenantId]);
    expect((await call("GET", `/v1/objects/contact/records/${q.id}`, { key: quiet.keys.ops })).json.data.job_title).toBe("seen");
    for (let i = 0; i < 20; i++) if ((await processEventsRound([bulk.tenantId, quiet.tenantId])) === 0) break;

    const inlineRuns = await runsOf(bulk, inline.id);
    expect(inlineRuns.filter((r) => r.status === "succeeded")).toHaveLength(200);
    const queuedRuns = await runsOf(bulk, queued.id);
    expect(queuedRuns.filter((r) => r.status === "queued")).toHaveLength(50);
    expect(queuedRuns.filter((r) => r.status === "skipped" && r.cap === "hourly")).toHaveLength(150);
    // The inline step's own update (first_name) doesn't match changed_fields, so nothing ran twice.
    expect(inlineRuns).toHaveLength(200);

    // The run queue: one run per workspace per pass, so the quiet workspace's run starts in the first pass.
    expect(await runAutomationPass([bulk.tenantId, quiet.tenantId])).toBe(2);
    expect((await runsOf(quiet, quietQueued.id))[0]!.status).toBe("succeeded");
    expect((await runsOf(bulk, queued.id)).filter((r) => r.status === "queued")).toHaveLength(49);
    for (let i = 0; i < 60; i++) if ((await runAutomationPass([bulk.tenantId])) === 0) break;
    expect((await runsOf(bulk, queued.id)).filter((r) => r.status === "succeeded")).toHaveLength(50);
  }, 120_000);
});

describe("email budgets", () => {
  it("automation email's server ceiling and sign-in email's budgets are separate, both ways", async () => {
    const a = await automation(ws, { name: "Mail owner", trigger: { type: "manual" }, actions: [{ type: "send_email", to: { member: ws.ownerId }, subject: "Budget check", body: "hi" }] });
    // Automation email used up: a sign-in code still goes out.
    for (let i = 0; i < LIMITS.automationEmail.max; i++) hit(LIMITS.automationEmail, "all");
    const before = mailer.sent.length;
    expect((await new Browser().request("POST", "/auth/email", { body: { email: ws.ownerEmail } })).status).toBe(202);
    await settleSignInTasks();
    expect(mailer.sent.length).toBe(before + 1);
    expect(mailer.codeFor(ws.ownerEmail)).not.toBeNull();
    // Sign-in email used up (server-wide and this workspace): an automation email still goes out.
    resetSignInLimits();
    for (let i = 0; i < LIMITS.globalEmail.max; i++) hit(LIMITS.globalEmail, "all");
    for (let i = 0; i < LIMITS.workspaceEmail.max; i++) hit(LIMITS.workspaceEmail, ws.tenantId);
    expect((await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: {} })).status).toBe(202);
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.status).toBe("succeeded");
    expect(mailer.lastTo(ws.ownerEmail)?.subject).toBe("Budget check");
    resetSignInLimits();
  });

  it("the suppression list keys on sign-in's canonical email plus the mailbox (+tag), and refuses addresses outside plain ASCII", async () => {
    const stamp = Date.now();
    expect((await call("POST", "/v1/email-suppressions", { key: ws.keys.admin, body: { email: `Ann.${stamp}+News@Example.COM` } })).status).toBe(201);
    for (const e of [`ann.${stamp}@example.com`, `ANN.${stamp}+other@example.com`]) {
      expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email: e } })).json.data.suppressed, e).toBe(true);
    }
    expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email: `bob.${stamp}@example.com` } })).json.data.suppressed).toBe(false);
    expect((await call("POST", "/v1/email-suppressions", { key: ws.keys.admin, body: { email: "jürgen@example.de" } })).status).toBe(422);
  });
});

describe("typed responses of the automation routes", () => {
  it("real responses match what the routes declare", async () => {
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const c = await create(ws.keys.ops, "contact", { first_name: "Doc", email: uniqueEmail("doc") });
    const body = { name: "Doc", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "doc" } }] };
    const a = await automation(ws, body);
    const sched = await automation(ws, { name: "Doc schedule", trigger: { type: "schedule", daily: { at: "09:00" } }, actions: [{ type: "find_records", id: "f", object: "contact", limit: 1 }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    const addr = uniqueEmail("docsup");
    const samples: [string, string, string, unknown, number][] = [
      ["GET", "/v1/automations", "/v1/automations", undefined, 200],
      ["POST", "/v1/automations", "/v1/automations", { ...body, dry_run: true }, 200],
      ["POST", "/v1/automations", "/v1/automations", body, 201],
      ["GET", "/v1/automations/{id}", `/v1/automations/${a.id}`, undefined, 200],
      ["PATCH", "/v1/automations/{id}", `/v1/automations/${a.id}`, { hourly_cap: 50 }, 200],
      ["POST", "/v1/automations/{id}/pause", `/v1/automations/${a.id}/pause`, {}, 200],
      ["POST", "/v1/automations/{id}/resume", `/v1/automations/${a.id}/resume`, undefined, 200],
      ["POST", "/v1/automations/{id}/test", `/v1/automations/${a.id}/test`, { record: c.id }, 200],
      ["POST", "/v1/automations/{id}/test", `/v1/automations/${sched.id}/test`, {}, 200],
      ["POST", "/v1/automations/test", "/v1/automations/test", { automation: body, record: c.id }, 200],
      ["POST", "/v1/automations/test", "/v1/automations/test", { automation: { ...body, condition: { field: "job_title", op: "eq", value: "nobody" } }, record: c.id }, 200],
      ["POST", "/v1/automations/{id}/run", `/v1/automations/${a.id}/run`, { records: [c.id] }, 202],
      ["POST", "/v1/automations/{id}/run", `/v1/automations/${a.id}/run`, { records: [c.id], dry_run: true }, 200],
      ["GET", "/v1/automations/{id}/runs", `/v1/automations/${a.id}/runs`, undefined, 200],
      ["GET", "/v1/automations/{id}/schedule", `/v1/automations/${sched.id}/schedule`, undefined, 200],
      ["POST", "/v1/automations/schedule-preview", "/v1/automations/schedule-preview", { trigger: { type: "schedule", every: { hours: 2 } } }, 200],
      ["GET", "/v1/automation-settings", "/v1/automation-settings", undefined, 200],
      ["PATCH", "/v1/automation-settings", "/v1/automation-settings", { timezone: "UTC" }, 200],
      ["POST", "/v1/email-suppressions", "/v1/email-suppressions", { email: addr }, 201],
      ["POST", "/v1/email-suppressions/check", "/v1/email-suppressions/check", { email: addr }, 200],
      ["POST", "/v1/email-suppressions/remove", "/v1/email-suppressions/remove", { email: addr }, 200],
      ["DELETE", "/v1/automations/{id}", `/v1/automations/${a.id}`, undefined, 200],
    ];
    for (const [method, template, path, reqBody, status] of samples) {
      const res = await call(method, path, { key: ws.keys.admin, body: reqBody });
      expect(res.status, `${method} ${path} ${JSON.stringify(res.json)}`).toBe(status);
      const responses = (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method.toLowerCase()]!.responses;
      expect(validate(doc, responses[String(status)]!.content["application/json"]!.schema, res.json), `${method} ${path}`).toEqual([]);
    }
    await drain(ws);
  });
});

afterAll(() => setMailer(new FakeMailer()));
