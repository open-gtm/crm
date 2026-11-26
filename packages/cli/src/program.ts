import { Command, CommanderError, Option } from "commander";
import { registerAdmin } from "./commands/admin.js";
import { registerAuth } from "./commands/auth.js";
import { registerAutomations } from "./commands/automations.js";
import { registerData } from "./commands/data.js";
import { registerPack } from "./commands/pack.js";
import { registerFiles } from "./commands/attachments.js";
import { registerSchema } from "./commands/schema.js";
import { Context, type Globals } from "./context.js";
import { CliError, EXIT, toCliError } from "./errors.js";
import { clean } from "./output.js";
import type { Runtime } from "./runtime.js";
import { CLI_VERSION } from "./version.js";

/** Builds a Context for the command being run, from the global options wherever they appeared. */
export type Make = (cmd: Command) => Context;

/** Wraps a command's action: builds its Context, and records it so run() can read the exit code. */
export type Act = <A extends unknown[]>(fn: (ctx: Context, ...args: A) => Promise<void>) => (...args: unknown[]) => Promise<void>;

/** Collects a repeatable option (--map a=b --map c=d). */
export const collect = (value: string, previous: string[] = []) => [...previous, value];

export function buildProgram(rt: Runtime, state: { ctx?: Context }): Command {
  const program = new Command("crm")
    .description("Command-line client for hl-crm-db: schema-as-code, CSV import and export, and administration.\nDocs: docs/cli.md")
    .version(CLI_VERSION, "-V, --version")
    .option("--json", "machine-readable output: one JSON document (NDJSON for streams); errors as JSON on stderr")
    .option("--no-input", "never prompt; a confirmation that is needed and not given with --yes is an error")
    .option("-y, --yes", "confirm changes without asking")
    .option("--remote <name>", "use this saved remote instead of the current one")
    .addOption(new Option("--insecure-http", "allow http:// to a host other than localhost (the key crosses the network unencrypted)"))
    .showHelpAfterError("(run with --help for usage)")
    .exitOverride()
    .configureOutput({ writeOut: rt.stdout, writeErr: rt.stderr, outputError: (s, write) => write(s) });

  const make: Make = (cmd) => {
    const o = cmd.optsWithGlobals() as Partial<Globals> & { input?: boolean };
    const ctx = new Context(rt, { json: Boolean(o.json), input: o.input !== false, yes: Boolean(o.yes), remote: o.remote, insecureHttp: Boolean(o.insecureHttp) });
    state.ctx = ctx;
    return ctx;
  };
  const act: Act = (fn) => async (...args) => {
    const cmd = args[args.length - 1] as Command;
    await fn(make(cmd), ...(args.slice(0, -1) as never));
  };

  registerAuth(program, act);
  registerSchema(program, act);
  registerData(program, act, collect);
  registerAdmin(program, act);
  registerAutomations(program, act);
  registerPack(program, act, collect);
  registerFiles(program, act);
  // Subcommands inherit exit handling and output settings.
  for (const c of allCommands(program)) c.exitOverride().configureOutput({ writeOut: rt.stdout, writeErr: rt.stderr });
  return program;
}

function allCommands(c: Command): Command[] {
  return c.commands.flatMap((x) => [x, ...allCommands(x)]);
}

/** Runs the CLI and returns the exit code. Never calls process.exit, so tests can drive it. */
export async function run(argv: string[], rt: Runtime): Promise<number> {
  const state: { ctx?: Context } = {};
  const program = buildProgram(rt, state);
  const json = argv.includes("--json");
  try {
    await program.parseAsync(argv, { from: "user" });
    return state.ctx?.exitCode ?? EXIT.ok;
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version" || e.code === "commander.help") return EXIT.ok;
      // Commander has already printed the message.
      if (json) rt.stderr(`${JSON.stringify({ error: { code: "usage", message: e.message } })}\n`);
      return EXIT.usage;
    }
    const err = toCliError(e);
    report(rt, err, json);
    return err.exit;
  }
}

/** Prints an error: the API's problem detail and request ID, or the CLI's own message. */
function report(rt: Runtime, err: CliError, json: boolean): void {
  if (json) {
    rt.stderr(`${JSON.stringify({ error: { code: err.code, message: err.message, status: err.extra.status, request_id: err.extra.requestId,
      details: err.extra.details }, exit_code: err.exit })}\n`);
    return;
  }
  rt.stderr(`Error: ${clean(err.message)}${err.extra.status ? ` (${err.extra.status} ${err.code})` : ""}\n`);
  const details = err.extra.details;
  if (Array.isArray(details)) {
    for (const d of details.slice(0, 20)) {
      const x = d as Record<string, unknown>;
      const where = x.path ?? x.field ?? (x.row !== undefined ? `row ${String(x.row)}` : undefined);
      const what = x.message ?? x.reason ?? x.warning ?? x.change;
      rt.stderr(`  - ${where !== undefined ? `${clean(String(where))}: ` : ""}${clean(String(what ?? JSON.stringify(d)))}\n`);
    }
    if (details.length > 20) rt.stderr(`  … and ${details.length - 20} more (use --json for all)\n`);
  }
  if (err.extra.requestId) rt.stderr(`Request ID: ${err.extra.requestId}\n`);
}
