import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import YAML from "yaml";
import type { Context } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { clean, cleanLine } from "../output.js";
import { AUTOMATION_ID } from "../patterns.js";
import type { Act } from "../program.js";

/**
 * Automations (needs automations:manage, except `run` for roles an automation names in run_roles).
 * create and update read the API's shape from a YAML or JSON file, show the dry run (summary, every
 * URL and recipient, warnings, next runs) and apply only after confirmation: --yes, or yes at the
 * prompt; with --no-input, --yes is required. run shows a dry run the same way first.
 */

const automationId = (id: string) => {
  if (!AUTOMATION_ID.test(id)) throw usage(`"${id}" is not an automation ID (auto_…)`);
  return id;
};

/** One automation definition from a YAML or JSON file. */
function readDefinition(file: string): Record<string, unknown> {
  if (!existsSync(file)) throw usage(`${file} not found`);
  try {
    const parsed = YAML.parse(readFileSync(file, "utf8"), { uniqueKeys: true, maxAliasCount: 100 }) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it must hold one automation (a mapping)");
    if ("dry_run" in parsed) throw new Error("leave dry_run out; the CLI always shows the dry run first");
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new CliError("automation_file_invalid", `${file} is not a valid automation file: ${(e as Error).message.split("\n")[0]}`, EXIT.usage);
  }
}

interface Preview { summary: string; warnings?: string[]; next_runs?: string[]; automation?: Record<string, unknown> }

function showPreview(ctx: Context, p: Preview): void {
  ctx.out.info(cleanLine(p.summary));
  for (const w of p.warnings ?? []) ctx.out.info(ctx.out.paint("warn", `warning: ${cleanLine(w)}`));
  if (p.next_runs?.length) ctx.out.info(`Next runs: ${p.next_runs.join(", ")}`);
}

/** Step results of a run or dry run, one line each. */
function showSteps(ctx: Context, steps: { step: string; action: string; ok: boolean; skipped?: string; detail?: Record<string, unknown> }[]): void {
  for (const s of steps) {
    const d = s.detail ?? {};
    const what = d.would_send ? `${String((d.would_send as Record<string, unknown>).method)} ${String((d.would_send as Record<string, unknown>).url)}`
      : d.would_email ? `email ${String((d.would_email as Record<string, unknown>).to)}`
      : d.error ? String(d.error) : d.reason ? String(d.reason) : "";
    ctx.out.line(cleanLine(`${s.step.padEnd(6)} ${s.action.padEnd(14)} ${s.skipped ? `skipped: ${s.skipped}` : s.ok ? "ok" : "failed"}${what ? `  ${what}` : ""}`));
  }
}

export function registerAutomations(program: Command, act: Act): void {
  const automations = program.command("automations").description("Automations: event, schedule and run-on-request rules (needs automations:manage)");

  automations.command("list").description("List automations").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: (Record<string, unknown> & { trigger: Record<string, unknown> })[] }>("/v1/automations");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.map((a) => ({ ...a, trigger: a.trigger.type === "event" ? a.trigger.event : a.trigger.type })), ["id", "name", "status", "trigger", "next_run_at", "updated_at"]);
  }));

  automations.command("get <id>").description("Show one automation (secret header values are never returned)").action(act(async (ctx, id: string) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown> }>(`/v1/automations/${automationId(id)}`);
    if (ctx.g.json) return ctx.out.data({ data });
    for (const [k, v] of Object.entries(data)) ctx.out.line(`${k.padEnd(22)} ${clean(v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))}`);
  }));

  const save = async (ctx: Context, method: "post" | "patch", path: string, body: Record<string, unknown>, dryOnly: boolean) => {
    const client = ctx.client();
    const preview = await client[method]<Preview>(path, { ...body, dry_run: true });
    if (ctx.g.json && dryOnly) return ctx.out.data(preview);
    showPreview(ctx, preview);
    if (dryOnly) return;
    await ctx.confirm(`${method === "post" ? "Create" : "Apply"} this automation? [y/N] `, "Saving an automation changes what the CRM does on its own");
    const out = await client[method]<Preview & { automation: { id: string; status: string } }>(path, { ...body, dry_run: false });
    if (ctx.g.json) return ctx.out.data(out);
    ctx.out.line(`${method === "post" ? "Created" : "Updated"} ${out.automation.id} (${out.automation.status}).`);
  };

  automations.command("create").description("Create an automation from a YAML or JSON file: shows the dry run, then asks")
    .requiredOption("-f, --file <path>", "the automation, in the API's shape (name, trigger, condition, actions, …)")
    .option("--dry-run", "only show the dry run")
    .action(act(async (ctx, opts: { file: string; dryRun?: boolean }) => save(ctx, "post", "/v1/automations", readDefinition(opts.file), Boolean(opts.dryRun))));

  automations.command("update <id>").description("Change an automation from a YAML or JSON file (only the keys it holds): shows the dry run, then asks")
    .requiredOption("-f, --file <path>", "the fields to change; a secret header given as null keeps its stored value")
    .option("--dry-run", "only show the dry run")
    .action(act(async (ctx, id: string, opts: { file: string; dryRun?: boolean }) =>
      save(ctx, "patch", `/v1/automations/${automationId(id)}`, readDefinition(opts.file), Boolean(opts.dryRun))));

  automations.command("pause <id>").description("Pause an automation: no new runs until it is resumed")
    .option("--reason <text>", "why, shown on the automation")
    .action(act(async (ctx, id: string, opts: { reason?: string }) => {
      const { data } = await ctx.client().post<{ data: { id: string; status: string } }>(`/v1/automations/${automationId(id)}/pause`, { reason: opts.reason });
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`${data.id} is ${data.status}.`);
    }));

  automations.command("resume <id>").description("Resume a paused automation (it starts sending again)").action(act(async (ctx, id: string) => {
    await ctx.confirm(`Resume ${id}? Its runs and sends start again. [y/N] `, "Resuming an automation starts its runs again");
    const { data } = await ctx.client().post<{ data: { id: string; status: string } }>(`/v1/automations/${automationId(id)}/resume`, {});
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(`${data.id} is ${data.status}.`);
  }));

  automations.command("run <id>").description("Run an automation now for records (or none, for a schedule): shows a dry run, then asks")
    .option("-r, --record <id...>", "records of the trigger's object (at most 25)")
    .option("--dry-run", "only show the dry run")
    .action(act(async (ctx, id: string, opts: { record?: string[]; dryRun?: boolean }) => {
      const client = ctx.client();
      const path = `/v1/automations/${automationId(id)}/run`;
      const body = { records: opts.record };
      let dry: { data: { runs: { record: string | null; matched: boolean; explanation: string; actions: Parameters<typeof showSteps>[1] }[] } } | null = null;
      try {
        dry = await client.post(path, { ...body, dry_run: true });
      } catch (e) {
        // A member whose role may run it, but not manage it, can't see a dry run (it would show what the automation's own access reads).
        if ((e as { status?: number }).status !== 403 || opts.dryRun) throw e;
        ctx.out.info("No dry run: it needs automations:manage. The run acts with the automation's access.");
      }
      if (dry) {
        if (ctx.g.json && opts.dryRun) return ctx.out.data(dry);
        for (const r of dry.data.runs) {
          ctx.out.info(cleanLine(`${r.record ?? "(no record)"}: ${r.explanation}`));
          if (!ctx.g.json) showSteps(ctx, r.actions);
        }
        if (opts.dryRun) return;
      }
      await ctx.confirm(`Run ${id} now? [y/N] `, "Running an automation changes records and can send data out");
      const out = await client.post<{ data: { runs: { id: string; record: string | null }[] } }>(path, body);
      if (ctx.g.json) return ctx.out.data(out);
      ctx.out.line(`Queued ${out.data.runs.map((r) => r.id).join(", ")}; see crm automations runs ${id}.`);
    }));

  automations.command("runs <id>").description("Recent runs, newest first")
    .option("--status <status>", "queued, running, succeeded, failed or skipped")
    .option("--limit <n>", "runs (max 200)", "20")
    .option("--steps", "print each run's steps")
    .action(act(async (ctx, id: string, opts: { status?: string; limit: string; steps?: boolean }) => {
      const { data } = await ctx.client().get<{ data: (Record<string, unknown> & { results: Parameters<typeof showSteps>[1] })[] }>(`/v1/automations/${automationId(id)}/runs`,
        { status: opts.status, limit: opts.limit });
      if (ctx.g.json) return ctx.out.data({ data });
      // A skip by a cap and a failure caused by record data read apart from the others (neither pauses the automation).
      const shown = data.map((r): typeof r => ({ ...r, status: r.cap ? `${String(r.status)} (cap)` : r.failure === "data" ? `${String(r.status)} (data)` : r.status }));
      if (!opts.steps) return ctx.out.table(shown, ["id", "trigger", "status", "record_id", "started_at", "reason"]);
      for (const r of shown) {
        ctx.out.line(cleanLine(`${String(r.id)}  ${String(r.trigger)}  ${String(r.status)}  ${String(r.started_at)}${r.reason ? `  ${String(r.reason)}` : ""}`));
        showSteps(ctx, Array.isArray(r.results) ? r.results : []);
      }
    }));
}
