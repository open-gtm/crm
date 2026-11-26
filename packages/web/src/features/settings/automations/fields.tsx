import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, Textarea } from "@/components/ui/input";
import { isJson, textToValue, valueToText, type Json } from "./model";

/**
 * Small inputs the step forms share. Each keeps what is being typed as text and passes up only what
 * is valid, so a half-typed value is never lost and never sent. They start from their props once:
 * the owner remounts them (a new `key`) when the value is replaced from elsewhere.
 */

/** A JSON text area. Valid JSON goes up as a value, empty as `undefined`, anything else stays here with the reason. */
export function JsonField({ label, hint, value, onChange, rows = 4, required, error }: {
  label: string; hint?: React.ReactNode; value: unknown; onChange: (v: unknown) => void; rows?: number; required?: boolean; error?: string | null;
}) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value, null, 2));
  const [bad, setBad] = useState<string | null>(null);
  return (
    <FormField label={label} hint={hint} required={required} error={bad ?? error ?? null}>
      {(a) => (
        <Textarea {...a} rows={rows} spellCheck={false} className="font-mono text-sm" value={text} onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (t.trim() === "") {
            setBad(null);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(t) as unknown);
            setBad(null);
          } catch {
            setBad("Not valid JSON yet. The last valid version is kept until it is.");
          }
        }} />
      )}
    </FormField>
  );
}

interface Row { id: number; k: string; t: string }
let rowId = 0;

/**
 * Name and value pairs (the values of a record step, the headers of a request). Values are typed as
 * text: see `textToValue`. With `strings`, every value stays text.
 */
export function KeyValueEditor({ label, value, onChange, keyLabel = "Field", valueLabel = "Value", strings, hint, addLabel = "Add" }: {
  label: string; value: Json; onChange: (v: Json) => void; keyLabel?: string; valueLabel?: string; strings?: boolean; hint?: React.ReactNode; addLabel?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => Object.entries(value).map(([k, v]) => ({ id: ++rowId, k, t: strings ? String(v ?? "") : valueToText(v) })));
  const commit = (next: Row[]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.k.trim() !== "").map((r) => [r.k.trim(), strings ? r.t : textToValue(r.t)])));
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-muted">{label}</legend>
      {rows.map((r, i) => (
        <div key={r.id} className="flex items-start gap-2">
          <Input aria-label={`${keyLabel} ${i + 1}`} className="w-2/5 font-mono text-sm" placeholder={keyLabel} value={r.k} onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, k: e.target.value } : x)))} />
          <Input aria-label={`${valueLabel} ${i + 1}`} className="min-w-0 flex-1 font-mono text-sm" placeholder={valueLabel} value={r.t} onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, t: e.target.value } : x)))} />
          <Button size="icon-sm" variant="subtle" aria-label={`Remove ${keyLabel.toLowerCase()} ${i + 1}`} onClick={() => commit(rows.filter((x) => x.id !== r.id))}><X /></Button>
        </div>
      ))}
      <div><Button size="sm" variant="ghost" onClick={() => setRows([...rows, { id: ++rowId, k: "", t: "" }])}><Plus /> {addLabel}</Button></div>
      {hint ? <p className="text-sm text-subtle">{hint}</p> : null}
    </fieldset>
  );
}

interface SecretRow { id: number; k: string; v: string | null }

/**
 * Secret headers are write-only. A value the server holds arrives as null and is shown as "(set)";
 * sending null keeps it, typing replaces it. What is typed is a password field and is never shown again.
 */
export function SecretHeadersEditor({ value, onChange }: { value: Record<string, string | null>; onChange: (v: Record<string, string | null>) => void }) {
  const [rows, setRows] = useState<SecretRow[]>(() => Object.entries(value).map(([k, v]) => ({ id: ++rowId, k, v })));
  const commit = (next: SecretRow[]) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.k.trim() !== "").map((r) => [r.k.trim(), r.v])));
  };
  return (
    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium text-muted">Secret headers</legend>
      {rows.map((r, i) => (
        <div key={r.id} className="flex items-start gap-2">
          <Input aria-label={`Secret header name ${i + 1}`} className="w-2/5 font-mono text-sm" placeholder="Header" value={r.k} onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, k: e.target.value } : x)))} />
          {r.v === null && r.k !== "" ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-line bg-surface-2 px-2.5 text-sm text-muted">(set)</span>
              <Button size="sm" variant="ghost" aria-label={`Replace secret header ${i + 1}`} onClick={() => commit(rows.map((x) => (x.id === r.id ? { ...x, v: "" } : x)))}>Replace</Button>
            </div>
          ) : (
            <Input aria-label={`Secret header value ${i + 1}`} type="password" autoComplete="off" className="min-w-0 flex-1 font-mono text-sm" placeholder="Value" value={r.v ?? ""}
              onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, v: e.target.value } : x)))} />
          )}
          <Button size="icon-sm" variant="subtle" aria-label={`Remove secret header ${i + 1}`} onClick={() => commit(rows.filter((x) => x.id !== r.id))}><X /></Button>
        </div>
      ))}
      <div><Button size="sm" variant="ghost" onClick={() => setRows([...rows, { id: ++rowId, k: "", v: "" }])}><Plus /> Add secret header</Button></div>
      <p className="text-sm text-subtle">Write-only: kept encrypted and never shown again. A header marked (set) keeps its stored value unless replaced. A step with secret headers needs a step ID.</p>
    </fieldset>
  );
}

/** Reads a secret headers object from a step, null values included. */
export function secretHeadersOf(step: Json): Record<string, string | null> {
  const h = step.secret_headers;
  if (!isJson(h)) return {};
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, typeof v === "string" ? v : null]));
}
