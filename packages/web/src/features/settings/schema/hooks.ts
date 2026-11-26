import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useActorNames } from "@/features/layout-editor/data";
import { useApi } from "@/lib/api/context";
import type { ObjectMeta, SchemaChangeRow, SchemaSummaryObject } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { cleanMeta } from "@/meta/hooks";
import { qk } from "@/lib/keys";

/**
 * One object's describe with hidden fields included, as an admin looks at the schema. It sits under the
 * object's usual describe key, so invalidating that key (after a schema change) refreshes this too.
 */
export function useSchemaDescribe(object: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: [...qk.describe(object ?? ""), "all"],
    queryFn: async ({ signal }) => cleanMeta((await api.get<{ data: ObjectMeta }>(`/v1/objects/${encodeURIComponent(object!)}`, { include_hidden: "true" }, signal)).data),
    enabled: Boolean(object),
    staleTime: 60_000,
  });
}

/** Record counts per object (GET /v1/schema). A failure just leaves the counts out of the header. */
export function useRecordCounts(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["meta", "schema-counts"],
    queryFn: async ({ signal }) => (await api.get<{ data: { objects: SchemaSummaryObject[] } }>("/v1/schema", undefined, signal)).data.objects,
    enabled, staleTime: 60_000, retry: false,
  });
}

/** The schema's change history (audit:read only), newest first: one object's, or the whole workspace's when `object` is null. */
export function useSchemaChanges(object: string | null, limit: number, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: ["admin", "schema-changes", object ?? "", limit],
    queryFn: async ({ signal }) => (await api.get<{ data: SchemaChangeRow[] }>("/v1/schema/changes", { limit, object: object ?? undefined }, signal)).data,
    enabled, retry: false,
  });
}

/** A change's author in words: a member's name when the directory knows it, otherwise a plain description of who it was. */
export function useWho() {
  const names = useActorNames();
  const me = useSession().member;
  return useCallback((actor: string) => {
    if (actor === me.id) return `${me.name} (you)`;
    if (actor === "system" || actor === "") return "System";
    const n = names(actor);
    if (n !== actor) return n;
    return actor.startsWith("svc_") || actor.startsWith("sa_") ? "A service account" : actor.startsWith("usr_") ? "A member" : actor;
  }, [names, me.id, me.name]);
}
