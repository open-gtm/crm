import { Activity, CheckSquare, Clock, FileText, FileStack, LayoutList, Link2, Paperclip, Plus, Search, Table2, Zap } from "lucide-react";
import { useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { FormField, NativeSelect } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import type { LayoutComponent } from "@/features/record/pageLayout";
import { addComponent, allComponents, hasType, newId, newSectionName, placeableFields, placedFields, sections, typeLabel, updateComponent, type EditorCtx, type Zone } from "./model";

type Key = "fields" | "related" | "timeline" | "notes" | "files" | "quotes" | "tasks" | "stage_path" | "agent_changes" | "related_lists";
const ITEMS: { key: Key; label: string; icon: ComponentType<{ className?: string }>; zone: Zone }[] = [
  { key: "fields", label: "Field section", icon: Table2, zone: "left" },
  { key: "related", label: "Related list", icon: LayoutList, zone: "right" },
  { key: "timeline", label: "Activity timeline", icon: Clock, zone: "main" },
  { key: "notes", label: "Notes", icon: FileText, zone: "main" },
  { key: "files", label: "Files", icon: Paperclip, zone: "main" },
  { key: "quotes", label: "Quotes", icon: FileStack, zone: "main" },
  { key: "tasks", label: "Open tasks", icon: CheckSquare, zone: "right" },
  { key: "stage_path", label: "Stage path", icon: Activity, zone: "top" },
  { key: "agent_changes", label: "Changes by agents", icon: Zap, zone: "right" },
  { key: "related_lists", label: "Other related lists", icon: Link2, zone: "right" },
];

/** The status fields a stage path can follow (a deal's follows its pipeline instead). */
export const statusFields = (ctx: EditorCtx) => ctx.env.meta.fields.filter((f) => f.type === "status" && f.access !== "none");

/** Relations to this object that the page doesn't already show as a related list. */
const freeRelations = (ctx: EditorCtx) => ctx.env.relations.filter((r) => !allComponents(ctx.doc).some((x) => x.c.type === "related" && x.c.object === r.object && x.c.field === r.field));

/** Why a component can't be added now, or null when it can. */
function reasonFor(key: Key, ctx: EditorCtx): string | null {
  const label = ctx.env.meta.label;
  if (key !== "fields" && key !== "related" && hasType(ctx.doc, key)) return "Already on the page";
  switch (key) {
    case "related":
      if (ctx.env.relations.length === 0) return `No other object relates to ${label.toLowerCase()}`;
      return freeRelations(ctx).length === 0 ? "Every related list is already on the page" : null;
    case "quotes": return ctx.env.relations.some((r) => r.object === "quote") ? null : `Quotes aren't made for ${ctx.env.meta.plural_label.toLowerCase()}`;
    case "tasks": return ctx.env.meta.name === "task" || ctx.env.meta.name === "activity" ? `${label} records have no tasks of their own` : null;
    case "stage_path": return ctx.env.meta.name === "deal" || statusFields(ctx).length > 0 ? null : `${label} has no status field`;
    default: return null;
  }
}

/** The section a "from the library" field goes into: the selected one, else the first. */
function targetSection(ctx: EditorCtx) {
  const all = sections(ctx.doc);
  return all.find((s) => s.id === ctx.selected) ?? all[0];
}

/** What can be added to the page: components, and fields no section places yet. Every Add is a button. */
export function Library({ ctx }: { ctx: EditorCtx }) {
  const [q, setQ] = useState("");
  const [relating, setRelating] = useState(false);
  const term = q.trim().toLowerCase();
  const items = ITEMS.filter((i) => !term || i.label.toLowerCase().includes(term));
  const placed = placedFields(ctx.doc);
  const unplaced = placeableFields(ctx.env.meta).filter((f) => !placed.has(f.name))
    .filter((f) => !term || `${f.label} ${f.name} ${typeLabel(f)}`.toLowerCase().includes(term));
  const target = targetSection(ctx);

  const add = (key: Key) => {
    if (key === "related") return setRelating(true);
    const item = ITEMS.find((i) => i.key === key)!;
    let c: LayoutComponent;
    if (key === "fields") c = { id: newId(ctx.doc, "section"), type: "fields", name: newSectionName(ctx.doc), columns: 1, collapsed: false, fields: [] };
    else if (key === "tasks" || key === "quotes") c = { id: newId(ctx.doc, key), type: key, rows: 5 };
    else if (key === "agent_changes") c = { id: newId(ctx.doc, key), type: key, days: 7 };
    else if (key === "stage_path") c = { id: newId(ctx.doc, key), type: key, field: ctx.env.meta.name === "deal" ? null : statusFields(ctx)[0]?.name ?? null };
    else c = { id: newId(ctx.doc, key), type: key as "timeline" | "notes" | "files" | "related_lists" };
    ctx.edit((d) => addComponent(d, c, item.zone));
    ctx.select(c.id);
  };
  const addField = (name: string) => {
    if (!target) return;
    ctx.edit((d) => updateComponent(d, target.id, (c) => (c.type === "fields" ? { ...c, fields: [...c.fields, name] } : c)));
    ctx.select(target.id);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="mb-2.5 flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-subtle focus-within:outline-2 focus-within:outline-focus">
        <Search className="size-3.5 shrink-0" aria-hidden />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a field or component" aria-label="Find a field or component"
          className="w-full min-w-0 border-0 bg-transparent text-base text-fg outline-none placeholder:text-subtle" />
      </label>
      <h2 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-subtle">Components</h2>
      {items.length === 0 ? <p className="px-2 text-sm text-muted">No component matches.</p> : (
        <ul className="flex flex-col">
          {items.map((i) => {
            const reason = reasonFor(i.key, ctx);
            return (
              <li key={i.key} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
                <i.icon className="size-4 shrink-0 text-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-base">{i.label}</p>
                  {reason ? <p className="text-xs text-subtle">{reason}</p> : null}
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={`Add ${i.label}`} disabled={reason !== null} title={reason ?? undefined} onClick={() => add(i.key)}><Plus /></Button>
              </li>
            );
          })}
        </ul>
      )}
      <h2 className="px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-subtle">Fields not on the page</h2>
      <p className="px-2 pb-1.5 text-sm text-subtle">These still show under “Other fields” until you place them.</p>
      {unplaced.length === 0 ? <p className="px-2 text-sm text-muted">{term ? "No field matches." : "Every field is on the page."}</p> : (
        <ul className="flex flex-col">
          {unplaced.map((f) => (
            <li key={f.name} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
              <span className="min-w-0 flex-1 truncate text-base"><bdi>{f.label}</bdi></span>
              <span className="shrink-0 text-xs text-subtle">{typeLabel(f)}</span>
              <Button size="icon-sm" variant="ghost" disabled={!target} title={target ? undefined : "Add a field section first"} aria-label={`Add ${f.label} to ${target?.name ?? "a section"}`} onClick={() => addField(f.name)}><Plus /></Button>
            </li>
          ))}
        </ul>
      )}
      {relating ? <RelatedDialog ctx={ctx} onClose={() => setRelating(false)} /> : null}
    </div>
  );
}

function RelatedDialog({ ctx, onClose }: { ctx: EditorCtx; onClose: () => void }) {
  const options = freeRelations(ctx);
  const [value, setValue] = useState(options[0] ? `${options[0].object}.${options[0].field}` : "");
  const chosen = options.find((o) => `${o.object}.${o.field}` === value);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add a related list" size="sm" description={`Choose which records to list on a ${ctx.env.meta.label.toLowerCase()}'s page.`}
        footer={<>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!chosen} onClick={() => {
            if (!chosen) return;
            const c: LayoutComponent = { id: newId(ctx.doc, `${chosen.object}_list`), type: "related", object: chosen.object, field: chosen.field, rows: 5 };
            ctx.edit((d) => addComponent(d, c, "right"));
            ctx.select(c.id);
            onClose();
          }}>Add list</Button>
        </>}>
        <FormField label="Records and the relation that links them" hint="Relations already on the page are left out.">
          {(p) => (
            <NativeSelect {...p} value={value} onChange={(e) => setValue(e.target.value)}>
              {options.map((o) => <option key={`${o.object}.${o.field}`} value={`${o.object}.${o.field}`}>{o.objectLabel} · {o.fieldLabel}</option>)}
            </NativeSelect>
          )}
        </FormField>
      </DialogContent>
    </Dialog>
  );
}
