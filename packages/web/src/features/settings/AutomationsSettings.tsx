import { Package } from "lucide-react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Badge, Skeleton } from "@/components/ui/misc";
import type { InstalledPack } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { DocsLink } from "@/lib/docs";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";
import { AutomationList } from "./automations/AutomationList";

/**
 * Automations (a list, an editor with a dry run and a test, and the run history, under ./automations/)
 * and the read-only list of installed schema packs. Packs are installed and changed with the `crm` CLI
 * or the API (docs/packs.md).
 */

// These words are used by tests and other screens; they live with the rest of the automation model.
export { describeEvent, describeTrigger } from "./automations/model";
export { AutomationDetail, NewAutomation } from "./automations/AutomationDetail";

export const AutomationsSettings = AutomationList;

export function PacksSettings() {
  const q = useAdmin<{ data: InstalledPack[] }>(["packs"], "/v1/packs");
  return (
    <Section title="Installed packs" description={<>
      Schema packs set a workspace up for a use case (objects, fields, pipelines, roles, views). Install, upgrade and uninstall them with the <code>crm pack</code> CLI or
      the API (see the <DocsLink page="packs.md">packs guide</DocsLink>); connected apps can only plan and list them.
    </>}>
      {q.isPending ? <Skeleton className="h-16" /> : q.error ? <ProblemView error={q.error} onRetry={() => q.refetch()} compact /> : q.data.data.length === 0 ? (
        <EmptyState icon={<Package />} title="No packs installed" className="py-6">Try <code>crm pack install packs/recruiting</code>.</EmptyState>
      ) : (
        <SimpleTable label="Installed packs" head={["Pack", "Version", "State", "Adds", "Updated"]}>
          {q.data.data.map((p) => (
            <tr key={p.name}>
              <td className="px-4 py-2"><p className="font-medium">{p.name}</p>{p.description ? <p className="text-sm text-muted">{p.description}</p> : null}</td>
              <td className="px-4 py-2 text-sm">{p.version}</td>
              <td className="px-4 py-2 text-sm">{p.status === "installed" ? <Badge tone="success">Installed</Badge> : <Badge>Uninstalled</Badge>}</td>
              <td className="px-4 py-2 text-sm text-muted">{owns(p)}</td>
              <td className="px-4 py-2 text-sm" title={formatDateTime(p.updated_at)}>{formatRelative(p.updated_at)}</td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  );
}

function owns(p: InstalledPack): string {
  const o = p.owns ?? { objects: [], fields: [], pipelines: [], roles: [], views: [] };
  const part = (n: number, what: string) => (n ? `${n} ${what}${n === 1 ? "" : "s"}` : null);
  return [part(o.objects?.length ?? 0, "object"), part(o.fields?.length ?? 0, "field"), part(o.pipelines?.length ?? 0, "pipeline"),
    part(o.roles?.length ?? 0, "role"), part(o.views?.length ?? 0, "view")].filter(Boolean).join(", ") || "Nothing";
}
