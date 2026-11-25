/**
 * Query cache keys. Everything about an object's records sits under ["records", object], so one
 * invalidation after a write refreshes its lists, records, related lists and board totals; a single
 * record is ["records", object, "record", id]. Metadata is under ["meta"].
 */
export const qk = {
  session: ["session"] as const,
  prefs: ["prefs"] as const,
  objects: ["meta", "objects"] as const,
  describe: (o: string) => ["meta", "describe", o] as const,
  pipelines: ["meta", "pipelines"] as const,
  records: (o: string) => ["records", o] as const,
  list: (o: string, params: unknown) => ["records", o, "list", params] as const,
  record: (o: string, id: string) => ["records", o, "record", id] as const,
  related: (o: string, params: unknown) => ["records", o, "related", params] as const,
  aggregate: (o: string, params: unknown) => ["records", o, "aggregate", params] as const,
  board: (params: unknown) => ["records", "deal", "board", params] as const,
  timeline: (id: string) => ["timeline", id] as const,
  files: (id: string) => ["files", id] as const,
  views: (o: string) => ["views", o] as const,
  users: (q: string) => ["users", q] as const,
  search: (q: string, objects?: string) => ["search", q, objects ?? ""] as const,
  myTasks: ["records", "task", "mine"] as const,
  attention: ["inbox", "attention"] as const,
  notifications: (state: string) => ["inbox", "notifications", state] as const,
  notificationPrefs: ["inbox", "prefs"] as const,
  admin: (what: string, ...rest: unknown[]) => ["admin", what, ...rest] as const,
};
