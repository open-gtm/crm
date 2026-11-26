import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowLeft, Check, GitMerge, LayoutTemplate, Pencil, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { NoAccess, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { ApiProblem, asProblem } from "@/lib/api/problem";
import type { ObjectMeta, OpResult, RecordData } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";
import { useApplyWrite } from "@/lib/writes";
import { canWrite, includable, isRestrictedValue, visibleFields } from "@/meta/fields";
import { useDescribe } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { RecordLink } from "@/meta/registry";
import { recordRoute } from "@/router";
import { applyServerErrors, bodyFrom, checkForm, RecordFields, useRecordForm } from "./RecordForm";
import { FieldRow } from "./FieldRow";
import { hasComponent, headerFactFields, usePageLayout } from "./pageLayout";
import { PageBody } from "./PageBody";
import { DealStage } from "./StagePath";

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
  const layout = usePageLayout(meta.name);
  const s = useSession();
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
  // field sections list the rest. The layout can name the facts; otherwise they are picked automatically.
  const doc = layout.data?.layout;
  // A deal's stage has its own control: a stage path when the layout has one, else a select in the header.
  const stagePath = hasComponent(doc, "stage_path");
  const stageInHeader = meta.name === "deal" && !stagePath && !archived;
  const facts = headerFactFields(meta, r, doc);
  const headerFacts = doc?.header.key_facts ? facts.filter((f) => !(meta.name === "deal" && f.name === "stage" && !stagePath))
    : facts.filter((f) => !(meta.name === "deal" && (f.name === "stage" || f.name === "status")));
  const inHeader = new Set([...headerFacts.map((f) => f.name), ...(meta.name === "deal" ? ["stage"] : [])]);
  const fields = visibleFields(meta).filter((f) => !inHeader.has(f.name));
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
            {s.can("schema:manage") ? (
              <Button asChild variant="subtle">
                <Link to="/o/$object/customize" params={{ object: meta.name }} search={{ record: id }}><LayoutTemplate /> Customize page</Link>
              </Button>
            ) : null}
            {meta.name === "lead" && !archived ? <ConvertLead meta={meta} record={r} /> : null}
            {meta.name === "quote" && !archived ? <QuoteActions meta={meta} record={r} /> : null}
            {meta.access.write && !archived ? <Button onClick={() => setEditingAll(true)}><Pencil /> Edit</Button> : null}
            {meta.access.archive && !archived ? <Button variant="danger-ghost" onClick={() => setArchiving(true)}><Archive /> Archive</Button> : null}
            {meta.access.archive && archived && !mergedInto ? <Button onClick={() => restore.mutate()} busy={restore.isPending}><RotateCcw /> Restore</Button> : null}
          </div>
        </div>
        {headerFacts.length || stageInHeader ? (
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            {stageInHeader ? <DealStage meta={meta} record={r} /> : null}
            {headerFacts.map((f) => <FieldRow key={f.name} field={f} meta={meta} record={r} save={save} readOnly={archived || (meta.name === "deal" && f.name === "stage")} compact />)}
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

      <PageBody meta={meta} record={r} fields={fields} layout={layout.data} save={save} archived={archived} />

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

/**
 * What a quote can do next, through its operations (never a raw status write): a draft is sent, a sent
 * quote is accepted (which makes its order) or revised, and a rejected or expired one is revised.
 * Sending and accepting can't be undone, so each asks first and says what it will do.
 */
function QuoteActions({ meta, record }: { meta: ObjectMeta; record: RecordData }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const navigate = useNavigate();
  const [asking, setAsking] = useState<"send" | "accept" | null>(null);
  const status = meta.fields.find((f) => f.name === "status");
  const category = status?.values?.find((v) => v.key === record.status)?.category;
  const run = useMutation({
    mutationFn: (op: "send" | "accept" | "revise") => api.post<OpResult<RecordData & { order?: RecordData; quote?: RecordData }>>(`/v1/ops/${op}_quote`, { quote: record.id })
      .then((r) => ({ op, result: r.result })),
    onSuccess: ({ op, result }) => {
      setAsking(null);
      applyWrite({ object: "quote", id: record.id, alsoObjects: ["order", "deal", "quote_line_item"] });
      if (op === "accept" && result.order) {
        toast.toast({ tone: "success", title: "Quote accepted", description: `Order ${String(result.order.number ?? "")} was made from it.` });
        void navigate({ to: "/o/$object/$id", params: { object: "order", id: result.order.id } });
      } else if (op === "revise") {
        toast.toast({ tone: "success", title: "New version made", description: `${String(result.number ?? "")} is a draft with the same lines.` });
        void navigate({ to: "/o/$object/$id", params: { object: "quote", id: result.id } });
      } else toast.toast({ tone: "success", title: "Quote sent" });
    },
    onError: (e) => {
      setAsking(null);
      toast.error(e, "Couldn't change the quote");
    },
  });
  if (!meta.access.write || status?.access !== "write" || !category) return null;
  return (
    <>
      {category === "draft" ? <Button variant="primary" onClick={() => setAsking("send")}><Check /> Send quote</Button> : null}
      {category === "sent" ? <Button variant="primary" onClick={() => setAsking("accept")}><Check /> Accept</Button> : null}
      {["sent", "rejected", "expired"].includes(category) ? <Button onClick={() => run.mutate("revise")} busy={run.isPending && run.variables === "revise"}><Pencil /> Revise</Button> : null}
      <ConfirmDialog open={asking === "send"} onOpenChange={(o) => !o && setAsking(null)} busy={run.isPending} confirmLabel="Send quote"
        title={`Send ${String(record.number ?? "this quote")}?`}
        description="Once sent, its lines, amounts and terms can't be changed. To change them later, revise it: that makes a new version. Sending records the quote as sent; it doesn't email it."
        onConfirm={() => run.mutate("send")} />
      <ConfirmDialog open={asking === "accept"} onOpenChange={(o) => !o && setAsking(null)} busy={run.isPending} confirmLabel="Accept and make the order"
        title={`Accept ${String(record.number ?? "this quote")}?`}
        description="This makes an order with the quote's lines, closes the deal's other open quotes and, unless your workspace turned that off, marks the deal won. It can't be undone."
        onConfirm={() => run.mutate("accept")} />
    </>
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

