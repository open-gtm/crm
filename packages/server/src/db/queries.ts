import type { Sql, Tx } from "./pool.js";

/**
 * The SQL of the database layer itself (ADR 0012): entering a tenant, the startup role checks and the
 * migration runner. The code that calls these keeps its checks, errors and transactions.
 */

// --- Tenant isolation -------------------------------------------------------------------------------

/**
 * Sets the transaction's tenant (app.tenant_id), which every row-level security policy checks. The
 * third argument of set_config, true, makes it local to the transaction (SET LOCAL semantics), so it
 * ends at commit or rollback and can't leak to the next user of a pooled connection.
 */
export async function setTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

// --- Startup checks ---------------------------------------------------------------------------------

/** The role this connection runs as, and whether it is a superuser or may bypass row-level security. */
export async function currentRole(sql: Sql): Promise<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined> {
  const [role] = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  return role;
}

/** How many tables in the public schema this connection's role owns. */
export async function countOwnedTables(sql: Sql): Promise<{ n: number } | undefined> {
  const [owner] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`;
  return owner;
}

// --- Migrations -------------------------------------------------------------------------------------

/** Creates the table of applied migrations if it doesn't exist yet. */
export async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
}

/** The migrations applied so far, with the checksum each had. */
export async function appliedMigrations(sql: Sql): Promise<{ name: string; checksum: string }[]> {
  return sql<{ name: string; checksum: string }[]>`SELECT name, checksum FROM schema_migrations`;
}

/** Runs one migration file's text, as it is in the repository (it may hold several statements). */
export async function runMigrationScript(tx: Tx, script: string): Promise<void> {
  await tx.unsafe(script);
}

export async function recordMigration(tx: Tx, file: string, checksum: string): Promise<void> {
  await tx`INSERT INTO schema_migrations (name, checksum) VALUES (${file}, ${checksum})`;
}

/** Runs the GRANT and REVOKE statements migrate.ts builds for the app role (whose name it validated). */
export async function applyGrants(sql: Sql, statements: string): Promise<void> {
  await sql.unsafe(statements);
}
