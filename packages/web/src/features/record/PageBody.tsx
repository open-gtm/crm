import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CopyButton, EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import type { FieldMeta, ObjectMeta, ObjectSummary, RecordData } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useDescribe, useObjects } from "@/meta/hooks";
import { AgentChanges } from "./AgentChanges";
import { FieldSection, type SaveFields } from "./FieldRow";
import { Files } from "./Files";
import { Notes } from "./Notes";
import { arrangeFields, arrangePage, hasComponent, zoneComponents, type ArrangedItem, type LayoutDoc, type PageLayout } from "./pageLayout";
import { listKey, RelatedLists, RelatedOf, type RelatedExclude } from "./RelatedLists";
import { StagePath } from "./StagePath";
import { TaskLine, Timeline, useTimeline } from "./Timeline";

/** What every part of the page needs to draw itself. */
interface Ctx { meta: ObjectMeta; record: RecordData; save: SaveFields; archived: boolean }

/**
 * Column widths for a layout, by which columns have anything in them: an empty column takes no space.
 * Three columns on wide screens (the main one takes what the others leave), two on medium (the main column
 * beside the left and right ones stacked), one on a phone in the order left, main, right. Written out in
 * full so Tailwind sees every class.
 */
const WIDE: Record<string, string> = {
  LMR: "min-[1360px]:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(16rem,22rem)]",
  LM: "min-[1360px]:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)]",
  MR: "min-[1360px]:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]",
  LR: "min-[1360px]:grid-cols-2",
};
const RESET = "min-[1360px]:col-auto min-[1360px]:row-auto min-[1360px]:row-span-1";

export function columnClasses(has: { left: boolean; main: boolean; right: boolean }) {
  const key = `${has.left ? "L" : ""}${has.main ? "M" : ""}${has.right ? "R" : ""}`;
  const split = has.main && (has.left || has.right);
  return {
    grid: split ? `md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] md:grid-rows-[auto_1fr] ${WIDE[key] ?? ""}` : has.left && has.right ? "md:grid-cols-2" : "",
    left: split ? `md:col-start-1 md:row-start-1 ${RESET}` : "",
    main: split ? `md:col-start-2 md:row-start-1 md:row-span-2 ${RESET}` : "",
    right: split ? `md:col-start-1 ${has.left ? "md:row-start-2" : "md:row-start-1"} ${RESET}` : "",
  };
}

/**
 * Everything under the record's header: the layout's `top`, then its three columns. Until the layout is
 * known (or when the server sent none), the page is the one it was before layouts: fields, notes, files and
 * related records in one column and the timeline beside it.
 */
export function PageBody({ meta, record, fields, layout, save, archived }: {
  meta: ObjectMeta; record: RecordData; fields: FieldMeta[]; layout: PageLayout | undefined; save: SaveFields; archived: boolean;
}) {
  const ctx: Ctx = { meta, record, save, archived };
  const doc = layout?.layout;
  if (!doc) return <LegacyBody ctx={ctx} fields={fields} layout={layout} />;
  const page = arrangePage(fields, doc, { defaultPage: layout?.custom === false });
  const lastFields = [...doc.columns.left].reverse().find((c) => c.type === "fields");
  const otherColumns = lastFields?.type === "fields" ? lastFields.columns : 1;
  const cls = columnClasses({ left: true, main: page.main.length > 0, right: page.right.length > 0 });
  const part = (item: ArrangedItem) => <Part key={item.kind === "other" ? "other" : item.component.id} item={item} ctx={ctx} doc={doc} otherColumns={otherColumns} />;
  return (
    <div className="flex flex-col gap-6 px-4 pt-5 md:px-6">
      <div className="flex min-w-0 flex-col gap-4 empty:hidden">{page.top.map(part)}</div>
      <div className={`grid grid-cols-1 items-start gap-6 ${cls.grid}`}>
        {/* The left column always ends with the record's own details, so it is never empty. */}
        <div className={`flex min-w-0 flex-col gap-6 ${cls.left}`}>{page.left.map(part)}<SystemSection record={record} /></div>
        {page.main.length ? <div className={`flex min-w-0 flex-col gap-6 ${cls.main}`}>{page.main.map(part)}</div> : null}
        {page.right.length ? <div className={`flex min-w-0 flex-col gap-6 ${cls.right}`}>{page.right.map(part)}</div> : null}
      </div>
    </div>
  );
}

function LegacyBody({ ctx, fields, layout }: { ctx: Ctx; fields: FieldMeta[]; layout: PageLayout | undefined }) {
  const { meta, record, save, archived } = ctx;
  return (
    <div className="grid gap-6 px-4 pt-5 md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
      <div className="flex min-w-0 flex-col gap-6">
        {arrangeFields(fields, layout).map((sec) => <FieldSection key={sec.title} title={sec.title} fields={sec.fields} meta={meta} record={record} save={save} readOnly={archived} />)}
        <Notes recordId={record.id} />
        <Files recordId={record.id} canWrite={Boolean(meta.access.write) && !archived} />
        <RelatedLists object={meta.name} id={record.id} name={record.display_name ?? ""} />
        <SystemSection record={record} />
      </div>
      <div className="min-w-0"><Timeline recordId={record.id} /></div>
    </div>
  );
}

/** One part of the page. */
function Part({ item, ctx, doc, otherColumns }: { item: ArrangedItem; ctx: Ctx; doc: LayoutDoc; otherColumns: 1 | 2 }) {
  const { meta, record, save, archived } = ctx;
  if (item.kind === "other") return <FieldSection title="Other fields" fields={item.fields} meta={meta} record={record} save={save} readOnly={archived} columns={otherColumns} />;
  const c = item.component;
  const name = record.display_name ?? "";
  switch (c.type) {
    case "fields": return <FieldSection key={`${c.id}:${c.collapsed}`} title={c.name} fields={item.fields} meta={meta} record={record} save={save} readOnly={archived} columns={c.columns} collapsed={c.collapsed} />;
    case "related": return <RelatedOf of={meta.name} object={c.object} field={c.field} rows={c.rows} id={record.id} name={name} />;
    case "related_lists": return <RelatedLists object={meta.name} id={record.id} name={name} exclude={relatedPlacedElsewhere(doc)} />;
    case "timeline": return <Timeline recordId={record.id} />;
    case "notes": return <Notes recordId={record.id} />;
    case "files": return <Files recordId={record.id} canWrite={Boolean(meta.access.write) && !archived} />;
    case "tasks": return <Tasks recordId={record.id} rows={c.rows} />;
    case "quotes": return <RelatedOf of={meta.name} object="quote" rows={c.rows} id={record.id} name={name} />;
    case "stage_path": return <StagePath meta={meta} record={record} field={c.field} save={save} readOnly={archived} />;
    case "agent_changes": return <AgentChanges meta={meta} recordId={record.id} days={c.days} />;
  }
}

/** The related lists the group leaves out because the layout draws them on their own (a `related`, or all quotes). */
export function relatedPlacedElsewhere(doc: LayoutDoc): RelatedExclude {
  const lists = new Set<string>();
  for (const zone of ["top", "left", "main", "right"] as const) for (const c of zoneComponents(doc, zone)) if (c.type === "related") lists.add(listKey(c.object, c.field));
  return { lists, ...(hasComponent(doc, "quotes") ? { objects: new Set(["quote"]) } : {}) };
}

function SystemSection({ record }: { record: RecordData }) {
  const rows: [string, ReactNode][] = [
    ["ID", <span key="id" className="flex items-center gap-2"><code className="font-mono text-sm">{record.id}</code><CopyButton text={record.id} label="Copy ID" size="icon-sm" /></span>],
    ["Created", formatDateTime(record.created_at)],
    ["Last updated", formatDateTime(record.updated_at)],
    ["Version", String(record.version ?? "")],
  ];
  if (record.archived_at) rows.push(["Archived", formatDateTime(record.archived_at)]);
  return (
    <section aria-label="Record information" className="rounded-lg border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-2.5 text-md font-semibold">Record</h2>
      <dl className="grid grid-cols-1 gap-x-4 px-4 py-2 sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="py-1.5"><dt className="text-sm text-muted">{k}</dt><dd className="text-base">{v}</dd></div>)}
      </dl>
    </section>
  );
}

/** A task is open until its status says it is done or cancelled; a status this member can't read counts as open. */
export function isOpenTask(task: RecordData, status: FieldMeta | undefined): boolean {
  const category = status?.values?.find((v) => v.key === task.status)?.category;
  return category !== "done" && category !== "cancelled";
}

/** Soonest due first; tasks with no due date last. */
export function byDue(a: RecordData, b: RecordData): number {
  const at = typeof a.due_at === "string" ? Date.parse(a.due_at) : Infinity;
  const bt = typeof b.due_at === "string" ? Date.parse(b.due_at) : Infinity;
  return at - bt;
}

/**
 * Open tasks linked to this record, soonest due first. The API has no filter for "tasks linked to a record"
 * on the query endpoint, so they come from the record's timeline (the same request the Timeline and Notes
 * use), which carries the record's most recent tasks.
 */
function Tasks({ recordId, rows }: { recordId: string; rows: number }) {
  const objects = useObjects();
  const access = (objects.data ?? []).find((o: ObjectSummary) => o.name === "task")?.access;
  const task = useDescribe(access?.read ? "task" : undefined);
  const q = useTimeline(recordId, Boolean(access?.read));
  const [adding, setAdding] = useState(false);
  if (!access?.read) return null;
  const status = task.data?.fields.find((f) => f.name === "status");
  const open = (q.data ?? []).filter((it) => it.kind === "task" && isOpenTask(it.item, status)).map((it) => it.item).sort(byDue);
  return (
    <section aria-label="Open tasks" className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="flex-1 text-md font-semibold">Open tasks{open.length ? <span className="ml-2 text-sm font-normal text-subtle">{open.length}</span> : null}</h2>
        {access.write ? <Button size="sm" onClick={() => setAdding(true)}><Plus /> Task</Button> : null}
      </div>
      {q.isPending ? <div className="p-4"><Skeleton className="h-4 w-2/3" /></div>
        : q.error && !q.data ? <div className="p-3"><ProblemView error={q.error} onRetry={() => q.refetch()} compact /></div>
        : open.length === 0 ? <EmptyState title="No open tasks" className="py-6" />
        : (
          <ul className="divide-y divide-line">
            {open.slice(0, rows).map((t) => (
              <li key={t.id} className="px-4 py-2">
                <TaskLine task={t} recordId={recordId} />
                {typeof t.due_at === "string" ? <p className="ml-6 text-sm text-subtle">Due <time dateTime={t.due_at}>{formatDateTime(t.due_at)}</time></p> : null}
              </li>
            ))}
          </ul>
        )}
      {open.length > rows ? <p className="border-t border-line px-4 py-2 text-sm text-subtle">{open.length - rows} more open {open.length - rows === 1 ? "task" : "tasks"} are on the timeline.</p> : null}
      {adding ? <CreateRecordDialog object="task" open onOpenChange={setAdding} extra={{ related_to: [recordId] }} stay /> : null}
    </section>
  );
}
