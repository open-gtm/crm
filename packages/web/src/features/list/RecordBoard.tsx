import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useQueries, useQuery } from "@tanstack/react-query";
import { GripVertical, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { columnCoordinates } from "@/features/board/DealsBoard";
import { useApi } from "@/lib/api/context";
import type { AggregateResult, FieldMeta, ObjectMeta, Page, RecordData, Where } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { andWhere } from "@/lib/filters";
import { qk } from "@/lib/keys";
import { useApplyWrite } from "@/lib/writes";
import { allowedStatuses } from "@/meta/fields";
import { FieldValue, RecordLink } from "@/meta/registry";
import { whereForKey } from "./layouts";

const PER_COLUMN = 30;
const NONE = "__none__";

/**
 * A board for any object: one column per value of a select or status field, plus one for records
 * without a value. A card moves to another column by dragging its handle (mouse or keyboard: Space,
 * arrows, Space) or from its Move menu; moving sets the field, like editing it. Where a status may not
 * move (its own rules), the server says so and the card stays.
 */
export function RecordBoard({ meta, field, where, cardFields }: { meta: ObjectMeta; field: FieldMeta; where: Where | undefined; cardFields: string[] }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const [dragging, setDragging] = useState<RecordData | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates }));
  const columns = [...(field.values ?? []).map((v) => ({ key: v.key, label: v.label })), { key: NONE, label: `No ${field.label.toLowerCase()}` }];
  const shown = cardFields.filter((c) => c !== field.name).map((c) => meta.fields.find((f) => f.name === c)).filter((f): f is FieldMeta => Boolean(f)).slice(0, 3);
  const canMove = Boolean(meta.access.write) && field.access === "write" && !field.read_only;

  const counts = useQuery({
    queryKey: qk.aggregate(meta.name, { board: field.name, where }),
    queryFn: async ({ signal }) => {
      const r = await api.request<AggregateResult>("POST", "/v1/aggregate", { signal, body: { object: meta.name, ...(where ? { where } : {}), group_by: [{ field: field.name }], limit: 1000 } });
      return new Map(r.data.map((g) => [(g.group[field.name] as string | null) ?? NONE, g.count]));
    },
  });
  const cards = useQueries({
    queries: columns.map((c) => ({
      queryKey: qk.list(meta.name, { board: field.name, column: c.key, where }),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.request<Page>("POST", "/v1/query", { signal, body: {
        object: meta.name, where: andWhere(where, whereForKey(field.name, c.key === NONE ? null : c.key)), limit: PER_COLUMN,
        fields: ["display_name", field.name, ...shown.map((f) => f.name)], sort: [{ field: "updated_at", dir: "desc" }] } }),
    })),
  });

  const move = async (record: RecordData, to: string) => {
    const from = (record[field.name] as string | null) ?? NONE;
    if (from === to || moving) return;
    setMoving(record.id);
    try {
      const res = await api.patch<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(record.id)}`,
        { [field.name]: to === NONE ? null : to }, { ifMatch: record.version });
      applyWrite({ object: meta.name, id: record.id, record: res.data });
    } catch (e) {
      toast.error(e, `Couldn't move ${record.display_name || "the record"}`);
    } finally {
      setMoving(null);
    }
  };
  const targetsFor = (record: RecordData) => {
    const allowed = field.type === "status" ? new Set(allowedStatuses(field, record[field.name])) : null;
    return columns.filter((c) => c.key !== ((record[field.name] as string | null) ?? NONE) && (c.key === NONE ? !field.required : !allowed || allowed.has(c.key)));
  };

  if (counts.error && !counts.data) return <div className="p-6"><ProblemView error={counts.error} onRetry={() => counts.refetch()} /></div>;
  return (
    <DndContext sensors={sensors}
      onDragStart={(e: DragStartEvent) => setDragging((e.active.data.current as { record: RecordData }).record)}
      onDragCancel={() => setDragging(null)}
      onDragEnd={(e: DragEndEvent) => {
        const record = (e.active.data.current as { record: RecordData }).record;
        setDragging(null);
        if (e.over) void move(record, String(e.over.id));
      }}>
      <div className="flex h-full gap-3 overflow-x-auto p-4 md:px-6" role="group" aria-label={`${meta.plural_label} by ${field.label.toLowerCase()}`}>
        {columns.map((c, i) => {
          const q = cards[i]!;
          const total = counts.data?.get(c.key) ?? 0;
          const rows = q.data?.data ?? [];
          return (
            <Column key={c.key} id={c.key} label={c.label} count={counts.data ? total : undefined} disabled={!canMove}>
              {q.isPending ? <Skeleton className="h-16" /> : q.error ? <ProblemView error={q.error} compact /> : rows.length === 0 ? <p className="px-1 py-2 text-sm text-subtle">Nothing here.</p>
                : rows.map((r) => (
                  <Card key={r.id} record={r} meta={meta} shown={shown} canMove={canMove} busy={moving === r.id} targets={targetsFor(r)} onMove={(to) => void move(r, to)} />
                ))}
              {rows.length < total ? <p className="px-1 pt-1 text-sm text-subtle">Showing the {rows.length} most recently changed of {total.toLocaleString()}. Filter the list to see the others.</p> : null}
            </Column>
          );
        })}
      </div>
      <DragOverlay>{dragging ? <div className="rounded-md border border-accent bg-surface px-3 py-2 text-base font-medium shadow-lg">{dragging.display_name || "Record"}</div> : null}</DragOverlay>
    </DndContext>
  );
}

function Column({ id, label, count, disabled, children }: { id: string; label: string; count: number | undefined; disabled: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return (
    <section ref={setNodeRef} aria-label={`${label}${count !== undefined ? `, ${count}` : ""}`}
      className={cn("flex w-72 shrink-0 flex-col rounded-lg border border-line bg-surface-2", isOver && "border-accent")}>
      <h2 className="flex items-center gap-2 border-b border-line px-3 py-2 text-base font-semibold">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count !== undefined ? <span className="text-sm font-normal text-subtle">{count.toLocaleString()}</span> : null}
      </h2>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto p-2">{children}</div>
    </section>
  );
}

function Card({ record, meta, shown, canMove, busy, targets, onMove }: {
  record: RecordData; meta: ObjectMeta; shown: FieldMeta[]; canMove: boolean; busy: boolean; targets: { key: string; label: string }[]; onMove: (to: string) => void;
}) {
  const name = record.display_name || "Untitled";
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: record.id, data: { record }, disabled: !canMove });
  return (
    <article ref={setNodeRef} aria-busy={busy} className={cn("rounded-md border border-line bg-surface px-3 py-2", (isDragging || busy) && "opacity-50")}>
      <div className="flex items-start gap-1">
        {canMove ? (
          <button type="button" {...attributes} {...listeners} aria-label={`Drag ${name}`} className="-ml-1 mt-0.5 cursor-grab rounded-sm text-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
            <GripVertical className="size-4" />
          </button>
        ) : null}
        <RecordLink object={meta.name} id={record.id} className="min-w-0 flex-1 truncate font-medium">{name}</RecordLink>
        {canMove && targets.length ? (
          <Menu>
            <MenuTrigger asChild><Button size="icon-sm" variant="subtle" aria-label={`Move ${name}`}><MoreHorizontal /></Button></MenuTrigger>
            <MenuContent align="end">{targets.map((t) => <MenuItem key={t.key} onSelect={() => onMove(t.key)}>{t.label}</MenuItem>)}</MenuContent>
          </Menu>
        ) : null}
      </div>
      {shown.length ? (
        <dl className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
          {shown.filter((f) => record[f.name] !== null && record[f.name] !== undefined && record[f.name] !== "").map((f) => (
            <div key={f.name} className="flex gap-1.5"><dt className="shrink-0 text-subtle">{f.label}</dt><dd className="min-w-0 truncate"><FieldValue field={f} value={record[f.name]} record={record} meta={meta} /></dd></div>
          ))}
        </dl>
      ) : null}
    </article>
  );
}
