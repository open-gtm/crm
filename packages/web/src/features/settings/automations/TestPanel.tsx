import { useMutation } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { ProblemAlert } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import { StepLog } from "./StepLog";
import { isJson, type Json, type TestResult } from "./model";

/** Whether a run of this trigger starts with a record the person has to name. */
export const needsRecord = (trigger: Json) => trigger.type === "event" || (trigger.type === "manual" && typeof trigger.object === "string" && trigger.object !== "");

/**
 * "Test it": the server runs the automation against one record (or none, for a schedule) inside a
 * transaction it rolls back. A saved automation is tested as saved; a new one as drafted. Whatever the
 * server returns is shown: it never sends an email or an HTTP request, it describes them.
 */
export function TestPanel({ existingId, draft, trigger, blocked }: { existingId?: string; draft: Json | null; trigger: Json; blocked?: string }) {
  const api = useApi();
  const [record, setRecord] = useState("");
  const wants = needsRecord(trigger);
  const test = useMutation({
    // A test reply holds record data: keep none of it once the panel is gone.
    gcTime: 0,
    mutationFn: () => {
      const rec = wants ? { record: record.trim() } : {};
      return existingId
        ? api.post<{ data: TestResult }>(`/v1/automations/${encodeURIComponent(existingId)}/test`, rec)
        : api.post<{ data: TestResult }>("/v1/automations/test", { automation: draft, ...rec });
    },
  });
  const disabled = Boolean(blocked) || (!existingId && !draft) || (wants && record.trim() === "");
  const r = test.data?.data;
  return (
    <section aria-labelledby="test-it" className="rounded-lg border border-line bg-surface p-4">
      <h3 id="test-it" className="mb-1 flex items-center gap-2 text-base font-semibold"><FlaskConical className="size-4 text-accent" aria-hidden /> Test it</h3>
      <p className="mb-3 text-sm text-subtle">Runs against one record and then rolls back. Nothing is sent: emails and HTTP requests are described, never delivered.</p>
      <form className="grid gap-3" onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) test.mutate();
      }}>
        {wants ? (
          <FormField label="Record ID" hint={trigger.type === "event" ? "The record the event would be about, for example one in the object the trigger names." : "A record of the object this automation runs on."}>
            {(a) => <Input {...a} className="font-mono" placeholder="con_…" autoComplete="off" value={record} onChange={(e) => setRecord(e.target.value)} />}
          </FormField>
        ) : <p className="text-sm text-muted">This automation starts with no record, so there is nothing to choose.</p>}
        <div><Button type="submit" busy={test.isPending} disabled={disabled}>Run test</Button></div>
        {blocked ? <p className="text-sm text-subtle">{blocked}</p> : null}
      </form>
      {test.error ? <ProblemAlert className="mt-3" error={test.error} /> : null}
      {r ? (
        <div className="mt-3 grid gap-2.5 rounded-md bg-surface-2 p-3" role="status" aria-label="Test result">
          <p className="flex flex-wrap items-center gap-2 text-base"><Badge tone={r.error ? "danger" : r.matched ? "success" : "warning"}>{r.error ? "Would fail" : r.matched ? "Matched" : "No match"}</Badge> <span>{r.explanation}</span></p>
          {r.stopped ? <p className="text-sm text-muted">A stop step would end the run: {r.stopped}</p> : null}
          {r.error ? <p className="text-sm text-danger-fg">{r.error}</p> : null}
          {r.actions.length ? <StepLog results={r.actions.filter(isJson)} label="What each step would do" /> : null}
        </div>
      ) : null}
    </section>
  );
}
