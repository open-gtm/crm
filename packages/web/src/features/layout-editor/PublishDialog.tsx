import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ProblemAlert } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import type { LayoutDoc } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import { layoutPath } from "./data";

/** The answer to publishing, or to its dry run (`published` false). */
export interface PublishResult { dry_run: boolean; published: boolean; version: number; would_publish?: number; changes: string[]; stale: boolean; layout: LayoutDoc }

/**
 * What publishing would do, in the server's own sentences, before it is done. When the published layout changed
 * after this draft was started, publishing replaces those newer changes: that takes an explicit tick.
 */
export function PublishDialog({ object, objectLabel, revision, preview, onClose, onPublished }: {
  object: string; objectLabel: string; revision: number; preview: PublishResult; onClose: () => void; onPublished: (r: PublishResult) => void;
}) {
  const api = useApi();
  const boxId = useId();
  const [stale, setStale] = useState(preview.stale);
  const [overwrite, setOverwrite] = useState(false);
  const publish = useMutation({
    mutationFn: () => api.post<{ data: PublishResult }>(layoutPath(object, "/publish"), { revision, ...(stale && overwrite ? { overwrite: true } : {}) }),
    onSuccess: (r) => onPublished(r.data),
    // The published layout can change between the preview and the click: then the same tick is needed.
    onError: (e) => {
      if (asProblem(e).code === "layout_draft_stale") setStale(true);
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Publish the ${objectLabel} page?`} description="Every record page shows this layout from then on."
        footer={<>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={publish.isPending} disabled={stale && !overwrite} onClick={() => publish.mutate()}>Publish to everyone</Button>
        </>}>
        <ProblemAlert error={publish.error} className="mb-3" />
        {stale ? (
          <div role="alert" className="mb-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-base text-warning-fg">
            <p>The published layout changed after this draft was started. Publishing this draft replaces those newer changes.</p>
            <div className="mt-2 flex items-center gap-2">
              <Checkbox id={boxId} checked={overwrite} onCheckedChange={(v) => setOverwrite(v === true)} />
              <label htmlFor={boxId} className="text-base">Publish over it</label>
            </div>
          </div>
        ) : null}
        {preview.changes.length === 0 ? <p className="text-base text-muted">Nothing differs from the published page.</p> : (
          <>
            <p className="mb-1.5 text-sm font-medium">This would change the page:</p>
            <ul className="list-disc pl-5 text-base">{preview.changes.map((s) => <li key={s}>{s}</li>)}</ul>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
