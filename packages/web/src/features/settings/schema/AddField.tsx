import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { KnownFieldType, ObjectMeta, ObjectSummary, SchemaChangeResult } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/keys";
import { ADDABLE_TYPES, apiNameFrom, EMPTY_DRAFT, fieldBody, hasValues, parseValues, typeLabel, type FieldDraft } from "./model";

type Change = SchemaChangeResult["changes"][number];

/** One planned change in words, from the `after` the server sent (its summary of the field). */
function describeAfter(c: Change): string {
  const after = (typeof c.after === "object" && c.after !== null ? c.after : {}) as { type?: string; required?: boolean; options?: { values?: { label?: string; key?: string }[]; to?: string; cardinality?: string } };
  const parts: string[] = [after.type ? typeLabel(after.type) : "field"];
  if (after.options?.to) parts.push(`→ ${after.options.to}${after.options.cardinality === "many_to_many" ? " (many)" : ""}`);
  if (after.options?.values?.length) parts.push(after.options.values.map((v) => v.label ?? v.key).join(", "));
  parts.push(after.required ? "required" : "optional");
  return parts.join(" · ");
}

/** The same change as an agent would ask for it: the admin MCP tool and its arguments, built from the form's own values. */
function agentCall(object: string, d: FieldDraft): string {
  const args = [`object: "${object}"`, `name: "${d.apiName.trim()}"`, `type: "${d.type}"`];
  if (d.label.trim()) args.push(`label: "${d.label.trim()}"`);
  if (d.required) args.push("required: true");
  if (hasValues(d.type)) args.push(`values: [${parseValues(d.values).map((v) => `"${v.label}"`).join(", ")}]`);
  if (d.type === "relation") args.push(`relation_to: "${d.to}"`, ...(d.cardinality === "many_to_many" ? ["many: true"] : []));
  if (d.type === "rating" && d.max.trim()) args.push(`max: ${Number(d.max)}`);
  return `add_field(${args.join(", ")})`;
}

/**
 * The Add field form. Submitting asks the server for a dry run and shows what it would change; only
 * Apply sends the same body again for real, so what is applied is what was shown.
 */
export function AddField({ meta, objects, onClose }: { meta: ObjectMeta; objects: ObjectSummary[]; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<FieldDraft>(EMPTY_DRAFT);
  // The API name follows the label until the person edits it themselves.
  const [nameTouched, setNameTouched] = useState(false);
  const [review, setReview] = useState<{ body: Record<string, unknown>; draft: FieldDraft; result: SchemaChangeResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = `/v1/objects/${encodeURIComponent(meta.name)}/fields`;
  const set = (patch: Partial<FieldDraft>) => setD((x) => ({ ...x, ...patch }));

  const dry = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<SchemaChangeResult>(path, { ...body, dry_run: true }),
    onSuccess: (result, body) => {
      setError(null);
      setReview({ body, draft: d, result });
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  const apply = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<SchemaChangeResult>(path, body),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.describe(meta.name) }), qc.invalidateQueries({ queryKey: qk.objects }),
        qc.invalidateQueries({ queryKey: ["admin", "schema-changes"] }), qc.invalidateQueries({ queryKey: ["meta", "schema-counts"] }),
      ]);
      toast.toast({ tone: "success", title: "Field added", description: `${meta.label}: ${review?.draft.apiName ?? ""}` });
      onClose();
    },
    onError: (e) => setError(asProblem(e).detail),
  });

  const targets = objects.filter((o) => o.access.read && !o.hidden && o.name !== "pipeline" && o.name !== "stage");
  const ready = d.apiName.trim() !== "" && (!hasValues(d.type) || parseValues(d.values).length > 0) && (d.type !== "relation" || d.to !== "");

  if (review) {
    const { result, draft, body } = review;
    return (
      <div className="border-b border-line bg-surface-2 p-4" aria-label={`Review the new field on ${meta.label}`} role="group">
        <h3 className="flex items-center gap-1.5 text-base font-semibold"><Eye className="size-4 text-accent" aria-hidden /> Dry run: what will change</h3>
        <p className="mt-0.5 text-sm text-muted">Nothing has been changed yet.</p>
        <ul className="mt-3 grid gap-2">
          {result.changes.length === 0 ? <li className="rounded-md bg-surface px-3 py-2 text-sm text-muted">The server reports nothing to change.</li> : result.changes.map((c, i) => (
            <li key={i} className="grid gap-1">
              <p className="rounded-md bg-success-soft px-3 py-1.5 text-sm text-success-fg"><strong aria-hidden>+ </strong><code className="font-mono">{c.object}.{c.field}</code> {describeAfter(c)}</p>
              {c.warning ? <p role="note" className="rounded-md bg-warning-soft px-3 py-1.5 text-sm text-warning-fg">{c.warning}</p> : null}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-subtle">Same change from an agent (admin MCP): <code className="break-all font-mono text-xs">{agentCall(meta.name, draft)}</code></p>
        {error ? <p role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { setReview(null); setError(null); }} disabled={apply.isPending}>Back</Button>
          <Button variant="primary" busy={apply.isPending} onClick={() => apply.mutate(body)}>Apply</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="border-b border-line bg-surface-2 p-4" aria-label={`New field on ${meta.label}`} onSubmit={(e) => {
      e.preventDefault();
      if (ready && !dry.isPending) dry.mutate(fieldBody(d));
    }}>
      <h3 className="text-base font-semibold">New field on {meta.label}</h3>
      <p className="mt-0.5 text-sm text-muted">You see the server's dry run before anything is applied.</p>
      {error ? <p role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FormField label="Label">{(p) => <Input {...p} autoFocus value={d.label} onChange={(e) => set({ label: e.target.value, ...(nameTouched ? {} : { apiName: apiNameFrom(e.target.value) }) })} />}</FormField>
        <FormField label="API name" required hint="Lowercase letters, digits and underscores.">
          {(p) => <Input {...p} className="font-mono" value={d.apiName} onChange={(e) => { setNameTouched(true); set({ apiName: e.target.value }); }} />}
        </FormField>
        <FormField label="Type">
          {(p) => <NativeSelect {...p} value={d.type} onChange={(e) => set({ type: e.target.value as KnownFieldType })}>{ADDABLE_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</NativeSelect>}
        </FormField>
        {hasValues(d.type) ? (
          <FormField label="Values" required hint="Separated by commas. Each gets a key made from its label.">{(p) => <Input {...p} value={d.values} onChange={(e) => set({ values: e.target.value })} />}</FormField>
        ) : null}
        {d.type === "relation" ? (
          <>
            <FormField label="Points to" required>
              {(p) => <NativeSelect {...p} value={d.to} onChange={(e) => set({ to: e.target.value })}>
                <option value="">Choose an object…</option>
                <option value="user">Member</option>
                {targets.map((o) => <option key={o.name} value={o.name}>{o.label}</option>)}
              </NativeSelect>}
            </FormField>
            <FormField label="How many">
              {(p) => <NativeSelect {...p} value={d.cardinality} onChange={(e) => set({ cardinality: e.target.value as FieldDraft["cardinality"] })}>
                <option value="many_to_one">One {d.to ? (targets.find((o) => o.name === d.to)?.label ?? d.to).toLowerCase() : "record"} per record</option>
                <option value="many_to_many">Several per record</option>
              </NativeSelect>}
            </FormField>
          </>
        ) : null}
        {d.type === "rating" ? <FormField label="Highest rating" hint="1 to 10; 5 when empty.">{(p) => <Input {...p} type="number" min={1} max={10} inputMode="numeric" value={d.max} onChange={(e) => set({ max: e.target.value })} />}</FormField> : null}
        <div className={cn("flex items-center gap-2 text-base sm:col-span-2")}>
          <Checkbox id="add-field-required" checked={d.required} onCheckedChange={(v) => set({ required: v === true })} />
          <label htmlFor="add-field-required">Required</label>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" busy={dry.isPending} disabled={!ready}>Preview change</Button>
      </div>
    </form>
  );
}
