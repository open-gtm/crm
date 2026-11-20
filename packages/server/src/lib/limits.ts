/**
 * Text lengths the request schemas share, so the same kind of thing has the same limit wherever it is
 * accepted. Limits that belong to one feature live with it (PACK_LIMITS in core/packs.ts, for one).
 */
export const TEXT_MAX = {
  /** A name or label a person reads: an object, field, pipeline, stage, automation or alert rule. */
  name: 200,
  description: 2_000,
  /** An object or field name as stored: a Postgres identifier, so 63. */
  identifier: 63,
  /** A field reference in a sort, column list or grouping; longer than an identifier since it may cross relations. */
  fieldPath: 200,
  /** A plan, confirm or cursor token the server issued and takes back. */
  token: 2_000,
} as const;
