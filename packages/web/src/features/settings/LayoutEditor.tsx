import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Input, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { layoutKey, usePageLayout, type PageLayout } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { ObjectMeta } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { visibleFields } from "@/meta/fields";
import { Section } from "./SettingsLayout";

interface Draft { title: string; fields: string[] }

/** Moves the item at `i` one place up or down. */
const moved = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

/**
 * Arranges an object's record page: named sections, each an ordered list of fields. Everything moves
 * with buttons, so it works from the keyboard. Fields left out of every section still show on the page,
 * under "Other fields", so nothing is lost by leaving one out. Changing it needs permission to manage the schema.
 */
export function LayoutEditor({ meta }: { meta: ObjectMeta }) {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const layout = usePageLayout(meta.name);
  const [draft, setDraft] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const editable = s.can("schema:manage");
  const fields = visibleFields(meta);
  const label = (name: string) => fields.find((f) => f.name === name)?.label ?? name;

  // Editing starts from what is saved; the default page starts as one section with every field.
  useEffect(() => setDraft(null), [meta.name]);
  const saved: Draft[] = layout.data?.custom ? layout.data.sections : [];
  const start = () => setDraft(saved.length ? saved.map((x) => ({ ...x, fields: [...x.fields] })) : [{ title: "Details", fields: fields.map((f) => f.name) }]);

  const done = (data: PageLayout, title: string) => {
    qc.setQueryData(layoutKey(meta.name), data);
    setDraft(null);
    setError(null);
    toast.toast({ tone: "success", title });
  };
  const save = useMutation({
    mutationFn: (sections: Draft[]) => api.put<{ data: PageLayout }>(`/v1/objects/${encodeURIComponent(meta.name)}/layout`, { sections: sections.map((x) => ({ title: x.title.trim(), fields: x.fields })) }),
    onSuccess: (r) => done(r.data, "Layout saved"),
    onError: (e) => setError(asProblem(e).detail),
  });
  const reset = useMutation({
    mutationFn: () => api.delete<{ data: PageLayout }>(`/v1/objects/${encodeURIComponent(meta.name)}/layout`),
    onSuccess: (r) => {
      setResetting(false);
      done(r.data, "Back to the default page");
    },
    onError: (e) => {
      setResetting(false);
      toast.error(e, "Couldn't reset the layout");
    },
  });

  const change = (i: number, fn: (x: Draft) => Draft) => setDraft((d) => d && d.map((x, j) => (j === i ? fn(x) : x)));
  const placed = new Set((draft ?? []).flatMap((x) => x.fields));
  const unplaced = fields.filter((f) => !placed.has(f.name));

  return (
    <Section id="record-page-layout" title="Record page layout"
      description={`How a ${meta.label.toLowerCase()}'s page arranges its fields, for everyone. A field you leave out still shows, under "Other fields". Key facts (a status, money, the owner) stay in the page's header.`}
      actions={draft ? null : editable ? (
        <>
          {layout.data?.custom ? <Button size="sm" variant="ghost" onClick={() => setResetting(true)}><RotateCcw /> Use the default page</Button> : null}
          <Button size="sm" onClick={start}>{layout.data?.custom ? "Edit layout" : "Arrange this page"}</Button>
        </>
      ) : null}>
      {layout.isPending ? <Skeleton className="h-16" /> : layout.error ? <ProblemView error={layout.error} onRetry={() => layout.refetch()} compact /> : draft ? (
        <form className="flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate(draft);
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          {draft.map((sec, i) => (
            <fieldset key={i} className="rounded-md border border-line p-3">
              <legend className="sr-only">Section {i + 1}</legend>
              <div className="flex items-center gap-2">
                <Input aria-label={`Section ${i + 1} title`} value={sec.title} maxLength={80} required className="max-w-xs" onChange={(e) => change(i, (x) => ({ ...x, title: e.target.value }))} />
                <span className="flex-1" />
                <Button size="icon-sm" variant="subtle" aria-label={`Move section ${sec.title || i + 1} up`} disabled={i === 0} onClick={() => setDraft(moved(draft, i, -1))}><ArrowUp /></Button>
                <Button size="icon-sm" variant="subtle" aria-label={`Move section ${sec.title || i + 1} down`} disabled={i === draft.length - 1} onClick={() => setDraft(moved(draft, i, 1))}><ArrowDown /></Button>
                <Button size="icon-sm" variant="subtle" aria-label={`Remove section ${sec.title || i + 1}`} disabled={draft.length === 1} onClick={() => setDraft(draft.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
              {sec.fields.length === 0 ? <p className="mt-2 text-sm text-muted">No fields yet. An empty section isn't shown.</p> : (
                <ol className="mt-2 flex flex-col">
                  {sec.fields.map((name, k) => (
                    <li key={name} className="flex items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-surface-2">
                      <span className="min-w-0 flex-1 truncate text-base">{label(name)}</span>
                      <Button size="icon-sm" variant="subtle" aria-label={`Move ${label(name)} up`} disabled={k === 0} onClick={() => change(i, (x) => ({ ...x, fields: moved(x.fields, k, -1) }))}><ArrowUp /></Button>
                      <Button size="icon-sm" variant="subtle" aria-label={`Move ${label(name)} down`} disabled={k === sec.fields.length - 1} onClick={() => change(i, (x) => ({ ...x, fields: moved(x.fields, k, 1) }))}><ArrowDown /></Button>
                      <Button size="icon-sm" variant="subtle" aria-label={`Take ${label(name)} out of ${sec.title || `section ${i + 1}`}`} onClick={() => change(i, (x) => ({ ...x, fields: x.fields.filter((n) => n !== name) }))}><X /></Button>
                    </li>
                  ))}
                </ol>
              )}
              {unplaced.length ? (
                <NativeSelect aria-label={`Add a field to ${sec.title || `section ${i + 1}`}`} className="mt-2 h-7 w-56 text-sm" value="" onChange={(e) => e.target.value && change(i, (x) => ({ ...x, fields: [...x.fields, e.target.value] }))}>
                  <option value="">Add a field…</option>
                  {unplaced.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
                </NativeSelect>
              ) : null}
            </fieldset>
          ))}
          {unplaced.length ? <p className="text-sm text-muted">Not in a section, so shown under "Other fields": {unplaced.map((f) => f.label).join(", ")}.</p> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={draft.length >= 20} onClick={() => setDraft([...draft, { title: `Section ${draft.length + 1}`, fields: [] }])}><Plus /> Add section</Button>
            <span className="flex-1" />
            <Button size="sm" onClick={() => {
              setDraft(null);
              setError(null);
            }}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" busy={save.isPending} disabled={draft.some((x) => !x.title.trim())}>Save layout</Button>
          </div>
        </form>
      ) : saved.length ? (
        <ul className="flex flex-col gap-2">
          {saved.map((sec) => <li key={sec.title} className="text-base"><span className="font-medium">{sec.title}</span><span className="text-muted">: {sec.fields.length ? sec.fields.map(label).join(", ") : "no fields"}</span></li>)}
        </ul>
      ) : <p className="text-base text-muted">The default page: this object's own fields under Details, and custom fields under Custom fields.{editable ? "" : " Changing it needs permission to manage the schema."}</p>}
      <ConfirmDialog open={resetting} onOpenChange={setResetting} busy={reset.isPending} confirmLabel="Use the default page" title="Go back to the default page?"
        description="The sections you arranged are removed, for everyone." onConfirm={() => reset.mutate()} />
    </Section>
  );
}
