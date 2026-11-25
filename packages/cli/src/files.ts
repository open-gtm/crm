import { randomBytes } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "./context.js";
import { CliError, EXIT } from "./errors.js";

/**
 * Files the CLI writes that can hold record data (exports, import error reports). They are never
 * written through a symlink: one planted where the file will go (a dangling one included) could
 * point anywhere. An existing file is replaced only with confirmation (--yes, or yes at the
 * prompt; never asked with --no-input).
 */
export async function checkOutput(ctx: Context, path: string): Promise<void> {
  if (existingFile(path)) await ctx.confirm(`${path} exists. Overwrite it? [y/N] `, `${path} already exists`);
}

/**
 * True when the regular file at `path` begins with exactly `firstLine` (a header the CLI itself
 * writes, such as the import error report's), read without following a symlink. Lets a command
 * replace its own earlier output without asking, while a file it didn't write still needs confirming.
 */
export function startsWithLine(path: string, firstLine: string): boolean {
  if (!existingFile(path)) return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return false;
  }
  try {
    const want = Buffer.from(firstLine, "utf8");
    const buf = Buffer.alloc(want.length + 2);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    return head.subarray(0, want.length).equals(want) && (head.length === want.length || head[want.length] === 0x0d || head[want.length] === 0x0a);
  } finally {
    closeSync(fd);
  }
}

/** True when a regular file is at `path`; refuses a symlink or anything else that isn't one. */
export function existingFile(path: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (st.isSymbolicLink()) throw new CliError("output_is_symlink", `${path} is a symbolic link; refusing to write through it. Remove it or choose another file`, EXIT.usage);
  if (!st.isFile()) throw new CliError("output_not_a_file", `${path} exists and is not a regular file`, EXIT.usage);
  return true;
}

/**
 * A new owner-only (0600) file beside `path`, created exclusively without following symlinks and
 * renamed over `path` on commit. A rename replaces whatever is at `path`, a symlink included, and
 * never writes through it; until then (and after abort) an existing file is left as it was.
 */
export class OutputFile {
  private readonly tmp: string;
  private readonly fd: number;

  constructor(readonly path: string) {
    this.tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
    this.fd = openSync(this.tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  }

  write(s: string | Uint8Array): void {
    if (typeof s === "string") writeSync(this.fd, s);
    else writeSync(this.fd, s);
  }

  commit(): void {
    closeSync(this.fd);
    renameSync(this.tmp, this.path);
  }

  abort(): void {
    try {
      closeSync(this.fd);
    } catch {
      // already closed by a failed commit
    }
    try {
      unlinkSync(this.tmp);
    } catch {
      // gone already
    }
  }
}

/** Writes a whole file through OutputFile. */
export function writeOutput(path: string, write: (f: OutputFile) => void): void {
  const f = new OutputFile(path);
  try {
    write(f);
    f.commit();
  } catch (e) {
    f.abort();
    throw e;
  }
}
