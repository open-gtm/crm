#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { bootstrapReport, expectedFailure, limitsReport, limitsUsage } from "./cli-output.js";
import { assertStartupConfig, config, publicOrigin } from "./config.js";
import { assertSafeDbRole, closeDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { ConfigError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";

/**
 * Server entry point. One image runs every role:
 *   api | mcp | worker | migrate | bootstrap | sign-in-link | limits | delete-workspace | seed | audit-verify | mcp-stdio | healthcheck
 */
const [command, ...rest] = process.argv.slice(2);

function shutdownOn(stop: () => Promise<void> | void) {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, async () => {
      logger.info({ signal: sig }, "shutting down");
      await stop();
      await closeDb();
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "healthcheck": {
      // For container healthchecks (the image has no shell or curl). Usage: healthcheck <api|mcp>
      const target = rest[0] === "mcp" ? { port: config().MCP_PORT, path: "/healthz" } : { port: config().API_PORT, path: "/readyz" };
      const res = await fetch(`http://127.0.0.1:${target.port}${target.path}`, { signal: AbortSignal.timeout(2500) }).catch(() => null);
      process.exit(res?.ok ? 0 : 1);
      return;
    }
    case "migrate": {
      assertStartupConfig("migrate");
      const url = config().MIGRATOR_DATABASE_URL;
      if (!url) throw new ConfigError("MIGRATOR_DATABASE_URL is required for migrate (the hlcrm_migrator role)");
      const applied = await migrate(url);
      logger.info({ applied }, applied.length ? "migrations applied" : "database is up to date");
      return;
    }
    case "api": {
      assertStartupConfig("api");
      await assertSafeDbRole();
      const { buildApp } = await import("./api/app.js");
      const { describeWebUi, webUi } = await import("./web/static.js");
      const server = serve({ fetch: buildApp().fetch, port: config().API_PORT, hostname: "0.0.0.0" });
      logger.info({ port: config().API_PORT, ...describeWebUi(webUi()) }, "api listening");
      shutdownOn(() => new Promise<void>((r) => server.close(() => r())));
      return;
    }
    case "mcp": {
      assertStartupConfig("mcp");
      const { buildMcpApp } = await import("./mcp/http.js");
      const { oauthSettings } = await import("./config.js");
      const origins = (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      const oauth = oauthSettings();
      const server = serve({ fetch: buildMcpApp({ apiUrl: config().HLCRM_API_URL, allowedOrigins: origins, oauth }).fetch, port: config().MCP_PORT, hostname: "0.0.0.0" });
      logger.info({ port: config().MCP_PORT, endpoints: ["/mcp/ops", "/mcp/admin"], oauth: oauth ? oauth.resources : "off" }, "mcp listening");
      shutdownOn(() => new Promise<void>((r) => server.close(() => r())));
      return;
    }
    case "mcp-stdio": {
      const { values } = parseArgs({ args: rest, options: { surface: { type: "string", default: "ops" } } });
      const surface = values.surface === "admin" ? "admin" : "ops";
      const key = process.env.HLCRM_API_KEY;
      if (!key) throw new ConfigError("HLCRM_API_KEY is required");
      const { runStdio } = await import("./mcp/stdio.js");
      await runStdio(surface, config().HLCRM_API_URL, key);
      return;
    }
    case "worker": {
      assertStartupConfig("worker");
      await assertSafeDbRole();
      const { startWorker } = await import("./worker/index.js");
      const stop = startWorker();
      shutdownOn(stop);
      return;
    }
    case "bootstrap": {
      const { values } = parseArgs({ args: rest, options: {
        name: { type: "string" }, email: { type: "string" }, "owner-name": { type: "string" }, currency: { type: "string" },
      } });
      if (!values.name || !values.email) throw new ConfigError('Usage: bootstrap --name "My Company" --email you@example.com [--owner-name "Your Name"] [--currency USD]');
      assertStartupConfig("cli");
      await assertSafeDbRole();
      const { createWorkspace } = await import("./core/workspace.js");
      const ws = await createWorkspace({ name: values.name, ownerEmail: values.email, ownerName: values["owner-name"] ?? values.email, currency: values.currency });
      process.stdout.write(bootstrapReport({ workspace: ws.workspace, owner: ws.owner, keys: ws.keys, email: values.email, publicUrl: Boolean(publicOrigin()) }));
      await closeDb();
      return;
    }
    case "sign-in-link": {
      // A one-time browser sign-in link for an existing member, delivered by the operator (works without email).
      const { values } = parseArgs({ args: rest, options: { email: { type: "string" }, workspace: { type: "string" }, "return-to": { type: "string" } } });
      if (!values.email) throw new ConfigError("Usage: sign-in-link --email you@example.com [--workspace ws_…] [--return-to /path/in/the/app]");
      assertStartupConfig("cli");
      if (!publicOrigin()) throw new ConfigError("Set PUBLIC_URL first (the address people open the app at, e.g. https://crm.example.com): the link is built from it");
      await assertSafeDbRole();
      const { createServerLink } = await import("./auth/signin.js");
      const link = await createServerLink(values.email, values.workspace, `cli-${Date.now()}`, values["return-to"]);
      process.stderr.write(`One-time sign-in link for ${link.workspace.name} (${link.workspace.id}), valid until ${link.expiresAt.toISOString()}.\n`
        + "Anyone with it can sign in as this member until it is used or expires; open it yourself or hand it over privately.\n");
      process.stdout.write(`${link.url}\n`);
      await closeDb();
      return;
    }
    case "delete-workspace": {
      // Deletes a workspace and everything in it, now, with no grace period (ADR 0020). The ID must be given twice.
      const { values } = parseArgs({ args: rest, options: { workspace: { type: "string" }, confirm: { type: "string" } } });
      const usage = "Usage: delete-workspace --workspace ws_… --confirm ws_… (the same ID twice: this deletes the workspace and everything in it, at once, for good)";
      if (!values.workspace || !values.confirm) throw new ConfigError(usage);
      if (values.workspace !== values.confirm) throw new ConfigError(`--confirm must repeat the workspace ID exactly. ${usage}`);
      assertStartupConfig("cli");
      await assertSafeDbRole();
      const { deleteWorkspaceNow, parseWorkspaceId } = await import("./core/disposal.js");
      const gone = await deleteWorkspaceNow(parseWorkspaceId(values.workspace), { type: "operator" });
      const rows = Object.values(gone.rows_deleted).reduce((a, b) => a + b, 0);
      process.stdout.write(`Deleted workspace ${gone.id}: ${rows} rows in ${Object.values(gone.rows_deleted).filter((n) => n > 0).length} tables, `
        + `${gone.audit_rows} audit entries (chain ended at position ${gone.audit_chain_pos ?? 0}${gone.audit_head_hash ? `, hash ${gone.audit_head_hash}` : ""}).\n`
        + "A tombstone with these facts and no customer content is kept in deleted_workspaces. Backups made earlier still hold the workspace until they age out.\n");
      await closeDb();
      return;
    }
    case "limits": {
      // One workspace's limits, and setting them (ADR 0019). The operator's command: it connects as the migrator,
      // the only role that may write a limit, so nothing the API accepts can raise one.
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: { type: "string" } } });
      if (!values.workspace) throw new ConfigError(limitsUsage());
      assertStartupConfig("migrate");
      const { parseLimitChanges, workspaceLimits } = await import("./core/limits.js");
      const out = await workspaceLimits(config().MIGRATOR_DATABASE_URL!, values.workspace, parseLimitChanges(positionals));
      process.stdout.write(limitsReport(out, positionals.length > 0));
      return;
    }
    case "seed": {
      assertStartupConfig("cli");
      await assertSafeDbRole();
      const { seedDemo } = await import("./seed.js");
      const out = await seedDemo();
      process.stdout.write(`\nDemo workspace seeded: ${out.summary}\n  Admin key: ${out.keys.admin}\n  Ops key:   ${out.keys.ops}\n\n`);
      await closeDb();
      return;
    }
    case "audit-verify": {
      assertStartupConfig("cli");
      await assertSafeDbRole();
      const { tenantIds, verifyTenant } = await import("./core/auditchain.js");
      const { sealAll } = await import("./worker/index.js");
      const { db } = await import("./db/pool.js");
      await sealAll();
      let ok = true;
      for (const t of await tenantIds(db())) {
        const r = await verifyTenant(t);
        ok &&= r.ok;
        process.stdout.write(`${t}: ${r.ok ? "OK" : `FAILED (${r.problem})`} rows=${r.rows_checked} anchors=${r.anchors_checked} unsealed=${r.unsealed}\n`);
      }
      await closeDb();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    default:
      process.stderr.write("Usage: hl-crm-db-server <api|mcp|worker|migrate|bootstrap|sign-in-link|limits|delete-workspace|seed|audit-verify|mcp-stdio|healthcheck>\n");
      process.exitCode = 2;
  }
}

main().catch(async (e: unknown) => {
  const expected = expectedFailure(e);
  if (expected) {
    // A setup or usage problem: one plain line, no stack trace.
    process.stderr.write(`${expected}\n`);
  } else {
    const err = e instanceof Error ? e : new Error(String(e));
    logger.fatal({ err: { message: err.message, stack: err.stack } }, "fatal");
    process.stderr.write(`${err.message}\n`);
  }
  await closeDb().catch(() => {});
  process.exit(1);
});
