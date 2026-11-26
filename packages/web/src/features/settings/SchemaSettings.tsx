import { useParams } from "@tanstack/react-router";
import { EmptyState } from "@/components/feedback";
import { Database } from "lucide-react";
import { ObjectList } from "./schema/ObjectList";
import { ObjectPane } from "./schema/ObjectPane";
import { WaysStrip } from "./schema/WaysStrip";

/**
 * Settings → Objects & fields: every object the caller can read on the left, the chosen one on the right,
 * and the three ways to change the schema above both. Changes made here, by an agent or from the CLI all
 * go through the same schema routes, each previewed by a dry run and recorded with where it came from.
 */
function SchemaPage({ object }: { object: string | undefined }) {
  return (
    <div className="flex max-w-6xl flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Objects and fields</h2>
        <p className="mt-0.5 text-base text-muted">The shape of your workspace. Every change is previewed first and recorded with where it came from.</p>
      </div>
      <WaysStrip />
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="md:w-60 md:shrink-0"><ObjectList selected={object} /></div>
        <div className="min-w-0 flex-1">
          {object ? <ObjectPane key={object} object={object} /> : (
            <EmptyState icon={<Database />} title="Choose an object" className="rounded-lg border border-line bg-surface">Its fields, page layout and change history appear here.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

export function SchemaSettings() {
  return <SchemaPage object={undefined} />;
}

export function SchemaObject() {
  const { schemaObject } = useParams({ strict: false }) as { schemaObject?: string };
  return <SchemaPage object={schemaObject} />;
}
