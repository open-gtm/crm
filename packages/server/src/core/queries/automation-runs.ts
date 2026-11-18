import type { Tx } from "../../db/pool.js";
import type { AutomationRow } from "../automation-defs.js";
import type { RunState, StepResult } from "../automation-runner.js";

/**
 * The SQL of automation runs: recording event, manual and scheduled runs, the caps they count against,
 * and the worker's leasing of queued runs (core/automations.ts and automation-runner.ts, ADR 0012). The
 * callers keep their checks, errors, audits and the order of statements in each transaction.
 */

// --- Run history ------------------------------------------------------------------------------------

export interface RunListRow {
  id: string; event_id: string | null; record_id: string | null; status: string; reason: string | null; depth: number; results: unknown; started_at: Date;
  finished_at: Date | null; trigger_kind: string; scheduled_for: Date | null; requested_by: string | null; input: { record?: string; via?: Record<string, string> } | null;
  attempts: number; usage: unknown;
}

/** An automation's runs, of one status when given, newest first. */
export async function runsOf(tx: Tx, automationId: string, status: string | null, limit: number): Promise<RunListRow[]> {
  return tx<RunListRow[]>`
    SELECT id, event_id, record_id, status, reason, depth, results, started_at, finished_at, trigger_kind, scheduled_for, requested_by, input, attempts, usage
    FROM automation_runs WHERE automation_id = ${automationId} AND (${status}::text IS NULL OR status = ${status})
    ORDER BY started_at DESC LIMIT ${limit}`;
}

// --- Event runs -------------------------------------------------------------------------------------

/**
 * Records an automation's run for an event; nothing when the automation already has one for it. A
 * finished run (any status but queued) is stamped finished now.
 */
export async function insertEventRun(tx: Tx, r: { tenantId: string; id: string; automationId: string; eventId: string; recordId: string | null; status: string;
  reason: string | null; depth: number; results: unknown; finishedAt: Date | null; usage: Record<string, unknown> }): Promise<void> {
  await tx`INSERT INTO automation_runs (tenant_id, id, automation_id, event_id, record_id, status, reason, depth, results, finished_at, usage)
               VALUES (${r.tenantId}, ${r.id}, ${r.automationId}, ${r.eventId}, ${r.recordId}, ${r.status}, ${r.reason}, ${r.depth},
                       ${tx.json(r.results as never)}, ${r.finishedAt}, ${tx.json(r.usage as never)})
               ON CONFLICT (tenant_id, automation_id, event_id) DO NOTHING`;
}

/** Whether an automation already has a run for an event. */
export async function hasRunForEvent(tx: Tx, automationId: string, eventId: string): Promise<boolean> {
  const [prior] = await tx`SELECT 1 FROM automation_runs WHERE automation_id = ${automationId} AND event_id = ${eventId}`;
  return Boolean(prior);
}

/** An automation's runs (skips aside) in the last hour, and those of them for one record in the last 10 minutes. */
export async function recentRunCounts(tx: Tx, automationId: string, recordId: string) {
  const [recent] = await tx<{ n: number; same: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE record_id = ${recordId} AND started_at > now() - interval '10 minutes')::int AS same
      FROM automation_runs WHERE automation_id = ${automationId} AND status <> 'skipped' AND started_at > now() - interval '1 hour'`;
  return recent;
}

// --- Manual runs ------------------------------------------------------------------------------------

/** An automation's runs (skips aside) in the last hour, and its requested runs still queued or running. */
export async function manualRunCounts(tx: Tx, automationId: string) {
  const [counts] = await tx<{ hour: number; open: number }[]>`
    SELECT count(*) FILTER (WHERE status <> 'skipped' AND started_at > now() - interval '1 hour')::int AS hour,
           count(*) FILTER (WHERE trigger_kind = 'manual' AND status IN ('queued', 'running'))::int AS open
    FROM automation_runs WHERE automation_id = ${automationId}`;
  return counts;
}

/** Queues a requested run, for a record or none. */
export async function insertManualRun(tx: Tx, r: { tenantId: string; id: string; automationId: string; recordId: string | null; requestedBy: string | null;
  input: { record: string | null; via: Record<string, string> } }): Promise<void> {
  await tx`INSERT INTO automation_runs (tenant_id, id, automation_id, event_id, record_id, status, depth, trigger_kind, requested_by, input)
             VALUES (${r.tenantId}, ${r.id}, ${r.automationId}, NULL, ${r.recordId}, 'queued', 0, 'manual', ${r.requestedBy}, ${tx.json(r.input as never)})`;
}

// --- Scheduled runs ---------------------------------------------------------------------------------

/** Automations whose next run is due by `now`, earliest first, at most 100, locked (skipping those another worker holds). */
export async function dueScheduledAutomations(tx: Tx, now: Date): Promise<AutomationRow[]> {
  return tx<AutomationRow[]>`
      SELECT * FROM automations WHERE next_run_at <= ${now} AND archived_at IS NULL ORDER BY next_run_at LIMIT 100 FOR UPDATE SKIP LOCKED`;
}

/** An automation's runs still queued or running, and its runs (skips aside) in the last hour. */
export async function scheduleRunCounts(tx: Tx, automationId: string) {
  const [n] = await tx<{ open: number; hour: number }[]>`
          SELECT count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS open,
                 count(*) FILTER (WHERE status <> 'skipped' AND started_at > now() - interval '1 hour')::int AS hour
          FROM automation_runs WHERE automation_id = ${automationId}`;
  return n;
}

/** Records a schedule tick's run (queued, or skipped with a reason); nothing when the tick already has one. */
export async function insertScheduledRun(tx: Tx, r: { tenantId: string; id: string; automationId: string; status: string; reason: string | null; scheduledFor: Date;
  finishedAt: Date | null; usage: Record<string, unknown> }): Promise<void> {
  await tx`INSERT INTO automation_runs (tenant_id, id, automation_id, event_id, record_id, status, reason, depth, trigger_kind, scheduled_for, finished_at, usage)
                 VALUES (${r.tenantId}, ${r.id}, ${r.automationId}, NULL, NULL, ${r.status}, ${r.reason}, 0, 'schedule', ${r.scheduledFor},
                         ${r.finishedAt}, ${tx.json(r.usage as never)})
                 ON CONFLICT DO NOTHING`;
}

// --- Caps -------------------------------------------------------------------------------------------

/** Counts one unit in a cap's window. False when the window already holds `cap`. */
export async function countUsage(tx: Tx, tenantId: string, bucket: string, windowStart: Date, cap: number): Promise<boolean> {
  const rows = await tx`
    INSERT INTO automation_usage (tenant_id, bucket, window_start, n) VALUES (${tenantId}, ${bucket}, ${windowStart}, 1)
    ON CONFLICT (tenant_id, bucket, window_start) DO UPDATE SET n = automation_usage.n + 1 WHERE automation_usage.n < ${cap}
    RETURNING n`;
  return rows.length > 0;
}

/** Marks that admins were told about a cap in a window. False when they already were. */
export async function markCapNotice(tx: Tx, tenantId: string, bucket: string, window: Date): Promise<boolean> {
  const [first] = await tx`INSERT INTO automation_usage (tenant_id, bucket, window_start, n) VALUES (${tenantId}, ${bucket}, ${window}, 1)
                           ON CONFLICT DO NOTHING RETURNING 1`;
  return Boolean(first);
}

// --- After a run ------------------------------------------------------------------------------------

/** How many of an automation's runs are queued. */
export async function queuedRunCount(tx: Tx, automationId: string): Promise<number | undefined> {
  const [q] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM automation_runs WHERE automation_id = ${automationId} AND status = 'queued'`;
  return q?.n;
}

/** Active members whose role (not archived) can manage automations. */
export async function automationManagers(tx: Tx): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT u.id FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
    WHERE u.disabled_at IS NULL AND r.archived_at IS NULL AND 'automations:manage' = ANY (r.permissions)`;
}

/** An active member's email address. */
export async function activeMemberEmail(tx: Tx, userId: string): Promise<{ email: string } | undefined> {
  const [u] = await tx<{ email: string }[]>`SELECT email::text AS email FROM users WHERE id = ${userId} AND disabled_at IS NULL`;
  return u;
}

// --- The worker's leases ----------------------------------------------------------------------------

export interface Progress {
  cursor?: string | null; loop?: RunState["loop"]; vars?: Record<string, unknown>; counters?: { executed?: number; http?: number; emails?: number };
}

export interface RunRow {
  id: string; automation_id: string; event_id: string | null; record_id: string | null; status: string; depth: number; trigger_kind: string;
  scheduled_for: Date | null; input: { record?: string } | null; attempts: number; progress: Progress | null;
  results: StepResult[]; requested_by: string | null;
}

/** Up to 10 runs that are queued or whose lease ran out, oldest first, locked (skipping those another worker holds). */
export async function claimableRuns(tx: Tx): Promise<{ id: string; automation_id: string }[]> {
  return tx<{ id: string; automation_id: string }[]>`
      SELECT id, automation_id FROM automation_runs
      WHERE status = 'queued' OR (status = 'running' AND locked_until < now())
      ORDER BY started_at, id LIMIT 10 FOR UPDATE SKIP LOCKED`;
}

/** Locks an automation unless another worker holds it; false when it does. */
export async function lockAutomationIfFree(tx: Tx, automationId: string): Promise<boolean> {
  const [free] = await tx`SELECT 1 FROM automations WHERE id = ${automationId} FOR UPDATE SKIP LOCKED`;
  return Boolean(free);
}

/** Whether another run of the automation is running under a live lease. */
export async function otherRunInProgress(tx: Tx, automationId: string, runId: string): Promise<boolean> {
  const [busy] = await tx`SELECT 1 FROM automation_runs WHERE automation_id = ${automationId} AND status = 'running' AND locked_until >= now() AND id <> ${runId} LIMIT 1`;
  return Boolean(busy);
}

/** Starts (or restarts) a run under a new lease of `seconds`, one attempt more. */
export async function leaseRun(tx: Tx, id: string, lease: string, seconds: number): Promise<RunRow | undefined> {
  const [row] = await tx<RunRow[]>`
        UPDATE automation_runs SET status = 'running', attempts = attempts + 1, lease_token = ${lease}::uuid,
          locked_until = now() + make_interval(secs => ${seconds})
        WHERE id = ${id} RETURNING *`;
  return row;
}

/** Whether this lease still holds the running run, locking it. */
export async function holdsRunLease(tx: Tx, id: string, lease: string): Promise<boolean> {
  const [held] = await tx`SELECT 1 FROM automation_runs WHERE id = ${id} AND status = 'running' AND lease_token = ${lease}::uuid FOR UPDATE`;
  return Boolean(held);
}

/**
 * Merges `progress` into the run's saved progress, replaces its step log with `results` (null keeps it)
 * and extends its lease by `seconds`.
 */
export async function saveRunProgress(tx: Tx, id: string, progress: Record<string, unknown>, results: unknown[] | null, seconds: number): Promise<void> {
  await tx`UPDATE automation_runs SET progress = COALESCE(progress, '{}'::jsonb) || ${tx.json(progress as never)},
               results = ${results ? tx.json(results as never) : tx`results`}, locked_until = now() + make_interval(secs => ${seconds}) WHERE id = ${id}`;
}

/** Ends a run under this lease; false when the lease is no longer held. */
export async function finishRun(tx: Tx, id: string, lease: string, r: { status: string; reason: string | null; results: unknown; usage: Record<string, unknown> }): Promise<boolean> {
  const done = await tx`
        UPDATE automation_runs SET status = ${r.status}, reason = ${r.reason}, results = ${tx.json(r.results as never)},
          usage = ${tx.json(r.usage as never)},
          progress = NULL, lease_token = NULL, locked_until = NULL, finished_at = clock_timestamp()
        WHERE id = ${id} AND lease_token = ${lease}::uuid RETURNING 1`;
  return done.length > 0;
}
