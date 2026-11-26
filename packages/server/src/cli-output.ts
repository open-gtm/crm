import { ApiError, ConfigError } from "./lib/errors.js";

/**
 * What the server's command line (cli.ts) prints, kept apart from it so it can be tested without
 * starting a command: the report after `bootstrap`, and how a failed command is told.
 */

/** A value as one shell word: as it is when it is plainly safe, else in single quotes. */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Everything `bootstrap` prints: the workspace, the owner, the keys (once), and exactly what to do next. */
export function bootstrapReport(r: {
  workspace: { id: string; name: string }; owner: { id: string; email: string }; keys: { admin: string; ops: string }; email: string; publicUrl: boolean;
}): string {
  const args = `sign-in-link --email ${shellWord(r.email)} --workspace ${r.workspace.id}`;
  return [
    "",
    `Workspace created: ${r.workspace.name} (${r.workspace.id})`,
    `Owner: ${r.owner.email} (${r.owner.id})`,
    "",
    "API keys (shown once; store them in a password manager):",
    `  Admin key (schema, members, keys + data): ${r.keys.admin}`,
    `  Ops key (records only):                   ${r.keys.ops}`,
    "",
    "Next, sign in from a browser with a one-time link (valid for 15 minutes). Print one with:",
    `  docker compose run --rm api ${args}`,
    "or, without Docker Compose:",
    `  hl-crm-db-server ${args}`,
    ...(r.publicUrl ? [] : ["(This needs PUBLIC_URL set first: the address people open the app at.)"]),
    "Once signed in, set a password (the app offers it straight away, or Settings > Account), so you can sign in again without a new link.",
    "",
  ].join("\n");
}

/** How `limits` is called. */
export function limitsUsage(): string {
  return ["Usage: limits --workspace ws_… [key=value …]",
    "  Shows one workspace's limits. With key=value pairs, sets them first: a whole number, \"unlimited\",",
    "  or \"default\" (back to the server's setting). Example: limits --workspace ws_… records=50000 members=10 webhooks=default",
    "  Needs MIGRATOR_DATABASE_URL (run it where `migrate` runs: docker compose run --rm migrate limits …)."].join("\n");
}

/** What `limits` prints: every limit of the workspace and where its value comes from. */
export function limitsReport(r: { workspace: string; limits: { key: string; limit: number | null; source: "server" | "workspace" }[] }, changed: boolean): string {
  const width = Math.max(...r.limits.map((l) => l.key.length));
  return ["", `${changed ? "Limits set. " : ""}Limits of workspace ${r.workspace}:`,
    ...r.limits.map((l) => `  ${l.key.padEnd(width)}  ${String(l.limit ?? "unlimited").padStart(12)}  ${l.source === "workspace" ? "set for this workspace" : "server default"}`),
    "", "A changed limit applies at once, except requests_per_minute, which each API process picks up within 30 seconds.", ""].join("\n");
}

/** Errors from a mistyped or unknown command-line option (node:util parseArgs). */
const PARSE_ARGS = /^ERR_PARSE_ARGS_/;
/** Database connection failures an operator fixes in their setup: refused, unknown host, wrong password, missing database or role. */
const DB_SETUP = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "28P01", "28000", "3D000"]);

/**
 * The one line to print when a command failed for an expected reason (its setup, how it was called,
 * a refused request such as an invalid email), or null for anything else: a real crash, which is
 * logged with its stack trace.
 */
export function expectedFailure(e: unknown): string | null {
  if (e instanceof ConfigError || e instanceof ApiError) return e.message;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && PARSE_ARGS.test(code)) return `${(e as Error).message}. Run hl-crm-db-server with no arguments to see the commands.`;
  if (typeof code === "string" && DB_SETUP.has(code)) return `Can't connect to the database (${code}): ${(e as Error).message}. Check DATABASE_URL and that Postgres is running.`;
  return null;
}
