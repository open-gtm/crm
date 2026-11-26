import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assertRoom } from "./limits.js";
import { config } from "../config.js";
import type { Tx } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { BlockedTargetError, checkUrl, safePost, type TargetPolicy } from "../lib/outbound.js";
import { fieldAccess, hasHiddenFields } from "./access.js";
import { audit } from "./audit.js";
import { can, withRestricted as grantRestricted, without, type Ctx } from "./context.js";
import { decryptValue, encryptValue } from "./encryption.js";
import type { EventRow } from "./queries/events.js";
import {
  abandonDeliveriesOf, archiveWebhookRow, countWebhookFailure, deliveriesOf, deliveryById, insertDelivery, insertReplayDelivery,
  insertTestDelivery, insertWebhook, liveWebhooks, markDeliveryFailed, markDeliverySucceeded, pendingTestDeliveries, resetWebhookFailures,
  setWebhookSecret, updateWebhookSettings, webhookById, type DeliveryRow, type WebhookRow,
} from "./queries/webhooks.js";
import { getRecord, type RecordOut } from "./records.js";
import { loadSchema } from "./schema.js";

/**
 * Webhooks follow the Standard Webhooks spec (standardwebhooks.com): headers `webhook-id`,
 * `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`,
 * with a `whsec_` secret per endpoint. Off-the-shelf verifiers work as is.
 */

export const policy = (): TargetPolicy => ({ allowInsecure: config().WEBHOOK_ALLOW_INSECURE_TARGETS });

/** Delay before each retry: 8 attempts in all over about 22 hours, with ±20% jitter. */
export const RETRY_DELAYS_S = [30, 120, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length;
const CIRCUIT_THRESHOLD = 10;
const CIRCUIT_PAUSE_MS = 10 * 60 * 1000;
const EVENT_PATTERN = /^(\*|[a-z][a-z0-9_]*\.\*|[a-z][a-z0-9_]*\.[a-z_]+|\*\.[a-z_]+)$/;

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

export function sign(secret: string, msgId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${msgId}.${timestamp}.${body}`).digest("base64")}`;
}

/** Verifies a Standard Webhooks signature header. Exposed for the docs and tests; receivers use the same logic. */
export function verify(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, toleranceS = 300): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceS) return false;
  const expected = Buffer.from(sign(secret, headers.id, ts, body));
  // Constant-time, so how much of a guessed signature matched can't be measured.
  return headers.signature.split(" ").some((s) => {
    const given = Buffer.from(s);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

function publicWebhook(w: WebhookRow) {
  const now = Date.now();
  return {
    id: encodeId("whk", w.id), url: w.url, description: w.description, events: w.events, include_restricted: w.include_restricted,
    enabled: w.enabled && !w.archived_at,
    status: w.archived_at ? "archived" : !w.enabled ? "disabled" : w.circuit_open_until && w.circuit_open_until.getTime() > now ? "paused" : "active",
    consecutive_failures: w.consecutive_failures,
    paused_until: w.circuit_open_until && w.circuit_open_until.getTime() > now ? w.circuit_open_until.toISOString() : null,
    previous_secret_valid_until: w.previous_expires_at && w.previous_expires_at.getTime() > now ? w.previous_expires_at.toISOString() : null,
    created_at: w.created_at.toISOString(), updated_at: w.updated_at.toISOString(),
  };
}

function parseWebhookId(publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "whk") throw notFound(`Webhook ${publicId}`);
  return d.uuid;
}

export async function loadWebhook(tx: Tx, publicId: string, opts: { forUpdate?: boolean } = {}): Promise<WebhookRow> {
  const id = parseWebhookId(publicId);
  const w = await webhookById(tx, id, opts.forUpdate);
  if (!w) throw notFound(`Webhook ${publicId}`);
  return w;
}

function validateEvents(events: string[]): string[] {
  const out = [...new Set(events.map((e) => e.trim()))];
  const bad = out.filter((e) => !EVENT_PATTERN.test(e));
  if (bad.length) throw unprocessable(`Invalid event pattern(s): ${bad.join(", ")}. Use e.g. "deal.*", "contact.created", "*.archived" or "*".`);
  if (out.length > 50) throw unprocessable("A webhook can subscribe to at most 50 event patterns");
  return out;
}

function validateUrl(url: string): string {
  try {
    return checkUrl(url, policy()).toString();
  } catch (e) {
    if (e instanceof BlockedTargetError) throw unprocessable(e.message, { field: "url" });
    throw e;
  }
}

export interface WebhookInput { url: string; description?: string; events?: string[]; include_restricted?: boolean; enabled?: boolean }

/**
 * Granting restricted values is a person's decision: it needs restricted:read, and never happens
 * through MCP, where a prompt-injected agent could use it to send restricted data anywhere.
 */
function assertMayGrantRestricted(ctx: Ctx): void {
  if (!can(ctx, "restricted:read")) throw forbidden("Only a key with restricted:read can grant a webhook restricted values");
  if (ctx.surface.endsWith("mcp")) {
    throw forbidden("include_restricted cannot be turned on through MCP. Ask the user to turn it on through the API (PATCH /v1/webhooks/{id}).");
  }
}

export async function createWebhook(tx: Tx, ctx: Ctx, input: WebhookInput) {
  const url = validateUrl(input.url);
  const events = validateEvents(input.events ?? []);
  if (input.include_restricted) assertMayGrantRestricted(ctx);
  await assertRoom(tx, ctx.tenantId, "webhooks");
  const id = uuidv7();
  const secret = newSecret();
  await insertWebhook(tx, { tenantId: ctx.tenantId, id, url, description: input.description ?? null, events, includeRestricted: input.include_restricted ?? false,
    secret: await encryptValue(tx, ctx.tenantId, id, "webhook_secret", secret), enabled: input.enabled ?? true, createdBy: ctx.actor.id });
  await audit(tx, ctx, { action: "webhook.created", details: { webhook: encodeId("whk", id), events, include_restricted: input.include_restricted ?? false } });
  const row = await webhookById(tx, id);
  return { ...publicWebhook(row!), secret };
}

export async function listWebhooks(tx: Tx) {
  const rows = await liveWebhooks(tx);
  return rows.map(publicWebhook);
}

export async function getWebhook(tx: Tx, publicId: string) {
  return publicWebhook(await loadWebhook(tx, publicId));
}

export async function updateWebhook(tx: Tx, ctx: Ctx, publicId: string, patch: Partial<WebhookInput>) {
  const w = await loadWebhook(tx, publicId, { forUpdate: true });
  if (w.archived_at) throw conflict(`Webhook ${publicId} is archived`);
  if (patch.include_restricted && !w.include_restricted) assertMayGrantRestricted(ctx);
  const url = patch.url !== undefined ? validateUrl(patch.url) : w.url;
  const events = patch.events !== undefined ? validateEvents(patch.events) : w.events;
  // Where restricted values go, and which ones, is decided by someone who may read them: otherwise
  // a caller without restricted:read could point a granted endpoint at a URL of their own.
  const redirects = url !== w.url || events.length !== w.events.length || events.some((e, i) => e !== w.events[i]);
  if (redirects && (w.include_restricted || patch.include_restricted) && !can(ctx, "restricted:read")) {
    throw forbidden("This webhook receives restricted values: changing its URL or events needs a key with restricted:read");
  }
  // Same reasoning as assertMayGrantRestricted: through MCP, a prompt-injected agent could redirect restricted values.
  if (redirects && (patch.include_restricted ?? w.include_restricted) && ctx.surface.endsWith("mcp")) {
    throw forbidden("This webhook receives restricted values, so its URL and events can't be changed through MCP. Ask the user to change them through the API (PATCH /v1/webhooks/{id}).");
  }
  const enabled = patch.enabled ?? w.enabled;
  await updateWebhookSettings(tx, w.id, {
    url, description: patch.description !== undefined ? patch.description : w.description,
    events, includeRestricted: patch.include_restricted ?? w.include_restricted, enabled,
    consecutiveFailures: enabled && !w.enabled ? 0 : w.consecutive_failures,
    circuitOpenUntil: enabled && !w.enabled ? null : w.circuit_open_until,
  });
  await audit(tx, ctx, { action: "webhook.updated", details: { webhook: publicId, fields: Object.keys(patch) } });
  return getWebhook(tx, publicId);
}

export async function archiveWebhook(tx: Tx, ctx: Ctx, publicId: string) {
  const w = await loadWebhook(tx, publicId, { forUpdate: true });
  if (!w.archived_at) {
    await archiveWebhookRow(tx, w.id);
    await abandonDeliveriesOf(tx, w.id);
    await audit(tx, ctx, { action: "webhook.archived", details: { webhook: publicId } });
  }
  return getWebhook(tx, publicId);
}

/** New secret now; the old one keeps signing (as a second signature) for the overlap window. */
export async function rotateWebhookSecret(tx: Tx, ctx: Ctx, publicId: string, overlapHours = 24) {
  const w = await loadWebhook(tx, publicId, { forUpdate: true });
  if (w.archived_at) throw conflict(`Webhook ${publicId} is archived`);
  const secret = newSecret();
  await setWebhookSecret(tx, w.id, await encryptValue(tx, ctx.tenantId, w.id, "webhook_secret", secret),
    overlapHours > 0 ? w.secret : null,
    overlapHours > 0 ? new Date(Date.now() + overlapHours * 3_600_000) : null);
  await audit(tx, ctx, { action: "webhook.secret_rotated", details: { webhook: publicId, overlap_hours: overlapHours } });
  return { ...(await getWebhook(tx, publicId)), secret };
}

export async function revealWebhookSecret(tx: Tx, ctx: Ctx, publicId: string) {
  const w = await loadWebhook(tx, publicId);
  await audit(tx, ctx, { action: "webhook.secret_revealed", details: { webhook: publicId } });
  return { id: publicId, secret: (await decryptValue(tx, ctx.tenantId, w.id, "webhook_secret", w.secret)) as string };
}

// ----------------------------------------------------------------------------------------------
// Payloads and the delivery queue

/** Public IDs for actors, events and records referenced by an event. */
export function actorRef(type: string, id: string | null): string | null {
  if (!id) return null;
  return encodeId(type === "user" ? "usr" : type === "service_account" ? "svc" : type === "automation" ? "auto" : "sys", id);
}

/**
 * An event's data as `ctx` may see it. Record events carry field values (before/after), so fields the
 * caller can't read are removed, and so is anything derived from them: a stage change when the stage
 * is hidden, and an alert's title (built from the record's display name). Unknown keys in before/after
 * are dropped too. Without `ctx` (webhook payloads, for roles that must be unrestricted) data is whole.
 */
function visibleData(ctx: Ctx | undefined, schema: Awaited<ReturnType<typeof loadSchema>>, e: EventRow): Record<string, unknown> {
  const obj = e.object_type ? schema.objects.get(e.object_type) : undefined;
  if (!ctx || !obj || !e.record_id || !hasHiddenFields(ctx, obj)) return e.data;
  const readable = (name: string) => {
    const f = obj.byName.get(name);
    return Boolean(f) && fieldAccess(ctx, obj, f!) !== "none";
  };
  const out: Record<string, unknown> = { ...e.data };
  for (const k of ["before", "after"]) {
    const v = out[k];
    if (v && typeof v === "object" && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).filter(([name]) => readable(name)));
  }
  if (e.type === "deal.stage_changed" && !readable("stage")) for (const k of ["from_status", "to_stage", "to_status"]) delete out[k];
  if (e.type === "alert.fired") delete out.title;
  return out;
}

/**
 * The app or key an event came through is a name its owner chose. It is shown to the member the key or app
 * acts for and to those who read the audit log (where the key itself is named); to others the surface is enough.
 * Never part of a webhook payload (no caller).
 */
function viaFor(ctx: Ctx | undefined, e: EventRow): { via?: string | null } {
  if (!ctx || e.via === undefined) return {};
  const own = e.actor_id !== null && ctx.actor.id === e.actor_id;
  return own || can(ctx, "audit:read") ? { via: e.via } : {};
}

export async function publicEvent(tx: Tx, e: EventRow, ctx?: Ctx) {
  const schema = await loadSchema(tx);
  const prefix = e.object_type ? schema.objects.get(e.object_type)?.id_prefix : undefined;
  return {
    id: encodeId("evt", e.id), type: e.type, occurred_at: e.occurred_at.toISOString(),
    object: e.object_type, record_id: e.record_id && prefix ? encodeId(prefix, e.record_id) : null,
    actor: { type: e.actor_type, id: actorRef(e.actor_type, e.actor_id), surface: e.surface, ...viaFor(ctx, e) },
    causation_depth: e.causation_depth,
    automation_id: e.automation_id ? encodeId("auto", e.automation_id) : null,
    data: visibleData(ctx, schema, e),
  };
}

/**
 * The record as it is now, for the payload. Read with a context that lacks restricted:read, so
 * restricted values show as "[restricted]"; when the endpoint is granted them, they are returned
 * separately so the caller can store them encrypted.
 */
export async function recordForPayload(tx: Tx, ctx: Ctx, e: EventRow, withRestricted: boolean):
  Promise<{ record: RecordOut | null; restricted: Record<string, unknown> | null }> {
  if (!e.object_type || !e.record_id) return { record: null, restricted: null };
  const schema = await loadSchema(tx);
  const obj = schema.objects.get(e.object_type);
  if (!obj) return { record: null, restricted: null };
  const publicId = encodeId(obj.id_prefix, e.record_id);
  const plain = without(ctx, "restricted:read");
  try {
    const record = await getRecord(tx, plain, obj.api_name, publicId);
    if (!withRestricted) return { record, restricted: null };
    const restrictedFields = obj.fields.filter((f) => f.sensitivity === "restricted" && !f.hidden);
    if (restrictedFields.length === 0) return { record, restricted: null };
    const full = await getRecord(tx, grantRestricted(ctx), obj.api_name, publicId);
    return { record, restricted: Object.fromEntries(restrictedFields.map((f) => [f.api_name, full[f.api_name]])) };
  } catch {
    return { record: null, restricted: null }; // module turned off, or the record is gone
  }
}

/** Does an event type match a subscription pattern ("*", "deal.*", "*.created", "deal.created")? */
export function matchesPattern(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  const [po, pa] = pattern.split(".");
  const [to, ta] = type.split(".");
  return (po === "*" || po === to) && (pa === "*" || pa === ta);
}

export async function enqueueDelivery(tx: Tx, ctx: Ctx, args: {
  webhook: WebhookRow; event: EventRow; consumer: string; automation?: { id: string; name: string } | null; record?: { record: RecordOut | null; restricted: Record<string, unknown> | null };
}): Promise<string | null> {
  const { webhook, event } = args;
  const rec = args.record ?? await recordForPayload(tx, ctx, event, webhook.include_restricted);
  const id = uuidv7();
  const payload = {
    ...(await publicEvent(tx, event)),
    record: rec.record,
    automation: args.automation ? { id: encodeId("auto", args.automation.id), name: args.automation.name } : null,
  };
  const restricted = webhook.include_restricted && rec.restricted
    ? await encryptValue(tx, ctx.tenantId, id, "payload_restricted", rec.restricted) : null;
  const inserted = await insertDelivery(tx, { tenantId: ctx.tenantId, id, webhookId: webhook.id, eventId: event.id, consumer: args.consumer, eventType: event.type,
    payload, restricted });
  return inserted ? id : null;
}

function publicDelivery(d: DeliveryRow) {
  return {
    id: encodeId("dlv", d.id), webhook_id: encodeId("whk", d.webhook_id), event_id: d.event_id ? encodeId("evt", d.event_id) : null,
    event_type: d.event_type,
    trigger: d.consumer === "subscription" ? "subscription" : d.consumer.startsWith("replay:") ? "replay" : d.consumer.startsWith("test:") ? "test" : "automation",
    automation_id: /^[0-9a-f-]{36}$/.test(d.consumer) ? encodeId("auto", d.consumer) : null,
    status: d.status === "sending" ? "pending" : d.status, attempts: d.attempts,
    next_attempt_at: d.status === "pending" || d.status === "sending" ? d.next_attempt_at.toISOString() : null,
    last_attempt_at: d.last_attempt_at?.toISOString() ?? null, last_status_code: d.last_status_code, last_error: d.last_error,
    last_duration_ms: d.last_duration_ms, replay_of: d.replay_of ? encodeId("dlv", d.replay_of) : null,
    created_at: d.created_at.toISOString(), delivered_at: d.delivered_at?.toISOString() ?? null,
    payload: d.payload,
  };
}

export async function listDeliveries(tx: Tx, webhookPublicId: string, q: { status?: string; limit?: number; before?: string }) {
  const w = await loadWebhook(tx, webhookPublicId);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const before = q.before ? decodeId(q.before) : null;
  if (q.before && (!before || before.prefix !== "dlv")) throw badRequest("before must be a delivery ID (dlv_…)");
  const status = q.status === "pending" ? ["pending", "sending"] : q.status ? [q.status] : ["pending", "sending", "succeeded", "dead"];
  const rows = await deliveriesOf(tx, w.id, status, before?.uuid ?? null, limit);
  return { data: rows.map(publicDelivery), next_before: rows.length === limit ? encodeId("dlv", rows[rows.length - 1]!.id) : null };
}

async function loadDelivery(tx: Tx, publicId: string): Promise<DeliveryRow> {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "dlv") throw notFound(`Delivery ${publicId}`);
  const row = await deliveryById(tx, d.uuid);
  if (!row) throw notFound(`Delivery ${publicId}`);
  return row;
}

export async function getDelivery(tx: Tx, publicId: string) {
  return publicDelivery(await loadDelivery(tx, publicId));
}

/** Queues a fresh copy of a delivery (same payload, new delivery ID, attempts reset). */
export async function replayDelivery(tx: Tx, ctx: Ctx, publicId: string) {
  const d = await loadDelivery(tx, publicId);
  const w = await webhookById(tx, d.webhook_id);
  if (!w || w.archived_at) throw conflict("The webhook for this delivery is archived");
  // A replay sends the stored restricted values to the endpoint's current URL.
  if (d.restricted_values && !can(ctx, "restricted:read")) {
    throw forbidden("This delivery carries restricted values: replaying it needs a key with restricted:read");
  }
  if (d.restricted_values && ctx.surface.endsWith("mcp")) {
    throw forbidden("This delivery carries restricted values, so it can't be replayed through MCP. Ask the user to replay it through the API (POST /v1/webhook-deliveries/{id}/replay).");
  }
  const id = uuidv7();
  const restricted = d.restricted_values
    ? await encryptValue(tx, ctx.tenantId, id, "payload_restricted", await decryptValue(tx, ctx.tenantId, d.id, "payload_restricted", d.restricted_values))
    : null;
  await insertReplayDelivery(tx, { tenantId: ctx.tenantId, id, webhookId: d.webhook_id, eventId: d.event_id, eventType: d.event_type, payload: d.payload,
    restricted, replayOf: d.id });
  await audit(tx, ctx, { action: "webhook.delivery_replayed", details: { delivery: publicId, replay: encodeId("dlv", id) } });
  return getDelivery(tx, encodeId("dlv", id));
}

// ----------------------------------------------------------------------------------------------
// Sending

async function signingSecrets(tx: Tx, tenantId: string, w: WebhookRow): Promise<string[]> {
  const out = [(await decryptValue(tx, tenantId, w.id, "webhook_secret", w.secret)) as string];
  if (w.previous_secret && w.previous_expires_at && w.previous_expires_at.getTime() > Date.now()) {
    out.push((await decryptValue(tx, tenantId, w.id, "webhook_secret", w.previous_secret)) as string);
  }
  return out;
}

/** Builds the exact bytes and headers to send for a delivery. */
export async function buildRequest(tx: Tx, tenantId: string, w: WebhookRow, d: Pick<DeliveryRow, "id" | "payload" | "restricted_values">) {
  let payload = d.payload;
  if (d.restricted_values && w.include_restricted && payload.record) {
    const restricted = (await decryptValue(tx, tenantId, d.id, "payload_restricted", d.restricted_values)) as Record<string, unknown>;
    payload = { ...payload, record: { ...(payload.record as object), ...restricted } };
  }
  const body = JSON.stringify(payload);
  const msgId = encodeId("dlv", d.id);
  const ts = Math.floor(Date.now() / 1000);
  const secrets = await signingSecrets(tx, tenantId, w);
  return {
    body,
    headers: {
      "webhook-id": msgId,
      "webhook-timestamp": String(ts),
      "webhook-signature": secrets.map((s) => sign(s, msgId, ts, body)).join(" "),
    },
  };
}

/**
 * `error` is shown to the tenant as last_error and `code` is logged. Neither carries the response
 * body: with insecure targets allowed an endpoint can be an internal service, and its body must
 * not be readable through the delivery log (nor written into ours by a hostile receiver).
 */
export type AttemptOutcome = { ok: boolean; status: number | null; error: string | null; code: string | null; durationMs: number | null };

export async function attempt(url: string, req: { body: string; headers: Record<string, string> }): Promise<AttemptOutcome> {
  try {
    const r = await safePost(url, req.body, req.headers, policy());
    const ok = r.status >= 200 && r.status < 300;
    return { ok, status: r.status, error: ok ? null : `HTTP ${r.status}`, code: ok ? null : "http_status", durationMs: r.durationMs };
  } catch (e) {
    const { error, code } = failureReason(e);
    return { ok: false, status: null, error, code, durationMs: null };
  }
}

/** A short, fixed-vocabulary reason for a failed send. Only our own messages pass through. */
function failureReason(e: unknown): { error: string; code: string } {
  if (e instanceof BlockedTargetError) return { error: e.message.slice(0, 300), code: "blocked_target" };
  const msg = (e as Error)?.message ?? "";
  if (msg.startsWith("timed out")) return { error: msg.slice(0, 100), code: "timeout" };
  const errno = (e as NodeJS.ErrnoException)?.code;
  if (typeof errno === "string" && /^[A-Z0-9_]{2,40}$/.test(errno)) return { error: `network error (${errno})`, code: errno };
  return { error: "network error", code: "network" };
}

/**
 * Records an attempt's outcome: success, a scheduled retry, or dead-letter after the last attempt
 * (a test delivery gets one attempt). With a lease token, the outcome is recorded only while that
 * lease is still held, and false is returned otherwise: another worker owns the delivery now.
 */
export async function recordAttempt(
  tx: Tx, w: Pick<WebhookRow, "id">, d: Pick<DeliveryRow, "id" | "attempts" | "consumer">, out: AttemptOutcome, leaseToken: string | null = null,
): Promise<boolean> {
  const attempts = d.attempts + 1;
  if (out.ok) {
    const done = await markDeliverySucceeded(tx, d.id, { attempts, status: out.status, durationMs: out.durationMs }, leaseToken);
    if (!done) return false;
    await resetWebhookFailures(tx, w.id);
    return true;
  }
  const dead = attempts >= MAX_ATTEMPTS || d.consumer.startsWith("test:");
  const delay = RETRY_DELAYS_S[Math.min(attempts - 1, RETRY_DELAYS_S.length - 1)]! * (0.8 + Math.random() * 0.4);
  const done = await markDeliveryFailed(tx, d.id, { state: dead ? "dead" : "pending", attempts, nextAttemptAt: new Date(Date.now() + delay * 1000),
    status: out.status, error: out.error, durationMs: out.durationMs }, leaseToken);
  if (!done) return false;
  // A failed test doesn't count against real deliveries or pause them: otherwise a few queued tests
  // to a dead endpoint (or one briefly down) would trip the circuit breaker for real traffic.
  if (d.consumer.startsWith("test:")) return true;
  await countWebhookFailure(tx, w.id, CIRCUIT_THRESHOLD, new Date(Date.now() + CIRCUIT_PAUSE_MS));
  return true;
}

const MAX_PENDING_TESTS = 5;

/**
 * Queues a signed `webhook.test` event for the worker, which sends it within one poll interval;
 * poll the returned delivery for the result. The API never sends it itself: the handler runs
 * inside the request transaction, and a slow endpoint would hold a pooled connection for the
 * whole send. A test is a single attempt, and is sent even while the endpoint is disabled or paused.
 */
export async function testWebhook(tx: Tx, ctx: Ctx, publicId: string) {
  // Locked, so concurrent test requests count pending tests one at a time and the cap holds.
  const w = await loadWebhook(tx, publicId, { forUpdate: true });
  if (w.archived_at) throw conflict(`Webhook ${publicId} is archived`);
  const pending = await pendingTestDeliveries(tx, w.id);
  if ((pending ?? 0) >= MAX_PENDING_TESTS) throw conflict(`Webhook ${publicId} already has ${MAX_PENDING_TESTS} test deliveries waiting to be sent`);
  const id = uuidv7();
  const payload = {
    id: encodeId("evt", id), type: "webhook.test", occurred_at: new Date().toISOString(), object: null, record_id: null,
    actor: { type: ctx.actor.type, id: actorRef(ctx.actor.type, ctx.actor.id), surface: ctx.surface }, causation_depth: 0,
    automation_id: null, data: { message: "Test event from hl-crm-db. Verify the signature, then return any 2xx status." }, record: null, automation: null,
  };
  await insertTestDelivery(tx, { tenantId: ctx.tenantId, id, webhookId: w.id, payload });
  const delivery = await getDelivery(tx, encodeId("dlv", id));
  return { queued: true, delivery, poll: `/v1/webhook-deliveries/${delivery.id}` };
}

export type { DeliveryRow, EventRow, WebhookRow };
