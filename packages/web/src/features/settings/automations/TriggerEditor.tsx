import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useObjects } from "@/meta/hooks";
import {
  actionLabel, defaultTrigger, EVENT_ACTIONS, isJson, NAMED_EVENTS, scheduleRuleOf, scheduleWith, SCHEDULE_LABEL, SCHEDULE_RULES, WEEKDAYS, type Json, type ScheduleRule,
} from "./model";

/** The objects the member can read, plus one the automation already names that they can't see (so the select never misreports it). */
function useObjectNames(extra?: string): { name: string; label: string }[] {
  const q = useObjects();
  const all = (q.data ?? []).map((o) => ({ name: o.name, label: o.label }));
  return extra && !all.some((o) => o.name === extra) ? [...all, { name: extra, label: extra }] : all;
}

/** Which object an automation names, as a select; `none` adds an "any / no record" choice. */
export function ObjectSelect({ label, value, onChange, none, hint, id }: {
  label: string; value: string; onChange: (v: string) => void; none?: string; hint?: string; id?: string;
}) {
  const objects = useObjectNames(value || undefined);
  return (
    <FormField label={label} hint={hint}>
      {(a) => (
        <NativeSelect {...a} id={id ?? a.id} value={value} onChange={(e) => onChange(e.target.value)}>
          {none !== undefined ? <option value="">{none}</option> : <option value="" disabled>Choose an object</option>}
          {objects.map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}
        </NativeSelect>
      )}
    </FormField>
  );
}

const num = (v: string): number | string => (v.trim() === "" ? "" : Number(v));
const field = (t: Json, key: string): Json => (isJson(t[key]) ? (t[key] as Json) : {});

/** The three kinds of trigger, each with exactly the fields the server's schema has (docs/automations.md, Triggers). */
export function TriggerEditor({ trigger, onChange }: { trigger: Json; onChange: (t: Json) => void }) {
  const type = typeof trigger.type === "string" ? trigger.type : "event";
  return (
    <div className="grid gap-3.5">
      <FormField label="Starts">
        {(a) => (
          <NativeSelect {...a} value={["event", "schedule", "manual"].includes(type) ? type : "other"} onChange={(e) => onChange(defaultTrigger(e.target.value))}>
            <option value="event">When a record event happens</option>
            <option value="schedule">On a schedule</option>
            <option value="manual">When someone asks for it</option>
            {["event", "schedule", "manual"].includes(type) ? null : <option value="other" disabled>{type} (edit as JSON)</option>}
          </NativeSelect>
        )}
      </FormField>
      {type === "event" ? <EventFields trigger={trigger} onChange={onChange} /> : null}
      {type === "schedule" ? <ScheduleFields trigger={trigger} onChange={onChange} /> : null}
      {type === "manual" ? (
        <ObjectSelect label="Run on records of" none="No record (runs by itself)" value={typeof trigger.object === "string" ? trigger.object : ""}
          hint="Leave empty for an automation that needs no record. Otherwise you name a record when you run it."
          onChange={(v) => onChange(v ? { type: "manual", object: v } : { type: "manual" })} />
      ) : null}
    </div>
  );
}

function EventFields({ trigger, onChange }: { trigger: Json; onChange: (t: Json) => void }) {
  const event = typeof trigger.event === "string" ? trigger.event : "";
  const [object = "", action = ""] = event.split(".", 2);
  const named = NAMED_EVENTS.filter((n) => n.object === object).map((n) => n.action);
  const actions = [...EVENT_ACTIONS, ...named, ...(action && ![...EVENT_ACTIONS, ...named].some((a) => a === action) ? [action] : [])];
  const changed = Array.isArray(trigger.changed_fields) ? trigger.changed_fields.filter((x): x is string => typeof x === "string") : [];
  // Keep only the keys that belong to the event the trigger now names.
  const set = (next: { object?: string; action?: string }) => {
    const o = next.object ?? object;
    let a = next.action ?? action;
    if (next.object !== undefined && !EVENT_ACTIONS.some((x) => x === a) && !NAMED_EVENTS.some((n) => n.object === o && n.action === a)) a = "created";
    const out: Json = { type: "event", event: `${o}.${a}` };
    if (a === "updated" && changed.length) out.changed_fields = changed;
    if ((a === "updated" || a === "archived") && trigger.include_reference_moves === true) out.include_reference_moves = true;
    onChange(out);
  };
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <ObjectSelect label="Record type" value={object} onChange={(v) => set({ object: v })} />
        <FormField label="What happens">
          {(a) => <NativeSelect {...a} value={action} onChange={(e) => set({ action: e.target.value })}>{actions.map((x) => <option key={x} value={x}>{actionLabel(x)}</option>)}</NativeSelect>}
        </FormField>
      </div>
      {action === "updated" ? (
        <FormField label="Only when one of these fields changed" hint="Field names separated by commas. Leave empty to run on any change.">
          {(a) => (
            <Input {...a} className="font-mono" defaultValue={changed.join(", ")} onChange={(e) => {
              const list = e.target.value.split(/[\s,]+/).filter(Boolean);
              const { changed_fields: _drop, ...rest } = trigger;
              onChange(list.length ? { ...rest, changed_fields: list } : rest);
            }} />
          )}
        </FormField>
      ) : null}
      {action === "updated" || action === "archived" ? (
        <label className="flex items-start gap-2 text-base">
          <Checkbox checked={trigger.include_reference_moves === true} onCheckedChange={(v) => {
            const { include_reference_moves: _drop, ...rest } = trigger;
            onChange(v === true ? { ...rest, include_reference_moves: true } : rest);
          }} className="mt-0.5" />
          <span>Also run when a merge only moved a reference on the record<span className="block text-sm text-subtle">Off by default: one merge can touch many records.</span></span>
        </label>
      ) : null}
    </>
  );
}

function ScheduleFields({ trigger, onChange }: { trigger: Json; onChange: (t: Json) => void }) {
  const rule = scheduleRuleOf(trigger) ?? "daily";
  const tz = typeof trigger.timezone === "string" ? trigger.timezone : "";
  const put = (key: "every" | "daily" | "weekly" | "monthly", v: Json) => onChange({ ...trigger, [key]: v });
  const every = field(trigger, "every"), daily = field(trigger, "daily"), weekly = field(trigger, "weekly"), monthly = field(trigger, "monthly");
  const days = Array.isArray(weekly.days) ? weekly.days.filter((d): d is string => typeof d === "string") : [];
  const time = (key: "daily" | "weekly" | "monthly", cur: Json) => (
    <FormField label="At (24-hour time)">
      {(a) => <Input {...a} type="time" value={typeof cur.at === "string" ? cur.at : ""} onChange={(e) => put(key, { ...cur, at: e.target.value })} />}
    </FormField>
  );
  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <FormField label="Repeats">
          {(a) => <NativeSelect {...a} value={rule} onChange={(e) => onChange(scheduleWith(trigger, e.target.value as ScheduleRule))}>{SCHEDULE_RULES.map((r) => <option key={r} value={r}>{SCHEDULE_LABEL[r]}</option>)}</NativeSelect>}
        </FormField>
        {rule === "every_minutes" ? (
          <FormField label="Minutes" hint="At least 15, at most 1440. Ticks line up with the clock in UTC.">
            {(a) => <Input {...a} type="number" min={15} max={1440} value={String(every.minutes ?? "")} onChange={(e) => put("every", { minutes: num(e.target.value) })} />}
          </FormField>
        ) : null}
        {rule === "every_hours" ? (
          <FormField label="Hours" hint="At most 168. Ticks line up with the clock in UTC.">
            {(a) => <Input {...a} type="number" min={1} max={168} value={String(every.hours ?? "")} onChange={(e) => put("every", { hours: num(e.target.value) })} />}
          </FormField>
        ) : null}
        {rule === "daily" ? time("daily", daily) : null}
        {rule === "monthly" ? (
          <FormField label="Day of the month" hint="A day past the month's end runs on its last day.">
            {(a) => (
              <NativeSelect {...a} value={String(monthly.day ?? 1)} onChange={(e) => put("monthly", { ...monthly, day: e.target.value === "last" ? "last" : Number(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={String(i + 1)}>{i + 1}</option>)}
                <option value="last">Last day</option>
              </NativeSelect>
            )}
          </FormField>
        ) : null}
      </div>
      {rule === "weekly" ? (
        <div className="grid gap-3.5 sm:grid-cols-2">
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-muted">Days</legend>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {WEEKDAYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 text-base">
                  <Checkbox checked={days.includes(d)} onCheckedChange={(v) => put("weekly", { ...weekly, days: WEEKDAYS.filter((x) => (x === d ? v === true : days.includes(x))) })} aria-label={d} />
                  <span className="capitalize">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {time("weekly", weekly)}
        </div>
      ) : null}
      {rule === "monthly" ? <div className="sm:w-1/2">{time("monthly", monthly)}</div> : null}
      <FormField label="Time zone" hint="An IANA name such as Europe/Berlin. Leave empty to use the workspace's time zone.">
        {(a) => (
          <Input {...a} className="font-mono sm:w-1/2" placeholder="Workspace time zone" value={tz} onChange={(e) => {
            const { timezone: _drop, ...rest } = trigger;
            onChange(e.target.value.trim() ? { ...rest, timezone: e.target.value.trim() } : rest);
          }} />
        )}
      </FormField>
    </>
  );
}
