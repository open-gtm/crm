import type { Tx } from "../db/pool.js";
import { ApiError, deadline, forbidden, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { assertObject, fieldAccess } from "./access.js";
import type { Ctx } from "./context.js";
import { Compiler, targetFor } from "./query.js";
import { fetchRows, serialize, type RecordOut } from "./records.js";
import { getObject, loadSchema, quoteIdent, type FieldMeta, type ObjectMeta } from "./schema.js";
import { limitFuzzyComparison } from "./queries/duplicates.js";

/**
 * The duplicate finder (POST /v1/objects/{object}/duplicates): groups of records that look like the
 * same thing, each with the reason it was grouped, as candidates for merge_records. Nothing changes.
 *
 * A rule is a list of fields; records whose normalized values are equal on every field of a rule form
 * a group (`exact` when the stored values are identical too). Optional fuzzy matching groups records
 * whose names are similar (pg_trgm), over a smaller window. Cost is bounded whatever the table's size:
 * only the newest DUPLICATE_SCAN records are examined (custom objects: most recently updated), groups
 * are capped, and every statement runs under the statement timeout and the request under the work budget.
 * Fuzzy matching compares every pair in its window, so it is bounded harder: only the first FUZZY_PREFIX
 * characters of each name, the trigram operator, and its own FUZZY_LIMITS timeout; past that it is refused
 * (422, with a hint) rather than holding a pooled connection. The route is also `heavy` (api/app.ts).
 *
 * Access: grouping on a field reveals which records share its value, so a rule may only use fields the
 * caller can read (a rule naming another field is refused; a default rule that would is skipped and
 * reported), restricted fields are never matched on, and the records are returned as the caller sees them.
 */

export const DUPLICATE_SCAN = 10_000;
export const FUZZY_SCAN = 1_000;
/** Characters of a name fuzzy matching compares: a longer name adds cost to every pair, not meaning. */
export const FUZZY_PREFIX = 48;
/** The fuzzy comparison's own statement timeout, well under the pool's 5 s. Mutable for tests. */
export const FUZZY_LIMITS = { timeoutMs: 1_500 };
const MAX_GROUPS = 200;
const MAX_MEMBERS = 25;
const MAX_PAIRS = 5_000;

const DEFAULT_RULES: Record<string, string[][]> = {
  contact: [["email"], ["first_name", "last_name", "account"]],
  account: [["domain"], ["name"]],
  lead: [["contact", "interest"]],
};
const FUZZY_NAME: Record<string, string[]> = { contact: ["first_name", "last_name"], account: ["name"] };

export interface DuplicateInput { rules?: string[][]; fuzzy?: boolean; min_similarity?: number; limit?: number }

class Done extends Error {
  constructor(readonly value: unknown) { super("done"); }
}

interface Group { rule: string[]; match: "exact" | "normalized" | "similar"; similarity?: number; ids: string[]; count: number; also?: Group[] }
const reasonOf = (g: Group) => ({ fields: g.rule, match: g.match, ...(g.similarity !== undefined ? { similarity: g.similarity } : {}) });

/** Company names compare without case, punctuation or a legal suffix: "Acme, Inc." and "ACME inc" are one. */
const companyName = (e: string) => `nullif(btrim(regexp_replace(regexp_replace(regexp_replace(lower(${e}), '[^a-z0-9]+', ' ', 'g'),
  '\\m(inc|incorporated|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|sa|ag|bv|pty)\\M', ' ', 'g'), '\\s+', ' ', 'g')), '')`;

/** The value a field is compared by: normalized so the same thing typed two ways matches. */
function normalized(obj: ObjectMeta, f: FieldMeta, e: string): string {
  if (obj.api_name === "account" && f.api_name === "domain") {
    return `nullif(split_part(regexp_replace(regexp_replace(lower(btrim(${e}::text)), '^https?://', ''), '^www\\.', ''), '/', 1), '')`;
  }
  if (obj.api_name === "account" && f.api_name === "name") return companyName(`${e}::text`);
  switch (f.type) {
    case "email": return `nullif(lower(btrim(${e}::text)), '')`;
    case "phone": return `nullif(regexp_replace(${e}::text, '\\D', '', 'g'), '')`;
    case "text": case "long_text": case "url": case "single_select": case "status":
      return `nullif(btrim(regexp_replace(lower(${e}::text), '\\s+', ' ', 'g')), '')`;
    // An address compares by all its parts, ignoring case and spacing (its JSON text lists them in a fixed order).
    case "address": return `nullif(regexp_replace(lower((${e})::text), '\\s+', ' ', 'g'), '')`;
    default: return `(${e})::text`;
  }
}

/** Checks a rule against the caller's access; returns why it can't be used, or null. Throws for a rule the caller named. */
function ruleProblem(ctx: Ctx, obj: ObjectMeta, rule: string[], explicit: boolean): string | null {
  for (const name of rule) {
    const f = obj.byName.get(name);
    if (!f) throw unprocessable(`"${name}" is not a field of ${obj.api_name}`);
    if (f.sensitivity === "restricted") throw unprocessable(`${obj.api_name}.${name} is restricted; restricted fields are never matched on`);
    if ((f.type === "relation" && !f.column_name) || f.type === "multi_select") throw unprocessable(`${obj.api_name}.${name} holds a list; match on single-valued fields`);
    // A json value can be 16 KB: comparing those across the scan window costs too much for what it finds.
    if (f.type === "json") throw unprocessable(`${obj.api_name}.${name} is a json field; json fields are never matched on`);
    if (fieldAccess(ctx, obj, f) === "none") {
      // Grouping by a field the caller can't read would show which records share its hidden value.
      if (explicit) throw forbidden(`This key can't read ${obj.api_name}.${name}, so it can't find duplicates by it`);
      return `this key can't read ${obj.api_name}.${name}`;
    }
  }
  return null;
}

export async function findDuplicates(tx: Tx, ctx: Ctx, objectName: string, input: DuplicateInput) {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  assertObject(ctx, obj, "read");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_GROUPS);
  const minSimilarity = input.min_similarity ?? 0.6;
  if (!(minSimilarity >= 0.3 && minSimilarity <= 1)) throw unprocessable("min_similarity must be between 0.3 and 1");
  if (input.rules !== undefined && (input.rules.length === 0 || input.rules.length > 5 || input.rules.some((r) => !Array.isArray(r) || r.length === 0 || r.length > 4))) {
    throw unprocessable("rules is a list of 1 to 5 rules, each a list of 1 to 4 field names");
  }
  const defaults = DEFAULT_RULES[obj.api_name] ?? (obj.display_field ? [[obj.display_field]] : []);
  const rules = input.rules ?? defaults;
  if (rules.length === 0 && !input.fuzzy) throw unprocessable(`${obj.plural_label} have no default duplicate rules; pass rules, e.g. [["name"]]`);
  const skipped: { rule: string[]; reason: string }[] = [];
  const usable = rules.filter((r) => {
    const problem = ruleProblem(ctx, obj, r, input.rules !== undefined);
    if (problem) skipped.push({ rule: r, reason: problem });
    return !problem;
  });
  const fuzzyFields = input.fuzzy ? FUZZY_NAME[obj.api_name] ?? (obj.display_field ? [obj.display_field] : []) : [];
  if (input.fuzzy && fuzzyFields.length === 0) throw unprocessable(`${obj.plural_label} have no name field to compare; set the object's display_field`);
  if (input.fuzzy) ruleProblem(ctx, obj, fuzzyFields, true);

  const check = deadline(WORK_BUDGET_MS.bulk, "Finding duplicates");
  const t = targetFor(schema, obj.api_name);
  const window = (n: number) => `SELECT * FROM ${quoteIdent(obj.table_name ?? "records")} WHERE archived_at IS NULL${obj.is_system ? "" : " AND object_id = $1"}
    ORDER BY ${obj.is_system ? "id" : "updated_at"} DESC LIMIT ${n}`;
  const params = obj.is_system ? [] : [obj.id];
  const groups: Group[] = [];
  for (const rule of usable) {
    check();
    const c = new Compiler(schema);
    const exprs = rule.map((name) => c.expr("r", t.fields.get(name)!));
    const keys = rule.map((name, i) => `${normalized(obj, obj.byName.get(name)!, exprs[i]!)} AS k${i}`);
    // eslint-disable-next-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
    const rows = await tx.unsafe<{ ids: string[]; n: number; exact: boolean }[]>(`
      WITH k AS (SELECT r.id, ${keys.join(", ")}, jsonb_build_array(${exprs.map((e) => `(${e})::text`).join(", ")}) AS raw FROM (${window(DUPLICATE_SCAN)}) r)
      SELECT (array_agg(id ORDER BY id))[1:${MAX_MEMBERS}] AS ids, count(*)::int AS n, count(DISTINCT raw) = 1 AS exact, min(id::text) AS first
      FROM k WHERE ${rule.map((_, i) => `k${i} IS NOT NULL`).join(" AND ")} GROUP BY ${rule.map((_, i) => `k${i}`).join(", ")} HAVING count(*) > 1
      ORDER BY n DESC, first LIMIT ${limit + 1}`, params as never[]);
    for (const r of rows) groups.push({ rule, match: r.exact ? "exact" : "normalized", ids: r.ids, count: r.n });
  }
  if (input.fuzzy) {
    check();
    const c = new Compiler(schema);
    const parts = fuzzyFields.map((name) => c.expr("r", t.fields.get(name)!));
    const full = obj.api_name === "account" ? companyName(parts[0]!) : `lower(btrim(concat_ws(' ', ${parts.join(", ")})))`;
    const name = `left(${full}, ${FUZZY_PREFIX})`;
    let pairs: { a: string; b: string; s: number }[];
    try {
      // In a savepoint that is always rolled back: the lower timeout and the threshold end with it, and a timeout leaves the transaction usable.
      await tx.savepoint(async (sp) => {
        await limitFuzzyComparison(sp, String(FUZZY_LIMITS.timeoutMs), String(minSimilarity));
        // eslint-disable-next-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
        throw new Done(await sp.unsafe<{ a: string; b: string; s: number }[]>(`
          WITH n AS MATERIALIZED (SELECT r.id, ${name} AS nm FROM (${window(FUZZY_SCAN)}) r)
          SELECT x.id AS a, y.id AS b, similarity(x.nm, y.nm)::float8 AS s FROM n x JOIN n y ON x.id < y.id AND x.nm % y.nm
          WHERE length(x.nm) >= 3 AND length(y.nm) >= 3
          ORDER BY s DESC, x.id, y.id LIMIT ${MAX_PAIRS}`, params as never[]));
      });
      throw new Error("unreachable");
    } catch (e) {
      if (e instanceof Done) pairs = e.value as typeof pairs;
      else if ((e as { code?: string }).code === "57014") {
        throw new ApiError(422, "too_slow", `Comparing similar names took longer than ${FUZZY_LIMITS.timeoutMs / 1000} s, so it was stopped. `
          + "Raise min_similarity (e.g. 0.7), or find exact duplicates with rules instead of fuzzy");
      } else throw e;
    }
    groups.push(...similarGroups(pairs, fuzzyFields));
  }

  // One group per set of records: the first rule to find it is its reason, later ones are listed in `also`. Rule order, largest first.
  const bySet = new Map<string, Group>();
  const unique = groups.filter((g) => {
    const key = [...g.ids].sort().join(",");
    const first = bySet.get(key);
    if (first) (first.also ??= []).push(g);
    else bySet.set(key, g);
    return !first;
  });
  const shown = unique.slice(0, limit);
  const ids = [...new Set(shown.flatMap((g) => g.ids))];
  const records = new Map<string, RecordOut>();
  if (ids.length) {
    const rows = await fetchRows(tx, obj, ids);
    const out = await serialize(tx, ctx, schema, obj, rows);
    rows.forEach((r, i) => records.set(r.id, out[i]!));
  }
  const [scanned] = await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (${window(DUPLICATE_SCAN + 1)}) r`, params as never[]); // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
  return {
    object: obj.api_name,
    scanned: Math.min(scanned!.n, DUPLICATE_SCAN),
    window_full: scanned!.n > DUPLICATE_SCAN,
    ...(input.fuzzy ? { fuzzy_scanned: Math.min(scanned!.n, FUZZY_SCAN) } : {}),
    groups: shown.map((g) => ({
      reason: { ...reasonOf(g), ...(g.also ? { also: g.also.map(reasonOf) } : {}) },
      count: g.count,
      records: g.ids.map((id) => records.get(id)!).filter(Boolean),
    })),
    more_groups: unique.length > limit,
    ...(skipped.length ? { skipped_rules: skipped } : {}),
  };
}

/** Connected groups of similar pairs, each with the lowest similarity that joined it. Deterministic: pairs come sorted. */
function similarGroups(pairs: { a: string; b: string; s: number }[], fields: string[]): Group[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const { a, b } of pairs) {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  }
  const byRoot = new Map<string, { ids: Set<string>; min: number }>();
  for (const { a, b, s } of pairs) {
    const g = byRoot.get(find(a)) ?? { ids: new Set<string>(), min: 1 };
    g.ids.add(a).add(b);
    g.min = Math.min(g.min, s);
    byRoot.set(find(a), g);
  }
  return [...byRoot.values()]
    .map((g) => ({ rule: fields, match: "similar" as const, similarity: Math.round(g.min * 100) / 100, ids: [...g.ids].sort().slice(0, MAX_MEMBERS), count: g.ids.size }))
    .sort((x, y) => y.count - x.count || (x.ids[0]! < y.ids[0]! ? -1 : 1));
}
