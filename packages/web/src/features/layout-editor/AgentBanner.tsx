import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LayoutChange } from "@/features/record/pageLayout";
import { formatRelative } from "@/lib/format";
import { surfaceLabel } from "./model";

/**
 * The newest change an agent (or anything but the web) made that nobody has looked at. The page can't say which blocks
 * it touched without guessing, so the change's own sentences are listed instead of an outline on the canvas.
 */
export function AgentBanner({ change, actorName, busy, onKeep, onUndo }: {
  change: LayoutChange; actorName: (actor: string) => string; busy: boolean; onKeep: () => void; onUndo: () => void;
}) {
  const surface = surfaceLabel(change.source.surface);
  return (
    <div role="status" className="flex flex-wrap items-start gap-2.5 border-b border-line bg-info-soft px-4 py-2.5 text-base text-info-fg md:px-5">
      <Zap className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-[1_1_22rem]">
        <p>
          <strong className="font-semibold">{change.source.via ? `${change.source.via} changed this draft through ${surface}` : `This draft was changed through ${surface}`}</strong>
          {change.source.actor ? ` for ${actorName(change.source.actor)}` : ""} {formatRelative(change.at)}{change.note ? `: “${change.note}”` : "."}
        </p>
        {change.changes.length ? <ul className="mt-1 list-disc pl-5 text-sm">{change.changes.map((s) => <li key={s}>{s}</li>)}</ul> : null}
      </div>
      <div className="flex gap-1.5">
        <Button size="sm" busy={busy} onClick={onKeep}>Keep</Button>
        {change.can_undo ? <Button size="sm" variant="ghost" busy={busy} onClick={onUndo}>Undo this change</Button> : null}
      </div>
    </div>
  );
}
