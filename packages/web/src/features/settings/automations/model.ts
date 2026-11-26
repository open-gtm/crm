import type { Automation } from "@/lib/api/types";

/**
 * What the automation screens know about an automation, apart from how it looks: the words for triggers,
 * the draft the editor works on, and how a draft becomes the request body the server validates. The
 * server is the only judge of a definition; nothing here checks more than it takes to build the request.
 */

export type Json = Record<string, unknown>;
export const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// --- Words --------------------------------------------------------------------------------------

/** What happened to a record, for an event's name ("deal.created" → "a deal is created"). */
const EVENT_VERBS: Record<string, string> = {
  created: "is created", updated: "is changed", archived: "is archived", restored: "is restored", deleted: "is deleted", merged: "is merged",
  stage_changed: "changes stage", won: "is won", lost: "is lost", converted: "is converted", assigned: "is assigned", completed: "is completed",
  sent: "is sent", accepted: "is accepted",
};
export function describeEvent(event: string): string {
  const [object, verb] = event.split(".", 2);
  const words = verb ? EVENT_VERBS[verb] : undefined;
  if (!object || !words) return event;
  const thing = object.replaceAll("_", " ");
  return `${/^[aeiou]/.test(thing) ? "an" : "a"} ${thing} ${words}`;
}

/** A trigger in a few words: "When a deal is created", "On a schedule", "Run by hand". */
export function describeTrigger(t: Automation["trigger"]): string {
  if (t.type === "event") {
    if (typeof t.event !== "string") return "When an event happens";
    const words = describeEvent(t.event);
    return words === t.event ? `When ${t.event}` : `When ${words} (${t.event})`;
  }
  if (t.type === "schedule") return "On a schedule";
  if (t.type === "manual") return typeof t.object === "string" ? `Run by hand on ${t.object} records` : "Run by hand";
  return String(t.type ?? "Unknown trigger");
}

export type Shown = "active" | "failing" | "paused" | "off";
/** The state a person sees: failing is an active automation whose recent runs failed (the API's count), not a state of its own. */
export function shownStatus(a: Pick<Automation, "status" | "consecutive_failures">): Shown {
  if (a.status === "paused") return "paused";
  if (a.status === "enabled") return (a.consecutive_failures ?? 0) > 0 ? "failing" : "active";
  return "off";
}

export const SHOWN_LABEL: Record<Shown, string> = { active: "Active", failing: "Failing", paused: "Paused", off: "Off" };
export const SHOWN_TONE = { active: "success", failing: "danger", paused: "warning", off: "neutral" } as const;
export const RUN_TONE = { succeeded: "success", failed: "danger", skipped: "warning", queued: "neutral", running: "accent" } as const;

// --- Triggers -----------------------------------------------------------------------------------

/** The record actions every object has, then the named events of particular objects (docs/automations.md, Triggers). */
export const EVENT_ACTIONS = ["created", "updated", "archived", "restored", "merged"] as const;
export const NAMED_EVENTS: { object: string; action: string }[] = [
  { object: "deal", action: "stage_changed" }, { object: "lead", action: "converted" }, { object: "quote", action: "sent" }, { object: "quote", action: "accepted" },
];
export const actionLabel = (a: string) => a.replaceAll("_", " ");

export const SCHEDULE_RULES = ["every_minutes", "every_hours", "daily", "weekly", "monthly"] as const;
export type ScheduleRule = (typeof SCHEDULE_RULES)[number];
export const SCHEDULE_LABEL: Record<ScheduleRule, string> = {
  every_minutes: "Every N minutes", every_hours: "Every N hours", daily: "Every day", weekly: "On certain weekdays", monthly: "Once a month",
};
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export function scheduleRuleOf(t: Json): ScheduleRule | null {
  if (isJson(t.every)) return typeof t.every.hours === "number" ? "every_hours" : "every_minutes";
  if (isJson(t.daily)) return "daily";
  if (isJson(t.weekly)) return "weekly";
  if (isJson(t.monthly)) return "monthly";
  return null;
}

/** A trigger with only its type's own keys and a sensible first value, for when the type is changed. */
export function defaultTrigger(type: string): Json {
  if (type === "schedule") return { type: "schedule", daily: { at: "09:00" } };
  if (type === "manual") return { type: "manual" };
  return { type: "event", event: "contact.created" };
}

/** One schedule rule with its first values, keeping the time zone. */
export function scheduleWith(t: Json, rule: ScheduleRule): Json {
  const out: Json = { type: "schedule" };
  if (typeof t.timezone === "string" && t.timezone) out.timezone = t.timezone;
  if (rule === "every_minutes") out.every = { minutes: 30 };
  else if (rule === "every_hours") out.every = { hours: 6 };
  else if (rule === "daily") out.daily = { at: "09:00" };
  else if (rule === "weekly") out.weekly = { days: ["mon"], at: "09:00" };
  else out.monthly = { day: 1, at: "09:00" };
  return out;
}

// --- Steps --------------------------------------------------------------------------------------

export const STEP_TYPES: { type: string; label: string; hint: string }[] = [
  { type: "update_record", label: "Change a record", hint: "update_record" },
  { type: "create_record", label: "Create a record", hint: "create_record" },
  { type: "upsert_record", label: "Create or update a record", hint: "upsert_record" },
  { type: "find_records", label: "Find records", hint: "find_records" },
  { type: "notify", label: "Notify people", hint: "notify" },
  { type: "send_webhook", label: "Send a webhook", hint: "send_webhook" },
  { type: "http_request", label: "Call another system", hint: "http_request" },
  { type: "send_email", label: "Send an email", hint: "send_email" },
  { type: "for_each", label: "Repeat for each record", hint: "for_each" },
  { type: "stop", label: "Stop", hint: "stop" },
];
export const stepLabel = (type: unknown) => STEP_TYPES.find((s) => s.type === type)?.label ?? String(type ?? "Step");
/** Steps that have a structured form; the others are edited as JSON. */
export const FORM_STEPS = new Set(["update_record", "create_record", "notify", "send_webhook", "http_request", "send_email", "stop"]);

export function newStep(type: string): Json {
  switch (type) {
    case "update_record": return { type, values: {} };
    case "create_record": return { type, object: "", values: {} };
    case "upsert_record": return { type, object: "", key: "", values: {} };
    case "find_records": return { type, object: "", limit: 25 };
    case "notify": return { type, title: "", recipients: { record_owner: true } };
    case "send_webhook": return { type, webhook: "" };
    case "http_request": return { type, method: "POST", url: "" };
    case "send_email": return { type, to: { record_owner: true }, subject: "", body: "" };
    case "for_each": return { type, query: { object: "", limit: 50 }, steps: [] };
    default: return { type };
  }
}

// --- Values typed as text ------------------------------------------------------------------------

/**
 * A value a person types for a field: a number, true/false, null, a list or an object is sent as that
 * (so `5` is the number 5), anything else as text. Text that would read as one of those is quoted.
 */
export function textToValue(t: string): unknown {
  const s = t.trim();
  if (s === "") return "";
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return t;
  }
}
export function valueToText(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v) ?? "";
  return textToValue(v) === v ? v : JSON.stringify(v);
}

// --- Secrets ------------------------------------------------------------------------------------

/**
 * A step as it is shown as JSON: a secret header's value never appears. The server returns null for
 * the ones it holds and a value typed here is not echoed, so both read as null.
 */
export function maskSecrets(step: Json): Json {
  if (!isJson(step.secret_headers)) return step;
  return { ...step, secret_headers: Object.fromEntries(Object.keys(step.secret_headers).map((k) => [k, null])) };
}
/** A step read back from JSON text: a null secret goes back to what was typed before, or stays null (the server keeps its stored value). */
export function restoreSecrets(next: Json, before: Json | undefined): Json {
  if (!isJson(next.secret_headers)) return next;
  const prev = before && isJson(before.secret_headers) ? before.secret_headers : {};
  return { ...next, secret_headers: Object.fromEntries(Object.entries(next.secret_headers).map(([k, v]) => [k, v === null && typeof prev[k] === "string" ? prev[k] : v])) };
}

// --- The draft ----------------------------------------------------------------------------------

export interface DraftStep { key: string; value: Json }
export interface Draft {
  name: string; description: string; trigger: Json;
  /** The condition as JSON text; empty means none. */
  condition: string; steps: DraftStep[]; hourlyCap: string;
}

let counter = 0;
export const stepKey = () => `s${++counter}`;

export const emptyDraft = (): Draft => ({ name: "", description: "", trigger: defaultTrigger("event"), condition: "", steps: [], hourlyCap: "" });

export function draftOf(a: Automation): Draft {
  return {
    name: a.name, description: a.description ?? "",
    trigger: isJson(a.trigger) ? { ...a.trigger } : defaultTrigger("event"),
    condition: a.condition === null || a.condition === undefined ? "" : JSON.stringify(a.condition, null, 2),
    steps: (a.actions ?? []).map((value) => ({ key: stepKey(), value })),
    hourlyCap: String(a.hourly_cap),
  };
}

export interface Built {
  /** The request body, or null while the draft can't be turned into one. */
  body: Json | null;
  /** Why not, in plain words (shown beside the form). */
  problems: string[];
  /** Whether the draft has what the server needs before it can say anything (a name and a step). */
  complete: boolean;
}

/** The request body for the draft. `existing` sends `null` for an emptied condition, which clears it on a change. */
export function buildBody(d: Draft, existing: boolean): Built {
  const problems: string[] = [];
  let condition: unknown;
  if (d.condition.trim() !== "") {
    try {
      condition = JSON.parse(d.condition) as unknown;
    } catch {
      problems.push("The condition is not valid JSON.");
    }
  } else if (existing) condition = null;
  let cap: number | undefined;
  if (d.hourlyCap.trim() !== "") {
    cap = Number(d.hourlyCap);
    if (!Number.isInteger(cap)) problems.push("The hourly cap must be a whole number.");
  }
  const complete = d.name.trim() !== "" && d.steps.length > 0;
  if (problems.length) return { body: null, problems, complete };
  const body: Json = {
    name: d.name.trim(), ...(existing || d.description.trim() ? { description: d.description.trim() } : {}),
    trigger: d.trigger, ...(condition !== undefined ? { condition } : {}), actions: d.steps.map((s) => s.value),
    ...(cap !== undefined ? { hourly_cap: cap } : {}),
  };
  return { body, problems, complete };
}

/** The draft as the whole-automation JSON view shows it: the body, without secret header values. */
export function draftJson(d: Draft): string {
  let condition: unknown;
  try {
    condition = d.condition.trim() ? (JSON.parse(d.condition) as unknown) : undefined;
  } catch {
    condition = d.condition;
  }
  return JSON.stringify({
    name: d.name, ...(d.description ? { description: d.description } : {}), trigger: d.trigger, ...(condition !== undefined ? { condition } : {}),
    actions: d.steps.map((s) => maskSecrets(s.value)), ...(d.hourlyCap.trim() ? { hourly_cap: Number(d.hourlyCap) || d.hourlyCap } : {}),
  }, null, 2);
}

/** Reads the whole-automation JSON view back into a draft, or says why it can't. */
export function draftFromJson(text: string, before: Draft): { draft: Draft } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text) as unknown;
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : "could not read it"}.` };
  }
  if (!isJson(v)) return { error: "The automation must be a JSON object." };
  if (v.name !== undefined && typeof v.name !== "string") return { error: "name must be text." };
  if (v.description !== undefined && typeof v.description !== "string") return { error: "description must be text." };
  if (!isJson(v.trigger)) return { error: "trigger must be an object." };
  if (v.actions !== undefined && (!Array.isArray(v.actions) || !v.actions.every(isJson))) return { error: "actions must be a list of steps." };
  const actions = (v.actions ?? []) as Json[];
  return {
    draft: {
      name: v.name ?? "", description: v.description ?? "", trigger: v.trigger,
      condition: v.condition === undefined || v.condition === null ? "" : JSON.stringify(v.condition, null, 2),
      steps: actions.map((value, i) => ({ key: before.steps[i]?.key ?? stepKey(), value: restoreSecrets(value, before.steps[i]?.value) })),
      hourlyCap: v.hourly_cap === undefined ? "" : String(v.hourly_cap),
    },
  };
}

// --- Server answers -----------------------------------------------------------------------------

export interface WriteResult { dry_run: boolean; summary: string; warnings: string[]; next_runs?: string[]; automation: Automation }
export interface TestResult { matched: boolean; explanation: string; actions: Json[]; stopped?: string; error?: string }
export interface QueuedRun { id: string; record: string | null; status: string }

/** The path of an error ("actions.2.values") and its message, from whichever shape the server's `errors` has. */
export function problemLines(errors: unknown): { path: string; message: string }[] {
  const list = Array.isArray(errors) ? errors : isJson(errors) && Array.isArray(errors.errors) ? errors.errors : [];
  const out: { path: string; message: string }[] = [];
  for (const e of list) {
    if (!isJson(e)) continue;
    const raw = e.path ?? e.field;
    const path = Array.isArray(raw) ? raw.join(".") : typeof raw === "string" ? raw : "";
    out.push({ path, message: typeof e.message === "string" ? e.message : "is not valid" });
  }
  return out;
}

/** The index of the step an error path names ("actions.2.values" or "actions[2]"), or null. */
export function stepIndexOf(path: string): number | null {
  const m = /^actions(?:\.|\[)(\d+)/.exec(path);
  return m ? Number(m[1]) : null;
}
