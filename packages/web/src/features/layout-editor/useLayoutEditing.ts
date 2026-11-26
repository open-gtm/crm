import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import type { LayoutDoc, LayoutDraft, LayoutDraftWrite } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import { draftKey, layoutPath } from "./data";
import { changesNewestFirst, surfaceLabel, whoLabel } from "./model";

/**
 * Every edit is one PUT of the whole layout to the shared draft, with the revision last read. The edit shows at once
 * (`doc` is the optimistic layout) and the server's answer replaces it: the server fills ids and defaults, so the
 * answer, never the local copy, is what the page keeps. Edits made while a save is out are folded into one follow-up
 * save. When someone else changed the draft meanwhile (409), the edit is dropped, the draft is read again, and the
 * person is told who changed it: their edit is never re-applied on top of a layout they haven't seen.
 */
export function useLayoutEditing(object: string, draft: LayoutDraft | undefined, actorName: (actor: string) => string) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [local, setLocal] = useState<LayoutDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const revision = useRef(0);
  const queued = useRef<LayoutDoc | null>(null);
  const flying = useRef(false);
  const current = useRef<LayoutDoc | undefined>(undefined);
  const names = useRef(actorName);
  names.current = actorName;

  // Between our own saves the draft's revision is whatever the server last said, including agents' changes.
  if (local === null) current.current = draft?.layout;
  useEffect(() => {
    if (draft && !flying.current && queued.current === null) revision.current = draft.revision;
  }, [draft]);

  const flush = useCallback(async () => {
    if (flying.current || !queued.current) return;
    const next = queued.current;
    queued.current = null;
    flying.current = true;
    setSaving(true);
    try {
      const r = (await api.put<{ data: LayoutDraftWrite }>(layoutPath(object, "/draft"), { layout: next, revision: revision.current })).data;
      revision.current = r.revision;
      qc.setQueryData<LayoutDraft>(draftKey(object), (old) => (old ? { ...old, has_draft: old.has_draft || r.saved, revision: r.revision, layout: r.layout } : old));
      if (queued.current === null) {
        current.current = r.layout;
        setLocal(null);
      }
      // The change list (who, when, what) comes from the draft itself.
      void qc.invalidateQueries({ queryKey: draftKey(object) });
    } catch (e) {
      queued.current = null;
      setLocal(null);
      const p = asProblem(e);
      if (p.status === 409 && p.code === "layout_draft_changed") {
        await qc.invalidateQueries({ queryKey: draftKey(object) });
        const fresh = qc.getQueryData<LayoutDraft>(draftKey(object));
        const newest = fresh ? changesNewestFirst(fresh)[0] : undefined;
        const who = newest ? `${whoLabel(newest.source, names.current)} through ${surfaceLabel(newest.source.surface)}` : "Someone else";
        setConflict(`${who} changed this draft while you were editing, so your last edit wasn't applied. The page now shows the draft as it is; make your change again if you still want it.`);
      } else if (p.code === "layout_revision_required") {
        void qc.invalidateQueries({ queryKey: draftKey(object) });
        toast.error(e, "Couldn't save that change");
      } else {
        toast.error(e, "Couldn't save that change");
      }
    } finally {
      flying.current = false;
      if (queued.current) void flush();
      else setSaving(false);
    }
  }, [api, qc, toast, object]);

  /** Applies a change to the layout as it is now (including edits still being saved). */
  const edit = useCallback((fn: (doc: LayoutDoc) => LayoutDoc) => {
    const base = current.current;
    if (!base) return;
    const next = fn(base);
    if (next === base) return;
    setConflict(null);
    current.current = next;
    queued.current = next;
    setLocal(next);
    void flush();
  }, [flush]);

  /** Forgets anything unsaved: after the draft was discarded, undone or published, the server's version is the only one. */
  const reset = useCallback(() => {
    queued.current = null;
    setLocal(null);
  }, []);

  return { doc: local ?? draft?.layout, edit, saving, conflict, dismissConflict: () => setConflict(null), reset };
}
