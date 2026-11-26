import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FileText, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Skeleton, Switch } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { Automation } from "@/lib/api/types";
import { DocsLink } from "@/lib/docs";
import { formatDateTime } from "@/lib/format";
import { StepCard } from "./StepEditor";
import { TestPanel } from "./TestPanel";
import { TriggerEditor } from "./TriggerEditor";
import {
  buildBody, draftFromJson, draftJson, draftOf, emptyDraft, newStep, problemLines, stepIndexOf, stepKey, STEP_TYPES, type Draft, type WriteResult,
} from "./model";

/** How long the form rests before the server is asked what the automation would do. */
const DEBOUNCE_MS = 600;
const MAX_STEPS = 20;

type Preview =
  | { key: string; state: "loading" }
  | { key: string; state: "ok"; result: WriteResult }
  | { key: string; state: "error"; error: unknown };

/**
 * Creates an automation, or changes one. Every edit (after a short rest) is sent to the server as a dry
 * run and the server's own summary, warnings and next runs are shown: this screen never words what an
 * automation does itself. Saving sends the same request without `dry_run`, and is possible once the
 * server has accepted what is on screen.
 */
export function AutomationEditor({ existing }: { existing?: Automation }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Draft>(() => (existing ? draftOf(existing) : emptyDraft()));
  const [asJson, setAsJson] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [adding, setAdding] = useState("update_record");
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const built = useMemo(() => buildBody(draft, Boolean(existing)), [draft, existing]);
  const baseline = useMemo(() => (existing ? JSON.stringify(buildBody(draftOf(existing), true).body) : null), [existing]);
  const bodyKey = built.body ? JSON.stringify(built.body) : null;
  const dirty = existing ? bodyKey !== baseline : true;
  const url = existing ? `/v1/automations/${encodeURIComponent(existing.id)}` : "/v1/automations";

  const [preview, setPreview] = useState<Preview | null>(null);
  const ready = bodyKey !== null && built.complete;
  const isExisting = Boolean(existing);
  useEffect(() => {
    if (!ready || !built.body) return;
    const key = bodyKey;
    let cancelled = false;
    setPreview({ key, state: "loading" });
    const timer = setTimeout(() => {
      const body = { ...built.body, dry_run: true };
      const call = isExisting ? api.patch<WriteResult>(url, body) : api.post<WriteResult>(url, body);
      call.then((result) => {
        if (!cancelled) setPreview({ key, state: "ok", result });
      }, (error: unknown) => {
        if (!cancelled) setPreview({ key, state: "error", error });
      });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `built.body` is what `bodyKey` is made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bodyKey, ready, api, url, isExisting]);

  const current = preview && preview.key === bodyKey ? preview : null;
  const accepted = current?.state === "ok" ? current.result : null;

  const save = useMutation({
    // The request may hold secret header values: nothing of it stays in the mutation cache.
    gcTime: 0,
    mutationFn: () => (existing ? api.patch<WriteResult>(url, built.body) : api.post<WriteResult>(url, built.body)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      toast.toast({ tone: "success", title: existing ? "Automation saved" : "Automation created", description: r.summary });
      if (!existing) void navigate({ to: "/settings/automations/$automationId", params: { automationId: r.automation.id } });
    },
    onError: (e) => toast.error(e, "Couldn't save the automation"),
  });
  const refusal = save.error ?? (current?.state === "error" ? current.error : null);
  const problem = refusal ? asProblem(refusal) : null;
  const lines = problem ? problemLines(problem.errors) : [];
  const stepErrors = (i: number) => lines.filter((l) => stepIndexOf(l.path) === i).map((l) => `${l.path}: ${l.message}`);
  const otherLines = lines.filter((l) => stepIndexOf(l.path) === null);

  const setSteps = (steps: Draft["steps"]) => patch({ steps });
  const move = (i: number, by: -1 | 1) => {
    const steps = [...draft.steps];
    const [s] = steps.splice(i, 1);
    steps.splice(i + by, 0, s!);
    setSteps(steps);
  };
  const toggleJson = (on: boolean) => {
    if (on) {
      setJsonText(draftJson(draft));
      setJsonError(null);
    }
    setAsJson(on);
  };

  let conditionError: string | null = null;
  if (draft.condition.trim()) {
    try {
      JSON.parse(draft.condition);
    } catch {
      conditionError = "Not valid JSON yet.";
    }
  }
  const cannotSave = !accepted || save.isPending || !built.body || (Boolean(existing) && !dirty);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
      <div className="grid min-w-0 gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted">When something happens, and the record matches, run the steps. Nothing here ever runs as code.</p>
          <label className="flex items-center gap-2 text-sm text-muted"><Switch checked={asJson} onCheckedChange={toggleJson} aria-label="Edit the whole automation as JSON" /> As JSON</label>
        </div>

        {asJson ? (
          <FormField label="Automation as JSON" error={jsonError} hint="The same body the API takes. Secret header values are never shown: null keeps the stored one.">
            {(a) => (
              <Textarea {...a} rows={26} spellCheck={false} className="font-mono text-sm" value={jsonText} onChange={(e) => {
                const text = e.target.value;
                setJsonText(text);
                const r = draftFromJson(text, draft);
                if ("error" in r) setJsonError(r.error);
                else {
                  setJsonError(null);
                  setDraft(r.draft);
                }
              }} />
            )}
          </FormField>
        ) : (
          <>
            <Card title="About">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <FormField label="Name" required>{(a) => <Input {...a} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />}</FormField>
                <FormField label="Runs at most per hour" hint="Default 100, at most 10,000. Past it, runs are skipped.">
                  {(a) => <Input {...a} type="number" min={1} max={10000} placeholder="100" value={draft.hourlyCap} onChange={(e) => patch({ hourlyCap: e.target.value })} />}
                </FormField>
                <FormField label="Description" className="sm:col-span-2">{(a) => <Input {...a} value={draft.description} onChange={(e) => patch({ description: e.target.value })} />}</FormField>
              </div>
            </Card>

            <Card title="When">
              <TriggerEditor trigger={draft.trigger} onChange={(trigger) => patch({ trigger })} />
            </Card>

            <Card title="Only if">
              <FormField label="Condition (JSON, optional)" error={conditionError}
                hint={<>A filter in the query language, checked against the record, for example <code className="font-mono">{'{"field": "amount", "op": "gt", "value": 10000}'}</code>. The server checks it. <DocsLink page="automations.md">Automations guide</DocsLink></>}>
                {(a) => <Textarea {...a} rows={4} spellCheck={false} className="font-mono text-sm" placeholder="Empty: every record that triggers it" value={draft.condition} onChange={(e) => patch({ condition: e.target.value })} />}
              </FormField>
            </Card>

            <Card title="Then">
              {draft.steps.length === 0 ? <p className="mb-3 text-base text-muted">No steps yet. An automation needs at least one.</p> : (
                <ol aria-label="Steps" className="mb-3 grid gap-3">
                  {draft.steps.map((s, i) => (
                    <StepCard key={s.key} index={i} count={draft.steps.length} value={s.value} errors={stepErrors(i)}
                      onChange={(value) => setSteps(draft.steps.map((x) => (x.key === s.key ? { ...x, value } : x)))}
                      onMove={(by) => move(i, by)} onRemove={() => setSteps(draft.steps.filter((x) => x.key !== s.key))} />
                  ))}
                </ol>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <FormField label="Kind of step" className="min-w-48">
                  {(a) => <NativeSelect {...a} value={adding} onChange={(e) => setAdding(e.target.value)}>{STEP_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}</NativeSelect>}
                </FormField>
                <Button disabled={draft.steps.length >= MAX_STEPS} onClick={() => setSteps([...draft.steps, { key: stepKey(), value: newStep(adding) }])}><Plus /> Add step</Button>
                {draft.steps.length >= MAX_STEPS ? <span className="text-sm text-subtle">At most {MAX_STEPS} steps.</span> : null}
              </div>
            </Card>
          </>
        )}
      </div>

      <div className="grid min-w-0 gap-4 lg:sticky lg:top-4">
        <section aria-labelledby="plain-words" className="rounded-lg border border-line bg-surface p-4">
          <h3 id="plain-words" className="mb-2 flex items-center gap-2 text-base font-semibold"><FileText className="size-4 text-accent" aria-hidden /> In plain words</h3>
          {built.problems.length ? <p role="alert" className="text-base text-danger-fg">{built.problems.join(" ")}</p>
            : !built.complete ? <p className="text-base text-muted">Give it a name and at least one step, and the server will say here what it would do.</p>
            : !current || current.state === "loading" ? <div aria-live="polite"><p className="sr-only">Asking the server</p><Skeleton className="h-4 w-full" /><Skeleton className="mt-2 h-4 w-2/3" /></div>
            : current.state === "ok" ? (
              <div aria-live="polite">
                <p className="text-base leading-6 text-fg">{current.result.summary}</p>
                {current.result.warnings.length ? (
                  <ul aria-label="Warnings" className="mt-3 grid gap-2">
                    {current.result.warnings.map((w, i) => (
                      <li key={i} className="flex gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-fg"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span>{w}</span></li>
                    ))}
                  </ul>
                ) : null}
                {current.result.next_runs?.length ? (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-muted">Next runs</p>
                    <ul className="text-base">{current.result.next_runs.map((t) => <li key={t} className="tabular-nums">{formatDateTime(t) || t}</li>)}</ul>
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-subtle">The server's own description of the unsaved version. Nothing is saved yet.</p>
              </div>
            ) : (
              <div role="alert">
                <p className="font-medium text-danger-fg">The server refused this version</p>
                <p className="mt-0.5 break-words text-base text-muted">{asProblem(current.error).detail}</p>
              </div>
            )}
          {problem && (save.error || otherLines.length) ? (
            <div role="alert" className="mt-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger-fg">
              <p>{problem.detail}</p>
              {otherLines.length ? <ul className="mt-1 list-disc pl-4">{otherLines.map((l, i) => <li key={i}>{l.path ? <code className="font-mono">{l.path}</code> : null}{l.path ? ": " : ""}{l.message}</li>)}</ul> : null}
            </div>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <Button variant="primary" busy={save.isPending} disabled={cannotSave} onClick={() => save.mutate()}>{existing ? "Save changes" : "Create automation"}</Button>
            {existing && !dirty ? <span className="text-sm text-subtle">No changes to save.</span> : !accepted && built.complete ? <span className="text-sm text-subtle">Saving is possible once the server accepts this version.</span> : null}
          </div>
          <p className="mt-3 text-sm text-subtle">An agent can make the same change with the MCP tools <code className="font-mono">create_automation</code> and <code className="font-mono">update_automation</code>, always with a dry run first, as this page does.</p>
        </section>

        <TestPanel existingId={existing?.id} draft={built.body} trigger={existing ? existing.trigger : draft.trigger}
          blocked={existing && dirty ? "This tests the saved version. Save your changes to test them." : !existing && !built.complete ? "Give it a name and at least one step to test it." : undefined} />
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  const label = title.toLowerCase().replace(/\s+/g, "-");
  return (
    <section aria-labelledby={`card-${label}`} className="rounded-lg border border-line bg-surface p-4">
      <h3 id={`card-${label}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-subtle">{title}</h3>
      {children}
    </section>
  );
}
