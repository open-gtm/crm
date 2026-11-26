import { useMutation } from "@tanstack/react-query";
import { GitMerge, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { ProblemAlert } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useObjects } from "@/meta/hooks";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta, RecordData } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useApplyWrite } from "@/lib/writes";
import { FieldValue } from "@/meta/registry";
import { afterMerge, choosableFields, chosenFields, defaultSource, defaultSurvivor, isBlank, mergeRecordsOf, sameValue, MERGE_MAX_RECORDS } from "./merge";
import type { DuplicateGroup, DuplicateReason, MergeAnswer } from "./types";

/** "Record A", "Record B"…: duplicates often share a name, so the columns are told apart by letter. */
const letter = (i: number) => `Record ${String.fromCharCode(65 + i)}`;

function reasonText(r: DuplicateReason, meta: ObjectMeta): string {
  const names = r.fields.map((n) => meta.fields.find((f) => f.name === n)?.label.toLowerCase() ?? n).join(" and ");
  if (r.match === "similar") return `Similar ${names}${r.similarity !== undefined ? ` · ${Math.round(r.similarity * 100)}%` : ""}`;
  return r.match === "exact" ? `Same ${names}` : `Same ${names}, ignoring case and spacing`;
}

/** A record with the names of its owner and other members filled in from describe, which a duplicates answer doesn't include. */
function withNames(r: RecordData, meta: ObjectMeta): RecordData {
  const included: NonNullable<RecordData["included"]> = { ...(r.included ?? {}) };
  for (const f of meta.fields) {
    const v = r[f.name];
    if (f.type !== "relation" || f.relation?.to !== "user" || typeof v !== "string" || included[f.name]) continue;
    const u = meta.users?.find((x) => x.id === v);
    if (u) included[f.name] = { id: u.id, object: "user", display_name: u.name };
  }
  return { ...r, included };
}

/**
 * Possible duplicates, one group at a time. Skipping stores nothing. Merging is field by field: a column
 * per record, a choice of whose value to keep where they differ, the survivor selectable. The merge is
 * previewed by the server first (its dry run), and the real merge uses that preview's confirmation token.
 */
export function DuplicateReview({ meta, groups, onGroups, onClose }: {
  meta: ObjectMeta; groups: DuplicateGroup[]; onGroups: (g: DuplicateGroup[]) => void; onClose: () => void;
}) {
  const [at, setAt] = useState(0);
  const index = Math.min(at, Math.max(groups.length - 1, 0));
  const group = groups[index];
  if (!group) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-base text-muted">No groups left in this scan. Run the check again to look for others.</p>
        <Button size="sm" onClick={onClose}>Close</Button>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium" aria-live="polite">Group {index + 1} of {groups.length}</h3>
        <div className="flex flex-1 flex-wrap gap-1.5">
          <Badge tone="warning">{reasonText(group.reason, meta)}</Badge>
          {(group.reason.also ?? []).map((r, i) => <Badge key={i}>{reasonText(r, meta)}</Badge>)}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
      </div>
      <GroupMerge key={group.records.map((r) => r.id).join(",")} meta={meta} group={group} canSkip={groups.length > 1}
        onSkip={() => setAt((index + 1) % groups.length)}
        onMerged={(survivor, merged) => {
          onGroups(afterMerge(groups, survivor, merged));
          // The merged group is gone, so the same position is now the next group.
          setAt(index);
        }} />
    </div>
  );
}

function GroupMerge({ meta, group, canSkip, onSkip, onMerged }: {
  meta: ObjectMeta; group: DuplicateGroup; canSkip: boolean; onSkip: () => void; onMerged: (survivor: RecordData, merged: string[]) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const applyWrite = useApplyWrite();
  const objects = useObjects();
  const records = useMemo(() => mergeRecordsOf(group).map((r) => withNames(r, meta)), [group, meta]);
  const fields = useMemo(() => choosableFields(meta), [meta]);
  const [survivorId, setSurvivorId] = useState(() => defaultSurvivor(records));
  const [picks, setPicks] = useState<Record<string, string>>({});
  const survivor = records.find((r) => r.id === survivorId) ?? records[0]!;
  const duplicates = records.filter((r) => r.id !== survivor.id);
  const chosen = chosenFields(fields, survivor, duplicates, picks);
  const body = { survivor: survivor.id, duplicates: duplicates.map((d) => d.id), ...(Object.keys(chosen).length ? { fields: chosen } : {}) };
  const signature = JSON.stringify(body);
  const [preview, setPreview] = useState<{ answer: MergeAnswer; signature: string } | null>(null);
  // A preview answers for exactly the request it was made for: any change of survivor or choice puts it out of date.
  const current = preview && preview.signature === signature ? preview.answer : null;
  const [error, setError] = useState<unknown>(null);

  const rows = fields.filter((f) => records.some((r) => !isBlank(r[f.name])));
  const canMerge = meta.access.write && meta.access.archive;

  const previewMerge = useMutation({
    mutationFn: () => api.post<MergeAnswer>("/v1/ops/merge_records", { ...body, dry_run: true }),
    onMutate: () => setError(null),
    onSuccess: (answer) => setPreview({ answer, signature }),
    onError: (e) => {
      setPreview(null);
      setError(e);
    },
  });
  const merge = useMutation({
    mutationFn: () => api.post<MergeAnswer>("/v1/ops/merge_records", { ...body, dry_run: false, confirm_token: current?.confirm_token }),
    onMutate: () => setError(null),
    onSuccess: (done) => {
      for (const id of done.merged) applyWrite({ object: meta.name, id, removed: true });
      applyWrite({ object: meta.name, id: done.survivor.id, record: done.survivor, alsoObjects: [...new Set((done.references ?? []).map((r) => r.object))] });
      toast.toast({ tone: "success", title: `Merged ${done.merged.length + 1} ${meta.plural_label.toLowerCase()} into one`, description: done.survivor.display_name });
      onMerged(done.survivor, done.merged);
    },
    onError: (e) => {
      // The token is single-use and tied to the records as previewed: after a refusal, preview again.
      setPreview(null);
      setError(e);
    },
  });
  const objectLabel = (name: string) => objects.data?.find((o) => o.name === name)?.plural_label ?? name;
  const fieldOf = (name: string): FieldMeta | undefined => meta.fields.find((f) => f.name === name);

  return (
    <div className="flex flex-col gap-4">
      {group.records.length > MERGE_MAX_RECORDS ? (
        <p role="status" className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-muted">
          This group has {group.records.length} records. One merge takes at most {MERGE_MAX_RECORDS}, so the first {MERGE_MAX_RECORDS} are shown. Merge them, then run the check again for the rest.
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-line focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus" role="region" aria-label="Records to merge, field by field" tabIndex={0}>
        <table className="w-full table-fixed border-collapse text-base" style={{ minWidth: `${9 + records.length * 12}rem` }}>
          <thead>
            <tr className="bg-surface-2 text-left align-top">
              <th scope="col" className="w-36 px-3 py-2 text-sm font-medium text-muted">Keep value from</th>
              {records.map((r, i) => (
                <th key={r.id} scope="col" className="border-l border-line px-3 py-2 font-normal">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input type="radio" name="survivor" className="mt-1 accent-accent" checked={r.id === survivor.id} onChange={() => {
                      setSurvivorId(r.id);
                      setPicks({});
                    }} aria-label={`${letter(i)} survives`} />
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-1.5 font-medium">{letter(i)}{r.id === survivor.id ? <Badge tone="accent">Survivor</Badge> : null}</span>
                      <span className="block truncate text-sm text-muted"><bdi>{r.display_name || "(no name)"}</bdi></span>
                      {typeof r.created_at === "string" ? <span className="block text-sm text-subtle">Created {formatDateTime(r.created_at)}</span> : null}
                    </span>
                  </label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {rows.map((f) => {
              const differs = records.some((r) => !sameValue(r[f.name], records[0]![f.name]));
              const source = picks[f.name] ?? defaultSource(f, survivor, duplicates);
              return (
                <tr key={f.name}>
                  <th scope="row" className="px-3 py-2 text-left text-sm font-normal text-subtle">{f.label}</th>
                  {records.map((r, i) => (
                    <td key={r.id} className={`border-l border-line ${differs && source === r.id ? "bg-accent-soft" : ""}`}>
                      {differs ? (
                        <label className="flex min-h-9 cursor-pointer items-center gap-2 px-3 py-2">
                          <input type="radio" name={`field-${f.name}`} className="accent-accent" checked={source === r.id} aria-label={`${f.label}: keep the value from ${letter(i)}`}
                            onChange={() => setPicks((p) => ({ ...p, [f.name]: r.id }))} />
                          <span className="min-w-0 flex-1"><FieldValue field={f} value={r[f.name]} record={r} meta={meta} /></span>
                        </label>
                      ) : (
                        <div className="flex min-h-9 items-center px-3 py-2 text-muted"><FieldValue field={f} value={r[f.name]} record={r} meta={meta} /></div>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error ? <ProblemAlert error={error} /> : null}
      {current ? (
        <div className="rounded-md border border-line bg-surface-2 p-3 text-base">
          <p className="font-medium">What this merge will do</p>
          <p className="mt-1 text-muted">{letter(records.findIndex((r) => r.id === survivor.id))} survives; {current.merged.length === 1 ? "the other record is" : `the other ${current.merged.length} records are`} archived and point to it.</p>
          {current.changes?.length ? (
            <ul className="mt-2 flex flex-col gap-1">
              {current.changes.map((c) => {
                const f = fieldOf(c.field);
                return (
                  <li key={c.field} className="flex flex-wrap items-center gap-x-2 text-sm">
                    <span className="font-medium">{f?.label ?? c.field}</span>
                    <span className="text-muted">{f ? <FieldValue field={f} value={c.before} record={survivor} meta={meta} /> : String(c.before ?? "")}</span>
                    <span aria-hidden>→</span><span className="sr-only">becomes</span>
                    <span>{f ? <FieldValue field={f} value={c.after} record={survivor} meta={meta} /> : String(c.after ?? "")}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="mt-2 text-sm text-muted">No field values change.</p>}
          {current.references?.length ? (
            <>
              <p className="mt-3 text-sm font-medium">Linked records that move to the survivor</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
                {current.references.map((r) => (
                  <li key={`${r.object}.${r.field}`}>
                    {objectLabel(r.object)}: {r.field.replace(/_/g, " ")}, {[r.moved && `${r.moved} moved`, r.archived && `${r.archived} archived as copies`, r.dropped && `${r.dropped} dropped as copies`, r.cleared && `${r.cleared} cleared`].filter(Boolean).join(", ")}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {current.not_filled?.length ? (
            <>
              <p className="mt-3 text-sm font-medium">Left as they are</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
                {current.not_filled.map((n) => <li key={n.field}>{fieldOf(n.field)?.label ?? n.field}: {n.reason}</li>)}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2.5">
        <p className="flex min-w-[14rem] flex-1 items-start gap-2 text-sm text-muted">
          <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>A merge can't be undone. The other {duplicates.length === 1 ? "record is" : "records are"} archived and every record linked to {duplicates.length === 1 ? "it" : "them"} moves to the survivor.</span>
        </p>
        <Button size="sm" onClick={onSkip} disabled={!canSkip || merge.isPending}>Skip</Button>
        <Button size="sm" busy={previewMerge.isPending} disabled={!canMerge || merge.isPending} onClick={() => previewMerge.mutate()}>Preview merge</Button>
        <Button size="sm" variant="primary" busy={merge.isPending} disabled={!canMerge || !current?.confirm_token} onClick={() => merge.mutate()}><GitMerge /> Merge</Button>
      </div>
      {!canMerge ? <p className="text-sm text-muted">Your role can't merge {meta.plural_label.toLowerCase()}: that needs permission to change and archive them.</p> : null}
    </div>
  );
}
