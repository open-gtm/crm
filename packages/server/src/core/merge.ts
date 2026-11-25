import type { Tx } from "../db/pool.js";
import { asPreview } from "../db/tx.js";
import { canonicalJson, sha256 } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, deadline, forbidden, notFound, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { assertObject, canObject, fieldAccess, internalReader } from "./access.js";
import { audit } from "./audit.js";
import { issueConfirm, readConfirm, spendConfirm } from "./confirm.js";
import { can, withRestricted, type Ctx } from "./context.js";
import { encryptValue } from "./encryption.js";
import { emit } from "./events.js";
import { fetchRows, getRecord, serialize, updateRecord, type RecordOut } from "./records.js";
import { isModuleOn, loadSchema, quoteIdent, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";
import {
  archiveMergedRecords, bumpLinkHolders, countAlertReferences, countReferenceRows, dropDuplicateDeadlines, insertMerge, lockMerges, mergedInto,
  moveDeadlines, moveGuardedReferences, moveNotifications, resolveDuplicateNotifications, runReferenceStatement, type ReferenceRow,
} from "./queries/merge.js";
import { countFilesOf, moveFiles } from "./queries/files.js";

/**
 * Merging duplicate records (POST /v1/ops/merge_records). One survivor takes the duplicates' place:
 *
 * - Field values: an explicit per-field choice (`fields: {name: record ID}`), otherwise the survivor
 *   wins and its blank fields are filled from the duplicates, in the order given. Values change through
 *   updateRecord, so validation, unique values, status transitions, hooks, events and audit are those of
 *   a normal update. Only fields the caller can read and write are filled (and relations only to objects
 *   it can read); restricted values only with restricted:read. So a merge never moves a value the caller
 *   can't read, and the diff shows none.
 * - References: every reference to a duplicate moves to the survivor, as REFERENCES says column by
 *   column (a test fails when a foreign key into a mergeable table is not listed there, so a new table
 *   can't be re-pointed, or missed, without a decision). Plus alert state and notifications, which hold
 *   record IDs without a foreign key. A row that would duplicate one the survivor already has is dropped
 *   (links) or archived (records), never left as a second copy. This is platform bookkeeping: it happens
 *   on objects the caller can't write too, since a reference left on an archived record would be a
 *   dangling one, and the result names only what the caller can read. Every record whose reference moved
 *   gets a version bump and its normal `<object>.updated` event, marked `reference_move` (IDs only).
 * - Bounded: at most MERGE_MAX_REFERENCES rows move in one merge (else it is refused before anything
 *   changes), statements are set-based (a fixed number per referencing column), and the work budget is
 *   checked between them. Merges in one workspace run one at a time (an advisory lock), so two can't deadlock.
 * - Confirmation: a real run needs the confirm_token of its dry run, which binds the survivor, the
 *   duplicates, the field choices and every record's version, so it applies only to what was previewed.
 * - Duplicates are archived with a pointer to the survivor (`merges`), so a merged ID still resolves:
 *   reading it shows `merged_into` (the final survivor, through later merges).
 * - Everything is one transaction. `merges` keeps which fields came from which record, the survivor's
 *   previous values (encrypted) and every row that moved, enough to build an unmerge (not built).
 */

export const MERGE_MAX_DUPLICATES = 10;
/** Rows one merge may re-point (references, links, alert state, notifications). Each moved record gets an event, so this also bounds a merge's events. */
export const MERGE_MAX_REFERENCES = 1_000;
const MERGEABLE_STANDARD = new Set(["contact", "account", "lead"]);

/**
 * What a merge does with each column that references a mergeable table:
 *   move    re-point it to the survivor;
 *   dedupe  re-point it, but a row that would become a second copy of one the survivor (or an earlier
 *           duplicate) has, under `unique` (+ `live`: a partial unique index), is archived (a record row)
 *           or deleted (a link row);
 *   refuse  a row here stops the merge (`refusal` says why);
 *   own     not a reference: the column says which record a row belongs to (a duplicate's own values).
 * A row is either a record (`object`; it is bumped and evented itself) or a link that belongs to the
 * record in `via` (`object` and `field` name it; record links take both from their field).
 * `guarded` rows are protected by triggers (converted leads, history activities) and move only through
 * app.merge_move (migration 013). `self` is what happens when the holder is the survivor itself.
 */
export type RefPolicy = "move" | "dedupe" | "refuse" | "own";
export interface Reference {
  table: string;
  column: string;
  into: "contacts" | "accounts" | "leads" | "record_registry";
  policy: RefPolicy;
  object?: string;
  via?: string;
  field?: string;
  keys?: string[];
  unique?: string[];
  live?: "unarchived" | "current";
  guarded?: true;
  self?: "clear" | "drop";
  clearPrimary?: true;
  refusal?: string;
}

export const REFERENCES: Reference[] = [
  { table: "accounts", column: "parent_account_id", into: "accounts", policy: "move", object: "account", self: "clear" },
  { table: "contacts", column: "primary_account_id", into: "accounts", policy: "move", object: "contact" },
  { table: "deals", column: "account_id", into: "accounts", policy: "move", object: "deal" },
  { table: "leads", column: "account_id", into: "accounts", policy: "move", object: "lead", guarded: true },
  { table: "account_contacts", column: "account_id", into: "accounts", policy: "dedupe", object: "account_contact", unique: ["contact_id"], live: "current" },
  // A duplicate's account links are not primary: the survivor's own primary account decides.
  { table: "account_contacts", column: "contact_id", into: "contacts", policy: "dedupe", object: "account_contact", unique: ["account_id"], live: "current", clearPrimary: true },
  { table: "activities", column: "actor_contact_id", into: "contacts", policy: "move", object: "activity", guarded: true },
  { table: "deal_contacts", column: "contact_id", into: "contacts", policy: "dedupe", object: "deal_contact", unique: ["deal_id", "role"], live: "unarchived" },
  { table: "deals", column: "primary_contact_id", into: "contacts", policy: "move", object: "deal" },
  { table: "leads", column: "contact_id", into: "contacts", policy: "move", object: "lead", guarded: true },
  { table: "deals", column: "source_lead_id", into: "leads", policy: "refuse", object: "deal",
    refusal: "is the source of a deal (it was converted); a converted lead can only be the survivor of a merge" },
  { table: "activity_associations", column: "record_id", into: "record_registry", policy: "dedupe", via: "activity_id", object: "activity", field: "related_to",
    keys: ["activity_id", "record_id"], unique: ["activity_id"] },
  { table: "task_associations", column: "record_id", into: "record_registry", policy: "dedupe", via: "task_id", object: "task", field: "related_to",
    keys: ["task_id", "record_id"], unique: ["task_id"] },
  { table: "record_links", column: "to_id", into: "record_registry", policy: "dedupe", via: "from_id", keys: ["field_id", "from_id", "to_id"],
    unique: ["field_id", "from_id"], self: "drop" },
  { table: "record_links", column: "from_id", into: "record_registry", policy: "own" },
  { table: "records", column: "id", into: "record_registry", policy: "own" },
  { table: "merges", column: "survivor_id", into: "record_registry", policy: "own" },
  // Quotes and orders name their customer of record. A merge re-points them; what a sent quote said stays in its snapshot.
  { table: "quotes", column: "account_id", into: "accounts", policy: "move", object: "quote" },
  { table: "quotes", column: "contact_id", into: "contacts", policy: "move", object: "quote" },
  { table: "orders", column: "account_id", into: "accounts", policy: "move", object: "order" },
  { table: "orders", column: "contact_id", into: "contacts", policy: "move", object: "order" },
  // A file belongs to its record. A merge moves the duplicates' files to the survivor with a statement of its own
  // (moveFiles, below, like alert state), so every document is kept: files are not values the survivor could already have.
  { table: "files", column: "record_id", into: "record_registry", policy: "own" },
];

/** Tables whose rows app.merge_move changes (migration 013): the immutability triggers allow it only there. */
const GUARDED_TABLES = ["leads", "activities"] as const;

export interface MergeInput { survivor: string; duplicates: string[]; fields?: Record<string, string>; expected_version?: number; confirm_token?: string }

interface MovedRow { k: string[]; from: string; holder: string }
interface Moved { table: string; column: string; moved: MovedRow[]; dropped: MovedRow[]; archived: MovedRow[]; cleared: MovedRow[] }
type Found = ReferenceRow[];

/**
 * The statements for one reference, built from identifiers only: every table and column name goes
 * through quoteIdent, everything else is a literal, and every value is bound: $1 the survivor, $2 the
 * duplicates, and for a record row (which gets a version bump) $3 the actor. Each names the tenant
 * explicitly as well as through row-level security.
 * Each returns the holder (h), the duplicate the row pointed at (old) and the row's key (k).
 */
function statements(r: Reference) {
  const T = quoteIdent(r.table);
  const C = quoteIdent(r.column);
  const holder = r.via ? quoteIdent(r.via) : "id";
  const keys = `jsonb_build_array(${(r.keys ?? ["id"]).map((k) => `t.${quoteIdent(k)}::text`).join(", ")})`;
  const back = ` RETURNING t.${holder}::text AS h, o.old::text AS old, ${keys} AS k`;
  const bump = r.via ? "" : ", version = t.version + 1, updated_by = $3";
  const primary = r.clearPrimary ? ", is_primary = false" : "";
  const live = `${r.live ? " AND x.archived_at IS NULL" : ""}${r.live === "current" ? " AND x.end_date IS NULL" : ""}`;
  // Rows that belong to a duplicate hold its own values; the survivor's own row is `self`.
  const notOwn = ` AND NOT x.${holder} = ANY ($2::uuid[]) AND x.${holder} <> $1`;
  const match = (r.via ? [...r.unique!, r.column] : ["id"]).map((k) => `t.${quoteIdent(k)} = o.${quoteIdent(k)}`).join(" AND ");
  const pick = (r.via ? [...r.unique!, r.column] : ["id"]).map((k) => `x.${quoteIdent(k)}`).join(", ");
  const ranked = `SELECT ${pick}, x.${C} AS old, row_number() OVER (PARTITION BY ${(r.unique ?? []).map((u) => `x.${quoteIdent(u)}`).join(", ")}
      ORDER BY (x.${C} = $1) DESC, array_position($2::uuid[], x.${C}), x.${C}) AS n
    FROM ${T} x WHERE x.tenant_id = app.tenant_id() AND (x.${C} = $1 OR x.${C} = ANY ($2::uuid[]))${live}${notOwn}`;
  return {
    count: `SELECT count(*)::int AS n FROM ${T} x WHERE x.tenant_id = app.tenant_id() AND x.${C} = ANY ($1::uuid[])`,
    // The survivor's own reference to a duplicate would point at itself: cleared (a record's column) or dropped (a link).
    self: r.self === "clear"
      ? `UPDATE ${T} t SET ${C} = NULL${bump} FROM (SELECT x.id, x.${C} AS old FROM ${T} x WHERE x.tenant_id = app.tenant_id() AND x.id = $1 AND x.${C} = ANY ($2::uuid[])) o
         WHERE t.tenant_id = app.tenant_id() AND ${match}${back}`
      : `DELETE FROM ${T} t USING (SELECT ${pick}, x.${C} AS old FROM ${T} x WHERE x.tenant_id = app.tenant_id() AND x.${holder} = $1 AND x.${C} = ANY ($2::uuid[])) o
         WHERE t.tenant_id = app.tenant_id() AND ${match}${back}`,
    // A second copy of a row the survivor (or an earlier duplicate) already has: a record row is archived and moved, a link deleted.
    dedupe: r.via
      ? `DELETE FROM ${T} t USING (${ranked}) o WHERE t.tenant_id = app.tenant_id() AND ${match} AND o.n > 1 AND o.old <> $1${back}`
      : `UPDATE ${T} t SET archived_at = now(), ${C} = $1${bump}${primary} FROM (${ranked}) o
         WHERE t.tenant_id = app.tenant_id() AND ${match} AND o.n > 1 AND o.old <> $1${back}`,
    move: `UPDATE ${T} t SET ${C} = $1${bump}${primary}
      FROM (SELECT ${pick}, x.${C} AS old FROM ${T} x WHERE x.tenant_id = app.tenant_id() AND x.${C} = ANY ($2::uuid[])${notOwn}) o
      WHERE t.tenant_id = app.tenant_id() AND ${match}${back}`,
  };
}

/** A version bump for records whose relation (a link row) moved, in a table that isn't guarded. */
const bumpSql = (table: string) =>
  `UPDATE ${quoteIdent(table)} t SET version = t.version + 1, updated_by = $2 WHERE t.tenant_id = app.tenant_id() AND t.id = ANY ($1::uuid[])`;

const blank = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Why a merge can't fill a field from a duplicate, or null when it can: an update could change it, the caller can write it, and can see what it holds. */
function notMergeable(ctx: Ctx, schema: Schema, obj: ObjectMeta, f: FieldMeta): string | null {
  if (f.read_only || f.create_only || fieldAccess(ctx, obj, f) !== "write") return "this key can't write it (or it can't be changed by an update), so it was left blank";
  if (f.sensitivity === "restricted" && !can(ctx, "restricted:read")) return "it is restricted and this key can't read restricted values, so it was left blank";
  const target = f.type === "relation" ? schema.objects.get(f.options.to!) : undefined;
  if (f.type === "relation" && (!target || !canObject(ctx, target, "read"))) return "this key can't read the records it points to, so it was left blank";
  return null;
}

class Rollback extends Error {
  constructor(readonly value: unknown) { super("rollback"); }
}

/** What a merge token binds: the request, and every record's version when it was previewed. */
interface MergeToken { h: string; versions: Record<string, number> }
const REDO = "run the merge with dry_run: true again and pass back its confirm_token";
const requestPrint = (s: string, dups: string[], input: MergeInput) =>
  sha256(canonicalJson({ survivor: s, duplicates: dups, fields: input.fields ?? {}, expected: input.expected_version ?? null })).toString("base64url");

export async function mergeRecords(tx: Tx, ctx: Ctx, input: MergeInput, dryRun: boolean) {
  const schema = await loadSchema(tx);
  const s = decodeId(input.survivor);
  const obj = s ? schema.byPrefix.get(s.prefix) : undefined;
  if (!s || !obj || !isModuleOn(schema, obj)) throw notFound(`Record ${input.survivor}`);
  if (obj.is_system && !MERGEABLE_STANDARD.has(obj.api_name)) {
    throw unprocessable(`${obj.plural_label} can't be merged; merging works on contacts, accounts, leads and custom objects`);
  }
  // Before any lookup: whether these records exist, or what they hold, is data.
  assertObject(ctx, obj, "write");
  assertObject(ctx, obj, "archive");
  if (!Array.isArray(input.duplicates) || input.duplicates.length === 0) throw unprocessable("duplicates must list at least one record ID");
  if (input.duplicates.length > MERGE_MAX_DUPLICATES) throw unprocessable(`A merge takes at most ${MERGE_MAX_DUPLICATES} duplicates`);
  const dupIds: string[] = [];
  for (const pid of input.duplicates) {
    const d = decodeId(pid);
    if (!d) throw unprocessable(`"${pid}" is not a record ID`);
    if (d.prefix !== obj.id_prefix) throw unprocessable(`${pid} is not a ${obj.api_name}; every record in a merge must be of the same object`);
    if (d.uuid === s.uuid) throw unprocessable(`${pid} is the survivor; a record can't be merged into itself`);
    if (dupIds.includes(d.uuid)) throw unprocessable(`${pid} is listed twice`);
    dupIds.push(d.uuid);
  }
  const choices = new Map<FieldMeta, string>();
  for (const [name, pid] of Object.entries(input.fields ?? {})) {
    const f = obj.byName.get(name);
    if (!f) throw unprocessable(`"${name}" is not a field of ${obj.api_name}`);
    if (fieldAccess(ctx, obj, f) !== "write") throw forbidden(`This key can't write ${obj.api_name}.${name}`);
    if (f.sensitivity === "restricted" && !can(ctx, "restricted:read")) throw forbidden(`${obj.api_name}.${name} is restricted and this key can't read restricted values, so it can't choose one`);
    if (f.read_only || f.create_only) throw unprocessable(`${obj.api_name}.${name} can't be changed by an update, so a merge can't take it from another record`);
    const d = typeof pid === "string" ? decodeId(pid) : null;
    if (!d || (d.uuid !== s.uuid && !dupIds.includes(d.uuid))) throw unprocessable(`fields.${name} must be the survivor's or a duplicate's ID`);
    choices.set(f, d.uuid);
  }
  if (dryRun && input.confirm_token !== undefined) throw unprocessable("A dry run issues a confirm_token; it doesn't take one");
  const print = requestPrint(s.uuid, dupIds, input);
  let token: { body: MergeToken; exp: number } | undefined;
  if (!dryRun) {
    if (!input.confirm_token) throw badRequest("A merge needs confirmation: run it with dry_run: true first and pass back its confirm_token");
    token = readConfirm<MergeToken>(ctx, "merge", input.confirm_token, REDO);
    if (token.body.h !== print) throw badRequest(`confirm_token was issued for a different survivor, duplicates or field choices; ${REDO}`);
  }

  // One merge at a time per workspace: two merges touching the same rows in different orders would deadlock.
  await lockMerges(tx, ctx.tenantId);
  // Lock in ID order, so a merge and other writers over the same records can't deadlock.
  const rows = await fetchRows(tx, obj, [s.uuid, ...dupIds].sort(), true);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of [s.uuid, ...dupIds]) if (!byId.has(id)) throw notFound(`${obj.label} ${encodeId(obj.id_prefix, id)}`);
  const into = await mergedInto(tx, [s.uuid, ...dupIds]);
  for (const id of [s.uuid, ...dupIds]) {
    if (!byId.get(id)!.archived_at) continue;
    const m = into.find((x) => x.merged_id === id);
    throw conflict(`${obj.label} ${encodeId(obj.id_prefix, id)} is archived${m ? ` (it was merged into ${encodeId(obj.id_prefix, m.survivor_id)})` : ""}; restore it first`);
  }
  if (input.expected_version !== undefined && Number(byId.get(s.uuid)!.version) !== input.expected_version) {
    throw new ApiError(412, "version_mismatch", `${obj.label} ${input.survivor} has changed (now version ${String(byId.get(s.uuid)!.version)}); re-read it and retry`);
  }
  const versions = Object.fromEntries([s.uuid, ...dupIds].map((id) => [id, Number(byId.get(id)!.version)]));
  if (token) {
    const changed = Object.keys(versions).filter((id) => token.body.versions[id] !== versions[id]);
    if (changed.length) {
      throw conflict(`${changed.map((id) => encodeId(obj.id_prefix, id)).join(", ")} changed since the dry run, so this merge may not be the one previewed; ${REDO}`);
    }
  }
  // A converted lead is history (its deal's source): it stays, as the survivor if it is merged at all.
  if (obj.api_name === "lead") {
    const converted = dupIds.filter((id) => byId.get(id)!.status_category === "converted");
    if (converted.length) {
      throw conflict(`${converted.map((id) => encodeId(obj.id_prefix, id)).join(", ")} is a converted lead, which can only be the survivor of a merge; make it the survivor, or leave it out`);
    }
  }

  // The plan, from the records as the caller sees them.
  const seen = await serialize(tx, ctx, schema, obj, [s.uuid, ...dupIds].map((id) => byId.get(id)!), { includeHidden: true });
  const [surv, ...dups] = seen as [RecordOut, ...RecordOut[]];
  const changes: Record<string, unknown> = {};
  const sources: Record<string, string> = {};
  const diff: { field: string; before: unknown; after: unknown; from: string }[] = [];
  const notFilled: { field: string; reason: string }[] = [];
  for (const f of obj.fields) {
    const chosen = choices.get(f);
    let from: RecordOut | undefined;
    if (chosen) from = seen.find((r) => decodeId(r.id)!.uuid === chosen);
    else if (fieldAccess(ctx, obj, f) !== "none" && blank(surv[f.api_name])) {
      from = dups.find((d) => !blank(d[f.api_name]) && !(f.sensitivity === "restricted" && !can(ctx, "restricted:read")));
      const why = from ? notMergeable(ctx, schema, obj, f) : null;
      if (why) {
        notFilled.push({ field: f.api_name, reason: why });
        continue;
      }
    }
    if (!from || from === surv) continue;
    let value = from[f.api_name];
    // A relation to one of the merged records means the survivor now; to the survivor itself (a parent account) it means nothing.
    if (f.type === "relation" && f.options.to === obj.api_name) {
      const map = (v: unknown) => (dups.some((d) => d.id === v) ? surv.id : v);
      value = Array.isArray(value) ? [...new Set(value.map(map))].filter((v) => v !== surv.id) : map(value) === surv.id ? null : map(value);
      if (blank(value) && !chosen) continue;
    }
    if (same(value, surv[f.api_name])) continue;
    changes[f.api_name] = value;
    sources[f.api_name] = decodeId(from.id)!.uuid;
    diff.push({ field: f.api_name, before: surv[f.api_name] ?? null, after: value, from: from.id });
  }
  if (obj.api_name === "lead" && byId.get(s.uuid)!.status_category === "converted" && Object.keys(changes).length) {
    throw conflict(`${input.survivor} is a converted lead, which is read-only, so it can't take values from the duplicates (${Object.keys(changes).join(", ")}). `
      + "Choose those fields from the survivor, or make another lead the survivor");
  }
  await countReferences(tx, obj, dupIds);

  const work = async (t: Tx) => {
    const check = deadline(WORK_BUDGET_MS.merge, "The merge");
    const mergeId = uuidv7();
    const survivorPublic = encodeId(obj.id_prefix, s.uuid);
    // Archived first: a unique value (an email, a domain) is free for the survivor once its holder is archived.
    await archiveMergedRecords(t, obj.table_name ?? "records", dupIds, ctx.actor.id);
    for (const id of dupIds) {
      await audit(t, ctx, { action: `${obj.api_name}.archived`, objectType: obj.api_name, recordId: id, details: { merged_into: survivorPublic } });
      await emit(t, ctx, { type: `${obj.api_name}.archived`, objectType: obj.api_name, recordId: id, data: { merged_into: survivorPublic } });
    }
    const moved = await repoint(t, ctx, schema, obj, s.uuid, dupIds, check);
    check();
    // The survivor's previous values of the fields that change, for an unmerge: encrypted, since they may be restricted.
    const full = (await serialize(t, withRestricted(internalReader(ctx)), schema, obj, [byId.get(s.uuid)!], { includeHidden: true }))[0]!;
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, full[k] ?? null]));
    const survivorBefore = Object.keys(before).length ? await encryptValue(t, ctx.tenantId, mergeId, "survivor_before", before) : null;
    await insertMerge(t, { tenantId: ctx.tenantId, id: mergeId, objectId: obj.id, survivorId: s.uuid, mergedIds: dupIds, fieldSources: sources,
      survivorBefore, repointed: moved.log, mergedBy: ctx.actor.id });
    if (Object.keys(changes).length) await updateRecord(t, ctx, obj.api_name, survivorPublic, changes);
    const counts = Object.fromEntries(moved.log.map((m) => [`${m.table}.${m.column}`, m.moved.length + m.dropped.length + m.archived.length + m.cleared.length]));
    await audit(t, ctx, { action: `${obj.api_name}.merged`, objectType: obj.api_name, recordId: s.uuid,
      details: { merge: mergeId, merged: dupIds, fields: Object.keys(changes), references: counts, moved: moved.records } });
    await emit(t, ctx, { type: `${obj.api_name}.merged`, objectType: obj.api_name, recordId: s.uuid,
      data: { merged: dupIds.map((id) => encodeId(obj.id_prefix, id)) } }); // field changes are in the survivor's .updated event, filtered per reader
    return {
      survivor: await getRecord(t, ctx, obj.api_name, survivorPublic, { includeHidden: true }),
      merged: dupIds.map((id) => encodeId(obj.id_prefix, id)),
      changes: diff,
      references: describeMoves(ctx, schema, moved.log),
      ...(notFilled.length ? { not_filled: notFilled } : {}),
    };
  };
  try {
    if (!dryRun) {
      await spendConfirm(tx, ctx, input.confirm_token!, token!.exp);
      return { dry_run: false, ...(await work(tx)) };
    }
    // The real work in a savepoint that is rolled back: the preview checks everything a merge would (unique values,
    // transitions, the account hierarchy) and reports what would move. As a preview it takes no unique-value locks.
    await asPreview(() => tx.savepoint(async (sp) => {
      throw new Rollback(await work(sp as unknown as Tx));
    }));
  } catch (e) {
    if (e instanceof Rollback) {
      return { dry_run: true, ...(e.value as object), confirm_token: issueConfirm(ctx, "merge", { h: print, versions } satisfies MergeToken) };
    }
    const err = e as { code?: string; message?: string };
    if (err.code === "23514" && /cycle/.test(err.message ?? "")) {
      // Naming the cycle tells a role that can't read parent accounts something about the hierarchy.
      const parent = schema.objects.get("account")?.byName.get("parent_account");
      if (parent && fieldAccess(ctx, schema.objects.get("account")!, parent) !== "none") {
        throw conflict("This merge would make an account its own parent, through the account hierarchy; change the parent accounts first");
      }
      throw conflict("The database refused this merge (a record it touches doesn't allow the change); nothing was changed");
    }
    // Anything else the database refuses is named generically: its message would name tables and constraints.
    if (err.code === "23505") throw conflict("This merge would leave two records with the same unique value; change one of them first");
    if (err.code === "23514" || err.code === "23503") throw conflict("The database refused this merge (a record it touches doesn't allow the change); nothing was changed");
    if (err.code === "40P01" || err.code === "40001") throw new ApiError(409, "retry", "This merge conflicted with another change; nothing was changed. Retry it");
    throw e;
  }
  throw new Error("unreachable");
}

/** The references REFERENCES lists for a merge of `obj`: into its own table, and into the registry (every object). */
const referencesFor = (obj: ObjectMeta) => REFERENCES.filter((r) => r.policy !== "own" && (r.into === "record_registry" || r.into === obj.table_name));

/** Refuses a merge that would move more than MERGE_MAX_REFERENCES rows, or that a `refuse` reference stops, before anything changes. */
async function countReferences(tx: Tx, obj: ObjectMeta, dups: string[]): Promise<void> {
  let total = 0;
  for (const r of referencesFor(obj)) {
    const n = await countReferenceRows(tx, statements(r).count, dups);
    if (r.policy === "refuse" && n > 0) throw conflict(`A record in this merge ${r.refusal ?? "is referenced where a merge can't move it"}`);
    total += n;
  }
  total += await countAlertReferences(tx, dups);
  total += await countFilesOf(tx, dups);
  if (total > MERGE_MAX_REFERENCES) {
    throw unprocessable(`This merge would move ${total} references to the survivor; one merge moves at most ${MERGE_MAX_REFERENCES}. `
      + "Merge fewer duplicates at a time (or move some of their references first)");
  }
}

interface Change { object: ObjectMeta; id: string; archived: boolean; before: Record<string, unknown>; after: Record<string, unknown>; fields: Set<string> }

/**
 * Moves every reference from the duplicates to the survivor, as REFERENCES says (a fixed number of
 * set-based statements per column, the work budget checked between them), then gives every record whose
 * reference moved a version bump and its `.updated` event (`.archived` for a second copy archived),
 * marked reference_move, with only the IDs that moved. Returns the log kept in `merges` and, for the
 * audit entry, which records changed in which fields.
 */
async function repoint(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, survivor: string, dups: string[], check: () => void) {
  const log: Moved[] = [];
  const changed = new Map<string, Change>();
  const bumped = new Set<string>();
  const touch = new Map<string, Set<string>>(); // table -> link holders to bump
  const note = (o: ObjectMeta | undefined, id: string, field: string, from: string | null, to: string | null, list: boolean, archived = false) => {
    if (!o) return;
    const key = `${o.api_name}:${id}`;
    const c = changed.get(key) ?? { object: o, id, archived: false, before: {}, after: {}, fields: new Set<string>() };
    c.archived ||= archived;
    c.fields.add(field);
    const pid = (u: string | null) => (u ? encodeId(obj.id_prefix, u) : null);
    if (list) {
      c.before[field] = [...new Set([...((c.before[field] as string[] | undefined) ?? []), pid(from)!])];
      c.after[field] = to ? [pid(to)!] : ((c.after[field] as string[] | undefined) ?? []);
    } else {
      c.before[field] ??= pid(from);
      c.after[field] = pid(to);
    }
    changed.set(key, c);
  };
  const ownerOf = (fieldId: string) => [...schema.objects.values()].find((o) => o.fields.some((f) => f.id === fieldId));

  const record = (r: Reference, kind: "moved" | "dropped" | "archived" | "cleared", found: Found) => {
    if (!found.length) return;
    let m = log.find((x) => x.table === r.table && x.column === r.column);
    if (!m) log.push(m = { table: r.table, column: r.column, moved: [], dropped: [], archived: [], cleared: [] });
    m[kind].push(...found.map((f) => ({ k: f.k, from: f.old, holder: f.h })));
    const to = kind === "cleared" ? null : survivor;
    for (const f of found) {
      if (!r.via) {
        // The row is a record: it was bumped by the statement itself.
        const o = schema.objects.get(r.object!);
        bumped.add(f.h);
        note(o, f.h, o?.fields.find((x) => x.column_name === r.column)?.api_name ?? r.column, f.old, to, false, kind === "archived");
        continue;
      }
      const o = r.object ? schema.objects.get(r.object) : ownerOf(f.k[0]!);
      const field = r.field ?? o?.fields.find((x) => x.id === f.k[0])?.api_name ?? r.column;
      note(o, f.h, field, f.old, f.h === survivor ? null : to, true); // the survivor's own link to a duplicate is dropped, not moved
      if (o) touch.set(o.table_name ?? "records", (touch.get(o.table_name ?? "records") ?? new Set<string>()).add(f.h));
    }
  };

  for (const r of referencesFor(obj)) {
    if (r.policy === "refuse" || r.guarded) continue;
    const sql = statements(r);
    const params = r.via ? [survivor, dups] : [survivor, dups, ctx.actor.id];
    if (r.self) {
      check();
      record(r, r.self === "clear" ? "cleared" : "dropped", await runReferenceStatement(tx, sql.self, params));
    }
    if (r.policy === "dedupe") {
      check();
      record(r, r.via ? "dropped" : "archived", await runReferenceStatement(tx, sql.dedupe, params));
    }
    check();
    record(r, "moved", await runReferenceStatement(tx, sql.move, params));
  }

  // Rows the immutability triggers protect move through app.merge_move, which also bumps those that hold a moved link.
  for (const table of GUARDED_TABLES) {
    const guarded = referencesFor(obj).filter((r) => r.guarded && r.table === table);
    const holders = [...(touch.get(table) ?? [])];
    touch.delete(table);
    if (!guarded.length && !holders.length) continue;
    check();
    const rows = await moveGuardedReferences(tx, table, survivor, dups, holders, ctx.actor.id);
    for (const g of guarded) {
      record(g, "moved", rows.filter((x) => x.col === g.column).map((x) => ({ h: x.row_id, old: x.ref!, k: [x.row_id] })));
    }
    for (const x of rows) if (!x.col) bumped.add(x.row_id);
  }
  // Every other record whose link moved gets its version bump here, once.
  for (const [table, ids] of touch) {
    const todo = [...ids].filter((id) => !bumped.has(id));
    if (!todo.length) continue;
    check();
    await bumpLinkHolders(tx, bumpSql(table), todo, ctx.actor.id);
    for (const id of todo) bumped.add(id);
  }

  // Alert state and notifications hold record IDs without a foreign key. The survivor keeps its own deadline per
  // rule, and its own open notification per rule (or automation) and member; a duplicate's copy is dropped or resolved.
  check();
  const dl: Moved = { table: "rule_deadlines", column: "record_id", moved: [], dropped: [], archived: [], cleared: [] };
  const nt: Moved = { table: "notifications", column: "record_id", moved: [], dropped: [], archived: [], cleared: [] };
  dl.dropped = (await dropDuplicateDeadlines(tx, survivor, dups)).map((x) => ({ k: [x.rule_id], from: x.record_id, holder: x.rule_id }));
  dl.moved = (await moveDeadlines(tx, survivor, dups)).map((x) => ({ k: [x.rule_id], from: x.old, holder: x.rule_id }));
  check();
  nt.archived = (await resolveDuplicateNotifications(tx, survivor, dups))
    .map((x) => ({ k: [x.id], from: x.record_id, holder: x.id }));
  nt.moved = (await moveNotifications(tx, survivor, dups)).map((x) => ({ k: [x.id], from: x.old, holder: x.id }));
  // The duplicates' files go to the survivor: a merge loses no document.
  check();
  const fl: Moved = { table: "files", column: "record_id", moved: [], dropped: [], archived: [], cleared: [] };
  fl.moved = (await moveFiles(tx, survivor, dups)).map((x) => ({ k: [x.id], from: x.old, holder: x.id }));
  for (const m of [dl, nt, fl]) if (m.moved.length + m.dropped.length + m.archived.length) log.push(m);

  // One event per record whose reference moved: its normal event, with the IDs that moved (filtered per reader by field, like any update).
  const records: { object: string; record: string; fields: string[] }[] = [];
  for (const c of changed.values()) {
    await emit(tx, ctx, { type: `${c.object.api_name}.${c.archived ? "archived" : "updated"}`, objectType: c.object.api_name, recordId: c.id,
      data: { reference_move: true, before: c.before, after: c.after } });
    records.push({ object: c.object.api_name, record: c.id, fields: [...c.fields] });
  }
  return { log, records };
}

/** What moved, as the caller may see it: per object and field it can read, how many rows. Tables it can't read stay unnamed, so a count reveals nothing. */
function describeMoves(ctx: Ctx, schema: Schema, moved: Moved[]) {
  const out = new Map<string, { object: string; field: string; moved: number; archived: number; dropped: number; cleared: number }>();
  const add = (o: ObjectMeta | undefined, field: string, m: Moved, pick?: (r: MovedRow) => boolean) => {
    if (!o || !canObject(ctx, o, "read")) return;
    const f = o.byName.get(field);
    if (f && fieldAccess(ctx, o, f) === "none") return;
    const n = (l: MovedRow[]) => (pick ? l.filter(pick).length : l.length);
    const key = `${o.api_name}.${field}`;
    const cur = out.get(key) ?? { object: o.api_name, field, moved: 0, archived: 0, dropped: 0, cleared: 0 };
    cur.moved += n(m.moved); cur.archived += n(m.archived); cur.dropped += n(m.dropped); cur.cleared += n(m.cleared);
    if (cur.moved + cur.archived + cur.dropped + cur.cleared) out.set(key, cur);
  };
  for (const m of moved) {
    const o = [...schema.objects.values()].find((x) => x.table_name === m.table);
    if (o) add(o, o.fields.find((f) => f.column_name === m.column)?.api_name ?? m.column, m);
    else if (m.table === "activity_associations") add(schema.objects.get("activity"), "related_to", m);
    else if (m.table === "task_associations") add(schema.objects.get("task"), "related_to", m);
    else if (m.table === "record_links") {
      for (const fieldId of new Set([...m.moved, ...m.dropped].map((r) => r.k[0]!))) {
        const owner = [...schema.objects.values()].find((x) => x.fields.some((f) => f.id === fieldId));
        add(owner, owner?.fields.find((f) => f.id === fieldId)?.api_name ?? "", m, (r) => r.k[0] === fieldId);
      }
    }
  }
  return [...out.values()].sort((a, b) => (a.object + a.field < b.object + b.field ? -1 : 1));
}
