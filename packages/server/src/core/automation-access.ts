import type { Tx } from "../db/pool.js";
import { canObject, canReadField, fieldAccess, hasHiddenFields } from "./access.js";
import { ownerField, ruleHiddenFrom } from "./alerts.js";
import { recordObject, triggerOf, type AutomationRow, type InnerStep, type Step } from "./automation-defs.js";
import type { Ctx } from "./context.js";
import { roleOfServiceAccount, roleOfUser } from "./queries/automations.js";
import type { Where } from "./query.js";
import { contextForRole } from "./roles.js";
import type { ObjectMeta, Schema } from "./schema.js";
import { placeholders, strings } from "./templates.js";

/**
 * What an automation's runs depend on, and what they write. A notification or email that arrives only
 * when a run took some path tells its recipient what the run looked at, and a member who may run an
 * automation on request sees what it changed: so both must be able to read everything here. Computed
 * from the definition alone (the same at save and at run): the trigger and condition, every `if` filter,
 * every find_records and for_each filter and sort (inside for_each too), and every field a placeholder
 * names, through step outputs to the fields of the records they carry.
 */
export interface Deps {
  /** The trigger record's object and the event, as ruleHiddenFrom takes them. */
  trigger: { object: ObjectMeta; event: string; changed_fields?: string[] } | null;
  /** Object → fields read; "*" for whole records (a placeholder for a step's `first` or `records`). */
  fields: Map<string, Set<string>>;
  /** Filters and the object each runs on. */
  filters: { object: ObjectMeta; where: unknown }[];
  /** Step paths ("2", "3.1") whose gate or text uses another step's output. */
  outputUsers: string[];
  /** Step ids whose output a later step uses: the only outputs a run keeps. */
  usedIds: Set<string>;
}

type AnyStep = Step | InnerStep;

/**
 * The field a name reads: an address part (hq.city) or a json path (meta.a.b) is its field's, with its
 * field's access, so whoever can't read hq can't read hq.city. Any other name is itself.
 */
export function fieldOfName(o: ObjectMeta, name: string): string {
  if (o.byName.has(name)) return name;
  const dot = name.indexOf(".");
  const parent = dot > 0 ? o.byName.get(name.slice(0, dot)) : undefined;
  return parent && (parent.type === "address" || parent.type === "json") ? parent.api_name : name;
}

/** The trigger record's object, or null (a schedule, a manual trigger without one, or an object that is gone: the run fails before any step). */
function startObject(schema: Schema, a: Pick<AutomationRow, "trigger">): ObjectMeta | null {
  try {
    return recordObject(schema, triggerOf(a.trigger));
  } catch {
    return null;
  }
}

/** The object a step's output records belong to, by step id, as far as the definition says. */
function outputObject(s: AnyStep, cur: ObjectMeta | null, schema: Schema): ObjectMeta | null {
  switch (s.type) {
    case "find_records": case "create_record": case "upsert_record": return schema.objects.get(s.object) ?? null;
    case "update_record": return s.record ? (s.object ? schema.objects.get(s.object) ?? null : null) : cur;
    default: return null;
  }
}

export function dependencies(schema: Schema, a: Pick<AutomationRow, "trigger" | "condition" | "actions">): Deps {
  const d: Deps = { trigger: null, fields: new Map(), filters: [], outputUsers: [], usedIds: new Set() };
  const t = triggerOf(a.trigger);
  const start = startObject(schema, a);
  const read = (o: ObjectMeta | null | undefined, f: string) => {
    if (!o) return;
    const set = d.fields.get(o.api_name) ?? new Set<string>();
    set.add(fieldOfName(o, f));
    d.fields.set(o.api_name, set);
  };
  if (start && t.type !== "schedule") {
    d.trigger = { object: start, event: t.type === "event" ? t.event : `${start.api_name}.updated`, ...(t.type === "event" && t.changed_fields ? { changed_fields: t.changed_fields } : {}) };
    if (a.condition) d.filters.push({ object: start, where: a.condition });
  }
  const outputs = new Map<string, ObjectMeta | null>();
  const visit = (s: AnyStep, path: string, cur: ObjectMeta | null) => {
    if (cur) read(cur, "id");
    const g = s.if as { output?: unknown } | null | undefined;
    if (g && typeof g === "object" && !("output" in g) && cur) d.filters.push({ object: cur, where: g });
    if (s.type === "find_records") {
      const o = schema.objects.get(s.object);
      if (o) {
        if (s.where !== undefined) d.filters.push({ object: o, where: s.where });
        for (const x of s.sort ?? []) read(o, x.field);
        read(o, "id");
      }
    }
    if (s.type === "for_each" && s.query) {
      const o = schema.objects.get(s.query.object);
      if (o) {
        if (s.query.where !== undefined) d.filters.push({ object: o, where: s.query.where });
        for (const x of s.query.sort ?? []) read(o, x.field);
      }
    }
    if (s.type === "for_each" && s.over) d.usedIds.add(s.over);
    if (s.type === "send_email" && s.to.field && cur) read(cur, s.to.field);
    if (((s.type === "send_email" && s.to.record_owner) || (s.type === "notify" && s.recipients.record_owner)) && cur) {
      const of = ownerField(cur);
      if (of) read(cur, of);
    }
    let usesOutputs = false;
    for (const text of strings(s.type === "for_each" ? { if: s.if, query: s.query } : s)) {
      for (const p of safePlaceholders(text)) {
        if (p.date) continue;
        const [root, a1, a2, a3, a4] = p.path;
        if (root === "record") read(start, a1!);
        else if (root === "item") read(cur, a1!);
        else if (root === "steps") {
          usesOutputs = true;
          d.usedIds.add(a1!);
          const o = outputs.get(a1!);
          if (o) {
            if (a2 === "first" || a2 === "record") read(o, a3 ?? "*");
            else if (a2 === "records") read(o, a4 ?? "*");
          }
        }
      }
    }
    if (usesOutputs) d.outputUsers.push(path);
    if (s.id) outputs.set(s.id, outputObject(s, cur, schema));
  };
  for (const [i, s] of a.actions.entries()) {
    visit(s, String(i + 1), start);
    if (s.type === "for_each") {
      const src = s.over ? allTop(a.actions).find((x) => x.id === s.over) : null;
      const o = s.query ? schema.objects.get(s.query.object) ?? null : src?.type === "find_records" ? schema.objects.get(src.object) ?? null : null;
      for (const [k, x] of s.steps.entries()) visit(x, `${i + 1}.${k + 1}`, o);
    }
  }
  return d;
}

const allTop = (steps: Step[]): AnyStep[] => steps.flatMap((s) => (s.type === "for_each" ? [s, ...s.steps] : [s]));

/** Step ids a later step reads (`{{steps.<id>…}}`, or a for_each's `over`): the only outputs a run keeps. */
export function stepIdsUsed(actions: Step[]): Set<string> {
  const out = new Set<string>();
  for (const s of allTop(actions)) {
    if (s.type === "for_each" && s.over) out.add(s.over);
    for (const t of strings(s.type === "for_each" ? { if: s.if, query: s.query } : s)) for (const m of t.matchAll(/\{\{\s*steps\.([a-z][a-z0-9_]*)/g)) out.add(m[1]!);
  }
  return out;
}

/** Placeholders of a stored template; one that no longer parses names nothing (the run refuses it anyway). */
function safePlaceholders(text: string) {
  try {
    return placeholders(text);
  } catch {
    return [];
  }
}

/**
 * Does the step at `path` run after a step whose gate or text used another step's output? Inside a
 * for_each, every step of the body counts, since the body runs again after its last step.
 */
export function usesOutputsBefore(d: Deps, path: string): boolean {
  const [top, inner] = path.split(".");
  return d.outputUsers.some((p) => {
    const [pt, pi] = p.split(".");
    if (pt !== top) return Number(pt) < Number(top);
    // The same top step: itself, or for a body step, the for_each's own gate and any step of the body.
    return inner !== undefined || pi === undefined;
  });
}

/**
 * A filter with placeholder values swapped for is_null tests on the same fields: what a reader must be
 * able to see depends on the fields and paths a filter looks at, not on values only known when it runs.
 */
export function fieldsOnly(where: unknown, depth = 0): Where | null {
  if (!where || typeof where !== "object" || depth > 10) return (where ?? null) as Where | null;
  const w = where as Record<string, unknown>;
  for (const k of ["and", "or"] as const) if (Array.isArray(w[k])) return { [k]: (w[k] as unknown[]).map((x) => fieldsOnly(x, depth + 1)) } as Where;
  if (w.not !== undefined) return { not: fieldsOnly(w.not, depth + 1) } as Where;
  return JSON.stringify(w.value ?? null).includes("{{") ? { ...(w.field ? { field: w.field } : {}), ...(w.path ? { path: w.path } : {}), op: "is_null", value: true } as Where : w as Where;
}

/** Why `ctx` can't read everything in `d`, or null. The reason names the object or field (for admins' warnings and run logs). */
export function depsHiddenFrom(ctx: Ctx, schema: Schema, d: Deps): string | null {
  if (d.trigger) {
    const why = ruleHiddenFrom(ctx, schema, d.trigger.object, { type: "event", event: d.trigger.event, changed_fields: d.trigger.changed_fields }, null);
    if (why) return why;
  }
  for (const [name, fields] of d.fields) {
    const o = schema.objects.get(name);
    if (!o) continue;
    if (!canObject(ctx, o, "read")) return `can't read ${name} records`;
    if (fields.has("*") && hasHiddenFields(ctx, o)) return `can't read every ${name} field, and the automation uses whole ${name} records`;
    const hidden = [...fields].filter((f) => f !== "*" && !canReadField(ctx, o, f));
    if (hidden.length) return `can't read ${hidden.map((f) => `${name}.${f}`).join(", ")}`;
  }
  for (const f of d.filters) {
    const why = ruleHiddenFrom(ctx, schema, f.object, { type: "event", event: `${f.object.api_name}.updated` }, fieldsOnly(f.where));
    if (why) return why;
  }
  return null;
}

/** Objects and fields an automation writes: what a member who runs it on request must be able to write themselves. */
export function writes(schema: Schema, a: Pick<AutomationRow, "trigger" | "actions">): { object: ObjectMeta; fields: string[] }[] {
  const start = startObject(schema, a);
  const out: { object: ObjectMeta; fields: string[] }[] = [];
  for (const top of a.actions) {
    const cur = top.type === "for_each"
      ? (top.query ? schema.objects.get(top.query.object) : (() => {
        const src = allTop(a.actions).find((x) => x.id === top.over);
        return src?.type === "find_records" ? schema.objects.get(src.object) : undefined;
      })()) ?? null
      : start;
    for (const s of top.type === "for_each" ? top.steps : [top]) {
      const o = s.type === "update_record" ? (s.record ? (s.object ? schema.objects.get(s.object) : undefined) : cur)
        : s.type === "create_record" || s.type === "upsert_record" ? schema.objects.get(s.object) : undefined;
      if (o) out.push({ object: o, fields: [...new Set(Object.keys((s as { values: Record<string, unknown> }).values).filter((k) => k !== "id" && k !== "related_to").map((k) => fieldOfName(o, k)))] });
    }
  }
  return out;
}

/** Why `ctx` can't write what the automation writes, or null. */
export function writeDenied(ctx: Ctx, w: ReturnType<typeof writes>): string | null {
  for (const { object, fields } of w) {
    if (!canObject(ctx, object, "write")) return `can't write ${object.api_name} records`;
    const denied = fields.filter((n) => {
      const f = object.byName.get(n);
      return f && fieldAccess(ctx, object, f) !== "write";
    });
    if (denied.length) return `can't write ${denied.map((n) => `${object.api_name}.${n}`).join(", ")}`;
  }
  return null;
}

/** A member's (user or service account) role as a context, or null for the system, automations and anyone gone. */
export async function actorCtx(tx: Tx, tenantId: string, type: string | null, id: string | null): Promise<Ctx | null> {
  if (!id || (type !== "user" && type !== "service_account")) return null;
  const m = type === "user"
    ? await roleOfUser(tx, id)
    : await roleOfServiceAccount(tx, id);
  return m ? contextForRole(tx, { tenantId, requestId: "automation-actor" }, m as never) : null;
}
