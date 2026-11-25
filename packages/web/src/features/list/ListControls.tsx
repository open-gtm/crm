import { ArrowDown, ArrowDownUp, ArrowUp, CalendarDays, Columns3, Kanban, Plus, RotateCcw, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { FieldMeta, ObjectMeta, Sort } from "@/lib/api/types";
import { plainLabel } from "@/lib/text";
import { canSort, sortableParts, visibleFields } from "@/meta/fields";

/** Show, hide and reorder columns. Order changes with the arrow buttons (keyboard friendly). */
export function ColumnsMenu({ meta, columns, onChange, onReset, overridden }: {
  meta: ObjectMeta; columns: string[]; onChange: (c: string[]) => void; onReset: () => void; overridden: boolean;
}) {
  const all = [...visibleFields(meta).map((f) => ({ name: f.name, label: f.label })), { name: "created_at", label: "Created" }, { name: "updated_at", label: "Updated" }];
  const shown = columns.map((c) => all.find((a) => a.name === c)).filter((x): x is { name: string; label: string } => Boolean(x));
  const hidden = all.filter((a) => !columns.includes(a.name));
  const move = (i: number, d: -1 | 1) => {
    const next = [...columns];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <Popover>
      <PopoverTrigger asChild><Button size="sm"><Columns3 /> Columns</Button></PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="end">
        <p className="px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Shown, in order</p>
        <ul className="flex flex-col">
          {shown.map((c, i) => (
            <li key={c.name} className="flex items-center gap-2 rounded-sm px-1 py-0.5 hover:bg-surface-2">
              <Checkbox id={`col-${c.name}`} checked onCheckedChange={() => onChange(columns.filter((x) => x !== c.name))} />
              <label htmlFor={`col-${c.name}`} className="min-w-0 flex-1 truncate text-base">{c.label}</label>
              <Button size="icon-sm" variant="subtle" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
              <Button size="icon-sm" variant="subtle" aria-label={`Move ${c.label} down`} disabled={i === shown.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
            </li>
          ))}
        </ul>
        {hidden.length ? <p className="mt-2 px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-subtle">Hidden</p> : null}
        <ul className="flex max-h-60 flex-col overflow-y-auto">
          {hidden.map((c) => (
            <li key={c.name} className="flex items-center gap-2 rounded-sm px-1 py-1 hover:bg-surface-2">
              <Checkbox id={`col-${c.name}`} checked={false} onCheckedChange={() => onChange([...columns, c.name])} />
              <label htmlFor={`col-${c.name}`} className="min-w-0 flex-1 truncate text-base text-muted">{c.label}</label>
            </li>
          ))}
        </ul>
        {overridden ? <Button size="sm" variant="ghost" className="mt-2 w-full" onClick={onReset}><RotateCcw /> Reset columns</Button> : null}
      </PopoverContent>
    </Popover>
  );
}

/** Sort by up to three fields, each ascending or descending. */
export function SortMenu({ meta, sort, onChange }: { meta: ObjectMeta; sort: Sort[]; onChange: (s: Sort[]) => void }) {
  const fields = [...visibleFields(meta).filter(canSort).map((f) => ({ name: f.name, label: plainLabel(f.label) })), ...sortableParts(meta).map((p) => ({ ...p, label: plainLabel(p.label) })),
    { name: "created_at", label: "Created" }, { name: "updated_at", label: "Updated" }];
  const label = (n: string) => fields.find((f) => f.name === n)?.label ?? n;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" aria-label={sort.length ? `Sort: ${sort.map((s) => `${label(s.field)} ${s.dir === "desc" ? "descending" : "ascending"}`).join(", then ")}` : "Sort"}>
          <ArrowDownUp /> {sort.length ? `Sorted by ${label(sort[0]!.field)}${sort.length > 1 ? ` +${sort.length - 1}` : ""}` : "Sort"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="flex flex-col gap-2">
          {sort.length === 0 ? <p className="text-sm text-muted">Newest first. Add a sort to change the order.</p> : null}
          {sort.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-sm text-subtle">{i === 0 ? "By" : "Then"}</span>
              <NativeSelect aria-label={`Sort ${i + 1} field`} value={s.field} onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                {fields.filter((f) => f.name === s.field || !sort.some((x) => x.field === f.name)).map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
              </NativeSelect>
              <NativeSelect aria-label={`Sort ${i + 1} direction`} className="w-28" value={s.dir ?? "asc"} onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}>
                <option value="asc">A → Z</option>
                <option value="desc">Z → A</option>
              </NativeSelect>
              <Button size="icon-sm" variant="subtle" aria-label={`Remove sort ${i + 1}`} onClick={() => onChange(sort.filter((_, j) => j !== i))}><X /></Button>
            </div>
          ))}
          {sort.length < 3 ? (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => {
              const next = fields.find((f) => !sort.some((s) => s.field === f.name));
              if (next) onChange([...sort, { field: next.name, dir: "asc" }]);
            }}><Plus /> Add sort</Button>
          ) : null}
          <p className="text-xs text-subtle">Tip: shift-click a column header to add it to the sort.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type ListLayout = "table" | "board" | "calendar";

/**
 * How the list is shown: a table (optionally grouped by a field), a board with a column per value of a
 * select or status field, or a calendar by a date field. A layout the object has no field for isn't offered.
 */
export function LayoutMenu({ layout, onLayout, boardBy, boardFields, onBoardBy, dateBy, dateFields, onDateBy, groupBy, groupFields, onGroupBy }: {
  layout: ListLayout; onLayout: (l: ListLayout) => void;
  boardBy: FieldMeta | undefined; boardFields: FieldMeta[]; onBoardBy: (name: string) => void;
  dateBy: FieldMeta | undefined; dateFields: FieldMeta[]; onDateBy: (name: string) => void;
  groupBy: FieldMeta | undefined; groupFields: FieldMeta[]; onGroupBy: (name: string | null) => void;
}) {
  const options: { key: ListLayout; label: string; icon: React.ReactNode; show: boolean }[] = [
    { key: "table", label: "Table", icon: <Table2 />, show: true },
    { key: "board", label: "Board", icon: <Kanban />, show: boardFields.length > 0 },
    { key: "calendar", label: "Calendar", icon: <CalendarDays />, show: dateFields.length > 0 },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Show as" className="flex items-center">
        {options.filter((o) => o.show).map((o) => (
          <Button key={o.key} size="sm" variant={layout === o.key ? undefined : "ghost"} aria-pressed={layout === o.key} onClick={() => onLayout(o.key)}>{o.icon} {o.label}</Button>
        ))}
      </div>
      {layout === "board" && boardFields.length > 1 ? (
        <NativeSelect aria-label="Board columns" className="h-7 w-40 text-sm" value={boardBy?.name ?? ""} onChange={(e) => onBoardBy(e.target.value)}>
          {boardFields.map((f) => <option key={f.name} value={f.name}>By {plainLabel(f.label).toLowerCase()}</option>)}
        </NativeSelect>
      ) : null}
      {layout === "calendar" && dateFields.length > 1 ? (
        <NativeSelect aria-label="Calendar date" className="h-7 w-44 text-sm" value={dateBy?.name ?? ""} onChange={(e) => onDateBy(e.target.value)}>
          {dateFields.map((f) => <option key={f.name} value={f.name}>By {plainLabel(f.label).toLowerCase()}</option>)}
        </NativeSelect>
      ) : null}
      {layout === "table" && groupFields.length ? (
        <NativeSelect aria-label="Group by" className="h-7 w-44 text-sm" value={groupBy?.name ?? ""} onChange={(e) => onGroupBy(e.target.value || null)}>
          <option value="">No grouping</option>
          {groupFields.map((f) => <option key={f.name} value={f.name}>Group by {plainLabel(f.label).toLowerCase()}</option>)}
        </NativeSelect>
      ) : null}
    </div>
  );
}
