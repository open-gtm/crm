import { existsSync, readFileSync } from "node:fs";
import { HlCrmError } from "@hl-crm-db/sdk";
import type { Command } from "commander";
import { chunkRecords, csvLine, splitRecords, type Chunk } from "../csvsplit.js";
import { CliError, EXIT, toCliError, usage } from "../errors.js";
import { checkOutput, existingFile, OutputFile, startsWithLine, writeOutput } from "../files.js";
import { clean } from "../output.js";
import { FIELD_CONDITION, FILTER_KEY, OBJECT_NAME, RECORD_ID } from "../patterns.js";
import type { Act } from "../program.js";
import { registerRecordWrites } from "./records.js";

/** The server's per-request import limits (core/transfer.ts and the 1 MB body limit, with room for the JSON envelope). */
export const IMPORT_CHUNK_ROWS = 500;
export const IMPORT_CHUNK_BYTES = 800_000;

/** --filter email=a@b.com, --filter amount[gt]=100, --filter account.domain=acme.com → the list route's filter[...] parameters. */
export function filterQuery(filters: string[] = []): Record<string, string> {
  const q: Record<string, string> = {};
  for (const f of filters) {
    const m = FIELD_CONDITION.exec(f);
    if (!m) throw usage(`--filter "${f}" must look like field=value or field[op]=value`);
    q[`filter[${m[1]}]${m[2] ? `[${m[2]}]` : ""}`] = m[3]!;
  }
  return q;
}

/** --map "Company domain=account.domain" (split at the last =, since a column name may contain one). */
export function parseMappings(maps: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) {
    const i = m.lastIndexOf("=");
    if (i <= 0) throw usage(`--map "${m}" must look like column=field (or column= to ignore a column)`);
    out[m.slice(0, i)] = m.slice(i + 1);
  }
  return out;
}

/**
 * --filter field=value (and field[op]=value) as a where tree, for the JSON routes. Values stay text, as on the
 * list route: the server types each by its field (following relation paths), so zip=02139 stays "02139" on a
 * text field and amount[gt]=100 is a number on a number field.
 */
export function filterWhere(filters: string[] = []): unknown {
  const preds = Object.entries(filterQuery(filters)).map(([k, v]) => {
    const m = FILTER_KEY.exec(k)!;
    const op = m[2] ?? "eq";
    const value: unknown = op === "in" || op === "not_in" ? v.split(",") : op === "is_null" ? v !== "false" : v;
    return { path: m[1]!.split("."), op, value };
  });
  return preds.length === 0 ? undefined : preds.length === 1 ? preds[0] : { and: preds };
}

/** The request body of data aggregate. */
export function aggregateBody(object: string, opts: { groupBy?: string; sum?: string[]; avg?: string[]; min?: string[]; max?: string[]; filter?: string[];
  order?: string; view?: string; limit?: string }): Record<string, unknown> {
  objectPath(object);
  const groupBy = opts.groupBy?.split(",").map((s) => s.trim()).filter(Boolean).map((g) => {
    const [field, bucket] = g.split(":");
    return bucket ? { field, bucket } : { field };
  });
  const measures = (["sum", "avg", "min", "max"] as const).flatMap((op) => (opts[op] ?? []).map((field) => ({ op, field })));
  if (opts.order !== undefined && opts.order !== "key" && opts.order !== "count") throw usage("--order must be key or count");
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw usage("--limit must be a positive whole number");
  return Object.fromEntries(Object.entries({ object, where: filterWhere(opts.filter), group_by: groupBy, measures: measures.length ? measures : undefined,
    order: opts.order, view: opts.view, limit }).filter(([, v]) => v !== undefined));
}

const objectPath = (object: string) => {
  if (!OBJECT_NAME.test(object)) throw usage(`"${object}" is not an object name`);
  return `/v1/objects/${object}`;
};

interface Row { row: number; line: number; action: "create" | "update" | "skip" | "error"; id?: string; reason?: string; errors?: unknown }
interface ImportResult { counts: Record<Row["action"], number>; rows: Row[]; key: string | null; ignored_columns: { column: string; reason: string }[] }

export function registerData(program: Command, act: Act, collect: (v: string, p?: string[]) => string[]): void {
  const data = program.command("data").description("Read, export, import and change records");

  data.command("list <object>")
    .description("List records, newest first")
    .option("--filter <field=value>", "filter, repeatable: field=value or field[op]=value (ops: eq neq in not_in gt gte lt lte contains starts_with is_null)", collect)
    .option("--sort <fields>", "sort by up to 3 fields, e.g. name,-amount (- for descending); a single field sorts newest first unless --asc")
    .option("--asc", "ascending order, for a single --sort field")
    .option("--fields <fields>", "show only these fields, e.g. name,amount,stage")
    .option("--count", "also print how many records match (exact up to 10,000)")
    .option("--view <id>", "use a saved view's filter, sort and columns (v_…); --filter, --sort and --fields override it")
    .option("--limit <n>", "records per page (max 200)", "50")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--archived", "only archived records (to find one to restore)")
    .action(act(async (ctx, object: string, opts: { filter?: string[]; sort?: string; asc?: boolean; fields?: string; count?: boolean; view?: string; limit: string; cursor?: string; archived?: boolean }) => {
      const page = await ctx.client().get<{ data: Record<string, unknown>[]; next_cursor: string | null; total?: number; total_capped?: boolean }>(`${objectPath(object)}/records`, {
        ...filterQuery(opts.filter), sort: opts.sort, dir: opts.sort ? (opts.asc ? "asc" : "desc") : undefined, limit: opts.limit, cursor: opts.cursor,
        fields: opts.fields, count: opts.count ? "true" : undefined, view: opts.view, archived_only: opts.archived ? "true" : undefined,
      });
      if (ctx.g.json) return ctx.out.data(page);
      const columns = opts.fields ? ["id", ...opts.fields.split(",").map((s) => s.trim()).filter((s) => s && s !== "id")] : ["id", "display_name", "updated_at"];
      ctx.out.table(page.data, columns);
      if (page.total !== undefined) ctx.out.info(`${page.total_capped ? "More than " : ""}${page.total} matching record(s)`);
      if (page.next_cursor) ctx.out.info(`More: --cursor ${page.next_cursor}`);
    }));

  data.command("aggregate <object>")
    .description("Count and total records per group, e.g. deals by stage with their total amount")
    .option("--group-by <fields>", "up to 2 fields; a date takes a bucket: created_at:month (day, week, month, quarter, year)")
    .option("--sum <field>", "total of a number or currency field, repeatable", collect)
    .option("--avg <field>", "average, repeatable", collect)
    .option("--min <field>", "smallest value, repeatable", collect)
    .option("--max <field>", "largest value, repeatable", collect)
    .option("--filter <field=value>", "filter, repeatable, as in data list (eq and the other ops)", collect)
    .option("--order <order>", "key (default; stages in pipeline order) or count")
    .option("--view <id>", "use a saved view's filter and grouping")
    .option("--limit <n>", "groups at most (max 1000)")
    .addHelpText("after", "\nExample:\n  crm data aggregate deal --group-by stage --sum amount")
    .action(act(async (ctx, object: string, opts: { groupBy?: string; sum?: string[]; avg?: string[]; min?: string[]; max?: string[]; filter?: string[];
      order?: string; view?: string; limit?: string }) => {
      const body = aggregateBody(object, opts);
      const res = await ctx.client().post<{ data: { group: Record<string, unknown>; count: number; values: Record<string, unknown>; currency?: string }[];
        measures: { key: string }[]; truncated: boolean; rows_capped?: boolean }>("/v1/aggregate", body);
      if (ctx.g.json) return ctx.out.data(res);
      const label = (v: unknown) => (v && typeof v === "object" ? String((v as { display_name?: unknown; id?: unknown }).display_name ?? (v as { id?: unknown }).id) : v === null ? "(none)" : String(v));
      const keys = res.measures.map((m) => m.key).filter((k) => k !== "count");
      const rows = res.data.map((g) => ({ ...Object.fromEntries(Object.entries(g.group).map(([k, v]) => [k, label(v)])), count: g.count, ...g.values,
        ...(g.currency ? { currency: g.currency } : {}) }));
      ctx.out.table(rows, [...Object.keys(res.data[0]?.group ?? {}), "count", ...keys, ...(res.data.some((g) => g.currency) ? ["currency"] : [])]);
      if (res.truncated) ctx.out.info("More groups than shown: raise --limit or narrow the filter");
      if (res.rows_capped) ctx.out.info("Too many matching records to count them all: these figures cover the 100,000 most recently updated; narrow the filter");
    }));

  data.command("get <id>")
    .description("Show one record by ID (any object)")
    .action(act(async (ctx, id: string) => {
      if (!RECORD_ID.test(id)) throw usage(`"${id}" is not a record ID`);
      const rec = (await ctx.client().get<{ data: Record<string, unknown> }>(`/v1/records/${id}`)).data;
      if (ctx.g.json) return ctx.out.data(rec);
      const width = Math.max(...Object.keys(rec).map((k) => k.length));
      for (const [k, v] of Object.entries(rec)) ctx.out.line(`${k.padEnd(width)}  ${clean(v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))}`);
    }));

  data.command("export <object>")
    .description("Export records to CSV (or NDJSON), following the server's cursor until every matching record is written")
    .requiredOption("-o, --output <file>", "file to write (created owner-only, never through a symlink); - for stdout")
    .option("--format <format>", "csv or ndjson", "csv")
    .option("--filter <field=value>", "filter, repeatable, as in data list", collect)
    .option("--include-archived", "include archived records")
    .option("--include-hidden", "include hidden fields")
    .addHelpText("after", "\nText cells starting with = + - @ get a leading ' so spreadsheets don't run them; data import removes it.")
    .action(act(async (ctx, object: string, opts: { output: string; format: string; filter?: string[]; includeArchived?: boolean; includeHidden?: boolean }) => {
      if (opts.format !== "csv" && opts.format !== "ndjson") throw usage("--format must be csv or ndjson");
      if (opts.output !== "-") await checkOutput(ctx, opts.output);
      const client = ctx.client();
      const page = (cursor?: string) => client.requestText("GET", `${objectPath(object)}/export`, { query: {
        format: opts.format, cursor, include_archived: opts.includeArchived ? "true" : undefined, include_hidden: opts.includeHidden ? "true" : undefined,
        ...filterQuery(opts.filter),
      } });
      // The first response comes before the file is opened, so a refusal (an object, filter or sort this key
      // can't read) is reported with the API's message and leaves an existing file as it was.
      let res = await page();
      // Exports can hold personal data: the file is readable by its owner only, and replaces an existing one only once complete.
      const fd = opts.output === "-" ? null : new OutputFile(opts.output);
      const write = (s: string) => (fd === null ? ctx.out.raw(s) : fd.write(s));
      let rows = 0;
      let pages = 0;
      try {
        for (;;) {
          // Each response is a complete CSV document; later pages repeat the header, which is dropped.
          let text = res.text;
          if (pages > 0 && opts.format === "csv") {
            const { records } = splitRecords(text);
            text = records.length ? `${records.map((r) => r.text).join("\r\n")}\r\n` : "";
          }
          write(text);
          rows += Number(res.headers.get("x-row-count") ?? 0);
          pages++;
          const cursor = res.headers.get("x-next-cursor") ?? undefined;
          if (!cursor) break;
          if (fd !== null) ctx.out.info(`… ${rows} rows`);
          res = await page(cursor);
        }
        fd?.commit();
      } catch (e) {
        fd?.abort();
        throw e;
      }
      if (opts.output === "-") return;
      if (ctx.g.json) return ctx.out.data({ file: opts.output, rows, requests: pages });
      ctx.out.line(`Wrote ${rows} ${object} record(s) to ${opts.output}.`);
    }));

  data.command("import <object> <file>")
    .description("Import a CSV file: a dry run unless --apply. Large files are sent in chunks; a dry run of every chunk comes first")
    .option("--map <column=field>", "map a CSV column to a field, repeatable; field.lookup resolves relations (account.domain); column= ignores a column", collect)
    .option("--key <field>", "upsert key: id, or a unique field such as email; rows matching an existing record update it")
    .option("--apply", "write the records (otherwise only report what would happen)")
    .option("--report <file>", "where to write the per-row error report (default: <file>.errors.csv); an earlier report is replaced, any other file only with confirmation (or --yes)")
    .option("--keep-formula-quotes", "keep a leading ' before = + - @ (by default it is removed, undoing data export's guard)")
    .addHelpText("after", "\nExamples:\n  crm data import contact people.csv --map Email=email --map Company=account.domain --key email\n"
      + "  crm data import contact people.csv --key email --apply\nEmpty cells leave a field as it is. Columns named like fields map themselves.")
    .action(act(async (ctx, object: string, file: string, opts: { map?: string[]; key?: string; apply?: boolean; report?: string; keepFormulaQuotes?: boolean }) => {
      if (!existsSync(file)) throw usage(`${file} not found`);
      const { header, records } = splitRecords(readFileSync(file, "utf8"));
      if (!header) throw usage(`${file} is empty`);
      const chunks = chunkRecords(header, records, IMPORT_CHUNK_ROWS, IMPORT_CHUNK_BYTES);
      const body = { mapping: parseMappings(opts.map), ...(opts.key ? { key: opts.key } : {}), ...(opts.keepFormulaQuotes ? { unescape_formulas: false } : {}) };
      const client = ctx.client();
      const send = (c: Chunk, dryRun: boolean) => client.post<ImportResult>(`${objectPath(object)}/import`, { csv: c.text, ...body, dry_run: dryRun });
      /** Row numbers from the server count within a chunk; these are the file's. */
      const globalRows = (rows: Row[], c: Chunk, offset: number) => rows.map((r) => ({ ...r, row: offset + r.row, line: c.records[r.row - 1]?.line ?? r.line }));

      const outcome: Row[] = [];
      let ignored: ImportResult["ignored_columns"] = [];
      const reportFile = opts.report ?? `${file}.errors.csv`;
      existingFile(reportFile); // a symlink there is refused before anything is sent
      const finish = async (applied: boolean, appliedChunks: number) => {
        const counts = { create: 0, update: 0, skip: 0, error: 0 };
        for (const r of outcome) counts[r.action]++;
        const failed = outcome.filter((r) => r.action === "error");
        // An earlier error report (its first line is the header this command writes) is simply replaced: it is this
        // command's own output, from a run before. Any other existing file is replaced only when confirmed, as with
        // export; refused, the errors are still printed (and in --json). Never through a symlink (files.ts).
        let notWritten: string | undefined;
        if (failed.length) {
          ctx.exitCode = EXIT.failure;
          try {
            if (!startsWithLine(reportFile, REPORT_HEADER.join(","))) await checkOutput(ctx, reportFile);
            writeReport(reportFile, failed);
          } catch (e) {
            if (!(e instanceof CliError && e.exit === EXIT.notConfirmed)) throw e;
            notWritten = e.message;
          }
        }
        if (ctx.g.json) return ctx.out.data({ applied, chunks: chunks.length, applied_chunks: appliedChunks, counts, ignored_columns: ignored, errors: failed,
          report: failed.length && !notWritten ? reportFile : null, ...(notWritten ? { report_not_written: notWritten } : {}) });
        for (const i of ignored) ctx.out.info(`Ignored column "${clean(i.column)}": ${i.reason}`);
        const [created, updated] = applied ? ["created", "updated"] : ["to create", "to update"];
        ctx.out.line(`${applied ? "Imported" : "Dry run"}: ${counts.create} ${created}, ${counts.update} ${updated}, ${counts.skip} unchanged, `
          + `${counts.error} with errors (${outcome.length} rows, ${chunks.length} request(s)).`);
        for (const r of failed.slice(0, 10)) ctx.out.line(`  row ${r.row} (line ${r.line}): ${clean(r.reason ?? "error")}`);
        if (notWritten) ctx.out.info(`The error report was not written: ${notWritten}`);
        else if (failed.length) ctx.out.line(`Errors for every failed row are in ${reportFile}.${applied ? "" : " Nothing was written."}`);
        else if (!applied) ctx.out.line("Nothing was written. Run again with --apply to import.");
      };

      // A dry run first whenever applying would take more than one request: each request is all or
      // nothing, the file as a whole is not, so a bad row in a late chunk must stop the import before it starts.
      if (!opts.apply || chunks.length > 1) {
        let offset = 0;
        for (const c of chunks) {
          const r = await send(c, true);
          ignored = r.ignored_columns;
          outcome.push(...globalRows(r.rows, c, offset));
          offset += c.records.length;
        }
        if (!opts.apply || outcome.some((r) => r.action === "error")) return finish(false, 0);
        outcome.length = 0;
      }
      let offset = 0;
      for (const [i, c] of chunks.entries()) {
        try {
          const r = await send(c, false);
          ignored = r.ignored_columns;
          outcome.push(...globalRows(r.rows, c, offset));
        } catch (e) {
          if (e instanceof HlCrmError && e.code === "import_failed" && Array.isArray(e.details)) {
            outcome.push(...globalRows(e.details as Row[], c, offset));
            ctx.out.info(`Request ${i + 1} of ${chunks.length} failed and was rolled back${i ? `; the ${i} before it were applied` : ""}.`);
            return finish(i > 0, i);
          }
          if (i > 0) ctx.out.info(`Stopped at request ${i + 1} of ${chunks.length}; the ${i} before it were applied.`);
          throw toCliError(e);
        }
        offset += c.records.length;
      }
      await finish(true, chunks.length);
    }));

  registerRecordWrites(data, act, collect);
}

/** The import error report's header: its first line, which is also how a later run recognises its own report. */
const REPORT_HEADER = ["row", "line", "action", "id", "reason", "details"];

function writeReport(path: string, rows: Row[]): void {
  writeOutput(path, (f) => {
    f.write(csvLine(REPORT_HEADER));
    for (const r of rows) f.write(csvLine([String(r.row), String(r.line), r.action, r.id ?? "", r.reason ?? "", r.errors ? JSON.stringify(r.errors) : ""]));
  });
}
