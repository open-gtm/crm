import type { Tx } from "../../db/pool.js";
import type { TriggerT } from "../alerts.js";
import type { Severity } from "../notifications.js";
import type { Where } from "../query.js";

/**
 * The SQL of alert rules and their materialized deadlines (core/alerts.ts, ADR 0012). The callers keep
 * their checks, errors, audits and the order of statements in each transaction. Deadlines and backtest
 * matches are computed by SQL the filter compiler builds from the workspace's fields (core/query.ts);
 * that text is built in alerts.ts, and only run here.
 */

export interface RuleRow {
  id: string; scope: "workspace" | "personal"; owner_user_id: string | null; name: string; description: string | null; object: string;
  kind: "event" | "time"; trigger: TriggerT; condition: Where | null; severity: Severity;
  recipients: { record_owner?: boolean; users?: string[] }; webhooks: string[]; cooldown_hours: number | null; enabled: boolean;
  backfill_cursor: string | null; backfilled_at: Date | null; version: number; created_at: Date; updated_at: Date; archived_at: Date | null;
}

// --- Rules ------------------------------------------------------------------------------------------

/** One rule, archived or not; `forUpdate` locks it. */
export async function ruleById(tx: Tx, id: string, forUpdate = false): Promise<RuleRow | undefined> {
  const [r] = forUpdate ? await tx<RuleRow[]>`SELECT * FROM alert_rules WHERE id = ${id} FOR UPDATE`
    : await tx<RuleRow[]>`SELECT * FROM alert_rules WHERE id = ${id}`;
  return r;
}

/** The enabled rules on an object. */
export async function enabledRulesOn(tx: Tx, object: string): Promise<RuleRow[]> {
  return tx<RuleRow[]>`SELECT * FROM alert_rules WHERE enabled AND archived_at IS NULL AND object = ${object}`;
}

/** The enabled inactive-trigger rules on an object. */
export async function enabledInactiveRulesOn(tx: Tx, object: string): Promise<RuleRow[]> {
  return tx<RuleRow[]>`
        SELECT * FROM alert_rules WHERE enabled AND archived_at IS NULL AND object = ${object} AND trigger->>'type' = 'inactive'`;
}

/** The webhooks a rule notifies, or undefined when there is no such rule. */
export async function ruleWebhooks(tx: Tx, id: string): Promise<string[] | undefined> {
  const [r] = await tx<{ webhooks: string[] }[]>`SELECT webhooks FROM alert_rules WHERE id = ${id}`;
  return r?.webhooks;
}

/** How many rules the workspace has that aren't archived. */
export async function countLiveRules(tx: Tx): Promise<number | undefined> {
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM alert_rules WHERE archived_at IS NULL`;
  return count?.n;
}

export interface RuleValues {
  name: string; description: string | null; object: string; kind: "event" | "time"; trigger: TriggerT; condition: Where | null; severity: string;
  recipients: { record_owner: boolean; users: string[] }; webhooks: string[]; cooldownHours: number | null; enabled: boolean;
}

export async function insertRule(tx: Tx, r: RuleValues & { tenantId: string; id: string; scope: "workspace" | "personal"; ownerUserId: string | null;
  createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO alert_rules (tenant_id, id, scope, owner_user_id, name, description, object, kind, trigger, condition, severity, recipients,
                             webhooks, cooldown_hours, enabled, created_by)
    VALUES (${r.tenantId}, ${r.id}, ${r.scope}, ${r.ownerUserId}, ${r.name}, ${r.description},
            ${r.object}, ${r.kind}, ${tx.json(r.trigger as never)}, ${r.condition ? tx.json(r.condition as never) : null},
            ${r.severity}, ${tx.json(r.recipients as never)}, ${r.webhooks}::uuid[], ${r.cooldownHours},
            ${r.enabled}, ${r.createdBy})`;
}

/** Saves a rule's new definition (one version up), with the deadline backfill state it should have now. */
export async function updateRule(tx: Tx, id: string, r: RuleValues & { backfilledAt: Date | null; backfillCursor: string | null }): Promise<void> {
  await tx`
    UPDATE alert_rules SET name = ${r.name}, description = ${r.description}, object = ${r.object}, kind = ${r.kind},
      trigger = ${tx.json(r.trigger as never)}, condition = ${r.condition ? tx.json(r.condition as never) : null}, severity = ${r.severity},
      recipients = ${tx.json(r.recipients as never)}, webhooks = ${r.webhooks}::uuid[], cooldown_hours = ${r.cooldownHours},
      enabled = ${r.enabled}, version = version + 1,
      backfilled_at = ${r.backfilledAt}, backfill_cursor = ${r.backfillCursor}
    WHERE id = ${id}`;
}

/** Archives and disables a rule. */
export async function archiveRuleRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE alert_rules SET archived_at = now(), enabled = false WHERE id = ${id}`;
}

/** A member's personal rules that aren't archived, oldest first. */
export async function personalRulesOf(tx: Tx, userId: string): Promise<RuleRow[]> {
  return tx<RuleRow[]>`SELECT * FROM alert_rules WHERE archived_at IS NULL AND scope = 'personal' AND owner_user_id = ${userId} ORDER BY created_at`;
}

/** Every rule that isn't archived: workspace rules first, then personal, oldest first. */
export async function liveRules(tx: Tx): Promise<RuleRow[]> {
  return tx<RuleRow[]>`SELECT * FROM alert_rules WHERE archived_at IS NULL ORDER BY scope DESC, created_at`;
}

// --- Deadlines --------------------------------------------------------------------------------------

/** Runs deadline SQL built by alerts.ts (dueQuery): each record's ID and its deadline, if it has one. */
export async function computedDeadlines(tx: Tx, text: string, params: unknown[]) {
  return tx.unsafe<{ id: string; due: Date | null }[]>(text, params as never[]);
}

/** Sets a record's deadline for a rule, creating it if needed. */
export async function upsertDeadline(tx: Tx, tenantId: string, ruleId: string, recordId: string, due: Date | null): Promise<void> {
  await tx`INSERT INTO rule_deadlines (tenant_id, rule_id, record_id, due_at) VALUES (${tenantId}, ${ruleId}, ${recordId}, ${due})
             ON CONFLICT (tenant_id, rule_id, record_id) DO UPDATE SET due_at = EXCLUDED.due_at`;
}

/** Moves an existing deadline. */
export async function moveDeadline(tx: Tx, ruleId: string, recordId: string, due: Date): Promise<void> {
  await tx`UPDATE rule_deadlines SET due_at = ${due} WHERE rule_id = ${ruleId} AND record_id = ${recordId}`;
}

export async function dropDeadline(tx: Tx, ruleId: string, recordId: string): Promise<void> {
  await tx`DELETE FROM rule_deadlines WHERE rule_id = ${ruleId} AND record_id = ${recordId}`;
}

export async function dropDeadlines(tx: Tx, ruleId: string, recordIds: string[]): Promise<void> {
  await tx`DELETE FROM rule_deadlines WHERE rule_id = ${ruleId} AND record_id = ANY(${recordIds}::uuid[])`;
}

/** Every deadline of a rule. */
export async function dropRuleDeadlines(tx: Tx, ruleId: string): Promise<void> {
  await tx`DELETE FROM rule_deadlines WHERE rule_id = ${ruleId}`;
}

/** Time rules whose deadlines are still being built. */
export async function rulesToBackfill(tx: Tx): Promise<RuleRow[]> {
  return tx<RuleRow[]>`SELECT * FROM alert_rules WHERE kind = 'time' AND backfilled_at IS NULL AND archived_at IS NULL`;
}

export async function finishBackfill(tx: Tx, ruleId: string): Promise<void> {
  await tx`UPDATE alert_rules SET backfilled_at = now(), backfill_cursor = NULL WHERE id = ${ruleId}`;
}

/** Saves where a rule's backfill got to (the last record ID done). */
export async function advanceBackfill(tx: Tx, ruleId: string, cursor: string): Promise<void> {
  await tx`UPDATE alert_rules SET backfill_cursor = ${cursor} WHERE id = ${ruleId}`;
}

/** Deadlines due by `now` of enabled rules, earliest first, at most `limit`, locked (skipping those another worker holds). */
export async function dueDeadlines(tx: Tx, now: Date, limit: number) {
  return tx<{ rule_id: string; record_id: string }[]>`
      SELECT d.rule_id, d.record_id FROM rule_deadlines d
      JOIN alert_rules r ON r.tenant_id = d.tenant_id AND r.id = d.rule_id AND r.enabled AND r.archived_at IS NULL
      WHERE d.due_at <= ${now} ORDER BY d.due_at LIMIT ${limit} FOR UPDATE OF d SKIP LOCKED`;
}

/** The records an activity is linked to, with their objects. */
export async function activityLinks(tx: Tx, activityId: string) {
  return tx<{ record_id: string; object_id: string }[]>`
      SELECT aa.record_id, rr.object_id FROM activity_associations aa
      JOIN record_registry rr ON rr.tenant_id = aa.tenant_id AND rr.id = aa.record_id WHERE aa.activity_id = ${activityId}`;
}

// --- Backtest ---------------------------------------------------------------------------------------

/** Runs a record query compiled by core/query.ts (compileQuery) and returns the IDs it matched. */
export async function compiledRecordIds(tx: Tx, text: string, params: unknown[]) {
  return tx.unsafe<{ id: string }[]>(text, params as never[]);
}
