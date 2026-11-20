import type { Tx } from "../db/pool.js";
import { asPreview } from "../db/tx.js";
import { canonicalJson, sha256 } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, deadline, notFound, unprocessable, WORK_BUDGET_MS } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { accessGuard, assertObject } from "./access.js";
import { audit } from "./audit.js";
import { issueConfirm, peekConfirm, readConfirm, spendConfirm } from "./confirm.js";
import type { Ctx } from "./context.js";
import { Compiler, targetFor, type Where } from "./query.js";
import { archiveRecord, assertInputAllowed, createRecord, fetchRows, serialize, updateRecord } from "./records.js";
import { getObject, loadSchema, quoteIdent, type ObjectMeta, type Schema } from "./schema.js";
import { matchingIds } from "./queries/records.js";

/**
 * Bulk update and bulk archive of one object's records, by explicit IDs or by a filter.
 *
 * Every record goes through updateRecord or archiveRecord, so validation, object and field access,
 * status transitions, hooks, events and audit are exactly those of single changes: a bulk change is
 * a loop over them in one transaction, all or nothing, under the work budget. A dry run (the default)
 * runs the same loop in a savepoint that is rolled back, and reports what each record would do.
 *
 * By filter, a dry run is required first. It returns the count, a sample and a confirm_token that
 * binds the filter, the values and the exact records previewed. The real run evaluates the filter
 * again among those records only: a record that no longer matches is reported and left alone, and a
 * record that matches now but wasn't previewed is counted, never changed. So a run never widens.
 * By ids, a run of more than BULK_IDS_WITHOUT_TOKEN records needs the token of a dry run of the same
 * ids and values too. A token is single-use (core/confirm.ts): a replay is refused with 409.
 */

export const BULK_CAP = 500;
/** A real run by ids of more records than this needs a dry run's confirm_token, as a run by filter always does. */
export const BULK_IDS_WITHOUT_TOKEN = 25;
/** Records a dry run may examine per rate-limit token: it does each record's real work, then rolls it back. */
export const PREVIEW_PER_TOKEN = 10;
const SAMPLE = 10;

export type BulkOp = "update" | "archive";
export interface BulkInput {
  ids?: string[];
  where?: Where;
  values?: Record<string, unknown>;
  expected_versions?: Record<string, number>;
  dry_run?: boolean;
  confirm_token?: string;
}

interface RowOutcome { id: string; action: BulkOp | "skip" | "error"; version?: number; reason?: string; errors?: unknown }
interface TokenBody { op: BulkOp; o: string; h: string; ids: string }

/** What a token binds besides the records: the change, and for a run by ids the ids themselves (sorted, so order doesn't matter). */
const fingerprint = (op: BulkOp, obj: ObjectMeta, input: BulkInput, ids: string[] | null) =>
  sha256(canonicalJson({ op, object: obj.api_name, where: input.where ?? null, ids: ids ? [...ids].sort() : null, values: input.values ?? null,
    expected: input.expected_versions ?? null })).toString("base64url");
const REDO = "run the same request with dry_run: true again and pass back its confirm_token";

function issueToken(ctx: Ctx, op: BulkOp, obj: ObjectMeta, input: BulkInput, ids: string[]): string {
  const packed = Buffer.concat(ids.map((id) => Buffer.from(id.replaceAll("-", ""), "hex"))).toString("base64url");
  const body: TokenBody = { op, o: obj.api_name, h: fingerprint(op, obj, input, input.ids ? ids : null), ids: packed };
  return issueConfirm(ctx, "bulk", body);
}

/** The records a token's dry run previewed, once its signature, caller, expiry and request all check out; and when it expires, to spend it. */
function readToken(ctx: Ctx, op: BulkOp, obj: ObjectMeta, input: BulkInput, ids: string[] | null): { ids: string[]; exp: number } {
  const { body, exp } = readConfirm<TokenBody>(ctx, "bulk", input.confirm_token, REDO);
  if (body.op !== op || body.o !== obj.api_name) throw badRequest(`confirm_token was issued for another request or credential; ${REDO}`);
  if (body.h !== fingerprint(op, obj, input, ids)) throw badRequest(`confirm_token was issued for different records, filter, values or expected versions; ${REDO}`);
  const raw = Buffer.from(body.ids, "base64url");
  const out: string[] = [];
  for (let i = 0; i + 16 <= raw.length; i += 16) {
    const h = raw.subarray(i, i + 16).toString("hex");
    out.push(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`);
  }
  return { ids: out, exp };
}

/** How many records a confirm token covers, for the rate limit (read before the token is checked; a forged count only changes the charge of a request that then fails). */
export function tokenSize(token: string | undefined): number {
  const ids = (peekConfirm(token) as Partial<TokenBody> | undefined)?.ids;
  return typeof ids === "string" ? Math.max(1, Buffer.from(ids, "base64url").length / 16) : 1;
}

/**
 * The records matching `where`, in ID order: their IDs (at most `limit`), or with `count` how many there are.
 * `among` keeps only those records, `excluding` leaves those out. Filters go through the caller's access guard.
 */
async function matching(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, where: Where,
  opts: { among?: string[]; excluding?: string[]; limit: number; count?: boolean }): Promise<string[] | number> {
  const c = new Compiler(schema, accessGuard(ctx, schema));
  const t = targetFor(schema, obj.api_name);
  const conds = ["r.archived_at IS NULL", c.compileWhere(t, "r", where, 0)];
  if (!obj.is_system) conds.push(`r.object_id = ${c.param(obj.id, "uuid")}`);
  if (opts.among) conds.push(`r.id = ANY(${c.param(opts.among, "uuid[]")})`);
  if (opts.excluding) conds.push(`NOT r.id = ANY(${c.param(opts.excluding, "uuid[]")})`);
  const select = `SELECT r.id FROM ${quoteIdent(obj.table_name ?? "records")} r WHERE ${conds.join(" AND ")} ORDER BY r.id LIMIT ${opts.limit}`;
  try {
    if (opts.count) return (await tx.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM (${select}) x`, c.params as never[]))[0]!.n; // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
    return (await matchingIds(tx, select, c.params)).map((r) => r.id);
  } catch (e) {
    if (typeof (e as { code?: string }).code === "string" && (e as { code: string }).code.startsWith("22")) throw unprocessable("A filter value is not valid for its field");
    throw e;
  }
}

class Rollback extends Error {}

export async function bulkChange(tx: Tx, ctx: Ctx, objectName: string, op: BulkOp, input: BulkInput) {
  const schema = await loadSchema(tx);
  const obj = getObject(schema, objectName);
  const dryRun = input.dry_run ?? true;
  // Everything the caller may not do is refused before a record is looked up.
  if (op === "update") {
    if (typeof input.values !== "object" || input.values === null || Array.isArray(input.values) || Object.keys(input.values).length === 0) {
      throw unprocessable("values must name at least one field to set");
    }
    assertInputAllowed(ctx, schema, obj, input.values);
  } else assertObject(ctx, obj, "archive");
  if ((input.ids === undefined) === (input.where === undefined)) throw unprocessable("Pass either ids or where (a filter), not both");
  if (dryRun && input.confirm_token !== undefined) throw unprocessable("A dry run issues a confirm_token; it doesn't take one");

  const versions = new Map<string, number>();
  for (const [pid, v] of Object.entries(input.expected_versions ?? {})) {
    const d = decodeId(pid);
    if (!d || d.prefix !== obj.id_prefix) throw unprocessable(`expected_versions: "${pid}" is not a ${obj.api_name} ID`);
    if (!Number.isInteger(v) || v < 1) throw unprocessable(`expected_versions.${pid} must be a version number`);
    versions.set(d.uuid, v);
  }

  let targets: string[];
  let noLongerMatch: string[] = [];
  let newMatches = 0;
  if (input.ids !== undefined) {
    if (input.ids.length === 0 || input.ids.length > BULK_CAP) throw unprocessable(`ids lists 1 to ${BULK_CAP} records`);
    const bad = input.ids.filter((pid) => decodeId(pid)?.prefix !== obj.id_prefix);
    if (bad.length) throw unprocessable(`Not ${obj.api_name} IDs: ${bad.slice(0, 10).map((x) => String(x).slice(0, 40)).join(", ")}`);
    targets = [...new Set(input.ids.map((pid) => decodeId(pid)!.uuid))];
    if (!dryRun && (targets.length > BULK_IDS_WITHOUT_TOKEN || input.confirm_token !== undefined)) {
      if (!input.confirm_token) {
        throw badRequest(`A change of more than ${BULK_IDS_WITHOUT_TOKEN} records needs confirmation: run it with dry_run: true first and pass back its confirm_token`);
      }
      await spendConfirm(tx, ctx, input.confirm_token, readToken(ctx, op, obj, input, targets).exp);
    }
  } else {
    // A filter shows which records match, so the caller must be able to read them (the guard checks its fields).
    assertObject(ctx, obj, "read");
    if (dryRun) {
      targets = await matching(tx, ctx, schema, obj, input.where!, { limit: BULK_CAP + 1 }) as string[];
      if (targets.length > BULK_CAP) throw unprocessable(`The filter matches more than ${BULK_CAP} ${obj.plural_label.toLowerCase()}; narrow it (or work through it in parts)`);
    } else {
      if (!input.confirm_token) throw badRequest(`A change by filter needs confirmation: run it with dry_run: true first and pass back its confirm_token`);
      const { ids: previewed, exp } = readToken(ctx, op, obj, input, null);
      await spendConfirm(tx, ctx, input.confirm_token, exp);
      targets = await matching(tx, ctx, schema, obj, input.where!, { among: previewed, limit: BULK_CAP }) as string[];
      const now = new Set(targets);
      noLongerMatch = previewed.filter((id) => !now.has(id));
      newMatches = await matching(tx, ctx, schema, obj, input.where!, { excluding: previewed, limit: 100_000, count: true }) as number;
    }
  }

  const check = deadline(WORK_BUDGET_MS.bulk, `The bulk ${op}`);
  const outcomes: RowOutcome[] = [];
  const work = async (t: Tx) => {
    for (const id of targets) {
      check(); // outside the row's try: running out of time fails the request, not the row
      const pid = encodeId(obj.id_prefix, id);
      const out: RowOutcome = { id: pid, action: "error" };
      try {
        await t.savepoint(async (sp) => Object.assign(out, await changeOne(sp as unknown as Tx, ctx, obj, op, pid, input.values ?? {}, versions.get(id))));
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        out.action = "error";
        out.reason = e.message;
        if (e.details !== undefined) out.errors = (e.details as { errors?: unknown }).errors ?? e.details;
      }
      outcomes.push(out);
    }
  };
  if (dryRun) {
    try {
      // A preview: rolled back, so it takes no unique-value locks (records.ts) that would block real writes meanwhile.
      await asPreview(() => tx.savepoint(async (sp) => {
        await work(sp as unknown as Tx);
        throw new Rollback();
      }));
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  } else {
    await work(tx);
  }
  const failed = outcomes.filter((o) => o.action === "error");
  if (!dryRun && failed.length) {
    throw new ApiError(422, "bulk_failed", `${failed.length} of ${outcomes.length} record(s) failed, so nothing was changed`, failed);
  }
  const counts = { [op]: 0, skip: 0, error: 0 } as Record<string, number>;
  for (const o of outcomes) counts[o.action] = (counts[o.action] ?? 0) + 1;
  if (!dryRun) {
    await audit(tx, ctx, { action: `${obj.api_name}.bulk_${op === "update" ? "updated" : "archived"}`, objectType: obj.api_name, details: {
      records: outcomes.filter((o) => o.action === op).length, by: input.ids ? "ids" : "filter",
      ...(op === "update" ? { fields: Object.keys(input.values ?? {}) } : {}), ...(input.ids ? {} : { no_longer_matching: noLongerMatch.length, new_matches_left: newMatches }),
    } });
  }
  const sampleRows = dryRun && targets.length ? await fetchRows(tx, obj, targets.slice(0, SAMPLE)) : [];
  return {
    dry_run: dryRun, object: obj.api_name, op, count: targets.length, counts, rows: outcomes,
    ...(dryRun ? { sample: await serialize(tx, ctx, schema, obj, sampleRows) } : {}),
    ...(dryRun && failed.length === 0 && targets.length ? { confirm_token: issueToken(ctx, op, obj, input, targets) } : {}),
    ...(!dryRun && input.where !== undefined ? {
      no_longer_matching: noLongerMatch.map((id) => encodeId(obj.id_prefix, id)), new_matches_not_changed: newMatches,
    } : {}),
  };
}

async function changeOne(tx: Tx, ctx: Ctx, obj: ObjectMeta, op: BulkOp, pid: string, values: Record<string, unknown>, expected?: number): Promise<Partial<RowOutcome>> {
  if (op === "update") {
    const rec = await updateRecord(tx, ctx, obj.api_name, pid, values, expected);
    return { action: "update", version: Number(rec.version) };
  }
  const [row] = await fetchRows(tx, obj, [decodeId(pid)!.uuid], true);
  if (!row) throw notFound(`${obj.label} ${pid}`);
  if (row.archived_at) return { action: "skip", reason: "already archived" };
  if (expected !== undefined && Number(row.version) !== expected) {
    throw conflict(`${obj.label} ${pid} has changed (now version ${String(row.version)}); re-read it and retry`);
  }
  const rec = await archiveRecord(tx, ctx, obj.api_name, pid);
  return { action: "archive", version: Number(rec.version) };
}

/**
 * A dry run of the batch create (POST /v1/objects/{object}/records/batch with dry_run): each record
 * goes through createRecord, as in a real run, in a savepoint that is rolled back, so later records
 * see earlier ones (a repeated unique value fails as it would for real) and nothing is written.
 * As a preview it takes no unique-value locks. IDs and timestamps are left out: they are not kept.
 */
export async function previewCreates(tx: Tx, ctx: Ctx, objectName: string, records: Record<string, unknown>[]) {
  const rows: { index: number; action: "create" | "error"; record?: Record<string, unknown>; reason?: string; errors?: unknown }[] = [];
  try {
    await asPreview(() => tx.savepoint(async (sp) => {
      for (const [index, values] of records.entries()) {
        try {
          const rec = await sp.savepoint((one) => createRecord(one as unknown as Tx, ctx, objectName, values));
          const record = Object.fromEntries(Object.entries(rec).filter(([k]) => !["id", "created_at", "updated_at", "version"].includes(k)));
          rows.push({ index, action: "create", record });
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          rows.push({ index, action: "error", reason: e.message, ...(e.details !== undefined ? { errors: (e.details as { errors?: unknown }).errors ?? e.details } : {}) });
        }
      }
      throw new Rollback();
    }));
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const errors = rows.filter((r) => r.action === "error").length;
  return { dry_run: true, object: objectName, counts: { create: rows.length - errors, error: errors }, rows };
}
