import {
  columnSizingFeature, columnVisibilityFeature, rowSelectionFeature, tableFeatures, useTable, type ColumnDef, type RowSelectionState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Lock, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/overlays";
import type { FieldMeta, ObjectMeta, RecordData, Sort } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { canSort, canWrite, isRestrictedValue, readOnlyReason, toApiValue, toFormValue, validateValues, type FormValue } from "@/meta/fields";
import { FieldControl, FieldValue, isNumeric, RecordLink } from "@/meta/registry";
import { lastActivityField, StalePill } from "./stale";

/**
 * The records table: a virtualized grid (only visible rows are in the DOM, so thousands of loaded rows
 * stay smooth), server-side sorting on up to three columns (click a header; shift-click adds a column),
 * row selection, and editing a cell in place.
 *
 * Keyboard: arrow keys move between cells, Home/End to the row's ends, PageUp/PageDown by a screen,
 * Enter opens the record (name column) or edits the cell, F2 edits, Space selects the row, Escape cancels
 * an edit. Only one cell is in the tab order at a time.
 */

export const ROW_HEIGHT = 36;
const SELECT_COL = "__select";
const NAME_COL = "__name";
// Only what the grid uses: fixed column sizes, the visible columns, and row selection. Sorting is done by the server.
const features = tableFeatures({ columnSizingFeature, columnVisibilityFeature, rowSelectionFeature });

export interface DataTableProps {
  meta: ObjectMeta;
  rows: RecordData[];
  columns: string[];
  sort: Sort[];
  onSortChange: (s: Sort[]) => void;
  selection: RowSelectionState;
  onSelectionChange: (s: RowSelectionState) => void;
  /** Saves one field of one record; rejects with an ApiProblem when the server refuses. */
  onEdit?: (record: RecordData, field: FieldMeta, value: unknown) => Promise<void>;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Rows the server has in all (a count), for screen readers. */
  total?: number;
  /** A totals row pinned under the rows: what each number column adds up to for the whole filtered list. Absent cells stay empty. */
  footer?: { cells: Record<string, ReactNode> };
}

const SYSTEM: Record<string, FieldMeta> = {
  created_at: { name: "created_at", label: "Created", type: "datetime", read_only: true, access: "read" },
  updated_at: { name: "updated_at", label: "Updated", type: "datetime", read_only: true, access: "read" },
};

export function fieldOf(meta: ObjectMeta, name: string): FieldMeta | undefined {
  return meta.fields.find((f) => f.name === name) ?? (Object.hasOwn(SYSTEM, name) ? SYSTEM[name] : undefined);
}

/** Clicking a sortable header: replace the sort (or flip it); with shift, add it as the next key (at most three). */
export function toggleSort(sort: Sort[], field: string, additive: boolean): Sort[] {
  const i = sort.findIndex((s) => s.field === field);
  if (!additive) {
    if (i === 0 && sort.length === 1) return sort[0]!.dir === "asc" ? [{ field, dir: "desc" }] : [];
    return [{ field, dir: "asc" }];
  }
  if (i >= 0) {
    const cur = sort[i]!;
    return cur.dir === "asc" ? sort.map((s, j) => (j === i ? { field, dir: "desc" } : s)) : sort.filter((_, j) => j !== i);
  }
  return [...sort, { field, dir: "asc" as const }].slice(-3);
}

export function DataTable(p: DataTableProps) {
  const { meta, rows, columns } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 1 });
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);

  const colDefs = useMemo<ColumnDef<typeof features, RecordData>[]>(() => {
    const defs: ColumnDef<typeof features, RecordData>[] = [
      { id: SELECT_COL, size: 40, header: () => null, cell: () => null },
      { id: NAME_COL, size: 240, header: () => meta.label, cell: () => null },
    ];
    for (const c of columns) {
      const f = fieldOf(meta, c);
      if (f) defs.push({ id: c, size: f.type === "long_text" || f.type === "address" || f.type === "json" ? 280 : isNumeric(f.type) ? 140 : f.type === "relation" ? 200 : 170, header: () => f.label, cell: () => null });
    }
    return defs;
  }, [meta, columns]);

  const table = useTable({
    features,
    data: rows,
    columns: colDefs,
    getRowId: (r) => r.id,
    enableRowSelection: true,
    state: { rowSelection: p.selection },
    onRowSelectionChange: (u) => p.onSelectionChange(typeof u === "function" ? u(p.selection) : u),
  });
  const tableRows = table.getRowModel().rows;
  const leafCols = table.getVisibleLeafColumns();
  const width = leafCols.reduce((n, c) => n + c.getSize(), 0);

  const virtual = useVirtualizer({
    count: tableRows.length + (p.hasMore ? 1 : 0),
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });
  const items = virtual.getVirtualItems();

  // Load the next page as the end comes into view.
  const last = items[items.length - 1];
  useEffect(() => {
    if (last && last.index >= tableRows.length - 1 && p.hasMore && !p.loadingMore) p.onLoadMore();
  }, [last, tableRows.length, p]);

  const focusCell = useCallback((row: number, col: number) => {
    const r = Math.max(0, Math.min(row, tableRows.length - 1));
    const c = Math.max(0, Math.min(col, leafCols.length - 1));
    setFocus({ row: r, col: c });
    virtual.scrollToIndex(r, { align: "auto" });
    requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`)?.focus());
  }, [tableRows.length, leafCols.length, virtual]);

  const canEditCell = (row: RecordData, colId: string): boolean => {
    const f = fieldOf(meta, colId);
    return Boolean(p.onEdit && f && canWrite(f, meta.access, "edit") && !isRestrictedValue(row[colId]));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || (e.target as HTMLElement).closest("[data-editor]")) return;
    const { row, col } = focus;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1);
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusCell(row + 1, col), ArrowUp: () => focusCell(row - 1, col),
      ArrowRight: () => focusCell(row, col + 1), ArrowLeft: () => focusCell(row, col - 1),
      Home: () => focusCell(e.ctrlKey ? 0 : row, 0), End: () => focusCell(e.ctrlKey ? tableRows.length - 1 : row, leafCols.length - 1),
      PageDown: () => focusCell(row + page, col), PageUp: () => focusCell(row - page, col),
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      move();
      return;
    }
    const r = tableRows[row];
    const colId = leafCols[col]?.id;
    if (!r || !colId) return;
    if (e.key === " " ) {
      e.preventDefault();
      r.toggleSelected();
    } else if (e.key === "Enter" || e.key === "F2") {
      if (colId === NAME_COL && e.key === "Enter") {
        (scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"] a`))?.click();
      } else if (canEditCell(r.original, colId)) {
        e.preventDefault();
        setEditing({ row, col });
      }
    }
  };

  const allSelected = table.getIsAllRowsSelected();
  const someSelected = table.getIsSomeRowsSelected();

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={-1}
      aria-label={`${meta.plural_label}`}
      aria-rowcount={(p.total ?? rows.length) + 1 + (p.footer ? 1 : 0)}
      aria-colcount={leafCols.length}
      aria-multiselectable="true"
      onKeyDown={onKeyDown}
      className="relative h-full overflow-auto bg-surface"
    >
      <div style={{ width: Math.max(width, 0), minWidth: "100%" }}>
        <div role="row" aria-rowindex={1} className="sticky top-0 z-10 flex border-b border-line bg-surface-2 text-sm font-medium text-muted">
          {leafCols.map((c, ci) => {
            const id = c.id;
            const f = fieldOf(meta, id);
            const sortIdx = p.sort.findIndex((s) => s.field === id);
            const s = sortIdx >= 0 ? p.sort[sortIdx] : undefined;
            const sortable = f ? canSort(f) || id === "created_at" || id === "updated_at" : false;
            const sticky = id === SELECT_COL ? "sticky left-0 z-20 bg-surface-2" : id === NAME_COL ? "sticky left-10 z-20 bg-surface-2 border-r border-line" : "";
            return (
              <div key={id} role="columnheader" aria-colindex={ci + 1} aria-sort={s ? (s.dir === "asc" ? "ascending" : "descending") : sortable ? "none" : undefined}
                style={{ width: c.getSize() }} className={cn("flex h-9 shrink-0 items-center px-2", sticky, f && isNumeric(f.type) && "justify-end")}>
                {id === SELECT_COL ? (
                  <Checkbox aria-label="Select all loaded rows" checked={allSelected ? true : someSelected ? "indeterminate" : false}
                    onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)} />
                ) : sortable ? (
                  <button type="button" onClick={(e) => p.onSortChange(toggleSort(p.sort, id, e.shiftKey))}
                    title="Sort (shift-click to sort by several columns)"
                    className="-mx-1 flex min-w-0 items-center gap-1 rounded-sm px-1 py-0.5 hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
                    <span className="truncate">{f!.label}</span>
                    {s ? (
                      <span className="flex items-center text-accent">
                        {s.dir === "asc" ? <ArrowUp aria-hidden className="size-3.5" /> : <ArrowDown aria-hidden className="size-3.5" />}
                        {p.sort.length > 1 ? <span className="text-xs">{sortIdx + 1}</span> : null}
                      </span>
                    ) : null}
                  </button>
                ) : (
                  <span className="truncate">{id === NAME_COL ? meta.label : f?.label}</span>
                )}
              </div>
            );
          })}
        </div>
        {p.loading ? (
          <div aria-busy="true">
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} className="flex border-b border-line" style={{ height: ROW_HEIGHT }}>
                {leafCols.map((c) => <div key={c.id} style={{ width: c.getSize() }} className="flex shrink-0 items-center px-2"><Skeleton className={cn("h-3", c.id === SELECT_COL ? "w-4" : "w-3/4")} /></div>)}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {items.map((vi) => {
              const r = tableRows[vi.index];
              if (!r) {
                return (
                  <div key="more" role="row" aria-rowindex={vi.index + 2} className="absolute left-0 flex w-full items-center px-3" style={{ top: vi.start, height: ROW_HEIGHT }}>
                    <div role="gridcell" className="flex items-center gap-2 text-sm text-muted">
                      {p.loadingMore ? <><Skeleton className="h-3 w-40" /> Loading more…</> : <Button size="sm" variant="ghost" onClick={p.onLoadMore}>Load more</Button>}
                    </div>
                  </div>
                );
              }
              const selected = r.getIsSelected();
              return (
                <div key={r.id} role="row" aria-rowindex={vi.index + 2} aria-selected={selected}
                  className={cn("group absolute left-0 flex border-b border-line", selected ? "bg-accent-soft/60" : "hover:bg-surface-2")}
                  style={{ top: vi.start, height: ROW_HEIGHT, width: Math.max(width, 0), minWidth: "100%" }}>
                  {leafCols.map((c, ci) => {
                    const isFocus = focus.row === vi.index && focus.col === ci;
                    const sticky = c.id === SELECT_COL ? "sticky left-0 z-[1]" : c.id === NAME_COL ? "sticky left-10 z-[1] border-r border-line" : "";
                    const bg = sticky ? (selected ? "bg-accent-soft" : "bg-surface group-hover:bg-surface-2") : "";
                    return (
                      <div key={c.id} role="gridcell" aria-colindex={ci + 1} data-cell={`${vi.index}:${ci}`} tabIndex={isFocus ? 0 : -1}
                        onFocus={() => setFocus({ row: vi.index, col: ci })}
                        onDoubleClick={() => canEditCell(r.original, c.id) && setEditing({ row: vi.index, col: ci })}
                        style={{ width: c.getSize() }}
                        className={cn("relative flex shrink-0 items-center overflow-hidden px-2 text-base outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus", sticky, bg)}>
                        <Cell meta={meta} row={r.original} colId={c.id} selected={selected} onToggle={() => r.toggleSelected()}
                          editable={canEditCell(r.original, c.id)} onStartEdit={() => setEditing({ row: vi.index, col: ci })} />
                        {editing && editing.row === vi.index && editing.col === ci ? (
                          <CellEditor meta={meta} record={r.original} field={fieldOf(meta, c.id)!}
                            onDone={() => {
                              setEditing(null);
                              requestAnimationFrame(() => scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${vi.index}:${ci}"]`)?.focus());
                            }}
                            onSave={(v) => p.onEdit!(r.original, fieldOf(meta, c.id)!, v)} />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {p.footer && !p.loading ? (
          <div role="row" aria-rowindex={(p.total ?? rows.length) + 2} className="sticky bottom-0 z-10 flex border-t border-line bg-surface-2 text-sm font-medium text-muted">
            {leafCols.map((c, ci) => {
              const sticky = c.id === SELECT_COL ? "sticky left-0 z-[1] bg-surface-2" : c.id === NAME_COL ? "sticky left-10 z-[1] border-r border-line bg-surface-2" : "";
              const f = fieldOf(meta, c.id);
              return (
                <div key={c.id} role="gridcell" aria-colindex={ci + 1} style={{ width: c.getSize() }}
                  className={cn("flex min-h-9 shrink-0 items-center overflow-hidden px-2", sticky, f && isNumeric(f.type) && "justify-end text-right")}>
                  {c.id === NAME_COL ? "Total" : p.footer!.cells[c.id] ?? null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Cell({ meta, row, colId, selected, onToggle, editable, onStartEdit }: {
  meta: ObjectMeta; row: RecordData; colId: string; selected: boolean; onToggle: () => void; editable: boolean; onStartEdit: () => void;
}) {
  if (colId === SELECT_COL) return <Checkbox aria-label={`Select ${row.display_name || row.id}`} checked={selected} onCheckedChange={onToggle} tabIndex={-1} />;
  if (colId === NAME_COL) {
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <RecordLink object={meta.name} id={row.id} className="block truncate font-medium" >{row.display_name || "(no name)"}</RecordLink>
        {row.archived_at ? <span className="text-xs text-subtle">archived</span> : null}
      </span>
    );
  }
  const f = fieldOf(meta, colId);
  if (!f) return null;
  return (
    <>
      <span className={cn("min-w-0 flex-1", isNumeric(f.type) && "text-right")}><FieldValue field={f} value={row[colId]} record={row} meta={meta} /></span>
      {f === lastActivityField(meta) ? <StalePill value={row[colId]} /> : null}
      {editable ? (
        <button type="button" tabIndex={-1} aria-label={`Edit ${f.label}`} onClick={onStartEdit}
          className="ml-1 hidden shrink-0 rounded-sm p-0.5 text-subtle hover:bg-surface-3 hover:text-fg group-hover:inline-flex">
          <Pencil className="size-3" />
        </button>
      ) : null}
    </>
  );
}

/** Editing one cell: the field's own control in a small popover; Enter or Save writes, Escape cancels. */
function CellEditor({ meta, record, field, onSave, onDone }: {
  meta: ObjectMeta; record: RecordData; field: FieldMeta; onSave: (v: unknown) => Promise<void>; onDone: () => void;
}) {
  const s = useSession();
  const [value, setValue] = useState<FormValue>(() => toFormValue(field, record[field.name]));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reason = readOnlyReason(field, meta.access, "edit");
  const commit = async () => {
    const api = toApiValue(field, value);
    const problems = validateValues([field], { [field.name]: api }, "edit");
    if (problems[field.name]) {
      setError(problems[field.name]!);
      return;
    }
    setBusy(true);
    try {
      await onSave(api);
      onDone();
    } catch (e) {
      const p = e as { fieldErrors?: Record<string, string>; detail?: string; status?: number };
      if (p.status === 412) onDone(); // the table shows the conflict dialog
      else {
        const m = p.fieldErrors?.[field.name];
        setError(m ? m.charAt(0).toUpperCase() + m.slice(1) : p.detail ?? "Couldn't save");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover open onOpenChange={(o) => !o && onDone()}>
      <PopoverAnchor className="absolute inset-0" />
      <PopoverContent className="w-80" data-editor onKeyDown={(e) => e.stopPropagation()} onOpenAutoFocus={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("input,select,textarea,button[aria-haspopup],[role=switch]")?.focus();
      }}>
        <form onSubmit={(e) => {
          e.preventDefault();
          void commit();
        }}>
          <p className="mb-1.5 flex items-center gap-1 text-sm font-medium text-muted">{field.label}{reason ? <Lock className="size-3" aria-label={reason} /> : null}</p>
          <FieldControl field={field} meta={meta} record={record} mode="edit" value={value} onChange={setValue} me={{ id: s.member.id, name: s.member.name }}
            invalid={Boolean(error)} onCommit={() => void commit()} />
          {error ? <p role="alert" className="mt-1.5 text-sm text-danger-fg">{error}</p> : null}
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" busy={busy}>Save</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
