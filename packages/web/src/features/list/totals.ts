import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api/context";
import { ApiProblem } from "@/lib/api/problem";
import type { AggregateResult, FieldMeta, ObjectMeta, Where } from "@/lib/api/types";
import { formatMoney, formatNumber } from "@/lib/format";
import { qk } from "@/lib/keys";
import { formatDuration } from "@/meta/fields";

/** One total of a column: a sum in one currency (money), or the plain sum (`currency` null). */
export interface TotalLine { currency: string | null; value: number }
export interface ListTotals {
  /** Per column name: one line per currency for money, one line for other numbers. */
  sums: Map<string, TotalLine[]>;
  /** More records matched than the server totals up (it uses the newest 100,000). */
  capped: boolean;
}

/**
 * The sum of each number column over the whole filtered list, from the aggregate endpoint (the same
 * route grouped tables use). Money of one currency is one total; when the list mixes currencies the
 * server refuses a single sum, and the totals are asked for per currency instead.
 */
export function useListTotals(meta: ObjectMeta, where: Where | undefined, fields: FieldMeta[], enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: qk.aggregate(meta.name, { footer: true, where, totals: fields.map((f) => f.name) }),
    enabled: enabled && fields.length > 0,
    queryFn: async ({ signal }): Promise<ListTotals> => {
      const measures = fields.map((f) => ({ op: "sum" as const, field: f.name }));
      const run = (groupBy?: { field: string }[]) => api.request<AggregateResult>("POST", "/v1/aggregate", {
        signal, body: { object: meta.name, ...(where ? { where } : {}), ...(groupBy ? { group_by: groupBy } : {}), measures, limit: 200 },
      });
      let r: AggregateResult;
      let byCurrency = false;
      try {
        r = await run();
      } catch (e) {
        if (!(e instanceof ApiProblem && e.code === "mixed_currencies")) throw e;
        r = await run([{ field: "currency" }]);
        byCurrency = true;
      }
      const sums = new Map<string, TotalLine[]>();
      for (const f of fields) {
        const key = r.measures.find((m) => m.op === "sum" && m.field === f.name)?.key;
        const lines: TotalLine[] = [];
        for (const g of r.data) {
          const v = key ? g.values[key] : null;
          if (typeof v !== "number") continue;
          const currency = f.type === "currency" ? g.currency ?? (byCurrency ? (g.group.currency as string | null) : null) ?? meta.currency : null;
          const same = lines.find((l) => l.currency === currency);
          if (same) same.value += v; else lines.push({ currency, value: v });
        }
        sums.set(f.name, lines);
      }
      return { sums, capped: r.rows_capped === true };
    },
  });
}

/** A total as the column shows its values. */
export function formatTotal(f: FieldMeta, line: TotalLine): string {
  if (f.type === "currency") return formatMoney(line.value, line.currency);
  return f.type === "duration" ? formatDuration(line.value) : formatNumber(line.value);
}
