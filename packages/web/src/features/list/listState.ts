import type { Group } from "@/lib/filters";
import { compileWhere, encodeFilter, formatSort, packFilter, parseColumns, parseSort, unpackFilter } from "@/lib/filters";
import type { ObjectMeta, SavedView, Sort, Where } from "@/lib/api/types";
import { canSort, defaultColumns, includable, isVisible, partFields, sortableParts } from "@/meta/fields";

/**
 * A list's state lives in the URL: `view` (a saved view's ID), and overrides of what the view (or the
 * default) shows: `filter` (the builder's packed form), `sort` ("name,-amount") and `cols` ("a,b,c").
 * An absent override means "as the view has it". These functions turn the URL into the request the
 * table makes, and back.
 */

export interface ListUrl { view?: string; sort?: string; cols?: string; filter?: unknown; layout?: "board" | "calendar"; by?: string; group?: string; month?: string }

export interface ResolvedList {
  viewId: string | undefined;
  view: SavedView | undefined;
  /** The builder's filter: the URL's, else the view's (when the builder can show it), else none. */
  filter: Group | null;
  /** True when the URL overrides the view's filter (so `where` is sent). */
  filterOverridden: boolean;
  sort: Sort[];
  sortOverridden: boolean;
  columns: string[];
  columnsOverridden: boolean;
  /** What to send: where only when overridden (otherwise the server applies the view's). */
  where: Where | undefined;
  fields: string[];
  include: string[];
  /** The URL differs from the view (or from the defaults with no view). */
  modified: boolean;
}

export function resolveList(url: ListUrl, meta: ObjectMeta, views: SavedView[] | undefined, viewFilter: Group | null): ResolvedList {
  const view = url.view ? views?.find((v) => v.id === url.view) : undefined;
  const usable = view?.status === "ok";
  const visible = new Set(meta.fields.filter(isVisible).map((f) => f.name));
  const urlFilter = url.filter !== undefined ? unpackFilter(url.filter) : null;
  const filterOverridden = url.filter !== undefined && urlFilter !== null;
  const filter = filterOverridden ? urlFilter : usable ? viewFilter : null;

  const urlSort = url.sort !== undefined ? parseSort(url.sort) : null;
  const parts = new Set(sortableParts(meta).map((p) => p.name));
  const sortable = (s: Sort) => {
    if (parts.has(s.field)) return true;
    const f = meta.fields.find((x) => x.name === s.field);
    return f ? canSort(f) : s.field === "created_at" || s.field === "updated_at";
  };
  const sort = (urlSort ?? (usable && view?.sort ? view.sort : [])).filter(sortable).slice(0, 3);

  const urlCols = parseColumns(url.cols);
  const viewCols = usable && view?.columns?.length ? view.columns : undefined;
  const columns = (urlCols ?? viewCols ?? defaultColumns(meta)).filter((c) => visible.has(c) || c === "created_at" || c === "updated_at");

  // With a view, "no filter" must still be sent (an absent where means the view's): id is never empty, so this matches everything.
  const where = filterOverridden ? compileWhere(filter, partFields(meta)) ?? (url.view ? { field: "id", op: "is_null", value: false } : undefined) : undefined;
  return {
    viewId: url.view,
    view,
    filter,
    filterOverridden,
    sort,
    sortOverridden: urlSort !== null,
    columns,
    columnsOverridden: urlCols !== undefined,
    where,
    fields: ["display_name", "created_at", "updated_at", ...columns.filter((c) => c !== "created_at" && c !== "updated_at")],
    include: includable(meta, columns),
    modified: url.filter !== undefined || url.sort !== undefined || url.cols !== undefined,
  };
}

/** URL search for a change to the list: undefined values drop that override. */
export function nextSearch(cur: ListUrl, change: { filter?: Group | null; sort?: Sort[] | null; columns?: string[] | null; view?: string | null }): ListUrl {
  const out: ListUrl = { ...cur };
  if (change.view !== undefined) {
    if (change.view === null) delete out.view; else out.view = change.view;
    delete out.filter;
    delete out.sort;
    delete out.cols;
    // How the list is shown (table, board, calendar, grouping) is the member's choice, not the view's: it stays.
  }
  if (change.filter !== undefined) {
    if (change.filter === null) delete out.filter; else out.filter = packFilter(change.filter);
  }
  if (change.sort !== undefined) {
    if (change.sort === null) delete out.sort; else out.sort = formatSort(change.sort);
  }
  if (change.columns !== undefined) {
    if (change.columns === null) delete out.cols; else out.cols = change.columns.join(",");
  }
  return out;
}

/** Stable key of a filter, for comparing and caching. */
export const filterKey = (g: Group | null) => (g ? encodeFilter(g) : "");
