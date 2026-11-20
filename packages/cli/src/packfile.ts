import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { CliError, EXIT } from "./errors.js";
import { PACK_NAME, PACK_VERSION } from "./patterns.js";

/**
 * Reading schema packs from disk (docs/packs.md). A pack is a folder holding pack.yaml (the manifest) and
 * one file per part (schema.yaml, roles.yaml, views.yaml; .yml or .json too), or a single file holding the
 * manifest with its parts inline. Packs are downloaded from strangers, so reading one is careful: only
 * those fixed file names are read (never a name from the pack itself), never through a symlink, each file
 * size-capped, YAML parsed with the CLI's limits. The server checks everything again; this catches
 * mistakes early and keeps the request small.
 */

export const PACK_PARTS = ["schema", "roles", "views"] as const;
export type PackPart = (typeof PACK_PARTS)[number];
/** Per file. The API takes a body of at most 1 MB, so a bigger pack could not be sent anyway. */
export const PACK_FILE_MAX = 512 * 1024;
const MANIFEST_KEYS = ["name", "version", "description", "min_server_version", "modules", "parts", "license"];
const EXTENSIONS = [".yaml", ".yml", ".json"];

export interface PackPayload {
  manifest: Record<string, unknown> & { name: string; version: string; parts: PackPart[] };
  schema?: Record<string, unknown>;
  roles?: unknown[];
  views?: unknown[];
}

const invalid = (message: string) => new CliError("pack_invalid", message, EXIT.usage);
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A regular file's text, refusing symlinks, other file types, oversized files and text that isn't UTF-8. The file
 * is opened without following a symlink and checked through the open handle, so it can't be swapped for a link
 * (or grow) between the check and the read; at most the size limit plus one byte is ever read.
 */
function readSmall(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP" || lstatSync(path).isSymbolicLink()) throw invalid(`${path} is a symbolic link; packs are read only from regular files`);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw invalid(`${path} is not a regular file`);
    if (st.size > PACK_FILE_MAX) throw invalid(`${path} is larger than ${PACK_FILE_MAX / 1024} KB`);
    const buf = Buffer.alloc(PACK_FILE_MAX + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > PACK_FILE_MAX) throw invalid(`${path} is larger than ${PACK_FILE_MAX / 1024} KB`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, n));
    } catch {
      throw invalid(`${path} is not UTF-8 text`);
    }
  } finally {
    closeSync(fd);
  }
}

function parse(text: string, path: string): unknown {
  try {
    return path.toLowerCase().endsWith(".json") ? JSON.parse(text) : YAML.parse(text, { uniqueKeys: true, maxAliasCount: 100 });
  } catch (e) {
    throw invalid(`${path} is not valid ${path.toLowerCase().endsWith(".json") ? "JSON" : "YAML"}: ${(e as Error).message.split("\n")[0]}`);
  }
}

/** The one file in `dir` named `base` with a known extension, or undefined. Two (pack.yaml and pack.json) is an error. */
function findFile(dir: string, entries: string[], base: string): string | undefined {
  const found = EXTENSIONS.map((e) => `${base}${e}`).filter((n) => entries.includes(n));
  if (found.length > 1) throw invalid(`${dir} holds both ${found.join(" and ")}; keep one`);
  return found[0] ? join(dir, found[0]) : undefined;
}

/** Reads a pack folder or single-file pack into the request body the server takes. */
export function readPack(path: string): PackPayload {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw invalid(`${path} not found`);
  }
  if (st.isSymbolicLink()) throw invalid(`${path} is a symbolic link; give the folder or file itself`);
  let top: Record<string, unknown>;
  const fromFiles: Partial<Record<PackPart, unknown>> = {};
  if (st.isDirectory()) {
    const entries = readdirSync(path);
    const manifest = findFile(path, entries, "pack");
    if (!manifest) throw invalid(`${path} has no pack.yaml (or pack.json); crm pack init writes one`);
    const doc = parse(readSmall(manifest), manifest);
    if (!isMap(doc)) throw invalid(`${manifest} must hold a mapping (name:, version:, parts:, …)`);
    top = doc;
    for (const part of PACK_PARTS) {
      const file = findFile(path, entries, part);
      if (!file) continue;
      if (Object.hasOwn(top, part)) throw invalid(`The ${part} part is both in ${manifest} and in ${file}; keep one`);
      const body = parse(readSmall(file), file);
      // schema.yaml is a schema document; roles.yaml and views.yaml hold a list under their name (or the list itself).
      fromFiles[part] = part === "schema" ? body : isMap(body) && Object.keys(body).length === 1 && Object.hasOwn(body, part) ? body[part] : body;
    }
  } else if (st.isFile()) {
    const doc = parse(readSmall(path), path);
    if (!isMap(doc)) throw invalid(`${path} must hold a mapping (name:, version:, parts:, schema:, …)`);
    top = doc;
  } else {
    throw invalid(`${path} is neither a folder nor a file`);
  }
  const manifest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(top)) {
    if ((PACK_PARTS as readonly string[]).includes(k)) continue;
    if (!MANIFEST_KEYS.includes(k)) throw invalid(`The manifest has an unknown key "${k.slice(0, 40)}"; it takes ${MANIFEST_KEYS.join(", ")}`);
    manifest[k] = v;
  }
  const out: PackPayload = { manifest: manifest as PackPayload["manifest"] };
  for (const part of PACK_PARTS) {
    const v = Object.hasOwn(top, part) ? top[part] : fromFiles[part];
    if (v === undefined) continue;
    if (part === "schema" ? !isMap(v) : !Array.isArray(v)) throw invalid(`The ${part} part must be ${part === "schema" ? "a mapping (objects:, pipelines:)" : "a list"}`);
    (out as unknown as Record<string, unknown>)[part] = v;
  }
  checkPack(out);
  return out;
}

/** The checks that need no server: the manifest's shape, and that it lists exactly the parts the pack holds. */
export function checkPack(p: PackPayload): void {
  const m = p.manifest;
  if (typeof m.name !== "string" || !PACK_NAME.test(m.name)) throw invalid("name must be 2 to 63 lowercase letters, digits and hyphens");
  if (typeof m.version !== "string" || !PACK_VERSION.test(m.version)) throw invalid("version must be MAJOR.MINOR.PATCH, e.g. 1.0.0");
  if (!Array.isArray(m.parts) || m.parts.length === 0) throw invalid("parts must list what the pack holds: schema, roles, views");
  for (const part of m.parts as unknown[]) {
    if (part === "automations") throw invalid("Packs can't carry automations in this version");
    if (!(PACK_PARTS as readonly unknown[]).includes(part)) throw invalid(`parts: "${String(part).slice(0, 40)}" is not a part (schema, roles, views)`);
  }
  for (const part of PACK_PARTS) {
    const present = p[part] !== undefined;
    if (present !== m.parts.includes(part)) throw invalid(present ? `The pack holds a ${part} part that parts doesn't list` : `parts lists ${part}, which the pack doesn't hold`);
  }
}

/** A short summary for people: counts per part. */
export function summarize(p: PackPayload): Record<string, number> {
  const objects = (p.schema?.objects as unknown[] | undefined) ?? [];
  return {
    objects: objects.length,
    fields: objects.reduce<number>((n, o) => n + ((isMap(o) && Array.isArray(o.fields) ? o.fields.length : 0)), 0),
    pipelines: ((p.schema?.pipelines as unknown[] | undefined) ?? []).length,
    roles: p.roles?.length ?? 0,
    views: p.views?.length ?? 0,
  };
}

const TEMPLATE_DIR = new URL("../templates/pack/", import.meta.url);
const TEMPLATE_FILES = ["pack.yaml", "schema.yaml", "views.yaml"] as const;

/** The example pack `crm pack init` writes: the files in templates/pack, by name. */
export function packTemplate(): Record<string, string> {
  return Object.fromEntries(TEMPLATE_FILES.map((name) => [name, readFileSync(new URL(name, TEMPLATE_DIR), "utf8")]));
}
