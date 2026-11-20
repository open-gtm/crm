import type { Tx } from "../../db/pool.js";

/**
 * The SQL of webhook endpoints and their delivery queue (core/webhooks.ts, ADR 0012). The callers keep
 * their checks, errors, audits and the order of statements in each transaction.
 */

export interface WebhookRow {
  id: string; url: string; description: string | null; events: string[]; include_restricted: boolean; secret: string;
  previous_secret: string | null; previous_expires_at: Date | null; enabled: boolean; consecutive_failures: number;
  circuit_open_until: Date | null; created_at: Date; updated_at: Date; archived_at: Date | null;
}

export interface DeliveryRow {
  id: string; webhook_id: string; event_id: string | null; consumer: string; event_type: string; payload: Record<string, unknown>;
  restricted_values: string | null; status: string; attempts: number; next_attempt_at: Date; last_attempt_at: Date | null;
  last_status_code: number | null; last_error: string | null; last_duration_ms: number | null; replay_of: string | null;
  created_at: Date; delivered_at: Date | null;
}

// --- Endpoints --------------------------------------------------------------------------------------

/** One webhook, archived or not; `forUpdate` locks it. */
export async function webhookById(tx: Tx, id: string, forUpdate = false): Promise<WebhookRow | undefined> {
  const [w] = forUpdate
    ? await tx<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ${id} FOR UPDATE`
    : await tx<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ${id}`;
  return w;
}

/** How many webhooks the workspace has that aren't archived. */
export async function countLiveWebhooks(tx: Tx): Promise<number | undefined> {
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM webhooks WHERE archived_at IS NULL`;
  return count?.n;
}

/** `secret` is the encrypted signing secret. */
export async function insertWebhook(tx: Tx, w: { tenantId: string; id: string; url: string; description: string | null; events: string[];
  includeRestricted: boolean; secret: string; enabled: boolean; createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO webhooks (tenant_id, id, url, description, events, include_restricted, secret, enabled, created_by)
    VALUES (${w.tenantId}, ${w.id}, ${w.url}, ${w.description}, ${w.events}, ${w.includeRestricted},
            ${w.secret}, ${w.enabled}, ${w.createdBy})`;
}

/** The webhooks that aren't archived, oldest first. */
export async function liveWebhooks(tx: Tx): Promise<WebhookRow[]> {
  return tx<WebhookRow[]>`SELECT * FROM webhooks WHERE archived_at IS NULL ORDER BY created_at`;
}

export async function updateWebhookSettings(tx: Tx, id: string, w: { url: string; description: string | null; events: string[]; includeRestricted: boolean;
  enabled: boolean; consecutiveFailures: number; circuitOpenUntil: Date | null }): Promise<void> {
  await tx`
    UPDATE webhooks SET url = ${w.url}, description = ${w.description},
      events = ${w.events}, include_restricted = ${w.includeRestricted}, enabled = ${w.enabled},
      consecutive_failures = ${w.consecutiveFailures},
      circuit_open_until = ${w.circuitOpenUntil}
    WHERE id = ${id}`;
}

/** Archives and disables a webhook. */
export async function archiveWebhookRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE webhooks SET archived_at = now(), enabled = false WHERE id = ${id}`;
}

/** Gives up the deliveries of an archived webhook that were still waiting to be sent. */
export async function abandonDeliveriesOf(tx: Tx, webhookId: string): Promise<void> {
  await tx`UPDATE webhook_deliveries SET status = 'dead', last_error = 'webhook archived' WHERE webhook_id = ${webhookId} AND status IN ('pending', 'sending')`;
}

/** Stores a new (encrypted) secret, and the old one with when it stops signing (both null for no overlap). */
export async function setWebhookSecret(tx: Tx, id: string, secret: string, previous: string | null, previousExpiresAt: Date | null): Promise<void> {
  await tx`
    UPDATE webhooks SET secret = ${secret},
      previous_secret = ${previous},
      previous_expires_at = ${previousExpiresAt}
    WHERE id = ${id}`;
}

/** Resets an endpoint's failure count and closes its circuit, after a delivery got through. */
export async function resetWebhookFailures(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE webhooks SET consecutive_failures = 0, circuit_open_until = NULL WHERE id = ${id}`;
}

/** Counts a failed delivery against an endpoint, pausing it until `pauseUntil` once it reaches `threshold` in a row. */
export async function countWebhookFailure(tx: Tx, id: string, threshold: number, pauseUntil: Date): Promise<void> {
  await tx`UPDATE webhooks SET consecutive_failures = consecutive_failures + 1,
             circuit_open_until = CASE WHEN consecutive_failures + 1 >= ${threshold} THEN ${pauseUntil}::timestamptz ELSE circuit_open_until END
           WHERE id = ${id}`;
}

// --- Deliveries -------------------------------------------------------------------------------------

/**
 * Queues a delivery of an event to an endpoint for one consumer (a subscription or an automation). False
 * when that consumer already queued this event for this endpoint.
 */
export async function insertDelivery(tx: Tx, d: { tenantId: string; id: string; webhookId: string; eventId: string; consumer: string; eventType: string;
  payload: Record<string, unknown>; restricted: string | null }): Promise<boolean> {
  const inserted = await tx`
    INSERT INTO webhook_deliveries (tenant_id, id, webhook_id, event_id, consumer, event_type, payload, restricted_values)
    VALUES (${d.tenantId}, ${d.id}, ${d.webhookId}, ${d.eventId}, ${d.consumer}, ${d.eventType}, ${tx.json(d.payload as never)}, ${d.restricted})
    ON CONFLICT (tenant_id, event_id, webhook_id, consumer) DO NOTHING RETURNING id`;
  return inserted.length > 0;
}

/** A webhook's deliveries in the given states, newest first, older than `before` when given. */
export async function deliveriesOf(tx: Tx, webhookId: string, status: string[], before: string | null, limit: number): Promise<DeliveryRow[]> {
  return tx<DeliveryRow[]>`
    SELECT * FROM webhook_deliveries WHERE webhook_id = ${webhookId} AND status = ANY(${status})
      AND (${before}::uuid IS NULL OR id < ${before}::uuid)
    ORDER BY id DESC LIMIT ${limit}`;
}

export async function deliveryById(tx: Tx, id: string): Promise<DeliveryRow | undefined> {
  const [row] = await tx<DeliveryRow[]>`SELECT * FROM webhook_deliveries WHERE id = ${id}`;
  return row;
}

/** Queues a replay of a delivery: its payload under a new ID, consumer `replay:<id>`. */
export async function insertReplayDelivery(tx: Tx, d: { tenantId: string; id: string; webhookId: string; eventId: string | null; eventType: string;
  payload: Record<string, unknown>; restricted: string | null; replayOf: string }): Promise<void> {
  await tx`
    INSERT INTO webhook_deliveries (tenant_id, id, webhook_id, event_id, consumer, event_type, payload, restricted_values, replay_of)
    VALUES (${d.tenantId}, ${d.id}, ${d.webhookId}, ${d.eventId}, ${`replay:${d.id}`}, ${d.eventType}, ${tx.json(d.payload as never)}, ${d.restricted}, ${d.replayOf})`;
}

/** How many test deliveries of a webhook are waiting to be sent. */
export async function pendingTestDeliveries(tx: Tx, webhookId: string): Promise<number | undefined> {
  const [pending] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${webhookId} AND consumer LIKE 'test:%' AND status IN ('pending', 'sending')`;
  return pending?.n;
}

/** Queues a `webhook.test` delivery, consumer `test:<id>`. */
export async function insertTestDelivery(tx: Tx, d: { tenantId: string; id: string; webhookId: string; payload: Record<string, unknown> }): Promise<void> {
  await tx`INSERT INTO webhook_deliveries (tenant_id, id, webhook_id, event_id, consumer, event_type, payload)
           VALUES (${d.tenantId}, ${d.id}, ${d.webhookId}, NULL, ${`test:${d.id}`}, 'webhook.test', ${tx.json(d.payload as never)})`;
}

/** With a lease token, only while that lease is held (the delivery is `sending` under it); without one, always. */
const leaseHeld = (tx: Tx, leaseToken: string | null) =>
  leaseToken === null ? tx`TRUE` : tx`status = 'sending' AND lease_token = ${leaseToken}::uuid`;

/** Records a successful attempt. False when the lease is no longer held. */
export async function markDeliverySucceeded(tx: Tx, id: string, a: { attempts: number; status: number | null; durationMs: number | null },
  leaseToken: string | null): Promise<boolean> {
  const held = leaseHeld(tx, leaseToken);
  const done = await tx`UPDATE webhook_deliveries SET status = 'succeeded', attempts = ${a.attempts}, last_attempt_at = now(), delivered_at = now(),
               last_status_code = ${a.status}, last_error = NULL, last_duration_ms = ${a.durationMs}, locked_until = NULL, lease_token = NULL
             WHERE id = ${id} AND ${held} RETURNING 1`;
  return done.length > 0;
}

/** Records a failed attempt: `pending` again at `nextAttemptAt`, or `dead`. False when the lease is no longer held. */
export async function markDeliveryFailed(tx: Tx, id: string, a: { state: "dead" | "pending"; attempts: number; nextAttemptAt: Date; status: number | null;
  error: string | null; durationMs: number | null }, leaseToken: string | null): Promise<boolean> {
  const held = leaseHeld(tx, leaseToken);
  const done = await tx`UPDATE webhook_deliveries SET status = ${a.state}, attempts = ${a.attempts}, last_attempt_at = now(),
             next_attempt_at = ${a.nextAttemptAt}, last_status_code = ${a.status}, last_error = ${a.error},
             last_duration_ms = ${a.durationMs}, locked_until = NULL, lease_token = NULL
           WHERE id = ${id} AND ${held} RETURNING 1`;
  return done.length > 0;
}
