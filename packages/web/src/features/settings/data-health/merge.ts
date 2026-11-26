import type { FieldMeta, ObjectMeta, RecordData } from "@/lib/api/types";
import { canWrite, isRestrictedValue, visibleFields } from "@/meta/fields";
import type { DuplicateGroup } from "./types";

/** A merge keeps one survivor and takes at most this many duplicates (the server's MERGE_MAX_DUPLICATES is 10). */
export const MERGE_MAX_RECORDS = 11;

export const isBlank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
export const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The records of a group that one merge can take: the group's own order, at most 11. A group can hold
 * more (the server lists up to 25), and then the rest are for a second pass after this merge.
 */
export const mergeRecordsOf = (g: DuplicateGroup): RecordData[] => g.records.slice(0, MERGE_MAX_RECORDS);

/** Fields a choice can be made for: the ones this member may change on an existing record (the server refuses a choice for any other). */
export const choosableFields = (meta: ObjectMeta): FieldMeta[] => visibleFields(meta).filter((f) => canWrite(f, meta.access, "edit"));

/** The survivor a merge starts with: the record created first, else the first one the server listed. */
export function defaultSurvivor(records: RecordData[]): string {
  let best = records[0]!;
  for (const r of records) {
    if (typeof r.created_at === "string" && (typeof best.created_at !== "string" || r.created_at < best.created_at)) best = r;
  }
  return best.id;
}

/**
 * Whose value the merge keeps for a field when nobody chooses, exactly as the server does it: the
 * survivor's, unless it is empty, then the first duplicate (in the order given) that has one. A value
 * the server masks for this member is never a source to fill from.
 */
export function defaultSource(field: FieldMeta, survivor: RecordData, duplicates: RecordData[]): string {
  if (!isBlank(survivor[field.name])) return survivor.id;
  const from = duplicates.find((d) => !isBlank(d[field.name]) && !isRestrictedValue(d[field.name]));
  return from?.id ?? survivor.id;
}

/** The merge's `fields` map: only the fields where the choice differs from what the server would do by itself. */
export function chosenFields(fields: FieldMeta[], survivor: RecordData, duplicates: RecordData[], picks: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const pick = picks[f.name];
    if (pick && pick !== defaultSource(f, survivor, duplicates)) out[f.name] = pick;
  }
  return out;
}

/**
 * The groups still worth reviewing after a merge: records merged away are gone from every group, the
 * survivor shows its new values, and a group left with fewer than two records is finished.
 */
export function afterMerge(groups: DuplicateGroup[], survivor: RecordData, merged: string[]): DuplicateGroup[] {
  const gone = new Set(merged);
  return groups
    .map((g) => {
      const records = g.records.filter((r) => !gone.has(r.id)).map((r) => (r.id === survivor.id ? { ...r, ...survivor } : r));
      return { ...g, records, count: records.length };
    })
    .filter((g) => g.records.length >= 2);
}
