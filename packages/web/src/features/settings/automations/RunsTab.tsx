import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RotateCw } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Badge, Checkbox, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { AutomationRun, RunStatus } from "@/lib/api/types";
import { formatDateTime, pluralize } from "@/lib/format";
import { useObjects } from "@/meta/hooks";
import { useAdmin } from "../SettingsLayout";
import { StepLog } from "./StepLog";
import { isJson, RUN_TONE, type QueuedRun } from "./model";

const STATUSES: RunStatus[] = ["queued", "running", "succeeded", "failed", "skipped"];
const LIMIT = 50;
/** The most records one request can run (the API's limit). */
export const MAX_RERUN = 25;

/** From started and finished to "1.2 s"; empty while a run is still going. */
export function formatDuration(startedAt: string, finishedAt?: string | null): string {
  if (!finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** The runs of one automation, newest first, each with its step log; failed runs on records can be run again. */
export function RunsTab({ id }: { id: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<RunStatus | "">("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const runs = useAdmin<{ data: AutomationRun[] }>(["automation-runs", id, "list"], `/v1/automations/${encodeURIComponent(id)}/runs`, { limit: LIMIT, ...(status ? { status } : {}) });
  const objects = useObjects();
  const byPrefix = useMemo(() => new Map((objects.data ?? []).map((o) => [o.id_prefix, o.name])), [objects.data]);
  const rows = runs.data?.data ?? [];

  const again = useMutation({
    mutationFn: (records: string[]) => api.post<{ data: { runs: QueuedRun[] } }>(`/v1/automations/${encodeURIComponent(id)}/run`, { records }),
    onSuccess: (r) => {
      setConfirming(false);
      setPicked(new Set());
      const ids = r.data.runs.map((x) => x.id);
      toast.toast({ tone: "success", title: `Queued ${pluralize(ids.length, "new run", "new runs")}`, description: ids.join(", ") });
      void qc.invalidateQueries({ queryKey: ["admin", "automation-runs"] });
    },
    onError: (e) => {
      setConfirming(false);
      toast.error(e, "Couldn't start the runs");
    },
  });

  const selectable = (r: AutomationRun) => r.status === "failed" && Boolean(r.record_id);
  const records = [...new Set(rows.filter((r) => picked.has(r.id)).map((r) => r.record_id!))];
  const toggle = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-medium text-muted">Status
          <NativeSelect className="w-40" value={status} onChange={(e) => {
            setStatus(e.target.value as RunStatus | "");
            setPicked(new Set());
          }}>
            <option value="">All</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
          </NativeSelect>
        </label>
        <Button variant="ghost" onClick={() => void runs.refetch()} busy={runs.isFetching && !runs.isPending}><RotateCw /> Refresh</Button>
        <div className="ml-auto flex flex-col items-end gap-1">
          <Button disabled={records.length === 0 || records.length > MAX_RERUN} onClick={() => setConfirming(true)}>Run again for these records{records.length ? ` (${records.length})` : ""}</Button>
          {records.length > MAX_RERUN ? <p role="alert" className="text-sm text-danger-fg">At most {MAX_RERUN} records at a time.</p> : null}
        </div>
      </div>
      <p className="text-sm text-subtle">Shows the latest {LIMIT} runs. Runs are kept for 90 days. Running again starts new runs on the same records; it does not retry the failed run.</p>

      {runs.isPending ? <Skeleton className="h-24" /> : runs.error ? <ProblemView error={runs.error} onRetry={() => void runs.refetch()} compact /> : rows.length === 0 ? (
        <EmptyState title={status ? `No ${status} runs` : "No runs yet"} className="py-8">{status ? "Try another status." : "Runs appear here when it is triggered, on its schedule, or when you run it."}</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line focus-visible:outline-2 focus-visible:outline-focus" role="region" aria-label="Runs" tabIndex={0}>
          <table className="w-full min-w-[44rem] text-left text-base" aria-label="Runs of this automation">
            <thead className="border-b border-line bg-surface-2 text-sm text-muted">
              <tr>
                <th scope="col" className="w-10 px-3 py-2"><span className="sr-only">Select</span></th>
                {["When", "Trigger", "Result", "Duration", "Record", "Reason"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}
                <th scope="col" className="px-3 py-2"><span className="sr-only">Steps</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const isOpen = open.has(r.id);
                const prefix = r.record_id?.split("_")[0] ?? "";
                const object = byPrefix.get(prefix);
                const why = [r.reason, r.cap ? `cap: ${r.cap}` : null, r.failure ? `failure: ${r.failure}` : null].filter(Boolean).join(" · ");
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td className="px-3 py-2">{selectable(r) ? <Checkbox aria-label={`Select run ${r.id}`} checked={picked.has(r.id)} onCheckedChange={(v) => setPicked(toggle(picked, r.id, v === true))} /> : null}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-sm tabular-nums">{formatDateTime(r.started_at)}</td>
                      <td className="px-3 py-2 text-sm capitalize">{r.trigger}</td>
                      <td className="px-3 py-2"><Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status}</Badge></td>
                      <td className="px-3 py-2 text-sm tabular-nums text-muted">{formatDuration(r.started_at, r.finished_at)}</td>
                      <td className="px-3 py-2 font-mono text-sm">
                        {r.record_id ? (object ? <Link to="/o/$object/$id" params={{ object, id: r.record_id }} className="text-accent underline">{r.record_id}</Link> : r.record_id) : <span className="text-subtle">None</span>}
                      </td>
                      <td className="min-w-48 px-3 py-2 text-sm text-muted">{why}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="ghost" aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} steps of run ${r.id}`} onClick={() => setOpen(toggle(open, r.id, !isOpen))}>
                          {isOpen ? <ChevronDown /> : <ChevronRight />} Steps
                        </Button>
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr>
                        <td colSpan={8} className="bg-surface-2 px-3 py-3">
                          <StepLog results={(r.results ?? []).filter(isJson)} label={`Step log of run ${r.id}`} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog open={confirming} onOpenChange={setConfirming} busy={again.isPending} confirmLabel="Run again" title={`Run again for ${pluralize(records.length, "record", "records")}?`}
        description="This starts new runs on the same records with the automation as it is now. It is not a retry of the failed runs: those stay as they are in the history, and the new runs count against the hourly cap."
        onConfirm={() => again.mutate(records)} />
    </div>
  );
}
