import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { createWorkspace } from "../src/core/workspace.js";
import { migrate } from "../src/db/migrate.js";
import { closeDb } from "../src/db/pool.js";
import { decodeId, encodeId, uuidv7 } from "../src/lib/ids.js";
import { call } from "./helpers.js";

/**
 * Upgrades: the migrations after 009 (people sign-in 010, views 012, merges 013, OAuth 014, the automation
 * engine 016, field types and packs 017, custom objects' owner 018) applied in order to a database that was at 009 and holds a workspace
 * with members, a custom role, custom fields of the old types, records and an old-style automation with runs;
 * then a field of each new type is added and written, and a pack installed. This file rebuilds the test database (it starts by
 * dropping it, as global-setup does) and leaves it fully migrated, so the files after it start clean.
 */

const url = process.env.TEST_MIGRATOR_URL!;
const sql = postgres(url, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

async function empty() {
  await sql.unsafe("DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

describe("migrations", () => {
  it("apply in order on an empty database, with the app role's grants", async () => {
    await empty();
    const applied = await migrate(url);
    expect(applied).toEqual(["001_platform.sql", "002_schema_engine.sql", "003_core_sales.sql", "004_events_webhooks_automations.sql",
      "005_alerts_notifications.sql", "006_roles.sql", "007_chain_order_event_retries.sql", "008_object_field_permissions.sql", "009_schema_token.sql",
      "010_people_sign_in.sql", "012_views_preferences.sql", "013_merges.sql", "014_oauth_for_mcp.sql", "016_automation_engine.sql",
      "017_field_types_packs.sql", "018_custom_object_owner.sql"]);
    expect(await migrate(url)).toEqual([]);
  });

  it("upgrade a database at 009 with a workspace, members, a custom role, records and an old-style automation with runs", async () => {
    await empty();
    expect((await migrate(url, undefined, { upTo: "009" })).at(-1)).toBe("009_schema_token.sql");
    const ws = await createWorkspace({ name: "Before step 5", ownerEmail: `old-owner-${Date.now()}@example.com`, ownerName: "Old Owner" });
    // Custom fields of the old types, added through the API as a 009 server did (the schema code reads nothing newer).
    for (const f of [{ api_name: "old_note", type: "text" }, { api_name: "old_level", type: "number" },
      { api_name: "old_kind", type: "single_select", options: { values: [{ key: "a", label: "A" }] } }]) {
      const r = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: f });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const tenant = decodeId(ws.workspace.id)!.uuid;
    const owner = decodeId(ws.owner.id)!.uuid;
    const contact = uuidv7();
    const auto = uuidv7();
    const runs = [uuidv7(), uuidv7()];
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      const [role] = await tx<{ id: string }[]>`
        INSERT INTO roles (tenant_id, id, key, name, permissions) VALUES (${tenant}, gen_random_uuid(), 'clerk', 'Clerk', '{records:read,records:write}') RETURNING id`;
      await tx`INSERT INTO users (tenant_id, id, email, name, role_id) VALUES (${tenant}, gen_random_uuid(), ${`clerk-${Date.now()}@example.com`}, 'Clerk', ${role!.id})`;
      await tx`INSERT INTO contacts (tenant_id, id, first_name, primary_email, job_title, created_by) VALUES (${tenant}, ${contact}, 'Old', ${`old-${Date.now()}@example.com`}, 'before', ${owner})`;
      await tx`INSERT INTO automations (tenant_id, id, name, trigger, actions, created_by)
               VALUES (${tenant}, ${auto}, 'Old rule', ${tx.json({ event: "contact.updated", changed_fields: ["job_title"] })},
                       ${tx.json([{ type: "update_record", values: { source: "rule" } }])}, ${owner})`;
      await tx`INSERT INTO automation_runs (tenant_id, id, automation_id, event_id, record_id, status, depth, finished_at)
               VALUES (${tenant}, ${runs[0]!}, ${auto}, gen_random_uuid(), ${contact}, 'succeeded', 0, now()),
                      (${tenant}, ${runs[1]!}, ${auto}, gen_random_uuid(), ${contact}, 'failed', 0, now())`;
    });

    const later = await migrate(url);
    expect(later).toEqual(["010_people_sign_in.sql", "012_views_preferences.sql", "013_merges.sql", "014_oauth_for_mcp.sql", "016_automation_engine.sql",
      "017_field_types_packs.sql", "018_custom_object_owner.sql"]);

    // 017 replaced the type CHECK on fields by its own definition, which the old fields pass and the new types too.
    const checks = await sql<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'fields'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%long_text%'`;
    expect(checks.map((c) => c.conname)).toEqual(["fields_type_known"]);
    for (const t of ["address", "json", "rating", "percent", "duration", "relation", "status"]) expect(checks[0]!.def).toContain(`'${t}'`);
    const [packGrants] = await sql<{ rw: boolean; del: boolean }[]>`
      SELECT has_table_privilege('hlcrm_app', 'installed_packs', 'SELECT,INSERT,UPDATE') AS rw, has_table_privilege('hlcrm_app', 'installed_packs', 'DELETE') AS del`;
    expect(packGrants).toEqual({ rw: true, del: false });

    // Grants: the app role reaches the new tables (and not the migrations list).
    const [grants] = await sql<{ settings: boolean; usage: boolean; suppressions: boolean; grants: boolean; confirm: boolean; migrations: boolean }[]>`
      SELECT has_table_privilege('hlcrm_app', 'automation_settings', 'SELECT,INSERT,UPDATE') AS settings,
             has_table_privilege('hlcrm_app', 'automation_usage', 'SELECT,INSERT,UPDATE,DELETE') AS usage,
             has_table_privilege('hlcrm_app', 'email_suppressions', 'SELECT,INSERT,DELETE') AS suppressions,
             has_table_privilege('hlcrm_app', 'oauth_grants', 'SELECT,INSERT,UPDATE') AS grants,
             has_table_privilege('hlcrm_app', 'confirm_tokens', 'SELECT,INSERT') AS confirm,
             has_table_privilege('hlcrm_app', 'schema_migrations', 'SELECT') AS migrations`;
    expect(grants).toEqual({ settings: true, usage: true, suppressions: true, grants: true, confirm: true, migrations: false });

    // The old automation and its runs read as the new engine shows them, through the API with the workspace's own admin key.
    const id = encodeId("auto", auto);
    const got = await call("GET", `/v1/automations/${id}`, { key: ws.keys.admin });
    expect(got.status, JSON.stringify(got.json)).toBe(200);
    expect(got.json.data).toMatchObject({ status: "enabled", run_roles: [], paused_at: null, consecutive_failures: 0, next_run_at: null,
      trigger: { type: "event", event: "contact.updated", changed_fields: ["job_title"] } });
    const listed = await call("GET", `/v1/automations/${id}/runs`, { key: ws.keys.admin });
    expect(listed.json.data.map((r: { trigger: string; status: string; requested_by: string | null }) => [r.trigger, r.status, r.requested_by]).sort())
      .toEqual([["event", "failed", null], ["event", "succeeded", null]]);
    // The custom role and its member survive sign-in's identities (010), and the record is readable and writable.
    const roles = (await call("GET", "/v1/roles", { key: ws.keys.admin })).json.data as { key: string }[];
    expect(roles.map((r) => r.key)).toContain("clerk");
    const rec = await call("PATCH", `/v1/objects/contact/records/${encodeId("con", contact)}`, { key: ws.keys.ops, body: { job_title: "after" } });
    expect(rec.status, JSON.stringify(rec.json)).toBe(200);
    // The old rule still works on the new engine: a run on request for its record.
    const run = await call("POST", `/v1/automations/${id}/run`, { key: ws.keys.admin, body: { records: [encodeId("con", contact)] } });
    expect(run.status, JSON.stringify(run.json)).toBe(202);

    // The old custom fields read back, a field of each new type is added and written beside them, and a pack installs.
    const before = await call("PATCH", `/v1/objects/contact/records/${encodeId("con", contact)}`, { key: ws.keys.ops, body: { old_note: "n", old_level: 2, old_kind: "a" } });
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    for (const f of [{ api_name: "hq", type: "address" }, { api_name: "meta", type: "json" }, { api_name: "stars", type: "rating", options: { max: 3 } },
      { api_name: "share", type: "percent" }, { api_name: "wait", type: "duration" }]) {
      const r = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: f });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const written = await call("PATCH", `/v1/objects/contact/records/${encodeId("con", contact)}`, { key: ws.keys.ops,
      body: { hq: { city: "Austin", country: "us" }, meta: { a: 1 }, stars: 3, share: "12.5%", wait: "PT1H" } });
    expect(written.status, JSON.stringify(written.json)).toBe(200);
    expect(written.json.data).toMatchObject({ old_note: "n", old_level: 2, old_kind: "a", hq: { city: "Austin", country: "US", display: "Austin, United States" },
      meta: { a: 1 }, stars: 3, share: 12.5, wait: 3600 });
    const pack = { manifest: { name: "after-upgrade", version: "1.0.0", parts: ["schema", "roles"] },
      schema: { objects: [{ name: "site", id_prefix: "site", fields: [{ name: "title", type: "text" }, { name: "where", type: "address" }, { name: "lead_time", type: "duration" }] }] },
      roles: [{ key: "site_reader", name: "Site reader", permissions: ["records:read"] }] };
    const plan = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack } });
    expect(plan.status, JSON.stringify(plan.json).slice(0, 300)).toBe(200);
    const applied = await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack, plan_token: plan.json.plan_token } });
    expect(applied.status, JSON.stringify(applied.json).slice(0, 300)).toBe(200);
    expect((await call("GET", "/v1/packs", { key: ws.keys.admin })).json.data).toMatchObject([{ name: "after-upgrade", status: "installed" }]);
  });

  it("018 gives owned custom objects an owner field and their owners a reference to a member", async () => {
    await closeDb(); // the app's connections hold type IDs of the schema the test above used
    await empty();
    expect((await migrate(url, undefined, { upTo: "017" })).at(-1)).toBe("017_field_types_packs.sql");
    const ws = await createWorkspace({ name: "Before 018", ownerEmail: `owner-018-${Date.now()}@example.com`, ownerName: "Owner 018" });
    const tenant = decodeId(ws.workspace.id)!.uuid;
    const made = async (body: Record<string, unknown>) => expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body })).status).toBe(201);
    await made({ api_name: "visit", id_prefix: "vis", owned: true, fields: [{ api_name: "title", type: "text" }] });
    await made({ api_name: "errand", id_prefix: "err", fields: [{ api_name: "title", type: "text" }, { api_name: "owner", type: "text" }] });
    await made({ api_name: "shelf", id_prefix: "shf", fields: [{ api_name: "title", type: "text" }] });
    const kept = (await call("POST", "/v1/objects/visit/records", { key: ws.keys.ops, body: { title: "kept" } })).json.data;
    const lost = (await call("POST", "/v1/objects/visit/records", { key: ws.keys.ops, body: { title: "lost" } })).json.data;
    expect(kept.owner).toBe(ws.owner.id);
    // As a 017 server left it: visit without the field; errand owned, with a custom field that has the name; one owner that is no member.
    const [before] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      await tx`DELETE FROM fields WHERE api_name = 'owner' AND is_system AND object_id = (SELECT id FROM objects WHERE api_name = 'visit')`;
      await tx`UPDATE objects SET owned = true WHERE api_name = 'errand'`;
      await tx`UPDATE records SET owner_id = gen_random_uuid() WHERE id = ${decodeId(lost.id)!.uuid}`;
      return tx<{ v: string }[]>`SELECT schema_version::text AS v FROM tenants`;
    });

    expect(await migrate(url)).toEqual(["018_custom_object_owner.sql"]);

    const fields = async (o: string) => (await call("GET", `/v1/objects/${o}`, { key: ws.keys.admin })).json.data.fields as { name: string; type: string; standard?: boolean }[];
    expect((await fields("visit")).map((f) => [f.name, f.type, f.standard])).toEqual([["title", "text", undefined], ["owner", "relation", true]]);
    expect((await fields("errand")).map((f) => [f.name, f.type, f.standard])).toEqual([["title", "text", undefined], ["owner", "text", undefined]]);
    expect((await fields("shelf")).map((f) => f.name)).toEqual(["title"]);
    // One schema change, logged, so the version moved by one and every process reloads the schema.
    const log = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
      return tx<{ version: string; change_type: string; actor_type: string; object: string }[]>`
        SELECT sc.version::text, sc.change_type, sc.actor_type, o.api_name AS object FROM schema_changes sc JOIN objects o ON o.id = sc.object_id
        WHERE sc.version > ${before!.v} ORDER BY sc.version`;
    });
    expect(log).toEqual([{ version: String(Number(before!.v) + 1), change_type: "field_added", actor_type: "system", object: "visit" }]);

    // Owners read back through the field; the one that named no member is cleared; the column now refers to users.
    const read = async (id: string) => (await call("GET", `/v1/records/${id}`, { key: ws.keys.ops })).json.data;
    expect((await read(kept.id)).owner).toBe(ws.owner.id);
    expect((await read(lost.id)).owner).toBeNull();
    const mine = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "visit", where: { field: "owner", op: "eq", value: ws.owner.id } } });
    expect(mine.json.data.map((r: { title: string }) => r.title)).toEqual(["kept"]);
    const [fk] = await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'records_owner_fkey'`;
    expect(fk!.def).toBe("FOREIGN KEY (tenant_id, owner_id) REFERENCES users(tenant_id, id)");
    const forced = await sql<{ relname: string; f: boolean }[]>`SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('records', 'users') ORDER BY relname`;
    expect(forced).toEqual([{ relname: "records", f: true }, { relname: "users", f: true }]);
  });
});
