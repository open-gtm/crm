import type { DeliveryRow, EventRow, WebhookRow } from "../core/webhooks.js";
import type { Tx } from "../db/pool.js";

/**
 * The SQL of the background worker: claiming outbox events, leasing webhook deliveries, and the
 * retention jobs (ADR 0012). The code that calls these keeps its checks, logging, retries and the
 * order of statements in its transaction.
 */

// --- Row-level security scoping ---------------------------------------------------------------------

/** Enters one workspace in a transaction opened outside withTenant (retention jobs walk every workspace). */
export async function enterWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

// --- Outbox events ----------------------------------------------------------------------------------

/**
 * Claims up to `batch` due outbox events (unprocessed, not dead, past their retry time), oldest first,
 * locked and skipping those another worker holds.
 */
export async function claimDueEvents(tx: Tx, batch: number): Promise<(EventRow & { attempts: number })[]> {
  return tx<(EventRow & { attempts: number })[]>`
      SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, data, causation_depth, automation_id, attempts
      FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY occurred_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
}

/** Records a failed attempt at an event: when to retry it (`nextAttemptAt`), or that it is dead (`deadAt`). */
export async function recordEventFailure(tx: Tx, f: { id: string; attempts: number; lastError: string; nextAttemptAt: Date | null; deadAt: Date | null }): Promise<void> {
  await tx`UPDATE outbox_events SET attempts = ${f.attempts}, last_error = ${f.lastError},
                   next_attempt_at = ${f.nextAttemptAt}, dead_at = ${f.deadAt}
                 WHERE id = ${f.id}`;
}

export async function markEventsProcessed(tx: Tx, ids: string[]): Promise<void> {
  await tx`UPDATE outbox_events SET processed_at = now() WHERE id = ANY(${ids}::uuid[])`;
}

// --- Webhooks and deliveries ------------------------------------------------------------------------

/** The unarchived webhooks subscribed to at least one event pattern. */
export async function subscribedWebhooks(tx: Tx): Promise<WebhookRow[]> {
  return tx<WebhookRow[]>`SELECT * FROM webhooks WHERE archived_at IS NULL AND cardinality(events) > 0`;
}

/** The unarchived webhooks among these IDs (an alert rule's targets). */
export async function liveWebhooksByIds(tx: Tx, ids: string[]): Promise<WebhookRow[]> {
  return tx<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ANY(${ids}::uuid[]) AND archived_at IS NULL`;
}

/** A webhook, unless archived. */
export async function liveWebhook(tx: Tx, id: string): Promise<WebhookRow | undefined> {
  const [w] = await tx<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ${id} AND archived_at IS NULL`;
  return w;
}

/**
 * Leases due deliveries under the token `lease` for `leaseSeconds`: pending ones, or ones whose earlier
 * lease lapsed, of endpoints that are enabled and not paused (test deliveries regardless), at most
 * `perEndpoint` per endpoint (oldest first) and `limit` in all. Returns the leased rows.
 */
export async function leaseDueDeliveries(tx: Tx, l: { perEndpoint: number; limit: number; leaseSeconds: number; lease: string }): Promise<DeliveryRow[]> {
  return tx<DeliveryRow[]>`
    WITH due AS (
      SELECT id FROM (
        SELECT d.id, row_number() OVER (PARTITION BY d.webhook_id ORDER BY d.next_attempt_at, d.id) AS n
        FROM webhook_deliveries d JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
        WHERE (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now()))
          AND d.next_attempt_at <= now() AND w.archived_at IS NULL
          AND (d.consumer LIKE 'test:%' OR (w.enabled AND (w.circuit_open_until IS NULL OR w.circuit_open_until < now())))
      ) ranked WHERE n <= ${l.perEndpoint}
      LIMIT ${l.limit}
    )
    UPDATE webhook_deliveries d SET status = 'sending', locked_until = now() + make_interval(secs => ${l.leaseSeconds}), lease_token = ${l.lease}::uuid
    FROM due WHERE d.id = due.id AND (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now()))
    RETURNING d.*`;
}

/** Hands leased deliveries back untried, still held by `lease`, to be retried in 30 seconds. */
export async function releaseDeliveries(tx: Tx, ids: string[], lease: string): Promise<void> {
  await tx`
            UPDATE webhook_deliveries SET status = 'pending', locked_until = NULL, lease_token = NULL, next_attempt_at = now() + interval '30 seconds'
            WHERE id = ANY(${ids}::uuid[]) AND lease_token = ${lease}::uuid`;
}

/** Extends a delivery's lease by `leaseSeconds` from now. False when `lease` no longer holds it. */
export async function renewLease(tx: Tx, deliveryId: string, lease: string, leaseSeconds: number): Promise<boolean> {
  const [held] = await tx`
      UPDATE webhook_deliveries SET locked_until = now() + make_interval(secs => ${leaseSeconds})
      WHERE id = ${deliveryId} AND status = 'sending' AND lease_token = ${lease}::uuid RETURNING 1`;
  return !!held;
}

// --- Retention ----------------------------------------------------------------------------------------

/** Deletes succeeded and dead deliveries older than 90 days. */
export async function deleteOldDeliveries(tx: Tx): Promise<void> {
  await tx`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '90 days' AND status IN ('succeeded', 'dead')`;
}

/** Deletes finished automation runs started more than 90 days ago. */
export async function deleteOldAutomationRuns(tx: Tx): Promise<void> {
  await tx`DELETE FROM automation_runs WHERE started_at < now() - interval '90 days' AND status NOT IN ('queued', 'running')`;
}

/** Deletes automation usage windows that began more than 2 days ago. */
export async function deleteOldAutomationUsage(tx: Tx): Promise<void> {
  await tx`DELETE FROM automation_usage WHERE window_start < now() - interval '2 days'`;
}

/** Deletes processed and dead events that occurred more than 90 days ago. */
export async function deleteOldEvents(tx: Tx): Promise<void> {
  await tx`DELETE FROM outbox_events WHERE (processed_at IS NOT NULL OR dead_at IS NOT NULL) AND occurred_at < now() - interval '90 days'`;
}

/** Deletes expired confirm tokens. */
export async function deleteExpiredConfirmTokens(tx: Tx): Promise<void> {
  await tx`DELETE FROM confirm_tokens WHERE expires_at < now()`;
}

/** Deletes Idempotency-Key records older than 24 hours, in the workspace the transaction is in. */
export async function deleteOldIdempotencyKeys(tx: Tx): Promise<void> {
  await tx`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`;
}
