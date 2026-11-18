import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScheduler } from "../src/core/alerts.js";
import { DEFAULT_PREFS, emailSchedule, nextLocalTime, sendDueEmails, type Prefs } from "../src/core/notifications.js";
import { verify } from "../src/core/webhooks.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { setMailer, type OutgoingEmail } from "../src/providers/mailer.js";
import { deliverDue, processEvents } from "../src/worker/events.js";
import { call, create, newWorkspace, validate, type Schema, type Workspace } from "./helpers.js";

process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = "true";

const sent: OutgoingEmail[] = [];
setMailer({ name: "fake", enabled: true, send: async (e) => void sent.push(e) });

const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);
const uniq = (s: string) => `${s}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function drain(ws: Workspace) {
  for (let i = 0; i < 20; i++) if ((await processEvents(ws.tenantId)) + (await deliverDue(ws.tenantId)) === 0) return;
}
async function inbox(key: string, state = "open") {
  return (await call("GET", `/v1/me/notifications?state=${state}`, { key })).json.data as { id: string; title: string; state: string; fire_count: number; severity: string; record: { id: string } }[];
}
async function ownerEmail(ws: Workspace) {
  return (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users[0].email as string;
}

describe("preferences and scheduling helpers", () => {
  it("computes the next local time across time zones", () => {
    const now = new Date("2026-03-01T20:00:00Z"); // 13:00 in Denver (MST, UTC-7)
    expect(nextLocalTime(now, "America/Denver", 8, 0).toISOString()).toBe("2026-03-02T15:00:00.000Z");
    expect(nextLocalTime(now, "UTC", 21, 30).toISOString()).toBe("2026-03-01T21:30:00.000Z");
    // Across the US daylight-saving change at 02:00 on 2026-03-08: 08:00 that morning is MDT, 14:00 UTC.
    expect(nextLocalTime(new Date("2026-03-07T20:00:00Z"), "America/Denver", 8, 0).toISOString()).toBe("2026-03-08T14:00:00.000Z");
    expect(nextLocalTime(new Date("2026-03-08T16:00:00Z"), "America/Denver", 8, 0).toISOString()).toBe("2026-03-09T14:00:00.000Z");
  });

  it("holds non-critical email during quiet hours, sends critical at once, and schedules digests", () => {
    const prefs: Prefs = { ...DEFAULT_PREFS, timezone: "UTC", quiet_hours: { start: "22:00", end: "07:00" }, email: { info: "digest", warning: "immediate", critical: "immediate" } };
    const night = new Date("2026-05-01T23:30:00Z");
    expect(emailSchedule(night, prefs, "warning")).toEqual({ mode: "immediate", at: new Date("2026-05-02T07:00:00Z") });
    expect(emailSchedule(night, prefs, "critical")).toEqual({ mode: "immediate", at: night });
    expect(emailSchedule(night, prefs, "info")).toEqual({ mode: "digest", at: new Date("2026-05-02T08:00:00Z") });
    expect(emailSchedule(night, { ...prefs, email: { ...prefs.email, info: "off" } }, "info")).toBeNull();
  });

  it("validates preferences", async () => {
    const ws = await newWorkspace("Prefs");
    expect((await call("PATCH", "/v1/me/notification-preferences", { key: ws.keys.ops, body: { timezone: "Mars/Olympus" } })).status).toBe(422);
    const ok = await call("PATCH", "/v1/me/notification-preferences", { key: ws.keys.ops, body: { timezone: "America/Denver", email: { info: "digest" } } });
    expect(ok.json.data).toMatchObject({ timezone: "America/Denver", email: { info: "digest", warning: "immediate" } });
  });
});

describe("the 14-day scenario (definition of done)", () => {
  let ws: Workspace;
  let quiet: { id: string };
  let busy: { id: string };
  let hookId = "";
  let secret = "";
  let ruleId = "";
  const rule = {
    name: "Deal untouched for 14 days", description: "Open deals need a touch at least every two weeks.", object: "deal",
    trigger: { type: "inactive", days: 14 }, condition: { field: "status", op: "eq", value: "open" }, severity: "warning",
  };

  beforeAll(async () => {
    ws = await newWorkspace("Untouched");
    const contact = await create(ws.keys.ops, "contact", { first_name: "Una", email: `${uniq("una")}@example.com` });
    quiet = await create(ws.keys.ops, "deal", { name: "Quiet deal", amount: 12000, primary_contact: contact.id });
    busy = await create(ws.keys.ops, "deal", { name: "Busy deal", amount: 8000, primary_contact: contact.id });
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/alerts` } });
    hookId = hook.json.data.id;
    secret = hook.json.data.secret;
    await drain(ws);
  });

  it("dry run shows a summary and a backtest, and saves nothing", async () => {
    const r = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: { ...rule, webhooks: [hookId], dry_run: true } });
    expect(r.status).toBe(200);
    expect(r.json.summary).toContain("no update or logged activity for 14 days");
    expect(r.json.backtest).toMatchObject({ would_fire_on_save: 0, approximate: true });
    expect((await call("GET", "/v1/alerts", { key: ws.keys.admin })).json.data).toEqual([]);
  });

  it("saves; nothing fires before 14 days", async () => {
    const r = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: { ...rule, webhooks: [hookId] } });
    expect(r.status).toBe(201);
    ruleId = r.json.alert.id;
    expect(r.json.alert.deadlines).toBe("building");
    expect((await runScheduler(ws.tenantId)).fired).toBe(0);
    expect((await call("GET", `/v1/alerts/${ruleId}`, { key: ws.keys.admin })).json.data.deadlines).toBe("ready");
    expect((await runScheduler(ws.tenantId, later(13))).fired).toBe(0);
  });

  it("a logged activity counts as a touch", async () => {
    const r = await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", subject: "Check-in", related_to: [busy.id], occurred_at: later(10).toISOString() } });
    expect(r.status).toBe(201);
    await drain(ws);
    const [d] = await withTenant(ws.tenantId, (tx) => tx`SELECT due_at FROM rule_deadlines WHERE record_id = (SELECT id FROM deals WHERE name = 'Busy deal')`);
    expect((d!.due_at as Date).getTime()).toBeGreaterThan(later(23).getTime());
  });

  it("fires on schedule: inbox, signed webhook and email; restricted values never leave", async () => {
    const result = await runScheduler(ws.tenantId, later(15));
    expect(result.fired).toBe(1);
    const items = await inbox(ws.keys.ops);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Deal untouched for 14 days: Quiet deal", state: "unread", severity: "warning", record: { id: quiet.id } });

    await drain(ws);
    const hit = received.find((r) => JSON.parse(r.body).type === "alert.fired");
    expect(hit).toBeDefined();
    const h = hit!.headers;
    expect(verify(secret, { id: h["webhook-id"] as string, timestamp: h["webhook-timestamp"] as string, signature: h["webhook-signature"] as string }, hit!.body)).toBe(true);
    const payload = JSON.parse(hit!.body);
    expect(payload).toMatchObject({ record: { name: "Quiet deal", amount: 12000 }, data: { alert: { id: ruleId, severity: "warning" }, notifications: [items[0]!.id] } });

    expect(await sendDueEmails(ws.tenantId, later(15))).toBe(1);
    const mail = sent.at(-1)!;
    expect(mail.to).toBe(await ownerEmail(ws));
    expect(mail.subject).toContain("Warning: Deal untouched for 14 days: Quiet deal");
    expect(mail.text).toContain(items[0]!.id);
    const detail = await call("GET", `/v1/me/notifications/${items[0]!.id}`, { key: ws.keys.ops });
    expect(detail.json.data.deliveries).toMatchObject([{ channel: "email", status: "sent" }]);
  });

  it("re-running the scheduler creates no duplicates", async () => {
    const emails = sent.length;
    const hooks = received.length;
    for (const d of [15, 15, 16, 20]) expect((await runScheduler(ws.tenantId, later(d))).fired).toBe(0);
    await drain(ws);
    await sendDueEmails(ws.tenantId, later(20));
    expect(await inbox(ws.keys.ops, "all")).toHaveLength(1);
    expect(sent.length).toBe(emails);
    expect(received.length).toBe(hooks);
  });

  it("get_attention_summary puts it first; resolving closes it", async () => {
    const s = await call("GET", "/v1/me/attention", { key: ws.keys.ops });
    expect(s.json.data.counts.warning).toBe(1);
    expect(s.json.data.items[0]).toMatchObject({ title: "Deal untouched for 14 days: Quiet deal", why: rule.description });
    const id = s.json.data.items[0].id;
    expect((await call("POST", `/v1/me/notifications/${id}/resolve`, { key: ws.keys.ops })).json.data.state).toBe("resolved");
    expect((await call("GET", "/v1/me/attention", { key: ws.keys.ops })).json.data.items).toEqual([]);
    expect((await runScheduler(ws.tenantId, later(30))).fired).toBe(1); // the busy deal finally goes quiet
    expect((await inbox(ws.keys.ops)).map((n) => n.record.id)).toEqual([busy.id]);
  });

  it("ops keys cannot create workspace alerts", async () => {
    expect((await call("POST", "/v1/alerts", { key: ws.keys.ops, body: rule })).status).toBe(403);
  });
});

describe("event rules, dedupe, cooldown and snooze", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Events");
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "passport", type: "text", sensitivity: "restricted" } })).status).toBe(201);
  });

  it("an event rule notifies once while open, and email never carries restricted values", async () => {
    const r = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: "VIP changed", object: "contact", trigger: { type: "event", event: "contact.updated" }, condition: { field: "job_title", op: "eq", value: "CEO" },
      severity: "critical",
    } });
    expect(r.status).toBe(201);
    const c = await create(ws.keys.admin, "contact", { first_name: "Vic", last_name: "Ip", email: `${uniq("vip")}@example.com`, passport: "P-99887766" });
    for (const t of ["CTO", "CEO", "CEO", "CEO"]) await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { job_title: t, last_name: `Ip ${t}${Math.random()}` } });
    await drain(ws);
    const items = await inbox(ws.keys.ops);
    expect(items).toHaveLength(1);
    expect(items[0]!.fire_count).toBe(1);
    await sendDueEmails(ws.tenantId);
    const mail = sent.at(-1)!;
    expect(mail.subject).toContain("Critical: VIP changed");
    expect(JSON.stringify(sent)).not.toContain("P-99887766");
  });

  it("a cooldown re-notifies while the condition still holds", async () => {
    const r = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: "Task overdue", object: "task", trigger: { type: "field_passed", field: "due_at" }, cooldown_hours: 24, severity: "info",
      condition: { field: "status", op: "eq", value: "open" },
    } });
    expect(r.status).toBe(201);
    const me = (await call("GET", "/v1/me", { key: ws.keys.ops })).json.actor.id;
    await create(ws.keys.ops, "task", { title: "Send proposal", assignee: me, due_at: later(1).toISOString() });
    await drain(ws);
    const at = (h: number) => new Date(Date.now() + DAY + h * 3_600_000);
    expect((await runScheduler(ws.tenantId, at(1))).fired).toBe(1);
    expect((await runScheduler(ws.tenantId, at(2))).fired).toBe(0);
    expect((await runScheduler(ws.tenantId, at(26))).fired).toBe(1);
    const task = (await inbox(ws.keys.ops)).find((n) => n.title.startsWith("Task overdue"))!;
    expect(task.fire_count).toBe(2);
  });

  it("snoozed notifications come back as unread", async () => {
    const [n] = await inbox(ws.keys.ops);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call("POST", `/v1/me/notifications/${n!.id}/snooze`, { key: ws.keys.ops, body: { until } })).json.data.state).toBe("snoozed");
    expect((await call("POST", `/v1/me/notifications/${n!.id}/snooze`, { key: ws.keys.ops, body: { until: "2001-01-01T00:00:00Z" } })).status).toBe(422);
    await runScheduler(ws.tenantId, new Date(Date.now() + 2 * 3_600_000));
    expect((await call("GET", `/v1/me/notifications/${n!.id}`, { key: ws.keys.ops })).json.data.state).toBe("unread");
  });

  it("service-account keys have no inbox", async () => {
    const sa = await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: uniq("bot"), role: "member" } });
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "bot key", scopes: ["ops:read"], owner: sa.json.data.id } });
    expect((await call("GET", "/v1/me/notifications", { key: k.json.data.secret })).status).toBe(403);
  });
});

describe("recipients who can't read records", () => {
  it("get no notification, and queued email is dropped once a recipient is disabled or loses records:read", async () => {
    const ws = await newWorkspace("Recipients");
    const blind = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "auditor_only", name: "Auditor", permissions: ["audit:read"] } });
    expect(blind.status).toBe(201);
    const add = async (role: string) => (await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: `${uniq(role)}@example.com`, name: role, role } })).json.data.id as string;
    const auditor = await add("auditor_only");
    const leaver = await add("member");
    const demoted = await add("member");
    const r = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: "New account", object: "account", trigger: { type: "event", event: "account.created" }, severity: "warning",
      recipients: { record_owner: false, users: [auditor, leaver, demoted] },
    } });
    expect(r.status).toBe(201);
    expect(r.json.warnings.join(" ")).toContain(auditor);
    await create(ws.keys.ops, "account", { name: "Secret Co" });
    await drain(ws);
    const rows = await withTenant(ws.tenantId, (tx) => tx<{ user_id: string }[]>`SELECT user_id FROM notifications`);
    const ids = (u: string) => decodeId(u)!.uuid;
    expect(rows.map((x) => x.user_id).sort()).toEqual([ids(leaver), ids(demoted)].sort());

    expect((await call("PATCH", `/v1/members/${leaver}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(200);
    expect((await call("PATCH", `/v1/members/${demoted}`, { key: ws.keys.admin, body: { role: "auditor_only" } })).status).toBe(200);
    const before = sent.length;
    expect(await sendDueEmails(ws.tenantId)).toBe(2);
    expect(sent.length).toBe(before);
    const deliveries = await withTenant(ws.tenantId, (tx) => tx<{ status: string; last_error: string }[]>`SELECT status, last_error FROM notification_deliveries`);
    expect(deliveries).toEqual([
      { status: "skipped", last_error: "recipient is disabled or can no longer read this record's object" },
      { status: "skipped", last_error: "recipient is disabled or can no longer read this record's object" },
    ]);
  });
});

describe("personal alerts, digests and the notify action", () => {
  it("a personal alert covers only my records, and digests group email", async () => {
    const ws = await newWorkspace("Personal");
    await call("PATCH", "/v1/me/notification-preferences", { key: ws.keys.ops, body: { email: { warning: "digest" }, digest_hour: 8, timezone: "UTC" } });
    const member = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: `${uniq("m")}@example.com`, name: "Mo", role: "member" } });
    const preview = await call("POST", "/v1/me/alerts", { key: ws.keys.ops, body: {
      name: "My big deals", object: "deal", trigger: { type: "event", event: "deal.created" }, condition: { field: "amount", op: "gte", value: 5000 }, dry_run: true,
    } });
    expect(preview.status).toBe(200);
    expect(preview.json.summary).toContain("Notify you");
    const saved = await call("POST", "/v1/me/alerts", { key: ws.keys.ops, body: {
      name: "My big deals", object: "deal", trigger: { type: "event", event: "deal.created" }, condition: { field: "amount", op: "gte", value: 5000 },
    } });
    expect(saved.status).toBe(201);
    expect((await call("GET", "/v1/me/alerts", { key: ws.keys.ops })).json.data).toHaveLength(1);
    const contact = await create(ws.keys.ops, "contact", { first_name: "Pat", email: `${uniq("pat")}@example.com` });
    await create(ws.keys.ops, "deal", { name: "Mine A", amount: 9000, primary_contact: contact.id });
    await create(ws.keys.ops, "deal", { name: "Mine B", amount: 7000, primary_contact: contact.id });
    await create(ws.keys.ops, "deal", { name: "Small", amount: 100, primary_contact: contact.id });
    await create(ws.keys.ops, "deal", { name: "Theirs", amount: 9000, primary_contact: contact.id, owner: member.json.data.id });
    await drain(ws);
    expect((await inbox(ws.keys.ops)).map((n) => n.title).sort()).toEqual(["My big deals: Mine A", "My big deals: Mine B"]);
    const before = sent.length;
    expect(await sendDueEmails(ws.tenantId)).toBe(0); // held for the 08:00 digest
    expect(await sendDueEmails(ws.tenantId, nextLocalTime(new Date(), "UTC", 8, 1))).toBe(2);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)!.subject).toContain("Daily digest: 2 notifications");
  });

  it("an automation can notify the record owner", async () => {
    const ws = await newWorkspace("Notify");
    const a = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "New account heads-up", trigger: { event: "account.created" },
      actions: [{ type: "notify", title: "New account: {{record.name}}", severity: "info", recipients: { record_owner: true } }],
    } });
    expect(a.status).toBe(201);
    await create(ws.keys.ops, "account", { name: "Umbrella" });
    await drain(ws);
    const items = await inbox(ws.keys.ops);
    expect(items.map((n) => n.title)).toEqual(["New account: Umbrella"]);
  });
});

describe("typed responses of the notification, alert, webhook and event routes", () => {
  it("real responses match what the routes declare", async () => {
    const ws = await newWorkspace("Typed");
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const declared = (template: string, method: string, status: number) =>
      (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method.toLowerCase()]!
        .responses[String(status)]!.content["application/json"]!.schema;
    const check = async (key: string, method: string, template: string, path: string, body: unknown, status: number, headers?: Record<string, string>) => {
      const res = await call(method, path, { key, body, headers });
      expect(res.status, `${method} ${path} ${JSON.stringify(res.json)}`).toBe(status);
      expect(validate(doc, declared(template, method, status), res.json), `${method} ${path}`).toEqual([]);
      return res.json;
    };
    const { admin, ops } = ws.keys;

    const hook = (await check(admin, "POST", "/v1/webhooks", "/v1/webhooks", { url: `${base}/typed`, description: "Typed" }, 201)).data;
    expect(hook.secret).toMatch(/^whsec_/);
    const viaMcp = (await check(admin, "POST", "/v1/webhooks", "/v1/webhooks", { url: `${base}/typed-mcp` }, 201, { "x-hlcrm-surface": "admin-mcp" })).data;
    expect(viaMcp).toMatchObject({ secret: null, secret_note: expect.any(String) });
    const me = (await call("GET", "/v1/me", { key: ops })).json.actor.id;
    await create(ops, "task", { title: "Late task", assignee: me, due_at: later(-2).toISOString() });
    const vip = { name: "Typed VIP", description: "A VIP changed.", object: "contact", trigger: { type: "event", event: "contact.updated" },
      condition: { field: "job_title", op: "eq", value: "CEO" }, severity: "critical", webhooks: [hook.id] };
    const rule = (await check(admin, "POST", "/v1/alerts", "/v1/alerts", vip, 201)).alert;
    const c = await create(ops, "contact", { first_name: "Tia", email: `${uniq("tia")}@example.com` });
    await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ops, body: { job_title: "CEO" } });
    await drain(ws);

    // The inbox, the attention summary (with an overdue task) and one notification's state changes.
    const inboxPage = await check(ops, "GET", "/v1/me/notifications", "/v1/me/notifications?state=all", undefined, 200);
    expect(inboxPage.data.length).toBeGreaterThan(0);
    const n = inboxPage.data[0].id as string;
    const attention = (await check(ops, "GET", "/v1/me/attention", "/v1/me/attention", undefined, 200)).data;
    expect(attention.items.length).toBeGreaterThan(0);
    expect(attention.overdue_tasks.length).toBeGreaterThan(0);
    expect((await check(ops, "GET", "/v1/me/notifications/{id}", `/v1/me/notifications/${n}`, undefined, 200)).data.deliveries.length).toBeGreaterThan(0);
    await check(ops, "POST", "/v1/me/notifications/{id}/acknowledge", `/v1/me/notifications/${n}/acknowledge`, undefined, 200);
    await check(ops, "POST", "/v1/me/notifications/{id}/snooze", `/v1/me/notifications/${n}/snooze`, { until: later(1).toISOString() }, 200);
    await check(ops, "POST", "/v1/me/notifications/{id}/resolve", `/v1/me/notifications/${n}/resolve`, undefined, 200);
    await check(ops, "GET", "/v1/me/notification-preferences", "/v1/me/notification-preferences", undefined, 200);
    await check(ops, "PATCH", "/v1/me/notification-preferences", "/v1/me/notification-preferences", { quiet_hours: { start: "22:00", end: "07:00" } }, 200);

    // Personal alerts.
    const mine = { name: "My big deals", object: "deal", trigger: { type: "event", event: "deal.created" }, condition: { field: "amount", op: "gte", value: 5000 } };
    await check(ops, "POST", "/v1/me/alerts", "/v1/me/alerts", { ...mine, dry_run: true }, 200);
    const personal = (await check(ops, "POST", "/v1/me/alerts", "/v1/me/alerts", mine, 201)).alert;
    await check(ops, "GET", "/v1/me/alerts", "/v1/me/alerts", undefined, 200);
    await check(ops, "POST", "/v1/me/alerts/backtest", "/v1/me/alerts/backtest", mine, 200);
    await check(ops, "PATCH", "/v1/me/alerts/{id}", `/v1/me/alerts/${personal.id}`, { severity: "info", dry_run: true }, 200);
    await check(ops, "PATCH", "/v1/me/alerts/{id}", `/v1/me/alerts/${personal.id}`, { severity: "info" }, 200);
    await check(ops, "DELETE", "/v1/me/alerts/{id}", `/v1/me/alerts/${personal.id}`, undefined, 200);

    // Workspace alerts: an event rule (event backtest) and a time rule (deadline backtest).
    const untouched = { name: "Untouched", object: "deal", trigger: { type: "inactive", days: 14 } };
    expect((await check(admin, "POST", "/v1/alerts", "/v1/alerts", { ...untouched, dry_run: true }, 200)).backtest).toHaveProperty("would_fire_on_save");
    const bt = (await check(admin, "POST", "/v1/alerts/backtest", "/v1/alerts/backtest", vip, 200)).data.backtest;
    expect(bt.samples.length).toBeGreaterThan(0);
    await check(admin, "POST", "/v1/alerts/backtest", "/v1/alerts/backtest", untouched, 200);
    expect((await check(admin, "GET", "/v1/alerts", "/v1/alerts", undefined, 200)).data.length).toBeGreaterThan(0);
    await check(admin, "GET", "/v1/alerts/{id}", `/v1/alerts/${rule.id}`, undefined, 200);
    await check(admin, "PATCH", "/v1/alerts/{id}", `/v1/alerts/${rule.id}`, { cooldown_hours: 12 }, 200);

    // Webhooks and their deliveries.
    expect((await check(admin, "GET", "/v1/webhooks", "/v1/webhooks", undefined, 200)).data.length).toBe(2);
    await check(admin, "GET", "/v1/webhooks/{id}", `/v1/webhooks/${hook.id}`, undefined, 200);
    await check(admin, "PATCH", "/v1/webhooks/{id}", `/v1/webhooks/${hook.id}`, { description: "Typed, changed" }, 200);
    await check(admin, "GET", "/v1/webhooks/{id}/secret", `/v1/webhooks/${hook.id}/secret`, undefined, 200);
    await check(admin, "POST", "/v1/webhooks/{id}/rotate-secret", `/v1/webhooks/${hook.id}/rotate-secret`, { overlap_hours: 1 }, 200);
    const test = (await check(admin, "POST", "/v1/webhooks/{id}/test", `/v1/webhooks/${hook.id}/test`, undefined, 202)).data;
    await drain(ws);
    const deliveries = (await check(admin, "GET", "/v1/webhooks/{id}/deliveries", `/v1/webhooks/${hook.id}/deliveries`, undefined, 200)).data;
    expect(deliveries.length).toBeGreaterThan(1);
    await check(admin, "GET", "/v1/webhook-deliveries/{id}", `/v1/webhook-deliveries/${test.delivery.id}`, undefined, 200);
    await check(admin, "POST", "/v1/webhook-deliveries/{id}/replay", `/v1/webhook-deliveries/${deliveries[0].id}/replay`, undefined, 202);

    // The event log, as an ops key sees it.
    expect((await check(ops, "GET", "/v1/events", "/v1/events?limit=50", undefined, 200)).data.length).toBeGreaterThan(0);

    // Archiving answers with the archived object.
    expect((await check(admin, "DELETE", "/v1/alerts/{id}", `/v1/alerts/${rule.id}`, undefined, 200)).data.status).toBe("archived");
    expect((await check(admin, "DELETE", "/v1/webhooks/{id}", `/v1/webhooks/${hook.id}`, undefined, 200)).data.status).toBe("archived");

    // The checker itself catches drift.
    expect(validate(doc, declared("/v1/me/attention", "GET", 200), { data: { ...attention, counts: { critical: "1" } } }).length).toBeGreaterThan(0);
  });
});
