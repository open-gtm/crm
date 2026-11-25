import { useMutation } from "@tanstack/react-query";
import { Bold, Code, Heading, Italic, Link2, List, Pencil, Plus, StickyNote } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { ObjectSummary, OpResult, RecordData } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Markdown } from "@/lib/markdown";
import { touchedBy, useApplyWrite } from "@/lib/writes";
import { useDescribe, useObjects } from "@/meta/hooks";
import { Files } from "./Files";
import { useTimeline } from "./Timeline";

/**
 * Notes on a record: formatted text (Markdown) that can be changed later and can carry files. A note is
 * the `note` activity the timeline, the API and the MCP tools already know, so nothing is stored twice:
 * this is the place to write and read them.
 */
export function Notes({ recordId }: { recordId: string }) {
  const objects = useObjects();
  const access = (objects.data ?? []).find((o: ObjectSummary) => o.name === "activity")?.access;
  const meta = useDescribe(access?.read ? "activity" : undefined);
  const q = useTimeline(recordId, Boolean(access?.read));
  const [editing, setEditing] = useState<RecordData | "new" | null>(null);
  if (!access?.read) return null;
  const fieldWritable = (name: string) => meta.data?.fields.find((f) => f.name === name)?.access === "write";
  const canWrite = Boolean(access.write) && fieldWritable("body");
  const notes = (q.data ?? []).filter((it) => it.kind === "activity" && it.item.type === "note").map((it) => it.item as RecordData);
  return (
    <section aria-label="Notes" className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex-1 text-md font-semibold">Notes{notes.length ? <span className="ml-2 text-sm font-normal text-subtle">{notes.length}</span> : null}</h2>
        {canWrite ? <Button size="sm" onClick={() => setEditing("new")}><Plus /> New note</Button> : null}
      </div>
      <div className="px-4 py-3">
        {q.isPending ? <Skeleton className="h-12" /> : q.error && !q.data ? <ProblemView error={q.error} onRetry={() => q.refetch()} compact />
          : notes.length === 0 ? <EmptyState title="No notes yet" className="py-4">{canWrite ? "Write down what you learned, with headings, lists and links." : null}</EmptyState>
          : (
            <ul className="flex flex-col divide-y divide-line">
              {notes.map((n) => (
                <li key={n.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start gap-2">
                    <StickyNote className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                    <div className="min-w-0 flex-1">
                      {n.subject ? <h3 className="text-base font-semibold">{String(n.subject)}</h3> : null}
                      {typeof n.body === "string" && n.body ? <Markdown source={n.body} className="mt-1" /> : null}
                      <p className="mt-1 text-sm text-subtle">
                        <time dateTime={String(n.occurred_at ?? "")} title={formatDateTime(n.occurred_at)}>{formatRelative(n.occurred_at)}</time>
                      </p>
                      <Files recordId={n.id} canWrite={Boolean(access.write)} compact label={`Note ${String(n.subject ?? "")}`.trim()} />
                    </div>
                    {canWrite ? <Button size="icon-sm" variant="subtle" aria-label={`Edit note ${String(n.subject ?? "")}`.trim()} onClick={() => setEditing(n)}><Pencil /></Button> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
      {editing ? <NoteEditor recordId={recordId} note={editing === "new" ? undefined : editing} subjectWritable={fieldWritable("subject")} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

/** Wraps the selection of a textarea in Markdown marks, or starts each selected line with one. */
function applyMark(el: HTMLTextAreaElement, value: string, mark: "bold" | "italic" | "code" | "heading" | "list" | "link"): { value: string; from: number; to: number } {
  const [a, b] = [el.selectionStart, el.selectionEnd];
  const picked = value.slice(a, b);
  const wrap = (open: string, close = open, placeholder = "text") => {
    const inner = picked || placeholder;
    return { value: value.slice(0, a) + open + inner + close + value.slice(b), from: a + open.length, to: a + open.length + inner.length };
  };
  if (mark === "bold") return wrap("**");
  if (mark === "italic") return wrap("*");
  if (mark === "code") return wrap("`");
  if (mark === "link") return wrap("[", "](https://)", "link text");
  const prefix = mark === "heading" ? "## " : "- ";
  const start = value.lastIndexOf("\n", a - 1) + 1;
  const block = value.slice(start, b).split("\n").map((l) => prefix + l).join("\n");
  return { value: value.slice(0, start) + block + value.slice(b), from: start + prefix.length, to: start + block.length };
}

function NoteEditor({ recordId, note, subjectWritable, onClose }: { recordId: string; note?: RecordData; subjectWritable: boolean | undefined; onClose: () => void }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const [subject, setSubject] = useState(typeof note?.subject === "string" ? note.subject : "");
  const [body, setBody] = useState(typeof note?.body === "string" ? note.body : "");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (note) {
        return (await api.patch<{ data: RecordData }>(`/v1/objects/activity/records/${encodeURIComponent(note.id)}`,
          { ...(subjectWritable !== false ? { subject: subject.trim() || null } : {}), body }, { ifMatch: note.version })).data;
      }
      return (await api.post<OpResult<RecordData | null>>("/v1/ops/log_activity", { type: "note", related_to: [recordId],
        ...(subject.trim() ? { subject: subject.trim() } : {}), body })).result ?? undefined;
    },
    onSuccess: (r) => {
      applyWrite({ object: "activity", touched: [{ id: recordId }, ...touchedBy(r ?? undefined)] });
      toast.toast({ tone: "success", title: note ? "Note saved" : "Note added" });
      onClose();
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  const mark = (m: Parameters<typeof applyMark>[2]) => {
    const el = area.current;
    if (!el) return;
    const next = applyMark(el, body, m);
    setBody(next.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.from, next.to);
    });
  };
  const tools: [Parameters<typeof applyMark>[2], string, React.ReactNode][] = [
    ["bold", "Bold", <Bold key="b" />], ["italic", "Italic", <Italic key="i" />], ["heading", "Heading", <Heading key="h" />],
    ["list", "List", <List key="l" />], ["link", "Link", <Link2 key="k" />], ["code", "Code", <Code key="c" />],
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={note ? "Edit note" : "New note"} size="lg"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="note-form" busy={save.isPending} disabled={!body.trim()}>Save note</Button></>}>
        <form id="note-form" className="flex flex-col gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          {subjectWritable !== false ? <FormField label="Title">{(p) => <Input {...p} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} autoFocus />}</FormField> : null}
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formatting">
              {tools.map(([m, label, icon]) => <Button key={m} size="icon-sm" variant="subtle" aria-label={label} disabled={preview} onClick={() => mark(m)}>{icon}</Button>)}
              <span className="flex-1" />
              <Button size="sm" variant="ghost" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? "Write" : "Preview"}</Button>
            </div>
            {preview ? (
              <div aria-label="Preview" role="region" className="min-h-40 rounded-md border border-line px-3 py-2">{body.trim() ? <Markdown source={body} /> : <p className="text-base text-muted">Nothing to preview.</p>}</div>
            ) : (
              <FormField label="Note" hint="Markdown: **bold**, *italic*, ## heading, - list, [text](https://…)">{(p) => (
                <Textarea {...p} ref={area} rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-sm" />
              )}</FormField>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
