import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import type { Connection, Webhook } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { useAdmin } from "../SettingsLayout";
import { JsonField, KeyValueEditor, SecretHeadersEditor, secretHeadersOf } from "./fields";
import { FORM_STEPS, isJson, maskSecrets, restoreSecrets, stepLabel, type Json } from "./model";
import { ObjectSelect } from "./TriggerEditor";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A step as an ordered card: what it is, move and remove, an "Edit as JSON" switch, and its form. */
export function StepCard({ index, count, value, onChange, onMove, onRemove, errors }: {
  index: number; count: number; value: Json; onChange: (v: Json) => void; onMove: (by: -1 | 1) => void; onRemove: () => void; errors: string[];
}) {
  const type = typeof value.type === "string" ? value.type : "";
  const hasForm = FORM_STEPS.has(type);
  const [asJson, setAsJson] = useState(!hasForm);
  // Bumped when the step is replaced by JSON text, so the form below starts again from the new value.
  const [rev, setRev] = useState(0);
  const n = index + 1;
  return (
    <li className="rounded-lg border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-sm tabular-nums text-subtle">{n}</span>
        <h3 className="min-w-0 flex-1 text-base font-semibold">{stepLabel(type)} <code className="font-mono text-xs font-normal text-subtle">{type}</code></h3>
        {hasForm ? (
          <label className="flex items-center gap-2 text-sm text-muted">
            <Switch checked={asJson} onCheckedChange={(v) => { setAsJson(v); setRev((r) => r + 1); }} aria-label={`Edit step ${n} as JSON`} /> Edit as JSON
          </label>
        ) : null}
        <Button size="icon-sm" variant="subtle" aria-label={`Move step ${n} up`} disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp /></Button>
        <Button size="icon-sm" variant="subtle" aria-label={`Move step ${n} down`} disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown /></Button>
        <Button size="icon-sm" variant="danger-ghost" aria-label={`Remove step ${n}`} onClick={onRemove}><Trash2 /></Button>
      </div>
      <div className="grid gap-3.5 p-3">
        {errors.length ? <ul role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger-fg">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul> : null}
        {asJson ? (
          <StepJson key={rev} value={value} onChange={(v) => { onChange(v); }} label={`Step ${n} as JSON`} />
        ) : (
          <>
            <StepForm key={rev} type={type} value={value} set={onChange} n={n} />
            <StepAdvanced key={`a${rev}`} value={value} set={onChange} n={n} />
          </>
        )}
      </div>
    </li>
  );
}

/** The whole step as JSON. Secret header values never appear: a null stands for one the server holds or one just typed. */
function StepJson({ value, onChange, label }: { value: Json; onChange: (v: Json) => void; label: string }) {
  const [text, setText] = useState(JSON.stringify(maskSecrets(value), null, 2));
  const [bad, setBad] = useState<string | null>(null);
  return (
    <FormField label={label} error={bad} hint={isJson(value.secret_headers) ? "Secret header values are not shown. null keeps the stored value; a new value replaces it." : undefined}>
      {(a) => (
        <Textarea {...a} rows={8} spellCheck={false} className="font-mono text-sm" value={text} onChange={(e) => {
          const t = e.target.value;
          setText(t);
          try {
            const v = JSON.parse(t) as unknown;
            if (!isJson(v) || typeof v.type !== "string") {
              setBad("A step is an object with a type.");
              return;
            }
            setBad(null);
            onChange(restoreSecrets(v, value));
          } catch {
            setBad("Not valid JSON yet. The last valid version is kept until it is.");
          }
        }} />
      )}
    </FormField>
  );
}

/** What every step may have: an ID (so later steps can use its output) and an `if` gate. */
function StepAdvanced({ value, set, n }: { value: Json; set: (v: Json) => void; n: number }) {
  const id = typeof value.id === "string" ? value.id : "";
  const put = (patch: Json) => set(Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, v]) => v !== undefined)));
  return (
    <details className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium text-muted">Step ID and condition</summary>
      <div className="mt-3 grid gap-3.5">
        <FormField label="Step ID" hint="Lowercase letters, digits and _. Later steps reach this one's output as {{steps.<id>.…}}.">
          {(a) => <Input {...a} aria-label={`Step ${n} ID`} className="font-mono sm:w-1/2" value={id} onChange={(e) => put({ id: e.target.value || undefined })} />}
        </FormField>
        <JsonField label={`Only run step ${n} when (JSON, optional)`} rows={3} value={value.if} onChange={(v) => put({ if: v })}
          hint="A filter in the query language, or a test on an earlier step's output. A step whose condition doesn't match is skipped." />
      </div>
    </details>
  );
}

function StepForm({ type, value, set, n }: { type: string; value: Json; set: (v: Json) => void; n: number }) {
  const put = (patch: Json) => set(Object.fromEntries(Object.entries({ ...value, ...patch }).filter(([, v]) => v !== undefined)));
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  switch (type) {
    case "update_record":
      return (
        <>
          <KeyValueEditor label="Set these fields" value={isJson(value.values) ? value.values : {}} addLabel="Add field" onChange={(v) => put({ values: v })}
            hint={<>Numbers, true, false, null and JSON are sent as they are; put quotes around text that looks like one. <code className="font-mono">{"{{record.name}}"}</code> fills in a value from the record.</>} />
          <details className="rounded-md border border-line bg-surface-2 px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium text-muted">Change another record instead</summary>
            <div className="mt-3 grid gap-3.5 sm:grid-cols-2">
              <FormField label="Record ID or placeholder" hint="Empty: the record that started the run.">
                {(a) => <Input {...a} aria-label={`Step ${n} record`} className="font-mono" value={text("record")} onChange={(e) => put({ record: e.target.value || undefined, ...(e.target.value ? {} : { object: undefined }) })} />}
              </FormField>
              {text("record") ? <ObjectSelect label="Its object" value={text("object")} onChange={(v) => put({ object: v || undefined })} /> : null}
            </div>
          </details>
        </>
      );
    case "create_record":
      return (
        <>
          <ObjectSelect label="Create a record of" value={text("object")} onChange={(v) => put({ object: v })} />
          <KeyValueEditor label="With these fields" value={isJson(value.values) ? value.values : {}} addLabel="Add field" onChange={(v) => put({ values: v })}
            hint={<>Numbers, true, false, null and JSON are sent as they are; put quotes around text that looks like one. <code className="font-mono">{"{{record.name}}"}</code> fills in a value from the record.</>} />
        </>
      );
    case "notify": {
      const rec = isJson(value.recipients) ? value.recipients : {};
      const users = Array.isArray(rec.users) ? rec.users.filter((u): u is string => typeof u === "string") : [];
      const setRec = (patch: Json) => {
        const next = Object.fromEntries(Object.entries({ ...rec, ...patch }).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
        put({ recipients: next });
      };
      return (
        <>
          <FormField label="Title" required>{(a) => <Input {...a} value={text("title")} onChange={(e) => put({ title: e.target.value })} />}</FormField>
          <FormField label="Message">{(a) => <Textarea {...a} rows={3} value={text("body")} onChange={(e) => put({ body: e.target.value || undefined })} />}</FormField>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <FormField label="Importance">
              {(a) => (
                <NativeSelect {...a} value={text("severity")} onChange={(e) => put({ severity: e.target.value || undefined })}>
                  <option value="">Normal</option><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option>
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Members to notify" hint="Member IDs (usr_…) separated by commas.">
              {(a) => <Input {...a} className="font-mono" defaultValue={users.join(", ")} onChange={(e) => setRec({ users: e.target.value.split(/[\s,]+/).filter(Boolean) })} />}
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-base"><Switch checked={rec.record_owner === true} onCheckedChange={(v) => setRec({ record_owner: v ? true : undefined })} aria-label="Notify the record's owner" /> Notify the record's owner</label>
        </>
      );
    }
    case "send_webhook":
      return <WebhookPicker value={text("webhook")} onChange={(v) => put({ webhook: v })} />;
    case "http_request": {
      const method = typeof value.method === "string" ? value.method : "GET";
      return (
        <>
          <div className="grid gap-3.5 sm:grid-cols-[8rem_1fr]">
            <FormField label="Method">{(a) => <NativeSelect {...a} value={method} onChange={(e) => put({ method: e.target.value, ...(["POST", "PUT", "PATCH"].includes(e.target.value) ? {} : { body: undefined }) })}>{METHODS.map((m) => <option key={m}>{m}</option>)}</NativeSelect>}</FormField>
            <FormField label={text("connection") ? "Path under the connection's base URL" : "URL"} required hint="Placeholders may fill the path and query, never the host.">
              {(a) => <Input {...a} aria-label={`Step ${n} URL`} className="font-mono" placeholder={text("connection") ? "/v1/contacts" : "https://api.example.com/contacts"} value={text("url")} onChange={(e) => put({ url: e.target.value })} />}
            </FormField>
          </div>
          <ConnectionPicker value={text("connection")} onChange={(v) => put({ connection: v || undefined })} />
          <KeyValueEditor label="Headers" value={isJson(value.headers) ? value.headers : {}} strings keyLabel="Header" valueLabel="Value" addLabel="Add header" onChange={(v) => put({ headers: Object.keys(v).length ? v : undefined })} />
          {text("connection") ? <p className="text-sm text-subtle">With a connection, the credential header comes from the connection: this step can't set it or have secret headers.</p>
            : <SecretHeadersEditor value={secretHeadersOf(value)} onChange={(v) => put({ secret_headers: Object.keys(v).length ? v : undefined })} />}
          {["POST", "PUT", "PATCH"].includes(method) ? (
            <JsonField label="Body (JSON)" rows={5} value={value.body} onChange={(v) => put({ body: v })} hint="Placeholders are filled as values, so a record's text can't change the shape of the body." />
          ) : null}
        </>
      );
    }
    case "send_email": {
      const to = isJson(value.to) ? value.to : {};
      const kind = to.record_owner === true ? "record_owner" : typeof to.field === "string" ? "field" : typeof to.member === "string" ? "member" : typeof to.address === "string" ? "address" : "record_owner";
      const toValue = kind === "field" ? String(to.field) : kind === "member" ? String(to.member) : kind === "address" ? String(to.address) : "";
      const setTo = (k: string, v: string) => put({ to: k === "record_owner" ? { record_owner: true } : { [k]: v } });
      return (
        <>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <FormField label="Send to">
              {(a) => (
                <NativeSelect {...a} value={kind} onChange={(e) => setTo(e.target.value, "")}>
                  <option value="record_owner">The record's owner</option><option value="field">An email field of the record</option>
                  <option value="member">A member</option><option value="address">A fixed address</option>
                </NativeSelect>
              )}
            </FormField>
            {kind !== "record_owner" ? (
              <FormField label={kind === "field" ? "Field name" : kind === "member" ? "Member ID or email" : "Address"}>
                {(a) => <Input {...a} aria-label={`Step ${n} recipient`} className="font-mono" value={toValue} onChange={(e) => setTo(kind, e.target.value)} />}
              </FormField>
            ) : null}
          </div>
          <FormField label="Subject" required>{(a) => <Input {...a} value={text("subject")} onChange={(e) => put({ subject: e.target.value })} />}</FormField>
          <FormField label="Message" required hint="Plain text. Placeholders such as {{record.first_name}} are filled in.">{(a) => <Textarea {...a} rows={5} value={text("body")} onChange={(e) => put({ body: e.target.value })} />}</FormField>
        </>
      );
    }
    case "stop":
      return <FormField label="Reason" hint="Ends the run as a success; the reason is kept in the run history.">{(a) => <Input {...a} value={text("reason")} onChange={(e) => put({ reason: e.target.value || undefined })} />}</FormField>;
    default:
      return null;
  }
}

/** The webhook to send to. Listing them needs `webhooks:manage`; without it the ID is typed. */
function WebhookPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useSession();
  const list = useAdmin<{ data: Webhook[] }>(["webhooks"], "/v1/webhooks", undefined, s.can("webhooks:manage"));
  const hooks = list.data?.data ?? [];
  if (!s.can("webhooks:manage") || list.error) {
    return <FormField label="Webhook ID" hint="The ID of a registered webhook (whk_…). You can't list webhooks with your role.">{(a) => <Input {...a} className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} />}</FormField>;
  }
  return (
    <FormField label="Webhook" hint="Sends the event, signed, to a receiver you registered under Webhooks.">
      {(a) => (
        <NativeSelect {...a} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>{list.isPending ? "Loading webhooks…" : "Choose a webhook"}</option>
          {hooks.map((w) => <option key={w.id} value={w.id}>{w.description || w.url}</option>)}
          {value && !hooks.some((w) => w.id === value) ? <option value={value}>{value}</option> : null}
        </NativeSelect>
      )}
    </FormField>
  );
}

/** A connection by key. Listing them needs `connections:manage`; without it the key is typed. */
function ConnectionPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const s = useSession();
  const can = s.can("connections:manage");
  const list = useAdmin<{ data: Connection[] }>(["connections"], "/v1/connections", undefined, can);
  if (!can || list.error) {
    return <FormField label="Connection key" hint="Optional. The key of a stored credential: the URL is then a path under its base URL. You can't list connections with your role.">{(a) => <Input {...a} className="font-mono sm:w-1/2" value={value} onChange={(e) => onChange(e.target.value)} />}</FormField>;
  }
  const conns = list.data?.data ?? [];
  return (
    <FormField label="Connection" hint="Optional. With one, the URL is a path under its base URL and the credential is added for you.">
      {(a) => (
        <NativeSelect {...a} className="sm:w-1/2" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">None: a full URL</option>
          {conns.map((c) => <option key={c.id} value={c.key}>{c.name} ({c.key}){c.status === "active" ? "" : ` · ${c.status}`}</option>)}
          {value && !conns.some((c) => c.key === value) ? <option value={value}>{value}</option> : null}
        </NativeSelect>
      )}
    </FormField>
  );
}
