import type { Tx } from "../db/pool.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import { decodeId, uuidv7 } from "../lib/ids.js";
import { canObject, canReadField } from "./access.js";
import { audit } from "./audit.js";
import { actorUserId, type Ctx } from "./context.js";
import {
  activityType, activityTypeEditable, activityTypeKeys, advanceDealsLastActivity, clearPrimaryAccountLink, contactLifecycle, contactPrimaryAccount,
  defaultPipelineId, firstStage, hasCurrentAccountLink, insertActivityAssociation, insertActivityAssociationNow, insertFirstStageHistory,
  insertPrimaryAccountLink, insertTaskAssociation, insertTaskCompletedActivity, recordExists, setContactLifecycle, stageNamed, stageNames,
  stageOfPipeline, taskRecords,
} from "./queries/standard.js";
import { quoteBeforeCreate, quoteBeforeUpdate, quoteLineBeforeArchive, quoteLineBeforeCreate, quoteLineBeforeUpdate, quoteLineChanged, refuseOrderWrite } from "./commerce-hooks.js";
import { getObject, type ObjectMeta, type Schema } from "./schema.js";

/** A record being created or updated, shared between the record engine and these hooks. */
export interface Draft {
  id: string;
  obj: ObjectMeta;
  schema: Schema;
  input: Record<string, unknown>;
  prepared: {
    columns: Map<string, unknown>;
    values: Record<string, unknown>;
  };
  /** Extra typed columns set by hooks (status categories, derived values). */
  extra: Map<string, unknown>;
  current?: Record<string, unknown> & { id: string };
  related?: string[];
}

const LIFECYCLE_ORDER = ["subscriber", "lead", "opportunity", "customer"];

/** Normalizes a domain: lowercase, no scheme, no "www.", no path. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]!;
}

/** The records an activity or task is about. Each must be on an object the caller can read, like any relation. */
async function resolveRelated(tx: Tx, ctx: Ctx, schema: Schema, raw: unknown): Promise<string[]> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) throw unprocessable("related_to must be an array of record IDs");
  if (raw.length > 50) throw unprocessable("related_to can list at most 50 records");
  const ids: string[] = [];
  for (const pid of raw as string[]) {
    const d = decodeId(pid);
    const obj = d ? schema.byPrefix.get(d.prefix) : undefined;
    if (!d || !obj) throw unprocessable(`related_to: "${pid}" is not a record ID`);
    if (!canObject(ctx, obj, "read")) throw forbidden(`related_to: this key can't read ${obj.api_name} records, so it can't relate to them`);
    if (!(await recordExists(tx, d.uuid, obj.id))) throw unprocessable(`related_to: ${pid} was not found`);
    ids.push(d.uuid);
  }
  return [...new Set(ids)];
}

export async function beforeCreate(tx: Tx, ctx: Ctx, d: Draft): Promise<void> {
  const cols = d.prepared.columns;
  if (d.obj.is_system && d.obj.owned && !cols.has("owner_id")) cols.set("owner_id", actorUserId(ctx));

  switch (d.obj.api_name) {
    case "account": {
      const domain = cols.get("primary_domain");
      if (typeof domain === "string") {
        cols.set("primary_domain", normalizeDomain(domain));
        d.extra.set("domains", [normalizeDomain(domain)]);
      }
      break;
    }
    case "contact":
      if (cols.has("lifecycle_stage")) d.extra.set("lifecycle_stage_overridden", true);
      break;
    case "lead":
      // The lead takes its contact's account, but only for a caller who can read contact.account:
      // otherwise lead.account would show them a value hidden on the contact.
      if (!cols.has("account_id") && cols.get("contact_id") && canReadField(ctx, getObject(d.schema, "contact"), "account")) {
        const c = await contactPrimaryAccount(tx, cols.get("contact_id") as string);
        if (c?.primary_account_id) cols.set("account_id", c.primary_account_id);
      }
      break;
    case "deal":
      await prepareDealStage(tx, d);
      break;
    case "quote":
      await quoteBeforeCreate(tx, ctx, d);
      break;
    case "quote_line_item":
      await quoteLineBeforeCreate(tx, ctx, d);
      break;
    case "order":
    case "order_line_item":
      refuseOrderWrite(d.obj.api_name);
      break;
    case "task": {
      if (!cols.get("assignee_user_id")) {
        const uid = actorUserId(ctx);
        if (!uid) throw unprocessable("assignee is required when the caller is not a user");
        cols.set("assignee_user_id", uid);
      }
      if (cols.get("status") === "done") d.extra.set("completed_at", new Date().toISOString());
      d.related = await resolveRelated(tx, ctx, d.schema, d.input.related_to);
      break;
    }
    case "activity": {
      const type = cols.get("type_key");
      const t = await activityType(tx, type as string);
      if (!t) {
        const types = await activityTypeKeys(tx);
        throw unprocessable(`Unknown activity type "${String(type)}". Use one of: ${types.map((x) => x.key).join(", ")}`);
      }
      if (cols.get("actor_contact_id")) d.extra.set("actor_type", "contact");
      else if (actorUserId(ctx)) {
        d.extra.set("actor_type", "user");
        d.extra.set("actor_user_id", actorUserId(ctx));
      } else d.extra.set("actor_type", ctx.surface === "automation" ? "system" : "integration");
      if (!cols.has("occurred_at")) cols.set("occurred_at", new Date().toISOString());
      d.related = await resolveRelated(tx, ctx, d.schema, d.input.related_to);
      break;
    }
  }
}

async function prepareDealStage(tx: Tx, d: Draft): Promise<void> {
  const cols = d.prepared.columns;
  let pipelineId = cols.get("pipeline_id") as string | undefined;
  if (!pipelineId) {
    const p = await defaultPipelineId(tx);
    if (!p) throw unprocessable("This workspace has no default pipeline; pass pipeline");
    pipelineId = p.id;
    cols.set("pipeline_id", pipelineId);
  }
  const stageInput = d.prepared.values.stage;
  let stage: { id: string; category: string; default_probability: string | null } | undefined;
  if (typeof stageInput === "string" && !decodeId(stageInput)) {
    stage = await stageNamed(tx, pipelineId, stageInput);
    if (!stage) {
      const names = await stageNames(tx, pipelineId);
      throw unprocessable(`Stage "${stageInput}" is not in this pipeline. Stages: ${names.map((n) => n.name).join(", ")}`);
    }
  } else if (cols.get("stage_id")) {
    stage = await stageOfPipeline(tx, cols.get("stage_id") as string, pipelineId);
    if (!stage) throw unprocessable("stage does not belong to the deal's pipeline");
  } else {
    stage = await firstStage(tx, pipelineId);
    if (!stage) throw unprocessable("The pipeline has no stages");
  }
  cols.set("stage_id", stage.id);
  d.extra.set("status_category", stage.category);
  d.extra.set("currency", d.schema.currency);
  if (!cols.has("probability") && stage.default_probability !== null) cols.set("probability", Number(stage.default_probability));
}

export async function afterCreate(tx: Tx, ctx: Ctx, d: Draft): Promise<void> {
  const cols = d.prepared.columns;
  switch (d.obj.api_name) {
    case "activity": {
      const occurred = cols.get("occurred_at") as string;
      const related = new Set(d.related ?? []);
      const actorContact = cols.get("actor_contact_id") as string | undefined;
      if (actorContact) related.add(actorContact);
      for (const rid of related) {
        await insertActivityAssociation(tx, { tenantId: ctx.tenantId, activityId: d.id, recordId: rid, occurredAt: occurred });
      }
      // Bookkeeping: the activity's own time, which the caller just wrote; no value is copied from another record.
      if (related.size) {
        await advanceDealsLastActivity(tx, [...related], occurred);
      }
      break;
    }
    case "task":
      for (const rid of d.related ?? []) {
        await insertTaskAssociation(tx, ctx.tenantId, d.id, rid);
      }
      break;
    case "deal":
      await insertFirstStageHistory(tx, { tenantId: ctx.tenantId, id: uuidv7(), dealId: d.id, stageId: cols.get("stage_id") as string, changedBy: ctx.actor.id });
      await bumpLifecycle(tx, ctx, cols.get("primary_contact_id") as string, d.extra.get("status_category") === "won" ? "customer" : "opportunity");
      break;
    case "contact": // Bookkeeping: links the account the caller just set on the contact.
      if (cols.get("primary_account_id")) await ensureAccountContact(tx, ctx, cols.get("primary_account_id") as string, d.id);
      break;
    case "lead":
      await bumpLifecycle(tx, ctx, cols.get("contact_id") as string, "lead");
      break;
    case "quote_line_item":
      await quoteLineChanged(tx, ctx, cols.get("quote_id") as string);
      break;
  }
}

export async function beforeUpdate(_tx: Tx, _ctx: Ctx, d: Draft): Promise<void> {
  const cols = d.prepared.columns;
  switch (d.obj.api_name) {
    case "quote":
      quoteBeforeUpdate(d);
      break;
    case "quote_line_item":
      await quoteLineBeforeUpdate(_tx, _ctx, d);
      break;
    case "order_line_item":
      refuseOrderWrite(d.obj.api_name);
      break;
    case "account": {
      const domain = cols.get("primary_domain");
      if (typeof domain === "string") {
        cols.set("primary_domain", normalizeDomain(domain));
        d.extra.set("domains", [normalizeDomain(domain)]);
      }
      break;
    }
    case "contact":
      if (cols.has("lifecycle_stage")) d.extra.set("lifecycle_stage_overridden", true);
      break;
    case "activity":
      if (Object.keys(d.prepared.values).length && !(await isEditableActivity(_tx, d.current!.type_key as string))) {
        throw forbidden(`Activities of type "${String(d.current!.type_key)}" are history and cannot be edited`);
      }
      break;
    case "task":
      if (cols.has("status")) {
        const done = cols.get("status") === "done";
        d.extra.set("completed_at", done ? new Date().toISOString() : null);
      }
      if (d.input.related_to !== undefined) throw unprocessable("related_to can only be set when the task is created");
      break;
  }
}

async function isEditableActivity(tx: Tx, typeKey: string): Promise<boolean> {
  const t = await activityTypeEditable(tx, typeKey);
  return Boolean(t?.editable);
}

export async function afterUpdate(tx: Tx, ctx: Ctx, d: Draft): Promise<void> {
  const cols = d.prepared.columns;
  if (d.obj.api_name === "task" && cols.get("status") === "done" && d.current!.status !== "done") {
    // A generic subject, linked to the task itself and the records it is about: readers see the task's
    // title through the link only if their role can read it (the subject used to copy it).
    const related = await taskRecords(tx, d.id);
    const activityId = uuidv7();
    const actorUser = actorUserId(ctx);
    await insertTaskCompletedActivity(tx, { tenantId: ctx.tenantId, id: activityId, actorType: actorUser ? "user" : "system", actorUserId: actorUser,
      createdBy: ctx.actor.id });
    for (const r of [{ record_id: d.id }, ...related]) {
      await insertActivityAssociationNow(tx, { tenantId: ctx.tenantId, activityId, recordId: r.record_id });
    }
  }
  if (d.obj.api_name === "contact" && cols.get("primary_account_id")) {
    await ensureAccountContact(tx, ctx, cols.get("primary_account_id") as string, d.id);
  }
  if (d.obj.api_name === "quote_line_item") await quoteLineChanged(tx, ctx, d.current!.quote_id as string);
}

/** Before a record is archived or restored: what the object's rules refuse. `row` is the record as stored. */
export async function beforeArchive(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, row: Record<string, unknown>): Promise<void> {
  if (obj.api_name === "quote_line_item") await quoteLineBeforeArchive(tx, ctx, schema, row);
  if (obj.api_name === "order_line_item") refuseOrderWrite(obj.api_name);
}

/** After a record was archived or restored: what follows from it. */
export async function afterArchive(tx: Tx, ctx: Ctx, obj: ObjectMeta, row: Record<string, unknown>): Promise<void> {
  if (obj.api_name === "quote_line_item") await quoteLineChanged(tx, ctx, row.quote_id as string);
}

async function ensureAccountContact(tx: Tx, ctx: Ctx, accountId: string, contactId: string): Promise<void> {
  if (await hasCurrentAccountLink(tx, accountId, contactId)) return;
  await clearPrimaryAccountLink(tx, contactId);
  await insertPrimaryAccountLink(tx, { tenantId: ctx.tenantId, id: uuidv7(), accountId, contactId, actorId: ctx.actor.id });
}

/**
 * Moves a contact's lifecycle stage forward (never backward), unless it was set by hand. Bookkeeping:
 * the new stage follows from the caller's own change (a lead or deal); no value is copied between records.
 */
export async function bumpLifecycle(tx: Tx, ctx: Ctx, contactId: string, to: "lead" | "opportunity" | "customer"): Promise<void> {
  const c = await contactLifecycle(tx, contactId);
  if (!c || c.lifecycle_stage_overridden) return;
  if (LIFECYCLE_ORDER.indexOf(c.lifecycle_category) >= LIFECYCLE_ORDER.indexOf(to)) return;
  await setContactLifecycle(tx, contactId, to, ctx.actor.id);
  await audit(tx, ctx, { action: "contact.lifecycle_changed", objectType: "contact", recordId: contactId, details: { from: c.lifecycle_category, to } });
}
