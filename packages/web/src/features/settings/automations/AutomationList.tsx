import { Plus, Zap } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import type { Automation, AutomationRun } from "@/lib/api/types";
import { DocsLink } from "@/lib/docs";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Section, SimpleTable, useAdmin } from "../SettingsLayout";
import { describeTrigger, RUN_TONE, SHOWN_LABEL, SHOWN_TONE, shownStatus, type Shown } from "./model";

type Filter = "all" | Shown;
const CHIPS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "active", label: "Active" }, { id: "failing", label: "Failing" }, { id: "paused", label: "Paused" }];

/** Every automation, with filters whose counts come from the list itself. A row opens the automation. */
export function AutomationList() {
  const list = useAdmin<{ data: Automation[] }>(["automations"], "/v1/automations");
  const settings = useAdmin<{ data: { paused: boolean; paused_reason: string | null } }>(["automation-settings"], "/v1/automation-settings");
  const [filter, setFilter] = useState<Filter>("all");
  const live = (list.data?.data ?? []).filter((a) => a.status !== "archived");
  // Failing is an active automation that has been failing, so it is counted under Active too.
  const matches = (a: Automation, f: Filter) => f === "all" || (f === "active" ? a.status === "enabled" : shownStatus(a) === f);
  const count = (f: Filter) => live.filter((a) => matches(a, f)).length;
  const shown = live.filter((a) => matches(a, filter));
  return (
    <Section title="Automations" description={<>
      Rules that act on events, on a schedule or on request. Anything you can build here an agent can build too, with the same dry run first.
      The <DocsLink page="automations.md">automations guide</DocsLink> explains triggers, steps and limits.
    </>} actions={<Button size="sm" variant="primary" asChild><Link to="/settings/automations/new"><Plus /> New automation</Link></Button>}>
      {settings.data?.data.paused ? (
        <p role="status" className="mb-3 rounded-md border border-line bg-warning-soft px-3 py-2 text-base text-warning-fg">
          Every automation in this workspace is paused{settings.data.data.paused_reason ? `: ${settings.data.data.paused_reason}` : ""}.
        </p>
      ) : null}
      {list.isPending ? <Skeleton className="h-24" /> : list.error ? <ProblemView error={list.error} onRetry={() => list.refetch()} compact /> : live.length === 0 ? (
        <EmptyState icon={<Zap />} title="No automations yet" className="py-6">
          An automation does something for you when a record changes or on a schedule, such as notifying an owner about a big deal. The <DocsLink page="automations.md">automations guide</DocsLink> walks you through creating the first one.
        </EmptyState>
      ) : (
        <>
          <div role="group" aria-label="Filter automations" className="mb-7 flex flex-wrap gap-2">
            {CHIPS.map((c) => (
              <button key={c.id} type="button" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-medium text-muted hover:text-fg aria-pressed:border-transparent aria-pressed:bg-accent-soft aria-pressed:text-accent-soft-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                {c.label} <span className="tabular-nums">{count(c.id)}</span>
              </button>
            ))}
          </div>
          {shown.length === 0 ? <p className="text-base text-muted">No {filter} automations.</p> : (
            <SimpleTable label="Automations" head={["Automation", "Trigger", "Status", "Last run", "Next run"]}>
                {shown.map((a) => {
                  const st = shownStatus(a);
                  return (
                    <tr key={a.id}>
                      <td className="px-4 py-2">
                        <Link to="/settings/automations/$automationId" params={{ automationId: a.id }} className="font-medium text-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus">{a.name}</Link>
                        {a.description ? <p className="text-sm text-muted">{a.description}</p> : null}
                      </td>
                      <td className="px-4 py-2 text-sm">{describeTrigger(a.trigger)}</td>
                      <td className="px-4 py-2 text-sm">
                        <Badge tone={SHOWN_TONE[st]}>{SHOWN_LABEL[st]}</Badge>
                        {st === "failing" ? <span className="block text-muted">{a.consecutive_failures} failed in a row</span> : null}
                        {st === "paused" && a.paused_reason ? <span className="block text-muted">{a.paused_reason}</span> : null}
                      </td>
                      <td className="px-4 py-2 text-sm"><LastRun id={a.id} /></td>
                      <td className="px-4 py-2 text-sm">{a.next_run_at ? <span title={formatDateTime(a.next_run_at)}>{formatRelative(a.next_run_at)}</span> : <span className="text-subtle">None</span>}</td>
                    </tr>
                  );
                })}
              </SimpleTable>
          )}
        </>
      )}
    </Section>
  );
}

/** The most recent run, from the automation's own history. */
function LastRun({ id }: { id: string }) {
  const q = useAdmin<{ data: AutomationRun[] }>(["automation-runs", id], `/v1/automations/${encodeURIComponent(id)}/runs`, { limit: 1 });
  if (q.isPending) return <Skeleton className="h-4 w-20" />;
  if (q.error) return <span className="text-muted">Unavailable</span>;
  const r = q.data.data[0];
  if (!r) return <span className="text-muted">Never run</span>;
  return (
    <span title={[r.reason, r.cap ? `cap: ${r.cap}` : null, r.failure ? `failure: ${r.failure}` : null].filter(Boolean).join(" · ") || undefined}>
      <Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status}</Badge> <span className="text-muted">{formatRelative(r.finished_at ?? r.started_at)}</span>
    </span>
  );
}
