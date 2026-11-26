import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hit, LIMITS, resetSignInLimits } from "../src/auth/limits.js";
import { addressProblem, mailbox, progressWrites, runAutomationPass, runQueuedOnce, scheduleDue, validAddress } from "../src/core/automation-runner.js";
import { checkSchedule, nextRun, upcoming } from "../src/core/schedule.js";
import { budget, DataError, fillDeep, fillString, fillUrl, parsePlaceholder, RESTRICTED, samePath } from "../src/core/templates.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { setMailer } from "../src/providers/mailer.js";
import { EVENTS_TENANT_BUDGET_MS, processEvents, processEventsRound } from "../src/worker/events.js";
import { call, create, FakeMailer, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

// HTTP steps go to a local receiver, which needs the self-hosted "insecure targets" switch (metadata stays blocked).
process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = "true";

interface Received { method: string; path: string; headers: IncomingMessage["headers"]; body: string }
let server: Server;
let base = "";
const received: Received[] = [];
const replies = new Map<string, { status: number; body: string; delayMs?: number }>();
const mailer = new FakeMailer();

beforeAll(async () => {
  setMailer(mailer);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      const r = replies.get(path) ?? { status: 200, body: JSON.stringify({ ok: true, token: "tok-should-be-redacted", id: "ext-1" }) };
      setTimeout(() => res.writeHead(r.status, { "content-type": "application/json" }).end(r.body), r.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const at = (p: string) => received.filter((r) => r.path.split("?")[0] === p);
const uniq = (s: string) => `${s}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Runs the worker until nothing is left for this tenant: events, then queued runs. */
async function drain(ws: Workspace) {
  for (let i = 0; i < 30; i++) {
    const n = (await processEvents(ws.tenantId)) + (await runQueuedOnce(ws.tenantId) ? 1 : 0);
    if (n === 0) return;
  }
}

const runsOf = async (ws: Workspace, id: string) => (await call("GET", `/v1/automations/${id}/runs`, { key: ws.keys.admin })).json.data as {
  id: string; status: string; reason: string | null; trigger: string; results: { step: string; action: string; ok: boolean; skipped?: string; detail: Record<string, unknown> }[];
}[];

async function automation(ws: Workspace, body: Record<string, unknown>) {
  const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body });
  if (r.status !== 201) throw new Error(`create automation: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.automation as { id: string; actions: unknown[]; next_run_at: string | null };
}

describe("schedule language", () => {
  it("computes daily, weekly, monthly and interval ticks in a time zone", () => {
    const from = new Date("2026-03-06T12:00:00Z"); // a Friday
    expect(nextRun({ daily: { at: "09:00" }, timezone: "UTC" }, from, "UTC").toISOString()).toBe("2026-03-07T09:00:00.000Z");
    expect(nextRun({ daily: { at: "09:00" } }, from, "America/Denver").toISOString()).toBe("2026-03-06T16:00:00.000Z");
    expect(nextRun({ weekly: { days: ["mon"], at: "08:30" } }, from, "UTC").toISOString()).toBe("2026-03-09T08:30:00.000Z");
    expect(nextRun({ monthly: { day: 31, at: "00:00" } }, new Date("2026-04-01T00:00:00Z"), "UTC").toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(nextRun({ monthly: { day: "last", at: "06:00" } }, new Date("2026-02-01T00:00:00Z"), "UTC").toISOString()).toBe("2026-02-28T06:00:00.000Z");
    expect(nextRun({ every: { minutes: 15 } }, new Date("2026-03-06T12:07:00Z"), "UTC").toISOString()).toBe("2026-03-06T12:15:00.000Z");
    expect(upcoming({ every: { hours: 6 } }, new Date("2026-03-06T12:00:00Z"), "UTC", 3)).toEqual(["2026-03-06T18:00:00.000Z", "2026-03-07T00:00:00.000Z", "2026-03-07T06:00:00.000Z"]);
    // Across the US spring-forward change, 09:00 local stays 09:00 local.
    const ticks = upcoming({ daily: { at: "09:00" } }, new Date("2026-03-07T20:00:00Z"), "America/New_York", 2);
    expect(ticks).toEqual(["2026-03-08T13:00:00.000Z", "2026-03-09T13:00:00.000Z"]);
  });

  it("refuses ambiguous or unbounded schedules with a clear message", () => {
    expect(() => checkSchedule({ daily: { at: "09:00" }, weekly: { days: ["mon"], at: "09:00" } })).toThrow(/exactly one/);
    expect(() => checkSchedule({ every: {} })).toThrow(/minutes/);
    expect(() => checkSchedule({ daily: { at: "09:00" }, timezone: "Mars/Olympus" })).toThrow(/time zone/);
  });
});

describe("templates", () => {
  const scope = { record: { id: "con_1", object: "contact", first_name: "Ann \"the\" Smith\nBcc: x@evil.example", tags: ["a", "b"], amount: 12.5, due: "2026-01-01" },
    event: null, steps: { call: { status: 201, json: { id: "x" } } } };
  it("never walks prototypes or evaluates code", () => {
    for (const bad of ["record.__proto__", "record.constructor.name", "steps.__proto__.polluted", "process.env", "record.first_name; 1+1", "record['x']"]) {
      expect(() => parsePlaceholder(bad), bad).toThrow();
    }
    expect(fillString("{{steps.call.json.hasownproperty}}", scope)).toBeNull();
    // Capitals are allowed in a path (another system's JSON keys), and still reach own properties only: a method is never found.
    for (const inherited of ["toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) expect(fillString(`{{steps.call.json.${inherited}}}`, scope), inherited).toBeNull();
    expect(() => fillString("{{steps.call.json.to-string}}", scope)).toThrow(/not a valid path/);
    expect(fillString("{{record.tags.length}}", scope)).toBeNull(); // own properties of plain objects and array indexes only
    expect(fillString("{{record.tags.1}}", scope)).toBe("b");
    // A value that looks like a placeholder is data: filling is one pass.
    expect(fillString("Hi {{record.first_name}}", { ...scope, record: { first_name: "{{run.id}}" } }, { target: "text" })).toBe("Hi {{run.id}}");
  });

  it("escapes for where the value goes", () => {
    expect(fillString("https://api.example/c/{{record.first_name}}?q={{record.tags}}", scope, { target: "url" }))
      .toBe(`https://api.example/c/${encodeURIComponent(scope.record.first_name)}?q=${encodeURIComponent("a, b")}`);
    // A line break from a record can't start another header: control characters are stripped.
    expect(fillString("Bearer {{record.first_name}}", scope, { target: "header" })).toBe("Bearer Ann \"the\" SmithBcc: x@evil.example");
    expect(fillString("Re: {{record.first_name}}", scope, { target: "subject" })).not.toMatch(/[\r\n]/);
    // A value can't move a URL to another host, path segment or query: it is one encoded part.
    const moved = new URL(fillString("https://api.example/c/{{record.first_name}}", { record: { first_name: "x/../../@evil.example:1/?a=#" }, event: null }, { target: "url" }) as string);
    expect(moved.host).toBe("api.example");
    expect(moved.pathname.split("/")).toHaveLength(3);
    expect(moved.search).toBe("");
    const body = fillDeep({ name: "{{record.first_name}}", amount: "{{record.amount}}", note: "x{{record.amount}}" }, scope);
    expect(JSON.parse(JSON.stringify(body))).toEqual({ name: scope.record.first_name, amount: 12.5, note: "x12.5" });
    expect(fillString("{{record.amount | number:2}} {{record.due | add_days:3 | date}} {{record.first_name | truncate:3 | upper}}", scope, { target: "text" }))
      .toBe("12.50 2026-01-04 ANN");
    // A restricted value is the marker the runner puts in its place, refused wherever it would go; the text "[restricted]" is just text.
    expect(() => fillString("{{record.ssn}}", { record: { ssn: RESTRICTED }, event: null })).toThrow(/restricted/);
    expect(() => fillString("{{record.ssn | json}}", { record: { ssn: RESTRICTED }, event: null })).toThrow(/restricted/);
    expect(fillString("{{record.note}}", { record: { note: "[restricted]" }, event: null })).toBe("[restricted]");
  });
});

describe("validation of new triggers and steps", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto validation");
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tax_id", type: "text", sensitivity: "restricted" } })).status).toBe(201);
  });
  const bad = async (body: Record<string, unknown>) => {
    const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "x", ...body } });
    expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    return `${r.json.detail} ${JSON.stringify(r.json.errors ?? "")}`;
  };
  it("gives a 4xx with a helpful message for every hostile or wrong shape", async () => {
    const schedule = { type: "schedule", daily: { at: "09:00" } };
    expect(await bad({ trigger: { type: "schedule", every: { minutes: 1 } }, actions: [{ type: "stop" }] })).toMatch(/minutes|15/);
    expect(await bad({ trigger: { type: "schedule", cron: "* * * * *" }, actions: [{ type: "stop" }] })).toBeTruthy();
    expect(await bad({ trigger: schedule, condition: { field: "email", op: "is_null" }, actions: [{ type: "stop" }] })).toMatch(/for_each/);
    expect(await bad({ trigger: schedule, actions: [{ type: "update_record", values: { job_title: "x" } }] })).toMatch(/needs a record/);
    expect(await bad({ trigger: schedule, actions: [{ type: "create_record", object: "task", values: { title: "{{record.first_name}}" } }] })).toMatch(/trigger record/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "POST", url: "https://{{record.email}}/x" }] })).toMatch(/host/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "GET", url: "http://169.254.169.254/latest/meta-data" }] })).toMatch(/blocked|metadata/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "GET", url: `${base}/x`, headers: { Host: "evil" } }] })).toMatch(/not allowed/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "GET", url: `${base}/x`, headers: { "X-A": "a\r\nInjected: 1" } }] })).toMatch(/line break/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "POST", url: `${base}/x`, body: { t: "{{record.tax_id}}" } }] })).toMatch(/restricted/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "http_request", method: "GET", url: `${base}/x`, secret_headers: { Authorization: "Bearer s" } }] })).toMatch(/needs an id/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "send_email", to: { address: "a@example.com\r\nBcc: b@example.com" }, subject: "s", body: "b" }] })).toMatch(/plain email/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "send_email", to: { field: "tax_id" }, subject: "s", body: "b" }] })).toMatch(/not an email field/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "send_email", to: { address: "a@example.com", member: "x" }, subject: "s", body: "b" }] })).toMatch(/exactly one/);
    expect(await bad({ trigger: schedule, actions: [{ type: "for_each", query: { object: "contact" }, steps: [{ type: "for_each", query: { object: "contact" }, steps: [{ type: "stop" }] }] }] })).toBeTruthy();
    expect(await bad({ trigger: schedule, actions: [{ type: "for_each", over: "nope", steps: [{ type: "stop" }] }] })).toMatch(/find_records/);
    expect(await bad({ trigger: schedule, actions: [{ type: "for_each", query: { object: "contact", limit: 5000 }, steps: [{ type: "stop" }] }] })).toBeTruthy();
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "stop", id: "a" }, { type: "stop", id: "a" }] })).toMatch(/same id|two steps|id "a"/i);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "create_record", object: "task", values: { title: "{{steps.nope.id}}" } }] })).toMatch(/earlier step/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "upsert_record", object: "contact", key: "first_name", values: { first_name: "x" } }] })).toMatch(/unique/);
    expect(await bad({ trigger: { event: "contact.created" }, actions: [{ type: "notify", title: "{{record.__proto__}}", recipients: { record_owner: true } }] })).toMatch(/path/);
    expect(await bad({ trigger: { event: "alert.fired" }, actions: [{ type: "stop" }] })).toMatch(/trigger/i);
    expect(await bad({ trigger: { event: "contact.created" }, run_roles: ["no_such_role"], actions: [{ type: "stop" }] })).toMatch(/role/);
  });

  it("dry runs show the exact URL and recipients in the summary, and the next schedule runs", async () => {
    const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Preview", dry_run: true,
      trigger: { type: "schedule", weekly: { days: ["mon", "thu"], at: "07:30" }, timezone: "Europe/Berlin" },
      actions: [{ type: "for_each", query: { object: "contact", where: { field: "email", op: "is_null", value: false }, limit: 10 }, steps: [
        { type: "http_request", method: "POST", url: "https://hooks.example.com/sync?c={{item.id}}", body: { email: "{{item.email}}" } },
        { type: "send_email", to: { field: "email" }, subject: "Hello", body: "Hi {{item.first_name}}" }] }] } });
    expect(r.status).toBe(200);
    expect(r.json.summary).toContain("https://hooks.example.com/sync?c={{item.id}}");
    expect(r.json.summary).toContain("email field");
    expect(r.json.next_runs).toHaveLength(5);
    expect(r.json.warnings.join(" ")).toMatch(/not members is off/);
    const p = await call("POST", "/v1/automations/schedule-preview", { key: ws.keys.admin, body: { trigger: { type: "schedule", daily: { at: "23:59" } }, count: 3 } });
    expect(p.json.data.next_runs).toHaveLength(3);
  });
});

describe("schedule triggers", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto schedule");
    for (const n of ["Sa", "Sb", "Sc"]) await create(ws.keys.ops, "contact", { first_name: n, email: `${uniq(n)}@example.com`, job_title: "lead-src" });
  });

  it("enqueues each tick once, collapses missed ticks, iterates a bounded query and says when the cap was hit", async () => {
    const a = await automation(ws, { name: "Nightly tidy", trigger: { type: "schedule", every: { hours: 1 } },
      actions: [{ type: "for_each", id: "each", query: { object: "contact", where: { field: "job_title", op: "eq", value: "lead-src" }, limit: 2 },
        steps: [{ type: "update_record", values: { job_title: "tidied" } }] }] });
    expect(a.next_run_at).not.toBeNull();
    const id = decodeId(a.id)!.uuid;
    // The worker was down for three hours: the overdue tick runs once, not three times.
    await withTenant(ws.tenantId, (tx) => tx`UPDATE automations SET next_run_at = now() - interval '3 hours' WHERE id = ${id}`);
    expect(await scheduleDue(ws.tenantId)).toBe(1);
    expect(await scheduleDue(ws.tenantId)).toBe(0);
    const [row] = await withTenant(ws.tenantId, (tx) => tx<{ next_run_at: Date }[]>`SELECT next_run_at FROM automations WHERE id = ${id}`);
    expect(row!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    await drain(ws);
    const runs = await runsOf(ws, a.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "schedule" });
    expect(runs[0]!.results[0]!.detail).toMatchObject({ count: 2, cap: 2, truncated: true });
    const tidied = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "job_title", op: "eq", value: "tidied" } } });
    expect(tidied.json.data).toHaveLength(2);
  });

  it("never runs two runs of one automation at once: a tick during an open run is skipped", async () => {
    const a = await automation(ws, { name: "Slow", trigger: { type: "schedule", every: { minutes: 15 } }, actions: [{ type: "stop" }] });
    const id = decodeId(a.id)!.uuid;
    await withTenant(ws.tenantId, (tx) => tx`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${id}`);
    await scheduleDue(ws.tenantId);
    await withTenant(ws.tenantId, (tx) => tx`UPDATE automations SET next_run_at = now() - interval '1 second' WHERE id = ${id}`);
    await scheduleDue(ws.tenantId);
    const runs = await runsOf(ws, a.id);
    expect(runs.map((r) => r.status).sort()).toEqual(["queued", "skipped"]);
    expect(runs.find((r) => r.status === "skipped")!.reason).toMatch(/still in progress/);
    await drain(ws);
  });

  it("a test run of a schedule needs no record and changes nothing", async () => {
    const a = await automation(ws, { name: "Probe", trigger: { type: "schedule", daily: { at: "06:00" } },
      actions: [{ type: "find_records", id: "found", object: "contact", limit: 5 }, { type: "create_record", object: "task", values: { title: "Found {{steps.found.count}}", assignee: ws.ownerId.length ? `usr_x` : "" }, if: { output: "{{steps.found.count}}", op: "gt", value: 100 } }] });
    const t = await call("POST", `/v1/automations/${a.id}/test`, { key: ws.keys.admin, body: {} });
    expect(t.status).toBe(200);
    expect(t.json.data.actions[0]).toMatchObject({ action: "find_records", ok: true });
    expect(t.json.data.actions[1]).toMatchObject({ action: "create_record", skipped: expect.stringMatching(/if condition/) });
    const sched = await call("GET", `/v1/automations/${a.id}/schedule?count=2`, { key: ws.keys.admin });
    expect(sched.json.data.next_runs).toHaveLength(2);
  });
});

describe("http_request", () => {
  let ws: Workspace;
  let contact: { id: string };
  beforeAll(async () => {
    ws = await newWorkspace("Auto http");
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tax_id", type: "text", sensitivity: "restricted" } })).status).toBe(201);
    contact = await create(ws.keys.admin, "contact", { first_name: "Quote \"me\"\nplease", email: `${uniq("h")}@example.com`, tax_id: "TAX-SECRET-1" });
  });

  it("sends the templated JSON body, keeps secret headers write-only, and logs a redacted snippet", async () => {
    const a = await automation(ws, { name: "Sync out", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "http_request", id: "push", method: "POST", url: `${base}/sync/{{record.id}}?email={{record.email}}`,
        headers: { "X-Source": "crm" }, secret_headers: { Authorization: "Bearer very-secret-value" },
        body: { id: "{{record.id}}", name: "{{record.first_name}}", nested: { list: ["{{record.email}}", 1] } } },
      { type: "update_record", values: { job_title: "synced {{steps.push.status}}" } }] });
    expect(JSON.stringify(a)).not.toContain("very-secret-value");
    const got = await call("GET", `/v1/automations/${a.id}`, { key: ws.keys.admin });
    expect(got.json.data.actions[0].secret_headers).toEqual({ Authorization: null });
    expect(JSON.stringify(got.json)).not.toContain("very-secret-value");
    // A dry run shows the exact URL and headers, with the secret replaced, and sends nothing.
    const before = received.length;
    const dry = await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id], dry_run: true } });
    expect(dry.status).toBe(200);
    const would = dry.json.data.runs[0].actions[0].detail.would_send;
    expect(would.url).toBe(`${base}/sync/${contact.id}?email=${encodeURIComponent((await call("GET", `/v1/objects/contact/records/${contact.id}`, { key: ws.keys.ops })).json.data.email)}`);
    expect(would.headers).toMatchObject({ Authorization: "(secret, not shown)", "X-Source": "crm" });
    expect(received.length).toBe(before);
    // The real run.
    const run = await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id] } });
    expect(run.status).toBe(202);
    await drain(ws);
    const hit = at(`/sync/${contact.id}`).at(-1)!;
    expect(hit.headers.authorization).toBe("Bearer very-secret-value");
    expect(hit.headers["hlcrm-run"]).toBe(run.json.data.runs[0].id);
    const sent = JSON.parse(hit.body);
    expect(sent.name).toBe("Quote \"me\"\nplease");
    expect(sent.nested.list[1]).toBe(1);
    const runs = await runsOf(ws, a.id);
    expect(runs[0]!.status).toBe("succeeded");
    const log = JSON.stringify(runs[0]);
    expect(log).not.toContain("very-secret-value");
    expect(log).not.toContain("tok-should-be-redacted");
    expect(log).not.toContain("example.com"); // query values (the email) are not logged
    expect((await call("GET", `/v1/objects/contact/records/${contact.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("synced 200");
    // With private targets allowed (as here), the target may be an internal service: only its status is kept, never its reply.
    expect(runs[0]!.results[0]!.detail.snippet).toBe("");
    const auditLog = await call("GET", "/v1/audit-log?action=automation.http_request", { key: ws.keys.admin });
    expect(auditLog.json.data[0].details).toMatchObject({ method: "POST", status: 200 });
    // Updating with the secret as null keeps it; leaving it out removes it.
    const keep = await call("PATCH", `/v1/automations/${a.id}`, { key: ws.keys.admin, body: { name: "Sync out 2" } });
    expect(keep.status).toBe(200);
    expect(JSON.stringify(keep.json)).not.toContain("very-secret-value");
    // A stored secret is not reused for another host: pointing the step elsewhere needs the value again.
    const steps = keep.json.automation.actions as Record<string, unknown>[];
    const redirect = await call("PATCH", `/v1/automations/${a.id}`, { key: ws.keys.admin, body: { actions: [{ ...steps[0], url: "https://attacker.example/collect" }, steps[1]] } });
    expect(redirect.status).toBe(422);
    expect(redirect.json.detail).toMatch(/must be given again/);
    // Nor for another path of the same host: a secret is bound to the host and the path up to the first placeholder.
    const otherPath = await call("PATCH", `/v1/automations/${a.id}`, { key: ws.keys.admin, body: { actions: [{ ...steps[0], url: `${base}/admin/{{record.id}}` }, steps[1]] } });
    expect(otherPath.status).toBe(422);
    expect(otherPath.json.detail).toMatch(/host or path/);
    const samePrefix = await call("PATCH", `/v1/automations/${a.id}`, { key: ws.keys.admin, body: { actions: [{ ...steps[0], url: `${base}/sync/{{record.id}}/v2` }, steps[1]] } });
    expect(samePrefix.status).toBe(200);
  });

  it("refuses restricted values at run time too, and an error status fails the run", async () => {
    replies.set("/fail", { status: 500, body: "boom" });
    const a = await automation(ws, { name: "Fails", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "http_request", method: "GET", url: `${base}/fail` }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id] } });
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "failed" });
    expect(r!.reason).toMatch(/HTTP 500/);
    // A restricted field reached through a find step is refused at save when named, and at run time when a whole record carries it.
    const named = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Leak named", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "find_records", id: "f", object: "contact", where: { field: "id", op: "eq", value: "{{record.id}}" } },
        { type: "update_record", values: { job_title: "{{steps.f.first.tax_id}}" } }] } });
    expect(named.status).toBe(422);
    expect(named.json.detail).toMatch(/restricted/);
    const b = await automation(ws, { name: "Leak try", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "find_records", id: "f", object: "contact", where: { field: "id", op: "eq", value: "{{record.id}}" } },
        { type: "http_request", method: "POST", url: `${base}/leak`, body: { t: "{{steps.f.first | json}}" } }] });
    await call("POST", `/v1/automations/${b.id}/run`, { key: ws.keys.admin, body: { records: [contact.id] } });
    await drain(ws);
    const [rb] = await runsOf(ws, b.id);
    expect(rb!.status).toBe("failed");
    expect(rb!.reason).toMatch(/restricted/);
    expect(at("/leak")).toHaveLength(0);
  });

  it("pauses itself after repeated failures and tells the admins", async () => {
    const a = await automation(ws, { name: "Broken endpoint", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "http_request", method: "GET", url: `${base}/fail` }] });
    for (let i = 0; i < 5; i++) {
      expect((await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id] } })).status).toBe(202);
      await drain(ws);
    }
    const got = (await call("GET", `/v1/automations/${a.id}`, { key: ws.keys.admin })).json.data;
    expect(got.status).toBe("paused");
    expect(got.paused_reason).toMatch(/5 failed runs/);
    const inbox = await call("GET", "/v1/me/notifications", { key: ws.keys.admin });
    expect(inbox.json.data.some((n: { title: string }) => n.title === "Automation paused: Broken endpoint")).toBe(true);
    expect((await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [contact.id] } })).status).toBe(409);
    const resumed = await call("POST", `/v1/automations/${a.id}/resume`, { key: ws.keys.admin });
    expect(resumed.json.data).toMatchObject({ status: "enabled", consecutive_failures: 0 });
  });
});

describe("send_email", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto email");
  });

  it("needs the workspace switch for non-members, respects suppression and the per-recipient cap, and logs by hash", async () => {
    const addr = uniqueEmail("ext");
    const c = await create(ws.keys.ops, "contact", { first_name: "Eve\r\nBcc: victim@example.com", email: addr });
    const a = await automation(ws, { name: "Welcome", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "send_email", to: { field: "email" }, subject: "Welcome {{record.first_name}}", body: "Hello {{record.first_name}}, {{automation.name}}" }] });
    const runOnce = async () => {
      expect((await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } })).status).toBe(202);
      await drain(ws);
      return (await runsOf(ws, a.id))[0]!;
    };
    let r = await runOnce();
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/not members is off/);
    expect(mailer.lastTo(addr)).toBeUndefined();
    // Not through MCP.
    expect((await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true }, headers: { "x-hlcrm-surface": "admin-mcp" } })).status).toBe(403);
    expect((await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true } })).json.data.external_email).toBe(true);
    r = await runOnce();
    expect(r.status).toBe("succeeded");
    const mail = mailer.lastTo(addr)!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain("Sent by an automation of the");
    expect(JSON.stringify(r)).not.toContain(addr);
    expect(r.results[0]!.detail.to).toMatch(/^sha256:/);
    const auditLog = await call("GET", "/v1/audit-log?action=automation.email_sent", { key: ws.keys.admin });
    expect(JSON.stringify(auditLog.json)).not.toContain(addr);
    // Five a day per recipient (the default), then skipped, not failed.
    for (let i = 0; i < 4; i++) await runOnce();
    r = await runOnce();
    expect(r.status).toBe("succeeded");
    expect(r.results[0]!.skipped).toMatch(/today/);
    expect(mailer.sent.filter((m) => m.to === addr)).toHaveLength(5);
    // Suppressed addresses are skipped. Adding and removing one both need automations:manage (a records:write key could
    // otherwise stop the workspace's email to anyone); checking needs records:read, and only managers see the reason.
    const other = await create(ws.keys.ops, "contact", { first_name: "Sam", email: uniqueEmail("sup") });
    expect((await call("POST", "/v1/email-suppressions", { key: ws.keys.ops, body: { email: String(other.email) } })).status).toBe(403);
    expect((await call("POST", "/v1/email-suppressions", { key: ws.keys.admin, body: { email: String(other.email).toUpperCase(), reason: "asked by phone" } })).status).toBe(201);
    const checked = (await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email: other.email } })).json.data;
    expect(checked.suppressed).toBe(true);
    expect(checked).not.toHaveProperty("reason");
    expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.admin, body: { email: other.email } })).json.data.reason).toBe("asked by phone");
    expect((await call("POST", "/v1/email-suppressions/remove", { key: ws.keys.ops, body: { email: other.email } })).status).toBe(403);
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [other.id] } });
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.results[0]!.skipped).toMatch(/suppression/);
    expect(mailer.lastTo(String(other.email))).toBeUndefined();
    const rows = await withTenant(ws.tenantId, (tx) => tx`SELECT address_hash FROM email_suppressions`);
    expect(JSON.stringify(rows)).not.toContain(String(other.email));
  });

  it("a member recipient follows the notification rule: skipped when their role can't read what the run depends on", async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "no_deals", name: "No deals", permissions: ["records:read", "records:write"] } });
    await call("PATCH", `/v1/roles/${role.json.data.id}`, { key: ws.keys.admin, body: { objects: { deal: { read: false, write: false, archive: false } } } });
    const m = await memberWithKey(ws, "no_deals", ["ops:read"]);
    const a = await automation(ws, { name: "Deal mail", trigger: { type: "manual", object: "deal" },
      actions: [{ type: "send_email", to: { member: m.id }, subject: "Deal {{record.name}}", body: "Amount {{record.amount}}" }] });
    const pc = await create(ws.keys.ops, "contact", { first_name: "Pc", email: uniqueEmail("pc") });
    const d = await create(ws.keys.ops, "deal", { name: "Hidden deal", amount: 5, primary_contact: pc.id });
    const before = mailer.sent.length;
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [d.id] } });
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r!.results[0]!.skipped, JSON.stringify(r)).toMatch(/can't read deal/);
    expect(mailer.sent.length).toBe(before);
  });
});

describe("step outputs and limited recipients", () => {
  it("a notification built from step outputs never reaches a member whose role limits records", async () => {
    const ws = await newWorkspace("Auto outputs");
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "no_titles", name: "No titles", permissions: ["records:read", "records:write"] } });
    expect((await call("PATCH", `/v1/roles/${role.json.data.id}`, { key: ws.keys.admin, body: { fields: { contact: { job_title: "none" } } } })).status).toBe(200);
    const limitedMember = await memberWithKey(ws, "no_titles", ["ops:read"]);
    const full = await memberWithKey(ws, "member", ["ops:read"]);
    const secretTitle = uniq("hidden-title");
    const c = await create(ws.keys.ops, "contact", { first_name: "Out", email: uniqueEmail("out"), job_title: secretTitle });
    const a = await automation(ws, { name: "Peek", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "find_records", id: "f", object: "contact", where: { field: "id", op: "eq", value: "{{record.id}}" } },
      { type: "notify", title: "Title is {{steps.f.first.job_title}}", recipients: { users: [limitedMember.id, full.id] } }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    expect(JSON.stringify((await call("GET", "/v1/me/notifications", { key: limitedMember.key })).json)).not.toContain(secretTitle);
    expect(JSON.stringify((await call("GET", "/v1/me/notifications", { key: full.key })).json)).toContain(secretTitle);
  });
});

describe("find, upsert and control flow", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto upsert");
  });

  it("upserts by a unique key with the import's normalisation, and steps use earlier outputs", async () => {
    const email = uniqueEmail("ups");
    const existing = await create(ws.keys.ops, "contact", { first_name: "Before", email });
    const a = await automation(ws, { name: "Upsert", trigger: { type: "manual", object: "deal" }, actions: [
      { type: "upsert_record", id: "person", object: "contact", key: "email", values: { email: email.toUpperCase(), first_name: "After" } },
      { type: "update_record", values: { primary_contact: "{{steps.person.id}}" } },
      { type: "stop", reason: "done after {{steps.person.action}}" },
      { type: "create_record", object: "task", values: { title: "never" } },
    ] });
    const d = await create(ws.keys.ops, "deal", { name: "Up deal", primary_contact: existing.id });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [d.id] } });
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "succeeded", reason: "done after updated" });
    expect(r!.results.map((x) => x.action)).toEqual(["upsert_record", "update_record", "stop"]);
    expect((await call("GET", `/v1/objects/contact/records/${existing.id}`, { key: ws.keys.ops })).json.data.first_name).toBe("After");
    expect((await call("GET", `/v1/objects/deal/records/${d.id}`, { key: ws.keys.ops })).json.data.primary_contact).toBe(existing.id);
    const contacts = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "email", op: "eq", value: email } } });
    expect(contacts.json.data).toHaveLength(1);
  });
});

describe("running on request", () => {
  let ws: Workspace;
  let auto: { id: string };
  beforeAll(async () => {
    ws = await newWorkspace("Auto manual");
    await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "runner", name: "Runner", permissions: ["records:read", "records:write"] } });
    auto = await automation(ws, { name: "Stamp", trigger: { type: "manual", object: "contact" }, hourly_cap: 3,
      actions: [{ type: "update_record", values: { job_title: "stamped" } }] });
  });

  it("needs automations:manage, or a role the automation names; a granted member can't dry run or pass records they can't read", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "R", email: uniqueEmail("r") });
    const plain = await memberWithKey(ws, "member", ["ops:write", "ops:read"]);
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: plain.key, body: { records: [c.id] } })).status).toBe(403);
    const runner = await memberWithKey(ws, "runner", ["ops:write", "ops:read"]);
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: runner.key, body: { records: [c.id] } })).status).toBe(403);
    expect((await call("PATCH", `/v1/automations/${auto.id}`, { key: ws.keys.admin, body: { run_roles: ["runner"] } })).status).toBe(200);
    const ok = await call("POST", `/v1/automations/${auto.id}/run`, { key: runner.key, body: { records: [c.id] } });
    expect(ok.status).toBe(202);
    expect(ok.json.data.runs[0].id).toMatch(/^run_/);
    expect(JSON.stringify(ok.json)).not.toContain("stamped");
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: runner.key, body: { records: [c.id], dry_run: true } })).status).toBe(403);
    expect((await call("GET", `/v1/automations/${auto.id}/runs`, { key: runner.key })).status).toBe(403);
    // The run is the automation's, but the records must be ones the caller can read.
    const role = (await call("GET", "/v1/roles", { key: ws.keys.admin })).json.data.find((x: { key: string }) => x.key === "runner");
    const limited = await call("PATCH", `/v1/roles/${role.id}`, { key: ws.keys.admin, body: { objects: { contact: { read: false, write: false, archive: false } } } });
    expect(limited.status, JSON.stringify(limited.json)).toBe(200);
    const hidden = await call("POST", `/v1/automations/${auto.id}/run`, { key: runner.key, body: { records: [c.id] } });
    expect([403, 404]).toContain(hidden.status);
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("stamped");
  });

  it("counts against the hourly cap and refuses records of the wrong object", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Cap", email: uniqueEmail("cap") });
    auto = await automation(ws, { name: "Stamp 2", trigger: { type: "manual", object: "contact" }, hourly_cap: 2,
      actions: [{ type: "update_record", values: { job_title: "stamped" } }] });
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } })).status).toBe(202);
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } })).status).toBe(202);
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } })).status).toBe(429);
    await drain(ws);
    const d = await create(ws.keys.ops, "deal", { name: "Wrong", primary_contact: c.id });
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: [d.id] } })).status).toBe(422);
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: ["con_" + "0".repeat(26)] } })).status).toBe(404);
    await drain(ws);
  });

  it("pause and the workspace kill switch stop runs", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Pz", email: uniqueEmail("pz") });
    const ev = await automation(ws, { name: "On create", trigger: { event: "contact.created" }, actions: [{ type: "update_record", values: { job_title: "auto" } }] });
    expect((await call("POST", `/v1/automations/${ev.id}/pause`, { key: ws.keys.admin, body: { reason: "testing" } })).json.data.status).toBe("paused");
    const p1 = await create(ws.keys.ops, "contact", { first_name: "P1", email: uniqueEmail("p1") });
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${p1.id}`, { key: ws.keys.ops })).json.data.job_title).toBeNull();
    await call("POST", `/v1/automations/${ev.id}/resume`, { key: ws.keys.admin });
    expect((await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { paused: true } })).json.data.paused).toBe(true);
    const p2 = await create(ws.keys.ops, "contact", { first_name: "P2", email: uniqueEmail("p2") });
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${p2.id}`, { key: ws.keys.ops })).json.data.job_title).toBeNull();
    expect((await call("POST", `/v1/automations/${auto.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } })).status).toBe(409);
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { paused: false } });
    const p3 = await create(ws.keys.ops, "contact", { first_name: "P3", email: uniqueEmail("p3") });
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${p3.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("auto");
  });
});

describe("event triggers, loops and fairness", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto events");
  });

  it("restored and merged are triggers; moved references reach *.updated only when asked", async () => {
    const restored = await automation(ws, { name: "Back", trigger: { event: "contact.restored" }, actions: [{ type: "update_record", values: { job_title: "back" } }] });
    const updated = await automation(ws, { name: "Touched", trigger: { event: "deal.updated" }, actions: [{ type: "create_record", object: "task", values: { title: "touched {{record.name}}" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Gone", email: uniqueEmail("gone") });
    await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops });
    await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: ws.keys.ops });
    await drain(ws);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("back");
    expect((await runsOf(ws, restored.id))[0]!.status).toBe("succeeded");
    // A merge moves the deal's contact reference: a reference-move update, which this trigger leaves out.
    const keep = await create(ws.keys.ops, "contact", { first_name: "Keep", email: uniqueEmail("keep") });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Dup", email: uniqueEmail("dup") });
    await create(ws.keys.ops, "deal", { name: "Ref deal", primary_contact: dup.id });
    await drain(ws);
    const before = (await runsOf(ws, updated.id)).length;
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id] } });
    const merged = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(merged.status).toBe(200);
    await drain(ws);
    expect((await runsOf(ws, updated.id)).length).toBe(before);
  });

  it("stops a loop through the same record that carries no causation depth", async () => {
    const a = await automation(ws, { name: "Echo", trigger: { event: "contact.updated" }, actions: [{ type: "create_record", object: "task", values: { title: "echo", assignee: "{{record.owner}}" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Loop", email: uniqueEmail("loop") });
    for (let i = 0; i < 7; i++) {
      await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { job_title: `t${i}` } });
      await drain(ws);
    }
    const runs = await runsOf(ws, a.id);
    expect(runs.filter((r) => r.status === "succeeded")).toHaveLength(5);
    expect(runs.filter((r) => r.status === "skipped").every((r) => /loop guard/.test(r.reason ?? ""))).toBe(true);
  });

  it("a workspace cap skips the run instead of failing it", async () => {
    const a = await automation(ws, { name: "Capped", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "capped" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Capd", email: uniqueEmail("capd") });
    const start = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await withTenant(ws.tenantId, (tx) => tx`INSERT INTO automation_usage (tenant_id, bucket, window_start, n) VALUES (${ws.tenantId}, 'actions', ${start}, 5000)
      ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE SET n = 5000`);
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "skipped" });
    expect(r!.reason).toMatch(/hourly cap on automation actions/);
    await withTenant(ws.tenantId, (tx) => tx`DELETE FROM automation_usage`);
  });

  it("one pass runs at most one queued run per tenant, so a backlog can't starve another workspace", async () => {
    const other = await newWorkspace("Auto fair");
    const mk = async (w: Workspace) => automation(w, { name: "Fair", trigger: { type: "manual" }, hourly_cap: 100, actions: [{ type: "stop" }] });
    const busy = await mk(ws);
    const quiet = await mk(other);
    for (let i = 0; i < 6; i++) expect((await call("POST", `/v1/automations/${busy.id}/run`, { key: ws.keys.admin, body: {} })).status).toBe(202);
    expect((await call("POST", `/v1/automations/${quiet.id}/run`, { key: other.keys.admin, body: {} })).status).toBe(202);
    await runAutomationPass([ws.tenantId, other.tenantId]);
    expect((await runsOf(other, quiet.id))[0]!.status).toBe("succeeded");
    expect((await runsOf(ws, busy.id)).filter((r) => r.status === "succeeded")).toHaveLength(1);
    await drain(ws);
  });

  it("a slow run holds one slot: the next pass starts other tenants' runs without waiting for it", async () => {
    replies.set("/slow", { status: 200, body: "{}", delayMs: 1500 });
    const other = await newWorkspace("Auto fair 2");
    const slow = await automation(ws, { name: "Slow call", trigger: { type: "manual" }, actions: [{ type: "http_request", method: "GET", url: `${base}/slow` }] });
    const quick = await automation(other, { name: "Quick", trigger: { type: "manual" }, actions: [{ type: "stop" }] });
    await call("POST", `/v1/automations/${slow.id}/run`, { key: ws.keys.admin, body: {} });
    const t0 = Date.now();
    expect(await runAutomationPass([ws.tenantId], { wait: false })).toBe(1);
    await call("POST", `/v1/automations/${quick.id}/run`, { key: other.keys.admin, body: {} });
    await runAutomationPass([ws.tenantId, other.tenantId], { wait: true });
    expect(Date.now() - t0).toBeLessThan(1400);
    expect((await runsOf(other, quick.id))[0]!.status).toBe("succeeded");
    for (let i = 0; i < 40 && (await runsOf(ws, slow.id))[0]!.status !== "succeeded"; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await runsOf(ws, slow.id))[0]!.status).toBe("succeeded");
  });
});

describe("review fixes: bounded fills", () => {
  it("stops a fill as soon as it passes its budget, per placeholder, and refuses too many placeholders at save", async () => {
    const records = Array.from({ length: 40 }, (_, i) => ({ id: `con_${i}`, note: "x".repeat(2000) }));
    const scope = { record: null, event: null, steps: { f: { records } } };
    const template = "{{steps.f.records | json}}".repeat(60); // would be about 5 MB
    const t0 = Date.now();
    expect(() => fillString(template, scope, { target: "email", budget: budget(64 * 1024, "The email body") })).toThrow(DataError);
    expect(() => fillString(template, scope, { target: "email", budget: budget(64 * 1024, "The email body") })).toThrow(/longer than 65,536/);
    expect(Date.now() - t0).toBeLessThan(500);
    // A JSON body shares one budget across its strings, and a whole-value placeholder counts what it holds.
    expect(() => fillDeep({ a: "{{steps.f.records}}", b: ["{{steps.f.records}}"] }, scope, { budget: budget(100_000, "The request body") })).toThrow(/request body/);
    // Filters with arguments that would throw are refused when parsed; a filter that can't use a value is a data error.
    expect(() => parsePlaceholder("record.amount | number:-1")).toThrow(/0 to 10/);
    expect(() => parsePlaceholder("record.due | add_days:999999")).toThrow(/36500/);
    const ws = await newWorkspace("Auto budget save");
    const many = Array.from({ length: 51 }, () => "{{record.first_name}}").join(" ");
    const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Many", trigger: { event: "contact.created" },
      actions: [{ type: "update_record", values: { job_title: many } }] } });
    expect(r.status).toBe(422);
    expect(r.json.detail).toMatch(/placeholders; at most 50/);
  });

  it("a test run of a template that would grow to megabytes fails that step with a short reply", async () => {
    const ws = await newWorkspace("Auto budget test");
    await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records: Array.from({ length: 30 }, (_, i) => ({
      first_name: `Big ${i}`, email: uniqueEmail(`big${i}`), job_title: "j".repeat(1900) })) } });
    const body = "{{steps.f.records | json}}\n".repeat(40);
    const res = await call("POST", "/v1/automations/test", { key: ws.keys.admin, body: { automation: { name: "Huge", trigger: { type: "schedule", daily: { at: "09:00" } },
      actions: [{ type: "find_records", id: "f", object: "contact", limit: 200 }, { type: "send_email", to: { member: ws.ownerId }, subject: "x", body }] } } });
    expect(res.status).toBe(200);
    expect(res.json.data.error).toMatch(/email body would be longer than 65,536/);
    expect(JSON.stringify(res.json).length).toBeLessThan(200_000);
  });
});

describe("review fixes: what a recipient can infer", () => {
  let ws: Workspace;
  let limitedMember: { id: string; key: string };
  beforeAll(async () => {
    ws = await newWorkspace("Auto infer");
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "no_titles", name: "No titles", permissions: ["records:read", "records:write"] } });
    expect((await call("PATCH", `/v1/roles/${role.json.data.id}`, { key: ws.keys.admin, body: { fields: { contact: { job_title: "none" } } } })).status).toBe(200);
    limitedMember = await memberWithKey(ws, "no_titles", ["ops:read", "ops:write"]);
  });

  it("a step gated on a hidden field never reaches a member who can't read it, and the save says so", async () => {
    const ceo = await create(ws.keys.ops, "contact", { first_name: "Chief", email: uniqueEmail("ceo"), job_title: "CEO" });
    const other = await create(ws.keys.ops, "contact", { first_name: "Staff", email: uniqueEmail("staff"), job_title: "Staff" });
    const created = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "CEO gate", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "notify", title: "Look at {{record.first_name}}", recipients: { users: [limitedMember.id] }, if: { field: "job_title", op: "eq", value: "CEO" } },
      { type: "send_email", to: { member: limitedMember.id }, subject: "Hi", body: "About {{record.first_name}}", if: { field: "job_title", op: "eq", value: "CEO" } }] } });
    expect(created.status).toBe(201);
    expect(created.json.warnings.join(" ")).toContain(`${limitedMember.id} can't use the condition`);
    const before = mailer.sent.length;
    for (const c of [ceo, other]) await call("POST", `/v1/automations/${created.json.automation.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    expect((await call("GET", "/v1/me/notifications?state=all", { key: limitedMember.key })).json.data).toEqual([]);
    expect(mailer.sent.length).toBe(before);
    // A find_records inside for_each, filtering on the hidden field, counts too.
    const nested = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Nested", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "for_each", query: { object: "contact", limit: 2 }, steps: [{ type: "find_records", id: "chiefs", object: "contact", where: { field: "job_title", op: "eq", value: "CEO" } }] },
      { type: "notify", title: "Done", recipients: { users: [limitedMember.id] } }] } });
    expect(nested.json.warnings.join(" ")).toContain(limitedMember.id);
    await call("POST", `/v1/automations/${nested.json.automation.id}/run`, { key: ws.keys.admin, body: { records: [ceo.id] } });
    await drain(ws);
    expect((await call("GET", "/v1/me/notifications?state=all", { key: limitedMember.key })).json.data).toEqual([]);
  });

  it("a gate on an earlier step's output keeps a limited member out", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Gate", email: uniqueEmail("gate") });
    const a = await automation(ws, { name: "Count gate", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "find_records", id: "f", object: "account", limit: 5 },
      { type: "stop", if: { output: "{{steps.f.count}}", op: "gt", value: 100 } },
      { type: "notify", title: "Reached {{record.first_name}}", recipients: { users: [limitedMember.id, ws.ownerId] } }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    expect((await call("GET", "/v1/me/notifications?state=all", { key: limitedMember.key })).json.data).toEqual([]);
    expect(JSON.stringify((await call("GET", "/v1/me/notifications?state=all", { key: ws.keys.admin })).json)).toContain("Reached Gate");
  });

  it("an external email to an address the change's author set is skipped when their role can't read what it carries", async () => {
    expect((await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true } })).status).toBe(200);
    const created = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Title out", trigger: { event: "contact.updated" },
      actions: [{ type: "send_email", to: { field: "email" }, subject: "Your title", body: "Title: {{record.job_title}}" }] } });
    expect(created.status).toBe(201);
    expect(created.json.warnings.join(" ")).toMatch(/no_titles \(can't read contact.job_title\)/);
    const c = await create(ws.keys.ops, "contact", { first_name: "Victim", email: uniqueEmail("victim"), job_title: `secret-title-${Date.now()}` });
    await drain(ws);
    const mine = uniqueEmail("attacker");
    expect((await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: limitedMember.key, body: { email: mine } })).status).toBe(200);
    await drain(ws);
    expect(mailer.lastTo(mine)).toBeUndefined();
    const [r] = await runsOf(ws, created.json.automation.id);
    expect(r!.status).toBe("succeeded");
    expect(r!.results[0]!.skipped).toMatch(/recipient was set by usr_/);
    // The same change by someone who can read the title sends it.
    const theirs = uniqueEmail("owner");
    await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { email: theirs } });
    await drain(ws);
    expect(mailer.lastTo(theirs)?.text).toContain("secret-title-");
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: false } });
    await call("DELETE", `/v1/automations/${created.json.automation.id}`, { key: ws.keys.admin });
  });

  it("a run_roles member can't run an automation that writes what their role can't", async () => {
    await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "ro_titles", name: "Read-only titles", permissions: ["records:read", "records:write"],
      fields: { contact: { job_title: "read" } } } });
    const runner = await memberWithKey(ws, "ro_titles", ["ops:read", "ops:write"]);
    const c = await create(ws.keys.ops, "contact", { first_name: "W", email: uniqueEmail("w") });
    const a = await automation(ws, { name: "Writes title", trigger: { type: "manual", object: "contact" }, run_roles: ["ro_titles"],
      actions: [{ type: "update_record", values: { job_title: "set" } }] });
    const r = await call("POST", `/v1/automations/${a.id}/run`, { key: runner.key, body: { records: [c.id] } });
    expect(r.status).toBe(403);
    expect(r.json.detail).toMatch(/can't write contact.job_title/);
    const ok = await automation(ws, { name: "Writes name", trigger: { type: "manual", object: "contact" }, run_roles: ["ro_titles"],
      actions: [{ type: "update_record", values: { first_name: "Set" } }] });
    expect((await call("POST", `/v1/automations/${ok.id}/run`, { key: runner.key, body: { records: [c.id] } })).status).toBe(202);
    await drain(ws);
  });
});

describe("review fixes: record data can't pause an automation", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto data failures");
  });

  it("strips control characters from headers, and a target's 4xx on record data fails runs without pausing", async () => {
    const nl = await create(ws.keys.ops, "contact", { first_name: "Line\nBreak", email: uniqueEmail("nl"), job_title: "[restricted]" });
    const a = await automation(ws, { name: "Header", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "http_request", method: "POST", url: `${base}/hdr`, headers: { "X-Name": "{{record.first_name}}" }, body: { title: "{{record.job_title}}" } }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [nl.id] } });
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.status).toBe("succeeded");
    const hit = at("/hdr").at(-1)!;
    expect(hit.headers["x-name"]).toBe("LineBreak");
    // A value that is literally "[restricted]" is just text: it goes out like any other.
    expect(JSON.parse(hit.body).title).toBe("[restricted]");
    replies.set("/junk", { status: 422, body: "{}" });
    const b = await automation(ws, { name: "Junk", trigger: { type: "manual", object: "contact" }, actions: [{ type: "http_request", method: "POST", url: `${base}/junk`, body: { n: "{{record.first_name}}" } }] });
    for (let i = 0; i < 6; i++) {
      expect((await call("POST", `/v1/automations/${b.id}/run`, { key: ws.keys.admin, body: { records: [nl.id] } })).status).toBe(202);
      await drain(ws);
    }
    const runs = await runsOf(ws, b.id) as (Awaited<ReturnType<typeof runsOf>>[number] & { failure: string | null })[];
    expect(runs.every((r) => r.status === "failed" && r.failure === "data")).toBe(true);
    expect(runs[0]!.reason).toMatch(/not counted towards the automatic pause/);
    const got = (await call("GET", `/v1/automations/${b.id}`, { key: ws.keys.admin })).json.data;
    expect(got).toMatchObject({ status: "enabled", consecutive_failures: 0 });
  });

  it("an address from a record that can't be emailed skips the email, and the server ceiling skips the run", async () => {
    expect(validAddress("o'brien+news@mail_relay.example.co.uk")).toBe(true);
    for (const bad of ["a,b@example.com", "\"a\"@example.com", "a<b>@example.com", "a@b@example.com", "a@example", "a..b@example.com"]) expect(validAddress(bad), bad).toBe(false);
    expect(addressProblem("jürgen@example.de")).toMatch(/ASCII/);
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true } });
    const c = await create(ws.keys.ops, "contact", { first_name: "Uni", email: "jürgen.ü@example.de" });
    const a = await automation(ws, { name: "Mail", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "send_email", to: { field: "email" }, subject: "Hi", body: "Hello" }, { type: "update_record", values: { job_title: "after mail" } }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    let [r] = await runsOf(ws, a.id);
    expect(r!.status).toBe("succeeded");
    expect(r!.results[0]!.skipped).toMatch(/ASCII/);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("after mail");
    // The server-wide ceiling is no fault of this automation: a cap skip, not a failure.
    const ok = await create(ws.keys.ops, "contact", { first_name: "Fine", email: uniqueEmail("fine") });
    for (let i = 0; i < 600; i++) hit(LIMITS.automationEmail, "all");
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [ok.id] } });
    await drain(ws);
    resetSignInLimits();
    [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/server's automation email ceiling/) });
    expect((await call("GET", `/v1/automations/${a.id}`, { key: ws.keys.admin })).json.data.consecutive_failures).toBe(0);
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: false } });
  });

  it("keeps recipient addresses out of a refused send's reason", async () => {
    const m = await memberWithKey(ws, "member", ["ops:read"]);
    const addr = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id)?.email as string;
    const refusing = { name: "refusing", enabled: true, async send(e: { to: string }) {
      throw Object.assign(new Error(`550 5.1.1 <${e.to}>: Recipient address rejected`), { responseCode: 550 });
    } };
    const a = await automation(ws, { name: "Refused", trigger: { type: "manual" }, actions: [{ type: "send_email", to: { member: m.id }, subject: "s", body: "b" }] });
    setMailer(refusing);
    try {
      await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: {} });
      await drain(ws);
    } finally {
      setMailer(mailer);
    }
    const [r] = await runsOf(ws, a.id) as (Awaited<ReturnType<typeof runsOf>>[number] & { failure: string | null })[];
    expect(r).toMatchObject({ status: "failed", failure: "data" });
    expect(r!.reason).toContain("<address>");
    expect(JSON.stringify(r)).not.toContain(addr);
  });
});

describe("review fixes: URL paths", () => {
  it("refuses a filled segment that is empty, . or .., and keeps the template's path", () => {
    const scope = (v: Record<string, unknown>) => ({ record: v, event: null });
    const t = "https://api.example/v1/lists/123/members/{{record.x}}/tags";
    expect(fillUrl(t, scope({ x: "a b" }))).toBe("https://api.example/v1/lists/123/members/a%20b/tags");
    for (const x of ["..", ".", "", null]) expect(() => fillUrl(t, scope({ x })), String(x)).toThrow(/path segment/i);
    expect(() => fillUrl("https://api.example/v1/{{record.a}}{{record.b}}/x", scope({ a: ".", b: "." }))).toThrow(/path segment/i);
    expect(() => fillUrl("https://api.example/v1/%2e{{record.a}}/x", scope({ a: "." }))).toThrow(/path segment/i);
    expect(fillUrl("https://api.example/v1/{{record.a}}?q={{record.b}}", scope({ a: "x/y", b: "../?&" }))).toBe("https://api.example/v1/x%2Fy?q=..%2F%3F%26");
    expect(samePath("https://api.example/v1/{{record.a}}/x", "/v1/p/x")).toBe(true);
    expect(samePath("https://api.example/v1/{{record.a}}/x", "/x")).toBe(false);
  });

  it("a run whose record value would climb the path fails as a data error and sends nothing", async () => {
    const ws = await newWorkspace("Auto dotdot");
    const c = await create(ws.keys.ops, "contact", { first_name: "Dots", email: uniqueEmail("dots"), job_title: ".." });
    const a = await automation(ws, { name: "Members", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "http_request", id: "tag", method: "POST", url: `${base}/v1/lists/123/members/{{record.job_title}}/tags`, secret_headers: { Authorization: "Bearer list-secret" }, body: {} }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    const [r] = await runsOf(ws, a.id);
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/path segment/i) });
    expect(at("/v1/lists/123/tags")).toHaveLength(0);
  });
});

describe("review fixes: fairness of event processing", () => {
  it("a tenant with slow inline automations delays another tenant's events by about its time budget, not its backlog", async () => {
    const busy = await newWorkspace("Auto busy events");
    const quiet = await newWorkspace("Auto quiet events");
    for (let i = 0; i < 4; i++) {
      await automation(busy, { name: `Slow ${i}`, trigger: { event: "contact.created" }, actions: [
        { type: "update_record", values: { job_title: `a${i}` } }, { type: "update_record", values: { job_title: `b${i}` } }, { type: "update_record", values: { job_title: `c${i}` } }] });
    }
    for (let k = 0; k < 2; k++) {
      expect((await call("POST", "/v1/objects/contact/records/batch", { key: busy.keys.ops, body: { records: Array.from({ length: 100 }, (_, i) => ({
        first_name: `B${k}-${i}`, email: uniqueEmail(`busy${k}${i}`) })) } })).status).toBe(201);
    }
    await automation(quiet, { name: "Seen", trigger: { event: "contact.created" }, actions: [{ type: "update_record", values: { job_title: "seen" } }] });
    const q = await create(quiet.keys.ops, "contact", { first_name: "Quiet", email: uniqueEmail("quiet") });
    const saved = EVENTS_TENANT_BUDGET_MS.value;
    EVENTS_TENANT_BUDGET_MS.value = 200;
    try {
      const t0 = Date.now();
      await processEventsRound([busy.tenantId, quiet.tenantId]);
      expect(Date.now() - t0).toBeLessThan(2_500);
    } finally {
      EVENTS_TENANT_BUDGET_MS.value = saved;
    }
    expect((await call("GET", `/v1/objects/contact/records/${q.id}`, { key: quiet.keys.ops })).json.data.job_title).toBe("seen");
    const [left] = await withTenant(busy.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE processed_at IS NULL`);
    expect(left!.n).toBeGreaterThan(50);
  });

  it("queues event automations that query, so they run on the worker, not inside event processing", async () => {
    const ws = await newWorkspace("Auto queued finds");
    const a = await automation(ws, { name: "Finder", trigger: { event: "contact.created" }, actions: [{ type: "find_records", id: "f", object: "contact", limit: 1 }] });
    await create(ws.keys.ops, "contact", { first_name: "F", email: uniqueEmail("f") });
    await processEvents(ws.tenantId);
    expect((await runsOf(ws, a.id))[0]!.status).toBe("queued");
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.status).toBe("succeeded");
  });
});

describe("review fixes: progress, resume and caps", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Auto progress");
  });

  it("saves a small progress, and a run picked up again goes on in its loop with its per-run counters", async () => {
    const tag = uniq("resume");
    const made = [];
    for (let i = 0; i < 4; i++) made.push(await create(ws.keys.ops, "contact", { first_name: `R${i}`, email: uniqueEmail(`r${i}`), job_title: tag }));
    const a = await automation(ws, { name: "Loop", trigger: { type: "manual" }, actions: [
      { type: "find_records", id: "big", object: "contact", limit: 200 },
      { type: "for_each", query: { object: "contact", where: { field: "job_title", op: "eq", value: tag }, limit: 10 }, steps: [{ type: "update_record", values: { job_title: "resumed" } }] }] });
    const queue = async (progress: unknown) => {
      const run = (await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: {} })).json.data.runs[0].id as string;
      await withTenant(ws.tenantId, (tx) => tx`UPDATE automation_runs SET status = 'running', attempts = 1, locked_until = now() - interval '1 minute',
        progress = ${tx.json(progress as never)} WHERE id = ${decodeId(run)!.uuid}`);
    };
    // The worker stopped after the loop's second item: the run goes on with the third, from the items it saved.
    await queue({ cursor: "2.2.1", loop: { path: "2", object: "contact", ids: made.map((c) => c.id) }, counters: { executed: 4, http: 0, emails: 0 } });
    await drain(ws);
    const titles = await Promise.all(made.map(async (c) => (await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.job_title));
    expect(titles).toEqual([tag, tag, "resumed", "resumed"]);
    expect((await runsOf(ws, a.id))[0]!.status).toBe("succeeded");
    // The per-run step count carries over: a run that had used its budget can't start over with a fresh one.
    await queue({ cursor: "2.2.1", loop: { path: "2", object: "contact", ids: made.map((c) => c.id) }, counters: { executed: 999, http: 0, emails: 0 } });
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.reason).toMatch(/more than 1000 steps/);
  });

  it("writes the step log every few steps and keeps only outputs a later step uses", async () => {
    const tag = uniq("many");
    await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records: Array.from({ length: 60 }, (_, i) => ({ first_name: `M${i}`, email: uniqueEmail(`m${i}`), job_title: tag })) } });
    replies.set("/slowp", { status: 200, body: "{}", delayMs: 700 });
    const a = await automation(ws, { name: "Many", trigger: { type: "manual" }, actions: [
      { type: "find_records", id: "big", object: "contact", limit: 200 },
      { type: "for_each", query: { object: "contact", where: { field: "job_title", op: "eq", value: tag }, limit: 60 }, steps: [{ type: "update_record", values: { first_name: "x" } }] },
      { type: "http_request", method: "GET", url: `${base}/slowp` }] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: {} });
    const before = { ...progressWrites };
    await runAutomationPass([ws.tenantId], { wait: false });
    let saved = "";
    for (let i = 0; i < 50 && !saved.includes("\"2.60.1\""); i++) {
      await new Promise((r) => setTimeout(r, 50));
      const [row] = await withTenant(ws.tenantId, (tx) => tx<{ p: string | null }[]>`SELECT progress::text AS p FROM automation_runs WHERE automation_id = ${decodeId(a.id)!.uuid}`);
      saved = row?.p ?? "";
    }
    // While the request is in flight: the cursor, the loop's 60 IDs and the counters; not the 60 records find_records returned.
    expect(saved).toContain("\"cursor\"");
    expect(saved).not.toContain("\"vars\"");
    expect(saved.length).toBeLessThan(4_000);
    for (let i = 0; i < 40 && (await runsOf(ws, a.id))[0]!.status !== "succeeded"; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await runsOf(ws, a.id))[0]!.status).toBe("succeeded");
    expect(progressWrites.vars - before.vars).toBe(0);
    expect(progressWrites.results - before.results).toBeLessThanOrEqual(5); // 63 steps, written every 25 and around the send
  });

  it("caps and suppressions treat plus-addressed variants as one mailbox", async () => {
    expect(mailbox("Ann+News@Example.com")).toBe("ann@example.com");
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: true } });
    const base0 = uniqueEmail("plus");
    const [local, domain] = base0.split("@");
    const a = await automation(ws, { name: "Plus", trigger: { type: "manual", object: "contact" }, actions: [{ type: "send_email", to: { field: "email" }, subject: "s", body: "b" }] });
    const sentTo = new Set<string>();
    for (let i = 0; i < 7; i++) {
      const addr = `${local}+${i}@${domain}`;
      const c = await create(ws.keys.ops, "contact", { first_name: `P${i}`, email: addr });
      await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
      await drain(ws);
      if (mailer.lastTo(addr)) sentTo.add(addr);
    }
    expect(sentTo.size).toBe(5);
    expect((await runsOf(ws, a.id))[0]!.results[0]!.skipped).toMatch(/today/);
    // A suppression covers the mailbox: added for one +tag variant, it stops the plain address and every other variant.
    const other = uniqueEmail("sup2");
    const [l2, d2] = other.split("@");
    expect((await call("POST", "/v1/email-suppressions", { key: ws.keys.admin, body: { email: `${l2}+promo@${d2}` } })).status).toBe(201);
    for (const e of [other, `${l2}+news@${d2}`]) expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email: e } })).json.data.suppressed, e).toBe(true);
    const c = await create(ws.keys.ops, "contact", { first_name: "Sup", email: other });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]!.results[0]!.skipped).toMatch(/suppression/);
    await call("PATCH", "/v1/automation-settings", { key: ws.keys.admin, body: { external_email: false } });
  });

  it("tells the admins the first time a workspace cap skips runs in a window, and shows cap skips apart", async () => {
    const a = await automation(ws, { name: "Capped twice", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "capped" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Cap", email: uniqueEmail("cap2") });
    const start = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    await withTenant(ws.tenantId, (tx) => tx`INSERT INTO automation_usage (tenant_id, bucket, window_start, n) VALUES (${ws.tenantId}, 'actions', ${start}, 5000)
      ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE SET n = 5000`);
    for (let i = 0; i < 2; i++) {
      await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
      await drain(ws);
    }
    const runs = await runsOf(ws, a.id) as (Awaited<ReturnType<typeof runsOf>>[number] & { cap: string | null })[];
    expect(runs.map((r) => [r.status, r.cap])).toEqual([["skipped", "actions"], ["skipped", "actions"]]);
    const inbox = (await call("GET", "/v1/me/notifications?state=all", { key: ws.keys.admin })).json.data as { title: string; body: string }[];
    const notices = inbox.filter((n) => n.title === "Automation cap reached: Capped twice");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toMatch(/hourly cap on automation actions/);
    const [marks] = await withTenant(ws.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM automation_usage WHERE bucket = 'notice:actions'`);
    expect(marks!.n).toBe(1);
    await withTenant(ws.tenantId, (tx) => tx`DELETE FROM automation_usage`);
  });

  it("an update_record that names its record declares the object, and a record of another object is refused", async () => {
    const bad = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "No object", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "update_record", record: "{{record.account}}", values: { nonexistent_field: "x" } }] } });
    expect(bad.status).toBe(422);
    expect(bad.json.detail).toMatch(/needs "object"/);
    const checked = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Checked", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "update_record", record: "{{record.id}}", object: "account", values: { nonexistent_field: "x" } }] } });
    expect(checked.status).toBe(422);
    expect(checked.json.detail).toMatch(/not a field of account/);
    const a = await automation(ws, { name: "Wrong object", trigger: { type: "manual", object: "contact" },
      actions: [{ type: "update_record", record: "{{record.id}}", object: "account", values: { name: "renamed" } }] });
    const c = await create(ws.keys.ops, "contact", { first_name: "Obj", email: uniqueEmail("obj") });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    expect((await runsOf(ws, a.id))[0]).toMatchObject({ status: "failed", reason: expect.stringMatching(/is a contact, and this step updates account records/) });
  });
});
