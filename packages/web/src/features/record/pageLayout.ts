import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api/context";
import type { FieldMeta } from "@/lib/api/types";

/** How an object's record page is arranged (GET /v1/objects/{object}/layout). `custom: false` means the default page. */
export interface PageLayout { object: string; custom: boolean; sections: { title: string; fields: string[] }[]; updated_at: string | null }

export const layoutKey = (object: string) => ["meta", "layout", object] as const;

export function usePageLayout(object: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: layoutKey(object), enabled, staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => (await api.get<{ data: PageLayout }>(`/v1/objects/${encodeURIComponent(object)}/layout`, undefined, signal)).data,
  });
}

export interface PageSection { title: string; fields: FieldMeta[] }

/**
 * The sections a record page shows, from the fields this member may see. With a layout: its sections in
 * order (one with nothing to show is left out), then "Other fields" for anything the layout doesn't
 * place, so a field added later is never missing from the page. Without one: the object's own fields
 * under Details and custom ones under Custom fields, as before layouts.
 */
export function arrangeFields(fields: FieldMeta[], layout: PageLayout | undefined): PageSection[] {
  if (!layout?.custom) {
    const standard = fields.filter((f) => f.standard);
    const custom = fields.filter((f) => !f.standard);
    return standard.length && custom.length ? [{ title: "Details", fields: standard }, { title: "Custom fields", fields: custom }]
      : [{ title: "Details", fields: standard.length ? standard : custom }];
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  const placed = new Set<string>();
  const sections: PageSection[] = [];
  for (const s of layout.sections) {
    const shown = s.fields.map((n) => byName.get(n)).filter((f): f is FieldMeta => f !== undefined && !placed.has(f.name));
    for (const f of shown) placed.add(f.name);
    if (shown.length) sections.push({ title: s.title, fields: shown });
  }
  const rest = fields.filter((f) => !placed.has(f.name));
  if (rest.length) sections.push({ title: sections.some((s) => s.title === "Other fields") ? "More fields" : "Other fields", fields: rest });
  return sections;
}
