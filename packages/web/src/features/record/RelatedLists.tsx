import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { useApi } from "@/lib/api/context";
import type { FieldMeta, ObjectMeta, Page } from "@/lib/api/types";
import { packFilter } from "@/lib/filters";
import { qk } from "@/lib/keys";
import { canFilter, canWrite, defaultColumns, includable } from "@/meta/fields";
import { navObjects, useDescribes, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";
import { FieldValue, RecordLink } from "@/meta/registry";

export interface Reference { meta: ObjectMeta; field: FieldMeta }

/**
 * Objects the record page's timeline already shows (logged activities and tasks, linked however they
 * are linked): they get no related list too, which could only show a different, smaller count.
 */
export const ON_TIMELINE = new Set(["activity", "task"]);

/** Every relation field, on any object this member can read, that points at `object`: the related lists, found from metadata. */
export function useReferences(object: string): { refs: Reference[]; loading: boolean } {
  const objects = useObjects();
  const { standard, custom } = navObjects(objects.data ?? []);
  const readable = [...standard, ...custom].filter((o) => !ON_TIMELINE.has(o.name));
  const metas = useDescribes(readable.map((o) => o.name));
  const refs: Reference[] = [];
  for (const m of metas) {
    if (!m.data) continue;
    for (const f of m.data.fields) if (f.type === "relation" && f.relation?.to === object && canFilter(f)) refs.push({ meta: m.data, field: f });
  }
  return { refs, loading: objects.isPending || metas.some((m) => m.isPending) };
}

const SHOWN = 5;

/** How a list is named in `exclude`: the object and the relation field that points at the record. */
export const listKey = (object: string, field: string) => `${object}.${field}`;

/** Related lists a layout draws elsewhere, so the group doesn't show them twice. */
export interface RelatedExclude { lists?: ReadonlySet<string>; objects?: ReadonlySet<string> }

export const keep = (r: Reference, exclude?: RelatedExclude) => !exclude?.lists?.has(listKey(r.meta.name, r.field.name)) && !exclude?.objects?.has(r.meta.name);

/** Every related list the member can read, one card each, minus those the layout places on their own. */
export function RelatedLists({ object, id, name, exclude }: { object: string; id: string; name: string; exclude?: RelatedExclude }) {
  const { refs, loading } = useReferences(object);
  if (loading) return <div className="flex flex-col gap-3" aria-busy="true">{[1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;
  const shown = refs.filter((r) => keep(r, exclude));
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-4">
      {shown.slice(0, 10).map((r) => <RelatedList key={listKey(r.meta.name, r.field.name)} r={r} id={id} name={name} several={refs.filter((x) => x.meta.name === r.meta.name).length > 1} />)}
    </div>
  );
}

/**
 * The related lists of `object` (all of them, or just the one through `field`) on a record of `of`, each limited
 * to `rows` rows: a layout's `related` and `quotes` components. Nothing when the member can't read the object.
 */
export function RelatedOf({ of, object, field, rows, id, name }: { of: string; object: string; field?: string; rows: number; id: string; name: string }) {
  const { refs, loading } = useReferences(of);
  if (loading) return <Skeleton className="h-24 w-full" />;
  const mine = refs.filter((r) => r.meta.name === object);
  const shown = field === undefined ? mine : mine.filter((r) => r.field.name === field);
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-4">
      {shown.map((r) => <RelatedList key={listKey(r.meta.name, r.field.name)} r={r} id={id} name={name} rows={rows} several={mine.length > 1} />)}
    </div>
  );
}

function RelatedList({ r, id, name, several, rows = SHOWN }: { r: Reference; id: string; name: string; several: boolean; rows?: number }) {
  const api = useApi();
  const [creating, setCreating] = useState(false);
  const cols = defaultColumns(r.meta).filter((c) => c !== r.field.name).slice(0, 2);
  const where = { field: r.field.name, op: "eq", value: id };
  const q = useQuery({
    queryKey: qk.related(r.meta.name, { field: r.field.name, id, cols, rows }),
    queryFn: ({ signal }) => api.request<Page>("POST", "/v1/query", { signal, body: { object: r.meta.name, where, limit: rows, count: true, fields: ["display_name", ...cols], sort: [{ field: "updated_at", dir: "desc" }],
      ...(includable(r.meta, cols).length ? { include: includable(r.meta, cols) } : {}) } }),
  });
  const title = several ? `${r.meta.plural_label} (${r.field.label})` : r.meta.plural_label;
  const canCreate = canWrite(r.field, r.meta.access, "create") && r.meta.name !== "activity";
  const total = q.data?.total;
  return (
    <section aria-label={title} className="rounded-lg border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <ObjectIcon object={r.meta} className="size-4 text-muted" />
        <h3 className="flex-1 truncate text-base font-semibold">{title}{total !== undefined ? <span className="ml-1.5 font-normal text-subtle">{total.toLocaleString()}{q.data?.total_capped ? "+" : ""}</span> : null}</h3>
        {canCreate ? <Button size="sm" variant="ghost" onClick={() => setCreating(true)} aria-label={`New ${r.meta.label.toLowerCase()} for ${name}`}><Plus /> New</Button> : null}
      </div>
      {q.isPending ? <div className="p-4"><Skeleton className="h-4 w-2/3" /></div>
        : q.error && !q.data ? <div className="p-3"><ProblemView error={q.error} compact /></div>
        : !q.data || q.data.data.length === 0 ? <p className="px-4 py-3 text-sm text-subtle">None yet.</p>
        : (
          <ul className="divide-y divide-line">
            {q.data.data.map((rec) => (
              <li key={rec.id} className="flex items-center gap-3 px-4 py-2 text-base">
                <RecordLink object={r.meta.name} id={rec.id} className="min-w-0 flex-1 truncate font-medium"><bdi>{rec.display_name || "(no name)"}</bdi></RecordLink>
                {cols.map((c) => {
                  const f = r.meta.fields.find((x) => x.name === c)!;
                  return <span key={c} className="hidden max-w-40 truncate text-sm text-muted sm:block"><FieldValue field={f} value={rec[c]} record={rec} meta={r.meta} /></span>;
                })}
              </li>
            ))}
          </ul>
        )}
      {total !== undefined && total > rows ? (
        <div className="border-t border-line px-4 py-2">
          <Link to="/o/$object" params={{ object: r.meta.name }} search={{ filter: packFilter({ kind: "group", conj: "and", children: [{ kind: "cond", path: [r.field.name], op: "eq", value: id }] }) }}
            className="text-sm font-medium text-accent hover:underline">View all {total.toLocaleString()}</Link>
        </div>
      ) : null}
      {creating ? <CreateRecordDialog object={r.meta.name} open onOpenChange={setCreating} prefill={{ [r.field.name]: r.field.relation?.cardinality === "many_to_many" ? [id] : id }} stay /> : null}
    </section>
  );
}
