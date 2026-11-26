import { CopyButton } from "@/components/feedback";
import { Badge } from "@/components/ui/misc";
import { DocsLink } from "@/lib/docs";
import { eligibleKeyFact, sections, type EditorCtx } from "./model";

/** The draft as the data the API takes: the layout and the object it is for. */
export const layoutJson = (ctx: EditorCtx) => JSON.stringify({ object: ctx.env.meta.name, ...ctx.doc }, null, 2);

/**
 * An example request in this object's own words, from its real labels: two fields that could join the header
 * and a section to collapse. Left out when the object doesn't have them, rather than made up.
 */
function exampleRequest(ctx: EditorCtx): string | null {
  const facts = new Set(ctx.doc.header.key_facts ?? []);
  const candidates = ctx.env.meta.fields.filter((f) => eligibleKeyFact(f) && !facts.has(f.name)).slice(0, 2);
  const section = sections(ctx.doc)[0];
  if (candidates.length < 2 || !section) return null;
  return `On the ${ctx.env.meta.label} page, put ${candidates[0]!.label} and ${candidates[1]!.label} in the header, and collapse ${section.name}.`;
}

/** The draft as data, and the other ways to make the same change: through an agent, the API or the command line. */
export function CodeTab({ ctx }: { ctx: EditorCtx }) {
  const object = ctx.env.meta.name;
  const json = layoutJson(ctx);
  const example = exampleRequest(ctx);
  return (
    <div className="flex flex-col gap-3.5 p-4">
      <div>
        <h2 className="text-base font-semibold">Ask your agent instead</h2>
        <p className="mt-0.5 text-sm text-subtle">Any MCP client with an admin connection can change this layout. It edits the same draft you see here, and every change shows who made it.</p>
      </div>
      {example ? <p className="rounded-lg border border-line px-3 py-2.5 text-base text-muted">“{example}”</p> : null}
      <div>
        <div className="mb-1.5 flex items-center">
          <h3 className="flex-1 text-sm font-medium">The draft as data</h3>
          <CopyButton text={json} label="Copy" />
        </div>
        <div role="region" aria-label="The draft as JSON" tabIndex={0} className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 p-3 focus-visible:outline-2 focus-visible:outline-focus">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm">{json}</pre>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-muted">
        <li><Badge>MCP</Badge> <code className="font-mono">set_page_layout</code> then <code className="font-mono">publish_page_layout</code> on the admin server, a dry run first</li>
        <li><Badge>API</Badge> <code className="font-mono">PUT /v1/objects/{object}/layout/draft</code>, then <code className="font-mono">POST /v1/objects/{object}/layout/publish</code></li>
        <li><Badge>CLI</Badge> <code className="font-mono">crm schema pull</code> to read layouts, <code className="font-mono">crm schema apply</code> to publish them</li>
      </ul>
      <p className="text-sm text-subtle">The <DocsLink page="cli.md">command-line guide</DocsLink> shows how.</p>
    </div>
  );
}
