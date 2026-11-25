import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { FileInfo } from "@hl-crm-db/sdk";
import type { Command } from "commander";
import { CliError, EXIT, usage } from "../errors.js";
import { checkOutput, writeOutput } from "../files.js";
import { clean } from "../output.js";
import { FILE_ID, RECORD_ID } from "../patterns.js";
import type { Act } from "../program.js";

/**
 * Files attached to records (docs/data-model.md, Files). They follow the record's object access:
 * read lists and downloads, write attaches and removes.
 */

const record = (id: string) => {
  if (!RECORD_ID.test(id)) throw usage(`"${id}" is not a record ID`);
  return id;
};
const file = (id: string) => {
  if (!FILE_ID.test(id)) throw usage(`"${id}" is not a file ID (file_…)`);
  return id;
};

export function registerFiles(program: Command, act: Act): void {
  const files = program.command("files").description("Files attached to records");

  files.command("list <record>").description("List the files attached to a record").action(act(async (ctx, id: string) => {
    const { data } = await ctx.client().listFiles(record(id));
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.map((f) => ({ ...f, name: clean(f.name) })), ["id", "name", "size", "content_type", "created_at"]);
  }));

  files.command("attach <record> <path>").description("Attach a local file to a record")
    .option("--name <name>", "the name to keep it under (default: the file's own name)")
    .action(act(async (ctx, id: string, path: string, opts: { name?: string }) => {
      let bytes: Buffer;
      try {
        if (!statSync(path).isFile()) throw new Error("not a regular file");
        bytes = readFileSync(path);
      } catch (e) {
        throw new CliError("file_unreadable", `Can't read ${path}: ${(e as Error).message.split("\n")[0]}`, EXIT.usage);
      }
      const { data } = await ctx.client().uploadFile(record(id), opts.name ?? basename(path), new Uint8Array(bytes));
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Attached ${clean(data.name)} (${data.id}, ${data.size} bytes) to ${id}.`);
    }));

  files.command("download <file>").description("Download a file's bytes to a local file")
    .option("--output <path>", "where to write it (default: the file's name, in the current directory)")
    .action(act(async (ctx, id: string, opts: { output?: string }) => {
      const client = ctx.client();
      const { data: info } = await client.get<{ data: FileInfo }>(`/v1/files/${file(id)}`);
      // The stored name is one line with no path separators (the server refuses others); basename is the backstop.
      const out = opts.output ?? basename(info.name);
      await checkOutput(ctx, out);
      const bytes = await client.downloadFile(id);
      writeOutput(out, (f) => f.write(bytes));
      if (ctx.g.json) return ctx.out.data({ data: { ...info, written_to: out } });
      ctx.out.line(`Wrote ${clean(info.name)} (${bytes.length} bytes) to ${out}.`);
    }));

  files.command("remove <file>").description("Remove a file from its record and delete its bytes").action(act(async (ctx, id: string) => {
    await ctx.confirm(`Remove file ${id}? It can't be brought back. [y/N] `, `Removing ${id} deletes its bytes`);
    const { data } = await ctx.client().delete<{ data: Record<string, unknown> }>(`/v1/files/${file(id)}`);
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(`Removed ${id}.`);
  }));
}
