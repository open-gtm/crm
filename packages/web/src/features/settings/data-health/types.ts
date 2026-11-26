import type { RecordData } from "@/lib/api/types";

/** Why a group of records was put together: the fields that matched, and how closely. */
export interface DuplicateReason { fields: string[]; match: "exact" | "normalized" | "similar"; similarity?: number }

/** One group of possible duplicates, the records as this member may see them. */
export interface DuplicateGroup { reason: DuplicateReason & { also?: DuplicateReason[] }; count: number; records: RecordData[] }

/** The answer of POST /v1/objects/{object}/duplicates. */
export interface DuplicatesAnswer {
  object: string;
  /** Records the scan looked at (the newest ones, up to a limit). */
  scanned: number;
  /** More records exist than the scan looked at, so some duplicates may not be found. */
  window_full: boolean;
  groups: DuplicateGroup[];
  /** More groups were found than were returned. */
  more_groups: boolean;
  skipped_rules?: { rule: string[]; reason: string }[];
}

/** What a merge would do (or did): POST /v1/ops/merge_records. */
export interface MergeChange { field: string; before: unknown; after: unknown; from: string }
export interface MergeReference { object: string; field: string; moved: number; archived: number; dropped: number; cleared: number }
export interface MergeAnswer {
  dry_run: boolean;
  survivor: RecordData;
  merged: string[];
  changes?: MergeChange[];
  references?: MergeReference[];
  not_filled?: { field: string; reason: string }[];
  confirm_token?: string;
}
