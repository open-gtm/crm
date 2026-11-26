import { Link } from "@tanstack/react-router";
import { ProblemView } from "@/components/feedback";
import { Badge, Skeleton } from "@/components/ui/misc";
import { useObjects } from "@/meta/hooks";
import { groupObjects } from "./model";

/** The objects the caller can read, by module; objects made by a pack sit under that pack's name. */
export function ObjectList({ selected }: { selected: string | undefined }) {
  const objects = useObjects();
  if (objects.isPending) return <Skeleton className="h-40" />;
  if (objects.error) return <ProblemView error={objects.error} compact />;
  return (
    <nav aria-label="Objects" className="rounded-lg border border-line bg-surface p-1.5">
      {groupObjects(objects.data).map((g) => (
        <div key={g.key}>
          <h3 className="flex items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-subtle">{g.name}{g.pack ? <Badge className="normal-case">pack</Badge> : null}</h3>
          <ul>
            {g.objects.map((o) => (
              <li key={o.name}>
                <Link to="/settings/schema/$schemaObject" params={{ schemaObject: o.name }} aria-current={o.name === selected ? "page" : undefined}
                  className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-base hover:bg-surface-2 aria-[current=page]:bg-accent-soft aria-[current=page]:text-accent-soft-fg">
                  <span className="min-w-0 flex-1 truncate font-medium">{o.label}</span>
                  <span className="text-sm text-subtle tabular">{o.field_count} fields</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
