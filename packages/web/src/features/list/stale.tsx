import type { FieldMeta, ObjectMeta } from "@/lib/api/types";
import { Badge } from "@/components/ui/misc";

/** A deal with no activity for longer than this shows a quiet "Stale" pill. */
export const STALE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

/** Whole days since a date-time, or null when the value isn't one. */
export function daysSince(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY_MS);
}

/** Older than STALE_AFTER_DAYS. A deal with no recorded activity isn't called stale: nothing says how long it has been. */
export function isStale(value: unknown, now = Date.now()): boolean {
  if (typeof value !== "string") return false;
  const t = new Date(value).getTime();
  return !Number.isNaN(t) && now - t > STALE_AFTER_DAYS * DAY_MS;
}

/** The deal object's last-activity field, when the metadata has one this member can see. */
export function lastActivityField(meta: ObjectMeta): FieldMeta | undefined {
  return meta.name === "deal" ? meta.fields.find((f) => f.name === "last_activity_at" && f.type === "datetime" && f.access !== "none") : undefined;
}

export function StalePill({ value, now }: { value: unknown; now?: number }) {
  if (!isStale(value, now)) return null;
  const days = daysSince(value, now);
  return <Badge tone="warning" className="shrink-0">Stale<span className="sr-only">: no activity for {days} days</span></Badge>;
}
