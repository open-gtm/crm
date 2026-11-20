import postgres from "postgres";
import { config } from "../config.js";
import { ConfigError } from "../lib/errors.js";
import { countOwnedTables, currentRole } from "./queries.js";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

let pool: Sql | undefined;

/** Connections in the application pool. The heavy-request gate (api/app.ts) is sized from it. */
export const POOL_MAX = 10;

/** The application pool. Connects as hlcrm_app, which is subject to row-level security. */
export function db(): Sql {
  const url = config().DATABASE_URL;
  if (!url) throw new ConfigError("DATABASE_URL is required (connect as the hlcrm_app role)");
  pool ??= postgres(url, {
    max: POOL_MAX,
    idle_timeout: 30,
    // A request stuck between statements releases its pooled connection (and its locks) after 30s.
    connection: { application_name: "hl-crm-db", statement_timeout: 5000, idle_in_transaction_session_timeout: 30_000 },
    types: { bigint: postgres.BigInt },
    onnotice: () => {},
  });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end({ timeout: 5 });
  pool = undefined;
}

/**
 * Refuses to run if the app role could bypass row-level security.
 * Tenant isolation depends on this, so it is checked at every startup.
 */
export async function assertSafeDbRole(sql: Sql = db()): Promise<void> {
  const role = await currentRole(sql);
  if (!role) throw new Error("Could not read the current database role");
  if (role.rolsuper || role.rolbypassrls) {
    throw new ConfigError(
      `Refusing to start: database role "${role.rolname}" can bypass row-level security. ` +
        "Connect as the hlcrm_app role (see deploy/postgres/init-roles.sh).",
    );
  }
  const owner = await countOwnedTables(sql);
  if ((owner?.n ?? 0) > 0) {
    throw new ConfigError("Refusing to start: the app role owns tables. Run migrations as hlcrm_migrator instead.");
  }
}
