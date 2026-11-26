import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckSquare, Flag, MessageSquare, Plus, Square } from "lucide-react";
import { useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { ObjectSummary, OpResult, RecordData, TimelineItem } from "@/lib/api/types";
import { formatDateTime, formatRelative, fromLocalInput, toLocalInput } from "@/lib/format";
import { qk } from "@/lib/keys";
import { Markdown } from "@/lib/markdown";
import { touchedBy, useApplyWrite } from "@/lib/writes";
import { optionLabel, toneFor } from "@/meta/fields";
import { useDescribe, useObjects } from "@/meta/hooks";
import { RecordLink } from "@/meta/registry";

/** Activity types people log by hand; the others are written by the platform. */
const PLATFORM_TYPES = new Set(["form_submitted", "lead_converted", "task_completed", "deal_stage_changed", "email_opened"]);

/** A record's timeline items, newest first. The timeline and the Notes section read the same query. */
export function useTimeline(recordId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: qk.timeline(recordId), enabled,
    queryFn: async ({ signal }) => (await api.get<{ data: { items: TimelineItem[] } }>(`/v1/records/${encodeURIComponent(recordId)}/timeline`, { limit: 50 }, signal)).data.items,
  });
}

/** Everything that happened on a record, newest first: activities, tasks and (for deals) stage changes. */
export function Timeline({ recordId }: { recordId: string }) {
  const objects = useObjects();
  const can = (name: string, a: "read" | "write") => Boolean((objects.data ?? []).find((o: ObjectSummary) => o.name === name)?.access[a]);
  const q = useTimeline(recordId);
  const [logging, setLogging] = useState(false);
  const [tasking, setTasking] = useState(false);
  return (
    <section aria-labelledby="timeline-h" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 id="timeline-h" className="flex-1 text-md font-semibold">Timeline</h2>
        {can("activity", "write") ? <Button size="sm" onClick={() => setLogging(true)}><MessageSquare /> Log activity</Button> : null}
        {can("task", "write") ? <Button size="sm" onClick={() => setTasking(true)}><Plus /> Task</Button> : null}
      </div>
      <div className="p-4">
        {q.isPending ? <div className="flex flex-col gap-4" aria-busy="true">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
          : q.error && !q.data ? <ProblemView error={q.error} onRetry={() => q.refetch()} compact />
          : !q.data || q.data.length === 0 ? <EmptyState title="Nothing here yet" className="py-6">Log a call, a note or a meeting, or add a task.</EmptyState>
          : <ol className="relative flex flex-col gap-4 border-l border-line pl-5">{q.data.map((it, i) => <TimelineEntry key={i} it={it} recordId={recordId} />)}</ol>}
      </div>
      {logging ? <LogActivityDialog recordId={recordId} onClose={() => setLogging(false)} /> : null}
      {tasking ? <CreateRecordDialog object="task" open onOpenChange={setTasking} extra={{ related_to: [recordId] }} stay /> : null}
    </section>
  );
}

function TimelineEntry({ it, recordId }: { it: TimelineItem; recordId: string }) {
  const activityMeta = useDescribe(it.kind === "activity" ? "activity" : undefined);
  const taskMeta = useDescribe(it.kind === "task" ? "task" : undefined);
  const dot = "absolute -left-[1.6rem] top-1 flex size-4 items-center justify-center rounded-full border border-line bg-surface [&_svg]:size-2.5";
  if (it.kind === "stage_change") {
    return (
      <li className="relative">
        <span aria-hidden className={dot}><Flag /></span>
        <p className="flex flex-wrap items-center gap-1.5 text-base">
          Stage {it.item.from ? <><Badge>{it.item.from}</Badge><ArrowRight aria-label="to" className="size-3.5 text-subtle" /></> : "set to"} <Badge tone={toneFor(it.item.status)}>{it.item.to}</Badge>
        </p>
        <Time at={it.at} />
      </li>
    );
  }
  if (it.kind === "task") {
    const t = it.item;
    const statusField = taskMeta.data?.fields.find((f) => f.name === "status");
    return (
      <li className="relative">
        <span aria-hidden className={dot}><CheckSquare /></span>
        <TaskLine task={t} recordId={recordId} />
        <p className="text-sm text-subtle">
          Task{statusField && t.status ? <> · <Badge tone={toneFor(statusField.values?.find((v) => v.key === t.status)?.category)}>{optionLabel(statusField, t.status)}</Badge></> : null}
          {typeof t.due_at === "string" ? <> · due {formatDateTime(t.due_at)}</> : null}
        </p>
      </li>
    );
  }
  const a = it.item;
  const typeLabel = activityMeta.data?.activity_types?.find((x) => x.key === a.type)?.label ?? String(a.type ?? "Activity");
  const others = (a.related ?? []).filter((r) => r.id !== recordId && r.object);
  return (
    <li className="relative">
      <span aria-hidden className={dot}><MessageSquare /></span>
      <p className="text-base"><span className="font-medium">{typeLabel}</span>{a.subject ? <>: {String(a.subject)}</> : null}</p>
      {typeof a.body === "string" && a.body ? (
        // Notes are written in Markdown (the Notes section); other activities keep their text as typed.
        a.type === "note" ? <Markdown source={a.body} className="mt-1 rounded-md bg-surface-2 px-3 py-2 text-fg" />
          : <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-base text-fg">{a.body}</p>
      ) : null}
      {others.length ? (
        <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-muted">Also on {others.map((r) => r.display_name
          ? <RecordLink key={r.id} object={r.object!} id={r.id}>{r.display_name}</RecordLink>
          : <span key={r.id}>a record you can't see</span>)}</p>
      ) : null}
      <Time at={typeof a.occurred_at === "string" ? a.occurred_at : it.at} />
    </li>
  );
}

function Time({ at }: { at: string }) {
  return <time dateTime={at} title={formatDateTime(at)} className="text-sm text-subtle">{formatRelative(at)}</time>;
}

/** A task on the timeline, ticked off in place. */
function TaskLine({ task, recordId }: { task: RecordData; recordId: string }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const meta = useDescribe("task");
  const status = meta.data?.fields.find((f) => f.name === "status");
  const doneKey = status?.values?.find((v) => v.category === "done")?.key;
  const isDone = status?.values?.find((v) => v.key === task.status)?.category === "done";
  const canTick = Boolean(meta.data?.access.write && status?.access === "write" && doneKey);
  const done = useMutation({
    mutationFn: () => api.patch<{ data: RecordData }>(`/v1/objects/task/records/${encodeURIComponent(task.id)}`, { status: isDone ? "open" : doneKey }, { ifMatch: task.version }),
    onSuccess: (r) => applyWrite({ object: "task", id: task.id, record: r.data, touched: [{ id: recordId }, ...touchedBy(task)] }),
    onError: (e) => toast.error(e, "Couldn't update the task"),
  });
  return (
    <p className="flex items-center gap-2 text-base">
      {canTick ? (
        <button type="button" onClick={() => done.mutate()} disabled={done.isPending} aria-pressed={isDone} aria-label={isDone ? `Reopen ${task.display_name}` : `Mark ${task.display_name} done`}
          className="text-muted hover:text-accent">{isDone ? <CheckSquare className="size-4 text-success" /> : <Square className="size-4" />}</button>
      ) : null}
      <RecordLink object="task" id={task.id} className={isDone ? "line-through decoration-subtle" : ""}>{task.display_name || "Task"}</RecordLink>
    </p>
  );
}

function LogActivityDialog({ recordId, onClose }: { recordId: string; onClose: () => void }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const meta = useDescribe("activity");
  const types = (meta.data?.activity_types ?? []).filter((t) => !PLATFORM_TYPES.has(t.key));
  const [type, setType] = useState("note");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(new Date().toISOString()));
  const [error, setError] = useState<string | null>(null);
  const writable = (name: string) => meta.data?.fields.find((f) => f.name === name)?.access === "write";
  const log = useMutation({
    mutationFn: () => api.post<OpResult<RecordData | null>>("/v1/ops/log_activity", {
      type, related_to: [recordId], ...(subject.trim() ? { subject: subject.trim() } : {}), ...(body.trim() ? { body } : {}),
      ...(fromLocalInput(when) ? { occurred_at: fromLocalInput(when) } : {}),
    }),
    onSuccess: (r) => {
      applyWrite({ object: "activity", touched: [{ id: recordId }, ...touchedBy(r.result ?? undefined)] });
      toast.toast({ tone: "success", title: "Activity logged" });
      onClose();
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Log activity" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="log-activity" busy={log.isPending}>Log it</Button></>}>
        <form id="log-activity" className="flex flex-col gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          log.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          <div className="grid gap-3.5 sm:grid-cols-2">
            <FormField label="Type">{(p) => (
              <NativeSelect {...p} value={type} onChange={(e) => setType(e.target.value)}>
                {(types.length ? types : [{ key: "note", label: "Note" }]).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </NativeSelect>
            )}</FormField>
            <FormField label="When">{(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</FormField>
          </div>
          {writable("subject") !== false ? <FormField label="Subject">{(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />}</FormField> : null}
          {writable("body") !== false ? <FormField label="Notes">{(p) => <Textarea {...p} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />}</FormField> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
