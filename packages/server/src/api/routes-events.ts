import type { Ctx } from "../core/context.js";
import { z } from "zod";
import { canObject } from "../core/access.js";
import { TriggerSchema } from "../core/automation-defs.js";
import {
  archiveAutomation, AutomationInput, checkSuppression, createAutomation, getAutomation, getSettings, listAutomations, listRuns, pauseAutomation,
  requestRun, resumeAutomation, schedulePreview, suppressEmail, testAutomation, unsuppressEmail, updateAutomation, updateSettings,
} from "../core/automations.js";
import {
  archiveWebhook, createWebhook, getDelivery, getWebhook, listDeliveries, listWebhooks, publicEvent, replayDelivery,
  revealWebhookSecret, rotateWebhookSecret, testWebhook, updateWebhook, type EventRow,
} from "../core/webhooks.js";
import { loadSchema } from "../core/schema.js";
import { badRequest } from "../lib/errors.js";
import { decodeId } from "../lib/ids.js";
import { route } from "./registry.js";
import { data, enumOf, list, nullable, object, plain, R, ref, S } from "./responses.js";

/** Through an MCP server: the header a key's client sends, or the surface a connected app's token fixes. */
const viaMcp = (headers: Headers, ctx: Ctx) => (headers.get("x-hlcrm-surface") ?? "api").endsWith("mcp") || ctx.surface.endsWith("mcp");

const WebhookBody = z.object({
  url: z.string().max(2000),
  description: z.string().max(2000).optional(),
  events: z.array(z.string()).max(50).optional(),
  include_restricted: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

// --- Webhooks --------------------------------------------------------------------------------

route({
  method: "GET", path: "/v1/webhooks", scope: "admin", tag: "webhooks", summary: "List webhook endpoints",
  response: R.webhooks,
  handler: async ({ tx }) => ({ body: { data: await listWebhooks(tx) } }),
});

route({
  method: "POST", path: "/v1/webhooks", scope: "admin", tag: "webhooks",
  response: { ...R.webhookWithSecret, status: 201 },
  summary: "Register a webhook endpoint. The signing secret is returned once (not through MCP)",
  body: WebhookBody,
  handler: async ({ tx, ctx, body, headers }) => {
    const { secret, ...webhook } = await createWebhook(tx, ctx, body);
    const hidden = viaMcp(headers, ctx);
    return { status: 201, body: { data: hidden ? { ...webhook, secret: null, secret_note: "Secrets are not shown through MCP. Get it with `GET /v1/webhooks/{id}/secret` or the CLI." } : { ...webhook, secret } } };
  },
});

route({
  method: "GET", path: "/v1/webhooks/:id", scope: "admin", tag: "webhooks", summary: "Get a webhook endpoint", idParams: { id: "webhook" },
  response: R.webhook,
  handler: async ({ tx, params }) => ({ body: { data: await getWebhook(tx, params.id!) } }),
});

route({
  method: "PATCH", path: "/v1/webhooks/:id", scope: "admin", tag: "webhooks", summary: "Change a webhook's URL, events, description or enabled flag",
  response: R.webhook,
  idParams: { id: "webhook" }, body: WebhookBody.partial(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await updateWebhook(tx, ctx, params.id!, body) } }),
});

route({
  method: "DELETE", path: "/v1/webhooks/:id", scope: "admin", tag: "webhooks", summary: "Archive a webhook (pending deliveries are dropped)",
  response: R.webhook,
  idParams: { id: "webhook" },
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveWebhook(tx, ctx, params.id!) } }),
});

route({
  method: "GET", path: "/v1/webhooks/:id/secret", scope: "admin", tag: "webhooks", summary: "Reveal the signing secret (not available through MCP)",
  response: data(object({ id: S.str, secret: S.str })),
  idParams: { id: "webhook" },
  handler: async ({ tx, ctx, params, headers }) => {
    if (viaMcp(headers, ctx)) throw badRequest("Webhook secrets are not shown through MCP; use the API");
    return { body: { data: await revealWebhookSecret(tx, ctx, params.id!) } };
  },
});

route({
  method: "POST", path: "/v1/webhooks/:id/rotate-secret", scope: "admin", tag: "webhooks",
  response: R.webhookWithSecret,
  summary: "Rotate the signing secret. The old secret also signs during the overlap window (default 24 hours)",
  idParams: { id: "webhook" }, body: z.object({ overlap_hours: z.number().int().min(0).max(168).optional() }),
  handler: async ({ tx, ctx, params, body, headers }) => {
    const { secret, ...webhook } = await rotateWebhookSecret(tx, ctx, params.id!, body.overlap_hours);
    return { body: { data: viaMcp(headers, ctx) ? { ...webhook, secret: null, secret_note: "Get the new secret with `GET /v1/webhooks/{id}/secret` or the CLI." } : { ...webhook, secret } } };
  },
});

route({
  method: "POST", path: "/v1/webhooks/:id/test", scope: "admin", tag: "webhooks",
  response: data(object({ queued: S.bool, delivery: ref("WebhookDelivery"), poll: { type: "string", description: "The path to poll for the result" } }), 202),
  summary: "Queue a signed webhook.test event; the worker sends it within seconds. Poll the returned delivery for the result",
  idParams: { id: "webhook" },
  handler: async ({ tx, ctx, params }) => ({ status: 202, body: { data: await testWebhook(tx, ctx, params.id!) } }),
});

route({
  method: "GET", path: "/v1/webhooks/:id/deliveries", scope: "admin", tag: "webhooks", summary: "Delivery log for a webhook, newest first",
  response: plain(object({ data: list(ref("WebhookDelivery")), next_before: nullable(S.str) })),
  idParams: { id: "webhook" },
  query: z.object({ status: z.enum(["pending", "succeeded", "dead"]).optional(), limit: z.coerce.number().int().optional(), before: z.string().optional() }),
  handler: async ({ tx, params, query }) => ({ body: await listDeliveries(tx, params.id!, query) }),
});

route({
  method: "GET", path: "/v1/webhook-deliveries/:id", scope: "admin", tag: "webhooks", summary: "One delivery, with its payload and last result",
  response: R.webhookDelivery,
  idParams: { id: "delivery" },
  handler: async ({ tx, params }) => ({ body: { data: await getDelivery(tx, params.id!) } }),
});

route({
  method: "POST", path: "/v1/webhook-deliveries/:id/replay", scope: "admin", tag: "webhooks", summary: "Send a delivery again (queues a new copy)",
  response: { ...R.webhookDelivery, status: 202 },
  idParams: { id: "delivery" },
  handler: async ({ tx, ctx, params }) => ({ status: 202, body: { data: await replayDelivery(tx, ctx, params.id!) } }),
});

// --- Automations -----------------------------------------------------------------------------

const DryRun = z.object({ dry_run: z.boolean().optional() });
const Email = z.object({ email: z.string().max(254) }).strict();

route({
  method: "GET", path: "/v1/automations", scope: "admin", tag: "automations", summary: "List automations",
  response: R.automations,
  handler: async ({ tx }) => ({ body: { data: await listAutomations(tx) } }),
});

route({
  method: "POST", path: "/v1/automations", scope: "admin", tag: "automations",
  response: { ...R.automationWrite, status: 201, alsoStatus: 200 },
  summary: "Create an automation. With dry_run, returns a plain-language summary, warnings and (for a schedule) the next runs without saving",
  body: AutomationInput.extend(DryRun.shape),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { status: dry_run ? 200 : 201, body: await createAutomation(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "GET", path: "/v1/automations/:id", scope: "admin", tag: "automations", summary: "Get an automation (secret header values are never returned)", idParams: { id: "automation" },
  response: R.automation,
  handler: async ({ tx, params }) => ({ body: { data: await getAutomation(tx, params.id!) } }),
});

route({
  method: "PATCH", path: "/v1/automations/:id", scope: "admin", tag: "automations", summary: "Change an automation (supports dry_run). A secret header sent as null keeps its stored value",
  response: R.automationWrite,
  idParams: { id: "automation" }, body: AutomationInput.partial().extend(DryRun.shape),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, ...patch } = body;
    return { body: await updateAutomation(tx, ctx, params.id!, patch, dry_run ?? false) };
  },
});

route({
  method: "DELETE", path: "/v1/automations/:id", scope: "admin", tag: "automations", summary: "Archive an automation", idParams: { id: "automation" },
  response: R.automation,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveAutomation(tx, ctx, params.id!) } }),
});

route({
  method: "POST", path: "/v1/automations/:id/pause", scope: "admin", tag: "automations", idParams: { id: "automation" },
  response: R.automation, summary: "Pause an automation: no new runs from events, its schedule or requests until it is resumed; queued runs are skipped",
  body: z.object({ reason: z.string().max(500).optional() }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await pauseAutomation(tx, ctx, params.id!, body.reason) } }),
});

route({
  method: "POST", path: "/v1/automations/:id/resume", scope: "admin", tag: "automations", idParams: { id: "automation" },
  response: R.automation, summary: "Resume a paused automation (also after an automatic pause); its failure count starts again",
  handler: async ({ tx, ctx, params }) => ({ body: { data: await resumeAutomation(tx, ctx, params.id!) } }),
});

route({
  method: "POST", path: "/v1/automations/:id/test", scope: "admin", tag: "automations", heavy: true,
  response: R.automationTest,
  summary: "Run a saved automation against one record (or none, for a schedule) without side effects: HTTP requests and emails are described, never sent", idParams: { id: "automation" },
  body: z.object({ record: z.string().max(100).optional() }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await testAutomation(tx, ctx, { automation: params.id!, record: body.record }) } }),
});

route({
  method: "POST", path: "/v1/automations/test", scope: "admin", tag: "automations", heavy: true,
  response: R.automationTest,
  summary: "Run a draft automation against one record (or none, for a schedule) without saving it or causing side effects",
  body: z.object({ automation: AutomationInput, record: z.string().max(100).optional() }).strict(),
  handler: async ({ tx, ctx, body }) => ({ body: { data: await testAutomation(tx, ctx, { draft: body.automation, record: body.record }) } }),
});

route({
  method: "POST", path: "/v1/automations/:id/run", scope: "any", tag: "automations", idParams: { id: "automation" },
  response: { schema: object({ data: S.obj }), status: 202, alsoStatus: 200, description: "The queued run IDs (202), or a dry run's step detail (200)" },
  summary: "Run an automation now, for up to 25 records (or none, for a schedule). Needs automations:manage, or a role in its run_roles with records:write. Queued for the worker; counts against its hourly cap",
  body: z.object({ records: z.array(z.string().max(100)).max(25).optional(), record: z.string().max(100).optional(), dry_run: z.boolean().optional() }).strict(),
  cost: (b) => 2 + (b.records?.length ?? 0) * 2,
  heavy: (b) => b.dry_run === true,
  handler: async ({ tx, ctx, params, body }) => {
    const out = await requestRun(tx, ctx, params.id!, { records: body.records ?? (body.record ? [body.record] : undefined), dry_run: body.dry_run });
    return { status: out.status, body: out.status === 200 ? { data: out.body } : out.body };
  },
});

route({
  method: "GET", path: "/v1/automations/:id/runs", scope: "admin", tag: "automations", summary: "Recent runs of an automation, newest first, with each step's (redacted) inputs and outcome; `cap` names the cap behind a skip, `failure` (data, target or config) what caused a failure",
  response: R.automationRuns,
  idParams: { id: "automation" },
  query: z.object({ limit: z.coerce.number().int().optional(), status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]).optional() }),
  handler: async ({ tx, params, query }) => ({ body: { data: await listRuns(tx, params.id!, query.limit, query.status) } }),
});

route({
  method: "GET", path: "/v1/automations/:id/schedule", scope: "admin", tag: "automations", summary: "The next runs of a schedule automation", idParams: { id: "automation" },
  response: R.schedulePreview, query: z.object({ count: z.coerce.number().int().optional() }),
  handler: async ({ tx, params, query }) => ({ body: { data: await schedulePreview(tx, { publicId: params.id! }, query.count) } }),
});

route({
  method: "POST", path: "/v1/automations/schedule-preview", scope: "admin", tag: "automations", summary: "The next runs of a draft schedule trigger",
  response: R.schedulePreview, body: z.object({ trigger: TriggerSchema, count: z.number().int().min(1).max(20).optional() }).strict(),
  handler: async ({ tx, body }) => ({ body: { data: await schedulePreview(tx, { trigger: body.trigger }, body.count) } }),
});

route({
  method: "GET", path: "/v1/automation-settings", scope: "admin", tag: "automations", summary: "Workspace automation settings: pause all, email to non-members, default time zone",
  response: R.automationSettings,
  handler: async ({ tx }) => ({ body: { data: await getSettings(tx) } }),
});

route({
  method: "PATCH", path: "/v1/automation-settings", scope: "admin", tag: "automations",
  summary: "Pause or resume every automation, allow email to addresses that are not members (not through MCP), or set the default time zone",
  response: R.automationSettings,
  body: z.object({ paused: z.boolean().optional(), reason: z.string().max(500).optional(), external_email: z.boolean().optional(), timezone: z.string().max(64).optional() }).strict(),
  handler: async ({ tx, ctx, body }) => ({ body: { data: await updateSettings(tx, ctx, body) } }),
});

route({
  method: "POST", path: "/v1/email-suppressions", scope: "admin", tag: "automations",
  summary: "Stop automations emailing an address and its +tag variants (kept as a hash only). Needs automations:manage, like removing one",
  response: { ...R.suppression, status: 201 }, body: Email.extend({ reason: z.string().max(200).optional() }),
  handler: async ({ tx, ctx, body }) => ({ status: 201, body: { data: await suppressEmail(tx, ctx, body.email, body.reason) } }),
});

route({
  method: "POST", path: "/v1/email-suppressions/check", scope: "ops:read", tag: "automations", summary: "Whether automations may email an address (the reason it was added only with automations:manage)",
  response: R.suppression, body: Email,
  handler: async ({ tx, ctx, body }) => ({ body: { data: await checkSuppression(tx, ctx, body.email) } }),
});

route({
  method: "POST", path: "/v1/email-suppressions/remove", scope: "admin", tag: "automations", summary: "Let automations email an address again",
  response: R.suppression, body: Email,
  handler: async ({ tx, ctx, body }) => ({ body: { data: await unsuppressEmail(tx, ctx, body.email) } }),
});

// --- Events ----------------------------------------------------------------------------------

interface Processing { processed_at: Date | null; dead_at: Date | null; attempts: number; last_error: string | null; next_attempt_at: Date | null }

/** How the worker got on with an event: whether its automations and webhooks ran, are retrying, or gave up. */
const publicProcessing = (r: Processing) => ({
  status: r.processed_at ? "processed" : r.dead_at ? "dead" : "pending",
  attempts: r.attempts, last_error: r.last_error,
  next_attempt_at: !r.processed_at && !r.dead_at ? r.next_attempt_at?.toISOString() ?? null : null,
});

/** An event as the caller may see it (core/webhooks.ts publicEvent), with how the worker got on with it. */
const Event = object({
  id: S.str, type: S.str, occurred_at: S.time, object: nullable(S.str), record_id: nullable(S.str),
  actor: object({ type: S.str, id: nullable(S.str), surface: S.str }),
  causation_depth: { type: "integer", description: "How many automation steps led to it (0 for a direct change)" },
  automation_id: { ...nullable(S.str), description: "The automation whose step caused it, or null" },
  data: { type: "object", additionalProperties: true,
    description: "The event's own data. Open by design: it differs per event type (record events carry before/after field values, without fields the caller can't read)" },
  processing: object({ status: enumOf("pending", "processed", "dead"), attempts: S.int, last_error: nullable(S.str), next_attempt_at: nullable(S.time) }),
});

route({
  method: "GET", path: "/v1/events", scope: "ops:read", tag: "events",
  response: plain(object({ data: list(Event), next_before: nullable(S.str) })),
  summary: "Recent events (90 days), newest first. Filter by type prefix, record or processing status (dead = failed every retry)",
  query: z.object({
    type: z.string().max(100).optional(), record: z.string().optional(), limit: z.coerce.number().int().optional(), before: z.string().optional(),
    status: z.enum(["pending", "processed", "dead"]).optional(),
  }),
  handler: async ({ tx, ctx, query }) => {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    // Events about records only for objects the caller can read (filtered in SQL, so paging stays exact); others are schema metadata.
    const schema = await loadSchema(tx);
    const objects = [...schema.objects.values()];
    const readable = objects.filter((o) => canObject(ctx, o, "read")).map((o) => o.api_name);
    const all = readable.length === objects.length;
    const record = query.record ? decodeId(query.record) : null;
    if (query.record && !record) throw badRequest("record must be a record ID");
    const before = query.before ? decodeId(query.before) : null;
    if (query.before && (!before || before.prefix !== "evt")) throw badRequest("before must be an event ID (evt_…)");
    const rows = await tx<(EventRow & Processing)[]>`
      SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, data, causation_depth, automation_id,
             processed_at, dead_at, attempts, last_error, next_attempt_at
      FROM outbox_events
      WHERE (${query.type ?? null}::text IS NULL OR type LIKE ${(query.type ?? "").replace(/[\\%_]/g, (c) => `\\${c}`) + "%"})
        AND (${record?.uuid ?? null}::uuid IS NULL OR record_id = ${record?.uuid ?? null}::uuid)
        AND (${before?.uuid ?? null}::uuid IS NULL OR id < ${before?.uuid ?? null}::uuid)
        AND (${all} OR record_id IS NULL OR object_type = ANY(${readable}::text[]))
        AND (${query.status ?? null}::text IS NULL
          OR (${query.status ?? null} = 'processed' AND processed_at IS NOT NULL)
          OR (${query.status ?? null} = 'dead' AND dead_at IS NOT NULL)
          OR (${query.status ?? null} = 'pending' AND processed_at IS NULL AND dead_at IS NULL))
      ORDER BY id DESC LIMIT ${limit}`;
    const data = [];
    for (const r of rows) data.push({ ...(await publicEvent(tx, r, ctx)), processing: publicProcessing(r) });
    return { body: { data, next_before: rows.length === limit ? data[data.length - 1]!.id : null } };
  },
});
