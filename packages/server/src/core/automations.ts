import type { Tx } from "../db/pool.js";
import { ApiError, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { BlockedTargetError, checkUrl } from "../lib/outbound.js";
import { checkConnectionPath, connectionForStep, connectionUrl } from "./connections.js";
import { ownerField } from "./alerts.js";
import { audit } from "./audit.js";
import { dependencies, depsHiddenFrom, writeDenied, writes } from "./automation-access.js";
import {
  allSteps, conditionMatches, isHeaderName, LIMITS, MAX_DEPTH, needsQueue, recordObject, sendsOut,
  triggerObject, triggerOf, type AutomationInputT, type AutomationRow, type InnerStep, type Step, type Trigger,
} from "./automation-defs.js";
import {
  addressHash, afterRun, capNotice, execute, failureReason, hashLabel, headerAllowed, hourStart, loadSettings, mailboxHash, newState, OUTPUT_OPS, storedResults,
  usageOf, validAddress, type Failure, type RunState, type Settings, type StepResult,
} from "./automation-runner.js";
import type { FieldType } from "./catalog.js";
import { can, type Ctx } from "./context.js";
import { decryptValue, encryptValue } from "./encryption.js";
import { ADDRESS_PART_NAMES, FieldValueError, isAddressPart, normalizeInput } from "./fieldtypes.js";
import { receivers, resolveUsers } from "./notifications.js";
import {
  hasRunForEvent, insertEventRun, insertManualRun, manualRunCounts, recentRunCounts, runsOf,
} from "./queries/automation-runs.js";
import {
  archiveAutomationRow, automationById, automationsListeningFor, countLiveAutomations, deleteSuppression, insertAutomation, insertSuppression, liveAutomations,
  liveRoles, pauseAutomationRow, resumeAutomationRow, saveAutomationSettings, scheduledAutomations, setNextRun, suppressionOf, updateAutomationDefinition,
} from "./queries/automations.js";
import { compileQuery, type Where } from "./query.js";
import { getRecord } from "./records.js";
import { contextForRole, resolveRole } from "./roles.js";
import { checkSchedule, describeSchedule, nextRun, upcoming, validTimezone, type Schedule } from "./schedule.js";
import { getObject, loadSchema, type ObjectMeta, type Schema } from "./schema.js";
import { MAX_PLACEHOLDERS, placeholders, secretScope, strings } from "./templates.js";
import { isUniqueKey } from "./transfer.js";
import { actorRef, loadWebhook, policy, type EventRow, type WebhookRow } from "./webhooks.js";

/**
 * Automations: "when <trigger> (and <condition>), do <steps>". Triggers are record events, a
 * schedule, or a request to run now. Agents may describe them in natural language, but only the
 * validated structure in automation-defs.ts is stored; the runner is automation-runner.ts.
 *
 * Guards against loops: an automation never reacts to its own changes, events carry a causation
 * depth (runs stop at MAX_DEPTH), one automation runs at most LIMITS.sameRecordPer10Min times per
 * record in 10 minutes, and each automation has an hourly cap. Workspaces have hourly caps on
 * actions, HTTP requests and emails (automation-runner.ts).
 */

export { ActionSchema, AutomationInput, automationCtx, conditionMatches, MAX_DEPTH, triggerObject } from "./automation-defs.js";
export type { Action, AutomationInputT } from "./automation-defs.js";
export { fillTemplates } from "./templates.js";

const RECORD_META = new Set(["id", "object", "display_name", "created_at", "updated_at", "version", "archived_at", "related", "merged_into"]);

const publicAutomation = (a: AutomationRow) => ({
  id: encodeId("auto", a.id), name: a.name, description: a.description, enabled: a.enabled && !a.archived_at,
  status: a.archived_at ? "archived" : !a.enabled ? "disabled" : a.paused_at ? "paused" : "enabled",
  paused_at: a.paused_at?.toISOString() ?? null, paused_reason: a.paused_reason, consecutive_failures: a.consecutive_failures,
  trigger: triggerOf(a.trigger), condition: a.condition, actions: a.actions, hourly_cap: a.hourly_cap, run_roles: a.run_roles,
  next_run_at: a.next_run_at?.toISOString() ?? null, version: a.version,
  created_at: a.created_at.toISOString(), updated_at: a.updated_at.toISOString(),
});

// ----------------------------------------------------------------------------------------------
// Validation

/** Field types whose values are checked at save when they hold no placeholder (core/fieldtypes.ts TYPE_INFO). */
const CHECKED_AT_SAVE = new Set<FieldType>(["address", "json", "rating", "percent", "duration"]);

/**
 * Checks that the fields a step writes exist and are writable, and that an address, json, rating, percent or
 * duration value without placeholders is one its field takes (an address with placeholders must still be an
 * object of parts, or one placeholder for a whole address). Values with placeholders are checked at run time.
 * A part or a path (hq.city, meta.a) is not a field: a step writes the whole address or json value.
 */
function checkValues(obj: ObjectMeta, values: Record<string, unknown>, mode: "create" | "update"): void {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "related_to" && (obj.api_name === "task" || obj.api_name === "activity")) continue;
    const f = obj.byName.get(k);
    const parent = !f && k.includes(".") ? obj.byName.get(k.slice(0, k.indexOf("."))) : undefined;
    if (!f) errors.push(parent && (parent.type === "address" || parent.type === "json")
      ? `"${k}" is a part of ${parent.api_name}; write the whole ${parent.type === "address" ? "address (an object of its parts)" : "json value"} under "${parent.api_name}"`
      : `"${k}" is not a field of ${obj.api_name}`);
    else if (f.read_only) errors.push(`"${k}" is read-only`);
    else if (mode === "update" && f.create_only) errors.push(`"${k}" can only be set when a ${obj.api_name} is created`);
    else if (CHECKED_AT_SAVE.has(f.type)) {
      const templated = strings(v).some((x) => x.includes("{{"));
      if (!templated) {
        try {
          normalizeInput(f, v);
        } catch (e) {
          if (!(e instanceof FieldValueError)) throw e;
          errors.push(`"${k}" ${e.message}`);
        }
      } else if (f.type === "address" && !(typeof v === "string" && /^\{\{[^{}]+\}\}$/.test(v))) {
        if (!v || typeof v !== "object" || Array.isArray(v)) errors.push(`"${k}" is an address: an object of its parts (${ADDRESS_PART_NAMES.join(", ")}) or one placeholder for a whole address`);
        else {
          const bad = Object.keys(v).filter((x) => x !== "display" && !isAddressPart(x));
          if (bad.length) errors.push(`"${k}" has unknown address parts: ${bad.map((x) => x.slice(0, 40)).join(", ")}`);
        }
      }
    }
  }
  if (errors.length) throw unprocessable(`Invalid action values: ${errors.join("; ")}`);
}

/** A filter that may hold placeholders: checked now when it has none, else when it runs (values aren't known yet). */
function checkWhere(schema: Schema, object: string, where: unknown, what: string): void {
  if (where === undefined || where === null) return;
  try {
    compileQuery(schema, { object, where: where as Where, limit: 1 });
  } catch (e) {
    if (e instanceof ApiError && !JSON.stringify(where).includes("{{")) throw unprocessable(`Invalid ${what}: ${e.message}`, e.details);
    if (!(e instanceof ApiError)) throw e;
  }
}

/** A sort, checked at save with the query compiler a run uses (fields, at most three keys, no restricted or unsortable field). */
function checkSort(schema: Schema, object: string, sort: unknown, what: string): void {
  if (sort === undefined || sort === null) return;
  try {
    compileQuery(schema, { object, sort: sort as never, limit: 1 });
  } catch (e) {
    if (e instanceof ApiError) throw unprocessable(`Invalid ${what}: ${e.message}`, e.details);
    throw e;
  }
}

interface Validated {
  input: AutomationInputT; trigger: Trigger; obj: ObjectMeta | null; webhooks: Map<string, WebhookRow>; summary: string; warnings: string[];
  actions: Step[]; secrets: Record<string, Record<string, string>>; runRoles: string[]; settings: Settings; nextRuns: string[] | null;
}

interface StepCtx { schema: Schema; trigger: Trigger; obj: ObjectMeta | null; condition: Where | null; cur: ObjectMeta | null; inFor: boolean; /** Inside a for_each over an HTTP reply's list: {{item…}} is an element of it, and there is no current record. */ itemData?: boolean; known: Map<string, Step | InnerStep>; outbound: boolean; warnings: string[] }

/** Most placeholders one step may hold in all its strings. Each is filled per run (and per recipient), so this bounds the work. */
const MAX_STEP_PLACEHOLDERS = 200;

/**
 * Checks every placeholder in a step: valid syntax, roots that exist here, at most MAX_PLACEHOLDERS per
 * string, and no restricted field anywhere (written to a record, the "[restricted]" the automation reads
 * would replace the real value) and no hidden field in what goes out.
 */
function checkTemplates(c: StepCtx, step: Step | InnerStep, where: string): void {
  const texts = strings(step.type === "for_each" ? { if: step.if, query: step.query, items: step.items } : step);
  let count = 0;
  for (const t of texts) {
    const found = placeholders(t);
    if (found.length > MAX_PLACEHOLDERS) throw unprocessable(`${where}: a text holds ${found.length} placeholders; at most ${MAX_PLACEHOLDERS}`);
    count += found.length;
    if (count > MAX_STEP_PLACEHOLDERS) throw unprocessable(`${where}: the step holds more than ${MAX_STEP_PLACEHOLDERS} placeholders`);
    for (const p of found) {
      if (p.date) continue;
      const [root, a] = p.path;
      const fieldOf = (obj: ObjectMeta, name = a, label = `${root}.${a}`) => {
        if (!name || RECORD_META.has(name)) return;
        const f = obj.byName.get(name);
        if (!f) return c.warnings.push(`${where}: {{${label}}} is not a field of ${obj.api_name}; it will be empty`);
        if (f.sensitivity === "restricted") throw unprocessable(`${where}: {{${label}}} is a restricted field; automations never read restricted values`);
        if (f.hidden) {
          const msg = `${where}: {{${label}}} is a hidden field`;
          if (c.outbound) throw unprocessable(`${msg}; automations never send it out`);
          c.warnings.push(`${msg}; automations can't read it, so it will be empty`);
        }
      };
      if (root === "record") {
        if (!c.obj) throw unprocessable(`${where}: {{record…}} needs a trigger record, and this trigger has none${c.inFor ? "; use {{item…}} for the current item" : ""}`);
        fieldOf(c.obj);
      } else if (root === "item") {
        if (!c.inFor || (!c.cur && !c.itemData)) throw unprocessable(`${where}: {{item…}} only works inside for_each`);
        // An element of an HTTP reply is another system's data, not a record: there are no fields to check.
        if (c.cur) fieldOf(c.cur);
      } else if (root === "steps") {
        const src = c.known.get(a!);
        if (!src) throw unprocessable(`${where}: {{steps.${a}…}} names no earlier step; give that step "id": "${a}"`);
        // A field of the records a step found or wrote: the same rule as {{record.<field>}}.
        const [, , out, b, d] = p.path;
        const o = src.type === "find_records" || src.type === "create_record" || src.type === "upsert_record" || (src.type === "update_record" && src.object)
          ? c.schema.objects.get((src as { object: string }).object) : undefined; // an update of the current record: its object depends on where it ran (checked at run)
        const name = out === "first" || out === "record" ? b : out === "records" ? d : undefined;
        if (o && name) fieldOf(o, name, p.path.join("."));
      } else if (root === "event" && c.trigger.type !== "event") {
        c.warnings.push(`${where}: {{event…}} is empty for ${c.trigger.type} runs`);
      }
    }
  }
}

function checkUrlTemplate(raw: string, where: string): void {
  const origin = /^https?:\/\/[^/?#]+/i.exec(raw);
  if (!origin) throw unprocessable(`${where}: url must start with https:// and a host`);
  if (origin[0].includes("{{")) throw unprocessable(`${where}: placeholders may fill the URL's path and query, not its host`);
  try {
    checkUrl(raw.replace(/\{\{[^{}]*\}\}/g, "x"), { allowInsecure: false });
  } catch (e) {
    if (!(e instanceof BlockedTargetError)) throw e;
    // Deployments that allow insecure webhook targets allow them here too; the send re-checks with that policy.
    try {
      checkUrl(raw.replace(/\{\{[^{}]*\}\}/g, "x"), policy());
    } catch (e2) {
      if (e2 instanceof BlockedTargetError) throw unprocessable(`${where}: ${e2.message.replace(/^Webhook URL/, "the URL")}`);
      throw e2;
    }
  }
}

async function checkStep(tx: Tx, ctx: Ctx, c: StepCtx, step: Step | InnerStep, where: string, webhooks: Map<string, WebhookRow>, settings: Settings): Promise<void> {
  const { schema, cur } = c;
  const outbound = step.type === "http_request" || step.type === "send_email";
  checkTemplates({ ...c, outbound }, step, where);
  if (step.if !== undefined && step.if !== null) {
    const g = step.if as Record<string, unknown>;
    if (typeof g === "object" && "output" in g) {
      if (typeof g.output !== "string" || !g.output.includes("{{")) throw unprocessable(`${where}: if.output must be a placeholder such as "{{steps.call.status}}"`);
      if (typeof g.op !== "string" || !OUTPUT_OPS.includes(g.op)) throw unprocessable(`${where}: if.op must be one of ${OUTPUT_OPS.join(", ")}`);
      if (Object.keys(g).some((k) => !["output", "op", "value"].includes(k))) throw unprocessable(`${where}: if takes output, op and value`);
    } else {
      if (!cur) throw unprocessable(`${where}: an if filter needs a current record (the trigger record or a for_each item); use {"output": …} to test a step's output`);
      checkWhere(schema, cur.api_name, step.if, `${where} if condition`);
    }
  }
  switch (step.type) {
    case "send_webhook": {
      const w = await loadWebhook(tx, step.webhook).catch(() => { throw unprocessable(`Webhook ${step.webhook} was not found; register it first`); });
      if (w.archived_at) throw unprocessable(`Webhook ${step.webhook} is archived`);
      if (!w.enabled) c.warnings.push(`Webhook ${step.webhook} is disabled; deliveries will queue but not send until it is enabled`);
      webhooks.set(step.webhook, w);
      return;
    }
    case "update_record":
      if (step.record) {
        // The record is only known when it runs: the step names its object, so its values are checked now (and the record against it then).
        if (!step.object) throw unprocessable(`${where}: an update_record with "record" needs "object", the object of the record it names`);
        return checkValues(getObject(schema, step.object), step.values, "update");
      }
      if (step.object !== undefined) throw unprocessable(`${where}: "object" goes with "record"; without it the step updates the current record`);
      if (!cur) throw unprocessable(`${where}: update_record needs a record: the trigger record, a for_each item, or "record"`);
      if (!c.inFor && c.trigger.type === "event" && c.trigger.event.endsWith(".archived")) throw unprocessable("update_record cannot run on an archived record");
      checkValues(cur, step.values, "update");
      if (!c.inFor && c.trigger.type === "event") {
        const self = Object.keys(step.values).filter((k) => c.trigger.type === "event" && c.trigger.changed_fields?.includes(k));
        if (self.length) c.warnings.push(`This automation updates ${self.join(", ")}, which it also watches; it will not re-trigger itself, but other automations may react`);
      }
      return;
    case "create_record":
      return checkValues(getObject(schema, step.object), step.values, "create");
    case "upsert_record": {
      const obj = getObject(schema, step.object);
      if (step.key !== "id" && !isUniqueKey(obj, step.key)) throw unprocessable(`${where}: the upsert key must be id or a unique field of ${obj.api_name}; "${step.key}" is not unique`);
      if (!(step.key in step.values)) throw unprocessable(`${where}: values must include the key ${step.key}`);
      return checkValues(obj, Object.fromEntries(Object.entries(step.values).filter(([k]) => k !== "id")), "create");
    }
    case "find_records": {
      const obj = getObject(schema, step.object);
      checkWhere(schema, obj.api_name, step.where, `${where} where`);
      checkSort(schema, obj.api_name, step.sort, `${where} sort`);
      if (!step.id) c.warnings.push(`${where}: find_records without an id: later steps can't use what it found`);
      return;
    }
    case "notify": {
      if (!cur) throw unprocessable(`${where}: notify needs a record (the trigger record or a for_each item)`);
      if (step.recipients.record_owner && !ownerField(cur)) throw unprocessable(`${cur.plural_label} have no owner; list recipient users instead`);
      const users = await resolveUsers(tx, step.recipients.users ?? []);
      if (!step.recipients.record_owner && !step.recipients.users?.length) throw unprocessable("notify needs recipients: record_owner and/or users");
      // Saved anyway (an admin may fix the role later); each run skips them while it applies. What the run
      // depends on is checked for each named member once every step is known (recipientWarnings).
      const receivable = await receivers(tx, ctx.tenantId, users, cur.api_name);
      const unreadable = users.filter((u) => !receivable.has(u));
      if (unreadable.length) c.warnings.push(`${unreadable.map((u) => encodeId("usr", u)).join(", ")} can't read ${cur.api_name} records, so notify will skip them until their role can.`);
      return;
    }
    case "http_request": {
      const conn = step.connection !== undefined ? await connectionForStep(tx, step.connection) : null;
      if (conn) {
        // The credential is the connection's: a step can't add secrets of its own, which would travel with it to wherever the connection points.
        if (step.secret_headers && Object.keys(step.secret_headers).length) throw unprocessable(`${where}: a step with a connection can't have secret_headers; the connection holds the credential`);
        checkConnectionPath(step.url, `${where}: url`);
        if (Object.keys(step.headers ?? {}).some((k) => k.toLowerCase() === conn.header_name.toLowerCase())) {
          throw unprocessable(`${where}: header ${conn.header_name} is set by connection ${conn.key}`);
        }
        if (!conn.enabled) c.warnings.push(`${where}: connection ${conn.key} is turned off, so this step will fail until it is turned on.`);
      }
      checkUrlTemplate(conn ? connectionUrl(conn, step.url) : step.url, where);
      const names = new Set<string>();
      for (const [k, v] of Object.entries(step.headers ?? {})) {
        if (!isHeaderName(k) || !headerAllowed(k)) throw unprocessable(`${where}: header "${k}" is not allowed`);
        if ([...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw unprocessable(`${where}: header ${k} holds a line break or control character`);
        names.add(k.toLowerCase());
      }
      const secrets = Object.keys(step.secret_headers ?? {});
      if (secrets.length > 10 || Object.keys(step.headers ?? {}).length > 20) throw unprocessable(`${where}: at most 20 headers and 10 secret headers`);
      for (const k of secrets) {
        if (!isHeaderName(k) || !headerAllowed(k)) throw unprocessable(`${where}: header "${k}" is not allowed`);
        if (names.has(k.toLowerCase())) throw unprocessable(`${where}: header ${k} is both a header and a secret header`);
        const v = step.secret_headers![k];
        if (typeof v === "string" && [...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) throw unprocessable(`${where}: secret header ${k} holds a control character`);
      }
      if (secrets.length && !step.id) throw unprocessable(`${where}: an http_request with secret_headers needs an id, to keep its secrets by`);
      if (step.body !== undefined && !["POST", "PUT", "PATCH"].includes(step.method)) throw unprocessable(`${where}: only POST, PUT and PATCH take a body`);
      if (step.body !== undefined && JSON.stringify(step.body).length > 64 * 1024) throw unprocessable(`${where}: the body template is larger than 64 KB`);
      return;
    }
    case "send_email": {
      const ways = (["member", "record_owner", "field", "address"] as const).filter((k) => step.to[k] !== undefined);
      if (ways.length !== 1) throw unprocessable(`${where}: to needs exactly one of member, record_owner, field or address`);
      if (step.to.member) await resolveUsers(tx, [step.to.member]);
      if (step.to.record_owner && (!cur || !ownerField(cur))) throw unprocessable(`${where}: there is no record with an owner to email here`);
      if (step.to.field !== undefined) {
        if (!cur) throw unprocessable(`${where}: to.field needs a record (the trigger record or a for_each item)`);
        const f = cur.byName.get(step.to.field);
        if (!f || f.type !== "email") throw unprocessable(`${where}: ${step.to.field} is not an email field of ${cur.api_name}`);
        if (f.sensitivity === "restricted" || f.hidden) throw unprocessable(`${where}: ${cur.api_name}.${step.to.field} is ${f.hidden ? "hidden" : "restricted"}, so automations can't email it`);
      }
      if (step.to.address !== undefined && !validAddress(step.to.address)) throw unprocessable(`${where}: to.address must be one plain email address`);
      if ((step.to.field !== undefined || step.to.address !== undefined) && !settings.external_email) {
        c.warnings.push(`${where}: email to addresses that are not members is off for this workspace; runs will fail at this step until an admin turns external_email on (PATCH /v1/automation-settings)`);
      }
      return;
    }
    case "for_each": {
      if (c.inFor) throw unprocessable(`${where}: for_each can't be nested`);
      if ([step.over, step.query, step.items].filter((x) => x !== undefined).length !== 1) {
        throw unprocessable(`${where}: for_each needs exactly one of over (a find_records step id), query, or items (a list from an HTTP reply)`);
      }
      if (step.items !== undefined) {
        // Exactly one placeholder, into the parsed JSON of an earlier http_request's reply. Nothing else is a list a run holds.
        const m = /^\{\{\s*([^{}|]+?)\s*\}\}$/.exec(step.items);
        const path = m ? m[1]!.split(".") : [];
        const src = path[0] === "steps" ? c.known.get(path[1] ?? "") : undefined;
        if (!m || !src || src.type !== "http_request" || path[2] !== "json") {
          throw unprocessable(`${where}: items must be one placeholder for a list in an earlier http_request step's reply, such as "{{steps.fetch.json.results}}"`);
        }
        const inner: StepCtx = { ...c, cur: null, inFor: true, itemData: true };
        for (const [i, s] of step.steps.entries()) {
          await checkStep(tx, ctx, inner, s, `${where}.${i + 1} (${s.type})`, webhooks, settings);
          if (s.id) c.known.set(s.id, s);
        }
        return;
      }
      let obj: ObjectMeta;
      if (step.over) {
        const src = c.known.get(step.over);
        if (!src || src.type !== "find_records") throw unprocessable(`${where}: over must name an earlier find_records step`);
        obj = getObject(schema, src.object);
      } else {
        obj = getObject(schema, step.query!.object);
        checkWhere(schema, obj.api_name, step.query!.where, `${where} query`);
        checkSort(schema, obj.api_name, step.query!.sort, `${where} query sort`);
      }
      const inner: StepCtx = { ...c, cur: obj, inFor: true };
      for (const [i, s] of step.steps.entries()) {
        await checkStep(tx, ctx, inner, s, `${where}.${i + 1} (${s.type})`, webhooks, settings);
        if (s.id) c.known.set(s.id, s);
      }
      return;
    }
    case "stop":
      return;
  }
}

async function validate(tx: Tx, ctx: Ctx, input: AutomationInputT, current: AutomationRow | null): Promise<Validated> {
  const schema = await loadSchema(tx);
  const settings = await loadSettings(tx);
  const trigger = input.trigger;
  const warnings: string[] = [];
  let obj: ObjectMeta | null = null;
  if (trigger.type === "event") {
    obj = triggerObject(schema, trigger.event, { automation: true });
    // A merge gives every record whose reference moved its normal event marked reference_move: `.updated`, or
    // `.archived` for a second copy it archived (a duplicate link row). Both kinds are skipped unless asked for.
    if (trigger.include_reference_moves && !trigger.event.endsWith(".updated") && !trigger.event.endsWith(".archived")) {
      throw unprocessable("include_reference_moves only applies to *.updated and *.archived triggers");
    }
    if (trigger.changed_fields?.length) {
      if (!trigger.event.endsWith(".updated")) throw unprocessable("changed_fields only applies to *.updated triggers");
      const bad = (trigger.changed_fields ?? []).filter((f) => !obj!.byName.has(f));
      if (bad.length) throw unprocessable(`changed_fields: not fields of ${obj.api_name}: ${bad.join(", ")}`);
    }
  } else if (trigger.type === "schedule") {
    checkSchedule(trigger);
    if (input.condition !== undefined && input.condition !== null) throw unprocessable("A schedule has no trigger record to check a condition against; filter with for_each query instead");
  } else if (trigger.object) {
    obj = getObject(schema, trigger.object);
  } else if (input.condition !== undefined && input.condition !== null) {
    throw unprocessable("A manual trigger without an object has no record to check a condition against");
  }
  if (input.condition !== undefined && input.condition !== null) {
    try {
      compileQuery(schema, { object: obj!.api_name, where: input.condition as Where, limit: 1 });
    } catch (e) {
      if (e instanceof ApiError) throw unprocessable(`Invalid condition: ${e.message}`, e.details);
      throw e;
    }
  }
  const runRoles: string[] = [];
  for (const r of input.run_roles ?? []) {
    const role = await resolveRole(tx, r).catch(() => { throw unprocessable(`run_roles: no role "${r}"`); });
    runRoles.push(role.key);
  }
  const ids = allSteps(input.actions).map((s) => s.id).filter(Boolean) as string[];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw unprocessable(`Two steps have the id "${dup}"`);
  if (allSteps(input.actions).length > LIMITS.totalSteps) throw unprocessable(`An automation can have at most ${LIMITS.totalSteps} steps in all`);
  const webhooks = new Map<string, WebhookRow>();
  const c: StepCtx = { schema, trigger, obj, condition: (input.condition ?? null) as Where | null, cur: obj, inFor: false, known: new Map(), outbound: false, warnings };
  for (const [i, s] of input.actions.entries()) {
    await checkStep(tx, ctx, c, s, `step ${i + 1} (${s.type})`, webhooks, settings);
    if (s.id) c.known.set(s.id, s);
  }
  await recipientWarnings(tx, ctx, schema, { trigger, condition: c.condition, actions: input.actions }, warnings);
  // Secret header values never stay in the stored steps: they are encrypted apart, and shown as null.
  const old = current?.secrets ? (await decryptValue(tx, ctx.tenantId, current.id, "automation_secrets", current.secrets)) as Record<string, Record<string, string>> : {};
  const secrets: Record<string, Record<string, string>> = {};
  const before = new Map(allSteps(current?.actions ?? []).flatMap((x) => (x.type === "http_request" && x.id ? [[x.id, x] as const] : [])));
  const strip = (s: InnerStep): InnerStep => {
    if (s.type !== "http_request" || !s.secret_headers) return s;
    const kept: Record<string, string> = {};
    // A stored secret only ever goes where it was meant to: the same host and the same path up to the first
    // placeholder. Pointing the step at another host or another API of the host needs the values again.
    const moved = before.has(s.id!) && secretScope(before.get(s.id!)!.url) !== secretScope(s.url);
    for (const [k, v] of Object.entries(s.secret_headers)) {
      if (v === null && moved) throw unprocessable(`Step ${s.id} now sends to another host or path, so secret header ${k} must be given again (it is not reused)`);
      const value = v ?? old[s.id!]?.[k];
      if (value === undefined) throw unprocessable(`Secret header ${k} of step ${s.id} has no stored value; provide it`);
      kept[k] = value;
    }
    secrets[s.id!] = kept;
    return { ...s, secret_headers: Object.fromEntries(Object.keys(s.secret_headers).map((k) => [k, null])) };
  };
  const actions = input.actions.map((s) => (s.type === "for_each" ? { ...s, steps: s.steps.map(strip) } : strip(s))) as Step[];
  if (sendsOut(actions) && input.trigger.type === "event") warnings.push("This automation sends data outside the CRM; its runs are queued and sent by the worker within seconds of the event.");
  const nextRuns = trigger.type === "schedule" ? upcoming(trigger, new Date(), settings.timezone) : null;
  return { input, trigger, obj, webhooks, warnings, actions, secrets, runRoles, settings, nextRuns, summary: describe(input, trigger, webhooks, settings) };
}

/**
 * Warnings for recipients the runs will skip or reach with more than their role shows. Named members of
 * notify and send_email whose role can't read everything the run depends on (automation-access.ts) are
 * skipped each run, as alerts skip theirs. An email to an address from a record, or a fixed one outside the
 * workspace, carries what the run depends on to whoever controls that address, whatever their role:
 * the roles that hide some of it are named, since a member with such a role who can change the address can read it there.
 */
async function recipientWarnings(tx: Tx, ctx: Ctx, schema: Schema, a: Pick<AutomationRow, "trigger" | "condition" | "actions">, warnings: string[]): Promise<void> {
  const steps = allSteps(a.actions);
  const deps = dependencies(schema, a);
  const named = new Set<string>();
  for (const s of steps) {
    if (s.type === "notify") for (const u of await resolveUsers(tx, s.recipients.users ?? [])) named.add(u);
    if (s.type === "send_email" && s.to.member) for (const u of await resolveUsers(tx, [s.to.member])) named.add(u);
  }
  const obj = deps.trigger?.object.api_name ?? [...deps.fields.keys()][0];
  if (named.size && obj) {
    for (const [u, uctx] of await receivers(tx, ctx.tenantId, [...named], obj)) {
      const why = depsHiddenFrom(uctx, schema, deps);
      if (why) warnings.push(`${encodeId("usr", u)} ${why}, so this automation's notifications and emails will skip them until their role can.`);
    }
  }
  if (!steps.some((s) => s.type === "send_email" && (s.to.field !== undefined || s.to.address !== undefined))) return;
  const roles = await liveRoles(tx);
  const hiding: string[] = [];
  for (const r of roles) {
    const why = depsHiddenFrom(await contextForRole(tx, ctx, r as never), schema, deps);
    if (why) hiding.push(`${r.key} (${why})`);
  }
  if (hiding.length) {
    warnings.push(`Emails to addresses outside the workspace carry what this automation reads to whoever holds the address, and some roles can't read it: `
      + `${hiding.slice(0, 5).join("; ")}${hiding.length > 5 ? "; …" : ""}. A run started by such a member's change to the address is skipped, but other paths to the address are not covered.`);
  }
}

function describeStep(s: Step | InnerStep, object: string | null, webhooks: Map<string, WebhookRow>): string {
  const kv = (v: Record<string, unknown>) => Object.entries(v).map(([k, x]) => `${k} = ${JSON.stringify(x)}`).join(", ");
  const gate = s.if !== undefined && s.if !== null ? ` (only if ${JSON.stringify(s.if)})` : "";
  const body = (() => {
    switch (s.type) {
      case "send_webhook": return `send a signed webhook to ${webhooks.get(s.webhook)?.url ?? s.webhook}`;
      case "update_record": return `set ${kv(s.values)} on ${s.record ? `${s.object ?? "the"} record ${s.record}` : `the ${object ?? "record"}`}`;
      case "create_record": return `create a ${s.object} with ${kv(s.values)}`;
      case "notify": return `notify ${[s.recipients.record_owner ? `the ${object}'s owner` : null, s.recipients.users?.length ? s.recipients.users.join(", ") : null].filter(Boolean).join(" and ")} ("${s.title}"; inbox, and email per their preferences)`;
      case "find_records": return `find up to ${s.limit ?? LIMITS.findDefault} ${s.object} records${s.where ? ` matching ${JSON.stringify(s.where)}` : ""}`;
      case "upsert_record": return `create or update a ${s.object} matched on ${s.key}, with ${kv(s.values)}`;
      case "http_request": return `send an HTTP ${s.method} request to ${s.connection ? `${s.url} through connection ${s.connection}` : s.url} (outside the CRM; headers: ${[...Object.keys(s.headers ?? {}), ...Object.keys(s.secret_headers ?? {}).map((k) => `${k} (secret)`)].join(", ") || "none"})`;
      case "send_email": return `email ${s.to.member ? `member ${s.to.member}` : s.to.record_owner ? `the ${object}'s owner` : s.to.field ? `the address in the ${object}'s ${s.to.field} field` : s.to.address} ("${s.subject}")`;
      case "stop": return "stop the run";
      case "for_each": return `for each ${s.items ? `element of ${s.items}` : s.over ? `record found by ${s.over}` : `${s.query!.object} record${s.query!.where ? ` matching ${JSON.stringify(s.query!.where)}` : ""}`} (at most ${s.query?.limit ?? (s.over || s.items ? LIMITS.forEachMax : LIMITS.forEachDefault)}): ${s.steps.map((x) => describeStep(x, s.query?.object ?? "item", webhooks)).join("; then ")}`;
    }
  })();
  return `${body}${gate}`;
}

function describe(input: AutomationInputT, trigger: Trigger, webhooks: Map<string, WebhookRow>, settings: Settings): string {
  let when: string;
  let object: string | null = null;
  if (trigger.type === "event") {
    const [o, action] = trigger.event.split(".");
    object = o!;
    when = action === "stage_changed" ? `When a ${o}'s stage changes` : action === "converted" ? `When a ${o} is converted` : `When a ${o} is ${action}`;
    if (trigger.changed_fields?.length) when += ` (only when ${trigger.changed_fields.join(" or ")} changes)`;
  } else if (trigger.type === "schedule") {
    when = `On a schedule, ${describeSchedule(trigger, settings.timezone)}`;
  } else {
    object = trigger.object ?? null;
    when = `When run on request${object ? ` for a ${object}` : ""}`;
  }
  const cond = input.condition ? ` and it matches ${JSON.stringify(input.condition)}` : "";
  const roles = input.run_roles?.length ? ` Members with role ${input.run_roles.join(", ")} may run it on request.` : "";
  return `${when}${cond}: ${input.actions.map((s) => describeStep(s, object, webhooks)).join("; then ")}. At most ${input.hourly_cap ?? 100} runs per hour.${roles}`;
}

// ----------------------------------------------------------------------------------------------
// CRUD

function parseAutomationId(publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "auto") throw notFound(`Automation ${publicId}`);
  return d.uuid;
}

async function loadAutomation(tx: Tx, publicId: string, forUpdate = false): Promise<AutomationRow> {
  const id = parseAutomationId(publicId);
  const a = await automationById(tx, id, forUpdate);
  if (!a) throw notFound(`Automation ${publicId}`);
  return a;
}

const nextRunFor = (t: Trigger, enabled: boolean, paused: boolean, settings: Settings) =>
  t.type === "schedule" && enabled && !paused ? nextRun(t, new Date(), settings.timezone) : null;

const preview = (v: Validated, enabled: boolean, hourlyCap: number) => ({
  ...v.input, trigger: v.trigger, actions: v.actions, enabled, hourly_cap: hourlyCap, run_roles: v.runRoles,
});

export async function createAutomation(tx: Tx, ctx: Ctx, input: AutomationInputT, dryRun: boolean) {
  const v = await validate(tx, ctx, input, null);
  const extra = { ...(v.nextRuns ? { next_runs: v.nextRuns } : {}) };
  if (dryRun) return { dry_run: true, summary: v.summary, warnings: v.warnings, ...extra, automation: preview(v, input.enabled ?? true, input.hourly_cap ?? 100) };
  const count = await countLiveAutomations(tx);
  if ((count ?? 0) >= 200) throw conflict("A workspace can have at most 200 automations");
  const id = uuidv7();
  const secrets = Object.keys(v.secrets).length ? await encryptValue(tx, ctx.tenantId, id, "automation_secrets", v.secrets) : null;
  await insertAutomation(tx, {
    tenantId: ctx.tenantId, id, name: input.name, description: input.description ?? null, enabled: input.enabled ?? true, trigger: v.trigger,
    condition: input.condition, actions: v.actions, hourlyCap: input.hourly_cap ?? 100, createdBy: ctx.actor.id,
    runRoles: v.runRoles, nextRunAt: nextRunFor(v.trigger, input.enabled ?? true, false, v.settings), secrets,
  });
  await audit(tx, ctx, { action: "automation.created", details: { automation: encodeId("auto", id), trigger: v.trigger.type === "event" ? v.trigger.event : v.trigger.type,
    actions: allSteps(v.actions).map((a) => a.type), ...(sendsOut(v.actions) ? { sends_out: true } : {}) } });
  return { dry_run: false, summary: v.summary, warnings: v.warnings, ...extra, automation: publicAutomation(await loadAutomation(tx, encodeId("auto", id))) };
}

export async function updateAutomation(tx: Tx, ctx: Ctx, publicId: string, patch: Partial<AutomationInputT>, dryRun: boolean) {
  const cur = await loadAutomation(tx, publicId, true);
  if (cur.archived_at) throw conflict(`Automation ${publicId} is archived`);
  const next: AutomationInputT = {
    name: patch.name ?? cur.name, description: patch.description ?? cur.description ?? undefined, enabled: patch.enabled ?? cur.enabled,
    trigger: patch.trigger ?? triggerOf(cur.trigger), condition: patch.condition !== undefined ? patch.condition : cur.condition ?? undefined,
    actions: patch.actions ?? cur.actions, hourly_cap: patch.hourly_cap ?? cur.hourly_cap, run_roles: patch.run_roles ?? cur.run_roles,
  };
  const v = await validate(tx, ctx, next, cur);
  const extra = { ...(v.nextRuns ? { next_runs: v.nextRuns } : {}) };
  if (dryRun) return { dry_run: true, summary: v.summary, warnings: v.warnings, ...extra, automation: { ...publicAutomation(cur), ...preview(v, next.enabled ?? true, next.hourly_cap ?? 100) } };
  const secrets = Object.keys(v.secrets).length ? await encryptValue(tx, ctx.tenantId, cur.id, "automation_secrets", v.secrets) : null;
  await updateAutomationDefinition(tx, cur.id, {
    name: next.name, description: next.description ?? null, enabled: next.enabled ?? true,
    trigger: v.trigger, condition: next.condition,
    actions: v.actions, hourlyCap: next.hourly_cap ?? 100, runRoles: v.runRoles, secrets,
    nextRunAt: nextRunFor(v.trigger, next.enabled ?? true, Boolean(cur.paused_at), v.settings),
  });
  await audit(tx, ctx, { action: "automation.updated", details: { automation: publicId, fields: Object.keys(patch), ...(sendsOut(v.actions) ? { sends_out: true } : {}) } });
  return { dry_run: false, summary: v.summary, warnings: v.warnings, ...extra, automation: publicAutomation(await loadAutomation(tx, publicId)) };
}

export async function archiveAutomation(tx: Tx, ctx: Ctx, publicId: string) {
  const cur = await loadAutomation(tx, publicId, true);
  if (!cur.archived_at) {
    await archiveAutomationRow(tx, cur.id);
    await audit(tx, ctx, { action: "automation.archived", details: { automation: publicId } });
  }
  return publicAutomation(await loadAutomation(tx, publicId));
}

/** The kill switch for one automation: no new runs (event, schedule or request) until it is resumed. Queued runs are skipped. */
export async function pauseAutomation(tx: Tx, ctx: Ctx, publicId: string, reason?: string) {
  const cur = await loadAutomation(tx, publicId, true);
  if (cur.archived_at) throw conflict(`Automation ${publicId} is archived`);
  if (!cur.paused_at) {
    const why = (reason ?? `paused by ${actorRef(ctx.actor.type, ctx.actor.id) ?? "the system"}`).slice(0, 500);
    await pauseAutomationRow(tx, cur.id, why);
    await audit(tx, ctx, { action: "automation.paused", details: { automation: publicId } });
  }
  return publicAutomation(await loadAutomation(tx, publicId));
}

export async function resumeAutomation(tx: Tx, ctx: Ctx, publicId: string) {
  const cur = await loadAutomation(tx, publicId, true);
  if (cur.archived_at) throw conflict(`Automation ${publicId} is archived`);
  if (cur.paused_at) {
    const settings = await loadSettings(tx);
    await resumeAutomationRow(tx, cur.id, nextRunFor(triggerOf(cur.trigger), cur.enabled, false, settings));
    await audit(tx, ctx, { action: "automation.resumed", details: { automation: publicId } });
  }
  return publicAutomation(await loadAutomation(tx, publicId));
}

export async function listAutomations(tx: Tx) {
  return (await liveAutomations(tx)).map(publicAutomation);
}

export async function getAutomation(tx: Tx, publicId: string) {
  return publicAutomation(await loadAutomation(tx, publicId));
}

/** The next runs of a saved schedule automation, or of a draft schedule trigger. */
export async function schedulePreview(tx: Tx, t: { publicId?: string; trigger?: Trigger }, n = 5) {
  const trigger = t.publicId ? triggerOf((await loadAutomation(tx, t.publicId)).trigger) : t.trigger!;
  if (trigger.type !== "schedule") throw unprocessable("Only schedule triggers have upcoming runs");
  checkSchedule(trigger);
  const settings = await loadSettings(tx);
  return { summary: describeSchedule(trigger, settings.timezone), timezone: trigger.timezone ?? settings.timezone,
    next_runs: upcoming(trigger as Schedule, new Date(), settings.timezone, Math.min(Math.max(n, 1), 20)) };
}

export async function listRuns(tx: Tx, publicId: string, limit = 50, status?: string) {
  const a = await loadAutomation(tx, publicId);
  const rows = await runsOf(tx, a.id, status ?? null, Math.min(Math.max(limit, 1), 200));
  const schema = await loadSchema(tx);
  let prefix: string | undefined;
  try {
    prefix = recordObject(schema, triggerOf(a.trigger))?.id_prefix;
  } catch {
    prefix = undefined; // the trigger's object was archived or its module turned off
  }
  return rows.map((r) => ({
    id: encodeId("run", r.id), trigger: r.trigger_kind, event_id: r.event_id ? encodeId("evt", r.event_id) : null,
    record_id: r.record_id && prefix ? encodeId(prefix, r.record_id) : r.input?.record ?? null,
    scheduled_for: r.scheduled_for?.toISOString() ?? null, requested_by: r.requested_by, requested_via: r.input?.via ?? null,
    status: r.status, reason: r.reason,
    // A skip by a workspace or automation cap, and what a failure was caused by ("data" ones don't count towards the automatic pause).
    cap: (r.usage as { cap?: string } | null)?.cap ?? null, failure: (r.usage as { failure?: string } | null)?.failure ?? null,
    depth: r.depth, attempts: r.attempts, usage: r.usage, results: r.results,
    started_at: r.started_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null,
  }));
}

// ----------------------------------------------------------------------------------------------
// Event-triggered runs

/**
 * Runs every enabled automation that listens for this event. Called by the worker inside the
 * tenant transaction that marks the event processed, so runs are exactly-once per event.
 * Automations with HTTP, email or for_each steps are queued instead (the run row is unique per
 * event, so queueing is exactly-once too) and the worker runs them outside event processing.
 */
export async function runAutomationsForEvent(tx: Tx, tenantId: string, event: EventRow): Promise<number> {
  if (!event.object_type || !event.record_id) return 0;
  const autos = await automationsListeningFor(tx, event.type);
  if (autos.length === 0) return 0;
  const settings = await loadSettings(tx);
  if (settings.paused_at) return 0;
  const schema = await loadSchema(tx);
  const obj = schema.objects.get(event.object_type);
  if (!obj || (obj.module && !schema.modules.includes(obj.module))) return 0;
  let ran = 0;
  for (const a of autos) {
    const t = triggerOf(a.trigger);
    if (t.type !== "event") continue;
    const after = (event.data.after ?? {}) as Record<string, unknown>;
    if (t.changed_fields?.length && !t.changed_fields.some((f) => f in after)) continue;
    if (event.data.reference_move && !t.include_reference_moves) continue;
    const runId = uuidv7();
    const record = async (status: string, reason: string | null, results: unknown = [], usage: Record<string, unknown> = {}) => {
      await insertEventRun(tx, { tenantId, id: runId, automationId: a.id, eventId: event.id, recordId: event.record_id, status, reason, depth: event.causation_depth,
        results, finishedAt: status === "queued" ? null : new Date(), usage });
    };
    if (await hasRunForEvent(tx, a.id, event.id)) continue;
    if (event.automation_id === a.id) continue; // never react to your own change
    let matches: boolean;
    try {
      matches = await conditionMatches(tx, schema, obj, event.record_id, a.condition);
    } catch (e) {
      await record("failed", `condition could not be evaluated: ${(e as Error).message}`);
      continue;
    }
    if (!matches) continue;
    if (event.causation_depth >= MAX_DEPTH) {
      await record("skipped", `causation depth limit (${MAX_DEPTH}) reached: automations triggered each other too many times`);
      logger.warn({ tenantId, automation: a.id, event: event.id }, "automation loop stopped by depth limit");
      continue;
    }
    const recent = await recentRunCounts(tx, a.id, event.record_id);
    if ((recent?.n ?? 0) >= a.hourly_cap) {
      await record("skipped", `hourly cap (${a.hourly_cap}) reached`, [], { cap: "hourly" });
      await capNotice(tx, tenantId, a, `hourly:${a.id}`, hourStart(), `hourly cap (${a.hourly_cap}) reached`);
      continue;
    }
    // A loop through something outside the CRM (an HTTP step whose receiver changes the record back) carries no causation depth.
    if ((recent?.same ?? 0) >= LIMITS.sameRecordPer10Min) {
      await record("skipped", `loop guard: already ran ${LIMITS.sameRecordPer10Min} times for this record in 10 minutes`);
      continue;
    }
    if (needsQueue(a.actions)) {
      await record("queued", null);
      ran++;
      continue;
    }
    const state = newState();
    try {
      await tx.savepoint((sp) => execute({ mode: "inline", tenantId, a, event, runId, start: { obj, id: event.record_id! }, depth: event.causation_depth,
        settings, state, unit: (fn) => fn(sp), actor: event.actor_id ? { type: event.actor_type, id: event.actor_id } : null }));
      await record("succeeded", state.stopped, storedResults(state), usageOf(state));
      await afterRun(tx, tenantId, a, "succeeded");
    } catch (e) {
      const f: Failure = failureReason(e);
      await record(f.status, f.reason, storedResults(state), usageOf(state, f));
      await afterRun(tx, tenantId, a, f.status, f);
    }
    ran++;
  }
  return ran;
}

// ----------------------------------------------------------------------------------------------
// Tests, dry runs and runs on request

/** Thrown inside a savepoint to roll back a simulation. */
class Rollback extends Error {
  constructor(readonly value: RunState) { super("rollback"); }
}

/** Simulates a run in a savepoint that is rolled back: nothing is changed, and HTTP and email are described, never sent. */
async function simulate(tx: Tx, ctx: Ctx, a: AutomationRow, start: { obj: ObjectMeta; id: string } | null, draftSecrets: Record<string, Record<string, string>> | null) {
  const settings = await loadSettings(tx);
  const event: EventRow | null = start && triggerOf(a.trigger).type === "event" ? {
    id: uuidv7(), type: (triggerOf(a.trigger) as { event: string }).event, object_type: start.obj.api_name, record_id: start.id, occurred_at: new Date(),
    actor_type: ctx.actor.type, actor_id: ctx.actor.id, surface: ctx.surface, data: { test: true }, causation_depth: 0, automation_id: null,
  } : null;
  const state = newState();
  try {
    await tx.savepoint(async (sp) => {
      await execute({ mode: "simulate", tenantId: ctx.tenantId, a, event, runId: uuidv7(), start, depth: 0, settings, state, draftSecrets, unit: (fn) => fn(sp) });
      throw new Rollback(state);
    });
  } catch (e) {
    if (e instanceof Rollback) {
      return { matched: true, explanation: `${start ? "The record matches. " : ""}These steps would run (nothing was changed or sent).`, actions: storedResults(e.value),
        ...(e.value.stopped ? { stopped: e.value.stopped } : {}) };
    }
    if (e instanceof ApiError || failureReason(e).status === "skipped") {
      const msg = (e as Error).message;
      return { matched: true, explanation: `${start ? "The record matches, but" : "A"} step would fail: ${msg}`, actions: storedResults(state), error: msg };
    }
    throw e;
  }
  throw new Error("unreachable");
}

async function startRecord(tx: Tx, ctx: Ctx, schema: Schema, a: Pick<AutomationRow, "trigger">, record: string | undefined, forRun = false) {
  const obj = recordObject(schema, triggerOf(a.trigger));
  if (!obj) {
    if (record) throw unprocessable("This automation's trigger has no record; leave record out");
    return null;
  }
  const t = triggerOf(a.trigger);
  if (!record) throw unprocessable(`Pass a ${obj.api_name} record ID (${obj.id_prefix}_…)`);
  const d = decodeId(record);
  if (!d || d.prefix !== obj.id_prefix) throw unprocessable(`record must be a ${obj.api_name} ID (${obj.id_prefix}_…)${t.type === "event" ? `, because the trigger is ${t.event}` : ""}`);
  const rec = await getRecord(tx, ctx, obj.api_name, record); // 404 if it does not exist here, or the caller can't read it
  // A merged record's references are on its survivor now (write side, ADR merges): run on that one instead.
  if (forRun && typeof rec.merged_into === "string") {
    throw conflict(`${record} was merged into ${rec.merged_into}; run the automation on that record`, { merged_into: rec.merged_into });
  }
  return { obj, id: d.uuid };
}

/**
 * Runs an automation (saved, or a draft) against one record, or with no record for a schedule, without
 * side effects: every step executes inside a savepoint that is rolled back, webhooks are built but not
 * sent, HTTP requests and emails are described (exact URL and recipient) but not sent.
 */
export async function testAutomation(tx: Tx, ctx: Ctx, args: { automation?: string; draft?: AutomationInputT; record?: string }) {
  let a: AutomationRow;
  let draftSecrets: Record<string, Record<string, string>> | null = null;
  if (args.automation) a = await loadAutomation(tx, args.automation);
  else if (args.draft) {
    const v = await validate(tx, ctx, args.draft, null);
    draftSecrets = v.secrets;
    a = { id: uuidv7(), name: args.draft.name, description: null, enabled: true, trigger: v.trigger, condition: (args.draft.condition ?? null) as Where | null,
      actions: v.actions, hourly_cap: args.draft.hourly_cap ?? 100, version: 0, created_at: new Date(), updated_at: new Date(), archived_at: null,
      paused_at: null, paused_reason: null, consecutive_failures: 0, run_roles: v.runRoles, next_run_at: null, secrets: null };
  } else throw unprocessable("Pass an automation ID or a draft automation");
  const schema = await loadSchema(tx);
  const start = await startRecord(tx, ctx, schema, a, args.record);
  if (start && !(await conditionMatches(tx, schema, start.obj, start.id, a.condition))) {
    return { matched: false, explanation: "The record does not match the condition, so nothing would happen.", actions: [] };
  }
  return simulate(tx, ctx, a, start, draftSecrets);
}

const MANUAL_QUEUE_CAP = LIMITS.queuedManual;

/**
 * The credential a run was requested through, kept with the run (`requested_by` names the member): an API
 * key, a browser session, or an app the member connected over OAuth (its grant and client), as in the audit log.
 */
function requestedVia(ctx: Ctx): Record<string, string> {
  if (ctx.keyId) return { kind: "key", key: encodeId("key", ctx.keyId), surface: ctx.surface };
  if (ctx.oauth) return { kind: "oauth", grant: encodeId("ogr", ctx.oauth.grantId), client: ctx.oauth.clientId, surface: ctx.surface };
  if (ctx.session) return { kind: "session", session: encodeId("ses", ctx.session.id), surface: ctx.surface };
  return { kind: ctx.actor.type, surface: ctx.surface };
}

/**
 * Runs a saved automation now, for one or more records (or none, for a schedule or a record-less manual
 * trigger). The run acts with the automation's access, not the caller's, so running needs
 * automations:manage, or a role the automation's run_roles names together with records:write; such a
 * caller must be able to read every record they pass, and gets run IDs back, never step output (a dry
 * run shows what the automation would do with its own access, so it needs automations:manage).
 * Runs are queued for the worker and count against the hourly cap.
 */
export async function requestRun(tx: Tx, ctx: Ctx, publicId: string, body: { records?: string[]; dry_run?: boolean }) {
  const a = await loadAutomation(tx, publicId, true);
  const manager = can(ctx, "automations:manage");
  if (!manager && !(a.run_roles.includes(ctx.actor.role) && can(ctx, "records:write"))) {
    throw forbidden("Running this automation needs automations:manage, or an admin adding your role to its run_roles");
  }
  if (a.archived_at) throw conflict(`Automation ${publicId} is archived`);
  if (!a.enabled || a.paused_at) throw conflict(`Automation ${publicId} is ${a.paused_at ? "paused" : "disabled"}; resume or enable it first`);
  const settings = await loadSettings(tx);
  if (settings.paused_at) throw conflict("Automations are paused for this workspace");
  const records = [...new Set(body.records ?? [])];
  if (records.length > LIMITS.manualRecords) throw unprocessable(`Run at most ${LIMITS.manualRecords} records at a time`);
  const schema = await loadSchema(tx);
  if (!manager) {
    // A run_roles grant lets a member start what an admin designed, not reach past their own record access: the
    // automation's results would show what it read (a count, a found record) and its writes are theirs to answer for.
    // No detail on which field: that would name what their role hides.
    if (depsHiddenFrom(ctx, schema, dependencies(schema, a))) throw forbidden("This automation depends on records or fields your role can't read, so you can't run it");
    const denied = writeDenied(ctx, writes(schema, a));
    if (denied) throw forbidden(`This automation changes what your role can't: you ${denied}`);
  }
  const obj = recordObject(schema, triggerOf(a.trigger));
  const starts = obj ? await Promise.all((records.length ? records : [undefined]).map((r) => startRecord(tx, ctx, schema, a, r, true)))
    : [await startRecord(tx, ctx, schema, a, records[0], true)];
  if (body.dry_run) {
    if (!manager) throw forbidden("A dry run shows what the automation would do with its own access, so it needs automations:manage");
    const out = [];
    for (const s of starts.slice(0, 5)) {
      const matched = !s || await conditionMatches(tx, schema, s.obj, s.id, a.condition);
      out.push({ record: s ? encodeId(s.obj.id_prefix, s.id) : null, ...(matched ? await simulate(tx, ctx, a, s, null)
        : { matched: false, explanation: "The record does not match the condition, so nothing would happen.", actions: [] }) });
    }
    return { status: 200, body: { dry_run: true, runs: out, ...(starts.length > 5 ? { note: "A dry run shows the first 5 records" } : {}) } };
  }
  const counts = await manualRunCounts(tx, a.id);
  if ((counts?.hour ?? 0) + starts.length > a.hourly_cap) throw new ApiError(429, "rate_limited", `This would pass the automation's hourly cap of ${a.hourly_cap} runs`);
  if ((counts?.open ?? 0) + starts.length > MANUAL_QUEUE_CAP) throw conflict(`At most ${MANUAL_QUEUE_CAP} requested runs of one automation can wait at a time`);
  const who = actorRef(ctx.actor.type, ctx.actor.id);
  const via = requestedVia(ctx);
  const runs: { id: string; record: string | null; status: string }[] = [];
  for (const s of starts) {
    const id = uuidv7();
    const rec = s ? encodeId(s.obj.id_prefix, s.id) : null;
    await insertManualRun(tx, { tenantId: ctx.tenantId, id, automationId: a.id, recordId: s?.id ?? null, requestedBy: who, input: { record: rec, via } });
    runs.push({ id: encodeId("run", id), record: rec, status: "queued" });
  }
  await audit(tx, ctx, { action: "automation.run_requested", details: { automation: publicId, runs: runs.map((r) => r.id), records: runs.map((r) => r.record).filter(Boolean) } });
  return { status: 202, body: { data: { automation: publicId, runs, poll: `/v1/automations/${publicId}/runs` } } };
}

// ----------------------------------------------------------------------------------------------
// Workspace settings and the suppression list

const publicSettings = (s: Settings) => ({
  paused: Boolean(s.paused_at), paused_at: s.paused_at?.toISOString() ?? null, paused_reason: s.paused_reason,
  external_email: s.external_email, timezone: s.timezone,
});

export async function getSettings(tx: Tx) {
  return publicSettings(await loadSettings(tx));
}

/**
 * Pause every automation (the workspace kill switch), allow email to addresses that are not members,
 * and set the time zone schedules default to. Turning external email on is a person's decision: not through MCP.
 */
export async function updateSettings(tx: Tx, ctx: Ctx, patch: { paused?: boolean; reason?: string; external_email?: boolean; timezone?: string }) {
  if (patch.external_email && ctx.surface.endsWith("mcp")) {
    throw forbidden("Email to non-members can't be turned on through MCP. Ask the user to turn it on through the API (PATCH /v1/automation-settings).");
  }
  if (patch.timezone !== undefined && !validTimezone(patch.timezone)) throw unprocessable(`Unknown time zone "${patch.timezone}"; use an IANA name such as America/Denver`);
  const cur = await loadSettings(tx);
  const paused = patch.paused === undefined ? cur.paused_at : patch.paused ? cur.paused_at ?? new Date() : null;
  const reason = patch.paused === undefined ? cur.paused_reason : patch.paused ? (patch.reason ?? `paused by ${actorRef(ctx.actor.type, ctx.actor.id) ?? "the system"}`).slice(0, 500) : null;
  const next = { paused_at: paused, paused_reason: reason, external_email: patch.external_email ?? cur.external_email, timezone: patch.timezone ?? cur.timezone };
  await saveAutomationSettings(tx, ctx.tenantId, next);
  if (patch.timezone !== undefined && patch.timezone !== cur.timezone) {
    // Schedules without their own time zone move with the workspace's.
    for (const a of await scheduledAutomations(tx)) {
      const t = triggerOf(a.trigger);
      if (t.type === "schedule" && !t.timezone) await setNextRun(tx, a.id, nextRun(t, new Date(), next.timezone));
    }
  }
  await audit(tx, ctx, { action: "automation_settings.updated", details: { fields: Object.keys(patch).filter((k) => k !== "reason"), paused: Boolean(next.paused_at), external_email: next.external_email } });
  return publicSettings(next as Settings);
}

function checkAddress(email: string): string {
  const e = email.trim();
  if (!validAddress(e)) throw unprocessable("email must be one plain email address");
  return e;
}

/**
 * Adds an address to the list automations never email, keyed on its mailbox: suppressing `ann@x.com`
 * also stops `ann+news@x.com`, and the other way round. Stored as a keyed hash only. Needs
 * automations:manage (the route's tag): any record writer could otherwise stop the workspace's email to anyone.
 */
export async function suppressEmail(tx: Tx, ctx: Ctx, email: string, reason?: string) {
  const e = checkAddress(email);
  const hash = mailboxHash(ctx.tenantId, e);
  await insertSuppression(tx, ctx.tenantId, hash, reason ?? null, actorRef(ctx.actor.type, ctx.actor.id));
  await audit(tx, ctx, { action: "email.suppressed", details: { recipient: hashLabel(hash) } });
  return { suppressed: true, recipient: hashLabel(hash) };
}

/** Whether automations may email an address. The free-text reason is for those who manage automations only. */
export async function checkSuppression(tx: Tx, ctx: Ctx, email: string) {
  const e = checkAddress(email);
  const hash = mailboxHash(ctx.tenantId, e);
  const row = await suppressionOf(tx, hash, addressHash(ctx.tenantId, e));
  return { suppressed: Boolean(row), recipient: hashLabel(hash), since: row?.created_at.toISOString() ?? null,
    ...(can(ctx, "automations:manage") ? { reason: row?.reason ?? null } : {}) };
}

export async function unsuppressEmail(tx: Tx, ctx: Ctx, email: string) {
  // Like turning external email on: letting automations email someone who asked not to be is a person's decision.
  // Keyed on the surface (a connected app's is fixed by its token), so keys through MCP and OAuth connections are both covered.
  if (ctx.surface.endsWith("mcp")) {
    throw forbidden("Addresses can't be taken off the suppression list through MCP. Ask the user to do it through the API (POST /v1/email-suppressions/remove).");
  }
  const e = checkAddress(email);
  const hash = mailboxHash(ctx.tenantId, e);
  const removed = await deleteSuppression(tx, hash, addressHash(ctx.tenantId, e));
  if (removed) await audit(tx, ctx, { action: "email.unsuppressed", details: { recipient: hashLabel(hash) } });
  return { suppressed: false, recipient: hashLabel(hash), removed };
}

export type { StepResult };
