import { randomUUID } from "node:crypto";
import { canonicalEmail } from "../auth/identity.js";
import { hit, LIMITS as RATE_LIMITS, type Limit } from "../auth/limits.js";
import { config } from "../config.js";
import type { Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { sha256 } from "../lib/crypto.js";
import { ApiError, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { logger, redactSecrets } from "../lib/logger.js";
import { BlockedTargetError, checkUrl, safeRequest } from "../lib/outbound.js";
import { getMailer } from "../providers/mailer.js";
import { ownerField } from "./alerts.js";
import { audit } from "./audit.js";
import { actorCtx, dependencies, depsHiddenFrom, stepIdsUsed, usesOutputsBefore, type Deps } from "./automation-access.js";
import {
  automationCtx, conditionMatches, LIMITS, recordObject, triggerOf,
  type AutomationRow, type InnerStep, type Step, type Trigger,
} from "./automation-defs.js";
import { systemCtx, type Ctx } from "./context.js";
import { decryptValue } from "./encryption.js";
import { emit } from "./events.js";
import { JSON_LIMITS, TEXT_MAX } from "./fieldtypes.js";
import { notifyUser, receivers, resolveUsers } from "./notifications.js";
import {
  activeMemberEmail, automationManagers, claimableRuns, countUsage, dueScheduledAutomations, finishRun, holdsRunLease, insertScheduledRun, leaseRun,
  lockAutomationIfFree, markCapNotice, otherRunInProgress, queuedRunCount, saveRunProgress, scheduleRunCounts, type RunRow,
} from "./queries/automation-runs.js";
import {
  automationById, automationSettings, clearAutomationFailures, clearNextRun, countAutomationFailure, isListedSuppressed, pauseAutomationRow, setNextRun,
  type Settings,
} from "./queries/automations.js";
import { eventById } from "./queries/events.js";
import { activeUserByEmail, currentWorkspaceName } from "./queries/notifications.js";
import type { Where } from "./query.js";
import { createRecord, getRecord, queryRecords, updateRecord, type RecordOut } from "./records.js";
import { nextRun, type Schedule } from "./schedule.js";
import { getObject, loadSchema, type ObjectMeta, type Schema } from "./schema.js";
import {
  budget as cap, DataError, fillDeep, fillString, fillTemplates, fillUrl, hasControl, RESTRICTED, reviveRestricted, samePath,
  type Budget, type TemplateScope,
} from "./templates.js";
import { upsertByKey } from "./transfer.js";
import { buildRequest, enqueueDelivery, loadWebhook, policy, publicEvent, recordForPayload, type EventRow } from "./webhooks.js";

/**
 * Runs automation steps. One interpreter, three ways to run it:
 *   - inline: inside the event-processing transaction (event automations with no HTTP, email or
 *     for_each step), all or nothing with the event, exactly once.
 *   - queued: a run row leased by the worker (schedule ticks, run-now requests, and event automations
 *     that call out). Each step commits on its own with the run's progress, so a run picked up again
 *     after a worker stops resumes after the last finished step. HTTP and email are sent between
 *     transactions; a stop between sending and recording can send that one step twice.
 *   - simulate: dry runs and tests, in a savepoint that is rolled back. HTTP and email are described, never sent.
 */

export interface StepResult { step: string; id?: string; action: string; ok: boolean; skipped?: string; detail: Record<string, unknown> }
export type { Settings };

/**
 * A cap was reached: the run is recorded as skipped, not failed (it does not count towards the automatic
 * pause). `bucket` and `window` name a workspace or automation cap, whose first hit in a window tells the admins.
 */
export class CapReached extends Error {
  constructor(message: string, readonly bucket: string | null = null, readonly window: Date | null = null) {
    super(message);
  }
}
class BudgetExceeded extends Error {}
class LeaseLost extends Error {}
/**
 * Why a run failed, for the automatic pause: "data" is a value from a record or what a target said about
 * it (a 4xx, an address it refused), which outside content can cause, so it never pauses an automation;
 * "target" (5xx, timeouts, DNS, TLS) and "config" (the automation's own definition) do.
 */
export type FailureKind = "data" | "target" | "config";
/** A step that did its work but failed (an HTTP error status, an email the server refused): the run fails with its result logged. */
class StepFailed extends Error {
  constructor(message: string, readonly kind: FailureKind) {
    super(message);
  }
}

type Mode = "inline" | "queued" | "simulate";
interface Cur { obj: ObjectMeta; id: string }

interface RunState {
  /** The last step that finished, by path in run order ("3.2.1"): every step up to it is done. */
  cursor: string | null;
  /** The for_each being gone through: its items, so a run picked up again goes on with the same list. */
  loop: { path: string; object: string; ids: string[] } | null;
  /** Outputs of the steps a later step uses, by step id. */
  vars: Record<string, unknown>;
  results: StepResult[];
  /** Characters of the results kept, each clipped: run history and test replies stay small. */
  resultChars: number;
  omitted: number;
  executed: number;
  http: number;
  emails: number;
  stopped: string | null;
  /** Not saved: what the next save must include (outputs changed; results due, every few steps and around a send). */
  dirty: { vars: boolean; results: boolean; steps: number };
}

interface Env {
  mode: Mode;
  tenantId: string;
  a: AutomationRow;
  trigger: Trigger;
  actx: Ctx;
  event: EventRow | null;
  runId: string;
  start: Cur | null;
  state: RunState;
  startedAt: number;
  deadline: number;
  settings: Settings;
  /** Draft secrets (tests) or the stored ones, decrypted on first use. */
  secrets: Record<string, Record<string, string>> | null;
  /** DB work for one step: the shared transaction, or (queued) a short one that also saves progress. */
  unit: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Who caused the run (the event's actor, or who asked for it): an email to an address they set is checked against their role. */
  actor: { type: string; id: string } | null;
  deps: Deps | null;
  /** Step ids whose output a later step uses: the only outputs kept. */
  used: Set<string>;
}

const MAX_RESULTS = 300;
/** All step results of one run, and one step's detail, in characters once written out. */
const RESULTS_CHARS = 256 * 1024;
const DETAIL_CHARS = 8 * 1024;
/** What a fill may produce, per place it goes (characters). Record values get their field's own maximum. */
const FILL = {
  emailBody: 64 * 1024, subject: 200, header: 2 * 1024, url: 8 * 1024, httpBody: 64 * 1024, title: 500, body: 4000,
  filter: 16 * 1024, gate: 16 * 1024, reason: 500, ref: 300, value: 10_000,
} as const;
const HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_BYTES = 64 * 1024;
const SNIPPET_CHARS = 500;
const LEASE_SECONDS = 120;
const MAX_RUN_ATTEMPTS = 3;
/** Automation email the whole server sends, whatever the workspace: a last resort above every workspace's share (its own store, apart from sign-in email). */
const SERVER_EMAIL: Limit = RATE_LIMITS.automationEmail;

export const newState = (): RunState => ({
  cursor: null, loop: null, vars: {}, results: [], resultChars: 0, omitted: 0, executed: 0, http: 0, emails: 0, stopped: null,
  dirty: { vars: false, results: false, steps: 0 },
});

/**
 * What a queued run saves with each step: the cursor, the loop's items and the per-run counters (so the
 * per-run caps hold across attempts), a few hundred bytes. Outputs go only when one changed, and the
 * step log every RESULTS_EVERY steps and around each send; the run's end writes the full log.
 */
const progressOf = (s: RunState) => ({ cursor: s.cursor, loop: s.loop, counters: { executed: s.executed, http: s.http, emails: s.emails } });
const RESULTS_EVERY = 25;
/** How often a queued run wrote its outputs and step log, for tests and to see the cost of long runs. */
export const progressWrites = { vars: 0, results: 0 };

// ----------------------------------------------------------------------------------------------
// Settings, caps and suppression

export async function loadSettings(tx: Tx): Promise<Settings> {
  const s = await automationSettings(tx);
  return s ?? { paused_at: null, paused_reason: null, external_email: false, timezone: "UTC" };
}

/**
 * Counts one unit against a fixed-window cap, in the caller's transaction (so a rolled-back step
 * gives it back). Throws CapReached once the window is full.
 */
export async function consume(tx: Tx, tenantId: string, bucket: string, cap: number, windowMs: number, what: string): Promise<void> {
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const counted = cap <= 0 ? false : await countUsage(tx, tenantId, bucket, start, cap);
  if (!counted) throw new CapReached(`${what} (${cap}) reached`, bucket, start);
}

const HOUR = 3_600_000;

/** A keyed hash of an address, so suppressions, caps, logs and the audit never hold the address itself. */
export const addressHash = (tenantId: string, email: string): Buffer => sha256(`hlcrm-email:${tenantId}:${canonicalEmail(email)}`);
export const hashLabel = (h: Buffer) => `sha256:${h.toString("hex").slice(0, 16)}`;
/**
 * The mailbox an address reaches: `ann+news@x.com` and `ann@x.com` are one person's. The per-recipient cap
 * and the suppression list key on it, so plus-addressing gets past neither; logs keep the address's own hash.
 */
export const mailbox = (email: string): string => canonicalEmail(email).replace(/^([^@+]*)\+[^@]*@/, "$1@");
export const mailboxHash = (tenantId: string, email: string): Buffer => addressHash(tenantId, mailbox(email));

/**
 * Addresses automations send to: what a record's email field accepts (no spaces, one @, a dot in the
 * domain), minus what could change the message's headers (control characters, the separators of an
 * address list, quotes, comments, brackets). ASCII only: SMTP without SMTPUTF8 can't carry the rest.
 */
const ADDRESS = /^[\x21-\x3f\x41-\x7e]{1,64}@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;
const HEADER_UNSAFE = /[<>,;:"()[\]\\]/;
export const validAddress = (s: string) => s.length <= 254 && ADDRESS.test(s) && !HEADER_UNSAFE.test(s) && !/^\.|\.\.|\.@/.test(s);
/** Why an address from a record can't be emailed, or null. */
export function addressProblem(s: string): string | null {
  if (/[^\x20-\x7e]/.test(s)) return "the address has characters outside ASCII, which automation email doesn't send to";
  return validAddress(s) ? null : "the address is not a single plain email address";
}

export async function isSuppressed(tx: Tx, tenantId: string, email: string): Promise<boolean> {
  // The exact address too: an entry made before suppressions were keyed on the mailbox.
  return isListedSuppressed(tx, mailboxHash(tenantId, email), addressHash(tenantId, email));
}

/** SMTP replies quote recipients ("550 <ann@x.com> rejected"); run logs and server logs never hold one. */
export const scrubAddresses = (s: string) => s.replace(/[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g, "<address>");

// ----------------------------------------------------------------------------------------------
// The interpreter

/**
 * A copy of a value bounded for the run log and test replies: long strings cut, long lists shortened; a
 * detail still larger than DETAIL_CHARS is replaced by a note. The run itself keeps the full value.
 */
function clip(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 1000 ? `${v.slice(0, 1000)}… (${v.length} characters)` : v;
  if (depth > 6) return "…";
  if (!v || typeof v !== "object" || v === RESTRICTED) return v;
  if (Array.isArray(v)) return [...v.slice(0, 50).map((x) => clip(x, depth + 1)), ...(v.length > 50 ? [`… ${v.length - 50} more`] : [])];
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x, depth + 1)]));
}

function pushResult(env: Env, r: StepResult, output: unknown): void {
  let detail = clip(r.detail) as Record<string, unknown>;
  if (JSON.stringify(detail).length > DETAIL_CHARS) detail = { note: `detail left out: larger than ${DETAIL_CHARS / 1024} KB` };
  const kept = { ...r, detail };
  const size = JSON.stringify(kept).length;
  if (env.state.results.length < MAX_RESULTS && env.state.resultChars + size <= RESULTS_CHARS) {
    env.state.results.push(kept);
    env.state.resultChars += size;
  } else env.state.omitted++;
  env.state.cursor = r.step;
  env.state.dirty.steps++;
  if (r.id && env.used.has(r.id)) {
    env.state.vars[r.id] = output ?? null;
    env.state.dirty.vars = true;
    if (JSON.stringify(env.state.vars).length > LIMITS.varsBytes) {
      throw unprocessable(`Step outputs grew past ${LIMITS.varsBytes / 1024} KB; find fewer records`);
    }
  }
}

/** Steps run in path order, a for_each's own path before its items: a path at or before the cursor is done. */
function comparePaths(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}
const isDone = (env: Env, path: string) => env.state.cursor !== null && comparePaths(path, env.state.cursor) <= 0;

/** The run's time limit, checked between steps and inside long ones (loop items, recipients, before each query). */
function deadline(env: Env): void {
  if (Date.now() > env.deadline) throw new BudgetExceeded(`the run took longer than ${Math.round((env.deadline - env.startedAt) / 1000)} s`);
}

function budget(env: Env): void {
  env.state.executed++;
  if (env.state.executed > LIMITS.stepExecutions) throw new BudgetExceeded(`more than ${LIMITS.stepExecutions} steps in one run`);
  deadline(env);
}

async function readRecord(tx: Tx, ctx: Ctx, cur: Cur | null): Promise<RecordOut | null> {
  return cur ? getRecord(tx, ctx, cur.obj.api_name, encodeId(cur.obj.id_prefix, cur.id)).catch(() => null) : null;
}

/** Restricted fields hold the marker, not the text "[restricted]": the automation reads without restricted:read. */
function markRestricted<T extends Record<string, unknown> | null>(obj: ObjectMeta, rec: T): T {
  if (!rec) return rec;
  for (const f of obj.fields) {
    if (f.sensitivity === "restricted" && rec[f.api_name] !== null && rec[f.api_name] !== undefined) (rec as Record<string, unknown>)[f.api_name] = RESTRICTED;
  }
  return rec;
}

/** A record as the automation reads it: its own access, restricted values marked. */
const readOwn = async (tx: Tx, env: Env, cur: Cur | null) => (cur ? markRestricted(cur.obj, await readRecord(tx, env.actx, cur)) : null);

const isItem = (env: Env, cur: Cur | null) => Boolean(cur && (!env.start || cur.id !== env.start.id));

async function scopeFor(tx: Tx, env: Env, cur: Cur | null): Promise<TemplateScope> {
  return {
    record: await readOwn(tx, env, env.start), item: isItem(env, cur) ? await readOwn(tx, env, cur) : null,
    event: env.event ? { type: env.event.type, id: encodeId("evt", env.event.id) } : null,
    steps: env.state.vars, run: { id: encodeId("run", env.runId) }, automation: { id: encodeId("auto", env.a.id), name: env.a.name },
  };
}

const COMPARE: Record<string, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => a === b, neq: (a, b) => a !== b,
  gt: (a, b) => (a as number) > (b as number), gte: (a, b) => (a as number) >= (b as number),
  lt: (a, b) => (a as number) < (b as number), lte: (a, b) => (a as number) <= (b as number),
  in: (a, b) => Array.isArray(b) && b.includes(a), not_in: (a, b) => Array.isArray(b) && !b.includes(a),
  is_null: (a, b) => (b === false ? a !== null && a !== undefined : a === null || a === undefined),
  contains: (a, b) => (typeof a === "string" && typeof b === "string" ? a.toLowerCase().includes(b.toLowerCase()) : Array.isArray(a) && a.includes(b)),
};
export const OUTPUT_OPS = Object.keys(COMPARE);

/** The reason a step's `if` gate skips it, or null when it runs. */
async function gate(tx: Tx, env: Env, step: Step | InnerStep, cur: Cur | null, scope: TemplateScope): Promise<string | null> {
  if (step.if === undefined || step.if === null) return null;
  const g = step.if as { output?: string; op?: string; value?: unknown };
  if (typeof g.output === "string") {
    const v = fillString(g.output, scope, { budget: cap(FILL.gate, "The if output") });
    return COMPARE[g.op!]!(v, g.value) ? null : "its if condition is not met";
  }
  if (!cur) throw unprocessable("This step's if condition needs a current record");
  const schema = await loadSchema(tx);
  const where = fillDeep(step.if, scope, { budget: cap(FILL.filter, "The if condition") }) as Where;
  return (await conditionMatches(tx, schema, cur.obj, cur.id, where)) ? null : "the record does not match its if condition";
}

/** Runs a list of steps for one current record (the trigger record, a for_each item, or none). */
export async function runSteps(env: Env, steps: (Step | InnerStep)[], prefix: string, cur: Cur | null): Promise<void> {
  for (const [i, step] of steps.entries()) {
    if (env.state.stopped) return;
    const path = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    // Done before a restart (the outputs later steps need are in the saved progress); a for_each goes on with its saved items.
    const done = isDone(env, path);
    if (done && step.type !== "for_each") continue;
    if (!done) budget(env);
    if (step.type === "for_each") await runForEach(env, step, path, cur);
    else if ((step.type === "http_request" || step.type === "send_email") && env.mode === "queued") await outbound(env, step, path, cur);
    else await env.unit((tx) => execStep(tx, env, step, path, cur));
  }
}

async function runForEach(env: Env, step: Extract<Step, { type: "for_each" }>, path: string, cur: Cur | null): Promise<void> {
  // Picked up again after a restart: the items it saved, or nothing when the cursor is already past the whole loop.
  const list = isDone(env, path) ? (env.state.loop?.path === path ? env.state.loop : null) : await env.unit(async (tx) => {
    const scope = await scopeFor(tx, env, cur);
    const skip = await gate(tx, env, step, cur, scope);
    if (skip) {
      pushResult(env, { step: path, id: step.id, action: "for_each", ok: true, skipped: skip, detail: {} }, { count: 0, ids: [] });
      return null;
    }
    let object: string;
    let ids: string[];
    let truncated: boolean;
    let max: number;
    if (step.over) {
      const found = env.state.vars[step.over] as { object?: string; ids?: string[]; truncated?: boolean } | null | undefined;
      object = String(found?.object ?? "");
      max = LIMITS.forEachMax;
      ids = (found?.ids ?? []).slice(0, max);
      truncated = Boolean(found?.truncated) || (found?.ids?.length ?? 0) > max;
    } else {
      const q = step.query!;
      max = q.limit ?? LIMITS.forEachDefault;
      const where = fillDeep(q.where, scope, { budget: cap(FILL.filter, "The for_each query") }) as Where | undefined;
      const page = await queryRecords(tx, env.actx, { object: q.object, where, sort: q.sort, limit: max });
      object = q.object;
      ids = page.data.map((r) => r.id);
      truncated = page.next_cursor !== null;
    }
    const detail = { object, count: ids.length, cap: max, ...(truncated ? { truncated: true, note: `More records matched; only the first ${max} were processed (the cap per run)` } : {}) };
    env.state.loop = { path, object, ids };
    pushResult(env, { step: path, id: step.id, action: "for_each", ok: true, detail }, { object, ids, count: ids.length, truncated });
    return env.state.loop;
  });
  if (!list || !list.object) return;
  const obj = getObject(await env.unit((tx) => loadSchema(tx)), list.object);
  for (const [k, publicId] of list.ids.entries()) {
    if (env.state.stopped) return;
    deadline(env);
    const d = decodeId(publicId);
    if (!d) continue;
    await runSteps(env, step.steps, `${path}.${k + 1}`, { obj, id: d.uuid });
  }
}

/**
 * Each field's own longest value: a placeholder can't build a value longer than the field takes. An address
 * is its parts (and the display and keys a whole address placeholder carries along), a json value its 16 KB
 * as stored, a rating, percent or duration a number written out.
 */
const ADDRESS_FILL = 4 * 1024;
const NUMBER_FILL = 64;
function fieldBudgets(obj: ObjectMeta) {
  return (key: string): Budget => {
    const f = obj.byName.get(key);
    const max = !f ? FILL.value
      : f.type === "text" || f.type === "long_text" ? Math.min(f.validation?.max_length ?? Infinity, TEXT_MAX[f.type])
      : f.type === "address" ? ADDRESS_FILL
      : f.type === "json" ? JSON_LIMITS.bytes
      : f.type === "rating" || f.type === "percent" || f.type === "duration" ? NUMBER_FILL
      : FILL.value;
    return cap(max, `${obj.api_name}.${key}`);
  };
}

/**
 * A record write with values filled from records: a value the field refuses comes from a record (a data
 * failure, which never pauses the automation). Without placeholders it is the automation's own mistake.
 */
async function writeValues<T>(values: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError && e.status === 422 && !(e instanceof DataError) && JSON.stringify(values).includes("{{")) throw new DataError(e.message);
    throw e;
  }
}

/**
 * An update of a record that was archived or merged since the run was queued (or that a placeholder names)
 * is refused by the write side (409). That is the record's state, not the automation's setup, so it fails
 * the step as a data failure (never towards the automatic pause) and names the survivor of a merge. A
 * merged record's updates are not redirected to the survivor: the values were meant for the duplicate.
 * A record ID written into the step itself stays a configuration failure.
 */
async function gone(tx: Tx, env: Env, target: Cur, e: unknown, fromData: boolean): Promise<never> {
  if (!(e instanceof ApiError) || e.status !== 409) throw e;
  const publicId = encodeId(target.obj.id_prefix, target.id);
  const rec = await getRecord(tx, env.actx, target.obj.api_name, publicId).catch(() => null);
  if (!rec?.archived_at) throw e;
  const into = typeof rec.merged_into === "string" ? rec.merged_into : null;
  const msg = `update_record: ${publicId} is archived${into ? ` (it was merged into ${into})` : ""}; archived and merged records are not updated`;
  throw fromData ? new DataError(msg) : unprocessable(msg);
}

/** A record named by an ID (or a placeholder for one): its object comes from the ID's prefix. */
function namedRecord(schema: Schema, ref: unknown): Cur {
  const d = typeof ref === "string" ? decodeId(ref) : null;
  const obj = d ? schema.byPrefix.get(d.prefix) : undefined;
  if (!d || !obj) throw unprocessable(`"${String(ref).slice(0, 100)}" is not a record ID`);
  return { obj, id: d.uuid };
}

async function execStep(tx: Tx, env: Env, step: Step | InnerStep, path: string, cur: Cur | null): Promise<void> {
  const scope = await scopeFor(tx, env, cur);
  const base = { step: path, ...(step.id ? { id: step.id } : {}), action: step.type };
  const skip = await gate(tx, env, step, cur, scope);
  if (skip) return pushResult(env, { ...base, ok: true, skipped: skip, detail: {} }, null);
  const simulate = env.mode === "simulate";
  const schema = await loadSchema(tx);
  if (step.type !== "stop") await countAction(tx, env);
  switch (step.type) {
    case "stop":
      env.state.stopped = step.reason ? fillString(step.reason, scope, { target: "text", budget: cap(FILL.reason, "The stop reason") }) as string : `stopped at step ${path}`;
      return pushResult(env, { ...base, ok: true, detail: { reason: env.state.stopped } }, null);
    case "send_webhook": {
      const w = await loadWebhook(tx, step.webhook);
      if (w.archived_at) throw unprocessable(`Webhook ${step.webhook} is archived`);
      const event = cur && env.event && env.start && cur.id === env.start.id ? env.event : syntheticEvent(env, cur, path);
      if (simulate) {
        const rec = await recordForPayload(tx, env.actx, event, false);
        const payload = { ...(await publicEvent(tx, event)), record: rec.record, automation: { id: encodeId("auto", env.a.id), name: env.a.name } };
        const req = await buildRequest(tx, env.tenantId, w, { id: uuidv7(), payload, restricted_values: null });
        return pushResult(env, { ...base, ok: true, detail: { would_send_to: w.url, headers: Object.keys(req.headers), payload } }, null);
      }
      const id = await enqueueDelivery(tx, env.actx, { webhook: w, event, consumer: env.a.id, automation: { id: env.a.id, name: env.a.name } });
      const delivery = id ? encodeId("dlv", id) : "already queued";
      return pushResult(env, { ...base, ok: true, detail: { webhook: step.webhook, delivery } }, { delivery });
    }
    case "update_record": {
      const target = step.record ? namedRecord(schema, fillString(step.record, scope, { budget: cap(FILL.ref, "The record to update") })) : cur;
      if (!target) throw unprocessable("There is no record to update here (no trigger record and no `record`)");
      // Its fields were checked at save against the object the step declares: a record of another object is refused.
      if (step.record && target.obj.api_name !== step.object) {
        throw unprocessable(`update_record: ${encodeId(target.obj.id_prefix, target.id)} is a ${target.obj.api_name}, and this step updates ${step.object ? `${step.object} records` : "the object it declares (set object)"}`);
      }
      const values = fillTemplates(step.values, scope, { budgets: fieldBudgets(target.obj) });
      const rec = markRestricted(target.obj, await writeValues(step.values, () => updateRecord(tx, env.actx, target.obj.api_name, encodeId(target.obj.id_prefix, target.id), values)
        .catch((e) => gone(tx, env, target, e, !step.record || step.record.includes("{{")))));
      return pushResult(env, { ...base, ok: true, detail: { record: rec.id, values, ...(simulate ? { result: rec } : {}) } }, { id: rec.id, record: rec });
    }
    case "create_record": {
      const obj = getObject(schema, step.object);
      const values = fillTemplates(step.values, scope, { budgets: fieldBudgets(obj) });
      const rec = markRestricted(obj, await writeValues(step.values, () => createRecord(tx, env.actx, step.object, values)));
      return pushResult(env, { ...base, ok: true, detail: { object: step.object, record: simulate ? null : rec.id, values, ...(simulate ? { result: rec } : {}) } },
        { id: rec.id, record: rec });
    }
    case "upsert_record": {
      const obj = getObject(schema, step.object);
      const values = fillTemplates(step.values, scope, { budgets: fieldBudgets(obj) });
      const key = step.key;
      const id = key === "id" ? String(values.id ?? "") : undefined;
      if (key === "id") delete values.id;
      if (key !== "id" && (values[key] === undefined || values[key] === null || values[key] === "")) throw unprocessable(`upsert_record: the key ${key} has no value`);
      const out = await writeValues(step.values, () => upsertByKey(tx, env.actx, obj, key, values, id));
      if (out.action === "error") throw JSON.stringify(step.values).includes("{{") ? new DataError(`upsert_record: ${out.reason}`) : unprocessable(`upsert_record: ${out.reason}`);
      const action = out.action === "create" ? "created" : out.action === "update" ? "updated" : "unchanged";
      return pushResult(env, { ...base, ok: true, detail: { object: obj.api_name, key, action, record: simulate && action === "created" ? null : out.id } },
        { id: out.id ?? null, action });
    }
    case "find_records": {
      const limit = step.limit ?? LIMITS.findDefault;
      const where = fillDeep(step.where, scope, { budget: cap(FILL.filter, "The find_records filter") }) as Where | undefined;
      deadline(env);
      const page = await queryRecords(tx, env.actx, { object: step.object, where, sort: step.sort, limit });
      const found = getObject(schema, step.object);
      for (const r of page.data) markRestricted(found, r);
      const ids = page.data.map((r) => r.id);
      const truncated = page.next_cursor !== null;
      return pushResult(env, { ...base, ok: true, detail: { object: step.object, count: ids.length, ids: ids.slice(0, 20), ...(truncated ? { truncated: true, cap: limit } : {}) } },
        { object: step.object, count: ids.length, truncated, ids, records: page.data, first: page.data[0] ?? null });
    }
    case "notify":
      return notifyStep(tx, env, step, base, path, cur, scope);
    case "http_request": {
      const req = await prepareHttp(tx, env, step, scope);
      return pushResult(env, { ...base, ok: true, detail: { would_send: describeHttp(req), sent: false } }, { status: null, ok: null, simulated: true });
    }
    case "send_email": {
      const plan = await prepareEmail(tx, env, step, path, cur, scope);
      return pushResult(env, { ...base, ok: true, ...(plan.skip ? { skipped: plan.skip } : {}),
        detail: plan.skip ? { to: plan.label } : { would_email: { to: plan.to, kind: plan.kind, subject: plan.subject, body: plan.text }, sent: false } }, { sent: 0, simulated: true });
    }
  }
}

function syntheticEvent(env: Env, cur: Cur | null, path: string): EventRow {
  return {
    id: uuidv7(), type: "automation.run", object_type: cur?.obj.api_name ?? null, record_id: cur?.id ?? null, occurred_at: new Date(),
    actor_type: "automation", actor_id: env.a.id, surface: "automation", data: { run: encodeId("run", env.runId), step: path },
    causation_depth: env.actx.causationDepth ?? 1, automation_id: env.a.id,
  };
}

async function countAction(tx: Tx, env: Env): Promise<void> {
  if (env.mode === "simulate") return;
  await consume(tx, env.tenantId, "actions", config().AUTOMATION_ACTIONS_PER_HOUR, HOUR, "the workspace's hourly cap on automation actions");
}

/** The run's dependencies (automation-access.ts), worked out once per run. */
const depsOf = (env: Env, schema: Schema) => (env.deps ??= dependencies(schema, env.a));

/** Notification text, bounded as it is filled: the title and body at the inbox's own limits. */
const notifyText = (step: Extract<InnerStep, { type: "notify" }>, scope: TemplateScope) => ({
  title: String(fillString(step.title, scope, { target: "text", budget: cap(FILL.title, "The notification title") })),
  body: step.body === undefined ? null : String(fillString(step.body, scope, { target: "text", budget: cap(FILL.body, "The notification body") })),
});

async function notifyStep(tx: Tx, env: Env, step: Extract<InnerStep, { type: "notify" }>, base: Omit<StepResult, "ok" | "detail">, path: string, cur: Cur | null, scope: TemplateScope) {
  if (!cur) throw unprocessable("notify needs a record (the trigger record, or a for_each item)");
  const schema = await loadSchema(tx);
  const deps = depsOf(env, schema);
  const current = await readRecord(tx, env.actx, cur);
  const users = new Set(await resolveUsers(tx, step.recipients.users ?? []));
  const of = ownerField(cur.obj);
  if (step.recipients.record_owner && of && typeof current?.[of] === "string") {
    const d = decodeId(current[of] as string);
    if (d) users.add(d.uuid);
  }
  // Only recipients whose role can read the record and everything the run depends on (automation-access.ts).
  // Step outputs were read with the automation's access: after a step that uses them (in a gate or in its
  // text), a recipient whose role limits records gets nothing, since whether this arrives may depend on them.
  const outputs = usesOutputsBefore(deps, path);
  const allowed = [...await receivers(tx, env.tenantId, [...users], cur.obj.api_name)]
    .filter(([, uctx]) => !depsHiddenFrom(uctx, schema, deps) && !(outputs && limited(uctx)));
  if (env.mode === "simulate") {
    const filled = notifyText(step, scope);
    return pushResult(env, { ...base, ok: true, detail: { would_notify: allowed.map(([u]) => encodeId("usr", u)), title: filled.title, body: filled.body } }, null);
  }
  // Each recipient's title and body are filled from the record as their own role sees it.
  const sent: string[] = [];
  for (const [u, uctx] of allowed) {
    deadline(env);
    const mine = notifyText(step, { ...scope, ...(await asSeenBy(tx, env, uctx, cur)) });
    const id = await notifyUser(tx, env.tenantId, u, { source: { automation_id: env.a.id }, recordId: cur.id, object: cur.obj.api_name,
      severity: step.severity ?? "info", title: mine.title, body: mine.body });
    if (id) sent.push(encodeId("ntf", id));
  }
  return pushResult(env, { ...base, ok: true, detail: { notifications: sent } }, { notified: sent.length });
}

/** A member whose role has object or field rules: they may not see everything the automation read. */
const limited = (uctx: Ctx) => Boolean(uctx.records && (uctx.records.objects.size > 0 || uctx.records.fields.size > 0));

/** The trigger record and the current item as a member's role sees them, for what is sent to that member. */
async function asSeenBy(tx: Tx, env: Env, uctx: Ctx, cur: Cur | null): Promise<Pick<TemplateScope, "record" | "item">> {
  const record = await readRecord(tx, uctx, env.start);
  return { record, item: isItem(env, cur) ? await readRecord(tx, uctx, cur) : null };
}

// ----------------------------------------------------------------------------------------------
// HTTP requests

const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection", "keep-alive", "upgrade", "te", "trailer",
  "expect", "proxy-authorization", "proxy-connection"]);
export const headerAllowed = (name: string) => !FORBIDDEN_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith("hlcrm-");

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
interface HttpPlan { method: HttpMethod; url: string; headers: Record<string, string>; secretNames: string[]; body: string | undefined }

async function secretsFor(tx: Tx, env: Env): Promise<Record<string, Record<string, string>>> {
  if (env.secrets) return env.secrets;
  env.secrets = env.a.secrets ? (await decryptValue(tx, env.tenantId, env.a.id, "automation_secrets", env.a.secrets)) as Record<string, Record<string, string>> : {};
  return env.secrets;
}

/**
 * Builds the exact request: the URL's origin is fixed by the automation, placeholders only fill its path
 * (segment by segment, never `.` or `..`) and query, and the parsed URL must keep the template's path.
 * Every part is bounded while it is filled.
 */
async function prepareHttp(tx: Tx, env: Env, step: Extract<InnerStep, { type: "http_request" }>, scope: TemplateScope): Promise<HttpPlan> {
  const url = fillUrl(step.url, scope, { budget: cap(FILL.url, "The request URL") });
  const fixed = new URL(step.url.replace(/\{\{[^{}]*\}\}/g, "x"));
  let parsed: URL;
  try {
    parsed = checkUrl(url, policy());
  } catch (e) {
    if (e instanceof BlockedTargetError) throw unprocessable(e.message.replace(/^Webhook URL/, "The request URL"));
    if (e instanceof TypeError) throw new DataError("The request URL is not a valid URL once its placeholders are filled");
    throw e;
  }
  if (parsed.origin !== fixed.origin) throw unprocessable("The request URL's host changed after filling placeholders"); // encodeURIComponent makes this unreachable
  if (!samePath(step.url, parsed.pathname)) throw new DataError("The request URL's path changed once its placeholders were filled");
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.headers ?? {})) headers[k] = fillString(v, scope, { target: "header", budget: cap(FILL.header, `Header ${k}`) }) as string;
  const secretNames = Object.keys(step.secret_headers ?? {});
  const stored = secretNames.length ? (await secretsFor(tx, env))[step.id ?? ""] ?? {} : {};
  for (const k of secretNames) {
    const v = stored[k];
    if (v === undefined) throw unprocessable(`Secret header ${k} has no stored value; set it again`);
    headers[k] = v;
  }
  const body = step.body === undefined ? undefined : JSON.stringify(fillDeep(step.body, scope, { budget: cap(FILL.httpBody, "The request body") }));
  if (body !== undefined && Buffer.byteLength(body) > HTTP_MAX_BYTES) throw new DataError(`The request body is larger than ${HTTP_MAX_BYTES / 1024} KB`);
  return { method: step.method, url: parsed.toString(), headers, secretNames, body };
}

/** Fields of the current record a URL template fills its path or query from. */
const urlFields = (url: string) => placeholderFields(url, "record");

function placeholderFields(text: string, root: "record" | "item"): string[] {
  return [...text.matchAll(/\{\{\s*(record|item)\.([a-z_][a-z0-9_]*)/g)].filter((m) => m[1] === root).map((m) => m[2]!);
}

/**
 * A step's recipient (an email field, or a URL filled from the record) set by the member whose change
 * started this run, or who chose the record when asking for the run: if that member's role can't read
 * everything the run depends on, the step is skipped. Otherwise a member who can write the email field
 * but can't read a field the message holds could point the message at themselves. The reason, or null.
 */
async function setByLimitedActor(tx: Tx, env: Env, schema: Schema, cur: Cur | null, fields: string[]): Promise<string | null> {
  if (!env.actor || !fields.length || !cur || !env.start || cur.id !== env.start.id) return null;
  const after = (env.event?.data.after ?? {}) as Record<string, unknown>;
  const touched = !env.event || env.event.type.endsWith(".merged") || fields.some((f) => Object.hasOwn(after, f));
  if (!touched) return null;
  const actx = await actorCtx(tx, env.tenantId, env.actor.type, env.actor.id);
  const why = actx && depsHiddenFrom(actx, schema, depsOf(env, schema));
  return why ? `the recipient was set by ${encodeId(env.actor.type === "user" ? "usr" : "svc", env.actor.id)}, whose role ${why}, so this step is skipped` : null;
}

/**
 * How an HTTP error status counts: a 5xx, a timeout (408) or a rate limit (429) is the target's; 401,
 * 403, 404, 405 and 407 mean the automation calls the wrong thing or lacks its key; any other 4xx is
 * the target refusing what it was sent, which came from a record.
 */
const httpKind = (status: number): FailureKind =>
  status >= 500 || status === 408 || status === 429 ? "target" : [401, 403, 404, 405, 407].includes(status) ? "config" : "data";

/** For dry runs: the exact URL and headers, with secret values replaced. */
const describeHttp = (p: HttpPlan) => ({
  method: p.method, url: p.url,
  headers: Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, p.secretNames.includes(k) ? "(secret, not shown)" : v])),
  body: p.body === undefined ? null : JSON.parse(p.body),
});

/** For the run log: no query values (they may carry personal data), header names only. */
function logUrl(raw: string): string {
  const u = new URL(raw);
  const names = [...u.searchParams.keys()];
  return `${u.origin}${u.pathname}${names.length ? `?${names.map((n) => `${n}=…`).join("&")}` : ""}`;
}

/** A short, redacted view of a reply: credential-like keys censored, bounded, no control characters. */
function snippet(body: string): { json: unknown; snippet: string } {
  let json: unknown;
  try {
    json = redactSecrets(JSON.parse(body));
  } catch {
    json = null;
  }
  const text = json === null ? body : JSON.stringify(json);
  return { json, snippet: [...text].filter((ch) => ch === "\n" || ch === "\t" || !hasControl(ch)).join("").slice(0, SNIPPET_CHARS) };
}

// ----------------------------------------------------------------------------------------------
// Email

interface EmailPlan {
  to: string; kind: "member" | "external"; user?: string; label: string; subject: string; text: string; skip?: string; hash: Buffer;
}
const skipped = (label: string, skip: string): EmailPlan => ({ to: "", kind: "external", label, subject: "", text: "", hash: Buffer.alloc(0), skip });

async function workspaceName(tx: Tx): Promise<string> {
  return (await currentWorkspaceName(tx)) ?? "hl-crm-db";
}

/**
 * Resolves the recipient and renders the message. A member (named, the record's owner, or an address that
 * belongs to an active member) follows the notification rule: they must be able to read what the run
 * depends on, and see records as their role does. Any other address needs the workspace's external email
 * switch, is checked against the suppression list and the per-recipient daily cap, and is logged by hash.
 */
async function prepareEmail(tx: Tx, env: Env, step: Extract<InnerStep, { type: "send_email" }>, path: string, cur: Cur | null, scope: TemplateScope): Promise<EmailPlan> {
  const schema = await loadSchema(tx);
  const deps = depsOf(env, schema);
  let address: string | null = null;
  let user: string | null = null;
  if (step.to.member) user = (await resolveUsers(tx, [step.to.member]))[0] ?? null;
  else if (step.to.record_owner) {
    const of = cur && ownerField(cur.obj);
    const rec = await readRecord(tx, env.actx, cur);
    const d = of && typeof rec?.[of] === "string" ? decodeId(rec[of] as string) : null;
    if (!d) throw unprocessable("The record has no owner to email");
    user = d.uuid;
  } else {
    const raw = step.to.address ?? (await readOwn(tx, env, cur))?.[step.to.field!];
    if (raw === RESTRICTED) throw unprocessable("The recipient field is restricted; automations never send restricted values");
    // An address from a record that can't be emailed skips this email (a data problem), not the run.
    if (typeof raw !== "string" || !raw.trim()) return skipped(`(no ${step.to.field})`, `the record has no ${step.to.field} to email`);
    address = raw.trim();
    const problem = addressProblem(address);
    if (problem) return skipped(hashLabel(addressHash(env.tenantId, address)), problem);
    const m = await activeUserByEmail(tx, address);
    if (m) user = m.id;
  }
  const footer = `\n\n--\nSent by an automation of the ${await workspaceName(tx)} workspace (hl-crm-db).`;
  if (user) {
    const u = await activeMemberEmail(tx, user);
    if (!u) throw unprocessable("The member to email is not active");
    const hash = addressHash(env.tenantId, u.email);
    const label = encodeId("usr", user);
    // A member's address follows the same rule as any other (plain ASCII, no list separators): an older
    // member row from before sign-in's ASCII rule may not, and is skipped rather than handed to SMTP.
    const problem = addressProblem(u.email);
    if (problem) return { to: u.email, kind: "member", user, label, subject: "", text: "", hash, skip: `${label}: ${problem}` };
    const objName = cur?.obj.api_name ?? env.start?.obj.api_name ?? "contact";
    const [uctx] = [...(await receivers(tx, env.tenantId, [user], objName)).values()];
    const why = !uctx ? `can't read ${objName} records` : depsHiddenFrom(uctx, schema, deps);
    if (why) return { to: u.email, kind: "member", user, label, subject: "", text: "", hash, skip: `${label} ${why}` };
    // Step outputs were read with the automation's access: after a step that uses them, a member whose role limits records gets no email.
    if (usesOutputsBefore(deps, path) && limited(uctx!)) {
      return { to: u.email, kind: "member", user, label, subject: "", text: "", hash, skip: `${label}'s role limits record access, and this email depends on step outputs` };
    }
    const mine = { ...scope, ...(await asSeenBy(tx, env, uctx!, cur)) };
    return { to: u.email, kind: "member", user, label, hash, ...emailText(step, mine, footer) };
  }
  const hash = addressHash(env.tenantId, address!);
  const label = hashLabel(hash);
  if (!env.settings.external_email) {
    throw unprocessable("Email to addresses that are not members is off for this workspace (PATCH /v1/automation-settings external_email)");
  }
  if (await isSuppressed(tx, env.tenantId, address!)) return { to: address!, kind: "external", label, subject: "", text: "", hash, skip: `${label} is on the suppression list` };
  const actorSkip = step.to.field ? await setByLimitedActor(tx, env, schema, cur, [step.to.field]) : null;
  if (actorSkip) return { to: address!, kind: "external", label, subject: "", text: "", hash, skip: actorSkip };
  return { to: address!, kind: "external", label, hash, ...emailText(step, scope, footer) };
}

/** The subject (one line, 200 characters) and body (64 KB), bounded as they are filled. */
const emailText = (step: Extract<InnerStep, { type: "send_email" }>, scope: TemplateScope, footer: string) => ({
  subject: fillString(step.subject, scope, { target: "subject", budget: cap(FILL.subject, "The subject") }) as string,
  text: (fillString(step.body, scope, { target: "email", budget: cap(FILL.emailBody, "The email body") }) as string) + footer,
});

/** Counts an email against every cap that applies. Past the per-recipient cap the email is skipped, not the run. */
async function emailCaps(tx: Tx, env: Env, plan: EmailPlan): Promise<string | null> {
  const cfg = config();
  if (++env.state.emails > LIMITS.emailsPerRun) throw new CapReached(`more than ${LIMITS.emailsPerRun} emails in one run`);
  await consume(tx, env.tenantId, "email", cfg.AUTOMATION_EMAILS_PER_HOUR, HOUR, "the workspace's hourly cap on automation emails");
  await consume(tx, env.tenantId, `email:${env.a.id}`, cfg.AUTOMATION_EMAILS_PER_AUTOMATION_HOUR, HOUR, "this automation's hourly cap on emails");
  try {
    await consume(tx, env.tenantId, `rcpt:${mailboxHash(env.tenantId, plan.to).toString("hex").slice(0, 40)}`, cfg.AUTOMATION_EMAILS_PER_RECIPIENT_DAY, 24 * HOUR, "per-recipient daily cap");
  } catch (e) {
    if (e instanceof CapReached) return `${plan.label} already got ${cfg.AUTOMATION_EMAILS_PER_RECIPIENT_DAY} automation emails today`;
    throw e;
  }
  return null;
}

// ----------------------------------------------------------------------------------------------
// Outbound steps in queued runs: prepare and count in one transaction, send outside any, record in another.

async function outbound(env: Env, step: Extract<InnerStep, { type: "http_request" | "send_email" }>, path: string, cur: Cur | null): Promise<void> {
  const base = { step: path, ...(step.id ? { id: step.id } : {}), action: step.type };
  type Prepared = { kind: "http"; plan: HttpPlan } | { kind: "email"; plan: EmailPlan } | null;
  const prepared: Prepared = await env.unit(async (tx) => {
    const scope = await scopeFor(tx, env, cur);
    const skip = await gate(tx, env, step, cur, scope);
    if (skip) {
      pushResult(env, { ...base, ok: true, skipped: skip, detail: {} }, null);
      return null;
    }
    await countAction(tx, env);
    if (step.type === "http_request") {
      const actorSkip = await setByLimitedActor(tx, env, await loadSchema(tx), cur, urlFields(step.url));
      if (actorSkip) {
        pushResult(env, { ...base, ok: true, skipped: actorSkip, detail: {} }, null);
        return null;
      }
      if (++env.state.http > LIMITS.httpPerRun) throw new CapReached(`more than ${LIMITS.httpPerRun} HTTP requests in one run`);
      await consume(tx, env.tenantId, "http", config().AUTOMATION_HTTP_PER_HOUR, HOUR, "the workspace's hourly cap on automation HTTP requests");
      return { kind: "http", plan: await prepareHttp(tx, env, step, scope) };
    }
    const plan = await prepareEmail(tx, env, step, path, cur, scope);
    const capped = plan.skip ? null : await emailCaps(tx, env, plan);
    if (plan.skip || capped) {
      pushResult(env, { ...base, ok: true, skipped: plan.skip ?? capped!, detail: { to: plan.label } }, { sent: 0 });
      return null;
    }
    return { kind: "email", plan };
  });
  if (!prepared) return;
  if (prepared.kind === "http") {
    const p = prepared.plan;
    const started = Date.now();
    let res: { status: number; body: string; truncated?: boolean } | null = null;
    let error: string | null = null;
    try {
      res = await safeRequest(p.url, { method: p.method, headers: { "user-agent": "hl-crm-db-automations/1", ...p.headers,
        "hlcrm-automation": encodeId("auto", env.a.id), "hlcrm-run": encodeId("run", env.runId),
        ...(p.body !== undefined ? { "content-type": "application/json" } : {}) }, body: p.body, maxBytes: HTTP_MAX_BYTES, timeoutMs: HTTP_TIMEOUT_MS, truncate: true }, policy());
    } catch (e) {
      error = e instanceof BlockedTargetError ? e.message.replace(/^Webhook URL/, "The request URL").slice(0, 300)
        : (e as Error).message?.startsWith("timed out") ? (e as Error).message.slice(0, 100)
        : `network error${typeof (e as NodeJS.ErrnoException).code === "string" && /^[A-Z0-9_]{2,40}$/.test((e as NodeJS.ErrnoException).code!) ? ` (${(e as NodeJS.ErrnoException).code})` : ""}`;
    }
    const durationMs = Date.now() - started;
    env.state.dirty.results = true; // sent: its record goes with the log, so a restart doesn't send it again
    await env.unit(async (tx) => {
      // With private targets allowed (self-hosted), the target may be an internal service: its reply is not kept or shown, only the status.
      const view = res && !policy().allowInsecure ? snippet(res.body) : { json: null, snippet: "" };
      const ok = Boolean(res && res.status < 400);
      await audit(tx, env.actx, { action: "automation.http_request", details: { automation: encodeId("auto", env.a.id), run: encodeId("run", env.runId),
        step: path, method: p.method, host: new URL(p.url).host, status: res?.status ?? null } });
      const detail = { method: p.method, url: logUrl(p.url), headers: Object.keys(p.headers), status: res?.status ?? null, duration_ms: durationMs,
        ...(error ? { error } : { snippet: view.snippet, ...(res?.truncated ? { truncated: true } : {}) }) };
      pushResult(env, { ...base, ok, detail }, { status: res?.status ?? null, ok, json: view.json, snippet: view.snippet });
    });
    if (error) throw new StepFailed(`step ${path} (http_request): ${error}`, "target");
    if (res && res.status >= 400) throw new StepFailed(`step ${path} (http_request): the server answered HTTP ${res.status}`, httpKind(res.status));
    return;
  }
  const p = prepared.plan;
  let error: string | null = null;
  let kind: FailureKind = "config";
  const mailer = getMailer();
  // The server-wide ceiling is no fault of this automation: the run is skipped (a cap), not failed.
  if (mailer.enabled && hit(SERVER_EMAIL, "all") !== null) throw new CapReached("the server's automation email ceiling was reached; the email was not sent");
  if (!mailer.enabled) error = "email is not configured (SMTP_URL)";
  else {
    try {
      await mailer.send({ to: p.to, subject: p.subject, text: p.text });
    } catch (e) {
      // The mail server's reply can quote the recipient: kept out of the run log. A refused recipient (5.1.x) is the record's address.
      const code = (e as { responseCode?: unknown }).responseCode;
      kind = typeof code === "number" && [501, 550, 551, 553, 555].includes(code) ? "data" : "target";
      error = `sending failed: ${scrubAddresses(String((e as Error).message ?? "")).slice(0, 200)}`;
    }
  }
  env.state.dirty.results = true;
  await env.unit(async (tx) => {
    await audit(tx, env.actx, { action: "automation.email_sent", details: { automation: encodeId("auto", env.a.id), run: encodeId("run", env.runId),
      step: path, recipient: p.kind === "member" ? p.label : hashLabel(p.hash), kind: p.kind, sent: !error } });
    pushResult(env, { ...base, ok: !error, detail: { to: p.label, kind: p.kind, subject_chars: p.subject.length, ...(error ? { error } : {}) } }, { sent: error ? 0 : 1 });
  });
  if (error) throw new StepFailed(`step ${path} (send_email): ${error}`, kind);
}

// ----------------------------------------------------------------------------------------------
// Running

export interface RunArgs {
  mode: Mode; tenantId: string; a: AutomationRow; event: EventRow | null; runId: string; start: Cur | null; depth: number;
  settings: Settings; state?: RunState; draftSecrets?: Record<string, Record<string, string>> | null;
  unit: Env["unit"];
  /** Who caused the run: the event's actor, or the member who asked for it. */
  actor?: { type: string; id: string } | null;
}

/** Runs every step; returns the state (results, stop reason). Throws on failure, with the state on the error. */
export async function execute(args: RunArgs): Promise<RunState> {
  const startedAt = Date.now();
  const env: Env & { startedAt: number } = {
    mode: args.mode, tenantId: args.tenantId, a: args.a, trigger: triggerOf(args.a.trigger), event: args.event, runId: args.runId, start: args.start,
    actx: automationCtx(args.tenantId, args.a.id, args.depth + 1, `${args.mode === "simulate" ? "test" : "run"}:${encodeId("run", args.runId)}`),
    state: args.state ?? newState(), startedAt,
    deadline: startedAt + (args.mode === "inline" ? LIMITS.inlineMs : args.mode === "queued" ? LIMITS.queuedMs : LIMITS.simulateMs),
    settings: args.settings, secrets: args.draftSecrets ?? null, unit: args.unit,
    actor: args.actor ?? null, deps: null, used: stepIdsUsed(args.a.actions),
  };
  try {
    await runSteps(env, env.a.actions, "", args.start);
  } catch (e) {
    throw Object.assign(e as Error, { runState: env.state });
  }
  return env.state;
}

export interface Failure {
  status: "failed" | "skipped"; reason: string;
  /** For a failure: what caused it ("data" never counts towards the automatic pause). */
  kind?: FailureKind;
  /** For a cap: which one (a workspace or automation bucket and its window, or a per-run cap). */
  cap?: { bucket: string | null; window: Date | null };
}

const DATA_NOTE = " (caused by a value from a record or the target's answer to it: not counted towards the automatic pause)";

/** What a failed run records as its reason: our own messages, never driver internals. */
export function failureReason(e: unknown): Failure {
  if (e instanceof CapReached) return { status: "skipped", reason: e.message, cap: { bucket: e.bucket, window: e.window } };
  if (e instanceof BudgetExceeded) return { status: "failed", reason: `work budget: ${e.message}`, kind: "config" };
  if (e instanceof StepFailed) return { status: "failed", reason: `${e.message.slice(0, 900)}${e.kind === "data" ? DATA_NOTE : ""}`, kind: e.kind };
  if (e instanceof DataError) return { status: "failed", reason: `${e.message.slice(0, 900)}${DATA_NOTE}`, kind: "data" };
  if (e instanceof ApiError) return { status: "failed", reason: e.message.slice(0, 1000), kind: "config" };
  const code = (e as { code?: unknown })?.code;
  return { status: "failed", reason: `internal error${typeof code === "string" && /^[A-Z0-9_]{1,40}$/i.test(code) ? ` (${code})` : ""}`, kind: "config" };
}

/** The run's usage, with how it failed or which cap skipped it: run history shows cap skips and data failures apart. */
export const usageOf = (s: RunState | null, f?: Failure | null) => ({
  ...(s ? { steps: s.executed, http: s.http, emails: s.emails } : {}),
  ...(f?.kind ? { failure: f.kind } : {}), ...(f?.cap ? { cap: f.cap.bucket ?? "run" } : {}),
});

/** The results to store for a run: step detail, with a note when the log was cut short. */
export const storedResults = (s: RunState) => (s.omitted ? [...s.results, { step: "…", action: "log", ok: true, detail: { omitted: s.omitted } }] : s.results);

/**
 * After a run ends: a success clears the failure count; a failure adds to it, and after
 * LIMITS.autoPauseAfter in a row the automation pauses itself and admins are told.
 */
export async function afterRun(tx: Tx, tenantId: string, a: AutomationRow, status: string, f?: Failure | null): Promise<void> {
  if (f?.cap?.bucket && f.cap.window) await capNotice(tx, tenantId, a, f.cap.bucket, f.cap.window, f.reason);
  if (status === "succeeded") {
    if (a.consecutive_failures) await clearAutomationFailures(tx, a.id);
    return;
  }
  if (status !== "failed" || f?.kind === "data") return;
  const row = await countAutomationFailure(tx, a.id);
  if (!row || row.paused_at || row.consecutive_failures < LIMITS.autoPauseAfter) return;
  const reason = `paused automatically after ${row.consecutive_failures} failed runs in a row`;
  await pauseAutomationRow(tx, a.id, reason);
  const ctx = systemCtx(tenantId, `auto-pause:${a.id}`);
  await audit(tx, ctx, { action: "automation.paused", details: { automation: encodeId("auto", a.id), reason, automatic: true } });
  await emit(tx, ctx, { type: "automation.paused", data: { automation: { id: encodeId("auto", a.id), name: a.name }, reason } });
  // Runs already queued are skipped, and events while it is paused are not replayed after it resumes: say how many runs that drops now.
  const queued = (await queuedRunCount(tx, a.id)) ?? 0;
  await notifyManagers(tx, tenantId, a, `Automation paused: ${a.name}`, `${reason}. ${queued} queued run${queued === 1 ? "" : "s"} will be skipped, and events `
    + `while it is paused are not run later. See its runs, fix it, then resume it (POST /v1/automations/${encodeId("auto", a.id)}/resume).`);
  logger.warn({ tenantId, automation: a.id }, "automation paused after repeated failures");
}

/** Tells every member who can manage automations (their roles have unrestricted record access by rule), through the inbox. */
async function notifyManagers(tx: Tx, tenantId: string, a: Pick<AutomationRow, "id" | "trigger">, title: string, body: string): Promise<void> {
  const schema = await loadSchema(tx);
  const object = (() => {
    try {
      return recordObject(schema, triggerOf(a.trigger))?.api_name ?? "contact";
    } catch {
      return "contact"; // the trigger's object is gone
    }
  })();
  const admins = await automationManagers(tx);
  for (const u of admins) await notifyUser(tx, tenantId, u.id, { source: { automation_id: a.id }, recordId: null, object, severity: "warning", title, body });
}

/**
 * The first time a workspace or automation cap skips a run in its window, the admins hear about it
 * (once per cap and window: a marker row in automation_usage). Later skips in the window only show in run history.
 */
export async function capNotice(tx: Tx, tenantId: string, a: Pick<AutomationRow, "id" | "name" | "trigger">, bucket: string, window: Date, what: string): Promise<void> {
  const first = await markCapNotice(tx, tenantId, `notice:${bucket}`.slice(0, 100), window);
  if (!first) return;
  await notifyManagers(tx, tenantId, a, `Automation cap reached: ${a.name}`,
    `${what}. Runs past it are skipped (shown as cap skips in its run history) until the window ends; raise the cap or spread the work out.`);
}

// ----------------------------------------------------------------------------------------------
// The worker: schedule ticks and queued runs

/**
 * Enqueues due schedule ticks for one tenant, exactly once each: the automation row is locked, the run
 * row is unique per tick, and next_run_at moves past now in the same transaction. Ticks missed while
 * the worker was down collapse into one run. A tick while the previous run is still open is recorded
 * as skipped, so runs of one automation never overlap. Returns how many automations were due.
 */
export async function scheduleDue(tenantId: string, now = new Date()): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const due = await dueScheduledAutomations(tx, now);
    if (due.length === 0) return 0;
    const settings = await loadSettings(tx);
    for (const a of due) {
      const t = triggerOf(a.trigger);
      if (t.type !== "schedule" || !a.enabled || a.paused_at) {
        await clearNextRun(tx, a.id);
        continue;
      }
      const tick = a.next_run_at!;
      if (!settings.paused_at) {
        const n = await scheduleRunCounts(tx, a.id);
        const capped = !n?.open && (n?.hour ?? 0) >= a.hourly_cap;
        const reason = n?.open ? "the previous run was still in progress" : capped ? `hourly cap (${a.hourly_cap}) reached` : null;
        await insertScheduledRun(tx, { tenantId, id: uuidv7(), automationId: a.id, status: reason ? "skipped" : "queued", reason, scheduledFor: tick,
          finishedAt: reason ? new Date() : null, usage: capped ? { cap: "hourly" } : {} });
        if (capped) await capNotice(tx, tenantId, a, `hourly:${a.id}`, hourStart(), reason!);
      }
      await setNextRun(tx, a.id, nextRun(t as Schedule, now, settings.timezone));
    }
    return due.length;
  });
}

/** The start of the current hour: the window of an automation's hourly_cap, for its cap notice. */
export const hourStart = () => new Date(Math.floor(Date.now() / HOUR) * HOUR);

/** The member who asked for a manual run (usr_… or svc_…), as an actor. */
function requester(ref: string | null): { type: string; id: string } | null {
  const d = ref ? decodeId(ref) : null;
  return d && (d.prefix === "usr" || d.prefix === "svc") ? { type: d.prefix === "usr" ? "user" : "service_account", id: d.uuid } : null;
}

/**
 * Claims one queued run for one tenant and runs it. A run whose automation already has a run in
 * progress waits, so one automation's runs never overlap. Returns false when nothing was claimable.
 */
export async function runQueuedOnce(tenantId: string): Promise<boolean> {
  const lease = randomUUID();
  const claimed = await withTenant(tenantId, async (tx) => {
    const cands = await claimableRuns(tx);
    for (const c of cands) {
      const free = await lockAutomationIfFree(tx, c.automation_id);
      if (!free) continue;
      const busy = await otherRunInProgress(tx, c.automation_id, c.id);
      if (busy) continue;
      const row = await leaseRun(tx, c.id, lease, LEASE_SECONDS);
      return row ?? null;
    }
    return null;
  });
  if (!claimed) return false;
  await runClaimed(tenantId, claimed, lease);
  return true;
}

async function runClaimed(tenantId: string, run: RunRow, lease: string): Promise<void> {
  let auto: AutomationRow | null = null;
  const finish = async (status: string, reason: string | null, state: RunState | null, f: Failure | null = null) => {
    await withTenant(tenantId, async (tx) => {
      const done = await finishRun(tx, run.id, lease, { status, reason, results: state ? storedResults(state) : run.results ?? [], usage: usageOf(state, f) });
      if (done && auto) await afterRun(tx, tenantId, auto, status, f);
    });
  };
  const setup = await withTenant(tenantId, async (tx) => {
    const a = await automationById(tx, run.automation_id);
    const settings = await loadSettings(tx);
    const schema = await loadSchema(tx);
    let event: EventRow | null = null;
    if (run.event_id) {
      event = (await eventById(tx, run.event_id)) ?? null;
    }
    return { a: a ?? null, settings, schema, event };
  });
  auto = setup.a;
  const a = setup.a;
  if (!a || a.archived_at) return finish("skipped", "the automation was archived", null);
  if (!a.enabled || a.paused_at) return finish("skipped", a.paused_at ? "the automation is paused" : "the automation is disabled", null);
  if (setup.settings.paused_at) return finish("skipped", "automations are paused for the workspace", null);
  if (run.attempts > MAX_RUN_ATTEMPTS) return finish("failed", `gave up after ${MAX_RUN_ATTEMPTS} attempts (the worker stopped during the run each time)`, null);
  let obj: ObjectMeta | null;
  try {
    obj = recordObject(setup.schema, triggerOf(a.trigger));
  } catch (e) {
    const f = failureReason(e);
    return finish("failed", f.reason, null, f);
  }
  const recordUuid = run.record_id ?? (run.input?.record ? decodeId(run.input.record)?.uuid ?? null : null);
  const start = obj && recordUuid ? { obj, id: recordUuid } : null;
  const state = newState();
  const p = run.progress;
  if (p) {
    // Picked up again after a worker stopped: from the saved cursor, with the per-run counters it had (so per-run caps hold across attempts).
    Object.assign(state, { cursor: p.cursor ?? null, loop: p.loop ?? null, vars: reviveRestricted(p.vars ?? {}) as Record<string, unknown>, results: run.results ?? [],
      executed: p.counters?.executed ?? 0, http: p.counters?.http ?? 0, emails: p.counters?.emails ?? 0 });
    state.resultChars = JSON.stringify(state.results).length;
  }
  // A run requested by hand for a record checks the condition when it runs (an event run checked it when queued).
  if (run.trigger_kind === "manual" && start && a.condition && !run.progress) {
    const matches = await withTenant(tenantId, (tx) => conditionMatches(tx, setup.schema, start.obj, start.id, a.condition));
    if (!matches) return finish("skipped", "the record does not match the condition", null);
  }
  // Each step's changes commit with the cursor (so a record write is never repeated after a restart), but the
  // outputs only when one changed and the step log every RESULTS_EVERY steps or around a send: a long loop
  // rewrites a few hundred bytes per step, not its whole state. `||` keeps saved keys the update leaves out.
  const unit: Env["unit"] = (fn) => withTenant(tenantId, async (tx) => {
    const held = await holdsRunLease(tx, run.id, lease);
    if (!held) throw new LeaseLost("lease lost");
    const out = await fn(tx);
    const d = state.dirty;
    const results = d.results || d.steps >= RESULTS_EVERY;
    const saved = { ...progressOf(state), ...(d.vars ? { vars: state.vars } : {}) };
    await saveRunProgress(tx, run.id, saved, results ? storedResults(state) : null, LEASE_SECONDS);
    if (d.vars) progressWrites.vars++;
    if (results) progressWrites.results++;
    state.dirty = { vars: false, results: false, steps: results ? 0 : d.steps };
    return out;
  });
  const actor = run.trigger_kind === "manual" ? requester(run.requested_by)
    : setup.event?.actor_id ? { type: setup.event.actor_type, id: setup.event.actor_id } : null;
  try {
    const out = await execute({ mode: "queued", tenantId, a, event: setup.event, runId: run.id, start, depth: run.depth, settings: setup.settings, state, unit, actor });
    await finish("succeeded", out.stopped, out);
  } catch (e) {
    if (e instanceof LeaseLost) return; // another worker owns the run now
    const f = failureReason(e);
    if (f.reason.startsWith("internal error")) logger.error({ tenantId, run: run.id, err: scrubAddresses(String((e as Error).message)) }, "automation run failed");
    await finish(f.status, f.reason, state, f).catch((err: Error) => logger.error({ tenantId, run: run.id, err: err.message }, "could not record an automation run"));
  }
}

/** Tenants with a queued run in progress in this process: each holds one slot until its run ends. */
const inFlight = new Map<string, Promise<boolean>>();
let rotation = 0;

/**
 * One worker pass over every tenant: enqueue due schedule ticks, then start queued runs for tenants
 * that have no run in progress here, up to `concurrency` at once. A tenant holds at most one slot, and
 * a pass does not wait for slow runs to end (unless `wait`), so a tenant with long or many runs can't
 * hold up the others: their runs start on the next pass. Returns how many runs this pass started.
 */
export async function runAutomationPass(tenants: string[], opts: { concurrency?: number; wait?: boolean } = {}): Promise<number> {
  const concurrency = opts.concurrency ?? 4;
  for (const t of tenants) {
    try {
      await scheduleDue(t);
    } catch (e) {
      logger.error({ tenantId: t, err: (e as Error).message }, "automation scheduling failed");
    }
  }
  const started: Promise<boolean>[] = [];
  // Round robin: each pass starts where the last one stopped, so tenants late in the list get slots too.
  const from = tenants.length ? rotation % tenants.length : 0;
  for (const [i, t] of [...tenants.slice(from), ...tenants.slice(0, from)].entries()) {
    if (inFlight.size >= concurrency) {
      rotation = from + i;
      break;
    }
    if (inFlight.has(t)) continue;
    const p = runQueuedOnce(t).catch((e: Error) => {
      logger.error({ tenantId: t, err: e.message }, "automation run failed to start");
      return false;
    }).finally(() => inFlight.delete(t));
    inFlight.set(t, p);
    started.push(p);
  }
  if (opts.wait ?? true) return (await Promise.all(started)).filter(Boolean).length;
  return started.length;
}

export type { Cur, Env, RunState };
