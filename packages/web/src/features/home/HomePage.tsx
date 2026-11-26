import { Link } from "@tanstack/react-router";
import { ArrowRight, Bell, ListChecks } from "lucide-react";
import { ProblemView } from "@/components/feedback";
import { Badge, Skeleton } from "@/components/ui/misc";
import { NotificationRow, TaskItem, useAttention, useMyTasks } from "@/features/inbox/shared";
import { SetPasswordCard } from "@/features/shell/FirstRun";
import { usePrefs } from "@/lib/prefs";
import { useSession } from "@/lib/session";
import { isJunction, navObjects, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { AdminHome } from "./AdminHome";
import { HeadlineCard } from "./HeadlineCards";
import { availableTeam } from "./lib";
import { AlertsPanel, PinnedViewsPanel, TodayPanel, YourAgentsPanel } from "./SideColumn";
import { TEAM_SPECS } from "./specs";
import { TEAM_PREF, TEAMS, teamOf, type TeamKey } from "./teams";
import { WorkTable } from "./WorkTable";

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Home: the team's own numbers when the member chose a team that is available here, otherwise the general starting point. */
export function HomePage() {
  const s = useSession();
  const prefs = usePrefs();
  const objects = useObjects();
  if (prefs.isPending || objects.isPending) {
    return <div className="mx-auto max-w-6xl p-4 md:p-8" aria-busy="true"><Skeleton className="h-8 w-64" /><Skeleton className="mt-6 h-24" /></div>;
  }
  const team = availableTeam(teamOf(prefs.data?.[TEAM_PREF]), objects.data ?? [], s.can);
  return team ? <TeamHome team={team} /> : <DefaultHome />;
}

function TeamHome({ team }: { team: TeamKey }) {
  const s = useSession();
  const objects = useObjects();
  const first = s.member.name.split(/\s+/)[0];
  const label = TEAMS.find((t) => t.key === team)?.label ?? "";
  const readable = new Set((objects.data ?? []).filter((o) => o.access.read).map((o) => o.name));
  const spec = team === "admin" ? null : TEAM_SPECS[team];
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <p className="text-sm text-subtle">{new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
      <h1 className="text-2xl font-semibold">{greeting()}, {first}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-base text-muted">
        <span>{s.workspace.name}</span><span aria-hidden>·</span><span>{label}</span>
        <Link to="/settings/account" className="text-sm text-accent hover:underline">Change team</Link>
      </p>
      <SetPasswordCard />
      {spec === null ? <AdminHome /> : (
        <>
          {spec.section ? <div className="mt-6"><Badge tone="info">{spec.section}</Badge></div> : null}
          <div className={`${spec.section ? "mt-2" : "mt-6"} grid gap-3 sm:grid-cols-2 lg:grid-cols-4`}>
            {spec.cards.filter((c) => readable.has(c.object)).map((c) => <HeadlineCard key={c.key} spec={c} me={s.member.id} currency={s.workspace.currency} />)}
          </div>
          <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              {readable.has(spec.table.object) ? <WorkTable spec={spec.table} me={s.member.id} currency={s.workspace.currency} /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <TodayPanel />
              <AlertsPanel />
              <YourAgentsPanel />
              <PinnedViewsPanel />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** A starting point: what needs attention, what's on my list, and every object a click away. */
function DefaultHome() {
  const s = useSession();
  const attention = useAttention();
  const tasks = useMyTasks();
  const objects = useObjects();
  const { standard, custom } = navObjects(objects.data ?? []);
  const first = s.member.name.split(/\s+/)[0];
  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{greeting()}, {first}</h1>
      <p className="mt-1 text-base text-muted">{s.workspace.name}</p>
      <p className="mt-1 text-sm"><Link to="/settings/account" className="text-accent hover:underline">Choose your team to see its numbers here.</Link></p>
      <SetPasswordCard />
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="h-attention" className="rounded-lg border border-line bg-surface">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Bell className="size-4 text-muted" aria-hidden />
            <h2 id="h-attention" className="flex-1 text-md font-semibold">Needs attention</h2>
            <Link to="/inbox" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">Inbox <ArrowRight className="size-3.5" /></Link>
          </header>
          {attention.isPending ? <div className="p-4"><Skeleton className="h-10" /></div>
            : attention.error ? <div className="p-4"><ProblemView error={attention.error} compact /></div>
            : attention.data.items.length === 0 ? <p className="px-4 py-6 text-base text-muted">Nothing needs your attention right now.</p>
            : <ul className="divide-y divide-line">{attention.data.items.slice(0, 5).map((n) => <NotificationRow key={n.id} n={n} />)}</ul>}
        </section>
        <section aria-labelledby="h-tasks" className="rounded-lg border border-line bg-surface">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <ListChecks className="size-4 text-muted" aria-hidden />
            <h2 id="h-tasks" className="flex-1 text-md font-semibold">My tasks</h2>
            <Link to="/tasks" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">All tasks <ArrowRight className="size-3.5" /></Link>
          </header>
          {tasks.isPending ? <div className="p-4"><Skeleton className="h-10" /></div>
            : tasks.error ? <div className="p-4"><ProblemView error={tasks.error} compact /></div>
            : tasks.data.length === 0 ? <p className="px-4 py-6 text-base text-muted">No open tasks. Enjoy it.</p>
            : <ul className="divide-y divide-line">{tasks.data.slice(0, 6).map((t) => <TaskItem key={t.id} task={t} overdue={typeof t.due_at === "string" && new Date(t.due_at).getTime() < Date.now()} />)}</ul>}
        </section>
      </div>
      <section aria-labelledby="h-objects" className="mt-6">
        <h2 id="h-objects" className="mb-3 text-md font-semibold">Records</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {objects.isPending ? [1, 2, 3, 4].map((i) => <li key={i}><Skeleton className="h-16" /></li>) : [...standard.filter((o) => !isJunction(o)), ...custom].map((o) => (
            <li key={o.name}>
              <Link to="/o/$object" params={{ object: o.name }} search={{}} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:border-line-strong hover:bg-surface-2">
                <span className="rounded-md bg-accent-soft p-1.5 text-accent-soft-fg"><ObjectIcon object={o} /></span>
                <span className="min-w-0 truncate font-medium">{o.plural_label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
