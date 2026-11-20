import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { ConfigError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { appliedMigrations, applyGrants, ensureMigrationsTable, recordMigration, runMigrationScript } from "./queries.js";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/**
 * Applies pending SQL migrations in order, each in its own transaction, then refreshes grants.
 * `upTo` stops after the migration with that prefix (tests of upgrades from an older database).
 */
export async function migrate(migratorUrl: string, appRole = process.env.APP_DB_ROLE ?? "hlcrm_app", opts: { upTo?: string } = {}): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new ConfigError("APP_DB_ROLE must be a plain identifier");
  const sql = postgres(migratorUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await ensureMigrationsTable(sql);
    const done = new Map((await appliedMigrations(sql)).map((r) => [r.name, r.checksum]));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && (!opts.upTo || f.slice(0, opts.upTo.length) <= opts.upTo)).sort();
    for (const file of files) {
      const text = readFileSync(new URL(file, MIGRATIONS_DIR), "utf8");
      const checksum = createHash("sha256").update(text).digest("hex");
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new ConfigError(`Migration ${file} was changed after it was applied`);
        continue;
      }
      await sql.begin(async (tx) => {
        await runMigrationScript(tx, text);
        await recordMigration(tx, file, checksum);
      });
      applied.push(file);
      logger.info({ migration: file }, "applied migration");
    }
    await applyGrants(sql, grantsSql(appRole));
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Least-privilege grants for the app role. Append-only tables get INSERT and SELECT only; spent confirm tokens are
 * inserted, read and expired, never changed. An installed pack's row is kept after an uninstall (it keeps versions
 * going forward and its names reserved), so the app never deletes one.
 */
function grantsSql(role: string): string {
  return `
    GRANT USAGE ON SCHEMA public, app TO ${role};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role};
    REVOKE ALL ON schema_migrations FROM ${role};
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM ${role};
    GRANT UPDATE (prev_hash, hash, sealed_at) ON audit_log TO ${role};
    REVOKE UPDATE, DELETE, TRUNCATE ON schema_changes, deal_stage_history, audit_anchors FROM ${role};
    REVOKE DELETE, TRUNCATE ON roles FROM ${role};
    ${ifTable("merges", `REVOKE UPDATE, DELETE, TRUNCATE ON merges FROM ${role}`)}
    ${ifTable("confirm_tokens", `REVOKE UPDATE, TRUNCATE ON confirm_tokens FROM ${role}`)}
    ${ifTable("installed_packs", `REVOKE DELETE, TRUNCATE ON installed_packs FROM ${role}`)}
  `;
}

/** A statement for a table added by a later migration: skipped while the database is older (`migrate`'s `upTo`). */
function ifTable(table: string, statement: string): string {
  return `DO $$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN EXECUTE '${statement}'; END IF; END $$;`;
}
