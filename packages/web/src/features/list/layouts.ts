import type { FieldMeta, ObjectMeta, Where } from "@/lib/api/types";
import { visibleFields } from "@/meta/fields";

/**
 * The ways a list can be shown besides a plain table, and which fields each can use. All of it is
 * read from the object's metadata, so custom objects and fields get boards, calendars and grouping
 * with no change.
 */

const usable = (f: FieldMeta) => f.access !== "none" && f.sensitivity !== "restricted";

/** A board has one column per value of a select or status field. */
export const boardFields = (meta: ObjectMeta): FieldMeta[] =>
  visibleFields(meta).filter((f) => usable(f) && (f.type === "single_select" || f.type === "status") && (f.values?.length ?? 0) > 0);

const CREATED: FieldMeta = { name: "created_at", label: "Created", type: "datetime", read_only: true, access: "read" };

/** A calendar places records on the day of a date or date-time field; every object has when it was created. */
export const calendarFields = (meta: ObjectMeta): FieldMeta[] =>
  [...visibleFields(meta).filter((f) => usable(f) && (f.type === "date" || f.type === "datetime")), CREATED];

/** A table's rows can be grouped by a field with few distinct values: a select, a status, a yes/no, or a relation to one record. */
export const groupFields = (meta: ObjectMeta): FieldMeta[] =>
  visibleFields(meta).filter((f) => usable(f) && (f.type === "single_select" || f.type === "status" || f.type === "boolean" || f.type === "rating"
    || (f.type === "relation" && f.relation?.cardinality === "many_to_one")));

/** Number-like columns a group can total: sums of money, numbers and durations. */
export const totalFields = (meta: ObjectMeta, columns: string[]): FieldMeta[] =>
  columns.map((c) => meta.fields.find((f) => f.name === c)).filter((f): f is FieldMeta => Boolean(f) && usable(f!) && ["currency", "number", "duration"].includes(f!.type)).slice(0, 3);

/** The records whose `field` has this group key (null: no value). A relation's key is `{id}`. */
export function whereForKey(field: string, key: unknown): Where {
  if (key === null || key === undefined) return { field, op: "is_null", value: true };
  if (typeof key === "object") return { field, op: "eq", value: (key as { id: string }).id };
  return { field, op: "eq", value: key as string | number | boolean };
}

// --- Calendar dates ---------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

/** The first day of a month ("2027-03"), and of the month `by` months from it. */
export function monthStart(month: string, by = 0): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(y, m - 1 + by, 1);
}

/** The weeks of a month's grid, Monday first: every day shown, with the neighbouring months' days filling the first and last week. */
export function monthGrid(month: string): Date[][] {
  const first = monthStart(month);
  const start = new Date(first);
  start.setDate(1 - ((first.getDay() + 6) % 7));
  const weeks: Date[][] = [];
  for (let d = new Date(start); weeks.length < 6; ) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
    if (d.getMonth() !== first.getMonth() && d > first) break;
  }
  return weeks;
}

/** The day a record falls on: a date field's own day; a date-time's day in the reader's time zone. */
export function dayOf(field: FieldMeta, value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (field.type === "date") return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : ymd(d);
}

/** The records of a month: on or after its first day, before the next month's. Date-times use the reader's local midnight. */
export function whereForMonth(field: FieldMeta, month: string): Where {
  const [from, to] = [monthStart(month), monthStart(month, 1)];
  const bound = (d: Date) => (field.type === "date" ? ymd(d) : d.toISOString());
  return { and: [{ field: field.name, op: "gte", value: bound(from) }, { field: field.name, op: "lt", value: bound(to) }] };
}
