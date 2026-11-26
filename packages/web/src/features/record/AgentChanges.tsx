import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { EmptyState } from "@/components/feedback";
import { useUsers } from "@/components/pickers";
import { Badge, Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { isRestricted, visibleFields } from "@/meta/fields";
import { FieldValue } from "@/meta/registry";

/** What GET /v1/events returns for one event (the part this card reads). */
interface ApiEvent {
  id: string; type: string; occurred_at: string;
  actor: { type: string; id: string | null; surface: string };
  data: Record<string, unknown>;
}

/** The surfaces that are agents and scripts, not people at the web app (the automation engine and the system are neither). */
const AGENT_SURFACES = new Set(["api", "cli", "admin-mcp", "ops-mcp"]);
const SURFACE_LABEL: Record<string, string> = { api: "API", cli: "CLI", "admin-mcp": "MCP", "ops-mcp": "MCP" };
const DAY = 86_400_000;
/** Events come 200 at a time, newest first; this many pages is more than any record's recent history needs. */
const MAX_PAGES = 5;

export const isAgentEvent = (e: Pick<ApiEvent, "actor">) => AGENT_SURFACES.has(e.actor.surface);

/** The events on a record within the last `days` days that agents made, newest first. */
export function agentEvents(events: ApiEvent[], days: number, now = Date.now()): ApiEvent[] {
  return events.filter((e) => isAgentEvent(e) && now - Date.parse(e.occurred_at) <= days * DAY);
}

function useRecordEvents(recordId: string, days: number) {
  const api = useApi();
  return useQuery({
    queryKey: ["events", "record", recordId, days],
    retry: false,
    queryFn: async ({ signal }) => {
      const since = Date.now() - days * DAY;
      const out: ApiEvent[] = [];
      let before: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await api.get<{ data: ApiEvent[]; next_before: string | null }>("/v1/events", { record: recordId, limit: 200, before }, signal);
        out.push(...r.data);
        const oldest = r.data[r.data.length - 1];
        if (!r.next_before || !oldest || Date.parse(oldest.occurred_at) < since) break;
        before = r.next_before;
      }
      return out;
    },
  });
}

const words = (s: string) => s.replace(/_/g, " ");

/** An event type in words: `deal.updated` is "Changed", `deal.stage_changed` "Moved to <stage>". */
export function eventWords(e: Pick<ApiEvent, "type" | "data">, meta: Pick<ObjectMeta, "label">): string {
  const noun = meta.label.toLowerCase();
  const [, action = e.type] = e.type.split(".");
  switch (action) {
    case "created": return `Created this ${noun}`;
    case "updated": return "Changed";
    case "archived": return `Archived this ${noun}`;
    case "restored": return `Restored this ${noun}`;
    case "merged": return `Merged this ${noun}`;
    case "stage_changed": return typeof e.data.to_stage === "string" ? `Moved to ${e.data.to_stage}` : "Moved to another stage";
    default: { const t = words(action); return t.charAt(0).toUpperCase() + t.slice(1); }
  }
}

interface Change { field: FieldMeta; before: unknown; after: unknown }

/** The fields an update changed, only those this member can read: the server leaves the rest out, and so does this. */
export function changedFields(data: Record<string, unknown>, meta: ObjectMeta): Change[] {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const before = obj(data.before);
  const after = obj(data.after);
  const readable = new Map(visibleFields(meta).filter((f) => !isRestricted(f)).map((f) => [f.name, f]));
  return Object.keys(after).filter((n) => readable.has(n) && JSON.stringify(before[n] ?? null) !== JSON.stringify(after[n] ?? null))
    .map((n) => ({ field: readable.get(n)!, before: before[n] ?? null, after: after[n] ?? null }));
}

const SHOWN_FIELDS = 4;

/**
 * Changes made on this record through API keys, MCP and the CLI in the last `days` days, from the event log.
 * The log says which surface and member or key acted, never which app, so none is named. It shows nothing
 * when the member's role can't read the events.
 */
export function AgentChanges({ meta, recordId, days }: { meta: ObjectMeta; recordId: string; days: number }) {
  const q = useRecordEvents(recordId, days);
  const users = useUsers("", meta.users);
  if (q.isError) return null;
  const names = new Map((users.data ?? []).map((u) => [u.id, u.name]));
  const items = q.data ? agentEvents(q.data, days) : [];
  return (
    <section aria-label="Changes by agents" className="rounded-lg border border-line bg-surface">
      <div className="border-b border-line px-4 py-2.5">
        <h2 className="text-md font-semibold">Changes by agents</h2>
        <p className="text-sm text-subtle">Made through the API, MCP or the CLI in the last {days} {days === 1 ? "day" : "days"}</p>
      </div>
      {q.isPending ? <div className="p-4" aria-busy="true"><Skeleton className="h-10" /></div>
        : items.length === 0 ? <EmptyState title={`No changes by agents in the last ${days} ${days === 1 ? "day" : "days"}.`} className="py-6" />
        : (
          <ul className="divide-y divide-line">
            {items.map((e) => {
              const changes = e.type.endsWith(".updated") ? changedFields(e.data, meta) : [];
              return (
                <li key={e.id} className="px-4 py-3 text-base">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{eventWords(e, meta)}</span>
                    <Badge tone="info">{SURFACE_LABEL[e.actor.surface] ?? e.actor.surface}</Badge>
                    <time dateTime={e.occurred_at} title={formatDateTime(e.occurred_at)} className="ml-auto text-sm text-subtle">{formatRelative(e.occurred_at)}</time>
                  </div>
                  <p className="text-sm text-muted">By <bdi>{e.actor.id ? names.get(e.actor.id) ?? e.actor.id : "an unknown actor"}</bdi></p>
                  {changes.length ? (
                    <ul className="mt-1.5 flex flex-col gap-1">
                      {changes.slice(0, SHOWN_FIELDS).map((c) => (
                        <li key={c.field.name} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
                          <span className="text-muted">{c.field.label}</span>
                          <span className="min-w-0 max-w-40"><FieldValue field={c.field} value={c.before} meta={meta} /></span>
                          <ArrowRight aria-label="to" className="size-3.5 shrink-0 text-subtle" />
                          <span className="min-w-0 max-w-40"><FieldValue field={c.field} value={c.after} meta={meta} /></span>
                        </li>
                      ))}
                      {changes.length > SHOWN_FIELDS ? <li className="text-sm text-subtle">and {changes.length - SHOWN_FIELDS} more</li> : null}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}
