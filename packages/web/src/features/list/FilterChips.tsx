import { X } from "lucide-react";
import { Fragment } from "react";
import { useRecordName } from "@/components/pickers";
import { countConditions, isComplete, takesNoValue, type Condition, type FilterNode, type Group, type Scalar } from "@/lib/filters";
import { formatDate } from "@/lib/format";
import { operatorsFor, optionLabel } from "@/meta/fields";
import type { ObjectMeta } from "@/lib/api/types";
import { plainLabel } from "@/lib/text";
import { usePathOptions, type PathOption } from "./FilterBuilder";

/**
 * A filter without the builder's popover: removes the condition at `path` (child positions from the
 * root), and any group that leaves empty, so a chip's remove button changes the same filter state the
 * builder edits. An empty result is null (no filter).
 */
export function removeCondition(group: Group, path: number[]): Group | null {
  const [i, ...rest] = path;
  const children: FilterNode[] = [];
  group.children.forEach((c, j) => {
    if (j !== i) return void children.push(c);
    if (rest.length && c.kind === "group") {
      const inner = removeCondition(c, rest);
      if (inner) children.push(inner);
    }
  });
  return children.length ? { ...group, children } : null;
}

function RelatedName({ id }: { id: string }) {
  const name = useRecordName(id);
  return <bdi>{name.data ?? (name.isPending ? "…" : "a record")}</bdi>;
}

function Value({ v, option, meta }: { v: Scalar; option: PathOption; meta: ObjectMeta }) {
  const f = option.field;
  if (typeof v === "boolean") return <>{v ? "Yes" : "No"}</>;
  if (f.type === "relation" && typeof v === "string") {
    if (f.relation?.to === "user") return <bdi>{meta.users?.find((u) => u.id === v)?.name ?? "a member"}</bdi>;
    return <RelatedName id={v} />;
  }
  if (f.values) return <bdi>{plainLabel(optionLabel(f, v))}</bdi>;
  if (f.type === "date" && typeof v === "string") return <>{formatDate(v) || v}</>;
  return <bdi>{String(v)}</bdi>;
}

function Chip({ cond, option, meta, onRemove }: { cond: Condition; option: PathOption | undefined; meta: ObjectMeta; onRemove: () => void }) {
  const label = option?.label ?? cond.path.join(" → ");
  const op = (option ? operatorsFor(option.field.type) : []).find((o) => o.op === cond.op)?.label ?? cond.op.replace(/_/g, " ");
  const values = cond.value === undefined ? [] : Array.isArray(cond.value) ? cond.value : [cond.value];
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border border-line bg-surface pl-2.5 pr-1 text-sm text-muted">
      <span className="shrink-0">{label}</span>
      <span className="shrink-0">{op}</span>
      {!takesNoValue(cond.op) && values.length ? (
        <strong className="min-w-0 truncate font-medium text-fg">
          {values.map((v, i) => <Fragment key={i}>{i ? ", " : null}{option ? <Value v={v} option={option} meta={meta} /> : <bdi>{String(v)}</bdi>}</Fragment>)}
        </strong>
      ) : null}
      <button type="button" aria-label={`Remove filter: ${label} ${op}`} onClick={onRemove}
        className="inline-flex shrink-0 rounded-sm p-0.5 text-subtle hover:bg-surface-3 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
        <X aria-hidden className="size-3" />
      </button>
    </span>
  );
}

function Nodes({ group, path, root, options, meta, onChange }: {
  group: Group; path: number[]; root: Group; options: PathOption[]; meta: ObjectMeta; onChange: (g: Group | null) => void;
}) {
  const shown = group.children.map((c, i) => ({ c, i })).filter(({ c }) => (c.kind === "cond" ? isComplete(c) : countConditions(c) > 0));
  return (
    <>
      {shown.map(({ c, i }, n) => (
        <Fragment key={i}>
          {n > 0 && group.conj === "or" ? <span className="text-sm text-subtle">or</span> : null}
          {c.kind === "cond" ? (
            <Chip cond={c} option={options.find((o) => o.key === c.path.join("."))} meta={meta} onRemove={() => onChange(removeCondition(root, [...path, i]))} />
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2 rounded-md border border-dashed border-line px-1.5 py-0.5" role="group" aria-label="Condition group">
              <Nodes group={c} path={[...path, i]} root={root} options={options} meta={meta} onChange={onChange} />
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** The list's active filters as removable chips under the header. Shown only when there is at least one complete condition. */
export function FilterChips({ meta, filter, onChange }: { meta: ObjectMeta; filter: Group | null; onChange: (g: Group | null) => void }) {
  const { options } = usePathOptions(meta);
  if (!filter || countConditions(filter) === 0) return null;
  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2 md:px-6">
      <Nodes group={filter} path={[]} root={filter} options={options} meta={meta} onChange={onChange} />
    </div>
  );
}
