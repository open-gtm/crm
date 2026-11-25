import { z } from "zod";
import type { Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { ApiError, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { TEXT_MAX } from "../lib/limits.js";
import { logger } from "../lib/logger.js";
import { accessGuard, assertObject, canObject, canReadField } from "./access.js";
import { audit } from "./audit.js";
import { conditionMatches, triggerObject } from "./automations.js";
import { systemCtx, without, type Ctx } from "./context.js";
import { emit } from "./events.js";
import { notifyUser, receivers, requireUser, resolveUsers } from "./notifications.js";
import {
  activityLinks, advanceBackfill, archiveRuleRow, compiledRecordIds, computedDeadlines, countLiveRules, dropDeadline, dropDeadlines, dropRuleDeadlines,
  dueDeadlines, enabledInactiveRulesOn, enabledRulesOn, finishBackfill, insertRule, liveRules, moveDeadline, personalRulesOf, ruleById, rulesToBackfill,
  ruleWebhooks, updateRule, upsertDeadline, type RuleRow,
} from "./queries/alerts.js";
import { recordEventsSince } from "./queries/events.js";
import { wakeSnoozed } from "./queries/notifications.js";
import { Compiler, compileQuery, targetFor, type Where } from "./query.js";
import { getRecord, type RecordOut } from "./records.js";
import { getObject, loadSchema, quoteIdent, type ObjectMeta, type Schema } from "./schema.js";
import { loadWebhook, type EventRow } from "./webhooks.js";

/**
 * Alert rules. Event rules fire when a matching change happens. Time rules fire when a deadline
 * computed from the record passes:
 *   - inactive: no update and no logged activity for N days ("deal untouched for 14 days")
 *   - field_passed: a date or date-time field has passed, plus an offset ("task overdue")
 * Deadlines are materialized in rule_deadlines and kept current from the event stream, so the
 * scheduler reads only due rows, never whole tables. Every fire re-checks the rule against the
 * record as it is now.
 */

const Trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: z.string(), changed_fields: z.array(z.string()).max(50).optional() }),
  z.object({ type: z.literal("inactive"), days: z.number().int().min(1).max(365) }),
  z.object({ type: z.literal("field_passed"), field: z.string(), offset_hours: z.number().int().min(-8760).max(8760).optional() }),
]);
export type TriggerT = z.infer<typeof Trigger>;

export const AlertInput = z.object({
  name: z.string().min(1).max(TEXT_MAX.name),
  description: z.string().max(TEXT_MAX.description).optional(),
  object: z.string(),
  trigger: Trigger,
  condition: z.unknown().optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  recipients: z.object({ record_owner: z.boolean().optional(), users: z.array(z.string()).max(50).optional() }).optional(),
  webhooks: z.array(z.string()).max(10).optional(),
  cooldown_hours: z.number().int().min(1).max(8760).nullable().optional(),
  enabled: z.boolean().optional(),
  /** Personal rules: only records I own (or tasks assigned to me). Defaults to true when the object has an owner. */
  mine_only: z.boolean().optional(),
});
export type AlertInputT = z.infer<typeof AlertInput>;

/** The field that names who is responsible for a record: owner, or a task's assignee. */
export function ownerField(obj: ObjectMeta): string | null {
  if (obj.api_name === "task") return "assignee";
  const f = obj.byName.get("owner");
  return f && f.type === "relation" && f.options.to === "user" ? "owner" : null;
}

function publicRule(r: RuleRow) {
  return {
    id: encodeId("alr", r.id), scope: r.scope, owner: r.owner_user_id ? encodeId("usr", r.owner_user_id) : null,
    name: r.name, description: r.description, object: r.object, trigger: r.trigger, condition: r.condition, severity: r.severity,
    recipients: { record_owner: r.recipients.record_owner ?? false, users: (r.recipients.users ?? []).map((u) => encodeId("usr", u)) },
    webhooks: r.webhooks.map((w) => encodeId("whk", w)), cooldown_hours: r.cooldown_hours,
    enabled: r.enabled && !r.archived_at, status: r.archived_at ? "archived" : r.enabled ? "enabled" : "disabled",
    deadlines: r.kind === "time" ? (r.backfilled_at ? "ready" : "building") : null,
    version: r.version, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
  };
}

// ----------------------------------------------------------------------------------------------
// Validation

interface Validated {
  obj: ObjectMeta; kind: "event" | "time"; condition: Where | null; recipients: { record_owner: boolean; users: string[] };
  webhooks: string[]; summary: string; warnings: string[];
}

/** The fields of the trigger's object that firing on an event reveals: the event's own field, and changed_fields. */
export function eventTriggerFields(event: string, changedFields?: string[]): string[] {
  const own = event === "deal.stage_changed" ? ["stage"] : ["lead.converted", "quote.sent", "quote.accepted"].includes(event) ? ["status"] : [];
  return [...own, ...(changedFields ?? [])];
}

/**
 * Why a rule firing for this reader would tell them something their role hides, or null if it can't.
 * A notification that arrives only for matching records reveals what the rule looked at: so the reader
 * must be able to read the object, every field the trigger or condition depends on (by filter or
 * relation path), and for an inactive trigger, activities and when they occurred (the deadline counts
 * from the last one). Used for every recipient of alerts and automation notify actions, when they are
 * saved (a warning, or a refusal for personal alerts) and each time they fire (the recipient is skipped).
 *
 * Trigger kinds: event (the event's field and changed_fields; created, updated and archived name no
 * field), field_passed (the field), inactive (activity read and activity.occurred_at; updated_at is metadata).
 */
export function ruleHiddenFrom(ctx: Ctx, schema: Schema, obj: ObjectMeta, trigger: TriggerT, condition: Where | null): string | null {
  if (!canObject(ctx, obj, "read")) return `can't read ${obj.api_name} records`;
  const fields = trigger.type === "field_passed" ? [trigger.field] : trigger.type === "event" ? eventTriggerFields(trigger.event, trigger.changed_fields) : [];
  const hidden = fields.filter((n) => !canReadField(ctx, obj, n));
  if (hidden.length) return `can't read ${hidden.map((n) => `${obj.api_name}.${n}`).join(", ")}`;
  if (trigger.type === "inactive") {
    const act = schema.objects.get("activity");
    if (act && (!canObject(ctx, act, "read") || !canReadField(ctx, act, "occurred_at"))) return "can't read activities, which an inactive trigger counts from";
  }
  if (condition) {
    try {
      compileQuery(schema, { object: obj.api_name, where: condition, limit: 1 }, accessGuard(ctx, schema));
    } catch (e) {
      if (e instanceof ApiError) return `can't use the condition: ${e.message}`;
      throw e;
    }
  }
  return null;
}

/** A personal alert notifies its owner only about what the owner's role can read (see ruleHiddenFrom). Checked on save; fire re-checks. */
function assertPersonalRuleVisible(ctx: Ctx, schema: Schema, obj: ObjectMeta, trigger: TriggerT, condition: Where | null): void {
  assertObject(ctx, obj, "read");
  const why = ruleHiddenFrom(ctx, schema, obj, trigger, condition);
  if (why) throw forbidden(`This key ${why}, so an alert can't depend on it`);
}

async function validate(tx: Tx, ctx: Ctx, input: AlertInputT, scope: "workspace" | "personal"): Promise<Validated> {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, input.object);
  const t = input.trigger;
  const warnings: string[] = [];
  if (scope === "personal") assertObject(ctx, obj, "read");
  if (t.type === "event") {
    const target = triggerObject(schema, t.event);
    if (target.api_name !== obj.api_name) throw unprocessable(`Trigger event "${t.event}" is not about ${obj.api_name}`);
    if (t.changed_fields?.length) {
      if (!t.event.endsWith(".updated")) throw unprocessable("changed_fields only applies to *.updated events");
      const bad = t.changed_fields.filter((f) => !obj.byName.has(f));
      if (bad.length) throw unprocessable(`changed_fields: not fields of ${obj.api_name}: ${bad.join(", ")}`);
    }
  } else if (t.type === "field_passed") {
    const f = obj.byName.get(t.field);
    if (!f) throw unprocessable(`"${t.field}" is not a field of ${obj.api_name}`);
    if (f.type !== "date" && f.type !== "datetime") throw unprocessable(`"${t.field}" must be a date or date-time field`);
    if (f.sensitivity === "restricted") throw unprocessable(`"${t.field}" is restricted and cannot drive an alert`);
  }

  let condition = (input.condition ?? null) as Where | null;
  if (scope === "personal") {
    const me = requireUser(ctx);
    const of = ownerField(obj);
    if (input.mine_only ?? Boolean(of)) {
      if (!of) throw unprocessable(`${obj.plural_label} have no owner, so mine_only cannot apply`);
      const mine: Where = { field: of, op: "eq", value: encodeId("usr", me) };
      condition = condition ? { and: [condition, mine] } : mine;
    }
    if (input.webhooks?.length) throw unprocessable("Personal alerts notify you only; webhooks are for workspace alerts");
  }
  if (condition) {
    try {
      compileQuery(schema, { object: obj.api_name, where: condition, limit: 1 });
    } catch (e) {
      if (e instanceof ApiError) throw unprocessable(`Invalid condition: ${e.message}`, e.details);
      throw e;
    }
  }
  if (scope === "personal") assertPersonalRuleVisible(ctx, schema, obj, t, condition);

  const recipients = scope === "personal"
    ? { record_owner: false, users: [requireUser(ctx)] }
    : { record_owner: input.recipients?.record_owner ?? Boolean(ownerField(obj)), users: await resolveUsers(tx, input.recipients?.users ?? []) };
  if (scope !== "personal") {
    if (recipients.record_owner && !ownerField(obj)) throw unprocessable(`${obj.plural_label} have no owner; list recipient users instead`);
    const receivable = await receivers(tx, ctx.tenantId, recipients.users, obj.api_name);
    const skipped = recipients.users.filter((u) => !receivable.has(u));
    if (skipped.length) warnings.push(`${skipped.map((u) => encodeId("usr", u)).join(", ")} can't read ${obj.api_name} records, so they will not be notified until their role can.`);
    // Saved anyway (an admin may fix the role later); each fire skips them while it applies.
    for (const [u, uctx] of receivable) {
      const why = ruleHiddenFrom(uctx, schema, obj, t, condition);
      if (why) warnings.push(`${encodeId("usr", u)} ${why}, so they will not be notified by this alert until their role can.`);
    }
  }
  const webhooks: string[] = [];
  for (const w of input.webhooks ?? []) {
    const row = await loadWebhook(tx, w).catch(() => { throw unprocessable(`Webhook ${w} was not found`); });
    if (row.archived_at) throw unprocessable(`Webhook ${w} is archived`);
    webhooks.push(row.id);
  }
  if (scope === "workspace" && !recipients.record_owner && recipients.users.length === 0 && webhooks.length === 0) {
    throw unprocessable("This alert would reach no one: set recipients (record_owner or users) or webhooks");
  }
  if (t.type !== "event" && !input.cooldown_hours) warnings.push("Without cooldown_hours, a time alert fires once per record until the record changes again.");
  return { obj, kind: t.type === "event" ? "event" : "time", condition, recipients, webhooks, warnings, summary: describe(obj, input, condition, recipients, webhooks, scope) };
}

function describe(obj: ObjectMeta, input: AlertInputT, condition: Where | null, recipients: { record_owner: boolean; users: string[] }, webhooks: string[], scope: string): string {
  const t = input.trigger;
  const when = t.type === "event" ? `when ${t.event} happens${t.changed_fields?.length ? ` (only if ${t.changed_fields.join(" or ")} changed)` : ""}`
    : t.type === "inactive" ? `when a ${obj.label.toLowerCase()} has had no update or logged activity for ${t.days} day${t.days === 1 ? "" : "s"}`
    : `when a ${obj.label.toLowerCase()}'s ${t.field} has passed${t.offset_hours ? ` by ${t.offset_hours} hour(s)` : ""}`;
  const cond = condition ? ` and it matches ${JSON.stringify(condition)}` : "";
  const who = scope === "personal" ? "you" : [
    recipients.record_owner ? `the ${obj.api_name === "task" ? "assignee" : "owner"}` : null,
    recipients.users.length ? `${recipients.users.length} named member(s)` : null,
    webhooks.length ? `${webhooks.length} webhook(s)` : null,
  ].filter(Boolean).join(", ");
  const repeat = input.cooldown_hours ? ` Repeats every ${input.cooldown_hours} hour(s) while it still applies.` : " One open notification per record at a time.";
  return `Notify ${who} (${input.severity ?? "warning"}) ${when}${cond}.${repeat}`;
}

// ----------------------------------------------------------------------------------------------
// Deadlines

/** SQL that computes each record's deadline for a time rule, for given IDs or a keyset page. */
function dueQuery(schema: Schema, obj: ObjectMeta, t: TriggerT, sel: { ids: string[] } | { after: string | null; limit: number }) {
  const target = targetFor(schema, obj.api_name);
  const c = new Compiler(schema);
  let due: string;
  if (t.type === "inactive") {
    due = `GREATEST(r.updated_at, COALESCE((SELECT max(aa.occurred_at) FROM activity_associations aa WHERE aa.record_id = r.id), r.updated_at))
           + make_interval(days => ${c.param(t.days, "int")})`;
  } else if (t.type === "field_passed") {
    const f = target.fields.get(t.field)!;
    due = `(${c.expr("r", f)})::timestamptz + make_interval(hours => ${c.param(t.offset_hours ?? 0, "int")})`;
  } else throw new Error("not a time rule");
  const conds = ["r.archived_at IS NULL"];
  if (target.objectId) conds.push(`r.object_id = ${c.param(target.objectId, "uuid")}`);
  let tail = "";
  if ("ids" in sel) conds.push(`r.id = ANY(${c.param(sel.ids, "uuid[]")})`);
  else {
    if (sel.after) conds.push(`r.id > ${c.param(sel.after, "uuid")}`);
    tail = ` ORDER BY r.id LIMIT ${sel.limit}`;
  }
  return { text: `SELECT r.id, ${due} AS due FROM ${quoteIdent(target.table)} r WHERE ${conds.join(" AND ")}${tail}`, params: c.params };
}

async function computeDue(tx: Tx, schema: Schema, obj: ObjectMeta, t: TriggerT, sel: Parameters<typeof dueQuery>[3]) {
  const q = dueQuery(schema, obj, t, sel);
  return computedDeadlines(tx, q.text, q.params);
}

async function syncDeadlines(tx: Tx, tenantId: string, schema: Schema, rule: RuleRow, obj: ObjectMeta, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await computeDue(tx, schema, obj, rule.trigger, { ids });
  const withDue = rows.filter((r) => r.due);
  for (const r of withDue) {
    await upsertDeadline(tx, tenantId, rule.id, r.id, r.due);
  }
  const keep = new Set(withDue.map((r) => r.id));
  const drop = ids.filter((i) => !keep.has(i));
  if (drop.length) await dropDeadlines(tx, rule.id, drop);
}

const BACKFILL_BATCH = 1000;

/** Builds deadlines for new or changed time rules, one keyset page per rule per call. */
async function backfill(tx: Tx, tenantId: string, schema: Schema): Promise<void> {
  const rules = await rulesToBackfill(tx);
  for (const rule of rules) {
    const obj = schema.objects.get(rule.object);
    if (!obj) continue;
    const page = await computeDue(tx, schema, obj, rule.trigger, { after: rule.backfill_cursor, limit: BACKFILL_BATCH });
    for (const r of page.filter((x) => x.due)) {
      await upsertDeadline(tx, tenantId, rule.id, r.id, r.due);
    }
    if (page.length < BACKFILL_BATCH) await finishBackfill(tx, rule.id);
    else await advanceBackfill(tx, rule.id, page[page.length - 1]!.id);
  }
}

// ----------------------------------------------------------------------------------------------
// Firing

async function fire(tx: Tx, tenantId: string, schema: Schema, rule: RuleRow, obj: ObjectMeta, recordId: string, now: Date, reason: string): Promise<number> {
  const ctx: Ctx = systemCtx(tenantId, `alert:${rule.id}`, ["ops:read"]); // no restricted values in titles
  const rec: RecordOut | null = await getRecord(tx, ctx, obj.api_name, encodeId(obj.id_prefix, recordId)).catch(() => null);
  if (!rec) return 0;
  const users = new Set(rule.recipients.users ?? []);
  const of = ownerField(obj);
  if (rule.scope === "personal") users.add(rule.owner_user_id!);
  else if (rule.recipients.record_owner && of && typeof rec[of] === "string") {
    const d = decodeId(rec[of] as string);
    if (d) users.add(d.uuid);
  }
  // Only active members whose role can read the object; each gets the record named as their role sees it.
  const recipients = await receivers(tx, tenantId, [...users], obj.api_name);
  const title = `${rule.name}: ${String(rec.display_name)}`;
  const fired: string[] = [];
  const active: string[] = [];
  for (const [u, uctx] of recipients) {
    // Notifying only when the rule matches would reveal what it looked at to a recipient who can't
    // read it: skip them (for a personal alert, the owner's access may have narrowed since it was saved).
    if (ruleHiddenFrom(uctx, schema, obj, rule.trigger, rule.condition)) continue;
    const seen = await getRecord(tx, uctx, obj.api_name, encodeId(obj.id_prefix, recordId)).catch(() => null);
    if (!seen) continue;
    active.push(u);
    const id = await notifyUser(tx, tenantId, u, {
      source: { rule_id: rule.id }, recordId, object: obj.api_name, severity: rule.severity, title: `${rule.name}: ${String(seen.display_name)}`,
      body: rule.description ?? reason, cooldownHours: rule.cooldown_hours, now,
    });
    if (id) fired.push(id);
  }
  if (fired.length || (active.length === 0 && rule.webhooks.length)) {
    await emit(tx, ctx, { type: "alert.fired", objectType: obj.api_name, recordId, data: {
      alert: { id: encodeId("alr", rule.id), name: rule.name, severity: rule.severity, scope: rule.scope, trigger: rule.trigger },
      title, reason, notifications: fired.map((n) => encodeId("ntf", n)), recipients: active.map((u) => encodeId("usr", u)),
    } });
  }
  return fired.length;
}

/**
 * Called by the event processor for every event: evaluates event rules and keeps time-rule
 * deadlines current (record changes, archives, and activities logged against a record).
 */
export async function handleEventForAlerts(tx: Tx, tenantId: string, e: EventRow): Promise<void> {
  if (!e.object_type || !e.record_id || e.type.startsWith("alert.") || e.type.startsWith("schema.")) return;
  const rules = await enabledRulesOn(tx, e.object_type);
  const schema = await loadSchema(tx);
  const obj = schema.objects.get(e.object_type);
  if (obj && rules.length) {
    for (const rule of rules) {
      if (rule.kind === "time") {
        if (e.type.endsWith(".archived")) await dropDeadline(tx, rule.id, e.record_id);
        else await syncDeadlines(tx, tenantId, schema, rule, obj, [e.record_id]);
        continue;
      }
      const t = rule.trigger as Extract<TriggerT, { type: "event" }>;
      if (t.event !== e.type) continue;
      if (t.changed_fields?.length && !t.changed_fields.some((f) => f in ((e.data.after ?? {}) as object))) continue;
      if (!(await conditionMatches(tx, schema, obj, e.record_id, rule.condition).catch(() => false))) continue;
      // The app clock, not the event's database timestamp: deliveries are scheduled against the app clock.
      await fire(tx, tenantId, schema, rule, obj, e.record_id, new Date(), `${e.type} at ${e.occurred_at.toISOString()}`);
    }
  }
  if (e.type === "activity.created") {
    // A logged activity counts as touching every record it is about.
    const linked = await activityLinks(tx, e.record_id);
    for (const l of linked) {
      const target = schema.byId.get(l.object_id);
      if (!target) continue;
      const inactive = await enabledInactiveRulesOn(tx, target.api_name);
      for (const rule of inactive) await syncDeadlines(tx, tenantId, schema, rule, target, [l.record_id]);
    }
  }
}

/** Rule webhooks for an alert.fired event (subscriptions to alert.* are handled like any event). */
export async function alertWebhooks(tx: Tx, e: EventRow): Promise<string[]> {
  if (e.type !== "alert.fired") return [];
  const d = decodeId(String((e.data.alert as { id?: string } | undefined)?.id ?? ""));
  if (!d) return [];
  return (await ruleWebhooks(tx, d.uuid)) ?? [];
}

const SCHEDULER_BATCH = 500;

/**
 * The scheduler pass for one tenant: wakes snoozed notifications, builds deadlines for new
 * rules, and fires due deadlines after re-checking each against the record as it is now.
 * Re-running it is a no-op: fired deadlines are removed (or pushed out by the cooldown) and
 * open notifications are unique per rule, record and recipient.
 */
export async function runScheduler(tenantId: string, now = new Date()): Promise<{ fired: number; checked: number }> {
  return withTenant(tenantId, async (tx) => {
    await wakeSnoozed(tx, now);
    const schema = await loadSchema(tx);
    await backfill(tx, tenantId, schema);
    const due = await dueDeadlines(tx, now, SCHEDULER_BATCH);
    let fired = 0;
    const byRule = new Map<string, string[]>();
    for (const d of due) byRule.set(d.rule_id, [...(byRule.get(d.rule_id) ?? []), d.record_id]);
    for (const [ruleId, ids] of byRule) {
      const rule = await ruleById(tx, ruleId);
      const obj = rule ? schema.objects.get(rule.object) : undefined;
      if (!rule || !obj || (obj.module && !schema.modules.includes(obj.module))) continue;
      const current = new Map((await computeDue(tx, schema, obj, rule.trigger, { ids })).map((r) => [r.id, r.due]));
      for (const id of ids) {
        const dueAt = current.get(id);
        if (!dueAt) {
          await dropDeadline(tx, ruleId, id);
          continue;
        }
        if (dueAt > now) { // the record changed since the deadline was set
          await moveDeadline(tx, ruleId, id, dueAt);
          continue;
        }
        try {
          await tx.savepoint(async (sp) => {
            if (await conditionMatches(sp, schema, obj, id, rule.condition)) {
              fired += await fire(sp, tenantId, schema, rule, obj, id, now, `${rule.trigger.type === "inactive" ? "No activity since" : "Deadline"} ${dueAt.toISOString()}`);
            }
          });
        } catch (e) {
          logger.error({ tenantId, rule: ruleId, err: (e as Error).message }, "alert evaluation failed");
        }
        if (rule.cooldown_hours) {
          await moveDeadline(tx, ruleId, id, new Date(now.getTime() + rule.cooldown_hours * 3_600_000));
        } else {
          await dropDeadline(tx, ruleId, id);
        }
      }
    }
    return { fired, checked: due.length };
  });
}

// ----------------------------------------------------------------------------------------------
// Backtest

const BACKTEST_SCAN_LIMIT = 20_000;

async function matchingIds(tx: Tx, schema: Schema, obj: ObjectMeta, ids: string[], condition: Where | null): Promise<Set<string>> {
  if (!condition) return new Set(ids);
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const q = compileQuery(schema, { object: obj.api_name, include_archived: true, limit: 200,
      where: { and: [condition, { field: "id", op: "in", value: chunk.map((u) => encodeId(obj.id_prefix, u)) }] } });
    for (const r of await compiledRecordIds(tx, q.text, q.params)) out.add(r.id);
  }
  return out;
}

async function sampleNames(tx: Tx, ctx: Ctx, obj: ObjectMeta, items: { id: string; at: Date }[]) {
  const out = [];
  const scoped: Ctx = without(ctx, "restricted:read");
  for (const it of items.slice(0, 10)) {
    const id = encodeId(obj.id_prefix, it.id);
    const rec = await getRecord(tx, scoped, obj.api_name, id).catch(() => null);
    out.push({ record: id, display_name: rec ? rec.display_name : null, at: it.at.toISOString() });
  }
  return out;
}

/** How often a rule would have fired over the last `days` days, with sample matches. Approximate: conditions use records as they are now. */
async function backtest(tx: Tx, ctx: Ctx, v: Validated, input: AlertInputT, days: number) {
  const schema = await loadSchema(tx);
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const t = input.trigger;
  if (t.type === "event") {
    const events = await recordEventsSince(tx, t.event, since, BACKTEST_SCAN_LIMIT);
    const relevant = events.filter((e) => !t.changed_fields?.length || t.changed_fields.some((f) => f in (e.data.after ?? {})));
    const ok = await matchingIds(tx, schema, v.obj, [...new Set(relevant.map((e) => e.record_id))], v.condition);
    const hits = relevant.filter((e) => ok.has(e.record_id));
    return {
      window_days: days, would_fire: hits.length, records: new Set(hits.map((h) => h.record_id)).size,
      samples: await sampleNames(tx, ctx, v.obj, hits.map((h) => ({ id: h.record_id, at: h.occurred_at }))),
      approximate: true, note: "Replays the event history. Conditions are checked against the records as they are now, and repeat events on a record with an open notification would not notify again.",
      truncated: events.length === BACKTEST_SCAN_LIMIT,
    };
  }
  const due: { id: string; due: Date }[] = [];
  let after: string | null = null;
  let scanned = 0;
  for (;;) {
    const page = await computeDue(tx, schema, v.obj, t, { after, limit: 2000 });
    scanned += page.length;
    for (const r of page) if (r.due && r.due <= now) due.push({ id: r.id, due: r.due });
    if (page.length < 2000 || scanned >= BACKTEST_SCAN_LIMIT) break;
    after = page[page.length - 1]!.id;
  }
  const ok = await matchingIds(tx, schema, v.obj, due.map((d) => d.id), v.condition);
  const hits = due.filter((d) => ok.has(d.id)).sort((a, b) => b.due.getTime() - a.due.getTime());
  return {
    window_days: days,
    would_fire_on_save: hits.length,
    became_due_in_window: hits.filter((h) => h.due >= since).length,
    samples: await sampleNames(tx, ctx, v.obj, hits.map((h) => ({ id: h.id, at: h.due }))),
    approximate: true,
    note: "Computed from each record's current state. Records already past their deadline would notify as soon as the rule is saved.",
    truncated: scanned >= BACKTEST_SCAN_LIMIT,
  };
}

// ----------------------------------------------------------------------------------------------
// CRUD

function parseRuleId(publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "alr") throw notFound(`Alert ${publicId}`);
  return d.uuid;
}

async function loadRule(tx: Tx, ctx: Ctx, publicId: string, scope: "any" | "personal", forUpdate = false): Promise<RuleRow> {
  const id = parseRuleId(publicId);
  const r = await ruleById(tx, id, forUpdate);
  if (!r) throw notFound(`Alert ${publicId}`);
  if (scope === "personal" && (r.scope !== "personal" || r.owner_user_id !== ctx.actor.id)) throw notFound(`Alert ${publicId}`);
  return r;
}

export interface SaveOpts { scope: "workspace" | "personal"; dryRun: boolean; backtestDays?: number }

export async function createAlert(tx: Tx, ctx: Ctx, input: AlertInputT, opts: SaveOpts) {
  const v = await validate(tx, ctx, input, opts.scope);
  const days = Math.min(Math.max(opts.backtestDays ?? 30, 1), 90);
  const bt = await backtest(tx, ctx, v, input, days);
  if (opts.dryRun) return { dry_run: true, summary: v.summary, warnings: v.warnings, backtest: bt };
  const count = await countLiveRules(tx);
  if ((count ?? 0) >= 500) throw conflict("A workspace can have at most 500 alert rules");
  const id = uuidv7();
  await insertRule(tx, {
    tenantId: ctx.tenantId, id, scope: opts.scope, ownerUserId: opts.scope === "personal" ? requireUser(ctx) : null, name: input.name, description: input.description ?? null,
    object: v.obj.api_name, kind: v.kind, trigger: input.trigger, condition: v.condition,
    severity: input.severity ?? "warning", recipients: v.recipients, webhooks: v.webhooks, cooldownHours: input.cooldown_hours ?? null,
    enabled: input.enabled ?? true, createdBy: ctx.actor.id,
  });
  await audit(tx, ctx, { action: "alert.created", details: { alert: encodeId("alr", id), scope: opts.scope, object: v.obj.api_name, kind: v.kind } });
  return { dry_run: false, summary: v.summary, warnings: v.warnings, backtest: bt, alert: publicRule(await loadRule(tx, ctx, encodeId("alr", id), "any")) };
}

export async function updateAlert(tx: Tx, ctx: Ctx, publicId: string, patch: Partial<AlertInputT>, opts: SaveOpts) {
  const cur = await loadRule(tx, ctx, publicId, opts.scope === "personal" ? "personal" : "any", true);
  if (cur.archived_at) throw conflict(`Alert ${publicId} is archived`);
  if (opts.scope === "workspace" && cur.scope === "personal") throw unprocessable("Personal alerts are changed by their owner through the ops surface");
  const next: AlertInputT = {
    name: patch.name ?? cur.name, description: patch.description ?? cur.description ?? undefined, object: patch.object ?? cur.object,
    trigger: patch.trigger ?? cur.trigger, condition: patch.condition !== undefined ? patch.condition : cur.condition ?? undefined,
    severity: patch.severity ?? cur.severity,
    recipients: patch.recipients ?? { record_owner: cur.recipients.record_owner, users: (cur.recipients.users ?? []).map((u) => encodeId("usr", u)) },
    webhooks: patch.webhooks ?? cur.webhooks.map((w) => encodeId("whk", w)),
    cooldown_hours: patch.cooldown_hours !== undefined ? patch.cooldown_hours : cur.cooldown_hours,
    enabled: patch.enabled ?? cur.enabled, mine_only: false, // the stored condition already includes it
  };
  const v = await validate(tx, ctx, next, opts.scope);
  const bt = await backtest(tx, ctx, v, next, Math.min(Math.max(opts.backtestDays ?? 30, 1), 90));
  if (opts.dryRun) return { dry_run: true, summary: v.summary, warnings: v.warnings, backtest: bt };
  const reshaped = JSON.stringify(next.trigger) !== JSON.stringify(cur.trigger) || next.object !== cur.object;
  await updateRule(tx, cur.id, {
    name: next.name, description: next.description ?? null, object: v.obj.api_name, kind: v.kind,
    trigger: next.trigger, condition: v.condition, severity: next.severity ?? "warning",
    recipients: v.recipients, webhooks: v.webhooks, cooldownHours: next.cooldown_hours ?? null,
    enabled: next.enabled ?? true,
    backfilledAt: reshaped ? null : cur.backfilled_at, backfillCursor: reshaped ? null : cur.backfill_cursor,
  });
  if (reshaped) await dropRuleDeadlines(tx, cur.id);
  await audit(tx, ctx, { action: "alert.updated", details: { alert: publicId, fields: Object.keys(patch) } });
  return { dry_run: false, summary: v.summary, warnings: v.warnings, backtest: bt, alert: publicRule(await loadRule(tx, ctx, publicId, "any")) };
}

export async function archiveAlert(tx: Tx, ctx: Ctx, publicId: string, scope: "workspace" | "personal") {
  const cur = await loadRule(tx, ctx, publicId, scope === "personal" ? "personal" : "any", true);
  if (!cur.archived_at) {
    await archiveRuleRow(tx, cur.id);
    await dropRuleDeadlines(tx, cur.id);
    await audit(tx, ctx, { action: "alert.archived", details: { alert: publicId } });
  }
  return publicRule(await loadRule(tx, ctx, publicId, "any"));
}

export async function listAlerts(tx: Tx, ctx: Ctx, scope: "all" | "mine") {
  const rows = scope === "mine"
    ? await personalRulesOf(tx, requireUser(ctx))
    : await liveRules(tx);
  return rows.map(publicRule);
}

export async function getAlert(tx: Tx, ctx: Ctx, publicId: string, scope: "any" | "personal") {
  return publicRule(await loadRule(tx, ctx, publicId, scope));
}

export async function backtestAlert(tx: Tx, ctx: Ctx, input: AlertInputT, scope: "workspace" | "personal", days = 30) {
  const v = await validate(tx, ctx, input, scope);
  return { summary: v.summary, warnings: v.warnings, backtest: await backtest(tx, ctx, v, input, Math.min(Math.max(days, 1), 90)) };
}
