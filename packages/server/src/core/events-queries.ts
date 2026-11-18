import type { Tx } from "../db/pool.js";
import type { EventRow } from "./webhooks.js";

/**
 * Reading the event outbox for GET /v1/events (ADR 0012). Moved out of the route handler; core's
 * other event SQL (events.ts, webhooks.ts) moves when core/ is converted.
 */

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
