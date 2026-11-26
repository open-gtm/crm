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
  /** The connected app or API key the change came through, by name. Only the events list selects it. */
  via?: string | null;
}

/** Writes one outbox event. */
export async function insertEvent(tx: Tx, e: {
  tenantId: string; id: string; type: string; objectType: string | null; recordId: string | null; actorType: string; actorId: string | null;
  surface: string; via: string | null; data: Record<string, unknown>; causationDepth: number; automationId: string | null;
}): Promise<void> {
  await tx`
    INSERT INTO outbox_events (tenant_id, id, type, object_type, record_id, actor_type, actor_id, surface, via, data, causation_depth, automation_id)
    VALUES (${e.tenantId}, ${e.id}, ${e.type}, ${e.objectType}, ${e.recordId},
            ${e.actorType}, ${e.actorId}, ${e.surface}, ${e.via}, ${tx.json(e.data as never)},
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
  /** Only events this member or service account caused. */
  actor: string | null;
  /** Only events that came through one of these surfaces. */
  surfaces: string[] | null;
  /** Only events at or after this time. */
  since: Date | null;
  limit: number;
}

/** Recent events, newest first, with their processing state. */
export async function recentEvents(tx: Tx, f: RecentEventsFilter): Promise<(EventRow & EventProcessing)[]> {
  return tx<(EventRow & EventProcessing)[]>`
      SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, via, data, causation_depth, automation_id,
             processed_at, dead_at, attempts, last_error, next_attempt_at
      FROM outbox_events
      WHERE (${f.type}::text IS NULL OR type LIKE ${(f.type ?? "").replace(/[\\%_]/g, (c) => `\\${c}`) + "%"})
        AND (${f.actor}::uuid IS NULL OR actor_id = ${f.actor}::uuid)
        AND (${f.surfaces}::text[] IS NULL OR surface = ANY(${f.surfaces}::text[]))
        AND (${f.since}::timestamptz IS NULL OR occurred_at >= ${f.since}::timestamptz)
        AND (${f.record}::uuid IS NULL OR record_id = ${f.record}::uuid)
        AND (${f.before}::uuid IS NULL OR id < ${f.before}::uuid)
        AND (${f.all} OR record_id IS NULL OR object_type = ANY(${f.readable}::text[]))
        AND (${f.status}::text IS NULL
          OR (${f.status} = 'processed' AND processed_at IS NOT NULL)
          OR (${f.status} = 'dead' AND dead_at IS NOT NULL)
          OR (${f.status} = 'pending' AND processed_at IS NULL AND dead_at IS NULL))
      ORDER BY id DESC LIMIT ${f.limit}`;
}

export interface ActivityRow { actor_type: string; actor_id: string | null; surface: string; via: string | null; changes: number; records: number; last_at: Date }

/** Changes since `since`, counted per actor, surface and app or key: who and what is writing to the workspace. */
export async function activityBySource(tx: Tx, since: Date, surfaces: string[], limit: number): Promise<ActivityRow[]> {
  return tx<ActivityRow[]>`
    SELECT actor_type, actor_id, surface, via, count(*)::int AS changes, count(DISTINCT record_id)::int AS records, max(occurred_at) AS last_at
    FROM outbox_events
    WHERE occurred_at >= ${since} AND surface = ANY(${surfaces}::text[])
    GROUP BY actor_type, actor_id, surface, via
    ORDER BY changes DESC, last_at DESC LIMIT ${limit}`;
}
