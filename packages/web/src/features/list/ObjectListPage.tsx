import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { RowSelectionState } from "@tanstack/react-table";
import { Archive, FilterX, Info, PenLine, Plus, RotateCcw, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, NoAccess, PageHeader, ProblemView } from "@/components/feedback";
import { useDebounced } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { useApi } from "@/lib/api/context";
import { ApiProblem, asProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, Page, RecordData, Sort } from "@/lib/api/types";
import { fromWhere, packFilter, type Group } from "@/lib/filters";
import { formatTotal, useListTotals } from "./totals";
import { qk } from "@/lib/keys";
import { listPrefKey, usePrefs, useSetPrefs, type ListPref } from "@/lib/prefs";
import { plainLabel } from "@/lib/text";
import { useApplyWrite } from "@/lib/writes";
import { canWrite } from "@/meta/fields";
import { useDescribe } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { listRoute } from "@/router";
import { BulkDialog } from "./BulkDialog";
import { DataTable } from "./DataTable";
import { FilterButton } from "./FilterBuilder";
import { FilterChips } from "./FilterChips";
import { GroupedList } from "./GroupedList";
import { boardFields, calendarFields, groupFields, monthOf, totalFields } from "./layouts";
import { ColumnsMenu, LayoutOptions, LayoutSwitch, SortMenu, type ListLayout } from "./ListControls";
import { nextSearch, resolveList, type ListUrl } from "./listState";
import { RecordBoard } from "./RecordBoard";
import { RecordCalendar } from "./RecordCalendar";
import { useViews, ViewsMenu } from "./ViewsMenu";

const PAGE_SIZE = 100;

export function ObjectListPage() {
  const { object } = listRoute.useParams();
  const meta = useDescribe(object);
  if ((meta.error instanceof ApiProblem && meta.error.status === 403) || (meta.data && !meta.data.access.read)) {
    return <div className="p-6"><NoAccess title={meta.data ? `You don't have access to ${plainLabel(meta.data.plural_label).toLowerCase()}` : undefined} /></div>;
  }
  if (meta.error) return <div className="p-6"><ProblemView error={meta.error} onRetry={() => meta.refetch()} /></div>;
  if (!meta.data) return <ListSkeleton />;
  return <ListBody key={object} meta={meta.data} />;
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="border-b border-line bg-surface px-6 py-4"><Skeleton className="h-6 w-48" /></div>
      <div className="flex gap-2 border-b border-line bg-surface px-6 py-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-7 w-24" />)}</div>
      <div className="p-6">{Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="mb-3 h-5 w-full" />)}</div>
    </div>
  );
}

type PageData = InfiniteData<Page, string | undefined>;

function ListBody({ meta }: { meta: ObjectMeta }) {
  const api = useApi();
  const qc = useQueryClient();
  const applyWrite = useApplyWrite();
  const navigate = useNavigate({ from: "/o/$object" });
  const search = listRoute.useSearch() as ListUrl;
  const views = useViews(meta.name);
  const prefs = usePrefs();
  const setPrefs = useSetPrefs();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState<null | { mode: "archive" | "update"; field?: string }>(null);
  const [conflict, setConflict] = useState<RecordData | null>(null);

  const setSearch = useCallback((s: ListUrl) => void navigate({ search: s as never, replace: true }), [navigate]);

  // Coming back to a list with nothing in the URL: the member's last view and columns for this object.
  const restored = useRef(false);
  const [restoredView, setRestoredView] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (restored.current || !prefs.isSuccess) return;
    restored.current = true;
    const p = prefs.data?.[listPrefKey(meta.name)] as ListPref | undefined;
    if (!p || search.view || search.cols !== undefined || search.filter !== undefined || search.sort !== undefined || search.layout || search.group) return;
    const next: ListUrl = {};
    if (p.view) next.view = p.view;
    if (p.columns?.length) next.cols = p.columns.join(",");
    if (p.layout === "board" || p.layout === "calendar") next.layout = p.layout;
    if (p.by) next.by = p.by;
    if (p.group) next.group = p.group;
    if (next.view) setRestoredView(next.view);
    if (Object.keys(next).length) setSearch(next);
  }, [prefs.isSuccess, prefs.data, meta.name, search, setSearch]);

  const view = search.view ? views.data?.find((v) => v.id === search.view) : undefined;
  // A remembered view that is gone, broken or no longer shared with this member: drop it (here and in the
  // preference, so it doesn't come back), show the default list, and say so once in plain words.
  const dropRestored = useCallback((name: string | undefined) => {
    setRestoredView(null);
    setNote(name ? `Your last view, “${plainLabel(name)}”, can't be shown any more, so you're seeing all ${plainLabel(meta.plural_label).toLowerCase()}.`
      : `Your last view isn't available any more, so you're seeing all ${plainLabel(meta.plural_label).toLowerCase()}.`);
    setSearch({});
    setPrefs.mutate({ [listPrefKey(meta.name)]: { view: null } as ListPref });
  }, [meta.name, meta.plural_label, setPrefs, setSearch]);
  useEffect(() => {
    if (!restoredView || search.view !== restoredView || !views.isSuccess) return;
    const v = views.data.find((x) => x.id === restoredView);
    if (!v || v.status !== "ok") dropRestored(v?.name);
  }, [restoredView, search.view, views.isSuccess, views.data, dropRestored]);
  const viewFilter = useMemo(() => (view?.status === "ok" && view.where ? fromWhere(view.where) : null), [view]);
  const list = resolveList(search, meta, views.data, viewFilter);

  // Remember the view and the column layout (not filters: those belong to views and links).
  const prefValue = JSON.stringify({ view: list.viewId ?? null, columns: list.columnsOverridden ? list.columns : undefined,
    layout: search.layout ?? null, by: search.by ?? null, group: search.group ?? null });
  const lastSaved = useRef<string | null>(null);
  const debouncedPref = useDebounced(prefValue, 300);
  useEffect(() => {
    if (!restored.current || lastSaved.current === debouncedPref) return;
    if (lastSaved.current === null) {
      lastSaved.current = debouncedPref;
      if (JSON.stringify(prefs.data?.[listPrefKey(meta.name)] ?? { view: null }) === debouncedPref) return;
    }
    lastSaved.current = debouncedPref;
    setPrefs.mutate({ [listPrefKey(meta.name)]: JSON.parse(debouncedPref) as ListPref });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedPref]);

  const where = useDebounced(list.where, 350);
  const waitingForView = Boolean(search.view) && views.isPending;

  // How the list is shown. A layout the object has no field for (or a field that is gone) falls back to the table.
  const boards = useMemo(() => boardFields(meta), [meta]);
  const dates = useMemo(() => calendarFields(meta), [meta]);
  const groups = useMemo(() => groupFields(meta), [meta]);
  const layout: ListLayout = search.layout === "board" && boards.length ? "board" : search.layout === "calendar" && dates.length ? "calendar" : "table";
  const boardBy = boards.find((f) => f.name === search.by) ?? boards[0];
  const dateBy = dates.find((f) => f.name === search.by) ?? dates[0];
  const groupBy = layout === "table" ? groups.find((f) => f.name === search.group) : undefined;
  const plainTable = layout === "table" && !groupBy;
  // The other layouts ask for their own slices of the same list: the filter in the URL, else the view's.
  const baseWhere = list.filterOverridden ? where : view?.status === "ok" ? view.where ?? undefined : undefined;
  const showAs = (change: Partial<Pick<ListUrl, "layout" | "by" | "group" | "month">>) => {
    const next: ListUrl = { ...search, ...change };
    for (const k of ["layout", "by", "group", "month"] as const) if (next[k] === undefined) delete next[k];
    setSearch(next);
  };
  const params = { view: list.viewId, where, sort: list.sort, fields: list.fields, include: list.include };
  const rows = useInfiniteQuery({
    queryKey: qk.list(meta.name, params),
    queryFn: ({ pageParam, signal }) => api.request<Page>("POST", "/v1/query", {
      signal,
      body: {
        object: meta.name, ...(list.viewId ? { view: list.viewId } : {}), ...(where ? { where } : {}), ...(list.sort.length ? { sort: list.sort } : {}),
        fields: list.fields, ...(list.include.length ? { include: list.include } : {}), limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : { count: true }),
      },
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: !waitingForView && plainTable,
  });
  // What the number columns shown add up to over the whole filtered list (not only the loaded rows).
  const totalCols = useMemo(() => (plainTable ? totalFields(meta, list.columns) : []), [plainTable, meta, list.columns]);
  const totals = useListTotals(meta, baseWhere, totalCols, plainTable && !waitingForView);
  const records = useMemo(() => rows.data?.pages.flatMap((p) => p.data) ?? [], [rows.data]);
  const first = rows.data?.pages[0];
  const selectedIds = Object.keys(selection).filter((k) => selection[k]);

  useEffect(() => setSelection({}), [list.viewId, JSON.stringify(where), meta.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchRows = (id: string, fn: (r: RecordData) => RecordData) => {
    qc.setQueriesData<PageData>({ queryKey: ["records", meta.name, "list"] }, (d) => d && {
      ...d, pages: d.pages.map((p) => ({ ...p, data: p.data.map((r) => (r.id === id ? fn(r) : r)) })),
    });
  };

  const onEdit = async (record: RecordData, field: FieldMeta, value: unknown) => {
    const before = record[field.name];
    patchRows(record.id, (r) => ({ ...r, [field.name]: value }));
    try {
      const res = await api.patch<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(record.id)}`,
        { [field.name]: value }, { ifMatch: record.version });
      // The new value and version in every row and on the record's page; lists, counts and totals refetch.
      applyWrite({ object: meta.name, id: record.id, record: res.data });
    } catch (e) {
      patchRows(record.id, (r) => ({ ...r, [field.name]: before }));
      const p = asProblem(e);
      if (p.status === 412) setConflict(record);
      throw p;
    }
  };

  // The remembered view failed when used (refused, or the schema moved under it): the same as above.
  useEffect(() => {
    if (restoredView && search.view === restoredView && rows.error instanceof ApiProblem && [403, 404, 422].includes(rows.error.status)) dropRestored(view?.name);
  }, [rows.error, restoredView, search.view, view?.name, dropRestored]);

  const canCreate = meta.access.write;
  const ownerField = meta.fields.find((f) => f.name === "owner");
  const canAssignOwner = Boolean(ownerField && canWrite(ownerField, meta.access, "edit"));
  const dealSum = meta.name === "deal" ? totals.data?.sums.get("amount") : undefined;
  const footer = plainTable && totalCols.length && (totals.data || totals.isPending) ? {
    cells: Object.fromEntries(totalCols.map((f) => [f.name, totals.data ? (
      <span className="flex flex-col items-end py-1 leading-4">
        <span className="sr-only">Sum of {f.label.toLowerCase()}: </span>
        {(totals.data.sums.get(f.name) ?? []).length ? (totals.data.sums.get(f.name) ?? []).map((l) => <span key={l.currency ?? "-"} className="tabular">{formatTotal(f, l)}</span>) : "—"}
      </span>
    ) : <Skeleton className="h-3 w-16" />])),
  } : undefined;
  const filterActive = Boolean(list.filter && list.filter.children.length);
  // The board shows the same group of records as this list: the filter in the address, else the saved view's.
  const boardFilter = list.filterOverridden ? (filterActive ? list.filter : null) : viewFilter;
  const viewError = rows.error instanceof ApiProblem && list.viewId && (rows.error.status === 403 || rows.error.status === 404 || rows.error.code === "view_invalid");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        icon={<ObjectIcon object={meta} />}
        title={meta.plural_label}
        subtitle={first?.total !== undefined ? (
          <span aria-live="polite">{first.total_capped ? `More than ${first.total.toLocaleString()}` : first.total.toLocaleString()} {first.total === 1 ? meta.label.toLowerCase() : meta.plural_label.toLowerCase()}{filterActive || list.viewId ? " match" : ""}{dealSum?.length ? <> · <span className="tabular">{dealSum.map((l) => formatTotal(totalCols.find((f) => f.name === "amount")!, l)).join(" · ")}</span></> : null}</span>
        ) : rows.isPending && plainTable ? <Skeleton className="mt-1 h-3 w-24" /> : null}
        actions={<>
          <LayoutSwitch layout={layout} onLayout={(l) => showAs({ layout: l === "table" ? undefined : l, by: undefined, month: undefined })}
            hasBoard={boards.length > 0} hasCalendar={dates.length > 0}
            boardLink={meta.name === "deal" && (meta.pipelines?.length ?? 0) > 0 && layout !== "board" ? { filter: boardFilter ? packFilter(boardFilter) : undefined } : undefined} />
          {canCreate ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /><span className="truncate">New {meta.label.toLowerCase()}</span></Button> : null}
        </>}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-6" role="toolbar" aria-label="List controls">
        <ViewsMenu meta={meta} views={views.data ?? []} current={view} modified={list.modified && Boolean(view)}
          definition={{ where: list.filterOverridden ? list.where : view?.where ?? undefined, sort: list.sort, columns: list.columns }}
          onApply={(id) => setSearch(nextSearch(search, { view: id }))} />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <FilterButton meta={meta} value={list.filter} onChange={(g: Group | null) => setSearch(nextSearch(search, { filter: g ?? (list.viewId ? { kind: "group", conj: "and", children: [] } : null) }))} />
        {layout === "table" ? <SortMenu meta={meta} sort={list.sort} onChange={(s: Sort[]) => setSearch(nextSearch(search, { sort: s }))} /> : null}
        {layout === "calendar" ? null : <ColumnsMenu meta={meta} columns={list.columns} overridden={list.columnsOverridden}
          onChange={(c) => setSearch(nextSearch(search, { columns: c }))} onReset={() => setSearch(nextSearch(search, { columns: null }))} />}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <LayoutOptions layout={layout}
          boardBy={boardBy} boardFields={boards} onBoardBy={(n) => showAs({ by: n })}
          dateBy={dateBy} dateFields={dates} onDateBy={(n) => showAs({ by: n })}
          groupBy={groupBy} groupFields={groups} onGroupBy={(n) => showAs({ group: n ?? undefined })} />
        {list.modified ? (
          <Button size="sm" variant="ghost" onClick={() => setSearch({ ...(list.viewId ? { view: list.viewId } : {}) })}>
            <RotateCcw /> {list.viewId ? "Reset to view" : "Reset"}
          </Button>
        ) : null}
        {selectedIds.length ? (
          <div className="ml-auto flex items-center gap-2" role="group" aria-label="Selected records">
            <span className="text-sm text-muted">{selectedIds.length} selected</span>
            {meta.access.write ? <Button size="sm" onClick={() => setBulk({ mode: "update" })}><PenLine /> Change…</Button> : null}
            {canAssignOwner ? <Button size="sm" onClick={() => setBulk({ mode: "update", field: "owner" })}><UserPlus /> Assign owner…</Button> : null}
            {meta.access.archive ? <Button size="sm" variant="danger-ghost" onClick={() => setBulk({ mode: "archive" })}><Archive /> Archive…</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => setSelection({})}>Clear</Button>
          </div>
        ) : null}
      </div>
      <FilterChips meta={meta} filter={list.filter} onChange={(g) => setSearch(nextSearch(search, { filter: g ?? (list.viewId ? { kind: "group", conj: "and", children: [] } : null) }))} />
      {plainTable && totals.data?.capped ? (
        <p role="status" className="border-b border-warning/50 bg-warning-soft px-4 py-2 text-base text-warning-fg md:px-6">
          Totals cover the 100,000 most recently changed records. Filter the list for exact figures.
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        {note ? (
          <div role="status" className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-base text-info-fg md:mx-6">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" /><span className="flex-1">{note}</span>
            <Button size="icon-sm" variant="subtle" aria-label="Dismiss" onClick={() => setNote(null)}><X /></Button>
          </div>
        ) : null}
        {waitingForView && !plainTable ? <ListSkeleton /> : layout === "board" && boardBy ? (
          <RecordBoard meta={meta} field={boardBy} where={baseWhere} cardFields={list.columns} />
        ) : layout === "calendar" && dateBy ? (
          <RecordCalendar meta={meta} field={dateBy} where={baseWhere} month={search.month ?? monthOf(new Date())} onMonth={(m) => showAs({ month: m === monthOf(new Date()) ? undefined : m })} />
        ) : groupBy ? (
          <GroupedList meta={meta} field={groupBy} where={baseWhere} columns={list.columns} sort={list.sort} />
        ) : rows.error && !rows.data && viewError ? (
          <div className="p-6">
            <EmptyState icon={<FilterX />} title="This view can't be shown"
              action={<Button onClick={() => setSearch({})}>Show all {plainLabel(meta.plural_label).toLowerCase()}</Button>}>
              {asProblem(rows.error).status === 403 ? "It isn't shared with you, or your role can't use what it filters on." : "It refers to fields that changed or were removed. Its owner can fix it, or you can use another view."}
            </EmptyState>
          </div>
        ) : rows.error && !rows.data ? (
          <div className="p-6">
            <ProblemView error={rows.error} onRetry={() => rows.refetch()} />
          </div>
        ) : !rows.isPending && records.length === 0 ? (
          filterActive || list.viewId ? (
            <EmptyState icon={<FilterX />} title={`No ${meta.plural_label.toLowerCase()} match`}
              action={<Button onClick={() => setSearch(list.viewId ? nextSearch(search, { view: null }) : {})}>Clear the filter</Button>}>
              Try fewer conditions, or another view.
            </EmptyState>
          ) : (
            <EmptyState icon={<ObjectIcon object={meta} />} title={`No ${meta.plural_label.toLowerCase()} yet`}
              action={canCreate ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New {meta.label.toLowerCase()}</Button> : null}>
              {meta.description}
            </EmptyState>
          )
        ) : (
          <DataTable
            meta={meta} rows={records} columns={list.columns} sort={list.sort} total={first?.total} footer={footer}
            onSortChange={(s) => setSearch(nextSearch(search, { sort: s }))}
            selection={selection} onSelectionChange={setSelection}
            onEdit={meta.access.write ? onEdit : undefined}
            loading={rows.isPending || waitingForView} hasMore={Boolean(rows.hasNextPage)} loadingMore={rows.isFetchingNextPage}
            onLoadMore={() => void rows.fetchNextPage()}
          />
        )}
      </div>
      {creating ? <CreateRecordDialog object={meta.name} open onOpenChange={setCreating} /> : null}
      {bulk ? <BulkDialog meta={meta} ids={selectedIds} mode={bulk.mode} initialField={bulk.field} onClose={() => setBulk(null)} onDone={() => {
        setBulk(null);
        setSelection({});
      }} /> : null}
      <ConfirmDialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)}
        title="Changed by someone else"
        description={`${conflict?.display_name ?? "This record"} was changed after this list loaded, so your edit wasn't saved. Reload to see the latest values, then make your change again.`}
        confirmLabel="Reload" onConfirm={() => {
          setConflict(null);
          void qc.invalidateQueries({ queryKey: qk.records(meta.name) });
        }} />
    </div>
  );
}


