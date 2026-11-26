import { useMutation } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, OpResult, RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { useApplyWrite } from "@/lib/writes";
import { allowedStatuses, canWrite, isRestrictedValue, optionLabel } from "@/meta/fields";
import type { SaveFields } from "./FieldRow";

/**
 * A deal's stage move, through the move_deal_stage operation (never a raw field write). Choosing a lost
 * stage first asks why, when this member may set the lost reason. Shared by the header's select and the
 * stage path, so both make the same call with the same checks.
 */
function useDealMove(meta: ObjectMeta, record: RecordData) {
  const api = useApi();
  const toast = useToast();
  const applyWrite = useApplyWrite();
  const stageField = meta.fields.find((f) => f.name === "stage");
  const pipeline = meta.pipelines?.find((p) => p.id === record.pipeline) ?? meta.pipelines?.find((p) => p.is_default);
  const [lost, setLost] = useState<{ stage: string; reason: string } | null>(null);
  const move = useMutation({
    mutationFn: (b: { stage: string; lost_reason?: string }) => api.post<OpResult<RecordData | null>>("/v1/ops/move_deal_stage", { deal: record.id, ...b }),
    onSuccess: (r) => {
      setLost(null);
      applyWrite({ object: "deal", id: record.id, ...(r.result ? { record: r.result } : {}) });
      toast.toast({ tone: "success", title: "Stage changed" });
    },
    onError: (e) => toast.error(e, "Couldn't move the deal"),
  });
  const lostWritable = meta.fields.find((f) => f.name === "lost_reason")?.access === "write";
  const usable = Boolean(stageField && stageField.access !== "none" && pipeline);
  const canMove = usable && meta.access.write && stageField?.access === "write";
  const choose = (stageId: string) => {
    const s = pipeline?.stages.find((x) => x.id === stageId);
    if (!s) return;
    if (s.category === "lost" && lostWritable) setLost({ stage: s.id, reason: "" });
    else move.mutate({ stage: s.id });
  };
  const dialog = (
    <Dialog open={lost !== null} onOpenChange={(o) => !o && setLost(null)}>
      <DialogContent title="Mark as lost" size="sm" footer={<><Button onClick={() => setLost(null)}>Cancel</Button><Button variant="primary" busy={move.isPending} onClick={() => lost && move.mutate({ stage: lost.stage, ...(lost.reason.trim() ? { lost_reason: lost.reason.trim() } : {}) })}>Move</Button></>}>
        <FormField label="Why was it lost?" hint="Optional">{(p) => <Input {...p} autoFocus value={lost?.reason ?? ""} onChange={(e) => setLost((l) => l && { ...l, reason: e.target.value })} />}</FormField>
      </DialogContent>
    </Dialog>
  );
  return { stageField, pipeline, usable, canMove, choose, pending: move.isPending, dialog };
}

/** A deal's stage in the header: a select that moves it. A page layout with a stage path takes this over. */
export function DealStage({ meta, record }: { meta: ObjectMeta; record: RecordData }) {
  const { pipeline, usable, canMove, choose, pending, dialog } = useDealMove(meta, record);
  if (!usable || !pipeline) return null;
  const current = pipeline.stages.find((s) => s.id === record.stage);
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Stage{meta.pipelines && meta.pipelines.length > 1 ? ` · ${pipeline.name}` : ""}</dt>
      <dd className="mt-0.5">
        {canMove ? (
          <NativeSelect aria-label="Stage" className="h-7 w-auto min-w-40" value={record.stage as string} disabled={pending} onChange={(e) => choose(e.target.value)}>
            {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </NativeSelect>
        ) : <Badge>{current?.name ?? "—"}</Badge>}
      </dd>
      {dialog}
    </div>
  );
}

interface Step { key: string; label: string; state: "done" | "current" | "todo"; category?: string; disabled: boolean }

/** The steps as buttons in one group, the current one marked; won and lost read from the stage's category. */
function Stepper({ label, steps, onPick, busy, note }: { label: string; steps: Step[]; onPick: (key: string) => void; busy: boolean; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div role="group" aria-label={label} className="flex gap-0.5 overflow-x-auto">
        {steps.map((s) => {
          const tone = s.state === "current"
            ? s.category === "won" ? "bg-success-soft text-success-fg" : s.category === "lost" ? "bg-danger-soft text-danger-fg" : "bg-accent text-accent-fg"
            : s.state === "done" ? "bg-accent-soft text-accent-soft-fg" : "bg-surface-3 text-muted hover:text-fg";
          return (
            <button key={s.key} type="button" disabled={s.disabled || busy} aria-current={s.state === "current" ? "step" : undefined} onClick={() => onPick(s.key)}
              className={cn("press flex h-9 min-w-0 flex-1 basis-0 items-center justify-center gap-1.5 whitespace-nowrap px-2.5 text-base font-medium first:rounded-l-lg last:rounded-r-lg pointer-coarse:h-11",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-default", tone,
                s.disabled && s.state !== "current" && "opacity-60")}>
              {s.state === "done" || (s.state === "current" && s.category === "won") ? <Check aria-hidden className="size-3.5 shrink-0" /> : null}
              {s.state === "current" && s.category === "lost" ? <X aria-hidden className="size-3.5 shrink-0" /> : null}
              <span className="truncate">{s.label}</span>
              {s.state === "current" && (s.category === "won" || s.category === "lost") ? <span className="sr-only">({s.category})</span> : null}
            </button>
          );
        })}
      </div>
      {note}
    </div>
  );
}

const DAY = 86_400_000;

/** How long a deal has been in its stage, from the deal's own `stage_entered_at` (shown only when this member can read it). */
function stageAge(meta: ObjectMeta, record: RecordData, now = Date.now()): string | null {
  const f = meta.fields.find((x) => x.name === "stage_entered_at");
  const at = typeof record.stage_entered_at === "string" ? Date.parse(record.stage_entered_at) : NaN;
  if (!f || f.access === "none" || Number.isNaN(at)) return null;
  const days = Math.max(0, Math.floor((now - at) / DAY));
  return days === 0 ? "In this stage for less than a day" : `In this stage for ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * A stage path: the stages of a deal's pipeline (`field` null), or the values of a status or select field, as
 * steps. Choosing a step moves the record the way the page's other controls do. Read-only when the member
 * can't change it or the record is archived.
 */
export function StagePath({ meta, record, field, save, readOnly }: { meta: ObjectMeta; record: RecordData; field: string | null; save: SaveFields; readOnly: boolean }) {
  if (field === null) return meta.name === "deal" ? <DealPath meta={meta} record={record} readOnly={readOnly} /> : null;
  const f = meta.fields.find((x) => x.name === field);
  return f && f.access !== "none" && f.values?.length ? <FieldPath meta={meta} record={record} field={f} save={save} readOnly={readOnly} /> : null;
}

function DealPath({ meta, record, readOnly }: { meta: ObjectMeta; record: RecordData; readOnly: boolean }) {
  const { pipeline, usable, canMove, choose, pending, dialog } = useDealMove(meta, record);
  if (!usable || !pipeline) return null;
  const at = pipeline.stages.findIndex((s) => s.id === record.stage);
  const open = canMove && !readOnly;
  const steps: Step[] = pipeline.stages.map((s, i) => ({ key: s.id, label: s.name, category: s.category, disabled: !open,
    state: i === at ? "current" : i < at && pipeline.stages[at]?.category === "open" ? "done" : "todo" }));
  const age = stageAge(meta, record);
  return (
    <>
      <Stepper label={`Stage${meta.pipelines && meta.pipelines.length > 1 ? ` · ${pipeline.name}` : ""}`} steps={steps} busy={pending} onPick={(k) => k !== record.stage && choose(k)}
        note={age ? <p className="text-sm text-subtle">{age}</p> : null} />
      {dialog}
    </>
  );
}

function FieldPath({ meta, record, field, save, readOnly }: { meta: ObjectMeta; record: RecordData; field: FieldMeta; save: SaveFields; readOnly: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const values = field.values ?? [];
  const current = typeof record[field.name] === "string" ? (record[field.name] as string) : null;
  const at = values.findIndex((v) => v.key === current);
  const open = !readOnly && canWrite(field, meta.access, "edit") && !isRestrictedValue(record[field.name]);
  // Only the moves the field's own rules allow; operation-only values are never offered.
  const allowed = new Set(allowedStatuses(field, current));
  const steps: Step[] = values.map((v, i) => ({ key: v.key, label: optionLabel(field, v.key), category: v.category, disabled: !open || !allowed.has(v.key),
    state: i === at ? "current" : i < at ? "done" : "todo" }));
  const pick = async (key: string) => {
    if (key === current) return;
    setBusy(true);
    try {
      await save({ [field.name]: key });
    } catch (e) {
      // A stale version already shows the page's conflict banner.
      if (asProblem(e).status !== 412) toast.error(e, `Couldn't change ${field.label.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  };
  return <Stepper label={field.label} steps={steps} busy={busy} onPick={(k) => void pick(k)} />;
}
