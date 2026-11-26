import { useParams, useSearch } from "@tanstack/react-router";

/**
 * The record page layout editor (ADR 0017): `/o/{object}/customize`, optionally `?record=<id>` to show the
 * page as that record has it. People and agents edit one shared draft here.
 */
export function LayoutEditorPage() {
  const { object } = useParams({ strict: false }) as { object?: string };
  const { record } = useSearch({ strict: false }) as { record?: string };
  return <div className="p-6 text-base text-muted">Customize the {object} page{record ? ` (shown with ${record})` : ""}</div>;
}
