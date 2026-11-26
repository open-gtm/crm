import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { NoAccess, ProblemAlert, ProblemView } from "@/components/feedback";
import { Button, buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Badge, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { layoutKey, type LayoutChange, type LayoutDraft } from "@/features/record/pageLayout";
import { useApi } from "@/lib/api/context";
import { ApiProblem } from "@/lib/api/problem";
import type { RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { includable } from "@/meta/fields";
import { useDescribe, useDescribes, useObjects } from "@/meta/hooks";
import { AgentBanner } from "./AgentBanner";
import { Canvas } from "./Canvas";
import { CodeTab } from "./CodeTab";
import { draftKey, layoutPath, useActorNames, useDraft, useRolePreview } from "./data";
import { HistoryTab } from "./HistoryTab";
import { Library } from "./Library";
import { draftStatus, HEADER_KEY, relationOptions, unreviewedAgentChange, type Env, type EditorCtx, type RolePreview } from "./model";
import { Properties } from "./Properties";
import { PublishDialog, type PublishResult } from "./PublishDialog";
import { useLayoutEditing } from "./useLayoutEditing";

/**
 * The record page layout editor (ADR 0017): `/o/{object}/customize`, optionally `?record=<id>` to show the
 * page as that record has it. People and agents edit one shared draft here; publishing is a separate, previewed step.
 */
export function LayoutEditorPage() {
  const { object } = useParams({ strict: false }) as { object?: string };
  const { record } = useSearch({ strict: false }) as { record?: string };
  const session = useSession();
  if (!object) return null;
  if (!session.can("schema:manage")) {
    return <div className="p-6"><NoAccess title="You can't customize this page">Changing how a record page is arranged needs permission to manage the schema. Ask a workspace admin.</NoAccess></div>;
  }
  return <Editor key={object} object={object} recordId={record} />;
}

/** The record the page is shown with. It shares the record page's cache entry, so opening it from there costs nothing. */
function useShownRecord(object: string, id: string | undefined, include: string[]) {
  const api = useApi();
  return useQuery({
    queryKey: qk.record(object, id ?? ""), enabled: Boolean(id), retry: false,
    queryFn: async ({ signal }) => (await api.get<{ data: RecordData }>(`/v1/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(id!)}`,
      include.length ? { include: include.join(",") } : undefined, signal)).data,
  });
}

function Editor({ object, recordId }: { object: string; recordId: string | undefined }) {
  const meta = useDescribe(object);
  const objects = useObjects();
  const readable = (objects.data ?? []).filter((o) => o.access.read).map((o) => o.name);
  const describes = useDescribes(readable);
  const draft = useDraft(object, true);
  const record = useShownRecord(object, recordId, meta.data ? includable(meta.data) : []);

  if ((meta.error instanceof ApiProblem && meta.error.status === 403) || (meta.data && !meta.data.access.read)) {
    return <div className="p-6"><NoAccess title="You don't have access to this object" /></div>;
  }
  if (meta.error) return <div className="p-6"><ProblemView error={meta.error} onRetry={() => meta.refetch()} /></div>;
  if (draft.error && !draft.data) return <div className="p-6"><ProblemView error={draft.error} onRetry={() => draft.refetch()} /></div>;
  if (!meta.data || !draft.data) {
    return <div className="p-6" aria-busy="true" aria-label="Loading"><Skeleton className="h-7 w-72" /><Skeleton className="mt-6 h-96" /></div>;
  }
  const env: Env = {
    meta: meta.data, objects: objects.data ?? [],
    relations: relationOptions(object, describes.map((q) => q.data)),
  };
  return <Loaded env={env} draft={draft.data} recordId={recordId} record={recordId ? record.data : undefined} recordFailed={Boolean(recordId) && record.isError} />;
}

function Loaded({ env, draft, recordId, record, recordFailed }: { env: Env; draft: LayoutDraft; recordId: string | undefined; record: RecordData | undefined; recordFailed: boolean }) {
  const object = env.meta.name;
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const actorName = useActorNames();
  const editing = useLayoutEditing(object, draft, actorName);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState("props");
  const [discarding, setDiscarding] = useState(false);
  const [publishing, setPublishing] = useState<PublishResult | null>(null);
  const [role, setRole] = useState("");
  const rolePreview = useRolePreview(role || null);

  const doc = editing.doc ?? draft.layout;
  const valid = selected === HEADER_KEY || (selected !== null && [...doc.top, ...doc.columns.left, ...doc.columns.main, ...doc.columns.right].some((c) => c.id === selected));
  const chosen = rolePreview.roles?.find((r) => r.key === role);
  const preview: RolePreview | null = useMemo(() => {
    const access = rolePreview.access.data;
    if (!chosen || !access) return null;
    const row = access.objects.find((o) => o.object === object);
    const hiddenFields = new Set<string>([
      ...Object.entries(row?.fields ?? {}).filter(([, a]) => a === "none").map(([n]) => n),
      ...(row?.restricted_fields ?? []).filter((r) => r.values !== "visible").map((r) => r.field),
    ]);
    return { roleName: chosen.name, hiddenFields, hiddenObjects: new Set(access.objects.filter((o) => !o.read).map((o) => o.object)) };
  }, [chosen, rolePreview.access.data, object]);

  const ctx: EditorCtx = {
    env, doc, edit: editing.edit, selected: valid ? selected : null, record, preview,
    select: (id) => {
      setSelected(id);
      if (id) setTab("props");
    },
  };

  const refreshed = (d: LayoutDraft) => {
    editing.reset();
    qc.setQueryData(draftKey(object), d);
    void qc.invalidateQueries({ queryKey: draftKey(object) });
  };
  const discard = useMutation({
    mutationFn: () => api.delete<{ data: LayoutDraft }>(layoutPath(object, "/draft")),
    onSuccess: (r) => {
      setDiscarding(false);
      refreshed(r.data);
      toast.toast({ tone: "success", title: "Draft discarded" });
    },
    onError: (e) => {
      setDiscarding(false);
      toast.error(e, "Couldn't discard the draft");
    },
  });
  const undo = useMutation({
    mutationFn: (change: LayoutChange) => api.post<{ data: LayoutDraft }>(layoutPath(object, "/draft/undo"), { change: change.id }),
    onSuccess: (r) => refreshed(r.data),
    onError: (e) => toast.error(e, "Couldn't undo that change"),
  });
  const keep = useMutation({
    mutationFn: (change: LayoutChange) => api.post<{ data: LayoutDraft }>(layoutPath(object, "/draft/review"), { change: change.id }),
    onSuccess: (r) => refreshed(r.data),
    onError: (e) => toast.error(e, "Couldn't mark that change as kept"),
  });
  const dryPublish = useMutation({
    mutationFn: () => api.post<{ data: PublishResult }>(layoutPath(object, "/publish"), { dry_run: true, revision: draft.revision }),
    onSuccess: (r) => setPublishing(r.data),
    onError: (e) => toast.error(e, "Couldn't preview publishing"),
  });

  const agentChange = unreviewedAgentChange(draft);
  const hasDraft = draft.has_draft;
  const busy = editing.saving;
  const mayPreview = rolePreview.roles && rolePreview.roles.length > 0 && !rolePreview.rolesError;

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-surface px-4 py-2.5 md:px-5">
        <Link {...(recordId ? { to: "/o/$object/$id" as const, params: { object, id: recordId } } : { to: "/settings/schema/$schemaObject" as const, params: { schemaObject: object } })}
          className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label={recordId ? "Back to the record" : `Back to the ${env.meta.label} schema`}>
          <ArrowLeft />
        </Link>
        <div className="min-w-0 flex-[1_1_12rem] leading-tight">
          <h1 className="truncate text-md font-semibold">Customize the <bdi>{env.meta.label}</bdi> page</h1>
          {recordId ? (
            <p className="truncate text-sm text-subtle">{record ? <>Shown with <bdi>{record.display_name || "this record"}</bdi></> : recordFailed ? "That record couldn't be loaded, so only labels are shown" : "Loading the record…"}</p>
          ) : <p className="truncate text-sm text-subtle">Showing field labels only. Open this from a record to see its values.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={hasDraft ? "warning" : "neutral"} className="h-6 text-sm">{draftStatus(draft)}</Badge>
          <span className="text-sm text-subtle" role="status">{busy ? "Saving…" : ""}</span>
          {mayPreview ? (
            <label className="inline-flex items-center gap-1.5 text-sm text-muted">Preview as
              <NativeSelect aria-label="Preview as role" className="h-7 w-auto text-sm" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">As me</option>
                {rolePreview.roles!.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </NativeSelect>
            </label>
          ) : null}
          <Button disabled={!hasDraft || busy} onClick={() => setDiscarding(true)}>Discard draft</Button>
          <Button variant="primary" disabled={!hasDraft || busy} busy={dryPublish.isPending} onClick={() => dryPublish.mutate()}>Publish to everyone</Button>
        </div>
      </div>

      {editing.conflict ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning-soft px-4 py-2.5 text-base text-warning-fg md:px-5">
          <span className="min-w-0 flex-1">{editing.conflict}</span>
          <Button size="sm" onClick={editing.dismissConflict}>Dismiss</Button>
        </div>
      ) : null}
      {role && rolePreview.access.error ? <div className="border-b border-line px-4 py-2 md:px-5"><ProblemAlert error={rolePreview.access.error} /></div> : null}
      {agentChange ? (
        <AgentBanner change={agentChange} actorName={actorName} busy={keep.isPending || undo.isPending} onKeep={() => keep.mutate(agentChange)} onUndo={() => undo.mutate(agentChange)} />
      ) : null}

      <div className="flex flex-1 flex-wrap items-stretch">
        <aside aria-label="Components and fields" className="flex flex-[1_1_15rem] flex-col border-line bg-bg p-3 md:max-w-72 md:border-r">
          <Library ctx={ctx} />
        </aside>
        <main className="flex min-w-0 flex-[999_1_30rem] flex-col bg-surface-2 p-4 md:p-5">
          <Canvas ctx={ctx} />
        </main>
        <aside aria-label="Properties, code and history" className={cn("flex flex-[1_1_20rem] flex-col border-line bg-surface md:max-w-96 md:border-l")}>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList label="Editor panel" className="px-2">
              <TabsTrigger value="props">Properties</TabsTrigger>
              <TabsTrigger value="code">As code</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="props"><Properties ctx={ctx} /></TabsContent>
            <TabsContent value="code"><CodeTab ctx={ctx} /></TabsContent>
            <TabsContent value="history">
              <HistoryTab object={object} draft={draft} actorName={actorName} undoing={undo.isPending} onUndo={(c) => undo.mutate(c)} />
            </TabsContent>
          </Tabs>
        </aside>
      </div>

      <ConfirmDialog open={discarding} onOpenChange={setDiscarding} busy={discard.isPending} danger confirmLabel="Discard draft" title="Discard the draft?"
        description="Everything changed in this draft, by you and by agents, is thrown away. The published page stays as it is." onConfirm={() => discard.mutate()} />
      {publishing ? (
        <PublishDialog object={object} objectLabel={env.meta.label} revision={draft.revision} preview={publishing} onClose={() => setPublishing(null)}
          onPublished={(r) => {
            setPublishing(null);
            editing.reset();
            setSelected(null);
            void qc.invalidateQueries({ queryKey: layoutKey(object) });
            toast.toast({ tone: "success", title: `Published version ${r.version}`, description: "Every record page now shows it." });
          }} />
      ) : null}
    </div>
  );
}
