import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { ProblemAlert, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Badge, Skeleton, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { Automation } from "@/lib/api/types";
import { DocsLink } from "@/lib/docs";
import { pluralize } from "@/lib/format";
import { useAdmin } from "../SettingsLayout";
import { AutomationEditor } from "./AutomationEditor";
import { RunsTab } from "./RunsTab";
import { needsRecord } from "./TestPanel";
import { describeTrigger, SHOWN_LABEL, SHOWN_TONE, shownStatus, type QueuedRun } from "./model";

/** A new automation: the editor with nothing in it. */
export function NewAutomation() {
  return (
    <div className="max-w-6xl">
      <Link to="/settings/automations" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Automations</Link>
      <h2 className="mb-3 text-lg font-semibold">New automation</h2>
      <AutomationEditor />
    </div>
  );
}

/** One automation: pause and resume, run now, archive, the editor and its runs. */
export function AutomationDetail() {
  const { automationId } = useParams({ strict: false }) as { automationId?: string };
  const id = automationId ?? "";
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const q = useAdmin<{ data: Automation }>(["automation", id], `/v1/automations/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState("editor");
  const [running, setRunning] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const toggle = useMutation({
    mutationFn: (pause: boolean) => api.post<{ data: Automation }>(`/v1/automations/${encodeURIComponent(id)}/${pause ? "pause" : "resume"}`, pause ? { reason: "Paused from the web app" } : undefined),
    onSuccess: (_r, pause) => {
      void refresh();
      toast.toast({ tone: "success", title: pause ? "Automation paused" : "Automation resumed" });
    },
    onError: (e) => toast.error(e, "Couldn't change the automation"),
  });
  const archive = useMutation({
    mutationFn: () => api.delete(`/v1/automations/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void refresh();
      toast.toast({ tone: "success", title: "Automation archived" });
      void navigate({ to: "/settings/automations" });
    },
    onError: (e) => {
      setArchiving(false);
      toast.error(e, "Couldn't archive the automation");
    },
  });
  if (q.error) return <ProblemView error={q.error} />;
  if (!q.data) return <Skeleton className="h-64 max-w-6xl" />;
  const a = q.data.data;
  const st = shownStatus(a);
  const canToggle = a.status === "enabled" || a.status === "paused";
  return (
    <div className="max-w-6xl">
      <Link to="/settings/automations" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Automations</Link>
      <header className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold"><span className="break-words">{a.name}</span> <Badge tone={SHOWN_TONE[st]}>{SHOWN_LABEL[st]}</Badge></h2>
          <p className="text-sm text-muted">{describeTrigger(a.trigger)} · up to {pluralize(a.hourly_cap, "run", "runs")} an hour</p>
        </div>
        <label className="flex items-center gap-2 text-base font-medium">
          <Switch checked={a.status === "enabled"} disabled={!canToggle || toggle.isPending} onCheckedChange={(on) => toggle.mutate(!on)} aria-label="Active" />
          {a.status === "paused" ? "Paused" : "Active"}
        </label>
        <Button onClick={() => setRunning(true)} disabled={a.status !== "enabled"}><Play /> Run now</Button>
        <Button variant="danger-ghost" onClick={() => setArchiving(true)}><Trash2 /> Archive…</Button>
      </header>

      {a.status === "paused" && a.paused_reason ? <p role="status" className="mb-4 rounded-md border border-line bg-warning-soft px-3 py-2 text-base text-warning-fg">Paused: {a.paused_reason}. Events and ticks while it is paused are not replayed.</p> : null}
      {st === "failing" ? (
        <p role="alert" className="mb-4 flex gap-2 rounded-md bg-danger-soft px-3 py-2 text-base text-danger-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{pluralize(a.consecutive_failures ?? 0, "run", "runs")} in a row failed. After 5 it pauses itself. Open the Runs tab to see why. <DocsLink page="automations.md">What counts as a failure</DocsLink></span>
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label="Automation">
          <TabsTrigger value="editor">Editor</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        {/* The editor stays mounted while the runs are shown, so an unsaved edit isn't lost by looking at them. */}
        <TabsContent value="editor" forceMount className="pt-4 data-[state=inactive]:hidden">
          <AutomationEditor key={`${a.id}:${a.version}`} existing={a} />
        </TabsContent>
        <TabsContent value="runs" className="pt-4"><RunsTab id={a.id} /></TabsContent>
      </Tabs>

      {running ? <RunNowDialog automation={a} onClose={() => setRunning(false)} /> : null}
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} danger busy={archive.isPending} confirmLabel="Archive automation" title={`Archive ${a.name}?`}
        description="It stops running and leaves the list. Its run history is kept for 90 days." onConfirm={() => archive.mutate()} />
    </div>
  );
}

/** Starts the automation now. One that works on a record needs a record ID; the answer lists the queued run IDs. */
function RunNowDialog({ automation, onClose }: { automation: Automation; onClose: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [record, setRecord] = useState("");
  const wants = needsRecord(automation.trigger);
  const run = useMutation({
    mutationFn: () => api.post<{ data: { runs: QueuedRun[] } }>(`/v1/automations/${encodeURIComponent(automation.id)}/run`, wants ? { records: [record.trim()] } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["admin", "automation-runs"] }),
  });
  const runs = run.data?.data.runs;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Run ${automation.name} now`}
        description={wants ? "It runs on the record you name, with the automation's own access, and checks its condition first." : "It starts one run now, with the automation's own access."}
        footer={runs ? <Button variant="primary" onClick={onClose}>Done</Button> : <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="run-now" busy={run.isPending} disabled={wants && record.trim() === ""}>Run now</Button>
        </>}>
        {runs ? (
          <div role="status" className="grid gap-2 text-base">
            <p>Queued {pluralize(runs.length, "run", "runs")}. The worker picks them up shortly; the Runs tab shows how they went.</p>
            <ul className="grid gap-1">{runs.map((r) => <li key={r.id} className="font-mono text-sm">{r.id}{r.record ? <span className="text-subtle"> · {r.record}</span> : null}</li>)}</ul>
          </div>
        ) : (
          <form id="run-now" className="grid gap-3.5" onSubmit={(e) => {
            e.preventDefault();
            if (!wants || record.trim()) run.mutate();
          }}>
            {run.error ? <ProblemAlert error={run.error} /> : null}
            {wants ? (
              <FormField label="Record ID" required hint={automation.trigger.type === "event" ? "The record to run it on, in the object the trigger names." : "A record of the object this automation runs on."}>
                {(a) => <Input {...a} autoFocus className="font-mono" placeholder="con_…" autoComplete="off" value={record} onChange={(e) => setRecord(e.target.value)} />}
              </FormField>
            ) : <p className="text-base text-muted">It starts with no record.</p>}
            <p className="text-sm text-subtle">Counts against its hourly cap.</p>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
