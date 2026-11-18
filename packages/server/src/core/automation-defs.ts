import { z } from "zod";
import type { Tx } from "../db/pool.js";
import { unprocessable } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { TEXT_MAX } from "../lib/limits.js";
import { permissionsForScopes, type Ctx } from "./context.js";
import { compileQuery, type Where } from "./query.js";
import { ScheduleFields, type Schedule } from "./schedule.js";
import { getObject, type ObjectMeta, type Schema } from "./schema.js";

/**
 * What an automation is: a trigger, an optional condition, and steps. Shared by validation, the API
 * and the runner. Only this validated structure is stored; nothing in it is ever evaluated as code.
 */

export const MAX_DEPTH = 5;
/** Limits on one automation's definition and on one run. */
export const LIMITS = {
  topSteps: 20, innerSteps: 10, totalSteps: 40,
  findMax: 200, findDefault: 25, forEachMax: 200, forEachDefault: 50,
  /** Steps executed in one run, counting each for_each iteration's steps. */
  stepExecutions: 1000,
  /** Wall time for a run: inline (inside event processing), and queued (leased by the worker). */
  inlineMs: 10_000, queuedMs: 60_000, simulateMs: 20_000,
  httpPerRun: 20, emailsPerRun: 50, manualRecords: 25, queuedManual: 25,
  /** Outputs kept between steps (only those a later step uses), serialized. */
  varsBytes: 256 * 1024,
  /** A run of one automation for one record more often than this in 10 minutes is a loop. */
  sameRecordPer10Min: 5,
  /** Failed runs in a row before an automation pauses itself. */
  autoPauseAfter: 5,
} as const;

const StepId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "use lowercase letters, digits and _ (start with a letter, at most 40)");
const TemplateValues = z.record(z.string(), z.unknown());
const Sort = z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() }).strict()).max(3);
const Query = z.object({
  object: z.string(), where: z.unknown().optional(), sort: Sort.optional(),
  limit: z.number().int().min(1).max(LIMITS.forEachMax).optional(),
}).strict();
const Base = { id: StepId.optional(), if: z.unknown().optional() };
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

const SendWebhook = z.object({ ...Base, type: z.literal("send_webhook"), webhook: z.string() }).strict();
const UpdateRecord = z.object({ ...Base, type: z.literal("update_record"), values: TemplateValues,
  record: z.string().max(300).optional().describe("Record ID (or a placeholder for one); default: the current record"),
  object: z.string().optional().describe("With record: the object of the record it names (its values are checked against it, and a record of another object is refused)") }).strict();
const CreateRecord = z.object({ ...Base, type: z.literal("create_record"), object: z.string(), values: TemplateValues }).strict();
const Notify = z.object({
  ...Base, type: z.literal("notify"), title: z.string().min(1).max(300), body: z.string().max(4000).optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  recipients: z.object({ record_owner: z.boolean().optional(), users: z.array(z.string()).max(50).optional() }).strict(),
}).strict();
const FindRecords = z.object({
  ...Base, type: z.literal("find_records"), object: z.string(), where: z.unknown().optional(), sort: Sort.optional(),
  limit: z.number().int().min(1).max(LIMITS.findMax).optional(),
}).strict();
const UpsertRecord = z.object({ ...Base, type: z.literal("upsert_record"), object: z.string(), key: z.string(), values: TemplateValues }).strict();
const HttpRequest = z.object({
  ...Base, type: z.literal("http_request"), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), url: z.string().min(1).max(2000),
  headers: z.record(z.string(), z.string().max(2000)).optional(),
  /** Write-only: values are encrypted with the workspace key and returned as null; null on update keeps the stored value. */
  secret_headers: z.record(z.string(), z.string().max(4000).nullable()).optional(),
  body: z.unknown().optional(),
}).strict();
const SendEmail = z.object({
  ...Base, type: z.literal("send_email"),
  to: z.object({
    member: z.string().optional().describe("usr_… ID or a member's email"),
    record_owner: z.literal(true).optional(),
    field: z.string().optional().describe("An email field of the current record, e.g. email"),
    address: z.string().max(254).optional().describe("A fixed address"),
  }).strict(),
  subject: z.string().min(1).max(200), body: z.string().min(1).max(10_000),
}).strict();
const Stop = z.object({ ...Base, type: z.literal("stop"), reason: z.string().max(200).optional() }).strict();

const Inner = z.discriminatedUnion("type", [SendWebhook, UpdateRecord, CreateRecord, Notify, FindRecords, UpsertRecord, HttpRequest, SendEmail, Stop]);
const ForEach = z.object({
  ...Base, type: z.literal("for_each"),
  over: StepId.optional().describe("id of an earlier find_records step"),
  query: Query.optional().describe("Or a query to iterate over directly"),
  steps: z.array(Inner).min(1).max(LIMITS.innerSteps),
}).strict();
export const StepSchema = z.discriminatedUnion("type", [SendWebhook, UpdateRecord, CreateRecord, Notify, FindRecords, UpsertRecord, HttpRequest, SendEmail, Stop, ForEach]);
/** Kept for callers of the phase-1 name. */
export const ActionSchema = StepSchema;
export type Step = z.infer<typeof StepSchema>;
export type InnerStep = z.infer<typeof Inner>;
export type Action = Step;

const EventTrigger = z.object({
  type: z.literal("event"),
  event: z.string().describe("e.g. deal.created, contact.updated, deal.stage_changed, lead.converted, <object>.archived, <object>.restored, <object>.merged"),
  changed_fields: z.array(z.string()).max(50).optional().describe("For *.updated: run only when one of these fields changed"),
  include_reference_moves: z.boolean().optional().describe("For *.updated (and *.archived): also run when a merge moved a reference on the record, or archived it as a second copy (off by default)"),
}).strict();
const ScheduleTrigger = z.object({ type: z.literal("schedule"), ...ScheduleFields }).strict();
const ManualTrigger = z.object({ type: z.literal("manual"), object: z.string().optional().describe("The object whose records it is run on; leave out to run without a record") }).strict();
export const TriggerSchema = z.preprocess(
  (v) => (v && typeof v === "object" && !Array.isArray(v) && !("type" in v) ? { ...v, type: "event" } : v),
  z.discriminatedUnion("type", [EventTrigger, ScheduleTrigger, ManualTrigger]),
);
export type Trigger = z.infer<typeof TriggerSchema>;
export type EventTriggerT = z.infer<typeof EventTrigger>;

export const AutomationInput = z.object({
  name: z.string().min(1).max(TEXT_MAX.name),
  description: z.string().max(TEXT_MAX.description).optional(),
  enabled: z.boolean().optional(),
  trigger: TriggerSchema,
  condition: z.unknown().optional(),
  actions: z.array(StepSchema).min(1).max(LIMITS.topSteps),
  hourly_cap: z.number().int().min(1).max(10000).optional(),
  run_roles: z.array(z.string().max(60)).max(20).optional().describe("Role keys whose members may run it on request (POST /v1/automations/{id}/run) without automations:manage"),
}).strict();
export type AutomationInputT = z.infer<typeof AutomationInput>;

/** A stored automation. Triggers saved before step 5 have no `type`; normalize with triggerOf. */
export interface AutomationRow {
  id: string; name: string; description: string | null; enabled: boolean; trigger: Trigger | Omit<EventTriggerT, "type">; condition: Where | null;
  actions: Step[]; hourly_cap: number; version: number; created_at: Date; updated_at: Date; archived_at: Date | null;
  paused_at: Date | null; paused_reason: string | null; consecutive_failures: number; run_roles: string[]; next_run_at: Date | null; secrets: string | null;
}

export const triggerOf = (t: AutomationRow["trigger"]): Trigger => ("type" in t ? t : { ...t, type: "event" }) as Trigger;

// ----------------------------------------------------------------------------------------------
// Triggers

const OP_EVENTS = new Set(["deal.stage_changed", "lead.converted"]);
/**
 * Record events automations may react to beyond created/updated/archived: a restore brings a record
 * back, and a merge names the survivor. Deliberately not triggers: alert.fired (an alert would run an
 * automation, which could fire an alert again), schema.* (configuration, not records), webhook.test
 * and automation.* (the engine's own events). A merge's moved references reach *.updated only with
 * include_reference_moves, since one merge can touch hundreds of records.
 */
const AUTOMATION_ONLY = new Set(["restored", "merged"]);

export function triggerObject(schema: Schema, event: string, opts: { automation?: boolean } = {}): ObjectMeta {
  const m = /^([a-z][a-z0-9_]*)\.([a-z_]+)$/.exec(event);
  if (!m) throw unprocessable(`Trigger event "${event}" must look like <object>.<created|updated|archived>, deal.stage_changed or lead.converted`);
  const [, object, action] = m as unknown as [string, string, string];
  const extra = opts.automation && AUTOMATION_ONLY.has(action);
  if (!["created", "updated", "archived"].includes(action) && !OP_EVENTS.has(event) && !extra) {
    throw unprocessable(`Unknown trigger event "${event}". Use <object>.created, <object>.updated, <object>.archived${opts.automation ? ", <object>.restored, <object>.merged" : ""}, deal.stage_changed or lead.converted`);
  }
  return getObject(schema, object);
}

/** The object whose record a run starts with: the event's, or a manual trigger's. Null for schedules and record-less manual triggers. */
export function recordObject(schema: Schema, t: Trigger): ObjectMeta | null {
  if (t.type === "event") return triggerObject(schema, t.event, { automation: true });
  if (t.type === "manual" && t.object) return getObject(schema, t.object);
  return null;
}

/** Every step, with for_each bodies, in order. */
export function allSteps(steps: Step[]): Step[] {
  return steps.flatMap((s) => (s.type === "for_each" ? [s, ...s.steps] : [s]));
}

/**
 * Steps that run inside event processing: plain record writes, notifications and webhooks, no queries.
 * Anything that queries (find_records, upsert_record, for_each), calls out or emails is queued for the
 * worker, which shares itself fairly between workspaces; event processing is shared by every automation,
 * alert and webhook of the workspace, and a slow query there would hold them all up.
 */
const INLINE = new Set<Step["type"]>(["update_record", "create_record", "notify", "send_webhook", "stop"]);
export const needsQueue = (steps: Step[]) => allSteps(steps).some((s) => !INLINE.has(s.type));
export const sendsOut = (steps: Step[]) => allSteps(steps).some((s) => s.type === "http_request" || s.type === "send_email");

/** The context steps run under: ops scopes only (no admin, no restricted values). */
export function automationCtx(tenantId: string, automationId: string, depth: number, requestId: string): Ctx {
  return {
    tenantId, actor: { type: "automation", id: automationId, role: "member" }, keyId: null,
    permissions: permissionsForScopes(["ops:read", "ops:write"]),
    scopes: new Set(["ops:read", "ops:write"]), surface: "automation", requestId, causationDepth: depth, automationId,
  };
}

/** Does the record match the condition? Uses the query compiler, so semantics equal query_records. */
export async function conditionMatches(tx: Tx, schema: Schema, obj: ObjectMeta, recordId: string, condition: Where | null): Promise<boolean> {
  if (!condition) return true;
  const idCond: Where = { field: "id", op: "eq", value: encodeId(obj.id_prefix, recordId) };
  const q = compileQuery(schema, { object: obj.api_name, where: { and: [condition, idCond] }, include_archived: true, limit: 1 });
  const rows = await tx.unsafe(q.text, q.params as never[]);
  return rows.length > 0;
}

export type { Schedule };
export const isHeaderName = (s: string) => HEADER_NAME.test(s);
