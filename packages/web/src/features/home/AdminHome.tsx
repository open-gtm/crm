import { Link } from "@tanstack/react-router";
import { KeyRound, Webhook as WebhookIcon, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { useUsers } from "@/components/pickers";
import { Badge } from "@/components/ui/misc";
import type { ApiKey, Automation, EventsSummary, Members, RunsSummary, SchemaChange, Webhook } from "@/lib/api/types";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { sentence, sourceText } from "./lib";
import { ArrowIcon, isForbidden, Panel, PanelEmpty, PanelLoading, PanelProblem, panelLink, StatCard, useHomeGet } from "./parts";

const DAY = 86_400_000;

/** The member or service account behind an ID, by name where the directory lists them. */
function useWho() {
  const users = useUsers();
  const names = new Map((users.data ?? []).map((u) => [u.id, u.name]));
  return (id: string | null) => (id ? names.get(id) ?? id : "Unknown");
}

const Time = ({ at }: { at: string }) => <time dateTime={at} title={formatDateTime(at)} className="whitespace-nowrap text-sm text-subtle">{formatRelative(at)}</time>;

interface Attention { key: string; icon: ReactNode; title: string; sub: string; to: "/settings/automations" | "/settings/webhooks" | "/settings/api-keys"; action: string }

/** The admin's Home: what automations, webhooks, keys and agents did lately, composed from the admin endpoints. */
export function AdminHome() {
  const s = useSession();
  const who = useWho();
  const runs = useHomeGet<{ data: RunsSummary }>(["runs-summary"], "/v1/automations/runs/summary");
  const events = useHomeGet<{ data: EventsSummary }>(["events-summary"], "/v1/events/summary");
  const automations = useHomeGet<{ data: Automation[] }>(["automations"], "/v1/automations");
  const members = useHomeGet<{ data: Members }>(["members"], "/v1/members", undefined, s.can("members:manage"));
  const webhooks = useHomeGet<{ data: Webhook[] }>(["webhooks"], "/v1/webhooks", undefined, s.can("webhooks:manage"));
  const keys = useHomeGet<{ data: ApiKey[] }>(["api-keys"], "/v1/api-keys", undefined, s.can("keys:manage"));
  const changes = useHomeGet<{ data: SchemaChange[] }>(["schema-changes"], "/v1/schema/changes", { limit: 8 });

  // One clock reading per render for "as of" and "within 14 days".
  const asOf = new Date();
  const list = automations.data?.data ?? [];
  const paused = list.filter((a) => a.status === "paused");
  const failing = list.filter((a) => (a.consecutive_failures ?? 0) > 0);

  const attention: Attention[] = [];
  for (const a of runs.data?.data.automations ?? []) {
    if (a.failed > 0) attention.push({ key: `run-${a.id}`, icon: <Zap />, title: a.name, sub: `${a.failed} failed ${a.failed === 1 ? "run" : "runs"} in 24 hours${a.last_failure ? `: ${a.last_failure}` : ""}`, to: "/settings/automations", action: "Automations" });
  }
  for (const a of paused) attention.push({ key: `paused-${a.id}`, icon: <Zap />, title: a.name, sub: `Paused${a.paused_reason ? `: ${a.paused_reason}` : ""}`, to: "/settings/automations", action: "Automations" });
  for (const w of webhooks.data?.data ?? []) {
    const status = String(w.status ?? "");
    const failures = w.consecutive_failures ?? 0;
    if (status === "paused" || (status === "active" && failures > 0)) {
      attention.push({ key: `hook-${w.id}`, icon: <WebhookIcon />, title: w.url, sub: status === "paused" ? `Paused after ${failures} failed deliveries` : `${failures} failed deliveries in a row`, to: "/settings/webhooks", action: "Webhooks" });
    }
  }
  for (const k of keys.data?.data ?? []) {
    if (k.revoked_at || !k.expires_at) continue;
    const left = new Date(k.expires_at).getTime() - asOf.getTime();
    if (left <= 14 * DAY) attention.push({ key: `key-${k.id}`, icon: <KeyRound />, title: k.name, sub: left <= 0 ? `Expired ${formatRelative(k.expires_at)}` : `Expires ${formatRelative(k.expires_at)}`, to: "/settings/api-keys", action: "API keys" });
  }
  const attentionReady = [runs, automations, ...(s.can("webhooks:manage") ? [webhooks] : []), ...(s.can("keys:manage") ? [keys] : [])].every((q) => !q.isPending);
  const sources = events.data?.data.sources ?? [];
  const totalChanges = sources.reduce((n, x) => n + x.changes, 0);
  const t = runs.data?.data.totals;

  return (
    <>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {s.can("members:manage") && !isForbidden(members.error) ? (
          members.data ? <StatCard label="Members" values={[formatNumber(members.data.data.users.filter((u) => u.active).length)]} sub={`${formatNumber(members.data.data.service_accounts.filter((u) => u.active).length)} service ${members.data.data.service_accounts.filter((u) => u.active).length === 1 ? "account" : "accounts"}`} />
            : members.error ? null : <StatCard label="Members" loading />
        ) : null}
        {isForbidden(automations.error) ? null : automations.data ? (
          <StatCard label="Automations" values={[formatNumber(list.filter((a) => a.status === "enabled").length)]}
            sub={`${formatNumber(paused.length)} paused, ${formatNumber(failing.length)} with failures`} />
        ) : automations.error ? null : <StatCard label="Automations" loading />}
        {isForbidden(runs.error) ? null : t ? <StatCard label="Runs in 24h" values={[`${formatNumber(t.succeeded)} / ${formatNumber(t.failed)}`]} sub="Succeeded / failed" />
          : runs.error ? null : <StatCard label="Runs in 24h" loading />}
        {isForbidden(events.error) ? null : events.data ? <StatCard label="Changes by agents in 24h" values={[formatNumber(totalChanges)]} sub="Through API keys, MCP and the CLI" />
          : events.error ? null : <StatCard label="Changes by agents in 24h" loading />}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="Needs attention" sub={`as of ${asOf.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}>
            {!attentionReady ? <PanelLoading />
              : attention.length === 0 ? <PanelEmpty>Nothing needs attention.</PanelEmpty>
              : (
                <ul className="divide-y divide-line">
                  {attention.map((x) => (
                    <li key={x.key} className="flex items-center gap-3 px-4 py-3">
                      <span aria-hidden className="rounded-md bg-warning-soft p-1.5 text-warning-fg [&_svg]:size-4">{x.icon}</span>
                      <div className="min-w-0 flex-1"><p className="truncate font-medium"><bdi>{x.title}</bdi></p><p className="text-sm text-subtle">{x.sub}</p></div>
                      <Link to={x.to} className={panelLink}>{x.action} <ArrowIcon /></Link>
                    </li>
                  ))}
                </ul>
              )}
          </Panel>

          {isForbidden(events.error) ? null : (
            <Panel title="Agent and API activity · 24h" sub="Changes made through API keys, MCP clients and the CLI, per source">
              {events.isPending ? <PanelLoading /> : events.error ? <PanelProblem error={events.error} />
                : sources.length === 0 ? <PanelEmpty>No changes through API keys, MCP or the CLI in the last 24 hours.</PanelEmpty>
                : (
                  <div className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" role="region" aria-label="Agent and API activity" tabIndex={0}>
                    <table className="w-full min-w-[34rem] text-left text-base" aria-label="Agent and API activity">
                      <thead className="border-b border-line bg-surface-2 text-sm text-muted">
                        <tr><th scope="col" className="px-4 py-2 font-medium">Who</th><th scope="col" className="px-4 py-2 font-medium">Source</th><th scope="col" className="px-4 py-2 text-right font-medium">Changes</th><th scope="col" className="px-4 py-2 text-right font-medium">Records</th><th scope="col" className="px-4 py-2 font-medium">Last active</th></tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {sources.map((x) => (
                          <tr key={`${x.actor}-${x.surface}-${x.via}`}>
                            <td className="px-4 py-2.5 font-medium"><bdi>{who(x.actor)}</bdi></td>
                            <td className="px-4 py-2.5"><Badge tone="info">{sourceText(x.surface, x.via)}</Badge></td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(x.changes)}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(x.records)}</td>
                            <td className="px-4 py-2.5"><Time at={x.last_at} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Panel>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {isForbidden(runs.error) ? null : (
            <Panel title="Automation runs · 24h" action={<Link to="/settings/automations" className={panelLink}>Automations <ArrowIcon /></Link>}>
              {runs.isPending ? <PanelLoading /> : runs.error ? <PanelProblem error={runs.error} />
                : runs.data.data.automations.length === 0 ? <PanelEmpty>No automation ran in the last 24 hours.</PanelEmpty>
                : (
                  <ul className="divide-y divide-line">
                    {[...runs.data.data.automations].sort((a, b) => b.failed - a.failed).map((a) => (
                      <li key={a.id} className="px-4 py-2.5">
                        <p className="truncate font-medium"><bdi>{a.name}</bdi></p>
                        <p className="flex flex-wrap gap-x-3 text-sm tabular-nums text-subtle">
                          <span>{formatNumber(a.succeeded)} succeeded</span>
                          <span className={a.failed ? "font-medium text-danger-fg" : ""}>{formatNumber(a.failed)} failed</span>
                          <span>{formatNumber(a.skipped)} skipped</span>
                          <span>{formatNumber(a.open)} open</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
            </Panel>
          )}
          {isForbidden(changes.error) ? null : (
            <Panel title="Recent schema changes" action={<Link to="/settings/audit" className={panelLink}>Audit log <ArrowIcon /></Link>}>
              {changes.isPending ? <PanelLoading /> : changes.error ? <PanelProblem error={changes.error} />
                : changes.data.data.length === 0 ? <PanelEmpty>No schema changes yet.</PanelEmpty>
                : (
                  <ul className="divide-y divide-line">
                    {changes.data.data.map((c) => (
                      <li key={c.version} className="px-4 py-2.5 text-base">
                        <p><span className="font-medium">{sentence(c.change)}</span>{c.object ? <span className="text-muted"> · {c.object}{c.field ? `.${c.field}` : ""}</span> : null}</p>
                        <p className="text-sm text-subtle"><bdi>{who(c.actor)}</bdi> · {sourceText(c.surface, c.via)}{c.pack ? ` · pack ${c.pack}` : ""} · <Time at={c.changed_at} /></p>
                      </li>
                    ))}
                  </ul>
                )}
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
