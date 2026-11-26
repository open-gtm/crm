import { useQueries, useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta, ObjectSummary } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { forPeople, plainLabel } from "@/lib/text";

/**
 * Labels from the schema (object, field, option, pipeline, stage and activity-type names) are shown in
 * menus, headers and navigation everywhere: they lose any bidirectional control characters once, here,
 * as describe output arrives. Record values are left as they are and isolated where shown (registry.tsx).
 */
function cleanField(f: FieldMeta, standard: boolean): FieldMeta {
  return { ...f, label: plainLabel(f.label), ...(f.values ? { values: f.values.map((v) => ({ ...v, label: plainLabel(v.label) })) } : {}),
    ...(standard && f.description ? { description: forPeople(f.description) } : {}) };
}
export function cleanSummary<T extends Pick<ObjectSummary, "label" | "plural_label"> & { standard?: boolean; description?: string }>(o: T): T {
  return { ...o, label: plainLabel(o.label), plural_label: plainLabel(o.plural_label), ...(o.standard && o.description ? { description: forPeople(o.description) } : {}) };
}
export function cleanMeta(o: ObjectMeta): ObjectMeta {
  // The standard objects' descriptions name API operations; people get words instead (lib/text.ts). A custom object's are the admin's own.
  return {
    ...cleanSummary(o),
    fields: o.fields.map((f) => cleanField(f, o.standard)),
    ...(o.pipelines ? { pipelines: o.pipelines.map((p) => ({ ...p, name: plainLabel(p.name), stages: p.stages.map((s) => ({ ...s, name: plainLabel(s.name) })) })) } : {}),
    ...(o.activity_types ? { activity_types: o.activity_types.map((t) => ({ ...t, label: plainLabel(t.label) })) } : {}),
  };
}

/** Metadata changes rarely: cached for five minutes, refreshed in the background. */
const META_STALE = 5 * 60_000;

/** Every object (turned-on modules only), with the caller's access to each. */
export function useObjects() {
  const api = useApi();
  return useQuery({
    queryKey: qk.objects,
    queryFn: async ({ signal }) => (await api.get<{ data: ObjectSummary[] }>("/v1/objects", undefined, signal)).data.map(cleanSummary),
    staleTime: META_STALE,
  });
}

/** One object's describe: its fields with the caller's access to each, and its extras (pipelines, users, activity types). */
export function useDescribe(object: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: qk.describe(object ?? ""),
    queryFn: async ({ signal }) => cleanMeta((await api.get<{ data: ObjectMeta }>(`/v1/objects/${encodeURIComponent(object!)}`, undefined, signal)).data),
    enabled: Boolean(object),
    staleTime: META_STALE,
  });
}

/** Several describes at once (related lists, relation paths in the filter builder). */
export function useDescribes(objects: string[]) {
  const api = useApi();
  return useQueries({
    queries: objects.map((o) => ({
      queryKey: qk.describe(o),
      queryFn: async ({ signal }: { signal: AbortSignal }) => cleanMeta((await api.get<{ data: ObjectMeta }>(`/v1/objects/${encodeURIComponent(o)}`, undefined, signal)).data),
      staleTime: META_STALE,
    })),
  });
}

/** Link records between standard objects (deal_contact…): reachable, but not where people start. Custom objects may use `_` freely. */
export const isJunction = (o: Pick<ObjectSummary, "name" | "standard">) => o.standard && o.name.includes("_");

/** Objects for navigation: readable and not hidden; standard ones first in a working order, then custom ones by label. */
export function navObjects(all: ObjectSummary[]): { standard: ObjectSummary[]; custom: ObjectSummary[] } {
  const ORDER = ["contact", "account", "lead", "deal", "quote", "order", "task", "activity"];
  const readable = all.filter((o) => o.access.read && !o.hidden);
  const rank = (o: ObjectSummary) => {
    const i = ORDER.indexOf(o.name);
    return i === -1 ? ORDER.length : i;
  };
  return {
    standard: readable.filter((o) => o.standard).sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)),
    custom: readable.filter((o) => !o.standard).sort((a, b) => a.label.localeCompare(b.label)),
  };
}
