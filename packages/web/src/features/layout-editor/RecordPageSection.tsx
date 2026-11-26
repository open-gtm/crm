import { Link } from "@tanstack/react-router";
import { ProblemView } from "@/components/feedback";
import { buttonVariants } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { usePageLayout } from "@/features/record/pageLayout";
import { Section } from "@/features/settings/SettingsLayout";
import type { ObjectMeta } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { useDraft } from "./data";

/**
 * Settings → an object: how its record page stands (the default page or a published version, and whether a draft
 * is waiting) and the way into the editor, where the arranging happens. Everything shown comes from the layout API.
 */
export function RecordPageSection({ meta }: { meta: ObjectMeta }) {
  const s = useSession();
  const editable = s.can("schema:manage");
  const layout = usePageLayout(meta.name);
  // The draft is for people who may change the layout; others see only what is published.
  const draft = useDraft(meta.name, editable);
  const published = layout.data ? (layout.data.custom ? `Published v${layout.data.version ?? 0}` : "Default page") : null;
  return (
    <Section id="record-page-layout" title="Record page"
      description={`How a ${meta.label.toLowerCase()}'s page is arranged, for everyone. A field the layout leaves out still shows, under "Other fields".`}
      actions={editable ? <Link to="/o/$object/customize" params={{ object: meta.name }} className={buttonVariants({ variant: "primary", size: "sm" })}>Customize page</Link> : null}>
      {layout.isPending ? <Skeleton className="h-8" /> : layout.error ? <ProblemView error={layout.error} onRetry={() => layout.refetch()} compact /> : (
        <div className="flex flex-wrap items-center gap-2 text-base">
          <Badge tone={layout.data.custom ? "success" : "neutral"}>{published}</Badge>
          {draft.data?.has_draft ? <Badge tone="warning">Draft waiting · {draft.data.changes.length} change{draft.data.changes.length === 1 ? "" : "s"}</Badge> : null}
          <span className="text-muted">{layout.data.custom
            ? "This object has a layout of its own."
            : "No layout is published: a record shows this object's own fields under Details, and custom fields under Custom fields."}
            {editable ? "" : " Changing it needs permission to manage the schema."}</span>
        </div>
      )}
    </Section>
  );
}
