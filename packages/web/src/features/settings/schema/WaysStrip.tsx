import { Code2, PenLine, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/misc";
import { DocsLink } from "@/lib/docs";
import { formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useSchemaChanges, useWho } from "./hooks";
import { surfaceLabel } from "./model";

function Way({ badge, children, last }: { badge: ReactNode; children: ReactNode; last?: ReactNode }) {
  return (
    <div className="flex min-w-[14rem] flex-1 flex-col items-start gap-1.5 border-line px-4 py-3 [&:not(:first-child)]:border-t md:[&:not(:first-child)]:border-l md:[&:not(:first-child)]:border-t-0">
      {badge}
      <p className="text-base text-muted">{children}</p>
      {last}
    </div>
  );
}

/**
 * The three ways to change the schema. "Last change from the CLI / by an agent" comes from the schema's change
 * history, which only audit:read callers can read; without it the lines are left out rather than guessed.
 */
export function WaysStrip() {
  const canAudit = useSession().can("audit:read");
  const history = useSchemaChanges(null, 500, canAudit);
  const who = useWho();
  const last = (surface: string) => history.data?.find((c) => c.surface === surface);
  const line = (what: string, surface: string) => {
    const c = last(surface);
    return c ? <span className="text-sm text-subtle">{what}: {formatRelative(c.changed_at)} by {who(c.actor)}{c.via ? ` (${c.via})` : ""}</span> : null;
  };
  return (
    <section aria-label="Three ways to change this" className="flex flex-wrap rounded-lg border border-line bg-surface">
      <Way badge={<span className="flex items-center gap-2"><Badge tone="info"><Sparkles className="size-3" aria-hidden /> Ask an agent</Badge><span className="text-sm text-subtle">recommended</span></span>}
        last={canAudit ? line("Last change by an agent", "admin-mcp") : null}>
        Connect an MCP client to the admin server and describe the change; it shows you a dry run before applying. Its tools are <code className="font-mono text-sm">add_field</code>, <code className="font-mono text-sm">create_object</code> and <code className="font-mono text-sm">set_page_layout</code>. <DocsLink page="mcp/README.md">MCP guide</DocsLink>
      </Way>
      <Way badge={<Badge tone="accent"><Code2 className="size-3" aria-hidden /> Schema as code</Badge>}
        last={canAudit ? line(`Last change from the ${surfaceLabel("cli")}`, "cli") : null}>
        Keep the schema in a file and review changes like code: <code className="font-mono text-sm">crm schema pull</code>, <code className="font-mono text-sm">plan</code>, <code className="font-mono text-sm">apply</code>. <DocsLink page="cli.md">Command-line guide</DocsLink>
      </Way>
      <Way badge={<Badge><PenLine className="size-3" aria-hidden /> Here, by hand</Badge>}>
        For a quick change. You see the same dry run an agent gets before anything is applied.
      </Way>
    </section>
  );
}
