import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProblemView } from "@/components/feedback";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, Page, RecordData } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useDescribe } from "@/meta/hooks";
import { FieldValue, RecordLink } from "@/meta/registry";
import { ArrowIcon, HOME_STALE, isForbidden, Panel, PanelEmpty, PanelLoading, panelLink } from "./parts";
import type { ColSpec, Ctx, TableSpec } from "./specs";

const ROWS = 10;
/** Timestamps every record has; describe doesn't list them as fields. */
const BUILT_IN = new Set(["created_at", "updated_at"]);

const related = (r: RecordData, field: string) => r.included?.[field] ?? null;

/**
 * The team's main list: ten rows, asked for with the member's own access. Only the columns whose field
 * describe says the member can read are asked for or shown; the table is left out when its object or its
 * filter is refused (403).
 */
export function WorkTable({ spec, me, currency }: { spec: TableSpec; me: string; currency: string }) {
  const api = useApi();
  const meta = useDescribe(spec.object);
  const readable = new Set((meta.data?.fields ?? []).filter((f) => f.access !== "none").map((f) => f.name));
  const fieldOf = (name: string): FieldMeta | undefined => meta.data?.fields.find((f) => f.name === name);
  const cols = spec.cols.filter((c) => BUILT_IN.has(c.field) || readable.has(c.field));
  const sortField = BUILT_IN.has(spec.sort.field) || readable.has(spec.sort.field) ? spec.sort.field : "updated_at";
  // Amounts are shown in the record's own currency when it has one.
  const wantsCurrency = cols.some((c) => fieldOf(c.field)?.type === "currency") && readable.has("currency");
  const fields = ["display_name", ...cols.map((c) => c.field), ...(wantsCurrency ? ["currency"] : [])];
  const include = cols.filter((c) => c.rel).map((c) => c.field);
  const ctx: Ctx = { me, now: new Date(), currency };

  const q = useQuery({
    queryKey: ["home", "table", spec.object, me, fields.join(",")],
    enabled: Boolean(meta.data),
    queryFn: ({ signal }) => api.request<Page>("POST", "/v1/query", {
      signal, body: { object: spec.object, ...(spec.where(ctx) ? { where: spec.where(ctx) } : {}), sort: [{ field: sortField, dir: spec.sort.dir }], limit: ROWS, fields, include },
    }),
    staleTime: HOME_STALE, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (meta.error && isForbidden(meta.error)) return null;
  if (q.error && isForbidden(q.error)) return null;
  const err = meta.error ?? q.error;
  const header = (c: ColSpec) => c.label ?? fieldOf(c.field)?.label ?? c.field.replace(/_/g, " ");

  return (
    <Panel title={spec.title} sub={spec.sub}
      action={<Link to="/o/$object" params={{ object: spec.object }} search={{}} className={panelLink}>{meta.data?.plural_label ?? "All"} <ArrowIcon /></Link>}>
      {err ? <div className="p-4"><ProblemView error={err} compact /></div>
        : !q.data ? <PanelLoading />
        : q.data.data.length === 0 ? <PanelEmpty>Nothing here right now.</PanelEmpty>
        : (
          <div className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" role="region" aria-label={spec.title} tabIndex={0}>
            <table className="w-full min-w-[34rem] text-left text-base" aria-label={spec.title}>
              <thead className="border-b border-line bg-surface-2 text-sm text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">{meta.data?.label ?? "Record"}</th>
                  {cols.map((c) => <th key={c.field} scope="col" className="px-4 py-2 font-medium">{header(c)}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {q.data.data.map((r) => (
                  <tr key={r.id}>
                    <td className="max-w-64 truncate px-4 py-2.5 font-medium"><RecordLink object={spec.object} id={r.id}>{r.display_name || r.id}</RecordLink></td>
                    {cols.map((c) => {
                      const f = fieldOf(c.field);
                      const rel = c.rel ? related(r, c.field) : null;
                      return (
                        <td key={c.field} className="max-w-56 whitespace-nowrap px-4 py-2.5 tabular-nums">
                          {c.rel ? (rel?.display_name ? <RecordLink object={rel.object} id={rel.id}>{rel.display_name}</RecordLink> : <span className="text-subtle">&mdash;</span>)
                            : BUILT_IN.has(c.field) ? <time dateTime={String(r[c.field] ?? "")} title={formatDateTime(r[c.field])}>{formatRelative(r[c.field])}</time>
                            : f ? <FieldValue field={f} value={r[c.field]} record={r} meta={meta.data} /> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}
