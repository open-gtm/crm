import { Link } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import type { ObjectMeta } from "@/lib/api/types";
import { packFilter } from "@/lib/filters";
import { formatDateTime } from "@/lib/format";
import { useDescribes } from "@/meta/hooks";
import { Section } from "../SettingsLayout";
import { availableChecks, CHECK_OBJECTS, runCounts, runDuplicates, type CheckObject, type CheckResult, type CheckSpec, type CountLine } from "./checks";
import { DuplicateReview } from "./DuplicateReview";
import type { DuplicateGroup, DuplicatesAnswer } from "./types";

/**
 * Data health: checks that look for records needing attention. There are no scheduled checks and nothing
 * is stored; each check runs when it is asked to and shows what it found until the page is left. Finding
 * duplicates is heavy for the server, so it never runs by itself.
 */
export function DataHealthSettings() {
  const api = useApi();
  const describes = useDescribes([...CHECK_OBJECTS]);
  const metas = useMemo(() => {
    const m: Partial<Record<CheckObject, ObjectMeta>> = {};
    CHECK_OBJECTS.forEach((o, i) => {
      const d = describes[i]?.data;
      if (d) m[o] = d;
    });
    return m;
  }, [describes]);
  const loading = describes.some((d) => d.isPending);
  const checks = useMemo(() => availableChecks(metas), [metas]);

  const [results, setResults] = useState<Record<string, CheckResult>>({});
  const [failed, setFailed] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState<string[]>([]);
  const [runningAll, setRunningAll] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const alive = useRef(new AbortController());
  useEffect(() => {
    const c = new AbortController();
    alive.current = c;
    return () => c.abort();
  }, []);

  const run = async (spec: CheckSpec) => {
    const signal = alive.current.signal;
    setRunning((r) => [...r, spec.key]);
    setFailed(({ [spec.key]: _gone, ...rest }) => rest);
    try {
      const result = spec.kind === "duplicates" ? await runDuplicates(api, spec.object, signal) : await runCounts(api, spec.lines, metas, signal);
      setResults((r) => ({ ...r, [spec.key]: result }));
      if (reviewing === spec.key) setReviewing(null);
    } catch (e) {
      if (!signal.aborted) setFailed((f) => ({ ...f, [spec.key]: e }));
    } finally {
      setRunning((r) => r.filter((k) => k !== spec.key));
    }
  };
  const runAll = async () => {
    setRunningAll(true);
    try {
      // One at a time: the duplicate finders are heavy for the server.
      for (const spec of checks) await run(spec);
    } finally {
      setRunningAll(false);
    }
  };

  const reviewSpec = checks.find((c) => c.key === reviewing);
  const reviewResult = reviewing ? results[reviewing] : undefined;
  const reviewMeta = reviewSpec?.kind === "duplicates" ? metas[reviewSpec.object as CheckObject] : undefined;
  const setGroups = (key: string, groups: DuplicateGroup[]) => setResults((r) => {
    const cur = r[key];
    return cur?.kind === "duplicates" ? { ...r, [key]: { ...cur, answer: { ...cur.answer, groups } } } : r;
  });

  return (
    <>
      <Section title="Checks"
        description="Each check looks at your records when you press Run. Nothing runs by itself and nothing is stored, so a result is what the workspace looked like when you ran it."
        actions={<Button size="sm" variant="primary" busy={runningAll} disabled={loading || checks.length === 0 || running.length > 0} onClick={() => void runAll()}><Play /> Run all</Button>}>
        {loading ? <Skeleton className="h-24" /> : checks.length === 0 ? (
          <p className="text-base text-muted">There are no checks your role can run: they need access to contacts, accounts or deals.</p>
        ) : (
          <ul className="-m-4 divide-y divide-line">
            {checks.map((c) => {
              const result = results[c.key];
              const busy = running.includes(c.key);
              return (
                <li key={c.key} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <div className="min-w-0 flex-[1_1_16rem]">
                      <h3 className="text-base font-medium">{c.title}</h3>
                      <p className="text-sm text-muted">{c.help}</p>
                    </div>
                    {result ? <span className="text-sm text-subtle">Ran <time dateTime={result.at.toISOString()}>{formatDateTime(result.at.toISOString())}</time></span> : <span className="text-sm text-subtle">Not run yet</span>}
                    {result?.kind === "duplicates" && result.answer.groups.length > 0 ? (
                      <Button size="sm" aria-pressed={reviewing === c.key} onClick={() => setReviewing(reviewing === c.key ? null : c.key)}>Review {result.answer.groups.length === 1 ? "1 group" : `${result.answer.groups.length} groups`}</Button>
                    ) : null}
                    <Button size="sm" busy={busy} disabled={runningAll || (running.length > 0 && !busy)} aria-label={`Run ${c.title}`} onClick={() => void run(c)}>{busy ? "Running" : "Run"}</Button>
                  </div>
                  {failed[c.key] ? <ProblemView error={failed[c.key]} compact /> : null}
                  {result?.kind === "duplicates" && c.kind === "duplicates" ? <DuplicatesSummary answer={result.answer} objectLabel={c.objectLabel} /> : null}
                  {result?.kind === "counts" ? <CountLines lines={result.lines} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      {reviewSpec && reviewMeta && reviewResult?.kind === "duplicates" ? (
        <Section title={reviewSpec.title} id="review" description="Look at one group at a time. Skipping stores nothing; choose whose value to keep field by field, and preview before you merge.">
          <DuplicateReview meta={reviewMeta} groups={reviewResult.answer.groups} onGroups={(g) => setGroups(reviewSpec.key, g)} onClose={() => setReviewing(null)} />
        </Section>
      ) : null}
    </>
  );
}

function DuplicatesSummary({ answer, objectLabel }: { answer: DuplicatesAnswer; objectLabel: string }) {
  const n = answer.groups.length;
  return (
    <div className="flex flex-col gap-0.5 text-sm" aria-live="polite">
      <p className="font-medium">{n === 0 ? `No groups of possible duplicates found among ${answer.scanned.toLocaleString()} ${objectLabel}.` : `${n.toLocaleString()} ${n === 1 ? "group" : "groups"} of possible duplicates found.`}</p>
      {answer.more_groups ? <p className="text-muted">There are more groups than this. Merge these, then run the check again to see the rest.</p> : null}
      {answer.window_full ? <p className="text-muted">The scan window was full: only the newest {answer.scanned.toLocaleString()} {objectLabel} were looked at, so older duplicates may not be listed.</p> : null}
      {answer.skipped_rules?.length ? <p className="text-muted">Some matching rules were skipped because your role can't read the fields they use.</p> : null}
    </div>
  );
}

function CountLines({ lines }: { lines: CountLine[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-sm" aria-live="polite">
      {lines.map((l) => (
        <li key={l.object} className="flex flex-wrap items-center gap-x-2">
          <span className="font-medium">{l.label}</span>
          {"error" in l ? <span className="text-danger-fg">couldn't be counted</span> : l.count === 0 ? <span className="text-muted">none found</span> : (
            <>
              <span className="tabular">{l.capped ? `More than ${l.count.toLocaleString()}` : l.count.toLocaleString()}</span>
              <Link to="/o/$object" params={{ object: l.object }} search={{ filter: packFilter(l.filter) } as never} className="text-accent hover:underline">Show in list</Link>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
