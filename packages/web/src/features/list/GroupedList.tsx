import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import type { AggregateResult, FieldMeta, ObjectMeta, Page, Sort, Where } from "@/lib/api/types";
import { andWhere } from "@/lib/filters";
import { formatMoney, formatNumber } from "@/lib/format";
import { qk } from "@/lib/keys";
import { optionLabel } from "@/meta/fields";
import { FieldValue, RecordLink } from "@/meta/registry";
import { fieldOf } from "./DataTable";
import { totalFields, whereForKey } from "./layouts";

const PAGE = 50;

/** A group's name: a select's label, a related record's name, Yes or No, or "No <field>" for records without a value. */
function groupLabel(field: FieldMeta, key: unknown): string {
  if (key === null || key === undefined) return `No ${field.label.toLowerCase()}`;
  if (typeof key === "object") return (key as { display_name?: string | null }).display_name ?? "A record you can't see";
  if (typeof key === "boolean") return key ? "Yes" : "No";
  return field.values ? optionLabel(field, key) : String(key);
}

/**
 * A list grouped by one field: each group with how many records it holds and the totals of the number
 * columns shown, from the aggregate endpoint. A group opens to show its records, loaded when it is opened.
 */
export function GroupedList({ meta, field, where, columns, sort }: { meta: ObjectMeta; field: FieldMeta; where: Where | undefined; columns: string[]; sort: Sort[] }) {
  const api = useApi();
  const totals = totalFields(meta, columns);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useQuery({
    queryKey: qk.aggregate(meta.name, { group: field.name, where, totals: totals.map((t) => t.name) }),
    queryFn: ({ signal }) => api.request<AggregateResult>("POST", "/v1/aggregate", { signal, body: {
      object: meta.name, ...(where ? { where } : {}), group_by: [{ field: field.name }], measures: totals.map((t) => ({ op: "sum" as const, field: t.name })), limit: 200 } }),
  });
  if (groups.isPending) return <div className="p-6" aria-busy="true">{[1, 2, 3].map((i) => <Skeleton key={i} className="mb-3 h-9" />)}</div>;
  if (groups.error) return <div className="p-6"><ProblemView error={groups.error} onRetry={() => groups.refetch()} /></div>;
  const result = groups.data;
  if (result.data.length === 0) return <div className="p-6"><EmptyState title={`No ${meta.plural_label.toLowerCase()} match`} /></div>;
  const sumKey = (name: string) => result.measures.find((m) => m.op === "sum" && m.field === name)?.key;
  return (
    <div className="h-full overflow-auto p-4 md:px-6">
      {result.rows_capped || result.truncated ? (
        <p role="status" className="mb-3 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-base text-warning-fg">
          {result.truncated ? "There are more groups than are shown. " : ""}{result.rows_capped ? "Counts and totals cover the 100,000 most recently changed records. " : ""}Filter the list for exact figures.
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {result.data.map((g) => {
          const key = g.group[field.name];
          const id = JSON.stringify(typeof key === "object" && key !== null ? (key as { id: string }).id : key ?? null);
          const label = groupLabel(field, key);
          const isOpen = open.has(id);
          return (
            <li key={id} className="rounded-lg border border-line bg-surface">
              <button type="button" aria-expanded={isOpen} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-surface-2"
                onClick={() => setOpen((s) => {
                  const next = new Set(s);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}>
                {isOpen ? <ChevronDown className="size-4 text-muted" aria-hidden /> : <ChevronRight className="size-4 text-muted" aria-hidden />}
                <span className="font-medium"><bdi>{label}</bdi></span>
                <span className="text-sm text-muted">{g.count.toLocaleString()} {g.count === 1 ? meta.label.toLowerCase() : meta.plural_label.toLowerCase()}</span>
                <span className="flex-1" />
                {totals.map((t) => {
                  const v = g.values[sumKey(t.name) ?? ""];
                  return v === null || v === undefined ? null : (
                    <span key={t.name} className="text-sm"><span className="text-subtle">{t.label}</span> <span className="font-medium tabular-nums">{t.type === "currency" ? formatMoney(v, g.currency ?? meta.currency) : formatNumber(v)}</span></span>
                  );
                })}
              </button>
              {isOpen ? <GroupRows meta={meta} where={andWhere(where, whereForKey(field.name, key))} columns={columns.filter((c) => c !== field.name)} sort={sort} label={label} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GroupRows({ meta, where, columns, sort, label }: { meta: ObjectMeta; where: Where | undefined; columns: string[]; sort: Sort[]; label: string }) {
  const api = useApi();
  const cols = columns.map((c) => fieldOf(meta, c)).filter((f): f is FieldMeta => Boolean(f));
  const rows = useInfiniteQuery({
    queryKey: qk.list(meta.name, { grouped: true, where, sort, columns }),
    queryFn: ({ pageParam, signal }) => api.request<Page>("POST", "/v1/query", { signal, body: {
      object: meta.name, ...(where ? { where } : {}), ...(sort.length ? { sort } : {}), fields: ["display_name", "created_at", "updated_at", ...columns.filter((c) => c !== "created_at" && c !== "updated_at")],
      limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  if (rows.isPending) return <div className="border-t border-line p-3"><Skeleton className="h-8" /></div>;
  if (rows.error) return <div className="border-t border-line p-3"><ProblemView error={rows.error} onRetry={() => rows.refetch()} compact /></div>;
  const records = rows.data.pages.flatMap((p) => p.data);
  return (
    <div className="overflow-x-auto border-t border-line">
      <table className="w-full text-base" aria-label={`${meta.plural_label}: ${label}`}>
        <thead className="bg-surface-2 text-sm text-muted">
          <tr><th scope="col" className="px-3 py-1.5 text-left font-medium">{meta.label}</th>{cols.map((f) => <th key={f.name} scope="col" className="px-3 py-1.5 text-left font-medium">{f.label}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {records.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="max-w-72 truncate px-3 py-1.5 text-left font-medium"><RecordLink object={meta.name} id={r.id}>{r.display_name || "Untitled"}</RecordLink></th>
              {cols.map((f) => <td key={f.name} className="max-w-64 px-3 py-1.5"><FieldValue field={f} value={r[f.name]} record={r} meta={meta} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.hasNextPage ? <div className="border-t border-line p-2"><Button size="sm" variant="ghost" busy={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>Show more</Button></div> : null}
    </div>
  );
}
