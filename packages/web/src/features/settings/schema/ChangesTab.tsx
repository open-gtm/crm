import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useSchemaChanges, useWho } from "./hooks";
import { changeWords, compactDiff, surfaceLabel, surfaceTone } from "./model";

const STEP = 50;
const MAX = 500;

/** The schema's history for one object, newest first, from GET /v1/schema/changes. */
export function ChangesTab({ object }: { object: string }) {
  const [limit, setLimit] = useState(STEP);
  const q = useSchemaChanges(object, limit, true);
  const who = useWho();
  if (q.isPending) return <div className="p-4"><Skeleton className="h-20" /></div>;
  if (q.error) return <div className="p-4"><ProblemView error={q.error} onRetry={() => q.refetch()} compact /></div>;
  const rows = q.data;
  return (
    <div>
      {rows.length === 0 ? <p className="p-4 text-base text-muted">No changes have been recorded for this object.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((c, i) => {
            const diff = compactDiff(c.before, c.after);
            return (
              <li key={`${c.version}-${c.field ?? ""}-${i}`} className="flex gap-3 px-4 py-3">
                <Badge tone={surfaceTone(c.surface)} className="h-5 shrink-0 self-start">{surfaceLabel(c.surface)}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-base"><strong className="font-medium"><bdi>{who(c.actor)}</bdi></strong>{c.via ? <span className="text-muted"> via {c.via}</span> : null}{" "}
                    <span className="text-muted">{changeWords(c)}</span>{c.pack ? <span className="text-muted"> ({c.pack} pack)</span> : null}</p>
                  {diff ? <p className="mt-0.5 text-sm text-subtle"><code className="font-mono">{diff}</code></p> : null}
                </div>
                <time dateTime={c.changed_at} title={formatDateTime(c.changed_at)} className="shrink-0 whitespace-nowrap text-sm text-subtle">{formatRelative(c.changed_at)}</time>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length >= limit && limit < MAX ? (
        <div className="border-t border-line p-3"><Button size="sm" busy={q.isFetching} onClick={() => setLimit((l) => Math.min(MAX, l + STEP * 3))}>Load more</Button></div>
      ) : null}
    </div>
  );
}
