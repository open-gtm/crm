import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Columns3, GripVertical, MoreHorizontal, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, NoAccess, PageHeader, ProblemView } from "@/components/feedback";
import { Avatar, useDebounced } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { FilterButton } from "@/features/list/FilterBuilder";
import { DealsLayoutLinks } from "@/features/list/ListControls";
import { isStale, lastActivityField, StalePill } from "@/features/list/stale";
import { useApi } from "@/lib/api/context";
import { ApiProblem, asProblem, isBusy } from "@/lib/api/problem";
import type { AggregateResult, ObjectMeta, OpResult, Page, Pipeline, RecordData, Stage, Where } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { andWhere, compileWhere, packFilter, unpackFilter, type Group } from "@/lib/filters";
import { formatDate, formatMoney } from "@/lib/format";
import { qk } from "@/lib/keys";
import { partFields } from "@/meta/fields";
import { useDescribe } from "@/meta/hooks";
import { RecordLink } from "@/meta/registry";
import { useApplyWrite } from "@/lib/writes";
import { boardRoute } from "@/router";
import { DocsLink } from "@/lib/docs";

/**
 * The deals board: one column per stage of a pipeline, totals per column from the aggregate endpoint
 * (per currency when a column mixes them), and drag-and-drop (or the card's "Move to" menu, from the
 * keyboard) to change a deal's stage through the move_deal_stage operation.
 */

const PAGE = 200;

/**
 * Keyboard dragging moves one column per arrow press (Left/Right), so a picked-up card always lands over
 * the next stage; Up/Down do nothing. Space or Enter picks the card up and drops it, Escape cancels. When
 * the next column is off to the side, the board scrolls to it at once (not smoothly), so a quick Space
 * after the arrow drops the card where it shows.
 */
export const columnCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return event.code === "ArrowUp" || event.code === "ArrowDown" ? currentCoordinates : undefined;
  event.preventDefault();
  const rect = context.collisionRect;
  if (!rect) return undefined;
  const columns = [...context.droppableRects.entries()]
    .filter(([id]) => !context.droppableContainers.get(id)?.disabled)
    .map(([, r]) => r)
    .sort((a, b) => a.left - b.left);
  const center = rect.left + rect.width / 2;
  let at = columns.findIndex((r) => center >= r.left && center <= r.left + r.width);
  if (at === -1) at = columns.reduce((best, r, i) => (Math.abs(r.left - rect.left) < Math.abs(columns[best]!.left - rect.left) ? i : best), 0);
  const target = columns[at + (event.code === "ArrowRight" ? 1 : -1)];
  if (!target) return currentCoordinates;
  return { x: target.left + (target.width - rect.width) / 2, y: currentCoordinates.y };
};
type Pages = InfiniteData<Page, string | undefined>;
interface Total { count: number; sums: { currency: string | null; amount: number | null }[] }

export function DealsBoard() {
  const meta = useDescribe("deal");
  // A role that can't read deals gets one plain message, not the board's controls and their errors.
  if ((meta.error instanceof ApiProblem && meta.error.status === 403) || (meta.data && !meta.data.access.read)) {
    return <div className="p-6"><NoAccess title="You don't have access to deals">Your role doesn't include reading deals, so there's no board to show. If you need it, ask a workspace admin.</NoAccess></div>;
  }
  if (meta.error) return <div className="p-6"><ProblemView error={meta.error} onRetry={() => meta.refetch()} /></div>;
  if (!meta.data) return <div className="p-6" aria-busy="true"><Skeleton className="h-7 w-56" /><div className="mt-6 flex gap-3">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-96 w-72" />)}</div></div>;
  const pipelines = meta.data.pipelines ?? [];
  if (!pipelines.length) return <EmptyState icon={<Columns3 />} title="No pipelines yet">A pipeline is the list of stages your deals move through. An admin sets them up with the <code>crm</code> command-line tool or the API; the <DocsLink page="cli.md">command-line guide</DocsLink> shows how.</EmptyState>;
  return <RoutedBoard meta={meta.data} pipelines={pipelines} />;
}

function RoutedBoard({ meta, pipelines }: { meta: ObjectMeta; pipelines: Pipeline[] }) {
  const search = boardRoute.useSearch();
  const navigate = useNavigate({ from: "/board" });
  return <Board meta={meta} pipelines={pipelines} search={search} setSearch={(s) => void navigate({ search: s, replace: true })} />;
}

export interface BoardSearch { pipeline?: string; filter?: unknown }

/** The board itself; the URL (pipeline, filter) comes in through `search`. */
export function Board({ meta, pipelines, search, setSearch }: { meta: ObjectMeta; pipelines: Pipeline[]; search: BoardSearch; setSearch: (s: BoardSearch) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const pipeline = pipelines.find((p) => p.id === search.pipeline) ?? pipelines.find((p) => p.is_default) ?? pipelines[0]!;
  const filter = search.filter !== undefined ? unpackFilter(search.filter) : null;
  const userWhere = useDebounced(compileWhere(filter, partFields(meta)), 350);
  const where = andWhere({ field: "pipeline", op: "eq", value: pipeline.id }, userWhere) as Where;
  // Creating a deal: from the header (no stage) or from the foot of a column (that stage).
  const [creating, setCreating] = useState<{ stage?: string } | null>(null);
  const [dragging, setDragging] = useState<RecordData | null>(null);
  const [lostFor, setLostFor] = useState<{ deal: RecordData; stage: Stage } | null>(null);
  const stageField = meta.fields.find((f) => f.name === "stage");
  const canMove = meta.access.write && stageField?.access === "write";
  const amountField = meta.fields.find((f) => f.name === "amount");
  const showAmount = amountField && amountField.access !== "none";

  const listKey = qk.board({ pipeline: pipeline.id, where: userWhere });
  const deals = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam, signal }) => api.request<Page>("POST", "/v1/query", {
      signal,
      body: { object: "deal", where, limit: PAGE, sort: [{ field: "updated_at", dir: "desc" }], include: ["account", "owner"].filter((n) => meta.fields.some((f) => f.name === n && f.access !== "none")), ...(pageParam ? { cursor: pageParam } : {}) },
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_cursor ?? undefined,
  });

  const totals = useQuery({
    queryKey: qk.aggregate("deal", { board: pipeline.id, where: userWhere, amount: showAmount }),
    queryFn: async ({ signal }) => {
      const run = (groupBy: { field: string }[]) => api.request<AggregateResult>("POST", "/v1/aggregate", {
        signal, body: { object: "deal", where, group_by: groupBy, measures: showAmount ? [{ op: "sum", field: "amount" }] : [], limit: 1000 },
      });
      let r: AggregateResult;
      let byCurrency = false;
      try {
        r = await run([{ field: "stage" }]);
      } catch (e) {
        // Deals in several currencies can't share a total: ask for one total per currency instead.
        if (!(e instanceof ApiProblem && e.code === "mixed_currencies")) throw e;
        r = await run([{ field: "stage" }, { field: "currency" }]);
        byCurrency = true;
      }
      const key = r.measures.find((m) => m.op === "sum")?.key;
      const out = new Map<string, Total>();
      for (const g of r.data) {
        const st = g.group.stage as { id: string } | null;
        if (!st) continue;
        const t = out.get(st.id) ?? { count: 0, sums: [] };
        t.count += g.count;
        const amount = key ? (g.values[key] as number | null) : null;
        t.sums.push({ currency: g.currency ?? (byCurrency ? (g.group.currency as string | null) : null) ?? meta.currency, amount });
        out.set(st.id, t);
      }
      return { totals: out, capped: r.rows_capped };
    },
  });

  const all = useMemo(() => deals.data?.pages.flatMap((p) => p.data) ?? [], [deals.data]);
  const byStage = useMemo(() => {
    const m = new Map<string, RecordData[]>();
    for (const d of all) m.set(String(d.stage), [...(m.get(String(d.stage)) ?? []), d]);
    return m;
  }, [all]);

  const setStageInCache = (id: string, stage: string) => qc.setQueryData<Pages>(listKey, (d) => d && {
    ...d, pages: d.pages.map((p) => ({ ...p, data: p.data.map((r) => (r.id === id ? { ...r, stage } : r)) })),
  });

  const move = async (deal: RecordData, stage: Stage, lostReason?: string) => {
    const from = String(deal.stage);
    if (from === stage.id) return;
    setStageInCache(deal.id, stage.id);
    try {
      const r = await api.post<OpResult<RecordData | null>>("/v1/ops/move_deal_stage", { deal: deal.id, stage: stage.id, ...(lostReason ? { lost_reason: lostReason } : {}) });
      toast.toast({ tone: "success", title: `Moved to ${stage.name}`, description: deal.display_name });
      // The deal's page and every list show the new stage; board totals refetch.
      applyWrite({ object: "deal", id: deal.id, ...(r.result ? { record: r.result } : {}) });
    } catch (e) {
      setStageInCache(deal.id, from);
      const p = asProblem(e);
      toast.toast({ tone: "error", title: p.status === 403 ? "You can't move this deal" : `Couldn't move it to ${stage.name}`, description: p.detail, requestId: p.requestId });
    }
  };
  const requestMove = (deal: RecordData, stage: Stage) => {
    if (stage.category === "lost" && meta.fields.find((f) => f.name === "lost_reason")?.access === "write") setLostFor({ deal, stage });
    else void move(deal, stage);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates, scrollBehavior: "auto" }));
  const onDragStart = (e: DragStartEvent) => setDragging(all.find((d) => d.id === e.active.id) ?? null);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const deal = all.find((d) => d.id === e.active.id);
    const stage = pipeline.stages.find((s) => s.id === e.over?.id);
    if (deal && stage) requestMove(deal, stage);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader icon={<Columns3 />} title="Deals board" subtitle={totals.data?.capped ? "Totals cover the 100,000 most recently updated deals" : `${pipeline.name} pipeline`}
        actions={<>
          <DealsLayoutLinks filter={filter ? packFilter(filter) : undefined} />
          {meta.access.write ? <Button variant="primary" onClick={() => setCreating({})}><Plus /> New deal</Button> : null}
        </>} />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-6" role="toolbar" aria-label="Board controls">
        {pipelines.length > 1 ? (
          <NativeSelect aria-label="Pipeline" className="h-7 w-auto" value={pipeline.id} onChange={(e) => setSearch({ ...search, pipeline: e.target.value })}>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
        ) : null}
        <FilterButton meta={meta} value={filter} onChange={(g: Group | null) => {
          const { filter: _old, ...rest } = search;
          setSearch(g ? { ...rest, filter: packFilter(g) } : rest);
        }} />
        {!canMove ? <p className="text-sm text-subtle">Your role can view deals but not move them.</p> : (
          <p id="board-help" className="hidden text-sm text-subtle sm:block">
            Drag a card by its handle to another stage, or use its menu. With the keyboard: focus a handle, Space to pick the card up, Left and Right arrows to move it one stage, Space to drop.
          </p>
        )}
      </div>
      {deals.error && !deals.data ? <div className="p-6"><ProblemView error={deals.error} onRetry={() => deals.refetch()} /></div> : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}
          accessibility={{ announcements: {
            onDragStart: ({ active }) => `Picked up ${all.find((d) => d.id === active.id)?.display_name ?? "deal"}. Left and Right arrows move it one stage, Space drops it, Escape cancels.`,
            onDragOver: ({ over }) => (over ? `Over ${pipeline.stages.find((s) => s.id === over.id)?.name ?? "a stage"}.` : "Not over a stage."),
            onDragEnd: ({ over }) => (over ? `Dropped in ${pipeline.stages.find((s) => s.id === over.id)?.name ?? "a stage"}.` : "Dropped."),
            onDragCancel: () => "Move cancelled.",
          }, screenReaderInstructions: { draggable: "To move this deal, press Space, then Left or Right to choose a stage, and Space again to drop it. Escape cancels. The card's menu also moves it." } }}>
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4 md:px-6" aria-label={`${pipeline.name} stages`}>
            {pipeline.stages.map((s) => (
              <Column key={s.id} stage={s} stages={pipeline.stages} meta={meta} deals={byStage.get(s.id) ?? []} total={totals.data?.totals.get(s.id)}
                totalsLoading={totals.isPending && !totals.error} totalsMissing={Boolean(totals.error && !totals.data)} loading={deals.isPending} canMove={Boolean(canMove)} onMove={requestMove} showAmount={Boolean(showAmount)}
                onAdd={meta.access.write ? () => setCreating({ stage: s.id }) : undefined} />
            ))}
          </div>
          <DragOverlay>{dragging ? <Card deal={dragging} meta={meta} stages={pipeline.stages} canMove={false} onMove={() => {}} overlay showAmount={Boolean(showAmount)} /> : null}</DragOverlay>
        </DndContext>
      )}
      {deals.hasNextPage ? (
        <div className="border-t border-line bg-surface px-6 py-2 text-sm">
          <Button size="sm" variant="ghost" busy={deals.isFetchingNextPage} onClick={() => void deals.fetchNextPage()}>Load more deals</Button>
          <span className="ml-2 text-muted">{all.length} loaded</span>
        </div>
      ) : null}
      {totals.error && !totals.data ? (
        // The board still works without its totals: the cards and counts of what is loaded show, the amounts don't.
        <p role="status" className="border-t border-line bg-surface px-6 py-2 text-sm text-muted">
          {isBusy(totals.error) ? "The server is busy, so column totals are left out for now." : "Column totals aren't available right now; the cards are up to date."}
          {" "}<button type="button" className="font-medium text-accent hover:underline" onClick={() => void totals.refetch()}>Try again</button>
        </p>
      ) : null}
      {creating ? <CreateRecordDialog object="deal" open onOpenChange={(o) => !o && setCreating(null)} prefill={{ pipeline: pipeline.id, ...(creating.stage ? { stage: creating.stage } : {}) }} stay /> : null}
      <Dialog open={lostFor !== null} onOpenChange={(o) => !o && setLostFor(null)}>
        {lostFor ? <LostDialog stage={lostFor.stage} onCancel={() => setLostFor(null)} onConfirm={(reason) => {
          const l = lostFor;
          setLostFor(null);
          void move(l.deal, l.stage, reason);
        }} /> : null}
      </Dialog>
    </div>
  );
}

function LostDialog({ stage, onCancel, onConfirm }: { stage: Stage; onCancel: () => void; onConfirm: (reason?: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <DialogContent title={`Move to ${stage.name}`} size="sm" footer={<><Button onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" form="lost-form">Move</Button></>}>
      <form id="lost-form" onSubmit={(e) => {
        e.preventDefault();
        onConfirm(reason.trim() || undefined);
      }}>
        <FormField label="Why was it lost?" hint="Optional">{(p) => <Input {...p} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} />}</FormField>
      </form>
    </DialogContent>
  );
}

function Column({ stage, stages, meta, deals, total, totalsLoading, totalsMissing, loading, canMove, onMove, showAmount, onAdd }: {
  stage: Stage; stages: Stage[]; meta: ObjectMeta; deals: RecordData[]; total: Total | undefined; totalsLoading: boolean; totalsMissing?: boolean; loading: boolean; canMove: boolean;
  onMove: (d: RecordData, s: Stage) => void; showAmount: boolean; onAdd?: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: !canMove });
  const count = total?.count ?? (totalsLoading ? null : deals.length);
  const sums = (total?.sums ?? []).filter((x) => x.amount !== null);
  const dot = stage.category === "won" ? "bg-success" : stage.category === "lost" ? "bg-danger" : "bg-accent";
  return (
    <section ref={setNodeRef} aria-label={`${stage.name}, ${count ?? "…"} deals`}
      className={cn("flex w-72 shrink-0 flex-col rounded-lg border border-line bg-surface-2/70", isOver && "ring-2 ring-focus")}>
      <header className="flex items-start gap-2 px-3 pb-2 pt-2.5">
        <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", dot)} />
        <h2 className="min-w-0 truncate text-base font-semibold">{stage.name}</h2>
        <span className="mt-px text-sm text-subtle tabular">{count ?? "…"}</span>
        {showAmount && !totalsMissing ? (
          <p className="ml-auto flex min-w-0 flex-col items-end text-right text-sm font-medium text-muted tabular">
            {totalsLoading ? <Skeleton className="h-3 w-20" /> : sums.length ? sums.map((s, i) => <span key={i}>{formatMoney(s.amount, s.currency)}</span>) : formatMoney(0, meta.currency)}
          </p>
        ) : null}
      </header>
      <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {loading ? [1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />) : deals.map((d) => (
          <Card key={d.id} deal={d} meta={meta} stages={stages} canMove={canMove} onMove={onMove} showAmount={showAmount} />
        ))}
        {!loading && total && total.count > deals.length ? <p className="px-1 text-sm text-subtle">{total.count - deals.length} more not loaded</p> : null}
        {onAdd ? <Button size="sm" variant="subtle" className="justify-start" aria-label={`Add deal to ${stage.name}`} onClick={onAdd}><Plus /> Add deal</Button> : null}
      </div>
    </section>
  );
}

function Card({ deal, meta, stages, canMove, onMove, overlay, showAmount }: {
  deal: RecordData; meta: ObjectMeta; stages: Stage[]; canMove: boolean; onMove: (d: RecordData, s: Stage) => void; overlay?: boolean; showAmount: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: deal.id, disabled: !canMove || overlay });
  const owner = deal.included?.owner?.display_name;
  const account = deal.included?.account;
  const name = deal.display_name || "(no name)";
  // The card itself is not a control: its drag handle, its link and its menu are three separate controls.
  // A pointer can drag from anywhere on the card; the keyboard drags with the handle.
  return (
    <article ref={setNodeRef} {...(canMove ? listeners : {})} aria-label={name}
      className={cn("group rounded-md border border-line bg-surface p-2.5 shadow-sm",
        canMove && "cursor-grab active:cursor-grabbing", isDragging && "opacity-40", overlay && "rotate-1 shadow-lg")}>
      <div className="flex items-start gap-1">
        {canMove && !overlay ? (
          <button type="button" ref={setActivatorNodeRef} {...attributes} aria-roledescription="draggable deal" aria-label={`Drag ${name}`} aria-describedby="board-help"
            className="-ml-1 mt-0.5 shrink-0 cursor-grab rounded-sm p-0.5 text-subtle hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
            <GripVertical aria-hidden className="size-4" />
          </button>
        ) : null}
        <RecordLink object="deal" id={deal.id} className="min-w-0 flex-1 text-base font-medium leading-5">{name}</RecordLink>
        {canMove && !overlay ? (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" aria-label={`Move ${deal.display_name}`} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                className="rounded-sm p-0.5 text-subtle hover:bg-surface-2 hover:text-fg"><MoreHorizontal className="size-4" /></button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLabel>Move to</MenuLabel>
              {stages.map((s) => <MenuItem key={s.id} disabled={s.id === deal.stage} onSelect={() => onMove(deal, s)}>{s.name}</MenuItem>)}
            </MenuContent>
          </Menu>
        ) : null}
      </div>
      {account?.display_name ? <p className="mt-0.5 truncate text-sm text-muted">{account.display_name}</p> : null}
      <div className="mt-2 flex items-center gap-2 text-sm">
        {showAmount ? <span className="font-medium tabular">{formatMoney(deal.amount, (deal.currency as string) ?? meta.currency) || "—"}</span> : null}
        {typeof deal.expected_close_date === "string" ? <span className="text-subtle tabular">· {formatDate(deal.expected_close_date)}</span> : null}
        <span className="flex-1" />
        {owner ? <span title={owner} className="inline-flex items-center gap-1 text-muted"><Avatar name={owner} /></span> : null}
      </div>
      {lastActivityField(meta) && isStale(deal.last_activity_at) ? <div className="mt-2"><StalePill value={deal.last_activity_at} /></div> : null}
    </article>
  );
}
