import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { db } from "../src/db/pool.js";
import { setFileStore, type FileStore } from "../src/providers/files.js";
import { deliverDue, processEvents } from "../src/worker/events.js";
import { app, call, create, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

/**
 * Erasing a person's records (ADR 0020). The main test plants one marker in every place a contact's
 * values can be written, erases the contact, and then reads every column of every table for it.
 */

const migrator = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
afterAll(() => migrator.end());
beforeEach(() => resetRateLimiter());

const MARK = "zqxjkmark";
const hex = Buffer.from(MARK).toString("hex");

/** Every row of every table in the workspace that holds the marker anywhere, as text or as bytes. */
async function rowsHoldingMarker(tenantId: string): Promise<string[]> {
  const tables = (await migrator<{ relname: string }[]>`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations' ORDER BY 1`).map((r) => r.relname);
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    const hits: string[] = [];
    for (const t of tables) {
      const rows = await tx.unsafe<{ row: string }[]>(`SELECT to_jsonb(t)::text AS row FROM "${t}" t WHERE to_jsonb(t)::text ILIKE $1 OR to_jsonb(t)::text ILIKE $2`, [`%${MARK}%`, `%${hex}%`]);
      for (const r of rows) hits.push(`${t}: ${r.row.slice(0, 300)}`);
    }
    return hits;
  }) as Promise<string[]>;
}

const erase = (key: string, path: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) => call("POST", path, { key, body, headers });

async function eraseFor(key: string, object: string, id: string) {
  const path = `/v1/objects/${object}/records/${id}/erase`;
  const dry = await erase(key, path);
  if (dry.status !== 200) return dry;
  return erase(key, path, { dry_run: false, confirm_token: dry.json.confirm_token });
}

async function upload(key: string, recordId: string, name: string, content: string) {
  const res = await app.request(`/v1/records/${recordId}/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${key}` },
    body: new TextEncoder().encode(content) });
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

interface Planted { ws: Workspace; contact: string; duplicate: string; lead: string; deal: string; note: string; task: string; file: string; email: string }

/** A contact with the marker in every place its values are kept, and the copies the server makes of them. */
async function plant(): Promise<Planted> {
  const ws = await newWorkspace("Erasure");
  const { ops, admin } = ws.keys;
  const ok = (r: { status: number; json: unknown }, what: string) => {
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
    return r;
  };
  ok(await call("POST", "/v1/objects/contact/fields", { key: admin, body: { api_name: "nickname", type: "text" } }), "field");
  ok(await call("POST", "/v1/objects/contact/fields", { key: admin, body: { api_name: "passport", type: "text", sensitivity: "restricted" } }), "restricted field");
  ok(await call("POST", "/v1/objects/lead/fields", { key: admin, body: { api_name: "lead_note", type: "text" } }), "lead field");
  ok(await call("POST", "/v1/objects", { key: admin, body: { api_name: "pet", fields: [{ api_name: "name", type: "text" }] } }), "object");
  ok(await call("POST", "/v1/objects/contact/fields", { key: admin, body: { api_name: "pets", type: "relation", options: { to: "pet", cardinality: "many_to_many" } } }), "relation");
  ok(await call("POST", "/v1/webhooks", { key: admin, body: { url: "https://hooks.example/erasure", events: ["*"] } }), "webhook");
  const email = `${MARK}-${Date.now()}@erase.example`;
  const acct = await create(ops, "account", { name: "Kept Corp" });
  const pet = await create(ops, "pet", { name: "Rex" });
  // Created with an Idempotency-Key, so a copy of the response is kept for replay (encrypted).
  const made = ok(await call("POST", "/v1/objects/contact/records", { key: admin, headers: { "Idempotency-Key": `plant-${Date.now()}` },
    body: { first_name: `${MARK}First`, last_name: `${MARK}Last`, email, phone: "+15550100", job_title: `${MARK} title`, source: `${MARK}-source`,
      nickname: `${MARK}nick`, passport: `${MARK}passport`, account: acct.id, pets: [pet.id] } }), "contact");
  const contact = (made.json as { data: { id: string } }).data.id;
  ok(await call("PATCH", `/v1/objects/contact/records/${contact}`, { key: ops, body: { nickname: `${MARK}nick2` } }), "update");
  const duplicate = (await create(ops, "contact", { first_name: `${MARK}Dup`, phone: "+15550101", nickname: `${MARK}dupnick` })).id;
  const lead = (await create(ops, "lead", { contact, status: "qualified", interest: `${MARK} interest`, campaign: `${MARK}-campaign`, lead_note: `${MARK} lead note` })).id;
  const converted = ok(await call("POST", "/v1/ops/convert_lead", { key: ops, body: { lead, deal_name: "A deal" } }), "convert");
  const deal = (converted.json as { result: { deal: { id: string } } }).result.deal.id;
  const noted = ok(await call("POST", "/v1/ops/log_activity", { key: ops, body: { type: "note", subject: `${MARK} subject`, body: `${MARK} body`, related_to: [contact, deal] } }), "note");
  const note = (noted.json as { data: { id: string } }).data.id;
  ok(await call("POST", "/v1/ops/log_activity", { key: ops, body: { type: "call_logged", subject: `${MARK} call`, related_to: [lead] } }), "call");
  const task = (await create(ops, "task", { title: `Ring ${MARK}`, description: `${MARK} description`, related_to: [contact] })).id;
  const file = await upload(ops, contact, `${MARK}-cv.txt`, `${MARK} file content`);
  await upload(ops, note, `${MARK}-note.txt`, `${MARK} note file`);
  // A merge that changes the survivor keeps its previous values (encrypted) and archives the duplicate with its values intact.
  const dry = ok(await call("POST", "/v1/ops/merge_records", { key: admin, body: { survivor: contact, duplicates: [duplicate], fields: { phone: duplicate } } }), "merge dry run");
  ok(await call("POST", "/v1/ops/merge_records", { key: admin, body: { survivor: contact, duplicates: [duplicate], fields: { phone: duplicate }, dry_run: false,
    confirm_token: (dry.json as { confirm_token: string }).confirm_token } }), "merge");
  // Events become webhook deliveries, which copy the record as it was.
  for (let i = 0; i < 20 && (await processEvents(ws.tenantId)) > 0; i++);
  return { ws, contact, duplicate, lead, deal, note, task, file, email };
}

describe("erasing a contact", () => {
  it("removes the person's values from every table, and says what it did", async () => {
    const p = await plant();
    const { ws } = p;
    const before = await rowsHoldingMarker(ws.tenantId);
    const tablesBefore = [...new Set(before.map((h) => h.split(":")[0]))];
    // The fixture really did put the marker everywhere an erasure has to reach.
    for (const t of ["contacts", "leads", "activities", "tasks", "files", "file_blobs", "outbox_events", "webhook_deliveries"]) expect(tablesBefore).toContain(t);

    const path = `/v1/objects/contact/records/${p.contact}/erase`;
    // Not with a key for record work, however senior its member; and a member who can't manage the schema can't either.
    expect((await erase(ws.keys.ops, path)).status).toBe(403);
    const member = await memberWithKey(ws, "member", ["ops:write", "ops:read"]);
    expect((await erase(member.key, path)).status).toBe(403);
    // Not on the ops MCP server; the admin MCP server may.
    expect((await erase(ws.keys.admin, path, {}, { "X-Hlcrm-Surface": "ops-mcp" })).status).toBe(403);

    // A dry run by default: what would go, and nothing changed.
    const dry = await erase(ws.keys.admin, path, {}, { "X-Hlcrm-Surface": "admin-mcp" });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json).toMatchObject({ dry_run: true, result: { id: p.contact, object: "contact" } });
    expect(dry.json.result.erased.sort()).toEqual([p.contact, p.duplicate, p.lead].sort());
    expect(dry.json.result.counts).toMatchObject({ contacts: 2, leads: 1, account_links: 1, activities: 3, tasks: 1, files: 2, merges: 1, relation_values: 1 });
    expect(dry.json.result.counts.events).toBeGreaterThan(5);
    expect(dry.json.result.counts.webhook_deliveries).toBeGreaterThan(5);
    expect(JSON.stringify(dry.json)).not.toContain(MARK);
    expect((await rowsHoldingMarker(ws.tenantId)).length).toBe(before.length);

    // A real run needs the dry run's token.
    expect((await erase(ws.keys.admin, path, { dry_run: false })).status).toBe(400);
    expect((await erase(ws.keys.admin, path, { dry_run: false, confirm_token: "x.y" })).status).toBe(400);
    const done = await erase(ws.keys.admin, path, { dry_run: false, confirm_token: dry.json.confirm_token });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ dry_run: false, result: { id: p.contact, emails_suppressed: 1 } });

    // Nothing in any column of any table holds the marker, as text or as bytes.
    expect(await rowsHoldingMarker(ws.tenantId)).toEqual([]);

    // The record is still there, blank, archived and marked: what refers to it still does.
    const got = await call("GET", `/v1/objects/contact/records/${p.contact}`, { key: ws.keys.admin });
    expect(got.status).toBe(200);
    expect(got.json.data).toMatchObject({ first_name: null, last_name: "[erased]", email: null, phone: null, job_title: null, nickname: null, passport: null, pets: [],
      display_name: "[erased]" });
    expect(got.json.data.erased_at).toBeTruthy();
    expect(got.json.data.archived_at).toBeTruthy();
    expect((await call("GET", `/v1/objects/deal/records/${p.deal}`, { key: ws.keys.ops })).json.data.primary_contact).toBe(p.contact);
    expect((await call("GET", `/v1/objects/contact/records/${p.duplicate}`, { key: ws.keys.ops })).json.data).toMatchObject({ last_name: "[erased]", first_name: null });
    const lead = (await call("GET", `/v1/objects/lead/records/${p.lead}`, { key: ws.keys.ops })).json.data;
    expect(lead).toMatchObject({ interest: null, campaign: null, lead_note: null, status: "converted" });
    expect(lead.erased_at).toBeTruthy();
    expect((await call("GET", `/v1/objects/activity/records/${p.note}`, { key: ws.keys.ops })).json.data).toMatchObject({ subject: "[erased]", body: null, type: "note" });
    expect((await call("GET", `/v1/objects/task/records/${p.task}`, { key: ws.keys.ops })).json.data).toMatchObject({ title: "[erased]", description: null });

    // The merge keeps that it happened, not the survivor's earlier values (they are encrypted, so the search above can't see them).
    const merges = await db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx`SELECT survivor_before, merged_ids FROM merges`;
    });
    expect(merges).toHaveLength(1);
    expect(merges[0]!.survivor_before).toBeNull();

    // Files: gone from the list, and their bytes with them.
    expect((await call("GET", `/v1/records/${p.contact}/files`, { key: ws.keys.ops })).json.data).toEqual([]);
    expect((await call("GET", `/v1/files/${p.file}/content`, { key: ws.keys.ops })).status).toBe(404);

    // The address is on the suppression list, as a hash.
    expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email: p.email } })).json.data).toMatchObject({ suppressed: true });

    // Events keep their type and time, not their data; the erasure has its own event, and deliveries not yet sent never are.
    const feed = await call("GET", `/v1/events?record=${p.contact}&limit=100`, { key: ws.keys.ops });
    const types = (feed.json.data as { type: string; data: unknown }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["contact.created", "contact.updated", "contact.erased"]));
    for (const e of feed.json.data as { type: string; data: unknown }[]) expect(e.data).toEqual({});
    const pendingBefore = await db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx`SELECT status, payload FROM webhook_deliveries WHERE payload = '{"erased": true}'`;
    });
    expect(pendingBefore.length).toBeGreaterThan(5);
    expect(pendingBefore.every((d) => d.status === "dead" || d.status === "succeeded")).toBe(true);
    await deliverDue(ws.tenantId);

    // Audit: an entry per erased record, with counts and IDs, never a value.
    const log = await call("GET", "/v1/audit-log?limit=50", { key: ws.keys.admin });
    const entries = (log.json.data as { action: string; details: Record<string, unknown> }[]).filter((e) => e.action.endsWith(".erased"));
    expect(entries.map((e) => e.action).sort()).toEqual(["contact.erased", "contact.erased", "lead.erased"]);
    expect(JSON.stringify(log.json)).not.toContain(MARK);

    // It can't be undone, repeated or replayed.
    expect((await call("POST", `/v1/objects/contact/records/${p.contact}/restore`, { key: ws.keys.ops })).status).toBe(409);
    const again = await erase(ws.keys.admin, path);
    expect(again.status).toBe(409);
    expect(again.json.detail).toMatch(/already erased/);
    // The replay copy of the create is sealed with the workspace key and expires in a day; it never held the marker in the clear.
    expect((await call("PATCH", `/v1/objects/contact/records/${p.contact}`, { key: ws.keys.ops, body: { first_name: "Back" } })).status).toBe(409);
  });

  it("is the same operation as POST /v1/ops/erase_contact, and can leave the address off the suppression list", async () => {
    const ws = await newWorkspace("Erase op");
    const email = `op-${Date.now()}@erase.example`;
    const c = await create(ws.keys.ops, "contact", { first_name: "Olga", last_name: "Op", email });
    expect((await erase(ws.keys.ops, "/v1/ops/erase_contact", { contact: c.id })).status).toBe(403);
    const dry = await erase(ws.keys.admin, "/v1/ops/erase_contact", { contact: c.id });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    // A token from the other route's dry run of the same erasure is the same confirmation.
    const done = await erase(ws.keys.admin, `/v1/objects/contact/records/${c.id}/erase`, { dry_run: false, confirm_token: dry.json.confirm_token, suppress_email: false });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.result.emails_suppressed).toBe(0);
    expect((await call("POST", "/v1/email-suppressions/check", { key: ws.keys.ops, body: { email } })).json.data).toMatchObject({ suppressed: false });
    // The token is spent.
    const c2 = await create(ws.keys.ops, "contact", { first_name: "Otto" });
    expect((await erase(ws.keys.admin, `/v1/objects/contact/records/${c2.id}/erase`, { dry_run: false, confirm_token: dry.json.confirm_token })).status).toBe(409);
  });

  it("applies only what the dry run listed: something added since means a new dry run", async () => {
    const ws = await newWorkspace("Erase drift");
    const c = await create(ws.keys.ops, "contact", { first_name: "Dee", last_name: "Drift" });
    const path = `/v1/objects/contact/records/${c.id}/erase`;
    const dry = await erase(ws.keys.admin, path);
    await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", subject: "Added since", related_to: [c.id] } });
    const stale = await erase(ws.keys.admin, path, { dry_run: false, confirm_token: dry.json.confirm_token });
    expect(stale.status).toBe(409);
    expect(stale.json.detail).toMatch(/changed since its dry run/);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data.first_name).toBe("Dee");
    expect((await eraseFor(ws.keys.admin, "contact", c.id)).status).toBe(200);
  });

  it("lists other records that seem to hold the person's email or name, without changing them", async () => {
    const ws = await newWorkspace("Erase copies");
    const email = `copycat-${Date.now()}@erase.example`;
    const c = await create(ws.keys.ops, "contact", { first_name: "Coppelia", last_name: "Copycat", email });
    const other = await create(ws.keys.ops, "contact", { first_name: "Someone", last_name: "Else" });
    const deal = await create(ws.keys.ops, "deal", { name: "Renewal for Coppelia Copycat", primary_contact: other.id });
    const done = await eraseFor(ws.keys.admin, "contact", c.id);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.result.possible_copies).toEqual([deal.id]);
    expect(done.json.result.possible_copies).not.toContain(other.id);
    expect((await call("GET", `/v1/objects/deal/records/${deal.id}`, { key: ws.keys.ops })).json.data.name).toBe("Renewal for Coppelia Copycat");
  });

  it("refuses a merged duplicate, naming the record that now stands for it", async () => {
    const ws = await newWorkspace("Erase merged");
    const s = await create(ws.keys.ops, "contact", { first_name: "Sur", last_name: "Vivor" });
    const d = await create(ws.keys.ops, "contact", { first_name: "Dup", last_name: "Licate" });
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d.id] } });
    await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    const r = await erase(ws.keys.admin, `/v1/objects/contact/records/${d.id}/erase`);
    expect(r.status).toBe(409);
    expect(r.json.merged_into ?? r.json.details?.merged_into ?? JSON.stringify(r.json)).toContain(s.id);
  });

  it("deletes the bytes of files kept in an outside store once the erasure has committed", async () => {
    const deleted: string[] = [];
    const kept = new Map<string, Buffer>();
    const store: FileStore = { name: "s3", external: true,
      put: async (_tx, tenantId, fileId, data) => { kept.set(`${tenantId}/${fileId}`, data); },
      get: async (_tx, tenantId, fileId) => kept.get(`${tenantId}/${fileId}`) ?? null,
      delete: async (_tx, tenantId, fileId) => { deleted.push(fileId); kept.delete(`${tenantId}/${fileId}`); } };
    const { resetConfig } = await import("../src/config.js");
    process.env.FILE_STORE = "s3";
    resetConfig();
    setFileStore(store);
    try {
      const ws = await newWorkspace("Erase outside");
      const c = await create(ws.keys.ops, "contact", { first_name: "Sam", last_name: "Three" });
      await upload(ws.keys.ops, c.id, "sam.txt", "Sam's file");
      expect(kept.size).toBe(1);
      const dry = await erase(ws.keys.admin, `/v1/objects/contact/records/${c.id}/erase`);
      expect(kept.size).toBe(1);
      expect((await erase(ws.keys.admin, `/v1/objects/contact/records/${c.id}/erase`, { dry_run: false, confirm_token: dry.json.confirm_token })).status).toBe(200);
      expect(deleted).toHaveLength(1);
      expect(kept.size).toBe(0);
    } finally {
      setFileStore(null);
      delete process.env.FILE_STORE;
      resetConfig();
    }
  });
});

describe("erasing other records", () => {
  it("a lead on its own: the lead and what was written about it go, the contact stays", async () => {
    const ws = await newWorkspace("Erase lead");
    const c = await create(ws.keys.ops, "contact", { first_name: "Lena", last_name: "Lead", email: `lena-${Date.now()}@erase.example` });
    const lead = await create(ws.keys.ops, "lead", { contact: c.id, interest: `${MARK} interest` });
    await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", subject: `${MARK} about the lead`, related_to: [lead.id] } });
    const done = await eraseFor(ws.keys.admin, "lead", lead.id);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.result).toMatchObject({ object: "lead", erased: [lead.id], counts: { contacts: 0, leads: 1, activities: 1 } });
    expect(await rowsHoldingMarker(ws.tenantId)).toEqual([]);
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops })).json.data).toMatchObject({ first_name: "Lena", last_name: "Lead" });
  });

  it("a record of a custom object: every value goes", async () => {
    const ws = await newWorkspace("Erase custom");
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "candidate", fields: [{ api_name: "full_name", type: "text" },
      { api_name: "salary", type: "number", sensitivity: "restricted" }, { api_name: "resume", type: "long_text" }] } })).status).toBe(201);
    const cand = await create(ws.keys.admin, "candidate", { full_name: `${MARK} Candidate`, salary: 5, resume: `${MARK} resume` });
    await upload(ws.keys.ops, cand.id, `${MARK}.pdf`, `%PDF- ${MARK}`);
    const done = await eraseFor(ws.keys.admin, "candidate", cand.id);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.result.counts).toMatchObject({ custom_records: 1, files: 1 });
    expect(await rowsHoldingMarker(ws.tenantId)).toEqual([]);
    const got = (await call("GET", `/v1/objects/candidate/records/${cand.id}`, { key: ws.keys.admin })).json.data;
    expect(got).toMatchObject({ full_name: null, salary: null, resume: null });
    expect(got.erased_at).toBeTruthy();
    expect((await call("POST", `/v1/objects/candidate/records/${cand.id}/restore`, { key: ws.keys.ops })).status).toBe(409);
  });

  it("refuses accounts, deals and the rest: they are archived, not erased", async () => {
    const ws = await newWorkspace("Erase refused");
    const acct = await create(ws.keys.ops, "account", { name: "Org" });
    const r = await erase(ws.keys.admin, `/v1/objects/account/records/${acct.id}/erase`);
    expect(r.status).toBe(422);
    expect(r.json.detail).toMatch(/erase the contacts at the account/);
    const person = await create(ws.keys.ops, "contact", { first_name: "Per", last_name: "Son" });
    const deal = await create(ws.keys.ops, "deal", { name: "D", primary_contact: person.id });
    expect((await erase(ws.keys.admin, `/v1/objects/deal/records/${deal.id}/erase`)).status).toBe(422);
    expect((await erase(ws.keys.admin, "/v1/objects/contact/records/con_nope/erase")).status).toBe(404);
  });
});
