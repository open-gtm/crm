import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { assertSafeDbRole, db } from "../src/db/pool.js";
import { newWorkspace, create } from "./helpers.js";
import { CATALOG } from "../src/core/catalog.js";

const NO_RLS = new Set(["tenant_directory", "schema_migrations"]);

describe("database isolation", () => {
  const app = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  afterAll(() => app.end());

  it("the app role cannot bypass RLS and owns nothing", async () => {
    await expect(assertSafeDbRole(db())).resolves.toBeUndefined();
  });

  it("every tenant table has row-level security enabled and forced", async () => {
    const tables = await app<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    const unprotected = tables.filter((t) => !NO_RLS.has(t.relname) && !(t.relrowsecurity && t.relforcerowsecurity));
    expect(unprotected.map((t) => t.relname)).toEqual([]);
    expect(tables.length).toBeGreaterThan(20);
  });

  it("queries without a tenant context fail instead of returning data", async () => {
    const ws = await newWorkspace();
    await create(ws.keys.ops, "contact", { first_name: "Isolated", email: `iso-${Date.now()}@example.com` });
    const tables = await app<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`;
    for (const { relname } of tables) {
      // Tombstones of deleted workspaces belong to no workspace and hold nothing of a customer's (ADR 0020):
      // readable without a context, like tenant_directory; their policy is there to refuse writes.
      if (relname === "deleted_workspaces") continue;
      if (["api_keys", "sessions", "sign_in_identities", "sign_in_flows", "oauth_clients", "oauth_codes", "oauth_tokens", "oauth_assertions"].includes(relname)) {
        // Authentication, sign-in and OAuth may read single rows by a presented hash, identity or client ID
        // (narrow lookup policies, ADR 0009 and 0010); with no context they see nothing.
        const rows = await app.unsafe(`SELECT * FROM "${relname}"`);
        expect(rows.length).toBe(0);
        continue;
      }
      await expect(app.unsafe(`SELECT * FROM "${relname}" LIMIT 1`), relname).rejects.toThrow(/app.tenant_id is not set/);
    }
  });

  it("every column in the standard object catalog exists in the migrations", async () => {
    const cols = await app<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`;
    const have = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`));
    const missing = CATALOG.flatMap((o) => o.fields.map((f) => `${o.table}.${f.column}`)).filter((c) => !have.has(c));
    expect(missing).toEqual([]);
  });

  it("the audit log is append-only for the app role", async () => {
    const ws = await newWorkspace();
    await create(ws.keys.ops, "account", { name: "Audit Co" });
    await expect(app.begin(async (tx) => {
      const [t] = await tx`SELECT tenant_id FROM tenant_directory ORDER BY created_at DESC LIMIT 1`;
      await tx`SELECT set_config('app.tenant_id', ${t!.tenant_id}, true)`;
      await tx`UPDATE audit_log SET action = 'tampered'`;
    })).rejects.toThrow();
    await expect(app.begin(async (tx) => {
      const [t] = await tx`SELECT tenant_id FROM tenant_directory ORDER BY created_at DESC LIMIT 1`;
      await tx`SELECT set_config('app.tenant_id', ${t!.tenant_id}, true)`;
      await tx`DELETE FROM audit_log`;
    })).rejects.toThrow();
  });
});
