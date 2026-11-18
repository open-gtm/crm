import type { Tx } from "../../db/pool.js";

/**
 * The SQL of the standard objects' hooks (core/standard.ts; ADR 0012): a deal's pipeline and stage, activity
 * types, what activities and tasks are about, a contact's accounts and lifecycle stage. The code that calls
 * these keeps its checks, errors, audits and the order of statements in its transaction.
 */

// --- Related records --------------------------------------------------------------------------------

/** True when a record with this ID exists on this object. */
export async function recordExists(tx: Tx, id: string, objectId: string): Promise<boolean> {
  const found = await tx`SELECT 1 FROM record_registry WHERE id = ${id} AND object_id = ${objectId}`;
  return found.length > 0;
}

/** A contact's primary account. */
export async function contactPrimaryAccount(tx: Tx, contactId: string): Promise<{ primary_account_id: string | null } | undefined> {
  const [c] = await tx<{ primary_account_id: string | null }[]>`SELECT primary_account_id FROM contacts WHERE id = ${contactId}`;
  return c;
}

// --- Activity types ---------------------------------------------------------------------------------

export async function activityType(tx: Tx, key: string): Promise<{ key: string } | undefined> {
  const [t] = await tx<{ key: string }[]>`SELECT key FROM activity_types WHERE key = ${key}`;
  return t;
}

export async function activityTypeKeys(tx: Tx): Promise<{ key: string }[]> {
  return tx<{ key: string }[]>`SELECT key FROM activity_types ORDER BY key`;
}

/** Whether activities of a type can be edited; undefined when there is no such type. */
export async function activityTypeEditable(tx: Tx, key: string): Promise<{ editable: boolean } | undefined> {
  const [t] = await tx<{ editable: boolean }[]>`SELECT editable FROM activity_types WHERE key = ${key}`;
  return t;
}

// --- A deal's pipeline and stage --------------------------------------------------------------------

export interface DealStageRow { id: string; category: string; default_probability: string | null }

export async function defaultPipelineId(tx: Tx): Promise<{ id: string } | undefined> {
  const [p] = await tx<{ id: string }[]>`SELECT id FROM pipelines WHERE is_default AND archived_at IS NULL`;
  return p;
}

/** A live stage of the pipeline by name, ignoring case. */
export async function stageNamed(tx: Tx, pipelineId: string, name: string): Promise<DealStageRow | undefined> {
  const [stage] = await tx<DealStageRow[]>`SELECT id, category, default_probability FROM stages
      WHERE pipeline_id = ${pipelineId} AND lower(name) = lower(${name}) AND archived_at IS NULL`;
  return stage;
}

/** The names of a pipeline's live stages, in order. */
export async function stageNames(tx: Tx, pipelineId: string): Promise<{ name: string }[]> {
  return tx<{ name: string }[]>`SELECT name FROM stages WHERE pipeline_id = ${pipelineId} AND archived_at IS NULL ORDER BY position`;
}

/** A stage by ID, if it belongs to the pipeline (archived or not). */
export async function stageOfPipeline(tx: Tx, stageId: string, pipelineId: string): Promise<DealStageRow | undefined> {
  const [stage] = await tx<DealStageRow[]>`SELECT id, category, default_probability FROM stages WHERE id = ${stageId} AND pipeline_id = ${pipelineId}`;
  return stage;
}

/** A pipeline's first live stage. */
export async function firstStage(tx: Tx, pipelineId: string): Promise<DealStageRow | undefined> {
  const [stage] = await tx<DealStageRow[]>`SELECT id, category, default_probability FROM stages
      WHERE pipeline_id = ${pipelineId} AND archived_at IS NULL ORDER BY position LIMIT 1`;
  return stage;
}

/** A new deal's first stage history entry (from no stage). */
export async function insertFirstStageHistory(tx: Tx, h: { tenantId: string; id: string; dealId: string; stageId: string; changedBy: string | null }): Promise<void> {
  await tx`INSERT INTO deal_stage_history (tenant_id, id, deal_id, from_stage_id, to_stage_id, changed_by)
               VALUES (${h.tenantId}, ${h.id}, ${h.dealId}, NULL, ${h.stageId}, ${h.changedBy})`;
}

// --- What activities and tasks are about ------------------------------------------------------------

/** Links an activity to a record it is about, at the activity's time. */
export async function insertActivityAssociation(tx: Tx, a: { tenantId: string; activityId: string; recordId: string; occurredAt: string }): Promise<void> {
  await tx`INSERT INTO activity_associations (tenant_id, activity_id, record_id, occurred_at)
                 VALUES (${a.tenantId}, ${a.activityId}, ${a.recordId}, ${a.occurredAt})`;
}

/** Links an activity happening now to a record it is about. */
export async function insertActivityAssociationNow(tx: Tx, a: { tenantId: string; activityId: string; recordId: string }): Promise<void> {
  await tx`INSERT INTO activity_associations (tenant_id, activity_id, record_id, occurred_at)
               VALUES (${a.tenantId}, ${a.activityId}, ${a.recordId}, now())`;
}

/** Moves the deals' last activity time forward to `occurredAt` (never back). IDs that aren't deals match nothing. */
export async function advanceDealsLastActivity(tx: Tx, ids: string[], occurredAt: string): Promise<void> {
  await tx`UPDATE deals SET last_activity_at = greatest(coalesce(last_activity_at, ${occurredAt}::timestamptz), ${occurredAt}::timestamptz)
                 WHERE id = ANY(${ids}::uuid[])`;
}

export async function insertTaskAssociation(tx: Tx, tenantId: string, taskId: string, recordId: string): Promise<void> {
  await tx`INSERT INTO task_associations (tenant_id, task_id, record_id) VALUES (${tenantId}, ${taskId}, ${recordId})`;
}

/** The records a task is about. */
export async function taskRecords(tx: Tx, taskId: string): Promise<{ record_id: string }[]> {
  return tx<{ record_id: string }[]>`SELECT record_id FROM task_associations WHERE task_id = ${taskId}`;
}

/** The "Task completed" activity a task's completion writes. */
export async function insertTaskCompletedActivity(tx: Tx, a: { tenantId: string; id: string; actorType: string; actorUserId: string | null;
  createdBy: string | null }): Promise<void> {
  await tx`INSERT INTO activities (tenant_id, id, type_key, actor_type, actor_user_id, subject, source, created_by, updated_by)
             VALUES (${a.tenantId}, ${a.id}, 'task_completed', ${a.actorType}, ${a.actorUserId},
                     'Task completed', 'task', ${a.createdBy}, ${a.createdBy})`;
}

// --- Contacts' accounts and lifecycle ---------------------------------------------------------------

/** True when the contact has a current (live, not ended) link to the account. */
export async function hasCurrentAccountLink(tx: Tx, accountId: string, contactId: string): Promise<boolean> {
  const existing = await tx`SELECT 1 FROM account_contacts
    WHERE account_id = ${accountId} AND contact_id = ${contactId} AND archived_at IS NULL AND end_date IS NULL`;
  return existing.length > 0;
}

/** Makes none of a contact's account links primary. */
export async function clearPrimaryAccountLink(tx: Tx, contactId: string): Promise<void> {
  await tx`UPDATE account_contacts SET is_primary = false WHERE contact_id = ${contactId} AND is_primary`;
}

export async function insertPrimaryAccountLink(tx: Tx, l: { tenantId: string; id: string; accountId: string; contactId: string; actorId: string | null }): Promise<void> {
  await tx`INSERT INTO account_contacts (tenant_id, id, account_id, contact_id, is_primary, created_by, updated_by)
           VALUES (${l.tenantId}, ${l.id}, ${l.accountId}, ${l.contactId}, true, ${l.actorId}, ${l.actorId})`;
}

export async function contactLifecycle(tx: Tx, contactId: string): Promise<{ lifecycle_category: string; lifecycle_stage_overridden: boolean } | undefined> {
  const [c] = await tx<{ lifecycle_category: string; lifecycle_stage_overridden: boolean }[]>`
    SELECT lifecycle_category, lifecycle_stage_overridden FROM contacts WHERE id = ${contactId}`;
  return c;
}

/** Sets a contact's lifecycle stage (and its category, the same value) as a change by `actorId`. */
export async function setContactLifecycle(tx: Tx, contactId: string, to: string, actorId: string | null): Promise<void> {
  await tx`UPDATE contacts SET lifecycle_stage = ${to}, lifecycle_category = ${to}, version = version + 1, updated_by = ${actorId}
           WHERE id = ${contactId}`;
}
