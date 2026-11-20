import type { Command } from "commander";
import type { Context } from "../context.js";
import { EXIT, usage } from "../errors.js";
import { cleanLine } from "../output.js";
import { FIELD_CONDITION, OBJECT_NAME, RECORD_ID } from "../patterns.js";
import type { Act } from "../program.js";

/** Record write commands under `crm data`: restore, duplicates, merge, and bulk update and archive (preview, then confirm). */

const objectName = (object: string) => {
  if (!OBJECT_NAME.test(object)) throw usage(`"${object}" is not an object name`);
  return object;
};
const recordId = (id: string) => {
  if (!RECORD_ID.test(id)) throw usage(`"${id}" is not a record ID`);
  return id;
};

/** A value typed on the command line: JSON when it parses (numbers, true/false, null, lists), text otherwise. */
function cliValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** --set field=value, repeatable. */
export function parseSet(sets: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets) {
    const i = s.indexOf("=");
    if (i <= 0) throw usage(`--set "${s}" must look like field=value`);
    out[s.slice(0, i)] = cliValue(s.slice(i + 1));
  }
  return out;
}

/**
 * --where, repeatable and combined with AND: field=value, field[op]=value (in/not_in take a comma list,
 * is_null true/false), or a JSON filter tree as in POST /v1/query.
 */
export function parseWhere(parts: string[] = []): unknown {
  const preds = parts.map((w) => {
    if (w.trim().startsWith("{")) {
      try {
        return JSON.parse(w) as unknown;
      } catch {
        throw usage(`--where "${w}" is not valid JSON`);
      }
    }
    const m = FIELD_CONDITION.exec(w);
    if (!m) throw usage(`--where "${w}" must look like field=value, field[op]=value or a JSON filter`);
    const path = m[1]!.split(".");
    const op = m[2] ?? "eq";
    const value = op === "in" || op === "not_in" ? m[3]!.split(",").map(cliValue) : op === "is_null" ? m[3] !== "false" : cliValue(m[3]!);
    return { path, op, value };
  });
  if (preds.length === 0) return undefined;
  return preds.length === 1 ? preds[0] : { and: preds };
}

interface Row { id: string; action: string; reason?: string }
interface BulkResult { dry_run: boolean; count: number; counts: Record<string, number>; rows: Row[]; sample?: Record<string, unknown>[];
  confirm_token?: string; no_longer_matching?: string[]; new_matches_not_changed?: number }

function printErrors(ctx: Context, rows: Row[]): void {
  for (const r of rows.filter((x) => x.action === "error").slice(0, 20)) ctx.out.line(`  ${r.id}: ${cleanLine(r.reason ?? "error")}`);
}

export function registerRecordWrites(data: Command, act: Act, collect: (v: string, p?: string[]) => string[]): void {
  data.command("restore <id>")
    .description("Restore (un-archive) a record")
    .action(act(async (ctx, id: string) => {
      const client = ctx.client();
      const rec = (await client.get<{ data: { object: string } }>(`/v1/records/${recordId(id)}`)).data;
      const res = await client.post<{ data: Record<string, unknown>; warnings: { field: string; message: string }[] }>(`/v1/objects/${objectName(rec.object)}/records/${id}/restore`, {});
      if (ctx.g.json) return ctx.out.data(res);
      ctx.out.line(`Restored ${id} (now version ${String(res.data.version)}).`);
      for (const w of res.warnings) ctx.out.info(`Warning: ${w.field} ${cleanLine(w.message)}`);
    }));

  data.command("duplicates <object>")
    .description("Find groups of likely duplicates (changes nothing)")
    .option("--rule <fields>", "comma-separated fields to match on, repeatable (default: the object's rules, e.g. email; first_name,last_name,account)", collect)
    .option("--fuzzy", "also group similar names")
    .option("--min-similarity <n>", "for --fuzzy, 0.3 to 1 (default 0.6)")
    .option("--limit <n>", "groups to show (max 200)", "50")
    .action(act(async (ctx, object: string, opts: { rule?: string[]; fuzzy?: boolean; minSimilarity?: string; limit: string }) => {
      const res = await ctx.client().post<{ groups: { reason: { fields: string[]; match: string; similarity?: number }; count: number; records: Record<string, unknown>[] }[];
        scanned: number; window_full: boolean; more_groups: boolean; skipped_rules?: { rule: string[]; reason: string }[] }>(`/v1/objects/${objectName(object)}/duplicates`, {
        ...(opts.rule ? { rules: opts.rule.map((r) => r.split(",").map((f) => f.trim()).filter(Boolean)) } : {}),
        ...(opts.fuzzy ? { fuzzy: true } : {}), ...(opts.minSimilarity ? { min_similarity: Number(opts.minSimilarity) } : {}), limit: Number(opts.limit),
      });
      if (ctx.g.json) return ctx.out.data(res);
      for (const s of res.skipped_rules ?? []) ctx.out.info(`Skipped rule ${s.rule.join(",")}: ${cleanLine(s.reason)}`);
      if (res.groups.length === 0) ctx.out.line(`No duplicates among the ${res.scanned} newest ${object} records.`);
      for (const [i, g] of res.groups.entries()) {
        ctx.out.line(`Group ${i + 1}: ${g.count} records, ${g.reason.match} ${g.reason.fields.join(" + ")}${g.reason.similarity ? ` (similarity ≥ ${g.reason.similarity})` : ""}`);
        for (const r of g.records) ctx.out.line(`  ${String(r.id)}  ${cleanLine(String(r.display_name ?? ""))}`);
      }
      if (res.more_groups) ctx.out.info("More groups: raise --limit.");
      if (res.window_full) ctx.out.info(`Only the ${res.scanned} newest records were examined.`);
    }));

  data.command("merge <survivor> <duplicates...>")
    .description("Merge duplicates into the survivor: shows the changes, then asks (--yes to skip)")
    .option("--field <field=id>", "take this field's value from the given record, repeatable", collect)
    .action(act(async (ctx, survivor: string, duplicates: string[], opts: { field?: string[] }) => {
      const fields: Record<string, string> = {};
      for (const f of opts.field ?? []) {
        const [name, id] = f.split("=");
        if (!name || !id) throw usage(`--field "${f}" must look like field=record_id`);
        fields[name] = recordId(id);
      }
      const body = { survivor: recordId(survivor), duplicates: duplicates.map(recordId), ...(opts.field ? { fields } : {}) };
      const client = ctx.client();
      type MergeResult = { changes: { field: string; before: unknown; after: unknown; from: string }[]; references: { object: string; field: string; moved: number; archived: number; dropped: number; cleared: number }[];
        not_filled?: { field: string; reason?: string }[]; survivor: Record<string, unknown>; confirm_token?: string };
      const preview = await client.post<MergeResult>("/v1/ops/merge_records", { ...body, dry_run: true });
      if (!ctx.g.json) {
        ctx.out.line(`Merge ${duplicates.length} record(s) into ${survivor}; they will be archived and point to it.`);
        for (const c of preview.changes) ctx.out.line(`  ${c.field}: ${cleanLine(JSON.stringify(c.before))} → ${cleanLine(JSON.stringify(c.after))} (from ${c.from})`);
        for (const r of preview.references) ctx.out.line(`  ${r.object}.${r.field}: ${r.moved} moved${r.archived ? `, ${r.archived} archived` : ""}${r.dropped ? `, ${r.dropped} duplicate links dropped` : ""}${r.cleared ? `, ${r.cleared} cleared` : ""}`);
        for (const f of preview.not_filled ?? []) ctx.out.info(`Not filled: ${f.field}${f.reason ? ` (${cleanLine(f.reason)})` : ""}`);
      }
      await ctx.confirm("Apply this merge? It can't be undone automatically. [y/N] ", `Merging archives ${duplicates.length} record(s)`);
      // The token binds the run to this preview: if a record changed since, the server refuses and nothing is merged.
      const done = await client.post<MergeResult>("/v1/ops/merge_records", { ...body, dry_run: false, confirm_token: preview.confirm_token });
      if (ctx.g.json) return ctx.out.data({ preview, result: done });
      ctx.out.line(`Merged into ${survivor}.`);
    }));

  for (const op of ["update", "archive"] as const) {
    const cmd = data.command(`${op} <object>`)
      .description(op === "update" ? "Set values on many records: a dry run first, then asks (--yes to skip)" : "Archive many records: a dry run first, then asks (--yes to skip)")
      .option("--id <id>", "a record ID, repeatable (or use --where)", collect)
      .option("--where <filter>", "field=value, field[op]=value or a JSON filter, repeatable (AND)", collect)
      .option("--expect-version <id=version>", "fail if this record has changed since you read it, repeatable", collect);
    if (op === "update") cmd.option("--set <field=value>", "a value to set, repeatable (JSON for numbers, true/false, null and lists)", collect);
    cmd.addHelpText("after", `\nExample:\n  crm data ${op} contact --where source=webinar${op === "update" ? " --set lifecycle_stage=lead" : ""}\n`
      + `At most 500 records per run. Under --no-input, --yes is required to apply.`);
    cmd.action(act(async (ctx, object: string, opts: { id?: string[]; where?: string[]; set?: string[]; expectVersion?: string[] }) => {
      if (Boolean(opts.id?.length) === Boolean(opts.where?.length)) throw usage("Pass --id or --where (not both)");
      const values = op === "update" ? parseSet(opts.set) : undefined;
      if (values && Object.keys(values).length === 0) throw usage("Pass at least one --set field=value");
      const expected: Record<string, number> = {};
      for (const e of opts.expectVersion ?? []) {
        const [id, v] = e.split("=");
        if (!id || !v || !Number.isInteger(Number(v))) throw usage(`--expect-version "${e}" must look like record_id=version`);
        expected[recordId(id)] = Number(v);
      }
      const body = {
        ...(opts.id ? { ids: opts.id.map(recordId) } : { where: parseWhere(opts.where) }), ...(values ? { values } : {}),
        ...(opts.expectVersion ? { expected_versions: expected } : {}),
      };
      const client = ctx.client();
      const path = `/v1/objects/${objectName(object)}/records/bulk_${op}`;
      const preview = await client.post<BulkResult>(path, { ...body, dry_run: true });
      const errors = preview.counts.error ?? 0;
      if (!ctx.g.json) {
        ctx.out.line(`${preview.count} ${object} record(s) would be ${op === "update" ? "updated" : "archived"}${preview.counts.skip ? ` (${preview.counts.skip} skipped)` : ""}${errors ? `; ${errors} would fail` : ""}.`);
        if (preview.sample?.length) ctx.out.table(preview.sample, ["id", "display_name", "updated_at"]);
        printErrors(ctx, preview.rows);
      }
      if (errors) {
        ctx.exitCode = EXIT.failure;
        if (ctx.g.json) ctx.out.data({ preview });
        else ctx.out.line("Nothing was changed: fix the errors first.");
        return;
      }
      if (preview.count === 0) return ctx.g.json ? ctx.out.data({ preview }) : ctx.out.line("Nothing to do.");
      await ctx.confirm(`${op === "update" ? "Update" : "Archive"} these ${preview.count} record(s)? [y/N] `, `This ${op === "update" ? "updates" : "archives"} ${preview.count} record(s)`);
      const done = await client.post<BulkResult>(path, { ...body, dry_run: false, ...(preview.confirm_token ? { confirm_token: preview.confirm_token } : {}) });
      if (ctx.g.json) return ctx.out.data({ preview, result: done });
      ctx.out.line(`${op === "update" ? "Updated" : "Archived"} ${done.counts[op] ?? 0} record(s)${done.counts.skip ? `, ${done.counts.skip} skipped` : ""}.`);
      if (done.no_longer_matching?.length) ctx.out.info(`Left alone (no longer match the filter): ${done.no_longer_matching.join(", ")}`);
      if (done.new_matches_not_changed) ctx.out.info(`${done.new_matches_not_changed} record(s) match the filter now but weren't in the preview; run again to include them.`);
    }));
  }
}
