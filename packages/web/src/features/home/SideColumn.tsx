import { Link } from "@tanstack/react-router";
import { Pin, PinOff, Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { NotificationRow, TaskItem, useAttention, useMyTasks } from "@/features/inbox/shared";
import { eventWords } from "@/features/record/AgentChanges";
import type { EventRow, SavedView } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { usePrefs, useSetPrefs } from "@/lib/prefs";
import { useObjects } from "@/meta/hooks";
import { RecordLink } from "@/meta/registry";
import { sourceText } from "./lib";
import { ArrowIcon, Panel, PanelEmpty, PanelLoading, PanelProblem, panelLink, useHomeGet } from "./parts";
import { MAX_PINNED_VIEWS, PINNED_VIEWS_PREF } from "./teams";

/** The member's open tasks, as on the Tasks page (their own data, ticked off here too). */
export function TodayPanel() {
  const tasks = useMyTasks();
  return (
    <Panel title="Today" action={<Link to="/tasks" className={panelLink}>All tasks <ArrowIcon /></Link>}>
      {tasks.isPending ? <PanelLoading /> : tasks.error ? <PanelProblem error={tasks.error} />
        : tasks.data.length === 0 ? <PanelEmpty>No open tasks. Enjoy it.</PanelEmpty>
        : <ul className="divide-y divide-line">{tasks.data.slice(0, 6).map((t) => <TaskItem key={t.id} task={t} overdue={typeof t.due_at === "string" && new Date(t.due_at).getTime() < Date.now()} />)}</ul>}
    </Panel>
  );
}

/** What the inbox holds: alerts and automation messages that need the member. */
export function AlertsPanel() {
  const attention = useAttention();
  return (
    <Panel title="Alerts" action={<Link to="/inbox" className={panelLink}>Inbox <ArrowIcon /></Link>}>
      {attention.isPending ? <PanelLoading /> : attention.error ? <PanelProblem error={attention.error} />
        : attention.data.items.length === 0 ? <PanelEmpty>Nothing needs your attention right now.</PanelEmpty>
        : <ul className="divide-y divide-line">{attention.data.items.slice(0, 4).map((n) => <NotificationRow key={n.id} n={n} />)}</ul>}
    </Panel>
  );
}

const WEEK = 7 * 86_400_000;

/**
 * Changes made through the member's own API keys, the CLI and connected apps in the last seven days, from
 * the event log (the server answers actor=me&surface=agents: those surfaces only, and only this member's).
 */
export function YourAgentsPanel() {
  // Fixed when the card appears, so the request (and its cache entry) doesn't change with the clock.
  const [since] = useState(() => new Date(Date.now() - WEEK).toISOString());
  const events = useHomeGet<{ data: EventRow[] }>(["agents"], "/v1/events", { actor: "me", surface: "agents", since, limit: 20 });
  const objects = useObjects();
  const labels = new Map((objects.data ?? []).map((o) => [o.name, o.label]));
  return (
    <Panel title="Your agents" sub="Changes made through your keys and connected apps, last 7 days">
      {events.isPending ? <PanelLoading /> : events.error ? <PanelProblem error={events.error} />
        : events.data.data.length === 0 ? <PanelEmpty>No changes through your keys or connected apps in the last 7 days.</PanelEmpty>
        : (
          <ul className="divide-y divide-line">
            {events.data.data.map((e) => {
              const label = (e.object ? labels.get(e.object) : undefined) ?? "record";
              return (
                <li key={e.id} className="px-4 py-2.5 text-base">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{eventWords(e, { label })}</span>
                    {e.object && e.record_id ? <RecordLink object={e.object} id={e.record_id} className="text-sm">Open {label.toLowerCase()}</RecordLink> : null}
                  </p>
                  <p className="text-sm text-subtle">
                    {sourceText(e.actor.surface, e.actor.via)} · <time dateTime={e.occurred_at} title={formatDateTime(e.occurred_at)}>{formatRelative(e.occurred_at)}</time>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );
}

/** Views the member pinned to Home (the preference holds their IDs), each opening its list. */
export function PinnedViewsPanel() {
  const prefs = usePrefs();
  const setPrefs = useSetPrefs();
  const toast = useToast();
  const objects = useObjects();
  const views = useHomeGet<{ data: SavedView[] }>(["views"], "/v1/views");
  const stored = prefs.data?.[PINNED_VIEWS_PREF];
  const ids = Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : [];
  const all = (views.data?.data ?? []).filter((v) => v.object);
  const pinned = ids.map((id) => all.find((v) => v.id === id)).filter((v): v is SavedView => Boolean(v)).slice(0, MAX_PINNED_VIEWS);
  const pinnedIds = pinned.map((v) => v.id);
  const choices = all.filter((v) => !pinnedIds.includes(v.id) && v.status !== "unavailable");
  const objectLabel = (name: string | null) => (objects.data ?? []).find((o) => o.name === name)?.plural_label ?? name ?? "";
  const write = (next: string[]) => setPrefs.mutate({ [PINNED_VIEWS_PREF]: next.length ? next : null }, { onError: (e) => toast.error(e, "Couldn't update pinned views") });

  return (
    <Panel title="Pinned views"
      action={pinned.length < MAX_PINNED_VIEWS ? (
        <Menu>
          <MenuTrigger asChild><Button size="sm" variant="ghost" disabled={choices.length === 0}><Plus /> Pin a view</Button></MenuTrigger>
          <MenuContent align="end" className="max-h-72 overflow-y-auto">
            <MenuLabel>Your views</MenuLabel>
            {choices.map((v) => <MenuItem key={v.id} onSelect={() => write([...pinnedIds, v.id])}><bdi>{v.name}</bdi><span className="ml-2 text-subtle">{objectLabel(v.object)}</span></MenuItem>)}
          </MenuContent>
        </Menu>
      ) : null}>
      {views.isPending || prefs.isPending ? <PanelLoading /> : views.error ? <PanelProblem error={views.error} />
        : pinned.length === 0 ? <PanelEmpty>{choices.length ? "Pin the views you open most." : "No saved views yet. Save one from a list to pin it here."}</PanelEmpty>
        : (
          <ul className="divide-y divide-line">
            {pinned.map((v) => (
              <li key={v.id} className="flex items-center gap-2 px-4 py-2">
                <Pin className="size-3.5 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <Link to="/o/$object" params={{ object: v.object! }} search={{ view: v.id }} className="block truncate font-medium text-accent hover:underline"><bdi>{v.name}</bdi></Link>
                  <p className="truncate text-sm text-subtle">{v.status === "broken" ? v.problem ?? "No longer fits the schema" : objectLabel(v.object)}</p>
                </div>
                <Button size="icon-sm" variant="subtle" aria-label={`Unpin ${v.name}`} onClick={() => write(pinnedIds.filter((x) => x !== v.id))}><PinOff /></Button>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}
