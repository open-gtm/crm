import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Terminal } from "lucide-react";
import { NoAccess, ProblemView } from "@/components/feedback";
import { ApiProblem } from "@/lib/api/problem";
import { Badge, Skeleton } from "@/components/ui/misc";
import { optionLabel } from "@/meta/fields";
import { navObjects, useDescribe, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { LayoutEditor } from "./LayoutEditor";
import { Section, SimpleTable } from "./SettingsLayout";
import { DocsLink } from "@/lib/docs";

function CliNote() {
  return (
    <p className="mb-4 flex max-w-4xl items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-base text-muted">
      <Terminal className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>The schema is read-only here. To add or change objects and fields, use the <code className="font-mono">crm</code> command-line tool (<code className="font-mono">crm schema pull</code>, then <code className="font-mono">plan</code> and <code className="font-mono">apply</code>) or the API, which can preview a change before making it. The <DocsLink page="cli.md">command-line guide</DocsLink> shows how.</span>
    </p>
  );
}

export function SchemaSettings() {
  const objects = useObjects();
  const { standard, custom } = navObjects(objects.data ?? []);
  return (
    <>
      <CliNote />
      <Section title="Objects" description="Every object in this workspace that you can read, with its fields.">
        {objects.isPending ? <Skeleton className="h-40" /> : objects.error ? <ProblemView error={objects.error} compact /> : (
          <ul className="-m-4 divide-y divide-line">
            {[...standard, ...custom].map((o) => (
              <li key={o.name}>
                <Link to="/settings/schema/$schemaObject" params={{ schemaObject: o.name }} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <ObjectIcon object={o} className="size-4 text-muted" />
                  <div className="min-w-0 flex-1"><p className="font-medium">{o.label} <code className="ml-1 font-mono text-xs text-subtle">{o.name}</code></p><p className="truncate text-sm text-muted">{o.description}</p></div>
                  {o.standard ? <Badge>Standard</Badge> : <Badge tone="accent">Custom</Badge>}
                  <span className="text-sm text-subtle">{o.field_count} fields</span>
                  <ChevronRight className="size-4 text-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

export function SchemaObject() {
  const { schemaObject } = useParams({ strict: false }) as { schemaObject?: string };
  const meta = useDescribe(schemaObject);
  return (
    <>
      <Link to="/settings/schema" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Schema</Link>
      <CliNote />
      {meta.error instanceof ApiProblem && (meta.error.status === 403 || meta.error.status === 404) ? (
        <NoAccess title="You can't see this object" className="max-w-4xl rounded-lg border border-line bg-surface">It doesn't exist, or your role can't read it.</NoAccess>
      ) : meta.error ? <ProblemView error={meta.error} /> : !meta.data ? <Skeleton className="h-64 max-w-4xl" /> : (
        <Section title={meta.data.label} description={<>API name <code className="font-mono">{meta.data.name}</code> · IDs start with <code className="font-mono">{meta.data.id_prefix}_</code>{meta.data.display_field ? <> · named by <code className="font-mono">{meta.data.display_field}</code></> : null}</>}>
          <SimpleTable label={`${meta.data.label} fields`} head={["Field", "Type", "Rules", "Your access"]}>
            {meta.data.fields.map((f) => (
              <tr key={f.name}>
                <td className="px-4 py-2"><p className="font-medium">{f.label}</p><code className="font-mono text-xs text-subtle">{f.name}</code></td>
                <td className="px-4 py-2 text-sm">{f.type.replace(/_/g, " ")}{f.relation ? ` → ${f.relation.to}${f.relation.cardinality === "many_to_many" ? " (many)" : ""}` : ""}
                  {f.values?.length ? <span className="block text-xs text-muted">{f.values.slice(0, 6).map((v) => optionLabel(f, v.key)).join(", ")}{f.values.length > 6 ? "…" : ""}</span> : null}</td>
                <td className="px-4 py-2"><div className="flex flex-wrap gap-1">
                  {f.required ? <Badge>required</Badge> : null}{f.unique ? <Badge>unique</Badge> : null}{f.read_only ? <Badge>system</Badge> : null}
                  {f.create_only ? <Badge>set on create</Badge> : null}{f.sensitivity ? <Badge tone={f.sensitivity === "restricted" ? "danger" : "warning"}>{f.sensitivity}</Badge> : null}
                  {f.standard ? null : <Badge tone="accent">custom</Badge>}
                </div></td>
                <td className="px-4 py-2 text-sm">{f.access === "none" ? "hidden" : f.access === "read" ? "read only" : "read and write"}</td>
              </tr>
            ))}
          </SimpleTable>
        </Section>
      )}
      {meta.data ? <LayoutEditor meta={meta.data} /> : null}
    </>
  );
}
