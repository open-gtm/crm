import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowLeft, Check, GitMerge, Lock, Pencil, RotateCcw, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CopyButton, NoAccess, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent, Tooltip } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { ApiProblem, asProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, OpResult, RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";
import { useApplyWrite } from "@/lib/writes";
import { canWrite, includable, isRestrictedValue, keyFacts, readOnlyReason, toApiValue, toFormValue, validateValues, visibleFields, type FormValue } from "@/meta/fields";
import { useDescribe } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { FieldControl, FieldValue, RecordLink } from "@/meta/registry";
import { recordRoute } from "@/router";
import { applyServerErrors, bodyFrom, checkForm, RecordFields, useRecordForm } from "./RecordForm";
import { Files } from "./Files";
import { Notes } from "./Notes";
import { RelatedLists } from "./RelatedLists";
import { Timeline } from "./Timeline";

/** One record: its key facts, its fields (edited in place or all at once), the records that refer to it, and its timeline. */
export function RecordPage() {
  const { object, id } = recordRoute.useParams();
  const meta = useDescribe(object);
  if ((meta.error instanceof ApiProblem && meta.error.status === 403) || (meta.data && !meta.data.access.read)) {
    return <div className="p-6"><NoAccess title={meta.data ? `You don't have access to ${plainLabel(meta.data.plural_label).toLowerCase()}` : undefined} /></div>;
  }
  if (meta.error) return <div className="p-6"><ProblemView error={meta.error} onRetry={() => meta.refetch()} /></div>;
  if (!meta.data) return <RecordSkeleton />;
  return <RecordBody key={id} meta={meta.data} id={id} />;
}

function RecordSkeleton() {
  return (
    <div className="p-6" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-72" />
      <div className="mt-3 flex gap-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-5 w-24" />)}</div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_24rem]"><Skeleton className="h-80" /><Skeleton className="h-80" /></div>
    </div>
  );
}

export function useRecord(meta: ObjectMeta, id: string) {
  const api = useApi();
  const include = includable(meta);
  return useQuery({
    queryKey: qk.record(meta.name, id),
    queryFn: async ({ signal }) => (await api.get<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}`,
      include.length ? { include: include.join(",") } : undefined, signal)).data,
  });
}

function RecordBody({ meta, id }: { meta: ObjectMeta; id: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const navigate = useNavigate();
  const rec = useRecord(meta, id);
  const [editingAll, setEditingAll] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const refresh = () => {
    setConflict(false);
    void qc.invalidateQueries({ queryKey: qk.records(meta.name) });
    void qc.invalidateQueries({ queryKey: qk.timeline(id) });
  };
  const archive = useMutation({
    mutationFn: () => api.delete(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}`),
    onSuccess: () => {
      setArchiving(false);
      applyWrite({ object: meta.name, id, removed: true });
      toast.toast({ tone: "success", title: `${meta.label} archived`, description: rec.data?.display_name });
      void navigate({ to: "/o/$object", params: { object: meta.name }, search: {} });
    },
    onError: (e) => toast.error(e, "Couldn't archive"),
  });
  const restore = useMutation({
    mutationFn: () => api.post<{ data: RecordData; warnings?: string[] }>(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}/restore`),
    onSuccess: (r) => {
      setConflict(false);
      applyWrite({ object: meta.name, id, record: r.data });
      toast.toast({ tone: "success", title: `${meta.label} restored`, description: r.warnings?.join(" ") });
    },
    onError: (e) => toast.error(e, "Couldn't restore"),
  });

  if (rec.error) {
    return (
      <div className="p-6">
        <BackLink meta={meta} />
        <ProblemView error={rec.error} onRetry={() => rec.refetch()} className="mt-4" />
      </div>
    );
  }
  if (!rec.data) return <RecordSkeleton />;
  const r = rec.data;
  const archived = Boolean(r.archived_at);
  const mergedInto = typeof r.merged_into === "string" ? r.merged_into : null;

  /** Saves some fields; a stale version (412) shows the conflict banner. */
  const save = async (body: Record<string, unknown>) => {
    try {
      const res = await api.patch<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(meta.name)}/records/${encodeURIComponent(id)}`, body, { ifMatch: r.version });
      applyWrite({ object: meta.name, id, record: res.data });
      return res.data;
    } catch (e) {
      const p = asProblem(e);
      if (p.status === 412) setConflict(true);
      throw p;
    }
  };

  // Key facts (a status, money, the owner…) show once, in the header, where they can be edited too; the
  // field sections list the rest. A deal's stage has its own control there.
  const facts = keyFacts(meta).filter((f) => r[f.name] !== undefined && r[f.name] !== null && r[f.name] !== "");
  const headerFacts = facts.filter((f) => !(meta.name === "deal" && (f.name === "stage" || f.name === "status")));
  const inHeader = new Set([...headerFacts.map((f) => f.name), ...(meta.name === "deal" ? ["stage"] : [])]);
  const fields = visibleFields(meta).filter((f) => !inHeader.has(f.name));
  const standard = fields.filter((f) => f.standard);
  const custom = fields.filter((f) => !f.standard);
  return (
    <div className="pb-10">
      <div className="border-b border-line bg-surface px-4 pb-4 pt-3 md:px-6">
        <BackLink meta={meta} />
        <div className="mt-2 flex flex-wrap items-start gap-3">
          <div aria-hidden className="rounded-md bg-accent-soft p-2 text-accent-soft-fg"><ObjectIcon object={meta} className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-2xl font-semibold"><bdi>{r.display_name || "(no name)"}</bdi></h1>
            <p className="text-sm text-muted">{meta.label}{archived ? <> · <Badge tone="warning">Archived</Badge></> : null}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {meta.name === "lead" && !archived ? <ConvertLead meta={meta} record={r} /> : null}
            {meta.access.write && !archived ? <Button onClick={() => setEditingAll(true)}><Pencil /> Edit</Button> : null}
            {meta.access.archive && !archived ? <Button variant="danger-ghost" onClick={() => setArchiving(true)}><Archive /> Archive</Button> : null}
            {meta.access.archive && archived && !mergedInto ? <Button onClick={() => restore.mutate()} busy={restore.isPending}><RotateCcw /> Restore</Button> : null}
          </div>
        </div>
        {headerFacts.length || meta.name === "deal" ? (
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            {meta.name === "deal" && !archived ? <DealStage meta={meta} record={r} /> : null}
            {headerFacts.map((f) => <FieldRow key={f.name} field={f} meta={meta} record={r} save={save} readOnly={archived} compact />)}
          </dl>
        ) : null}
      </div>

      {mergedInto ? (
        <div role="status" className="mx-4 mt-4 flex items-center gap-2 rounded-md border border-info/40 bg-info-soft px-3 py-2 text-base text-info-fg md:mx-6">
          <GitMerge className="size-4" /> This record was merged into <RecordLink object={meta.name} id={mergedInto}>another {meta.label.toLowerCase()}</RecordLink>, which holds its data now.
        </div>
      ) : null}
      {conflict ? (
        <div role="alert" className="mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-base text-warning-fg md:mx-6">
          <span className="flex-1">Someone else changed this {meta.label.toLowerCase()} since you opened it, so your change wasn't saved. Reload to see their version, then make your change again.</span>
          <Button size="sm" onClick={refresh}><RotateCcw /> Reload</Button>
        </div>
      ) : null}

      <div className="grid gap-6 px-4 pt-5 md:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          <FieldSection title="Details" fields={standard.length ? standard : custom} meta={meta} record={r} save={save} readOnly={archived} />
          {standard.length && custom.length ? <FieldSection title="Custom fields" fields={custom} meta={meta} record={r} save={save} readOnly={archived} /> : null}
          <Notes recordId={id} />
          <Files recordId={id} canWrite={Boolean(meta.access.write) && !archived} />
          <RelatedLists object={meta.name} id={id} name={r.display_name ?? ""} />
          <SystemSection record={r} />
        </div>
        <div className="min-w-0"><Timeline recordId={id} /></div>
      </div>

      {editingAll ? <EditAllDialog meta={meta} record={r} onClose={() => setEditingAll(false)} save={save} /> : null}
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} danger busy={archive.isPending} confirmLabel={`Archive ${meta.label.toLowerCase()}`}
        title={`Archive ${r.display_name || "this record"}?`}
        description="It leaves lists and searches but isn't deleted: it can be restored from its page, and its history is kept."
        onConfirm={() => archive.mutate()} />
    </div>
  );
}

function BackLink({ meta }: { meta: ObjectMeta }) {
  return (
    <Link to="/o/$object" params={{ object: meta.name }} search={{}} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
      <ArrowLeft className="size-3.5" /> {meta.plural_label}
    </Link>
  );
}

function FieldSection({ title, fields, meta, record, save, readOnly }: {
  title: string; fields: FieldMeta[]; meta: ObjectMeta; record: RecordData; save: (b: Record<string, unknown>) => Promise<RecordData>; readOnly: boolean;
}) {
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-2.5 text-md font-semibold">{title}</h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2">
        {fields.map((f) => <FieldRow key={f.name} field={f} meta={meta} record={record} save={save} readOnly={readOnly} />)}
      </dl>
    </section>
  );
}

/** One field: its value, and when this member may change it, an in-place editor (Enter saves, Escape cancels). */
function FieldRow({ field, meta, record, save, readOnly, compact }: {
  field: FieldMeta; meta: ObjectMeta; record: RecordData; save: (b: Record<string, unknown>) => Promise<RecordData>; readOnly: boolean;
  /** A key fact in the record's header: label above, no row border. */
  compact?: boolean;
}) {
  const s = useSession();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<FormValue>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writable = !readOnly && canWrite(field, meta.access, "edit") && !isRestrictedValue(record[field.name]);
  const reason = readOnly ? null : readOnlyReason(field, meta.access, "edit");
  const wide = field.type === "long_text" || field.type === "multi_select" || field.type === "json" || field.type === "address";
  const start = () => {
    setValue(toFormValue(field, record[field.name]));
    setError(null);
    setEditing(true);
  };
  const commit = async () => {
    const v = toApiValue(field, value);
    const problem = validateValues([field], { [field.name]: v }, "edit")[field.name];
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await save({ [field.name]: v });
      setEditing(false);
    } catch (e) {
      const p = asProblem(e);
      if (p.status === 412) setEditing(false);
      else setError(p.fieldErrors[field.name] ? cap(p.fieldErrors[field.name]!) : p.detail);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("group min-w-0", compact ? "max-w-full" : "border-b border-line px-4 py-2.5 sm:[&:nth-last-child(-n+2)]:border-b-0", wide && !compact && "sm:col-span-2", compact && editing && "min-w-64")}>
      <dt className={cn("flex items-center gap-1", compact ? "text-xs font-medium uppercase tracking-wide text-subtle" : "text-sm text-muted")}>
        {field.label}
        {!writable && reason && meta.access.write ? (
          <Tooltip content={reason}><button type="button" aria-label={`${field.label} is read-only: ${reason}`} className="rounded-sm text-subtle"><Lock className="size-3" /></button></Tooltip>
        ) : null}
      </dt>
      <dd className="mt-0.5 min-h-6 text-base">
        {editing ? (
          // Escape anywhere in the editor cancels it, as in every other editor of the app.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <form onSubmit={(e) => {
            e.preventDefault();
            void commit();
          }} onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}>
            <FieldControl field={field} meta={meta} record={record} mode="edit" value={value} onChange={setValue} autoFocus invalid={Boolean(error)}
              me={{ id: s.member.id, name: s.member.name }} onCommit={() => void commit()} />
            {error ? <p role="alert" className="mt-1 text-sm text-danger-fg">{error}</p> : null}
            <div className="mt-1.5 flex gap-1.5">
              <Button size="sm" variant="primary" type="submit" busy={busy}><Check /> Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}><X /> Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1"><FieldValue field={field} value={record[field.name]} record={record} meta={meta} variant="full" /></div>
            {writable ? (
              <button type="button" onClick={start} aria-label={`Edit ${field.label}`}
                className="shrink-0 rounded-sm p-1 text-subtle opacity-0 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100">
                <Pencil className="size-3.5" />
              </button>
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function SystemSection({ record }: { record: RecordData }) {
  const rows: [string, ReactNode][] = [
    ["ID", <span key="id" className="flex items-center gap-2"><code className="font-mono text-sm">{record.id}</code><CopyButton text={record.id} label="Copy ID" size="icon-sm" /></span>],
    ["Created", formatDateTime(record.created_at)],
    ["Last updated", formatDateTime(record.updated_at)],
    ["Version", String(record.version ?? "")],
  ];
  if (record.archived_at) rows.push(["Archived", formatDateTime(record.archived_at)]);
  return (
    <section aria-label="Record information" className="rounded-lg border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-2.5 text-md font-semibold">Record</h2>
      <dl className="grid grid-cols-1 gap-x-4 px-4 py-2 sm:grid-cols-2">
        {rows.map(([k, v]) => <div key={k} className="py-1.5"><dt className="text-sm text-muted">{k}</dt><dd className="text-base">{v}</dd></div>)}
      </dl>
    </section>
  );
}

function EditAllDialog({ meta, record, onClose, save }: { meta: ObjectMeta; record: RecordData; onClose: () => void; save: (b: Record<string, unknown>) => Promise<RecordData> }) {
  const fields = visibleFields(meta).filter((f) => !isRestrictedValue(record[f.name]));
  const writable = fields.filter((f) => canWrite(f, meta.access, "edit"));
  const { form, initial } = useRecordForm(fields, record);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const submit = form.handleSubmit(async (values) => {
    const body = bodyFrom(writable, values, "edit", initial);
    if (!Object.keys(body).length) return onClose();
    if (!checkForm(form, writable, "edit", body)) return;
    setBusy(true);
    setFormError(null);
    try {
      await save(body);
      onClose();
    } catch (e) {
      const p = asProblem(e);
      if (p.status === 412) onClose();
      else setFormError(applyServerErrors(form, writable, p));
    } finally {
      setBusy(false);
    }
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Edit ${record.display_name || meta.label.toLowerCase()}`} size="lg"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="edit-record" busy={busy}>Save changes</Button></>}>
        <form id="edit-record" noValidate onSubmit={(e) => void submit(e)}>
          {formError ? <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{formError}</p> : null}
          <RecordFields form={form} fields={fields} meta={meta} mode="edit" record={record} />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A deal's stage, changed through the move_deal_stage operation (never a raw field write). */
function DealStage({ meta, record }: { meta: ObjectMeta; record: RecordData }) {
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
  if (!stageField || stageField.access === "none" || !pipeline) return null;
  const canMove = meta.access.write && stageField.access === "write";
  const current = pipeline.stages.find((s) => s.id === record.stage);
  const lostWritable = meta.fields.find((f) => f.name === "lost_reason")?.access === "write";
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-subtle">Stage{meta.pipelines && meta.pipelines.length > 1 ? ` · ${pipeline.name}` : ""}</dt>
      <dd className="mt-0.5">
        {canMove ? (
          <NativeSelect aria-label="Stage" className="h-7 w-auto min-w-40" value={record.stage as string} disabled={move.isPending} onChange={(e) => {
            const s = pipeline.stages.find((x) => x.id === e.target.value);
            if (!s) return;
            if (s.category === "lost" && lostWritable) setLost({ stage: s.id, reason: "" });
            else move.mutate({ stage: s.id });
          }}>
            {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </NativeSelect>
        ) : <Badge>{current?.name ?? "—"}</Badge>}
      </dd>
      <Dialog open={lost !== null} onOpenChange={(o) => !o && setLost(null)}>
        <DialogContent title="Mark as lost" size="sm" footer={<><Button onClick={() => setLost(null)}>Cancel</Button><Button variant="primary" busy={move.isPending} onClick={() => lost && move.mutate({ stage: lost.stage, ...(lost.reason.trim() ? { lost_reason: lost.reason.trim() } : {}) })}>Move</Button></>}>
          <FormField label="Why was it lost?" hint="Optional">{(p) => <Input {...p} autoFocus value={lost?.reason ?? ""} onChange={(e) => setLost((l) => l && { ...l, reason: e.target.value })} />}</FormField>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Converting a qualified lead into a deal, through the convert_lead operation. */
function ConvertLead({ meta, record }: { meta: ObjectMeta; record: RecordData }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const navigate = useNavigate();
  const status = meta.fields.find((f) => f.name === "status");
  const category = status?.values?.find((v) => v.key === record.status)?.category;
  const convert = useMutation({
    mutationFn: () => api.post<OpResult<{ deal: RecordData }>>("/v1/ops/convert_lead", { lead: record.id }),
    onSuccess: (r) => {
      // The lead changes status, and a deal (perhaps a contact and an account too) appears.
      applyWrite({ object: "lead", id: record.id, alsoObjects: ["deal", "contact", "account"], touched: [{ object: "deal", id: r.result.deal.id }] });
      toast.toast({ tone: "success", title: "Lead converted", description: r.result.deal.display_name });
      void navigate({ to: "/o/$object/$id", params: { object: "deal", id: r.result.deal.id } });
    },
    onError: (e) => toast.error(e, e instanceof ApiProblem && e.status === 403 ? "Your role can't convert leads" : "Couldn't convert the lead"),
  });
  if (category !== "qualified" || !meta.access.write) return null;
  return <Button variant="primary" onClick={() => convert.mutate()} busy={convert.isPending}><Sparkles /> Convert to deal</Button>;
}

