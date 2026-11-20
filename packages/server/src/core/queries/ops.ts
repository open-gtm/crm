import type { Tx } from "../../db/pool.js";
import { quoteIdent } from "../schema.js";

/**
 * The SQL of the lifecycle operations (core/ops.ts, ADR 0012): capturing interest, converting leads,
 * moving deals between stages, assigning owners, timelines and the caller's open tasks. The operations
 * keep their checks, errors, audits, events and the order of statements in their transaction. Table
 * names come from metadata (objects.table_name) and are quoted here.
 *
 * Search's statements stay in core/ops.ts: they splice the per-object limit into the text, which the
 * Semgrep rule on unsafe() refuses once the limit is a function parameter, and the search over visible
 * fields is built from the query compiler's column expressions.
 */

// --- capture_interest -------------------------------------------------------------------------------

/** The live contact with this primary email, if any. */
export async function liveContactByEmail(tx: Tx, email: string): Promise<{ id: string; primary_account_id: string | null } | undefined> {
  const [c] = await tx<{ id: string; primary_account_id: string | null }[]>`
    SELECT id, primary_account_id FROM contacts WHERE primary_email = ${email} AND archived_at IS NULL`;
  return c;
}

/** The live account with this primary domain, if any. */
export async function liveAccountByDomain(tx: Tx, domain: string): Promise<{ id: string } | undefined> {
  const [a] = await tx<{ id: string }[]>`SELECT id FROM accounts WHERE primary_domain = ${domain} AND archived_at IS NULL`;
  return a;
}

/** Stores the submitted form fields on a form_submitted activity. */
export async function setFormSubmission(tx: Tx, activityId: string, fields: Record<string, unknown>): Promise<void> {
  await tx`UPDATE activities SET payload = ${tx.json({ fields } as never)} WHERE id = ${activityId}`;
}

// --- convert_lead -----------------------------------------------------------------------------------

export interface LeadToConvert { id: string; contact_id: string; account_id: string | null; status_category: string }

/** The lead to convert, locked. */
export async function leadForConversion(tx: Tx, leadId: string): Promise<LeadToConvert | undefined> {
  const [lead] = await tx<LeadToConvert[]>`
    SELECT id, contact_id, account_id, status_category FROM leads WHERE id = ${leadId} FOR UPDATE`;
  return lead;
}

/** Records which lead a deal came from. */
export async function setDealSourceLead(tx: Tx, dealId: string, leadId: string): Promise<void> {
  await tx`UPDATE deals SET source_lead_id = ${leadId} WHERE id = ${dealId}`;
}

/** Marks a lead converted into a deal, with the status key of its converted category. */
export async function markLeadConverted(tx: Tx, leadId: string, statusKey: string, dealId: string, actorId: string | null): Promise<void> {
  await tx`UPDATE leads SET status = ${statusKey}, status_category = 'converted', converted_deal_id = ${dealId},
           converted_at = now(), version = version + 1, updated_by = ${actorId} WHERE id = ${leadId}`;
}

/** Logs the lead_converted history activity. `actorType` is "user" or "system"; `actorUserId` the member, for a user. */
export async function insertLeadConvertedActivity(tx: Tx, a: { tenantId: string; id: string; actorType: "user" | "system"; actorUserId: string | null; actorId: string | null }): Promise<void> {
  await tx`INSERT INTO activities (tenant_id, id, type_key, actor_type, actor_user_id, subject, source, created_by, updated_by)
           VALUES (${a.tenantId}, ${a.id}, 'lead_converted', ${a.actorType},
                   ${a.actorUserId}, 'Lead converted to a deal', 'crm', ${a.actorId}, ${a.actorId})`;
}

/** Links an activity to a record it is about, as of now. */
export async function associateActivity(tx: Tx, tenantId: string, activityId: string, recordId: string): Promise<void> {
  await tx`INSERT INTO activity_associations (tenant_id, activity_id, record_id, occurred_at) VALUES (${tenantId}, ${activityId}, ${recordId}, now())`;
}

// --- move_deal_stage --------------------------------------------------------------------------------

export interface DealToMove { pipeline_id: string; stage_id: string; stage_entered_at: Date; primary_contact_id: string; status_category: string }
export interface StageRow { id: string; name: string; category: string; default_probability: string | null }

/** The deal to move, locked. */
export async function dealForStageMove(tx: Tx, dealId: string): Promise<DealToMove | undefined> {
  const [deal] = await tx<DealToMove[]>`
    SELECT pipeline_id, stage_id, stage_entered_at, primary_contact_id, status_category FROM deals WHERE id = ${dealId} FOR UPDATE`;
  return deal;
}

/** A live stage of a pipeline, by ID. */
export async function liveStageById(tx: Tx, stageId: string, pipelineId: string): Promise<StageRow | undefined> {
  const [stage] = await tx<StageRow[]>`
        SELECT id, name, category, default_probability FROM stages WHERE id = ${stageId} AND pipeline_id = ${pipelineId} AND archived_at IS NULL`;
  return stage;
}

/** A live stage of a pipeline, by name, ignoring case. */
export async function liveStageByName(tx: Tx, name: string, pipelineId: string): Promise<StageRow | undefined> {
  const [stage] = await tx<StageRow[]>`
        SELECT id, name, category, default_probability FROM stages WHERE lower(name) = lower(${name}) AND pipeline_id = ${pipelineId} AND archived_at IS NULL`;
  return stage;
}

/** The names of a pipeline's live stages, in order. */
export async function liveStageNames(tx: Tx, pipelineId: string): Promise<{ name: string }[]> {
  return tx<{ name: string }[]>`SELECT name FROM stages WHERE pipeline_id = ${pipelineId} AND archived_at IS NULL ORDER BY position`;
}

/**
 * Moves a deal to a stage, with the stage's category and probability. lost_reason is set (to
 * `lostReason`) only when `setLostReason`, and left alone otherwise.
 */
export async function moveDealToStage(tx: Tx, m: { dealId: string; stageId: string; category: string; probability: string | null;
  setLostReason: boolean; lostReason: string | null; actorId: string | null }): Promise<void> {
  const lostReason = m.setLostReason ? tx`lost_reason = ${m.lostReason},` : tx``;
  await tx`UPDATE deals SET stage_id = ${m.stageId}, status_category = ${m.category}, stage_entered_at = now(),
             probability = ${m.probability}, ${lostReason}
             version = version + 1, updated_by = ${m.actorId}
           WHERE id = ${m.dealId}`;
}

/** Records a stage change, with the time the deal spent in the stage it left (since `enteredAt`). */
export async function insertStageHistory(tx: Tx, h: { tenantId: string; id: string; dealId: string; fromStageId: string; toStageId: string;
  changedBy: string | null; enteredAt: Date }): Promise<void> {
  await tx`INSERT INTO deal_stage_history (tenant_id, id, deal_id, from_stage_id, to_stage_id, changed_by, time_in_from_stage)
           VALUES (${h.tenantId}, ${h.id}, ${h.dealId}, ${h.fromStageId}, ${h.toStageId}, ${h.changedBy}, now() - ${h.enteredAt}::timestamptz)`;
}

// --- assign_owner -----------------------------------------------------------------------------------

/** An active member by ID. */
export async function activeMemberById(tx: Tx, userId: string): Promise<{ id: string; name: string } | undefined> {
  const [u] = await tx<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE id = ${userId} AND disabled_at IS NULL`;
  return u;
}

/** An active member by email. */
export async function activeMemberByEmail(tx: Tx, email: string): Promise<{ id: string; name: string } | undefined> {
  const [u] = await tx<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE email = ${email} AND disabled_at IS NULL`;
  return u;
}

/** Sets a record's owner and bumps its version. */
export async function setRecordOwner(tx: Tx, table: string, ownerId: string, actorId: string | null, recordId: string): Promise<void> {
  await tx.unsafe(`UPDATE ${quoteIdent(table)} SET owner_id = $1, version = version + 1, updated_by = $2 WHERE id = $3`,
    [ownerId, actorId, recordId]);
}

// --- Timeline ---------------------------------------------------------------------------------------

/** A record's live activities, newest first. */
export async function activitiesAbout(tx: Tx, recordId: string, limit: number): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT a.* FROM activity_associations aa JOIN activities a ON a.tenant_id = aa.tenant_id AND a.id = aa.activity_id
    WHERE aa.record_id = ${recordId} AND a.archived_at IS NULL ORDER BY aa.occurred_at DESC LIMIT ${limit}`;
}

/** A record's live tasks, newest first. */
export async function tasksAbout(tx: Tx, recordId: string, limit: number): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT t.* FROM task_associations ta JOIN tasks t ON t.tenant_id = ta.tenant_id AND t.id = ta.task_id
    WHERE ta.record_id = ${recordId} AND t.archived_at IS NULL ORDER BY t.created_at DESC LIMIT ${limit}`;
}

export interface StageChangeRow { changed_at: Date; from_name: string | null; to_name: string; category: string }

/** A deal's stage changes, newest first. */
export async function stageChangesOf(tx: Tx, dealId: string, limit: number): Promise<StageChangeRow[]> {
  return tx<StageChangeRow[]>`
      SELECT h.changed_at, fs.name AS from_name, ts.name AS to_name, ts.category
      FROM deal_stage_history h JOIN stages ts ON ts.tenant_id = h.tenant_id AND ts.id = h.to_stage_id
      LEFT JOIN stages fs ON fs.tenant_id = h.tenant_id AND fs.id = h.from_stage_id
      WHERE h.deal_id = ${dealId} ORDER BY h.changed_at DESC LIMIT ${limit}`;
}


// --- My open tasks ----------------------------------------------------------------------------------

/**
 * A member's live tasks, at most 100: only open and in-progress ones when `openOnly`, soonest due
 * first when `byDue`, otherwise newest first.
 */
export async function tasksAssignedTo(tx: Tx, userId: string | null, openOnly: boolean, byDue: boolean): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT * FROM tasks WHERE assignee_user_id = ${userId} AND archived_at IS NULL
      ${openOnly ? tx`AND status_category IN ('open', 'in_progress')` : tx``}
    ORDER BY ${byDue ? tx`due_at NULLS LAST, created_at` : tx`created_at DESC`} LIMIT 100`;
}
