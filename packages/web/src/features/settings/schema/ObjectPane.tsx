import { Plus } from "lucide-react";
import { useState } from "react";
import { NoAccess, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/misc";
import { RecordPageSection } from "@/features/layout-editor/RecordPageSection";
import { ApiProblem } from "@/lib/api/problem";
import { formatNumber } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useObjects } from "@/meta/hooks";
import { AddField } from "./AddField";
import { ChangesTab } from "./ChangesTab";
import { FieldsTable } from "./FieldsTab";
import { useRecordCounts, useSchemaDescribe, useWho } from "./hooks";
import { originLabel, originOf } from "./model";

/** The right-hand pane: one object's header, then its fields, page layout and changes. */
export function ObjectPane({ object }: { object: string }) {
  const s = useSession();
  const meta = useSchemaDescribe(object);
  const objects = useObjects();
  const counts = useRecordCounts(true);
  const who = useWho();
  const [tab, setTab] = useState("fields");
  const [adding, setAdding] = useState(false);
  const canManage = s.can("schema:manage");
  const canAudit = s.can("audit:read");

  if (meta.error instanceof ApiProblem && (meta.error.status === 403 || meta.error.status === 404)) {
    return <NoAccess title="You can't see this object" className="rounded-lg border border-line bg-surface">It doesn't exist, or your role can't read it.</NoAccess>;
  }
  if (meta.error) return <ProblemView error={meta.error} onRetry={() => meta.refetch()} />;
  if (!meta.data) return <Skeleton className="h-64" />;
  const m = meta.data;
  const origin = originOf(m);
  const count = counts.data?.find((o) => o.name === object);
  const records = count && count.records !== null ? `${formatNumber(count.records)}${count.records_capped ? "+" : ""} records` : null;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{m.label}</h2>
            <Badge tone={origin.origin === "custom" ? "info" : origin.origin === "pack" ? "warning" : "neutral"}>{originLabel(origin)}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-subtle">API name <code className="font-mono">{m.name}</code> · IDs start <code className="font-mono">{m.id_prefix}_</code>{records ? ` · ${records}` : ""}
            {m.last_change ? ` · last changed ${who(m.last_change.actor)}` : ""}</p>
        </div>
        {canManage ? <Button onClick={() => { setTab("fields"); setAdding(true); }}><Plus /> Add field</Button> : null}
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList label={`${m.label}`} className="px-2">
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="layout">Page layout</TabsTrigger>
          {canAudit ? <TabsTrigger value="changes">Changes</TabsTrigger> : null}
        </TabsList>
        <TabsContent value="fields">
          {adding && canManage ? <AddField meta={m} objects={objects.data ?? []} onClose={() => setAdding(false)} /> : null}
          <FieldsTable meta={m} objects={objects.data ?? []} who={who} />
        </TabsContent>
        <TabsContent value="layout"><div className="p-4 [&>section]:mb-0 [&>section]:max-w-none"><RecordPageSection meta={m} /></div></TabsContent>
        {canAudit ? <TabsContent value="changes"><ChangesTab object={m.name} /></TabsContent> : null}
      </Tabs>
    </div>
  );
}
