import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProblemAlert, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import type { LayoutChange, LayoutDraft, LayoutDraftWrite, LayoutSource, LayoutVersion } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import { formatDateTime, formatRelative } from "@/lib/format";
import { draftKey, layoutPath, versionsKey, useVersions } from "./data";
import { changesNewestFirst, surfaceLabel, whoLabel } from "./model";

function SourceBadge({ source }: { source: LayoutSource }) {
  return <Badge tone={source.surface === "web" ? "neutral" : source.surface === "admin-mcp" ? "info" : "accent"}>{surfaceLabel(source.surface)}</Badge>;
}

const When = ({ at }: { at: string }) => <time dateTime={at} title={formatDateTime(at)}>{formatRelative(at)}</time>;

/** The draft's changes (newest first, the newest can be undone) and then the published versions, each older one restorable. */
export function HistoryTab({ object, draft, actorName, onUndo, undoing }: {
  object: string; draft: LayoutDraft; actorName: (actor: string) => string; onUndo: (change: LayoutChange) => void; undoing: boolean;
}) {
  const versions = useVersions(object, true);
  const qc = useQueryClient();
  const api = useApi();
  const toast = useToast();
  const [preview, setPreview] = useState<{ version: number; write: LayoutDraftWrite } | null>(null);
  const changes = changesNewestFirst(draft);

  const dryRun = useMutation({
    mutationFn: (version: number) => api.post<{ data: LayoutDraftWrite }>(layoutPath(object, "/restore"), { version, revision: draft.revision, dry_run: true }),
    onSuccess: (r, version) => setPreview({ version, write: r.data }),
    onError: (e) => toast.error(e, "Couldn't preview that version"),
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.post<{ data: LayoutDraftWrite }>(layoutPath(object, "/restore"), { version, revision: draft.revision }),
    onSuccess: (_r, version) => {
      setPreview(null);
      void qc.invalidateQueries({ queryKey: draftKey(object) });
      void qc.invalidateQueries({ queryKey: versionsKey(object) });
      toast.toast({ tone: "success", title: `Version ${version} is now in the draft`, description: "Publish the draft to make it live." });
    },
    onError: (e) => toast.error(e, "Couldn't restore that version"),
  });

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-3">
      <section aria-label="Draft changes">
        <h2 className="mb-1 text-sm font-semibold">Draft</h2>
        {changes.length === 0 ? <p className="text-sm text-muted">{draft.has_draft ? "No changes are recorded for this draft." : "There is no draft. Change something and it starts one."}</p> : (
          <ol className="divide-y divide-line">
            {changes.map((c) => (
              <li key={c.id} className="flex gap-2.5 py-2.5">
                <Badge tone="warning" className="h-5 self-start">Draft</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{c.summary}</p>
                  {c.note ? <p className="text-sm text-muted">“{c.note}”</p> : null}
                  <p className="flex flex-wrap items-center gap-1 text-sm text-subtle">{whoLabel(c.source, actorName)} · <SourceBadge source={c.source} /> · <When at={c.at} /></p>
                </div>
                {c.can_undo ? <Button size="sm" variant="ghost" busy={undoing} aria-label={`Undo: ${c.summary}`} onClick={() => onUndo(c)}>Undo</Button> : null}
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="Published versions">
        <h2 className="mb-1 text-sm font-semibold">Published</h2>
        {versions.isPending ? <Skeleton className="h-16" /> : versions.error ? <ProblemView error={versions.error} onRetry={() => versions.refetch()} compact /> : versions.data.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been published yet: every record page uses the default page.</p>
        ) : (
          <ol className="divide-y divide-line">
            {versions.data.map((v: LayoutVersion) => (
              <li key={v.version} className="flex gap-2.5 py-2.5">
                <Badge tone={v.current ? "success" : "neutral"} className="h-5 self-start">v{v.version}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{v.summary}{v.current ? <> <Badge tone="success">current</Badge></> : null}</p>
                  <p className="flex flex-wrap items-center gap-1 text-sm text-subtle">
                    {whoLabel(v.source, actorName)} · <SourceBadge source={v.source} /> · <When at={v.at} />
                    {v.contributors.length > 1 ? <> · {v.contributors.length} contributors</> : null}
                  </p>
                </div>
                {v.current ? null : <Button size="sm" variant="ghost" busy={dryRun.isPending && dryRun.variables === v.version} aria-label={`Restore v${v.version}`} onClick={() => dryRun.mutate(v.version)}>Restore</Button>}
              </li>
            ))}
          </ol>
        )}
      </section>
      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        {preview ? (
          <DialogContent title={`Restore version ${preview.version}?`} description="It goes into the draft. Nothing changes for anyone until you publish the draft."
            footer={<>
              <Button onClick={() => setPreview(null)}>Cancel</Button>
              <Button variant="primary" busy={restore.isPending} onClick={() => restore.mutate(preview.version)}>Put it in the draft</Button>
            </>}>
            <ProblemAlert error={restore.error} className="mb-3" />
            {preview.write.changes.length === 0 ? <p className="text-base text-muted">The draft already matches this version.</p> : (
              <>
                <p className="mb-1.5 text-sm font-medium">This would change the draft:</p>
                <ul className="list-disc pl-5 text-base">{preview.write.changes.map((s) => <li key={s}>{s}</li>)}</ul>
              </>
            )}
            {preview.write.warnings.length ? <ul className="mt-3 list-disc pl-5 text-sm text-muted">{preview.write.warnings.map((s) => <li key={s}>{s}</li>)}</ul> : null}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
