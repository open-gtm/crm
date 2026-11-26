import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Switch } from "@/components/ui/misc";
import type { LayoutComponent } from "@/features/record/pageLayout";
import { shownKeyFacts } from "./Canvas";
import { statusFields } from "./Library";
import { COLUMNS, describe, findComponent, HEADER_KEY, LIMITS, locate, moveAcross, moveWithin, removeComponent, updateComponent, type EditorCtx } from "./model";

const moved = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

/**
 * A text box that saves once, not per key: when it loses focus, on Enter, or after a pause in typing. What the
 * server last said fills it again whenever the person isn't typing in it.
 */
function CommitInput({ value, onCommit, ...props }: { value: string; onCommit: (v: string) => void; "aria-label"?: string; id?: string; maxLength?: number; "aria-describedby"?: string; "aria-invalid"?: boolean }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const commit = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    const t = v.trim();
    if (t && t !== value) onCommit(t);
  };
  return (
    <Input {...props} value={text}
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        setText(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = setTimeout(() => commit(v), 700);
      }}
      onBlur={() => {
        focused.current = false;
        commit(text);
        if (!text.trim()) setText(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(text);
      }} />
  );
}

/** A whole-number box with the same save-once behaviour, kept inside its limits. */
function CommitNumber({ value, min, max, onCommit, ...props }: { value: number; min: number; max: number; onCommit: (n: number) => void; id?: string; "aria-describedby"?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const valid = (v: string) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max;
  const commit = (v: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (valid(v) && Number(v) !== value) onCommit(Number(v));
  };
  return (
    <Input {...props} type="number" inputMode="numeric" min={min} max={max} step={1} value={text} className="w-24"
      onFocus={() => { focused.current = true; }}
      onChange={(e) => {
        setText(e.target.value);
        if (timer.current) clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = setTimeout(() => commit(v), 700);
      }}
      onBlur={() => {
        focused.current = false;
        commit(text);
        if (!valid(text)) setText(String(value));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(text);
      }} />
  );
}

const FOOTNOTE = "A layout arranges; it never grants access. A field someone's role can't read stays hidden wherever it's placed.";

/** The selected block: what it is, the buttons that move or remove it, and its settings. */
export function Properties({ ctx }: { ctx: EditorCtx }) {
  const c = ctx.selected && ctx.selected !== HEADER_KEY ? findComponent(ctx.doc, ctx.selected) : undefined;
  return (
    <div className="flex flex-col gap-3.5 p-4">
      {ctx.selected === HEADER_KEY ? <HeaderProps ctx={ctx} /> : c ? <ComponentProps ctx={ctx} c={c} /> : (
        <p className="text-base text-muted">Select a block on the page to change it. Everything here can be done with the buttons, without dragging.</p>
      )}
      <p className="flex gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-muted">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
        <span>{FOOTNOTE}</span>
      </p>
    </div>
  );
}

function HeaderProps({ ctx }: { ctx: EditorCtx }) {
  const names = shownKeyFacts(ctx);
  const explicit = ctx.doc.header.key_facts !== null;
  const label = (n: string) => ctx.env.meta.fields.find((f) => f.name === n)?.label ?? n;
  const set = (list: string[] | null) => ctx.edit((d) => ({ ...d, header: { key_facts: list } }));
  return (
    <>
      <Badge tone="accent" className="self-start">Header</Badge>
      <p className="text-base text-muted">The title and up to {LIMITS.keyFacts} key facts. Add a key fact from the header on the page.</p>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Key facts, in order</p>
        {names.length === 0 ? <p className="text-sm text-muted">None. The header shows only the title.</p> : names.map((n, i) => (
          <div key={n} className="flex items-center gap-1.5 rounded-md border border-line bg-surface py-1 pl-2 pr-1 text-base">
            <span className="min-w-0 flex-1 truncate"><bdi>{label(n)}</bdi></span>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${label(n)} up`} disabled={i === 0} onClick={() => set(moved(names, i, -1))}><ArrowUp /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${label(n)} down`} disabled={i === names.length - 1} onClick={() => set(moved(names, i, 1))}><ArrowDown /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${label(n)} from the header`} onClick={() => set(names.filter((x) => x !== n))}><X /></Button>
          </div>
        ))}
      </div>
      {explicit ? <Button size="sm" className="self-start" onClick={() => set(null)}>Let the page pick the key facts</Button> : <p className="text-sm text-subtle">The page picks these (a status, money, the owner) until you change them.</p>}
    </>
  );
}

function ComponentProps({ ctx, c }: { ctx: EditorCtx; c: LayoutComponent }) {
  const d = describe(c, ctx.env);
  const at = locate(ctx.doc, c.id);
  const inColumn = at !== null && at.zone !== "top";
  const col = at && at.zone !== "top" ? COLUMNS.indexOf(at.zone) : -1;
  const count = at ? (at.zone === "top" ? ctx.doc.top : ctx.doc.columns[at.zone]).length : 0;
  const update = (fn: (c: LayoutComponent) => LayoutComponent) => ctx.edit((doc) => updateComponent(doc, c.id, fn));
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{d.kind}</Badge>
        <div className="ml-auto flex gap-1" role="group" aria-label="Move or remove">
          {inColumn ? (
            <>
              <Button size="icon-sm" aria-label="Move up" disabled={at.index === 0} onClick={() => ctx.edit((doc) => moveWithin(doc, c.id, -1))}><ArrowUp /></Button>
              <Button size="icon-sm" aria-label="Move down" disabled={at.index === count - 1} onClick={() => ctx.edit((doc) => moveWithin(doc, c.id, 1))}><ArrowDown /></Button>
              <Button size="icon-sm" aria-label="Move to the column on the left" disabled={col === 0} onClick={() => ctx.edit((doc) => moveAcross(doc, c.id, -1))}><ArrowLeft /></Button>
              <Button size="icon-sm" aria-label="Move to the column on the right" disabled={col === COLUMNS.length - 1} onClick={() => ctx.edit((doc) => moveAcross(doc, c.id, 1))}><ArrowRight /></Button>
            </>
          ) : null}
          <Button size="icon-sm" variant="danger-ghost" aria-label="Remove from page" onClick={() => {
            ctx.edit((doc) => removeComponent(doc, c.id));
            ctx.select(null);
          }}><Trash2 /></Button>
        </div>
      </div>
      {c.type === "fields" ? <SectionProps ctx={ctx} c={c} update={update} /> : (
        <>
          <p className="text-base text-muted">{d.help}</p>
          {c.type === "related" || c.type === "tasks" || c.type === "quotes" ? (
            <FormField label="Rows shown" hint={`1 to ${LIMITS.rows}`}>
              {(p) => <CommitNumber {...p} value={c.rows} min={1} max={LIMITS.rows} onCommit={(rows) => update((x) => ({ ...x, rows }) as LayoutComponent)} />}
            </FormField>
          ) : null}
          {c.type === "agent_changes" ? (
            <FormField label="Days of changes" hint={`1 to ${LIMITS.days}`}>
              {(p) => <CommitNumber {...p} value={c.days} min={1} max={LIMITS.days} onCommit={(days) => update((x) => ({ ...x, days }) as LayoutComponent)} />}
            </FormField>
          ) : null}
          {c.type === "stage_path" ? <StageProps ctx={ctx} c={c} update={update} /> : null}
        </>
      )}
    </>
  );
}

function StageProps({ ctx, c, update }: { ctx: EditorCtx; c: Extract<LayoutComponent, { type: "stage_path" }>; update: (fn: (c: LayoutComponent) => LayoutComponent) => void }) {
  const isDeal = ctx.env.meta.name === "deal";
  const fields = statusFields(ctx);
  // A deal's path follows its pipeline unless a status field is chosen; any other object needs a status field.
  if (!isDeal && fields.length <= 1) return null;
  return (
    <FormField label="Follows">
      {(p) => (
        <NativeSelect {...p} value={c.field ?? ""} onChange={(e) => update((x) => ({ ...x, field: e.target.value || null }) as LayoutComponent)}>
          {isDeal ? <option value="">The deal's pipeline</option> : null}
          {fields.map((f) => <option key={f.name} value={f.name}>{f.label}</option>)}
        </NativeSelect>
      )}
    </FormField>
  );
}

function SectionProps({ ctx, c, update }: { ctx: EditorCtx; c: Extract<LayoutComponent, { type: "fields" }>; update: (fn: (c: LayoutComponent) => LayoutComponent) => void }): ReactNode {
  const label = (n: string) => ctx.env.meta.fields.find((f) => f.name === n)?.label ?? n;
  const setFields = (fields: string[]) => update((x) => ({ ...x, fields }) as LayoutComponent);
  return (
    <>
      <FormField label="Section name">
        {(p) => <CommitInput {...p} maxLength={80} value={c.name} onCommit={(name) => update((x) => ({ ...x, name }) as LayoutComponent)} />}
      </FormField>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium text-muted">Columns</legend>
        <div className="inline-flex self-start rounded-lg bg-surface-3 p-0.5">
          {([1, 2] as const).map((n) => (
            <label key={n} className="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-base font-medium text-muted has-[:checked]:bg-surface has-[:checked]:text-fg has-[:checked]:shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
              <input type="radio" name={`${c.id}-columns`} className="sr-only" checked={c.columns === n} onChange={() => update((x) => ({ ...x, columns: n }) as LayoutComponent)} />
              {n === 1 ? "One" : "Two"}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-2.5 text-base">
        <label htmlFor={`${c.id}-collapsed`} className="flex-1">Collapsed by default</label>
        <Switch id={`${c.id}-collapsed`} checked={c.collapsed} onCheckedChange={(collapsed) => update((x) => ({ ...x, collapsed }) as LayoutComponent)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Fields, in order</p>
        {c.fields.length === 0 ? <p className="text-sm text-muted">No fields yet. Add them from “Fields not on the page”.</p> : c.fields.map((n, i) => (
          <div key={n} className="flex items-center gap-1.5 rounded-md border border-line bg-surface py-1 pl-2 pr-1 text-base">
            <span className="min-w-0 flex-1 truncate"><bdi>{label(n)}</bdi></span>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${label(n)} up`} disabled={i === 0} onClick={() => setFields(moved(c.fields, i, -1))}><ArrowUp /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Move ${label(n)} down`} disabled={i === c.fields.length - 1} onClick={() => setFields(moved(c.fields, i, 1))}><ArrowDown /></Button>
            <Button size="icon-sm" variant="ghost" aria-label={`Take ${label(n)} off the page`} onClick={() => setFields(c.fields.filter((x) => x !== n))}><X /></Button>
          </div>
        ))}
      </div>
    </>
  );
}
