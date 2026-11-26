import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { layoutKey, type LayoutDraft, type LayoutVersion } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import type { RoleAccess } from "@/lib/api/types";
import { useUsers } from "@/components/pickers";
import { useRoles } from "@/features/settings/MembersSettings";

/** The layout routes for one object. */
export const layoutPath = (object: string, rest = "") => `/v1/objects/${encodeURIComponent(object)}/layout${rest}`;

// Both sit under layoutKey, so publishing (which invalidates layoutKey) refreshes the draft and the history too.
export const draftKey = (object: string) => [...layoutKey(object), "draft"] as const;
export const versionsKey = (object: string) => [...layoutKey(object), "versions"] as const;

/** The shared draft: with none, the published layout and revision 0. Always fetched fresh, since agents change it too. */
export function useDraft(object: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: draftKey(object), enabled, staleTime: 0, refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => (await api.get<{ data: LayoutDraft }>(layoutPath(object, "/draft"), undefined, signal)).data,
  });
}

export function useVersions(object: string, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: versionsKey(object), enabled,
    queryFn: async ({ signal }) => (await api.get<{ data: LayoutVersion[] }>(layoutPath(object, "/versions"), undefined, signal)).data,
  });
}

/** Names for the member ids a change or version names; the id itself when the directory doesn't know it. */
export function useActorNames() {
  const users = useUsers("");
  const known = users.data;
  return useCallback((actor: string) => known?.find((u) => u.id === actor)?.name ?? actor, [known]);
}

/** The roles that can be previewed, and what one role can't read. Both stay quiet (undefined) when the caller may not read them. */
export function useRolePreview(role: string | null) {
  const api = useApi();
  const roles = useRoles();
  const access = useQuery({
    queryKey: ["admin", "role-access", role], enabled: role !== null, retry: false,
    queryFn: async ({ signal }) => (await api.get<{ data: RoleAccess }>(`/v1/roles/${encodeURIComponent(role!)}/access`, undefined, signal)).data,
  });
  return { roles: roles.data?.data.filter((r) => !r.archived_at), rolesError: roles.error, access };
}
