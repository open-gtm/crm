import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, NativeSelect } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { ObjectMeta } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { useApplyWrite } from "@/lib/writes";
import { canWrite, toApiValue, toFormValue, validateValues, visibleFields, type FormValue } from "@/meta/fields";
import { FieldControl } from "@/meta/registry";

interface BulkRow { id?: string; action: string; reason?: string; error?: string; message?: string }
interface BulkResult { dry_run: boolean; count: number; counts: Record<string, number>; rows: BulkRow[]; confirm_token?: string }

/**
 * Archive selected records, or set one field on all of them. Always a dry run first (what each record
 * would do, nothing changed), then the real run with the dry run's single-use confirmation token.
 */
export function BulkDialog({ meta, ids, mode, initialField, onClose, onDone }: {
  meta: ObjectMeta; ids: string[]; mode: "archive" | "update"; onClose: () => void; onDone: () => void;
  /** The field to start on (the "Assign owner" shortcut starts on the owner). */
  initialField?: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const s = useSession();
  const fields = visibleFields(meta).filter((f) => canWrite(f, meta.access, "edit") && f.relation?.cardinality !== "many_to_many");
  const [fieldName, setFieldName] = useState(fields.find((f) => f.name === initialField)?.name ?? fields[0]?.name ?? "");
  const field = fields.find((f) => f.name === fieldName);
  const [value, setValue] = useState<FormValue>(field ? toFormValue(field, null) : null);
  const [stage, setStage] = useState<"edit" | "preview">(mode === "archive" ? "preview" : "edit");
  const [error, setError] = useState<string | null>(null);
  const path = `/v1/objects/${encodeURIComponent(meta.name)}/records/${mode === "archive" ? "bulk_archive" : "bulk_update"}`;
  const body = mode === "archive" ? { ids } : { ids, values: field ? { [field.name]: toApiValue(field, value) } : {} };
  const preview = useQuery({
    queryKey: ["bulk-preview", path, JSON.stringify(body)],
    queryFn: () => api.post<BulkResult>(path, { ...body, dry_run: true }),
    enabled: stage === "preview",
    retry: false,
    gcTime: 0,
  });
  const run = useMutation({
    mutationFn: () => api.post<BulkResult>(path, { ...body, dry_run: false, ...(preview.data?.confirm_token ? { confirm_token: preview.data.confirm_token } : {}) }),
    onSuccess: (r) => {
      for (const id of ids) {
        if (mode === "archive") applyWrite({ object: meta.name, id, removed: true });
        else void qc.invalidateQueries({ queryKey: qk.record(meta.name, id) });
      }
      applyWrite({ object: meta.name });
      const n = r.counts[mode] ?? r.count;
      toast.toast({ tone: "success", title: mode === "archive" ? `Archived ${n} ${n === 1 ? meta.label.toLowerCase() : meta.plural_label.toLowerCase()}` : `Updated ${n} ${n === 1 ? meta.label.toLowerCase() : meta.plural_label.toLowerCase()}` });
      onDone();
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  const failed = (preview.data?.rows ?? []).filter((r) => r.action === "error");
  const n = preview.data?.counts[mode] ?? 0;
  const title = mode === "archive" ? `Archive ${ids.length} selected` : initialField === "owner" && fieldName === "owner" ? `Assign owner to ${ids.length} selected` : `Change ${ids.length} selected`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title} size="md"
        footer={stage === "edit" ? (
          <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!field} onClick={() => {
            const problems = field ? validateValues([field], { [field.name]: toApiValue(field, value) }, "edit") : {};
            if (field && problems[field.name]) setError(problems[field.name]!);
            else {
              setError(null);
              setStage("preview");
            }
          }}>Preview</Button></>
        ) : (
          <><Button onClick={mode === "update" ? () => setStage("edit") : onClose}>{mode === "update" ? "Back" : "Cancel"}</Button>
            <Button variant={mode === "archive" ? "danger" : "primary"} busy={run.isPending} disabled={!preview.data || failed.length > 0 || n === 0} onClick={() => run.mutate()}>
              {mode === "archive" ? `Archive ${n}` : `Update ${n}`}
            </Button></>
        )}>
        {stage === "edit" && field ? (
          <div className="flex flex-col gap-4">
            <FormField label="Field">{(p) => (
              <NativeSelect {...p} value={fieldName} onChange={(e) => {
                setFieldName(e.target.value);
                const f = fields.find((x) => x.name === e.target.value);
                setValue(f ? toFormValue(f, null) : null);
              }}>{fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}</NativeSelect>
            )}</FormField>
            <FormField label="New value" hint="Leave empty to clear the field." error={error}>{(p) => (
              <FieldControl field={field} meta={meta} mode="edit" value={value} onChange={setValue} id={p.id} describedBy={p["aria-describedby"]} me={{ id: s.member.id, name: s.member.name }} />
            )}</FormField>
          </div>
        ) : null}
        {stage === "edit" && !field ? <p className="text-base text-muted">There is no field your role can change on {meta.plural_label.toLowerCase()}.</p> : null}
        {stage === "preview" ? (
          preview.isPending ? <div className="flex flex-col gap-2" aria-busy="true"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
            : preview.error ? <ProblemView error={preview.error} onRetry={() => preview.refetch()} />
            : (
              <div className="flex flex-col gap-3 text-base">
                <p>{mode === "archive" ? "Archiving" : "Updating"} <strong>{n}</strong> of {ids.length} record{ids.length === 1 ? "" : "s"}.{(preview.data.counts.skip ?? 0) > 0 ? ` ${preview.data.counts.skip} will be skipped (no change needed).` : ""}</p>
                {mode === "archive" ? <p className="text-muted">Archived records leave lists and searches. They can be restored from the record page.</p> : null}
                {failed.length ? (
                  <div role="alert" className="rounded-md border border-danger/40 bg-danger-soft p-3 text-danger-fg">
                    <p className="font-medium">{failed.length} record{failed.length === 1 ? "" : "s"} would fail, so nothing can be changed:</p>
                    <ul className="mt-1 list-disc pl-5 text-sm">{failed.slice(0, 5).map((r, i) => <li key={i}>{r.error ?? r.message ?? r.reason ?? "refused"}</li>)}</ul>
                  </div>
                ) : null}
                {error ? <p role="alert" className="text-danger-fg">{error}</p> : null}
              </div>
            )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
