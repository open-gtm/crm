import type { Tx } from "../../db/pool.js";

/**
 * The SQL of the event outbox (ADR 0012): writing events in the caller's transaction (core/events.ts)
 * and reading them back for GET /v1/events. The worker's own outbox SQL is in worker/.
 */

/** An outbox event, as the runner, webhooks and alerts read it. */
export interface EventRow {
  id: string; type: string; object_type: string | null; record_id: string | null; occurred_at: Date;
  actor_type: string; actor_id: string | null; surface: string; data: Record<string, unknown>; causation_depth: number;
  automation_id: string | null;
}

/** Writes one outbox event. */
export async function insertEvent(tx: Tx, e: {
  tenantId: string; id: string; type: string; objectType: string | null; recordId: string | null; actorType: string; actorId: string | null;
  surface: string; data: Record<string, unknown>; causationDepth: number; automationId: string | null;
}): Promise<void> {
  await tx`
    INSERT INTO outbox_events (tenant_id, id, type, object_type, record_id, actor_type, actor_id, surface, data, causation_depth, automation_id)
    VALUES (${e.tenantId}, ${e.id}, ${e.type}, ${e.objectType}, ${e.recordId},
            ${e.actorType}, ${e.actorId}, ${e.surface}, ${tx.json(e.data as never)},
            ${e.causationDepth}, ${e.automationId})`;
}

/** One event, for a queued automation run that started from it. */
export async function eventById(tx: Tx, id: string): Promise<EventRow | undefined> {
  const [e] = await tx<EventRow[]>`
        SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, data, causation_depth, automation_id FROM outbox_events WHERE id = ${id}`;
  return e;
}

/** Events of one type since a moment, newest first, at most `limit`, for an alert backtest. */
export async function recordEventsSince(tx: Tx, type: string, since: Date, limit: number) {
  return tx<{ record_id: string; occurred_at: Date; data: { after?: object } }[]>`
      SELECT record_id, occurred_at, data FROM outbox_events WHERE type = ${type} AND occurred_at >= ${since} AND record_id IS NOT NULL
      ORDER BY occurred_at DESC LIMIT ${limit}`;
}

// --- GET /v1/events ---------------------------------------------------------------------------------

/** How the worker got on with an event. */
export interface EventProcessing { processed_at: Date | null; dead_at: Date | null; attempts: number; last_error: string | null; next_attempt_at: Date | null }

export interface RecentEventsFilter {
  /** Event type prefix (matched literally, `%` and `_` included). */
  type: string | null;
  record: string | null;
  /** Only events older than this event ID (paging). */
  before: string | null;
  /** True when the caller can read every object; otherwise record events only for `readable` objects. */
  all: boolean;
  readable: string[];
  status: "pending" | "processed" | "dead" | null;
  limit: number;
}

/** Recent events, newest first, with their processing state. */
export async function recentEvents(tx: Tx, f: RecentEventsFilter): Promise<(EventRow & EventProcessing)[]> {
  return tx<(EventRow & EventProcessing)[]>`
      SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, data, causation_depth, automation_id,
             processed_at, dead_at, attempts, last_error, next_attempt_at
      FROM outbox_events
      WHERE (${f.type}::text IS NULL OR type LIKE ${(f.type ?? "").replace(/[\\%_]/g, (c) => `\\${c}`) + "%"})
        AND (${f.record}::uuid IS NULL OR record_id = ${f.record}::uuid)
        AND (${f.before}::uuid IS NULL OR id < ${f.before}::uuid)
        AND (${f.all} OR record_id IS NULL OR object_type = ANY(${f.readable}::text[]))
        AND (${f.status}::text IS NULL
          OR (${f.status} = 'processed' AND processed_at IS NOT NULL)
          OR (${f.status} = 'dead' AND dead_at IS NOT NULL)
          OR (${f.status} = 'pending' AND processed_at IS NULL AND dead_at IS NULL))
      ORDER BY id DESC LIMIT ${f.limit}`;
}
