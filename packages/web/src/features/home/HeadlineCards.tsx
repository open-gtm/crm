import { useQuery } from "@tanstack/react-query";
import { ProblemView } from "@/components/feedback";
import { useApi } from "@/lib/api/context";
import type { AggregateResult } from "@/lib/api/types";
import { useDescribe } from "@/meta/hooks";
import { HOME_STALE, isForbidden, StatCard } from "./parts";
import type { CardSpec, Ctx } from "./specs";

/**
 * One headline number: one aggregate, built from the member's ID and the clock when it is sent, cached for
 * a minute and never polled. Cards that show different views of one request share its cache entry. A
 * card whose request the role refuses (403) is left out.
 */
export function HeadlineCard({ spec, me, currency }: { spec: CardSpec; me: string; currency: string }) {
  const api = useApi();
  const meta = useDescribe(spec.object);
  const q = useQuery({
    queryKey: ["home", "aggregate", spec.shared ?? spec.key, me],
    queryFn: ({ signal }) => api.request<AggregateResult>("POST", "/v1/aggregate", { signal, body: spec.request({ me, now: new Date(), currency }) }),
    staleTime: HOME_STALE, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (q.error && isForbidden(q.error)) return null;
  if (q.error) return <div className="rounded-lg border border-line bg-surface p-4"><h3 className="mb-1 text-sm font-medium text-muted">{spec.label}</h3><ProblemView error={q.error} compact /></div>;
  if (!q.data) return <StatCard label={spec.label} loading />;
  const ctx: Ctx = { me, now: new Date(q.dataUpdatedAt), currency };
  const v = spec.view(q.data, ctx, meta.data);
  return <StatCard label={spec.label} values={v.values} sub={v.sub} lines={v.lines} note={v.note} />;
}
