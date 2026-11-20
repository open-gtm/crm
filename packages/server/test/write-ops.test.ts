import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { decodeId } from "../src/lib/ids.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/** Restore, the duplicate finder, merge, bulk update and archive, and the batch create dry run, through real HTTP calls. */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const stamp = Date.now().toString(36);
let ws: Workspace;
let n = 0;
const ALL = ["records:read", "records:write", "records:archive"];
const OPS = ["ops:read", "ops:write"];
const get = async (id: string, key = ws.keys.ops) => (await call("GET", `/v1/records/${id}`, { key })).json.data;
const drain = async () => { for (let i = 0; i < 20 && (await processEvents(ws.tenantId)) > 0; i++); };
const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
  return fn(tx);
}) as Promise<T>;

/** A real merge: its dry run, then the run with the dry run's confirm_token (as every client must). A failing dry run is returned as is. */
async function merge(body: Record<string, unknown>, key = ws.keys.ops) {
  const dry = await call("POST", "/v1/ops/merge_records", { key, body: { ...body, dry_run: true } });
  if (dry.status !== 200) return dry;
  return call("POST", "/v1/ops/merge_records", { key, body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } });
}

async function member(permissions: string[], rules: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `w${++n}_${stamp}`, name: "Write ops", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return memberWithKey(ws, r.json.data.key, OPS);
}

beforeAll(async () => {
  ws = await newWorkspace("Write ops");
});

// Each test makes many calls with one key; rate limits are tested elsewhere.
beforeEach(() => resetRateLimiter());

describe("restore", () => {
  it("un-archives a record, with an event and an audit entry, and lists archived records on their own", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Rae", email: uniqueEmail("rae") });
    await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops });
    const archived = await call("GET", "/v1/objects/contact/records?archived_only=true&limit=200", { key: ws.keys.ops });
    expect(archived.json.data.map((r: { id: string }) => r.id)).toContain(c.id);
    expect(archived.json.data.every((r: { archived_at?: string }) => r.archived_at)).toBe(true);
    const q = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", archived_only: true, where: { field: "id", op: "eq", value: c.id } } });
    expect(q.json.data.map((r: { id: string }) => r.id)).toEqual([c.id]);
    const r = await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: ws.keys.ops });
    expect(r.status).toBe(200);
    expect(r.json.data.archived_at).toBeUndefined();
    expect(r.json.data.version).toBe(3);
    expect(r.json.warnings).toEqual([]);
    const again = await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: ws.keys.ops });
    expect(again.status).toBe(409);
    const ev = await call("GET", `/v1/events?record=${c.id}`, { key: ws.keys.ops });
    expect(ev.json.data.map((e: { type: string }) => e.type)).toContain("contact.restored");
    const log = await call("GET", "/v1/audit-log?action=contact.restored", { key: ws.keys.admin });
    expect(log.json.data[0].record_id).toBe(decodeId(c.id)!.uuid);
    // Search finds it again.
    const s = await call("GET", "/v1/search?q=rae&objects=contact", { key: ws.keys.ops });
    expect(s.json.data.map((x: { id: string }) => x.id)).toContain(c.id);
  });

  it("refuses when another record now holds a unique value, without quoting it", async () => {
    const email = uniqueEmail("uniq");
    const a = await create(ws.keys.ops, "contact", { first_name: "Uno", email });
    await call("DELETE", `/v1/objects/contact/records/${a.id}`, { key: ws.keys.ops });
    await create(ws.keys.ops, "contact", { first_name: "Dos", email });
    const r = await call("POST", `/v1/objects/contact/records/${a.id}/restore`, { key: ws.keys.ops });
    expect(r.status).toBe(409);
    expect(r.json.detail).toMatch(/contact\.email/);
    expect(JSON.stringify(r.json)).not.toContain(email);
    // A custom unique field too.
    expect((await call("POST", "/v1/objects/account/fields", { key: ws.keys.admin, body: { api_name: "vat_no", type: "text", unique: true } })).status).toBe(201);
    const x = await create(ws.keys.ops, "account", { name: "Vat One", vat_no: `VAT${stamp}` });
    await call("DELETE", `/v1/objects/account/records/${x.id}`, { key: ws.keys.ops });
    await create(ws.keys.ops, "account", { name: "Vat Two", vat_no: `VAT${stamp}` });
    const r2 = await call("POST", `/v1/objects/account/records/${x.id}/restore`, { key: ws.keys.ops });
    expect(r2.status).toBe(409);
    expect(r2.json.detail).toMatch(/account\.vat_no/);
    // A caller who can't read the field isn't told which one.
    const hidden = await member(ALL, { fields: { account: { vat_no: "none" } } });
    const r3 = await call("POST", `/v1/objects/account/records/${x.id}/restore`, { key: hidden.key });
    expect(r3.status).toBe(409);
    expect(r3.json.detail).not.toMatch(/vat_no/);
  });

  it("needs archive on the object, and reports relations to records archived meanwhile", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Gone Co" });
    const c = await create(ws.keys.ops, "contact", { first_name: "Lin", email: uniqueEmail("lin"), account: acct.id });
    await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops });
    await call("DELETE", `/v1/objects/account/records/${acct.id}`, { key: ws.keys.ops });
    const writer = await member(["records:read", "records:write"]);
    expect((await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: writer.key })).status).toBe(403);
    const r = await call("POST", `/v1/objects/contact/records/${c.id}/restore`, { key: ws.keys.ops });
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([{ field: "account", message: `points to an archived account (${acct.id})` }]);
    // A role that can't read contact.account gets no warning about it.
    const c2 = await create(ws.keys.ops, "contact", { first_name: "Lin2", email: uniqueEmail("lin2"), account: acct.id });
    await call("DELETE", `/v1/objects/contact/records/${c2.id}`, { key: ws.keys.ops });
    const noAcct = await member(ALL, { fields: { contact: { account: "none" } } });
    const r2 = await call("POST", `/v1/objects/contact/records/${c2.id}/restore`, { key: noAcct.key });
    expect(r2.status).toBe(200);
    expect(r2.json.warnings).toEqual([]);
    expect(JSON.stringify(r2.json)).not.toContain(acct.id);
  });
});

describe("duplicates", () => {
  it("groups contacts by normalized email and by name and account, deterministically, with reasons", async () => {
    const acct = await create(ws.keys.ops, "account", { name: `Dupe Corp ${stamp}` });
    const e = `dupe-${stamp}@example.com`;
    const a = await create(ws.keys.ops, "contact", { first_name: "Ana", last_name: "Dupe", email: e, account: acct.id });
    // A second contact with the same email can't exist while the first is live, so insert one differing in case and spaces, as old data would.
    const b = await create(ws.keys.ops, "contact", { first_name: "ana", last_name: "dupe ", account: acct.id });
    await asApp((tx) => tx`UPDATE contacts SET primary_email = ${` ${e.toUpperCase()}`} WHERE id = ${decodeId(b.id)!.uuid}`);
    const res = await call("POST", "/v1/objects/contact/duplicates", { key: ws.keys.ops, body: {} });
    expect(res.status).toBe(200);
    const mine = res.json.groups.filter((g: { records: { id: string }[] }) => g.records.some((r) => r.id === a.id));
    expect(mine.map((g: { reason: unknown }) => g.reason)).toEqual([
      { fields: ["email"], match: "normalized", also: [{ fields: ["first_name", "last_name", "account"], match: "normalized" }] },
    ]);
    expect(mine[0].records.map((r: { id: string }) => r.id).sort()).toEqual([a.id, b.id].sort());
    const again = await call("POST", "/v1/objects/contact/duplicates", { key: ws.keys.ops, body: {} });
    expect(again.json).toEqual(res.json);
  });

  it("finds accounts by normalized domain and company name, and similar names with fuzzy", async () => {
    await create(ws.keys.ops, "account", { name: `Zephyr Widgets ${stamp}, Inc.` });
    await create(ws.keys.ops, "account", { name: `zephyr widgets ${stamp} LLC` });
    await create(ws.keys.ops, "account", { name: `Zephyr Widget ${stamp}` });
    const res = await call("POST", "/v1/objects/account/duplicates", { key: ws.keys.ops, body: { fuzzy: true, min_similarity: 0.7 } });
    expect(res.status).toBe(200);
    const byName = res.json.groups.find((g: { reason: { fields: string[]; match: string } }) => g.reason.fields[0] === "name" && g.reason.match === "normalized"
      && JSON.stringify(g).includes(`Zephyr Widgets ${stamp}`));
    expect(byName.count).toBe(2);
    const similar = res.json.groups.find((g: { reason: { match: string } }) => g.reason.match === "similar");
    expect(similar.count).toBe(3);
    expect(similar.reason.similarity).toBeGreaterThanOrEqual(0.7);
  });

  it("custom objects match on the fields named; access rules hold", async () => {
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: `gizmo_${stamp}`, id_prefix: `gz${stamp.replace(/[^a-z]/g, "").slice(0, 5)}`, display_field: "label",
      fields: [{ api_name: "label", type: "text" }, { api_name: "serial", type: "text" }, { api_name: "pin", type: "text", sensitivity: "restricted" }] } })).status).toBe(201);
    const o = `gizmo_${stamp}`;
    await create(ws.keys.ops, o, { label: "G1", serial: "SN-1" });
    await create(ws.keys.ops, o, { label: "G2", serial: "sn-1" });
    const res = await call("POST", `/v1/objects/${o}/duplicates`, { key: ws.keys.ops, body: { rules: [["serial"]] } });
    expect(res.json.groups).toHaveLength(1);
    expect(res.json.groups[0].reason).toEqual({ fields: ["serial"], match: "normalized" });
    expect((await call("POST", `/v1/objects/${o}/duplicates`, { key: ws.keys.ops, body: { rules: [["pin"]] } })).status).toBe(422);
    const hidden = await member(ALL, { fields: { [o]: { serial: "none" } } });
    const refused = await call("POST", `/v1/objects/${o}/duplicates`, { key: hidden.key, body: { rules: [["serial"]] } });
    expect(refused.status).toBe(403);
    // Default rules on a hidden field are skipped and said so; a role that can't read the object is refused.
    const noEmail = await member(ALL, { fields: { contact: { email: "none" } } });
    const skipped = await call("POST", "/v1/objects/contact/duplicates", { key: noEmail.key, body: {} });
    expect(skipped.status).toBe(200);
    expect(skipped.json.skipped_rules).toEqual([{ rule: ["email"], reason: "this key can't read contact.email" }]);
    expect(JSON.stringify(skipped.json)).not.toContain(`dupe-${stamp}`);
    const noContacts = await member(ALL, { objects: { contact: { read: false, write: false, archive: false } } });
    expect((await call("POST", "/v1/objects/contact/duplicates", { key: noContacts.key, body: {} })).status).toBe(403);
  });
});

describe("merge", () => {
  it("dry run by default; fills blanks from the duplicates, moves every reference, archives them with a pointer", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Merge Co" });
    const s = await create(ws.keys.ops, "contact", { first_name: "Sam", email: uniqueEmail("sam") });
    const dEmail = uniqueEmail("sam2");
    const d = await create(ws.keys.ops, "contact", { first_name: "Samuel", last_name: "Merge", email: dEmail, phone: "555", account: acct.id });
    const deal = await create(ws.keys.ops, "deal", { name: "Merge deal", primary_contact: d.id });
    const lead = await create(ws.keys.ops, "lead", { contact: d.id, status: "qualified" });
    await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: lead.id } });
    const note = await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", body: "x", related_to: [d.id, s.id] } });
    await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "call_logged", related_to: [d.id], actor_contact: d.id } });
    const task = await create(ws.keys.ops, "task", { title: "Call", related_to: [d.id] });

    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d.id] } });
    expect(dry.status).toBe(200);
    expect(dry.json.dry_run).toBe(true);
    expect(dry.json.changes.map((c: { field: string }) => c.field).sort()).toEqual(["account", "last_name", "phone"]);
    expect(dry.json.references).toEqual(expect.arrayContaining([expect.objectContaining({ object: "deal", field: "primary_contact", moved: 2 })]));
    expect((await get(d.id)).archived_at).toBeUndefined(); // nothing changed

    const real = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(real.status).toBe(200);
    expect(real.json.survivor).toMatchObject({ first_name: "Sam", last_name: "Merge", phone: "555", account: acct.id });
    const gone = await get(d.id);
    expect(gone.archived_at).toBeTruthy();
    expect(gone.merged_into).toBe(s.id);
    expect((await get(deal.id)).primary_contact).toBe(s.id);
    expect((await get(lead.id)).contact).toBe(s.id); // a converted (read-only) lead too
    expect((await get(task.id)).related_to).toEqual([s.id]);
    // The note was linked to both: one link to the survivor remains, not two.
    expect((await get(note.json.data.id)).related_to).toEqual([s.id]);
    const tl = await call("GET", `/v1/records/${s.id}/timeline`, { key: ws.keys.ops });
    expect(tl.json.data.items.filter((i: { kind: string }) => i.kind === "activity").length).toBeGreaterThanOrEqual(3);
    // One account link, primary or not, and the unique email is free.
    const links = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "account_contact", where: { field: "contact", op: "eq", value: s.id } } });
    expect(links.json.data.length).toBe(1);
    const ev = await call("GET", `/v1/events?record=${s.id}`, { key: ws.keys.ops });
    const merged = ev.json.data.find((e: { type: string }) => e.type === "contact.merged");
    expect(merged.data).toEqual({ merged: [d.id] });
    expect(JSON.stringify(merged)).not.toContain(dEmail);
    const log = await call("GET", "/v1/audit-log?action=contact.merged", { key: ws.keys.admin });
    expect(log.json.data[0].details.merged).toEqual([decodeId(d.id)!.uuid]);
    expect(JSON.stringify(log.json.data[0])).not.toMatch(/"555"|Merge/); // values, not IDs (a UUID may hold 555)
    const [m] = await asApp((tx) => tx<{ field_sources: Record<string, string>; survivor_before: string | null }[]>`SELECT field_sources, survivor_before FROM merges WHERE survivor_id = ${decodeId(s.id)!.uuid}`);
    expect(Object.keys(m!.field_sources).sort()).toEqual(["account", "last_name", "phone"]);
    expect(m!.survivor_before).not.toContain("Sam");
    // Merged and archived records can't be merged or restored.
    expect((await merge({ survivor: d.id, duplicates: [s.id] })).status).toBe(409);
    const restore = await call("POST", `/v1/objects/contact/records/${d.id}/restore`, { key: ws.keys.ops });
    expect(restore.status).toBe(409);
    expect(restore.json.detail).toContain(s.id);
  });

  it("explicit field choices, unique values moving to the survivor, and the guards", async () => {
    const e2 = uniqueEmail("pick");
    const s = await create(ws.keys.ops, "contact", { first_name: "Old", email: uniqueEmail("keep") });
    const d = await create(ws.keys.ops, "contact", { first_name: "New", email: e2 });
    const r = await merge({ survivor: s.id, duplicates: [d.id], fields: { first_name: d.id, email: d.id } });
    expect(r.status).toBe(200);
    expect(r.json.survivor).toMatchObject({ first_name: "New", email: e2 });
    const acct = await create(ws.keys.ops, "account", { name: "Other" });
    const c = await create(ws.keys.ops, "contact", { first_name: "C", email: uniqueEmail("c") });
    for (const [body, status] of [
      [{ survivor: c.id, duplicates: [c.id] }, 422],
      [{ survivor: c.id, duplicates: [acct.id] }, 422],
      [{ survivor: c.id, duplicates: [d.id] }, 409], // archived (merged)
      [{ survivor: c.id, duplicates: ["con_00000000000000000000000000"] }, 404],
      [{ survivor: c.id, duplicates: [s.id], fields: { first_name: acct.id } }, 422],
      [{ survivor: c.id, duplicates: [s.id], fields: { lifecycle_stage_overridden: s.id } }, 422],
    ] as const) {
      const res = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body });
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    const deal = await create(ws.keys.ops, "deal", { name: "D", primary_contact: c.id });
    expect((await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: deal.id, duplicates: [deal.id] } })).status).toBe(422);
  });

  it("accounts: children move, the survivor never becomes its own parent, and a hierarchy cycle is refused", async () => {
    const s = await create(ws.keys.ops, "account", { name: "Parent S" });
    const d = await create(ws.keys.ops, "account", { name: "Parent D", domain: `pd-${stamp}.example` });
    const child = await create(ws.keys.ops, "account", { name: "Child", parent_account: d.id });
    await call("PATCH", `/v1/objects/account/records/${s.id}`, { key: ws.keys.ops, body: { parent_account: d.id } });
    const r = await merge({ survivor: s.id, duplicates: [d.id] });
    expect(r.status).toBe(200);
    expect(r.json.survivor.parent_account).toBeNull();
    expect(r.json.survivor.domain).toBe(`pd-${stamp}.example`);
    expect((await get(child.id)).parent_account).toBe(s.id);
    // X's parent is Y, Y's parent is Z: merging Z into X would make X its own grandparent.
    const z = await create(ws.keys.ops, "account", { name: "Z" });
    const y = await create(ws.keys.ops, "account", { name: "Y", parent_account: z.id });
    const x = await create(ws.keys.ops, "account", { name: "X", parent_account: y.id });
    const cyc = await merge({ survivor: x.id, duplicates: [z.id] });
    expect(cyc.status).toBe(409);
    expect(cyc.json.detail).toMatch(/cycle|own parent/);
    expect((await get(z.id)).archived_at).toBeUndefined();
  });

  it("custom objects: incoming relation links move without duplicates; notifications and alert state follow", async () => {
    const o = `gizmo_${stamp}`;
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "gizmos", type: "relation", options: { to: o, cardinality: "many_to_many" } } })).status).toBe(201);
    const s = await create(ws.keys.ops, o, { label: "Keep" });
    const d = await create(ws.keys.ops, o, { label: "Drop", serial: "S-9" });
    const c1 = await create(ws.keys.ops, "contact", { email: uniqueEmail("g1"), gizmos: [s.id, d.id] });
    const c2 = await create(ws.keys.ops, "contact", { email: uniqueEmail("g2"), gizmos: [d.id] });
    const alert = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: { name: `Gizmo ${stamp}`, object: o, trigger: { type: "event", event: `${o}.updated` }, recipients: { users: [ws.ownerId] } } });
    expect(alert.status).toBe(201);
    await call("PATCH", `/v1/objects/${o}/records/${d.id}`, { key: ws.keys.ops, body: { serial: "S-10" } });
    await drain();
    const r = await merge({ survivor: s.id, duplicates: [d.id] });
    expect(r.status).toBe(200);
    expect(r.json.survivor.serial).toBe("S-10");
    expect((await get(c1.id)).gizmos).toEqual([s.id]);
    expect((await get(c2.id)).gizmos).toEqual([s.id]);
    const box = await call("GET", "/v1/me/notifications?state=all&limit=200", { key: ws.keys.ops });
    const ntf = box.json.data.find((x: { title: string }) => x.title.startsWith(`Gizmo ${stamp}`));
    expect(ntf.record.id).toBe(s.id);
  });

  it("a role that can't read a field never gets its value through a merge, and fields it can't write aren't changed", async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "badge", type: "text" } })).status).toBe(201);
    const SECRET = `zq${stamp}mergesentinel`;
    const s = await create(ws.keys.ops, "contact", { first_name: "Vis", email: uniqueEmail("vis") });
    const d = await create(ws.keys.ops, "contact", { first_name: "Vis2", email: uniqueEmail("vis2"), badge: SECRET, job_title: "Boss" });
    const hidden = await member(ALL, { fields: { contact: { badge: "none", job_title: "read" } } });
    const dry = await call("POST", "/v1/ops/merge_records", { key: hidden.key, body: { survivor: s.id, duplicates: [d.id] } });
    expect(dry.status).toBe(200);
    expect(JSON.stringify(dry.json)).not.toContain(SECRET);
    expect(dry.json.changes).toEqual([]);
    expect(dry.json.not_filled).toEqual([{ field: "job_title", reason: expect.any(String) }]);
    expect((await call("POST", "/v1/ops/merge_records", { key: hidden.key, body: { survivor: s.id, duplicates: [d.id], fields: { badge: d.id } } })).status).toBe(403);
    expect((await call("POST", "/v1/ops/merge_records", { key: hidden.key, body: { survivor: s.id, duplicates: [d.id], fields: { job_title: d.id } } })).status).toBe(403);
    const real = await merge({ survivor: s.id, duplicates: [d.id] }, hidden.key);
    expect(real.status).toBe(200);
    expect(JSON.stringify(real.json)).not.toContain(SECRET);
    const owner = await get(s.id);
    expect(owner.badge).toBeNull();
    expect(owner.job_title).toBeNull();
    // Write without archive can't merge.
    const noArchive = await member(["records:read", "records:write"]);
    const x = await create(ws.keys.ops, "contact", { email: uniqueEmail("x") });
    const y = await create(ws.keys.ops, "contact", { email: uniqueEmail("y") });
    expect((await call("POST", "/v1/ops/merge_records", { key: noArchive.key, body: { survivor: x.id, duplicates: [y.id] } })).status).toBe(403);
  });
});

describe("bulk update and archive", () => {
  it("by ids: dry run by default, then all or nothing through the normal update", async () => {
    const a = await create(ws.keys.ops, "contact", { email: uniqueEmail("b1") });
    const b = await create(ws.keys.ops, "contact", { email: uniqueEmail("b2") });
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { ids: [a.id, b.id], values: { job_title: "Bulk" } } });
    expect(dry.status).toBe(200);
    expect(dry.json).toMatchObject({ dry_run: true, count: 2, counts: { update: 2 } });
    expect((await get(a.id)).job_title).toBeNull();
    const bad = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { ids: [a.id, b.id], values: { job_title: "Bulk" }, expected_versions: { [b.id]: 99 }, dry_run: false } });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe("bulk_failed");
    expect(bad.json.errors).toEqual([expect.objectContaining({ id: b.id, action: "error" })]);
    expect((await get(a.id)).job_title).toBeNull();
    const ok = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { ids: [a.id, b.id], values: { job_title: "Bulk" }, dry_run: false } });
    expect(ok.status).toBe(200);
    expect((await get(b.id)).job_title).toBe("Bulk");
    const ev = await call("GET", `/v1/events?record=${a.id}`, { key: ws.keys.ops });
    expect(ev.json.data[0]).toMatchObject({ type: "contact.updated", data: { after: { job_title: "Bulk" } } });
    // Status transitions are those of a single update.
    const t = await create(ws.keys.ops, "lead", { contact: a.id });
    const conv = await call("POST", "/v1/objects/lead/records/bulk_update", { key: ws.keys.ops, body: { ids: [t.id], values: { status: "converted" }, dry_run: false } });
    expect(conv.status).toBe(422);
  });

  it("by filter: a dry run issues a token bound to the filter and the records; the run never widens", async () => {
    const tag = `fl${stamp}`;
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await create(ws.keys.ops, "contact", { email: uniqueEmail(`f${i}`), source: tag })).id);
    const where = { field: "source", op: "eq", value: tag };
    const noToken = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { where, values: { job_title: "F" }, dry_run: false } });
    expect(noToken.status).toBe(400);
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { where, values: { job_title: "F" } } });
    expect(dry.json.count).toBe(3);
    expect(dry.json.sample).toHaveLength(3);
    const token = dry.json.confirm_token as string;
    // Different values, or another key, can't use the token.
    expect((await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { where, values: { job_title: "G" }, dry_run: false, confirm_token: token } })).status).toBe(400);
    const other = await member(ALL);
    expect((await call("POST", "/v1/objects/contact/records/bulk_update", { key: other.key, body: { where, values: { job_title: "F" }, dry_run: false, confirm_token: token } })).status).toBe(400);
    // One record stops matching and a new one starts: neither is changed, both are reported.
    await call("PATCH", `/v1/objects/contact/records/${ids[0]}`, { key: ws.keys.ops, body: { source: "elsewhere" } });
    const late = await create(ws.keys.ops, "contact", { email: uniqueEmail("late"), source: tag });
    const run = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { where, values: { job_title: "F" }, dry_run: false, confirm_token: token } });
    expect(run.status).toBe(200);
    expect(run.json.count).toBe(2);
    expect(run.json.no_longer_matching).toEqual([ids[0]]);
    expect(run.json.new_matches_not_changed).toBe(1);
    expect((await get(ids[0]!)).job_title).toBeNull();
    expect((await get(late.id)).job_title).toBeNull();
    expect((await get(ids[1]!)).job_title).toBe("F");
    // Archive by filter the same way; write without archive is refused before anything.
    const arch = await call("POST", "/v1/objects/contact/records/bulk_archive", { key: ws.keys.ops, body: { where } });
    expect(arch.json.count).toBe(3);
    const noArchive = await member(["records:read", "records:write"]);
    expect((await call("POST", "/v1/objects/contact/records/bulk_archive", { key: noArchive.key, body: { where } })).status).toBe(403);
    const done = await call("POST", "/v1/objects/contact/records/bulk_archive", { key: ws.keys.ops, body: { where, dry_run: false, confirm_token: arch.json.confirm_token } });
    expect(done.status).toBe(200);
    expect(done.json.counts.archive).toBe(3);
    expect((await get(late.id)).archived_at).toBeTruthy();
  });

  it("refuses unwritable fields and hidden filters up front, and row errors don't echo hidden values", async () => {
    const SECRET = `zq${stamp}bulksentinel`;
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "bulk_badge", type: "text" } })).status).toBe(201);
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("h"), bulk_badge: SECRET });
    const m = await member(ALL, { fields: { contact: { bulk_badge: "none", job_title: "read" } } });
    expect((await call("POST", "/v1/objects/contact/records/bulk_update", { key: m.key, body: { ids: [c.id], values: { job_title: "x" } } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/contact/records/bulk_update", { key: m.key, body: { ids: [c.id], values: { bulk_badge: "x" } } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/contact/records/bulk_update", { key: m.key, body: { where: { field: "bulk_badge", op: "eq", value: SECRET }, values: { source: "x" } } })).status).toBe(403);
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: m.key, body: { where: { field: "id", op: "eq", value: c.id }, values: { email: "not-an-email" } } });
    expect(dry.status).toBe(200);
    expect(dry.json.counts.error).toBe(1);
    expect(JSON.stringify(dry.json)).not.toContain(SECRET);
    expect(dry.json.confirm_token).toBeUndefined();
  });

  it("500 records in one request emit 500 events; automation caps and the worker's batches hold", async () => {
    const tag = `big${stamp}`;
    await asApp(async (tx) => {
      await tx`INSERT INTO contacts (tenant_id, id, first_name, source)
               SELECT ${ws.tenantId}, ('00000000-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'Bulk', ${tag} FROM generate_series(1, 500) g`;
    });
    await drain();
    const auto = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: `Bulk cap ${stamp}`, trigger: { event: "contact.updated" }, condition: { field: "source", op: "eq", value: tag }, hourly_cap: 50,
      actions: [{ type: "update_record", values: { job_title: "Touched" } }] } });
    expect(auto.status).toBe(201);
    const where = { field: "source", op: "eq", value: tag };
    // A fresh key: a 500-record dry run takes 50 tokens (one per 10 records, charged once its count is known)
    // and the run 167, so the run waits about a second for the bucket to refill, as 500 single updates would.
    const big = await member(ALL);
    const started = Date.now();
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: big.key, body: { where, values: { last_name: "Big" } } });
    expect(dry.json.count).toBe(500);
    const body = { where, values: { last_name: "Big" }, dry_run: false, confirm_token: dry.json.confirm_token };
    const early = await call("POST", "/v1/objects/contact/records/bulk_update", { key: big.key, body });
    expect(early.status).toBe(429);
    await new Promise((r) => setTimeout(r, Number(early.headers.get("retry-after")) * 1000 + 100));
    const run = await call("POST", "/v1/objects/contact/records/bulk_update", { key: big.key, body });
    expect(run.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The bucket is now nearly empty: a second full run has to wait, as 500 single updates would.
    const rerun = await call("POST", "/v1/objects/contact/records/bulk_update", { key: big.key, body });
    expect(rerun.status).toBe(429);
    const { n: queued } = (await asApp((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'contact.updated' AND processed_at IS NULL`))[0]!;
    expect(queued).toBe(500);
    expect(await processEvents(ws.tenantId)).toBe(100); // one batch at a time
    await drain();
    const runs = await asApp((tx) => tx<{ status: string; n: number }[]>`SELECT status, count(*)::int AS n FROM automation_runs
      WHERE automation_id = ${decodeId(auto.json.automation.id)!.uuid} GROUP BY status ORDER BY status`);
    expect(runs).toEqual([{ status: "skipped", n: 450 }, { status: "succeeded", n: 50 }]);
    const { n: touched } = (await asApp((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM contacts WHERE source = ${tag} AND job_title = 'Touched'`))[0]!;
    expect(touched).toBe(50);
  }, 60_000);
});

describe("leads and hostile input", () => {
  it("merges leads, but a converted survivor can't take values", async () => {
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("ld") });
    const s = await create(ws.keys.ops, "lead", { contact: c.id, status: "qualified" });
    const d = await create(ws.keys.ops, "lead", { contact: c.id, interest: "Widgets", status: "qualified" });
    await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: d.id } });
    const conv = await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: s.id } });
    const s2 = await create(ws.keys.ops, "lead", { contact: c.id, status: "working" });
    // A converted lead is history (its deal's source): it can only be the survivor, never a duplicate.
    const r = await merge({ survivor: s2.id, duplicates: [d.id] });
    expect(r.status).toBe(409);
    expect(r.json.detail).toMatch(/converted lead, which can only be the survivor/);
    const dDeal = (await get(d.id)).converted_deal;
    if (dDeal) expect((await get(dDeal)).source_lead).toBe(d.id);
    // Merging an open lead into the converted one works when it takes no values: its references move to it.
    const s3 = await create(ws.keys.ops, "lead", { contact: c.id, status: "working" });
    const into = await merge({ survivor: d.id, duplicates: [s3.id] });
    expect(into.status).toBe(200);
    expect((await get(s3.id)).merged_into).toBe(d.id);
    expect((await get(s2.id)).archived_at).toBeUndefined();
    // A converted survivor is read-only.
    const d3 = await create(ws.keys.ops, "lead", { contact: c.id, interest: "Gadgets" });
    expect((await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d3.id] } })).status).toBe(409);
    expect((await get(conv.json.result.deal.id)).source_lead).toBe(s.id);
  });

  it("every hostile input is a 4xx", async () => {
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("hx") });
    const cases: [string, string, unknown][] = [
      ["POST", "/v1/ops/merge_records", { survivor: "nope", duplicates: ["x"] }],
      ["POST", "/v1/ops/merge_records", { survivor: c.id, duplicates: [42] }],
      ["POST", "/v1/ops/merge_records", { survivor: c.id, duplicates: Array(11).fill(c.id) }],
      ["POST", "/v1/ops/merge_records", { survivor: c.id, duplicates: ["con_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"], fields: { nope: c.id } }],
      ["POST", "/v1/objects/contact/records/bulk_update", { ids: ["x"], values: { job_title: "a" } }],
      ["POST", "/v1/objects/contact/records/bulk_update", { ids: [c.id], where: { field: "id", op: "eq", value: c.id }, values: { a: 1 } }],
      ["POST", "/v1/objects/contact/records/bulk_update", { where: { field: "nope", op: "eq", value: 1 }, values: { job_title: "a" } }],
      ["POST", "/v1/objects/contact/records/bulk_update", { where: { field: "created_at", op: "gt", value: "not a date" }, values: { job_title: "a" } }],
      ["POST", "/v1/objects/contact/records/bulk_update", { where: { field: "id", op: "eq", value: c.id }, values: {} }],
      ["POST", "/v1/objects/contact/records/bulk_update", { where: { field: "id", op: "eq", value: c.id }, values: { job_title: "a" }, dry_run: false, confirm_token: "a.b" }],
      ["POST", "/v1/objects/contact/records/bulk_update", { ids: [c.id], values: { job_title: "a" }, expected_versions: { nope: 1 } }],
      ["POST", "/v1/objects/contact/records/bulk_archive", { ids: Array(501).fill(c.id) }],
      ["POST", "/v1/objects/contact/duplicates", { rules: [["nope"]] }],
      ["POST", "/v1/objects/contact/duplicates", { rules: [[]] }],
      ["POST", "/v1/objects/contact/duplicates", { min_similarity: 5 }],
      ["POST", "/v1/objects/nope/duplicates", {}],
      ["POST", `/v1/objects/deal/records/${c.id}/restore`, {}],
      ["POST", "/v1/objects/contact/records/con_00000000000000000000000000/restore", {}],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(method, path, { key: ws.keys.ops, body });
      expect(res.status, `${path} ${JSON.stringify(body)}: ${JSON.stringify(res.json)}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${path} ${JSON.stringify(body)}`).toBeLessThan(500);
    }
  });
});

describe("batch create dry run", () => {
  it("reports what would be created, with per-row errors, and writes nothing", async () => {
    const email = uniqueEmail("dry");
    const res = await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { dry_run: true, records: [
      { email, first_name: "Dry" }, { email }, { email: "bad" },
    ] } });
    expect(res.status).toBe(200);
    expect(res.json.counts).toEqual({ create: 1, error: 2 });
    expect(res.json.rows[0]).toMatchObject({ index: 0, action: "create", record: { email, first_name: "Dry" } });
    expect(res.json.rows[0].record.id).toBeUndefined();
    expect(res.json.rows[1]).toMatchObject({ index: 1, action: "error" });
    const found = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "email", op: "eq", value: email } } });
    expect(found.json.data).toEqual([]);
    // The real run of the good row still works: the preview held no lock and left nothing behind.
    expect((await call("POST", "/v1/objects/contact/records/batch", { key: ws.keys.ops, body: { records: [{ email }] } })).status).toBe(201);
  });
});
