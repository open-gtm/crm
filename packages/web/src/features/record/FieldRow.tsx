import { Check, ChevronDown, ChevronRight, Lock, Pencil, X } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/overlays";
import { asProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { canWrite, isRestrictedValue, readOnlyReason, toApiValue, toFormValue, validateValues, type FormValue } from "@/meta/fields";
import { FieldControl, FieldValue } from "@/meta/registry";

export type SaveFields = (b: Record<string, unknown>) => Promise<RecordData>;

/**
 * A card of fields. It can be collapsed (it starts collapsed when the layout says so; the member's own
 * choice isn't stored) and lays its fields out in one or two columns.
 */
export function FieldSection({ title, fields, meta, record, save, readOnly, columns = 2, collapsed = false }: {
  title: string; fields: FieldMeta[]; meta: ObjectMeta; record: RecordData; save: SaveFields; readOnly: boolean; columns?: 1 | 2; collapsed?: boolean;
}) {
  const [closed, setClosed] = useState(collapsed);
  const body = useId();
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-surface">
      <h2 className="text-md font-semibold">
        <button type="button" aria-expanded={!closed} aria-controls={body} onClick={() => setClosed((c) => !c)}
          className={cn("flex w-full items-center gap-1.5 rounded-lg px-4 py-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus", !closed && "border-b border-line")}>
          {closed ? <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle" /> : <ChevronDown aria-hidden className="size-4 shrink-0 text-subtle" />}
          <span className="min-w-0 flex-1 truncate">{title}</span>
        </button>
      </h2>
      {closed ? null : (
        <dl id={body} className={cn("grid grid-cols-1", columns === 2 && "sm:grid-cols-2")}>
          {fields.map((f) => <FieldRow key={f.name} field={f} meta={meta} record={record} save={save} readOnly={readOnly} columns={columns} />)}
        </dl>
      )}
    </section>
  );
}

/** One field: its value, and when this member may change it, an in-place editor (Enter saves, Escape cancels). */
export function FieldRow({ field, meta, record, save, readOnly, compact, columns = 2 }: {
  field: FieldMeta; meta: ObjectMeta; record: RecordData; save: SaveFields; readOnly: boolean;
  /** How many columns the section has: the last row of each column loses its border. */
  columns?: 1 | 2;
  /** A key fact in the record's header: label above, no row border. */
  compact?: boolean;
}) {
  const s = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<FormValue>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = !readOnly && canWrite(field, meta.access, "edit") && !isRestrictedValue(record[field.name]);
  const reason = readOnly ? null : readOnlyReason(field, meta.access, "edit");
  const wide = field.type === "long_text" || field.type === "multi_select" || field.type === "json" || field.type === "address";
  const start = () => {
    setValue(toFormValue(field, record[field.name]));
    setError(null);
    setEditing(true);
  };
  const commit = async () => {
    const v = toApiValue(field, value);
    const problem = validateValues([field], { [field.name]: v }, "edit")[field.name];
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await save({ [field.name]: v });
      setEditing(false);
    } catch (e) {
      const p = asProblem(e);
      if (p.status === 412) setEditing(false);
      else setError(p.fieldErrors[field.name] ? cap(p.fieldErrors[field.name]!) : p.detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("group min-w-0", compact ? "max-w-full" : cn("border-b border-line px-4 py-2.5", columns === 2 ? "sm:[&:nth-last-child(-n+2)]:border-b-0" : "last:border-b-0"), wide && !compact && columns === 2 && "sm:col-span-2", compact && editing && "min-w-64")}>
      <dt className={cn("flex items-center gap-1", compact ? "text-xs font-medium uppercase tracking-wide text-subtle" : "text-sm text-muted")}>
        {field.label}
        {!writable && reason && meta.access.write ? (
          <Tooltip content={reason}><button type="button" aria-label={`${field.label} is read-only: ${reason}`} className="rounded-sm text-subtle"><Lock className="size-3" /></button></Tooltip>
        ) : null}
      </dt>
      <dd className="mt-0.5 min-h-6 text-base">
        {editing ? (
          // Escape anywhere in the editor cancels it, as in every other editor of the app.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <form onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }} onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}>
            <FieldControl field={field} meta={meta} record={record} mode="edit" value={value} onChange={setValue} autoFocus invalid={Boolean(error)}
              me={{ id: s.member.id, name: s.member.name }} onCommit={() => void commit()} />
            {error ? <p role="alert" className="mt-1 text-sm text-danger-fg">{error}</p> : null}
            <div className="mt-1.5 flex gap-1.5">
              <Button size="sm" variant="primary" type="submit" busy={busy}><Check /> Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X /> Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1"><FieldValue field={field} value={record[field.name]} record={record} meta={meta} variant="full" /></div>
            {writable ? (
              <button type="button" onClick={start} aria-label={`Edit ${field.label}`}
                className="shrink-0 rounded-sm p-1 text-subtle opacity-0 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100">
                <Pencil className="size-3.5" />
              </button>
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

