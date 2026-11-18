import type { Tx } from "../../db/pool.js";
import type { Permission } from "../context.js";
import type { Prefs, Severity } from "../notifications.js";

/**
 * The SQL of notifications, their email deliveries and members' notification preferences
 * (core/notifications.ts, ADR 0012). The callers keep their checks, errors and the order of statements
 * in each transaction.
 */

// --- Preferences ------------------------------------------------------------------------------------

/** A member's stored preferences (only what they set), or undefined when they never set any. */
export async function storedPrefs(tx: Tx, userId: string): Promise<{ prefs: Partial<Prefs> } | undefined> {
  const [row] = await tx<{ prefs: Partial<Prefs> }[]>`SELECT prefs FROM notification_preferences WHERE user_id = ${userId}`;
  return row;
}

export async function savePrefs(tx: Tx, tenantId: string, userId: string, prefs: Prefs): Promise<void> {
  await tx`INSERT INTO notification_preferences (tenant_id, user_id, prefs) VALUES (${tenantId}, ${userId}, ${tx.json(prefs as never)})
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs`;
}

// --- Recipients -------------------------------------------------------------------------------------

/** A member and their role, enough to build the role's context. */
export interface MemberRole { id: string; role_id: string; role_key: string; permissions: Permission[]; access_version: string }

/** The members among `ids` who are active and whose role isn't archived, with their roles. */
export async function activeMemberRoles(tx: Tx, ids: string[]): Promise<MemberRole[]> {
  return tx<MemberRole[]>`
    SELECT u.id, r.id AS role_id, r.key AS role_key, r.permissions, r.access_version::text
    FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
    WHERE u.id = ANY(${ids}::uuid[]) AND u.disabled_at IS NULL AND r.archived_at IS NULL`;
}

/** An active member by user ID. */
export async function activeUserById(tx: Tx, id: string): Promise<{ id: string } | undefined> {
  const [u] = await tx<{ id: string }[]>`SELECT id FROM users WHERE id = ${id} AND disabled_at IS NULL`;
  return u;
}

/** An active member by email. */
export async function activeUserByEmail(tx: Tx, email: string): Promise<{ id: string } | undefined> {
  const [u] = await tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND disabled_at IS NULL`;
  return u;
}

// --- Firing -----------------------------------------------------------------------------------------

/** Which notification a firing is about: its source (an alert rule or an automation), record and recipient. */
export interface NotificationKey { userId: string; recordId: string | null; ruleId: string | null; automationId: string | null }

/** The open (not resolved) notification for this source, record and recipient, locked. */
export async function openNotificationForUpdate(tx: Tx, k: NotificationKey) {
  const [open] = await tx<{ id: string; state: string; last_fired_at: Date; snoozed_until: Date | null }[]>`
    SELECT id, state, last_fired_at, snoozed_until FROM notifications
    WHERE user_id = ${k.userId} AND state <> 'resolved' AND record_id IS NOT DISTINCT FROM ${k.recordId}::uuid
      AND rule_id IS NOT DISTINCT FROM ${k.ruleId}::uuid AND automation_id IS NOT DISTINCT FROM ${k.automationId}::uuid
    FOR UPDATE`;
  return open;
}

/** Fires an open notification again: one more firing, a new title, and `state` (unread, or snoozed while the snooze lasts). */
export async function refireNotification(tx: Tx, id: string, now: Date, title: string, state: "snoozed" | "unread"): Promise<void> {
  await tx`UPDATE notifications SET fire_count = fire_count + 1, last_fired_at = ${now}, title = ${title},
               state = ${state} WHERE id = ${id}`;
}

/** Whether a notification for this source, record and recipient was resolved after last firing later than `since`. */
export async function resolvedSince(tx: Tx, k: NotificationKey, since: Date): Promise<boolean> {
  const [recent] = await tx`
        SELECT 1 FROM notifications WHERE user_id = ${k.userId} AND state = 'resolved' AND record_id IS NOT DISTINCT FROM ${k.recordId}::uuid
          AND rule_id IS NOT DISTINCT FROM ${k.ruleId}::uuid AND automation_id IS NOT DISTINCT FROM ${k.automationId}::uuid
          AND last_fired_at > ${since} LIMIT 1`;
  return Boolean(recent);
}

/** Creates a notification. False when one already exists for its source, record and recipient. */
export async function insertNotification(tx: Tx, n: { tenantId: string; id: string; ruleId: string | null; automationId: string | null; recordId: string | null;
  object: string; userId: string; severity: Severity; title: string; body: string | null; now: Date }): Promise<boolean> {
  const inserted = await tx`
      INSERT INTO notifications (tenant_id, id, rule_id, automation_id, record_id, object, user_id, severity, title, body, first_fired_at, last_fired_at)
      VALUES (${n.tenantId}, ${n.id}, ${n.ruleId}, ${n.automationId}, ${n.recordId}, ${n.object}, ${n.userId}, ${n.severity}, ${n.title},
              ${n.body}, ${n.now}, ${n.now})
      ON CONFLICT DO NOTHING RETURNING id`;
  return inserted.length > 0;
}

/** Queues an email of a notification, sent at `at`. */
export async function queueEmailDelivery(tx: Tx, d: { tenantId: string; id: string; notificationId: string; userId: string; mode: string; at: Date }): Promise<void> {
  await tx`INSERT INTO notification_deliveries (tenant_id, id, notification_id, user_id, channel, mode, next_attempt_at)
             VALUES (${d.tenantId}, ${d.id}, ${d.notificationId}, ${d.userId}, 'email', ${d.mode}, ${d.at})`;
}

/** Wakes notifications whose snooze has ended. */
export async function wakeSnoozed(tx: Tx, now: Date): Promise<void> {
  await tx`UPDATE notifications SET state = 'unread', snoozed_until = NULL WHERE state = 'snoozed' AND snoozed_until <= ${now}`;
}

// --- Inbox ------------------------------------------------------------------------------------------

export interface NotificationRow {
  id: string; rule_id: string | null; automation_id: string | null; record_id: string | null; object: string; user_id: string;
  severity: Severity; title: string; body: string | null; state: string; snoozed_until: Date | null; fire_count: number;
  first_fired_at: Date; last_fired_at: Date; acknowledged_at: Date | null; resolved_at: Date | null; rule_name?: string | null;
  rule_description?: string | null;
}

/**
 * A NotificationRow's columns and joins: the notification, and the name and description of the alert rule
 * or automation that fired it. Spliced into .unsafe() text, which numbers its own parameters. Exported for
 * the inbox list, which still runs its own statement in notifications.ts (myNotifications).
 */
export const NOTIFICATION_SELECT = `n.*, COALESCE(r.name, a.name) AS rule_name, COALESCE(r.description, a.description) AS rule_description
  FROM notifications n LEFT JOIN alert_rules r ON r.tenant_id = n.tenant_id AND r.id = n.rule_id
  LEFT JOIN automations a ON a.tenant_id = n.tenant_id AND a.id = n.automation_id`;

/** One of a member's notifications, locked. */
export async function memberNotificationForUpdate(tx: Tx, id: string, userId: string): Promise<NotificationRow | undefined> {
  const [n] = await tx.unsafe<NotificationRow[]>(`SELECT ${NOTIFICATION_SELECT} WHERE n.id = $1 AND n.user_id = $2 FOR UPDATE OF n`, [id, userId]);
  return n;
}

export async function notificationById(tx: Tx, id: string): Promise<NotificationRow | undefined> {
  const [n] = await tx.unsafe<NotificationRow[]>(`SELECT ${NOTIFICATION_SELECT} WHERE n.id = $1`, [id]);
  return n;
}

/** A member's open notifications that need attention (snoozes that ended included), most severe first, at most 25. */
export async function attentionNotifications(tx: Tx, userId: string): Promise<NotificationRow[]> {
  return tx.unsafe<NotificationRow[]>(
    `SELECT ${NOTIFICATION_SELECT}
     WHERE n.user_id = $1 AND (n.state IN ('unread', 'acknowledged') OR (n.state = 'snoozed' AND n.snoozed_until <= now()))
     ORDER BY CASE n.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
              CASE WHEN n.state = 'acknowledged' THEN 1 ELSE 0 END, n.last_fired_at DESC
     LIMIT 25`, [userId]);
}

/** A member's open notifications counted by severity (snoozed ones apart), unread and snoozed. */
export async function openNotificationCounts(tx: Tx, userId: string) {
  const [counts] = await tx<{ critical: number; warning: number; info: number; unread: number; snoozed: number }[]>`
    SELECT count(*) FILTER (WHERE severity = 'critical' AND state <> 'snoozed')::int AS critical,
           count(*) FILTER (WHERE severity = 'warning' AND state <> 'snoozed')::int AS warning,
           count(*) FILTER (WHERE severity = 'info' AND state <> 'snoozed')::int AS info,
           count(*) FILTER (WHERE state = 'unread')::int AS unread,
           count(*) FILTER (WHERE state = 'snoozed' AND snoozed_until > now())::int AS snoozed
    FROM notifications WHERE user_id = ${userId} AND state <> 'resolved'`;
  return counts;
}

/** A member's overdue open tasks, earliest due first, at most 10. */
export async function overdueTasksOf(tx: Tx, userId: string) {
  return tx<{ id: string; title: string; due_at: Date; priority: string }[]>`
    SELECT id, title, due_at, priority FROM tasks
    WHERE assignee_user_id = ${userId} AND archived_at IS NULL AND status_category IN ('open', 'in_progress') AND due_at < now()
    ORDER BY due_at LIMIT 10`;
}

/** A notification's deliveries, oldest first. */
export async function deliveriesOfNotification(tx: Tx, notificationId: string) {
  return tx<{ id: string; channel: string; mode: string; status: string; attempts: number; next_attempt_at: Date; last_error: string | null; sent_at: Date | null }[]>`
    SELECT id, channel, mode, status, attempts, next_attempt_at, last_error, sent_at FROM notification_deliveries WHERE notification_id = ${notificationId} ORDER BY created_at`;
}

export async function acknowledgeNotification(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE notifications SET state = 'acknowledged', acknowledged_at = now(), snoozed_until = NULL WHERE id = ${id}`;
}

export async function snoozeNotification(tx: Tx, id: string, until: Date): Promise<void> {
  await tx`UPDATE notifications SET state = 'snoozed', snoozed_until = ${until} WHERE id = ${id}`;
}

export async function resolveNotification(tx: Tx, id: string, resolvedBy: string | null): Promise<void> {
  await tx`UPDATE notifications SET state = 'resolved', resolved_at = now(), resolved_by = ${resolvedBy}, snoozed_until = NULL WHERE id = ${id}`;
}

/** Skips the emails of a resolved notification that were still waiting to be sent. */
export async function skipPendingDeliveries(tx: Tx, notificationId: string): Promise<void> {
  await tx`UPDATE notification_deliveries SET status = 'skipped', last_error = 'resolved before sending' WHERE notification_id = ${notificationId} AND status = 'pending'`;
}

// --- Email delivery (worker) ------------------------------------------------------------------------

/** A claimed email delivery, with its recipient and their role (re-checked at send time). */
export type ClaimedDeliveryRow = {
  id: string; notification_id: string; user_id: string; mode: string; attempts: number; email: string; user_name: string;
} & MemberRole & { disabled: boolean };

/** Leases up to 200 due email deliveries until `leaseUntil`, skipping those another worker holds. */
export async function claimDueDeliveries(tx: Tx, now: Date, leaseUntil: Date): Promise<ClaimedDeliveryRow[]> {
  return tx<ClaimedDeliveryRow[]>`
      UPDATE notification_deliveries d SET next_attempt_at = ${leaseUntil}
      FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
      WHERE d.id IN (SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at <= ${now}
                     ORDER BY next_attempt_at LIMIT 200 FOR UPDATE SKIP LOCKED)
        AND u.tenant_id = d.tenant_id AND u.id = d.user_id
      RETURNING d.id, d.notification_id, d.user_id, d.mode, d.attempts, u.email::text AS email, u.name AS user_name,
        u.disabled_at IS NOT NULL AS disabled, r.id AS role_id, r.key AS role_key, r.permissions, r.access_version::text`;
}

/** The workspace's name. */
export async function currentWorkspaceName(tx: Tx): Promise<string | undefined> {
  const [ws] = await tx<{ name: string }[]>`SELECT name FROM tenants`;
  return ws?.name;
}

export async function markEmailSent(tx: Tx, id: string, now: Date): Promise<void> {
  await tx`UPDATE notification_deliveries SET status = 'sent', attempts = attempts + 1, sent_at = ${now}, last_error = NULL WHERE id = ${id}`;
}

export async function scheduleEmailRetry(tx: Tx, id: string, error: string | null, nextAttemptAt: Date): Promise<void> {
  await tx`UPDATE notification_deliveries SET attempts = attempts + 1, last_error = ${error},
                   next_attempt_at = ${nextAttemptAt} WHERE id = ${id}`;
}

/** Ends a delivery unsent: `status` skipped or failed, `attemptsAdded` the attempt it took (0 or 1). */
export async function endEmailDelivery(tx: Tx, id: string, status: string, attemptsAdded: number, error: string | null): Promise<void> {
  await tx`UPDATE notification_deliveries SET status = ${status}, attempts = attempts + ${attemptsAdded}, last_error = ${error} WHERE id = ${id}`;
}
