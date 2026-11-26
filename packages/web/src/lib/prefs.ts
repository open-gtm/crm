import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "./api/context";
import { qk } from "./keys";

/**
 * Per-member UI preferences, kept by the API (/v1/me/preferences): the theme, and per object the last
 * view and column layout. Not for anything sensitive; values are small JSON.
 */
export type Prefs = Record<string, unknown>;

export const PREF_KEY = /^[a-z0-9_.:-]{1,64}$/;
export const listPrefKey = (object: string) => `list.${object}`;

export interface ListPref { view?: string | null; columns?: string[]; sort?: string; layout?: "board" | "calendar" | null; by?: string | null; group?: string | null }

export function usePrefs() {
  const api = useApi();
  return useQuery({
    queryKey: qk.prefs,
    queryFn: async ({ signal }) => (await api.get<{ data: Prefs }>("/v1/me/preferences", undefined, signal)).data,
    staleTime: 5 * 60_000,
  });
}

/** Sets some preferences (null removes one), updating the cache at once. */
export function useSetPrefs() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Prefs) => {
      const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => PREF_KEY.test(k)));
      return (await api.put<{ data: Prefs }>("/v1/me/preferences", clean)).data;
    },
    onMutate: (patch) => {
      const prev = qc.getQueryData<Prefs>(qk.prefs);
      const next = { ...(prev ?? {}) };
      for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k]; else next[k] = v;
      qc.setQueryData(qk.prefs, next);
      return { prev };
    },
    onError: (_e, _v, c) => {
      if (c?.prev) qc.setQueryData(qk.prefs, c.prev);
    },
    onSuccess: (data) => qc.setQueryData(qk.prefs, data),
  });
}
