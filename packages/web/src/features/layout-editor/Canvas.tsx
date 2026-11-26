import { closestCenter, DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { GripVertical, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { NativeSelect } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import type { LayoutComponent } from "@/features/record/pageLayout";
import { cn } from "@/lib/cn";
import { keyFacts } from "@/meta/fields";
import { FieldValue } from "@/meta/registry";
import { COLUMN_LABEL, COLUMNS, describe, eligibleKeyFact, findComponent, hiddenFrom, HEADER_KEY, LIMITS, moveInto, zoneList, type Column, type EditorCtx } from "./model";

/** The key facts the header shows now: the layout's own list, or (when it leaves them to the page) the ones the page picks. */
export function shownKeyFacts(ctx: EditorCtx): string[] {
  return ctx.doc.header.key_facts ?? keyFacts(ctx.env.meta).map((f) => f.name);
}

/**
 * The record page as the layout arranges it: the header, the top band and three columns of selectable blocks.
 * Blocks can be dragged between and within columns (mouse, or Space and the arrow keys on the grip); the
 * buttons in the Properties tab do the same, and are the way to do it by touch.
 */
export function Canvas({ ctx }: { ctx: EditorCtx }) {
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const id = String(e.active.id).replace(/^blk:/, "");
    const over = e.over ? String(e.over.id) : "";
    if (over.startsWith("end:")) ctx.edit((d) => moveInto(d, id, over.slice(4) as Column, null));
    else if (over.startsWith("blk:")) {
      const target = over.slice(4);
      const zone = COLUMNS.find((z) => zoneList(ctx.doc, z).some((c) => c.id === target));
      if (zone) ctx.edit((d) => moveInto(d, id, zone, target));
    }
  };
  const dragged = dragging ? findComponent(ctx.doc, dragging) : undefined;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={(e: DragStartEvent) => setDragging(String(e.active.id).replace(/^blk:/, ""))}
      onDragCancel={() => setDragging(null)} onDragEnd={onDragEnd}>
      <div className="flex min-w-0 flex-col gap-3">
        <Header ctx={ctx} />
        {ctx.doc.top.map((c) => <ComponentBlock key={c.id} ctx={ctx} c={c} draggable={false} />)}
        <div className="flex flex-wrap items-start gap-3">
          {COLUMNS.map((z) => (
            <div key={z} role="group" aria-label={COLUMN_LABEL[z]} className={cn("flex min-w-0 flex-col gap-3", z === "main" ? "flex-[2_1_20rem]" : "flex-[1_1_14rem]")}>
              <h3 className="px-0.5 text-xs font-semibold uppercase tracking-wide text-subtle">{COLUMN_LABEL[z]}</h3>
              {zoneList(ctx.doc, z).map((c) => <ComponentBlock key={c.id} ctx={ctx} c={c} draggable />)}
              <EndZone zone={z} />
            </div>
          ))}
        </div>
      </div>
      <DragOverlay>
        {dragged ? <div className="rounded-md border border-accent bg-surface px-3 py-2 text-base font-medium shadow-lg">{describe(dragged, ctx.env).name}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

function EndZone({ zone }: { zone: Column }) {
  const { setNodeRef, isOver } = useDroppable({ id: `end:${zone}` });
  return (
    <div ref={setNodeRef} className={cn("rounded-lg border-[1.5px] border-dashed border-line-strong p-3.5 text-center text-sm text-subtle", isOver && "border-accent bg-accent-soft")}>
      Drag a component here, or select one and use the arrow buttons
    </div>
  );
}

const blockClass = "relative rounded-lg border bg-surface";
const selectedClass = "border-accent ring-[3px] ring-accent-soft";

function Header({ ctx }: { ctx: EditorCtx }) {
  const { meta } = ctx.env;
  const names = shownKeyFacts(ctx);
  const explicit = ctx.doc.header.key_facts !== null;
  const selected = ctx.selected === HEADER_KEY;
  const set = (list: string[]) => ctx.edit((d) => ({ ...d, header: { key_facts: list } }));
  const options = meta.fields.filter((f) => eligibleKeyFact(f) && !names.includes(f.name));
  return (
    <section aria-label="Header" className={cn(blockClass, selected ? selectedClass : "border-line")}>
      <button type="button" aria-pressed={selected} onClick={() => ctx.select(HEADER_KEY)}
        className="flex w-full items-center gap-1.5 rounded-t-lg border-b border-line px-3 py-2 text-left text-sm font-semibold text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
        <span className="text-fg">Header</span><span className="font-normal">· title and key facts</span>
      </button>
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <div className="text-lg font-semibold"><bdi>{ctx.record?.display_name || meta.label}</bdi></div>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Key facts">
          {names.map((n) => {
            const f = meta.fields.find((x) => x.name === n);
            const hidden = ctx.preview?.hiddenFields.has(n);
            return (
              <li key={n} className={cn("inline-flex max-w-full items-center gap-1 rounded-full bg-surface-3 py-0.5 pl-2.5 pr-1 text-sm text-muted", hidden && "opacity-50")}>
                <span className={cn("min-w-0 truncate", hidden && "line-through")}>
                  {f?.label ?? n}{hidden ? <> · Hidden from {ctx.preview?.roleName}</> : ctx.record && f ? <>: <span className="font-medium text-fg"><FieldValue field={f} value={ctx.record[n]} record={ctx.record} meta={meta} /></span></> : null}
                </span>
                <button type="button" aria-label={`Remove ${f?.label ?? n} from the header`} onClick={() => set(names.filter((x) => x !== n))}
                  className="inline-flex size-5 items-center justify-center rounded-full text-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-focus"><X className="size-3" /></button>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          {names.length < LIMITS.keyFacts && options.length ? (
            <NativeSelect aria-label="Add a key fact" className="h-7 w-auto max-w-full text-sm" value="" onChange={(e) => e.target.value && set([...names, e.target.value])}>
              <option value="">+ Key fact</option>
              {options.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
            </NativeSelect>
          ) : null}
          <span className="text-xs text-subtle">{explicit ? `${names.length} of ${LIMITS.keyFacts} key facts` : "The page picks the key facts until you choose some."}</span>
        </div>
      </div>
    </section>
  );
}

function ComponentBlock({ ctx, c, draggable }: { ctx: EditorCtx; c: LayoutComponent; draggable: boolean }) {
  const d = describe(c, ctx.env);
  const selected = ctx.selected === c.id;
  const hidden = hiddenFrom(c, ctx.preview);
  const drag = useDraggable({ id: `blk:${c.id}`, disabled: !draggable });
  const drop = useDroppable({ id: `blk:${c.id}`, disabled: !draggable });
  const ref = (el: HTMLElement | null) => {
    drag.setNodeRef(el);
    drop.setNodeRef(el);
  };
  return (
    <section ref={ref} aria-label={d.name} className={cn(blockClass, selected ? selectedClass : "border-line hover:border-line-strong", drag.isDragging && "opacity-40", drop.isOver && !drag.isDragging && "border-accent")}>
      <div className="flex items-center rounded-t-lg border-b border-line">
        {draggable ? (
          <button type="button" ref={drag.setActivatorNodeRef} {...drag.listeners} {...drag.attributes} aria-label={`Drag ${d.name}`}
            className="ml-1 inline-flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-line-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">
            <GripVertical className="size-3.5" aria-hidden />
          </button>
        ) : null}
        <button type="button" aria-pressed={selected} onClick={() => ctx.select(c.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-2 text-left text-sm font-semibold text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus">
          <span className="truncate text-fg"><bdi>{d.name}</bdi></span><span className="shrink-0 font-normal">· {d.summary}</span>
        </button>
      </div>
      <div className="px-3.5 py-2.5">
        {c.type === "fields" ? <SectionBody ctx={ctx} c={c} /> : <p className="text-sm text-muted">{d.help}</p>}
        {hidden ? <p className="mt-2 text-sm text-subtle">Hidden from {ctx.preview?.roleName}: that role can't read these records.</p> : null}
      </div>
    </section>
  );
}

function SectionBody({ ctx, c }: { ctx: EditorCtx; c: Extract<LayoutComponent, { type: "fields" }> }): ReactNode {
  const { meta } = ctx.env;
  if (c.fields.length === 0) return <p className="text-sm text-muted">No fields yet. An empty section isn't shown on the page.</p>;
  return (
    <>
      {c.collapsed ? <Badge className="mb-1.5">Collapsed by default</Badge> : null}
      <dl className={cn("grid gap-x-4", c.columns === 2 ? "grid-cols-[repeat(2,minmax(0,1fr))]" : "grid-cols-[minmax(0,1fr)]")}>
        {c.fields.map((n) => {
          const f = meta.fields.find((x) => x.name === n);
          const hidden = ctx.preview?.hiddenFields.has(n) || (ctx.preview?.hiddenObjects.has(meta.name) ?? false);
          return (
            <div key={n} className={cn("flex min-w-0 justify-between gap-2 border-b border-dashed border-line py-1.5 text-sm last:border-b-0", hidden && "opacity-50")}>
              <dt className={cn("shrink-0 text-subtle", hidden && "line-through")}>{f?.label ?? n}</dt>
              <dd className="min-w-0 text-right">
                {hidden ? <span>Hidden from {ctx.preview?.roleName}</span> : ctx.record && f ? <FieldValue field={f} value={ctx.record[n]} record={ctx.record} meta={meta} /> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}
