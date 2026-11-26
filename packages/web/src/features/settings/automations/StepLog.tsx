import { Badge } from "@/components/ui/misc";
import { isJson, type Json } from "./model";

/**
 * What each step did, as the server recorded or simulated it: the step, its action, whether it went
 * through, was skipped or failed, and its detail as formatted JSON. The server already redacted the
 * detail (secrets hidden, long text cut), so it is shown as it came.
 */
export function StepLog({ results, label }: { results: Json[]; label: string }) {
  if (results.length === 0) return <p className="text-sm text-muted">No step ran.</p>;
  return (
    <ol aria-label={label} className="grid gap-2">
      {results.map((r, i) => {
        const skipped = typeof r.skipped === "string" ? r.skipped : null;
        const ok = r.ok === true;
        const detail = isJson(r.detail) ? r.detail : r.detail === undefined ? null : { value: r.detail };
        return (
          <li key={i} className="rounded-md border border-line bg-surface p-2.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="tabular-nums text-subtle">{String(r.step ?? i + 1)}</span>
              <code className="font-mono font-medium">{String(r.action ?? "step")}</code>
              {typeof r.id === "string" ? <span className="font-mono text-subtle">{r.id}</span> : null}
              {skipped ? <Badge tone="warning">Skipped</Badge> : ok ? <Badge tone="success">Done</Badge> : <Badge tone="danger">Failed</Badge>}
              {skipped ? <span className="text-muted">{skipped}</span> : null}
            </div>
            {detail && Object.keys(detail).length ? (
              <pre role="region" tabIndex={0} aria-label={`Detail of step ${String(r.step ?? i + 1)}`} className="mt-2 max-h-64 overflow-auto rounded-sm bg-surface-2 p-2 font-mono text-xs leading-5 focus-visible:outline-2 focus-visible:outline-focus">{JSON.stringify(detail, null, 2)}</pre>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
