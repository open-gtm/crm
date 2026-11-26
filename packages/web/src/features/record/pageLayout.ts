import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api/context";
import type { FieldMeta } from "@/lib/api/types";

/** One part of a record page (ADR 0017). Every component has a stable id. */
export type LayoutComponent =
  | { id: string; type: "fields"; name: string; columns: 1 | 2; collapsed: boolean; fields: string[] }
  | { id: string; type: "related"; object: string; field: string; rows: number }
  | { id: string; type: "tasks" | "quotes"; rows: number }
  | { id: string; type: "stage_path"; field: string | null }
  | { id: string; type: "agent_changes"; days: number }
  | { id: string; type: "timeline" | "notes" | "files" | "related_lists" };
export type LayoutZone = "top" | "left" | "main" | "right";
/** A layout by field and object name. `key_facts: null` leaves the header's facts to the page. */
export interface LayoutDoc {
  header: { key_facts: string[] | null };
  top: LayoutComponent[];
  columns: { left: LayoutComponent[]; main: LayoutComponent[]; right: LayoutComponent[] };
}
/** Where a change came from: the surface (web, admin-mcp, cli, api), the member, and the connected app or API key by name. */
export interface LayoutSource { surface: string; actor: string | null; via: string | null }

/**
 * How an object's record page is arranged (GET /v1/objects/{object}/layout). `custom: false` means the
 * default page, which `layout` still describes. `sections` are the layout's field sections (ADR 0015).
 */
export interface PageLayout {
  object: string; custom: boolean; version?: number; layout?: LayoutDoc; sections: { title: string; fields: string[] }[]; updated_at: string | null;
}

/** One change to the shared draft (GET /v1/objects/{object}/layout/draft). */
export interface LayoutChange {
  id: string; revision: number; summary: string; changes: string[]; note: string | null; source: LayoutSource; at: string; reviewed: boolean; can_undo: boolean;
}
/** The draft people and agents share. With no draft, `layout` is the published one and `revision` is 0. */
export interface LayoutDraft {
  object: string; has_draft: boolean; revision: number; layout: LayoutDoc; published_version: number; published_custom: boolean; stale: boolean;
  diff: string[]; changes: LayoutChange[]; updated_at: string | null;
}
/** The answer to a draft write or a restore; with dry_run nothing was saved and `changes` is what would change. */
export interface LayoutDraftWrite {
  dry_run: boolean; saved: boolean; revision: number; object: string; layout: LayoutDoc; changes: string[]; warnings: string[]; diff_from_published: string[]; restored_from?: number;
}
export interface LayoutVersion {
  version: number; current: boolean; summary: string; changes: string[]; restored_from: number | null; source: LayoutSource; at: string; default_page: boolean;
  contributors: { actor: string | null; surface: string; via: string | null; summary: string; note: string | null; at: string }[]; layout?: LayoutDoc;
}

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
