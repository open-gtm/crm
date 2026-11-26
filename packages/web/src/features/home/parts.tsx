import { useQuery, type QueryKey } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { ProblemView } from "@/components/feedback";
import { Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import { ApiProblem } from "@/lib/api/problem";
import { cn } from "@/lib/cn";

/** Home's numbers are cached for a minute and never polled: each one is a request the server counts as heavy. */
export const HOME_STALE = 60_000;

/** A request the member's role refuses (403): the part of Home that needs it is left out, not shown as an error. */
export const isForbidden = (e: unknown) => e instanceof ApiProblem && e.status === 403;

/** One GET for a Home section, cached for a minute, never retried or refetched on focus. */
export function useHomeGet<T>(key: QueryKey, path: string, query?: Record<string, string | number | undefined>, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: ["home", ...key, query ?? {}],
    queryFn: ({ signal }) => api.get<T>(path, query, signal),
    enabled, staleTime: HOME_STALE, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
}

/** A titled card in Home's columns. */
export function Panel({ title, sub, action, children, className }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("rounded-lg border border-line bg-surface", className)}>
      <header className="flex items-start gap-3 border-b border-line px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 id={id} className="text-md font-semibold">{title}</h2>
          {sub ? <p className="text-sm text-subtle">{sub}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export const panelLink = "inline-flex items-center gap-1 text-sm text-accent hover:underline";
export const ArrowIcon = () => <ArrowRight className="size-3.5" aria-hidden />;

export const PanelLoading = () => <div className="p-4" aria-busy="true"><Skeleton className="h-10" /></div>;
export const PanelProblem = ({ error }: { error: unknown }) => <div className="p-4"><ProblemView error={error} compact /></div>;
export const PanelEmpty = ({ children }: { children: ReactNode }) => <p className="px-4 py-6 text-base text-muted">{children}</p>;

/** A headline number: a label, the number(s), a line under it, and optionally a small list. */
export function StatCard({ label, values, sub, lines, note, loading }: {
  label: string; values?: string[]; sub?: ReactNode; lines?: { label: string; value: string }[]; note?: string; loading?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} aria-busy={loading || undefined} className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4">
      <h3 id={id} className="text-sm font-medium text-muted">{label}</h3>
      {loading ? <Skeleton className="mt-1 h-7 w-20" /> : (
        <>
          {values?.length ? (
            <p className={cn("font-semibold tabular-nums", values.length === 1 ? "text-2xl" : "flex flex-col text-md")}>
              {values.map((v) => <span key={v}>{v}</span>)}
            </p>
          ) : null}
          {sub ? <p className="text-sm text-subtle">{sub}</p> : null}
          {lines?.length ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-sm">
              {lines.map((l) => <li key={l.label} className="flex justify-between gap-3"><span className="min-w-0 truncate text-muted">{l.label}</span><span className="tabular-nums">{l.value}</span></li>)}
            </ul>
          ) : null}
          {note ? <p className="text-xs text-subtle">{note}</p> : null}
        </>
      )}
    </section>
  );
}
