import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta, Page, RecordData, Where } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { andWhere } from "@/lib/filters";
import { qk } from "@/lib/keys";
import { RecordLink } from "@/meta/registry";
import { dayOf, monthGrid, monthOf, monthStart, whereForMonth, ymd } from "./layouts";

// The API returns at most 200 records per request (the limit of /v1/query).
const MAX = 200;
const PER_DAY = 4;
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * A month of records, each on the day of a date or date-time field (a date-time's day is the reader's
 * local day). One request per month, of at most 200 records; when a month holds more, the calendar says
 * so. A day shows its first few records and opens to show the rest.
 */
export function RecordCalendar({ meta, field, where, month, onMonth }: { meta: ObjectMeta; field: FieldMeta; where: Where | undefined; month: string; onMonth: (m: string) => void }) {
  const api = useApi();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: qk.list(meta.name, { calendar: field.name, month, where }),
    queryFn: ({ signal }) => api.request<Page>("POST", "/v1/query", { signal, body: {
      object: meta.name, where: andWhere(where, whereForMonth(field, month)), limit: MAX, fields: ["display_name", field.name], sort: [{ field: field.name, dir: "asc" }] } }),
  });
  const byDay = useMemo(() => {
    const m = new Map<string, RecordData[]>();
    for (const r of q.data?.data ?? []) {
      const d = dayOf(field, r[field.name]);
      if (d) m.set(d, [...(m.get(d) ?? []), r]);
    }
    return m;
  }, [q.data, field]);
  const first = monthStart(month);
  const title = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const today = ymd(new Date());
  const shift = (by: number) => {
    setOpen(null);
    onMonth(monthOf(monthStart(month, by)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4 md:px-6">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="icon-sm" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></Button>
        <Button size="icon-sm" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></Button>
        <h2 className="text-md font-semibold" aria-live="polite">{title}</h2>
        {month !== monthOf(new Date()) ? <Button size="sm" variant="ghost" onClick={() => {
          setOpen(null);
          onMonth(monthOf(new Date()));
        }}>This month</Button> : null}
        <span className="flex-1" />
        <span className="text-sm text-muted">{q.isPending ? "Loading…" : `${(q.data?.data.length ?? 0).toLocaleString()} by ${field.label.toLowerCase()}`}</span>
      </div>
      {q.data?.next_cursor ? <p role="status" className="mb-2 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-base text-warning-fg">This month has more than {MAX} {meta.plural_label.toLowerCase()}; the first {MAX} are shown. Filter the list to see the others.</p> : null}
      {q.error && !q.data ? <ProblemView error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[44rem] table-fixed border-collapse" aria-label={`${meta.plural_label} in ${title}, by ${field.label.toLowerCase()}`}>
            <thead>
              <tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="border-b border-line bg-surface-2 px-2 py-1.5 text-left text-sm font-medium text-muted"><abbr title={d} className="no-underline">{d.slice(0, 3)}</abbr></th>)}</tr>
            </thead>
            <tbody>
              {monthGrid(month).map((week) => (
                <tr key={ymd(week[0]!)}>
                  {week.map((day) => {
                    const key = ymd(day);
                    const rows = byDay.get(key) ?? [];
                    const inMonth = day.getMonth() === first.getMonth();
                    const all = open === key;
                    return (
                      <td key={key} className={cn("h-28 border-b border-r border-line p-1.5 align-top last:border-r-0", !inMonth && "bg-surface-2")}>
                        <p className={cn("mb-1 text-sm", key === today ? "font-semibold text-accent" : inMonth ? "text-muted" : "text-subtle")}>
                          <time dateTime={key}>{day.getDate()}</time>{key === today ? <span className="sr-only"> (today)</span> : null}
                        </p>
                        {rows.length ? (
                          <ul className="flex flex-col gap-0.5">
                            {(all ? rows : rows.slice(0, PER_DAY)).map((r) => (
                              <li key={r.id} className="truncate text-sm"><RecordLink object={meta.name} id={r.id}>{r.display_name || "Untitled"}</RecordLink></li>
                            ))}
                          </ul>
                        ) : null}
                        {rows.length > PER_DAY ? (
                          <button type="button" className="mt-0.5 text-sm text-muted hover:text-fg hover:underline" aria-expanded={all} onClick={() => setOpen(all ? null : key)}>
                            {all ? "Show fewer" : `${rows.length - PER_DAY} more`}
                          </button>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
