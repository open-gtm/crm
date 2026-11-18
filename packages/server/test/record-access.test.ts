import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import { routes } from "../src/api/registry.js";
import { decodeId } from "../src/lib/ids.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Per-object and per-field record access (ADR 0008), through real HTTP calls. Values that a role
 * must never see are sentinels, so a leak anywhere in a response body is a plain substring match.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const SECRET = `zq${Date.now().toString(36)}contactsentinel`; // contact.secret_code
const DEAL_SECRET = `zq${Date.now().toString(36)}dealsentinel`; // deal.deal_secret
const RENAMED_VALUE = `zq${Date.now().toString(36)}renamesentinel`; // a field hidden by a rule, then renamed
const ADDR_SECRET = `Zq${Date.now().toString(36)}addrsentinel`; // contact.secret_addr.city (an address part)
const JSON_SECRET = `zq${Date.now().toString(36)}jsonsentinel`; // contact.secret_json.deep.value (inside a json value)

let ws: Workspace;
let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;
const ids: { account: string; contact: string; deal: string; lead: string } = { account: "", contact: "", deal: "", lead: "" };
let contactEmail = "";

async function role(permissions: string[], rules: Record<string, unknown> = {}, key = ws.keys.admin) {
  const r = await call("POST", "/v1/roles", { key, body: { key: slug("r"), name: "Custom", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string; permissions: string[]; objects: Record<string, unknown>; fields: Record<string, unknown> };
}

const ALL = ["records:read", "records:write", "records:archive"];
const OPS = ["ops:read", "ops:write"];
const has = (body: unknown, s: string) => JSON.stringify(body ?? null).includes(s);

/** The owner's view of a contact, for checking that nothing changed. */
const ownerGet = async (object: string, id: string) => (await call("GET", `/v1/objects/${object}/records/${id}`, { key: ws.keys.ops })).json.data;

beforeAll(async () => {
  ws = await newWorkspace("Record access");
  for (const [object, field, type] of [["contact", "secret_code", "text"], ["deal", "deal_secret", "text"], ["contact", "secret_addr", "address"],
    ["contact", "secret_json", "json"]] as const) {
    const f = await call("POST", `/v1/objects/${object}/fields`, { key: ws.keys.admin, body: { api_name: field, type } });
    if (f.status !== 201) throw new Error(`field: ${JSON.stringify(f.json)}`);
  }
  const acct = await create(ws.keys.ops, "account", { name: "Acme Visible", domain: `acme-${Date.now()}.example` });
  contactEmail = uniqueEmail("carla");
  const contact = await create(ws.keys.ops, "contact", { first_name: "Carla", last_name: "Contact", email: contactEmail, phone: "555 0100",
    secret_code: SECRET, account: acct.id, secret_addr: { city: ADDR_SECRET, country: "NZ" }, secret_json: { deep: { value: JSON_SECRET } } });
  const deal = await create(ws.keys.ops, "deal", { name: "Deal Visible", primary_contact: contact.id, account: acct.id, deal_secret: DEAL_SECRET, amount: 1200 });
  const lead = await create(ws.keys.ops, "lead", { contact: contact.id, interest: "Widgets", status: "qualified" });
  Object.assign(ids, { account: acct.id, contact: contact.id, deal: deal.id, lead: lead.id });
  // Sanity: the owner sees both sentinels, so their absence below means something.
  expect((await ownerGet("contact", contact.id)).secret_code).toBe(SECRET);
  expect((await ownerGet("deal", deal.id)).deal_secret).toBe(DEAL_SECRET);
  expect(JSON.stringify(await ownerGet("contact", contact.id))).toContain(ADDR_SECRET);
  expect(JSON.stringify(await ownerGet("contact", contact.id))).toContain(JSON_SECRET);
});

describe("object rules", () => {
  it("grant read on one object to a role without records:read", async () => {
    const r = await role([], { objects: { contact: { read: true } } });
    expect(r.objects).toEqual({ contact: { read: true, write: null, archive: null } });
    const m = await memberWithKey(ws, r.key, ["ops:read"]);
    const list = await call("GET", "/v1/objects/contact/records", { key: m.key });
    expect(list.status).toBe(200);
    expect(list.json.data.some((c: { id: string }) => c.id === ids.contact)).toBe(true);
    expect((await call("GET", `/v1/records/${ids.contact}`, { key: m.key })).status).toBe(200);
    for (const [method, path, body] of [
      ["GET", "/v1/objects/deal/records", undefined], ["GET", `/v1/objects/deal/records/${ids.deal}`, undefined],
      ["GET", `/v1/records/${ids.deal}`, undefined], ["POST", "/v1/query", { object: "deal" }], ["GET", "/v1/me/tasks", undefined],
      ["POST", "/v1/objects/contact/records", { email: uniqueEmail("no") }], ["GET", "/v1/search?q=Deal&objects=deal", undefined],
    ] as const) {
      const res = await call(method, path, { key: m.key, body });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    // Search skips what the role can't read; the schema still lists every object, with the caller's access.
    const found = await call("GET", "/v1/search?q=visible", { key: m.key });
    expect(found.json.data.every((x: { object: string }) => x.object === "contact")).toBe(true);
    const summary = (await call("GET", "/v1/schema", { key: m.key })).json.data.objects as { name: string; records: number | null; access: { read: boolean } }[];
    expect(summary.find((o) => o.name === "deal")).toMatchObject({ records: null, access: { read: false } });
    expect(summary.find((o) => o.name === "contact")!.records).toBeGreaterThan(0);
    const me = (await call("GET", "/v1/me/access", { key: m.key })).json.data;
    expect(me.objects.find((o: { object: string }) => o.object === "contact")).toMatchObject({ read: true, write: false, archive: false });
    expect(me.objects.find((o: { object: string }) => o.object === "deal")).toMatchObject({ read: false });
    // Granted read makes ops:read usable for the role; nothing makes ops:write usable.
    expect((await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "w", scopes: ["ops:write"], owner: m.id } })).status).toBe(403);
  });

  it("deny one object to a role with records:read", async () => {
    const r = await role(ALL, { objects: { deal: { read: false, write: false, archive: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    expect((await call("GET", "/v1/objects/contact/records", { key: m.key })).status).toBe(200);
    expect((await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key })).status).toBe(403);
    expect((await call("GET", `/v1/records/${ids.deal}`, { key: m.key })).status).toBe(403);
    expect((await call("GET", `/v1/records/${ids.deal}/timeline`, { key: m.key })).status).toBe(403);
    expect((await call("POST", "/v1/objects/deal/records", { key: m.key, body: { name: "x", primary_contact: ids.contact } })).status).toBe(403);
    // Linking to a deal is refused too: it would confirm the deal exists.
    expect((await call("POST", "/v1/ops/log_activity", { key: m.key, body: { type: "note", related_to: [ids.deal] } })).status).toBe(403);
    // Filters can't reach into deals through a relation path either.
    const path = await call("POST", "/v1/query", { key: m.key, body: { object: "lead", where: { path: ["converted_deal", "name"], op: "eq", value: "x" } } });
    expect(path.status).toBe(403);
    const search = await call("GET", "/v1/search?q=deal visible", { key: m.key });
    expect(has(search.json, ids.deal)).toBe(false);
    // Events about deals are filtered out.
    const events = await call("GET", "/v1/events?limit=200", { key: m.key });
    expect(events.status).toBe(200);
    // Schema events about the deal object (no record) are metadata and stay; record events don't.
    expect(events.json.data.some((e: { object: string; record_id: string | null }) => e.object === "deal" && e.record_id)).toBe(false);
    expect(has(events.json, DEAL_SECRET)).toBe(false);
  });

  it("write without archive, and archive granted on one object", async () => {
    const r = await role(ALL, { objects: { contact: { archive: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("arch") });
    expect((await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: m.key, body: { job_title: "CTO" } })).status).toBe(200);
    expect((await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: m.key })).status).toBe(403);
    const a = await create(ws.keys.ops, "account", { name: "Archivable" });
    expect((await call("DELETE", `/v1/objects/account/records/${a.id}`, { key: m.key })).status).toBe(200);

    const r2 = await role(["records:read", "records:write"], { objects: { account: { archive: true } } });
    const m2 = await memberWithKey(ws, r2.key, OPS);
    const a2 = await create(ws.keys.ops, "account", { name: "Archivable 2" });
    expect((await call("DELETE", `/v1/objects/account/records/${a2.id}`, { key: m2.key })).status).toBe(200);
    expect((await call("DELETE", `/v1/objects/contact/records/${c.id}`, { key: m2.key })).status).toBe(403);
  });

  it("a related record on an object the caller can't read shows as its ID only", async () => {
    const r = await role(ALL, { objects: { account: { read: false, write: false, archive: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const deal = await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key });
    expect(deal.status).toBe(200);
    expect(deal.json.data.account).toBe(ids.account);
    expect(has(deal.json, "Acme Visible")).toBe(false);
    const tl = await call("GET", `/v1/records/${ids.deal}/timeline`, { key: m.key });
    expect(has(tl.json, "Acme Visible")).toBe(false);
    // Filtering by the account's ID is fine; reaching into its fields is not.
    expect((await call("POST", "/v1/query", { key: m.key, body: { object: "deal", where: { field: "account", op: "eq", value: ids.account } } })).status).toBe(200);
    expect((await call("POST", "/v1/query", { key: m.key, body: { object: "deal", where: { path: ["account", "name"], op: "eq", value: "Acme Visible" } } })).status).toBe(403);
    // Setting a relation to an unreadable object is refused.
    const res = await call("POST", "/v1/objects/contact/records", { key: m.key, body: { email: uniqueEmail("link"), account: ids.account } });
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/account/);
  });
});

describe("field rules", () => {
  let limited: { id: string; key: string };
  let limitedRole: { key: string; id: string };
  beforeAll(async () => {
    limitedRole = await role(ALL, { fields: { contact: { secret_code: "none", phone: "read" }, deal: { deal_secret: "none" } } });
    limited = await memberWithKey(ws, limitedRole.key, OPS);
  });

  it("none hides a field from every read; read shows it", async () => {
    for (const path of [`/v1/objects/contact/records/${ids.contact}`, `/v1/records/${ids.contact}`, "/v1/objects/contact/records?limit=200",
      `/v1/objects/contact/records/${ids.contact}?include_hidden=true`, `/v1/records/${ids.deal}`, `/v1/records/${ids.contact}/timeline`]) {
      const res = await call("GET", path, { key: limited.key });
      expect(res.status, path).toBe(200);
      expect(has(res.json, SECRET), path).toBe(false);
      expect(has(res.json, DEAL_SECRET), path).toBe(false);
    }
    const c = (await call("GET", `/v1/objects/contact/records/${ids.contact}`, { key: limited.key })).json.data;
    expect("secret_code" in c).toBe(false);
    expect(c.phone).toBe("555 0100");
    expect(c.display_name).toBe("Carla Contact");
    const q = await call("POST", "/v1/query", { key: limited.key, body: { object: "contact", where: { field: "phone", op: "eq", value: "555 0100" } } });
    expect(q.status).toBe(200);
    expect(has(q.json, SECRET)).toBe(false);
  });

  it("describe reports each field's access for the caller", async () => {
    const d = (await call("GET", "/v1/objects/contact", { key: limited.key })).json.data;
    const access = Object.fromEntries(d.fields.map((f: { name: string; access: string }) => [f.name, f.access]));
    expect(access).toMatchObject({ secret_code: "none", phone: "read", email: "write" });
    expect(d.access).toEqual({ read: true, write: true, archive: true });
  });

  it("writes to a field that isn't writable are refused, naming the field; responses omit hidden fields", async () => {
    for (const body of [{ phone: "1" }, { secret_code: "x" }, { first_name: "Ok", secret_code: "x" }]) {
      const res = await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: limited.key, body });
      expect(res.status).toBe(403);
      expect(res.json.detail).toMatch(Object.keys(body).includes("phone") ? /contact\.phone/ : /contact\.secret_code/);
    }
    expect((await ownerGet("contact", ids.contact)).first_name).toBe("Carla");
    const ok = await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: limited.key, body: { job_title: "Buyer" } });
    expect(ok.status).toBe(200);
    expect("secret_code" in ok.json.data).toBe(false);
    expect(ok.headers.get("etag")).toBe(`"v${ok.json.data.version}"`);
    expect((await ownerGet("contact", ids.contact)).secret_code).toBe(SECRET); // untouched
    const made = await call("POST", "/v1/objects/contact/records", { key: limited.key, body: { email: uniqueEmail("lim") } });
    expect(made.status).toBe(201);
    expect("secret_code" in made.json.data).toBe(false);
    expect((await call("POST", "/v1/objects/contact/records", { key: limited.key, body: { email: uniqueEmail("lim"), secret_code: "x" } })).status).toBe(403);
    const batch = await call("POST", "/v1/objects/contact/records/batch", { key: limited.key, body: { records: [{ email: uniqueEmail("b1") }, { email: uniqueEmail("b2"), phone: "2" }] } });
    expect(batch.status).toBe(403);
  });

  it("filters, sorts and relation paths on a hidden field are refused", async () => {
    for (const body of [
      { object: "contact", where: { field: "secret_code", op: "eq", value: SECRET } },
      { object: "contact", where: { field: "secret_code", op: "is_null" } },
      { object: "contact", where: { not: { field: "secret_code", op: "starts_with", value: "zq" } } },
      { object: "contact", sort: [{ field: "secret_code", dir: "asc" }] },
      { object: "deal", where: { path: ["primary_contact", "secret_code"], op: "eq", value: SECRET } },
      { object: "deal", where: { field: "deal_secret", op: "contains", value: "sentinel" } },
    ]) {
      const res = await call("POST", "/v1/query", { key: limited.key, body });
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    expect((await call("GET", `/v1/objects/contact/records?filter[secret_code]=${SECRET}`, { key: limited.key })).status).toBe(403);
    expect((await call("GET", "/v1/objects/contact/records?sort=secret_code", { key: limited.key })).status).toBe(403);
  });

  it("search never matches on a hidden field, but still matches visible ones", async () => {
    const owner = await call("GET", `/v1/search?q=${SECRET}`, { key: ws.keys.ops });
    expect(owner.json.data.map((x: { id: string }) => x.id)).toContain(ids.contact);
    const hidden = await call("GET", `/v1/search?q=${SECRET}`, { key: limited.key });
    expect(hidden.status).toBe(200);
    expect(hidden.json.data).toEqual([]);
    const visible = await call("GET", "/v1/search?q=carla", { key: limited.key });
    expect(visible.json.data.map((x: { id: string }) => x.id)).toContain(ids.contact);
    expect(has(visible.json, SECRET)).toBe(false);
  });

  it("events drop fields the caller can't read", async () => {
    const owner = await call("GET", `/v1/events?record=${ids.contact}`, { key: ws.keys.ops });
    expect(has(owner.json, SECRET)).toBe(true);
    const mine = await call("GET", `/v1/events?record=${ids.contact}`, { key: limited.key });
    expect(mine.status).toBe(200);
    expect(mine.json.data.length).toBe(owner.json.data.length);
    expect(has(mine.json, SECRET)).toBe(false);
    const created = mine.json.data.find((e: { type: string }) => e.type === "contact.created");
    expect(created.data.after).toMatchObject({ first_name: "Carla", phone: "555 0100" });
    expect("secret_code" in created.data.after).toBe(false);
  });

  it("a required field the caller can't write blocks creating records (unless it has a default)", async () => {
    const r = await role(ALL, { fields: { account: { name: "read" } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const res = await call("POST", "/v1/objects/account/records", { key: m.key, body: { industry: "x" } });
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/account\.name is required/);
  });

  it("a rule follows its field through a rename", async () => {
    const field = `temp_${Date.now().toString(36)}`;
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: field, type: "text" } })).status).toBe(201);
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("ren"), [field]: RENAMED_VALUE });
    const r = await role(ALL, { fields: { contact: { [field]: "none" } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const renamed = `${field}_v2`;
    expect((await call("PATCH", `/v1/objects/contact/fields/${field}`, { key: ws.keys.admin, body: { api_name: renamed } })).status).toBe(200);
    expect((await call("GET", `/v1/roles/${r.key}`, { key: ws.keys.admin })).json.data.fields.contact).toEqual({ [renamed]: "none" });
    const seen = await call("GET", `/v1/objects/contact/records/${c.id}`, { key: m.key });
    expect(seen.status).toBe(200);
    expect(renamed in seen.json.data).toBe(false);
    expect(has(seen.json, RENAMED_VALUE)).toBe(false);
    expect((await ownerGet("contact", c.id))[renamed]).toBe(RENAMED_VALUE);
  });
});

describe("operations check every object they touch, before any work", () => {
  const counts = async () => sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
    const [r] = await tx<{ contacts: number; leads: number; activities: number; deals: number }[]>`
      SELECT (SELECT count(*) FROM contacts)::int AS contacts, (SELECT count(*) FROM leads)::int AS leads,
             (SELECT count(*) FROM activities)::int AS activities, (SELECT count(*) FROM deals)::int AS deals`;
    return r!;
  });

  it("capture_interest is refused when activities aren't writable, and changes nothing", async () => {
    const r = await role(ALL, { objects: { activity: { write: false, archive: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const before = await counts();
    const email = uniqueEmail("capture");
    for (const dry_run of [true, false]) {
      const res = await call("POST", "/v1/ops/capture_interest", { key: m.key, body: { email, first_name: "New", interest: "x", dry_run } });
      expect(res.status).toBe(403);
      expect(res.json.detail).toMatch(/activity/);
    }
    expect(await counts()).toEqual(before);
    // With a hidden contact field it can't even probe whether a contact exists.
    const r2 = await role(ALL, { fields: { contact: { email: "read" } } });
    const m2 = await memberWithKey(ws, r2.key, OPS);
    expect((await call("POST", "/v1/ops/capture_interest", { key: m2.key, body: { email: contactEmail, dry_run: true } })).status).toBe(403);
  });

  it("convert_lead is refused when deals aren't writable; the lead stays qualified", async () => {
    const r = await role(ALL, { objects: { deal: { write: false, archive: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const lead = await create(ws.keys.ops, "lead", { contact: ids.contact, status: "qualified" });
    const before = await counts();
    const res = await call("POST", "/v1/ops/convert_lead", { key: m.key, body: { lead: lead.id } });
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/deal/);
    expect(await counts()).toEqual(before);
    expect((await ownerGet("lead", lead.id)).status).toBe("qualified");
  });

  it("move_deal_stage needs write on the stage field; assign_owner on the owner field", async () => {
    const r = await role(ALL, { fields: { deal: { stage: "read" }, contact: { owner: "read" } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const before = await ownerGet("deal", ids.deal);
    const move = await call("POST", "/v1/ops/move_deal_stage", { key: m.key, body: { deal: ids.deal, stage: "Proposal" } });
    expect(move.status).toBe(403);
    expect(move.json.detail).toMatch(/deal\.stage/);
    expect((await ownerGet("deal", ids.deal)).stage).toBe(before.stage);
    const assign = await call("POST", "/v1/ops/assign_owner", { key: m.key, body: { record: ids.contact, owner: ws.ownerId } });
    expect(assign.status).toBe(403);
    expect((await call("POST", "/v1/ops/assign_owner", { key: m.key, body: { record: ids.deal, owner: ws.ownerId, dry_run: true } })).status).toBe(200);
  });

  it("a hidden stage is left out of a deal's timeline", async () => {
    const r = await role(ALL, { fields: { deal: { stage: "none" } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const owner = await call("GET", `/v1/records/${ids.deal}/timeline`, { key: ws.keys.ops });
    expect(owner.json.data.items.some((i: { kind: string }) => i.kind === "stage_change")).toBe(true);
    const tl = await call("GET", `/v1/records/${ids.deal}/timeline`, { key: m.key });
    expect(tl.status).toBe(200);
    expect(tl.json.data.items.some((i: { kind: string }) => i.kind === "stage_change")).toBe(false);
    expect("stage" in tl.json.data.record).toBe(false);
  });
});

describe("managing another member's sign-in follows record access", () => {
  it("a member manager can't list or revoke the sessions of someone whose role reads records theirs can't", async () => {
    const manage = [...ALL, "members:manage"];
    const noDeals = await role(manage, { objects: { deal: { read: false, write: false, archive: false } } });
    const manager = await memberWithKey(ws, noDeals.key, ["admin", "ops:read", "ops:write"]);
    const wider = await memberWithKey(ws, (await role(ALL)).key, OPS);
    const peer = await memberWithKey(ws, noDeals.key, OPS);
    for (const [method, path] of [["GET", `/v1/members/${wider.id}/sessions`], ["POST", `/v1/members/${wider.id}/sessions/revoke`]] as const) {
      const r = await call(method, path, { key: manager.key });
      expect(r.status, path).toBe(403);
      expect(r.json.detail, path).toMatch(/This member's role has record access you don't: deal/);
    }
    expect((await call("GET", `/v1/members/${peer.id}/sessions`, { key: manager.key })).status).toBe(200);
    expect((await call("GET", `/v1/members/${wider.id}/sessions`, { key: ws.keys.admin })).status).toBe(200);
  });
});

describe("notifications and alerts follow each recipient's access", () => {
  it("alert titles use what the recipient can read; recipients who can't read the object get nothing", async () => {
    const noNames = await memberWithKey(ws, (await role(ALL, { fields: { contact: { first_name: "none", last_name: "none" } } })).key, OPS);
    const noContacts = await memberWithKey(ws, (await role(ALL, { objects: { contact: { read: false, write: false, archive: false } } })).key, OPS);
    const users = [ws.ownerId, noNames.id, noContacts.id];
    const alert = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: "New contact", object: "contact", trigger: { type: "event", event: "contact.created" }, recipients: { users } } });
    expect(alert.status).toBe(201);
    expect(alert.json.warnings.join(" ")).toContain(noContacts.id);
    const auto = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Code", trigger: { event: "contact.created" }, actions: [{ type: "notify", title: "Code: {{record.secret_code}}", recipients: { users } }] } });
    expect(auto.status).toBe(201);
    const email = uniqueEmail("nina");
    await create(ws.keys.ops, "contact", { first_name: "Nina", last_name: "Named", email, secret_code: `${SECRET}-ntf` });
    for (let i = 0; i < 10 && (await processEvents(ws.tenantId)) > 0; i++);
    const inbox = async (key: string) => (await call("GET", "/v1/me/notifications?state=all&limit=200", { key })).json.data as { title: string }[];
    const ownerTitles = (await inbox(ws.keys.ops)).map((x) => x.title);
    expect(ownerTitles).toContain("New contact: Nina Named");
    expect(ownerTitles).toContain(`Code: ${SECRET}-ntf`);
    const named = (await inbox(noNames.key)).map((x) => x.title);
    expect(named).toContain(`New contact: ${email}`);
    expect(named.join(" ")).not.toContain("Nina");
    expect(await inbox(noContacts.key)).toEqual([]);
    const att = await call("GET", "/v1/me/attention", { key: noNames.key });
    expect(has(att.json, "Nina")).toBe(false);
  });

  it("an automation's notify skips a member who can't read a field it names, and is filled per recipient for the rest", async () => {
    const limited = await memberWithKey(ws, (await role(ALL, { fields: { contact: { secret_code: "none" } } })).key, OPS);
    const noTitles = await memberWithKey(ws, (await role(ALL, { fields: { contact: { job_title: "none" } } })).key, OPS);
    const auto = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Code 2", trigger: { event: "contact.updated" }, actions: [{ type: "notify", title: "Code: {{record.secret_code}}!", recipients: { users: [limited.id, noTitles.id] } }] } });
    expect(auto.status).toBe(201);
    // Whether it arrives (and what it says) depends on secret_code: the member who can't read it is skipped, and the save says so.
    expect(auto.json.warnings.join(" ")).toContain(`${limited.id} can't read contact.secret_code`);
    await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: ws.keys.ops, body: { job_title: "Head of buying" } });
    for (let i = 0; i < 10 && (await processEvents(ws.tenantId)) > 0; i++);
    const inbox = await call("GET", "/v1/me/notifications?state=all", { key: limited.key });
    expect(inbox.json.data.filter((x: { title: string }) => x.title.startsWith("Code:"))).toEqual([]);
    expect(has(inbox.json, SECRET)).toBe(false);
    const other = await call("GET", "/v1/me/notifications?state=all", { key: noTitles.key });
    expect(other.json.data.map((x: { title: string }) => x.title)).toContain(`Code: ${SECRET}!`);
  });

  it("personal alerts can't watch or filter on what the owner can't read", async () => {
    const r = await role(ALL, { objects: { deal: { read: false, write: false, archive: false } }, fields: { contact: { secret_code: "none" } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const base = { name: "Mine", trigger: { type: "event", event: "contact.updated" }, mine_only: false };
    const cond = await call("POST", "/v1/me/alerts", { key: m.key, body: { ...base, object: "contact", condition: { field: "secret_code", op: "eq", value: SECRET } } });
    expect(cond.status).toBe(403);
    const watch = await call("POST", "/v1/me/alerts", { key: m.key, body: { ...base, object: "contact", trigger: { type: "event", event: "contact.updated", changed_fields: ["secret_code"] } } });
    expect(watch.status).toBe(403);
    const deal = await call("POST", "/v1/me/alerts/backtest", { key: m.key, body: { ...base, object: "deal", trigger: { type: "event", event: "deal.created" } } });
    expect(deal.status).toBe(403);
    const ok = await call("POST", "/v1/me/alerts", { key: m.key, body: { ...base, object: "contact", condition: { field: "first_name", op: "eq", value: "Carla" } } });
    expect(ok.status).toBe(201);
    expect(has(ok.json, SECRET)).toBe(false);
  });
});

describe("saving roles", () => {
  it("write needs read and archive needs write, on every object with a rule", async () => {
    for (const [permissions, rules] of [
      [["records:read", "records:write"], { objects: { deal: { read: false } } }],
      [["records:read"], { objects: { deal: { archive: true } } }],
      [ALL, { objects: { deal: { write: false } } }],
      [[], { objects: { contact: { write: true } } }],
    ] as const) {
      const res = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("bad"), name: "Bad", permissions, ...rules } });
      expect(res.status, JSON.stringify(rules)).toBe(422);
      expect(res.json.detail).toMatch(/needs/);
    }
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "x", permissions: [], objects: { nope: { read: true } } } })).status).toBe(422);
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "x", permissions: [], fields: { contact: { nope: "none" } } } })).status).toBe(422);
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "x", permissions: [], fields: { contact: { email: "write" } } } })).status).toBe(422);
    expect((await call("PATCH", "/v1/roles/member", { key: ws.keys.admin, body: { objects: { deal: { read: false } } } })).status).toBe(403);
  });

  it("roles that manage automations, webhooks or alerts must be unrestricted, in the API and in the database", async () => {
    for (const [permissions, rules] of [
      [["records:read", "webhooks:manage"], { objects: { deal: { read: false } } }],
      [["records:read", "alerts:manage"], { fields: { contact: { email: "read" } } }],
      [[...ALL, "automations:manage"], { objects: { contact: { archive: false } } }],
    ] as const) {
      const res = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("mgr"), name: "Mgr", permissions, ...rules } });
      expect(res.status, JSON.stringify(permissions)).toBe(422);
      expect(res.json.detail).toMatch(/unrestricted record access/);
    }
    // A role that is limited can't gain a managing permission later either.
    const limited = await role(["records:read"], { fields: { contact: { email: "read" } } });
    expect((await call("PATCH", `/v1/roles/${limited.key}`, { key: ws.keys.admin, body: { permissions: ["records:read", "webhooks:manage"] } })).status).toBe(422);
    // Granting rules (true) are fine.
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("ok"), name: "Ok", permissions: ["records:read", "alerts:manage"],
      objects: { deal: { write: true } } } })).status).toBe(201);
    const hooks = await role(["records:read", "webhooks:manage"]);
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      const [f] = await tx<{ id: string }[]>`SELECT f.id FROM fields f JOIN objects o ON o.id = f.object_id WHERE o.api_name = 'contact' AND f.api_name = 'email'`;
      await tx`INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access) VALUES (${ws.tenantId}, ${decodeId(hooks.id)!.uuid}, ${f!.id}, 'read')`;
    })).rejects.toThrow(/unrestricted record access/);
  });

  it("nobody grants, assigns or mints keys for record access they don't have", async () => {
    const mgrRole = await role(["roles:manage", "members:manage", "keys:manage", "records:read"],
      { objects: { deal: { read: false } }, fields: { contact: { secret_code: "none" } } });
    const mgr = await memberWithKey(ws, mgrRole.key, ["admin", "ops:read"]);
    const tryRole = (permissions: string[], rules: Record<string, unknown> = {}) =>
      call("POST", "/v1/roles", { key: mgr.key, body: { key: slug("g"), name: "G", permissions, ...rules } });
    const plain = await tryRole(["records:read"]);
    expect(plain.status).toBe(403);
    expect(plain.json.detail).toMatch(/deal: read/);
    expect(plain.json.detail).toMatch(/contact\.secret_code: read/);
    expect((await tryRole([], { objects: { deal: { read: true } } })).status).toBe(403);
    expect((await tryRole(["records:read"], { objects: { deal: { read: false } } })).status).toBe(403); // still sees secret_code
    const within = await tryRole(["records:read"], { objects: { deal: { read: false } }, fields: { contact: { secret_code: "none" } } });
    expect(within.status).toBe(201);
    // Editing a role to widen it beyond the caller is refused; narrowing within is fine.
    expect((await call("PATCH", `/v1/roles/${within.json.data.key}`, { key: mgr.key, body: { objects: { deal: null } } })).status).toBe(403);
    expect((await call("PATCH", `/v1/roles/${within.json.data.key}`, { key: mgr.key, body: { objects: { contact: { read: false } } } })).status).toBe(200);
    // Assigning a role with more record access is refused, when adding and when changing a member.
    const reader = await role(["records:read"]);
    expect((await call("POST", "/v1/members", { key: mgr.key, body: { email: uniqueEmail("a"), name: "A", role: reader.key } })).status).toBe(403);
    const ok = await call("POST", "/v1/members", { key: mgr.key, body: { email: uniqueEmail("a"), name: "A", role: within.json.data.key } });
    expect(ok.status).toBe(201);
    expect((await call("PATCH", `/v1/members/${ok.json.data.id}`, { key: mgr.key, body: { role: reader.key } })).status).toBe(403);
    // Keys for someone whose role reads more than the caller are refused.
    const target = await memberWithKey(ws, reader.key, ["ops:read"]);
    const mint = await call("POST", "/v1/api-keys", { key: mgr.key, body: { name: "x", scopes: ["ops:read"], owner: target.id } });
    expect(mint.status).toBe(403);
    expect(mint.json.detail).toMatch(/record access/);
    expect((await call("POST", "/v1/api-keys", { key: mgr.key, body: { name: "x", scopes: ["ops:read"], owner: ok.json.data.id } })).status).toBe(201);
  });

  it("roles return their rules, an access view shows the result, and every change is audited by name", async () => {
    const r = await role(["records:read", "records:write"], { objects: { deal: { read: false, write: false } }, fields: { contact: { email: "read" } } });
    const got = (await call("GET", `/v1/roles/${r.key}`, { key: ws.keys.ops })).json.data;
    expect(got.objects).toEqual({ deal: { read: false, write: false, archive: null } });
    expect(got.fields).toEqual({ contact: { email: "read" } });
    const upd = await call("PATCH", `/v1/roles/${r.key}`, { key: ws.keys.admin, body: { objects: { deal: null, contact: { archive: true } }, fields: { contact: { email: null, phone: "none" } } } });
    expect(upd.status).toBe(200);
    expect(upd.json.data.objects).toEqual({ contact: { read: null, write: null, archive: true } });
    expect(upd.json.data.fields).toEqual({ contact: { phone: "none" } });
    const view = (await call("GET", `/v1/roles/${r.key}/access`, { key: ws.keys.ops })).json.data;
    expect(view.objects.find((o: { object: string }) => o.object === "contact")).toMatchObject({ read: true, write: true, archive: true, fields: { phone: "none" } });
    expect(view.objects.find((o: { object: string }) => o.object === "deal")).toMatchObject({ read: true, write: true, archive: false, rule: null });
    const log = (await call("GET", "/v1/audit-log?action=role.&limit=50", { key: ws.keys.admin })).json.data as { action: string; record_id: string; details: Record<string, unknown> }[];
    const entry = log.find((e) => e.action === "role.updated" && e.record_id === decodeId(r.id)!.uuid)!;
    expect(entry.details.object_rules).toEqual(expect.arrayContaining([{ object: "deal", read: null, write: null, archive: null }, { object: "contact", read: null, write: null, archive: true }]));
    expect(entry.details.field_rules).toEqual(expect.arrayContaining([{ object: "contact", field: "email", access: null }, { object: "contact", field: "phone", access: "none" }]));
    // Copying a role copies its rules.
    const copy = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("copy"), name: "Copy", copy_from: r.key } });
    expect(copy.json.data.fields).toEqual({ contact: { phone: "none" } });
  });

  it("a rule change takes effect on the holder's next request, with the same key", async () => {
    const r = await role([], { objects: { contact: { read: true } } });
    const m = await memberWithKey(ws, r.key, ["ops:read"]);
    expect((await call("GET", `/v1/records/${ids.contact}`, { key: m.key })).json.data.secret_code).toBe(SECRET);
    expect((await call("PATCH", `/v1/roles/${r.key}`, { key: ws.keys.admin, body: { fields: { contact: { secret_code: "none" } } } })).status).toBe(200);
    expect("secret_code" in (await call("GET", `/v1/records/${ids.contact}`, { key: m.key })).json.data).toBe(false);
    expect((await call("PATCH", `/v1/roles/${r.key}`, { key: ws.keys.admin, body: { objects: { contact: null }, fields: { contact: null } } })).status).toBe(200);
    expect((await call("GET", `/v1/records/${ids.contact}`, { key: m.key })).status).toBe(403);
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(403); // no permissions and no grants left
    expect((await call("PATCH", `/v1/roles/${r.key}`, { key: ws.keys.admin, body: { objects: { contact: { read: true } } } })).status).toBe(200);
    expect((await call("GET", `/v1/records/${ids.contact}`, { key: m.key })).status).toBe(200);
  });

  it("key scopes still narrow: an ops:read key can't write even where the role's rules allow it", async () => {
    const r = await role([], { objects: { contact: { read: true, write: true } } });
    const m = await memberWithKey(ws, r.key, ["ops:read"]);
    expect((await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: m.key, body: { job_title: "x" } })).status).toBe(403);
    const w = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "w", scopes: ["ops:write"], owner: m.id } });
    expect(w.status).toBe(201);
    expect((await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: w.json.data.secret, body: { job_title: "Buyer" } })).status).toBe(200);
    expect((await call("POST", "/v1/objects/account/records", { key: w.json.data.secret, body: { name: "No" } })).status).toBe(403);
  });
});

describe("export, import and the schema document", () => {
  const exported = async (key: string, path: string) => {
    const res = await call("GET", path, { key });
    return { ...res, rows: typeof res.json === "string" ? res.json.trim().split("\r\n").map((l) => l.split(",")) : [] };
  };
  const auditCount = async (action: string) => (await call("GET", `/v1/audit-log?action=${action}&limit=500`, { key: ws.keys.admin })).json.data.length as number;
  const importCsv = (key: string, object: string, body: Record<string, unknown>) => call("POST", `/v1/objects/${object}/import`, { key, body });

  let limited: { id: string; key: string };
  beforeAll(async () => {
    limited = await memberWithKey(ws, (await role(ALL, { fields: { contact: { secret_code: "none", phone: "read" }, deal: { deal_secret: "none" } } })).key, OPS);
  });

  it("export refuses an object the caller can't read, before any work, and writes no audit entry", async () => {
    const m = await memberWithKey(ws, (await role(ALL, { objects: { deal: { read: false, write: false, archive: false } } })).key, OPS);
    const before = await auditCount("deal.exported");
    for (const format of ["csv", "ndjson"]) {
      const res = await call("GET", `/v1/objects/deal/export?format=${format}`, { key: m.key });
      expect(res.status).toBe(403);
      expect(res.json.detail).toMatch(/can't read deal records/);
    }
    expect(await auditCount("deal.exported")).toBe(before);
    expect((await call("GET", "/v1/objects/contact/export", { key: m.key })).status).toBe(200);
  });

  it("export has no column for a field the caller can't read, keeps read-only ones, and is audited", async () => {
    const before = await auditCount("contact.exported");
    for (const q of ["", "?include_hidden=true"]) {
      const csv = await exported(limited.key, `/v1/objects/contact/export${q}`);
      expect(csv.status).toBe(200);
      expect(csv.rows[0]).not.toContain("secret_code");
      expect(csv.rows[0]).toEqual(expect.arrayContaining(["id", "email", "phone"]));
      expect(has(csv.json, SECRET)).toBe(false);
    }
    const nd = await call("GET", `/v1/objects/contact/export?format=ndjson&filter[email]=${encodeURIComponent(contactEmail)}`, { key: limited.key });
    const line = JSON.parse(String(nd.json).trim());
    expect(line.phone).toBe("555 0100");
    expect("secret_code" in line).toBe(false);
    // The owner's export has the column and the value, so its absence above means something.
    const owner = await exported(ws.keys.ops, `/v1/objects/contact/export?filter[email]=${encodeURIComponent(contactEmail)}`);
    expect(owner.rows[0]).toContain("secret_code");
    expect(has(owner.json, SECRET)).toBe(true);
    expect(await auditCount("contact.exported")).toBe(before + 4);
  });

  it("export filters and sorts go through the same guard as list", async () => {
    for (const path of [`/v1/objects/contact/export?filter[secret_code]=${SECRET}`, "/v1/objects/contact/export?sort=secret_code",
      "/v1/objects/contact/export?filter[secret_code][is_null]=true", `/v1/objects/deal/export?filter[primary_contact.secret_code]=${SECRET}`]) {
      const res = await call("GET", path, { key: limited.key });
      expect(res.status, path).toBe(403);
      expect(has(res.json, SECRET)).toBe(false);
    }
    const noAccounts = await memberWithKey(ws, (await role(ALL, { objects: { account: { read: false, write: false, archive: false } } })).key, OPS);
    expect((await call("GET", "/v1/objects/deal/export?filter[account.name]=Acme Visible", { key: noAccounts.key })).status).toBe(403);
    expect((await call("GET", `/v1/objects/deal/export?filter[account]=${ids.account}`, { key: noAccounts.key })).status).toBe(200);
  });

  it("export shows a related record on an unreadable object as its ID only", async () => {
    const m = await memberWithKey(ws, (await role(ALL, { objects: { account: { read: false, write: false, archive: false } } })).key, OPS);
    const subject = `Related ${Date.now()}`;
    await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", subject, related_to: [ids.account, ids.contact] } });
    const deal = await exported(m.key, `/v1/objects/deal/export?filter[name]=Deal Visible`);
    expect(deal.rows[1]![deal.rows[0]!.indexOf("account")]).toBe(ids.account);
    expect(has(deal.json, "Acme Visible")).toBe(false);
    const act = await call("GET", `/v1/objects/activity/export?format=ndjson&filter[subject]=${encodeURIComponent(subject)}`, { key: m.key });
    const rec = JSON.parse(String(act.json).trim());
    expect(rec.related).toEqual(expect.arrayContaining([{ id: ids.account, object: "account", display_name: null },
      { id: ids.contact, object: "contact", display_name: "Carla Contact" }]));
    const ownerAct = await call("GET", `/v1/objects/activity/export?format=ndjson&filter[subject]=${encodeURIComponent(subject)}`, { key: ws.keys.ops });
    expect(has(ownerAct.json, "Acme Visible")).toBe(true);
  });

  it("import refuses up front, naming them, columns the caller can't write, keys and lookups it can't read", async () => {
    const before = (await ownerGet("contact", ids.contact)).version;
    const cols = await importCsv(limited.key, "contact", { csv: `email,first_name,phone,secret_code\n${contactEmail},Carla,1,x\n`, key: "email", dry_run: false });
    expect(cols.status).toBe(403);
    expect(cols.json.detail).toBe(`This key can't write contact.phone (column "phone"), contact.secret_code (column "secret_code"); map those columns to "" to leave them out`);
    expect(cols.json.errors).toBeUndefined(); // refused as a whole, not row by row
    const mapped = await importCsv(limited.key, "contact", { csv: `Email,Code\n${contactEmail},x\n`, mapping: { Email: "email", Code: "secret_code" }, key: "email" });
    expect(mapped.json.detail).toMatch(/contact\.secret_code \(column "Code"\)/);
    // Mapping the column to "" leaves it out, and the rest imports.
    const ok = await importCsv(limited.key, "contact", { csv: `email,first_name,phone,secret_code\n${contactEmail},Carla,1,x\n`, mapping: { phone: "", secret_code: "" }, key: "email" });
    expect(ok.status).toBe(200);
    expect(ok.json.counts).toEqual({ create: 0, update: 0, skip: 1, error: 0 });

    const noEmail = await memberWithKey(ws, (await role(ALL, { fields: { contact: { email: "none" } } })).key, OPS);
    const key = await importCsv(noEmail.key, "contact", { csv: `email,first_name\n${contactEmail},X\n`, key: "email" });
    expect(key.status).toBe(403);
    expect(key.json.detail).toMatch(/can't read contact\.email, so it can't be the upsert key/);
    const noDomain = await memberWithKey(ws, (await role(ALL, { fields: { account: { domain: "none" } } })).key, OPS);
    const look = await importCsv(noDomain.key, "contact", { csv: `email,account\n${uniqueEmail("lk")},acme.example\n`, mapping: { account: "account.domain" } });
    expect(look.status).toBe(403);
    expect(look.json.detail).toMatch(/can't read account\.domain, so column "account" can't look account records up by it/);
    const noAccounts = await memberWithKey(ws, (await role(ALL, { objects: { account: { read: false, write: false, archive: false } } })).key, OPS);
    for (const body of [{ csv: `email,account\n${uniqueEmail("lk")},${ids.account}\n` }, { csv: `email,account\n${uniqueEmail("lk")},x.example\n`, mapping: { account: "account.domain" } }]) {
      const res = await importCsv(noAccounts.key, "contact", body);
      expect(res.status).toBe(403);
      expect(res.json.detail).toMatch(/can't read account records, so column "account" can't set contact\.account/);
    }
    const noDealWrite = await memberWithKey(ws, (await role(ALL, { objects: { deal: { write: false, archive: false } } })).key, OPS);
    expect((await importCsv(noDealWrite.key, "deal", { csv: "amount\n5\n" })).status).toBe(403);
    expect((await ownerGet("contact", ids.contact)).version).toBe(before);
  });

  it("an upsert key the caller can read but not write updates matching records and creates none", async () => {
    const m = await memberWithKey(ws, (await role(ALL, { fields: { contact: { email: "read" } } })).key, OPS);
    const fresh = uniqueEmail("ro");
    const res = await importCsv(m.key, "contact", { csv: `email,job_title\n${contactEmail},Importer\n${fresh},Nobody\n`, key: "email" });
    expect(res.status).toBe(200);
    expect(res.json.rows[0]).toMatchObject({ action: "update", id: ids.contact });
    expect(res.json.rows[1]).toMatchObject({ action: "error", reason: "This key can't write contact.email" });
  });

  it("a redacted restricted value is never compared, and the placeholder an export holds is never written", async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tax_ref", type: "text", sensitivity: "restricted" } })).status).toBe(201);
    const c = await create(ws.keys.admin, "contact", { email: uniqueEmail("tax"), tax_ref: "TX-1" });
    const m = await memberWithKey(ws, (await role(ALL, { fields: { contact: { secret_code: "none" } } })).key, OPS);
    const csv = (await call("GET", `/v1/objects/contact/export?filter[email]=${encodeURIComponent(c.email as string)}`, { key: m.key })).json as string;
    expect(csv).toContain("[restricted]");
    const back = await importCsv(m.key, "contact", { csv, dry_run: false });
    expect(back.json.counts).toEqual({ create: 0, update: 0, skip: 1, error: 0 });
    const tax = async () => (await call("GET", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.admin })).json.data.tax_ref;
    expect(await tax()).toBe("TX-1");
    // A key that can read the value imports the redacted file without writing the placeholder over it.
    expect((await importCsv(ws.keys.admin, "contact", { csv, dry_run: false })).json.counts).toEqual({ create: 0, update: 0, skip: 1, error: 0 });
    expect(await tax()).toBe("TX-1");
    // The same outcome whether the value matches or not: a dry run can't be used to test a guess.
    for (const guess of ["TX-1", "TX-2"]) {
      const r = await importCsv(m.key, "contact", { csv: `id,tax_ref\n${c.id},${guess}\n` });
      expect(r.json.rows[0], guess).toMatchObject({ action: "update", id: c.id });
    }
    expect((await importCsv(ws.keys.admin, "contact", { csv: `id,tax_ref\n${c.id},TX-1\n` })).json.rows[0].action).toBe("skip");
    expect((await importCsv(m.key, "contact", { csv: `id,tax_ref\n${c.id},TX-2\n`, dry_run: false })).status).toBe(200);
    expect(await tax()).toBe("TX-2");
  });

  it("row errors, in a dry run and a real one, don't echo values the caller can't read", async () => {
    const other = await create(ws.keys.ops, "contact", { email: uniqueEmail("taken"), secret_code: `${SECRET}-other` });
    for (const dry_run of [true, false]) {
      const res = await importCsv(limited.key, "contact", { dry_run, csv: [
        "id,email,first_name",
        `${ids.contact},${other.email as string},Dup`, // unique conflict against a record with a hidden value
        `${ids.deal},x@y.example,Wrong`, // an ID of another object
        `${ids.contact},not-an-email,Bad`,
      ].join("\n") });
      expect(res.status).toBe(dry_run ? 200 : 422);
      const rows = dry_run ? res.json.rows : res.json.errors;
      expect(rows.filter((r: { action: string }) => r.action === "error")).toHaveLength(3);
      expect(has(res.json, SECRET)).toBe(false);
    }
  });

  it("the schema document lists every object and field, with the caller's access when it is limited", async () => {
    const m = await memberWithKey(ws, (await role(ALL, { objects: { deal: { read: false, write: false, archive: false } },
      fields: { contact: { secret_code: "none", phone: "read" } } })).key, OPS);
    const doc = (await call("GET", "/v1/schema/export", { key: m.key })).json;
    const names = (o: string) => doc.objects.find((x: { name: string }) => x.name === o).fields.map((f: { name: string }) => f.name);
    expect(names("contact")).toEqual(expect.arrayContaining(["secret_code", "phone"]));
    expect(names("deal")).toContain("deal_secret");
    expect(doc.access.find((a: { object: string }) => a.object === "deal")).toMatchObject({ read: false, write: false, archive: false });
    expect(doc.access.find((a: { object: string }) => a.object === "contact")).toMatchObject({ read: true, fields: { secret_code: "none", phone: "read" } });
    expect(has(doc, SECRET)).toBe(false);
    // Same names and access as describe and GET /v1/me/access.
    const me = (await call("GET", "/v1/me/access", { key: m.key })).json.data.objects;
    expect(doc.access).toEqual(me);
    // An ops:read key of an unrestricted member is limited too (no write); the owner's admin key is not, so its file has no access.
    expect((await call("GET", "/v1/schema/export", { key: (await memberWithKey(ws, "member", ["ops:read"])).key })).json.access).toBeDefined();
    const full = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    expect(full.access).toBeUndefined();
    // A document pulled with a limited key plans cleanly: access is informational.
    const planned = await call("POST", "/v1/schema/plan", { key: ws.keys.admin, body: { document: doc } });
    expect(planned.status).toBe(200);
    expect(planned.json.changes).toEqual([]);
    // Every object denied: the route gate treats the export like GET /v1/schema, and the document says nothing is readable.
    const every = (await call("GET", "/v1/objects", { key: ws.keys.admin })).json.data.map((o: { name: string }) => o.name) as string[];
    const none = await memberWithKey(ws, (await role(["records:read"], { objects: Object.fromEntries(every.map((o) => [o, { read: false }])) })).key, ["ops:read"]);
    const summary = await call("GET", "/v1/schema", { key: none.key });
    const blind = await call("GET", "/v1/schema/export", { key: none.key });
    expect(blind.status).toBe(summary.status);
    expect(blind.json.access.every((a: { read: boolean }) => !a.read)).toBe(true);
  });

  it("schema plan and apply need schema:manage, which needs unrestricted record access", async () => {
    const res = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("schema"), name: "Schema", permissions: ["records:read", "schema:manage"],
      fields: { contact: { secret_code: "none" } } } });
    expect(res.status).toBe(422);
    expect(res.json.detail).toMatch(/unrestricted record access/);
    for (const path of ["/v1/schema/plan", "/v1/schema/apply"]) {
      expect((await call("POST", path, { key: limited.key, body: { document: {} } })).status).toBe(403);
    }
  });
});

/**
 * Copy paths: the platform copies values between records (a contact's account into a lead, a deal name
 * or task title into a history activity's subject, an interest into a form_submitted subject), and the
 * reader of the copy can have different rules than the source. Sentinels in custom fields alone missed
 * these, because they copy standard fields. So the sentinels below include standard fields on every
 * object the operations touch, and the operations run first as an unrestricted member so the copies
 * exist. A new feature that copies a value from one record to another needs a sentinel here.
 */
describe("no route returns a hidden value", () => {
  it("every route, called by a role that can't read the sentinel fields, never returns them", async () => {
    const S = (what: string) => `zq${Date.now().toString(36)}${what}sentinel`;
    const sentinels = { lead: S("interest"), task: S("tasktitle"), deal: S("dealname"), activity: S("actbody"), account: S("acctname") };
    const r = await role(ALL, {
      objects: { account: { read: false, write: false, archive: false } },
      fields: { contact: { secret_code: "none", account: "none", secret_addr: "none", secret_json: "none" }, deal: { deal_secret: "none", name: "none" }, lead: { interest: "none" },
        task: { title: "none" }, activity: { body: "none" } },
    });
    const m = await memberWithKey(ws, r.key, OPS);
    // Copies made for an unrestricted member: a form submission with an interest, a completed task, a
    // converted lead with a named deal, an activity body, and a contact (free-mail, so no domain) with an account.
    const secretAcct = await create(ws.keys.ops, "account", { name: sentinels.account });
    const freeEmail = uniqueEmail("free").replace("@example.com", "@gmail.com");
    await create(ws.keys.ops, "contact", { first_name: "Free", email: freeEmail, account: secretAcct.id });
    expect((await call("POST", "/v1/ops/capture_interest", { key: ws.keys.ops, body: { email: contactEmail, interest: sentinels.lead } })).status).toBe(200);
    const task = await create(ws.keys.ops, "task", { title: sentinels.task, related_to: [ids.contact] });
    expect((await call("PATCH", `/v1/objects/task/records/${task.id}`, { key: ws.keys.ops, body: { status: "done" } })).status).toBe(200);
    const toConvert = await create(ws.keys.ops, "lead", { contact: ids.contact, status: "qualified" });
    expect((await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: toConvert.id, deal_name: sentinels.deal } })).status).toBe(200);
    expect((await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "note", body: sentinels.activity, related_to: [ids.contact] } })).status).toBe(201);
    // Workspace alerts for the member on what the copies land in, so a copied value would reach its inbox.
    for (const event of ["activity.created", "lead.created", "task.updated"]) {
      expect((await call("POST", "/v1/alerts", { key: ws.keys.admin, body: { name: `Copy ${event}`, object: event.split(".")[0],
        trigger: { type: "event", event }, recipients: { record_owner: false, users: [m.id] } } })).status).toBe(201);
    }
    // Give the member a notification and a personal alert about the sentinel-bearing contact.
    const auto = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Guard", trigger: { event: "contact.updated" }, actions: [{ type: "notify", title: "Guard {{record.secret_code}}", recipients: { users: [m.id] } }] } });
    expect(auto.status).toBe(201);
    await call("PATCH", `/v1/objects/contact/records/${ids.contact}`, { key: ws.keys.ops, body: { job_title: "Guarded" } });
    for (let i = 0; i < 10 && (await processEvents(ws.tenantId)) > 0; i++);
    const ntf = (await call("GET", "/v1/me/notifications", { key: m.key })).json.data[0].id as string;
    // An automation the member's role may run on request: it reads with its own (full) access, so what comes back must hold nothing of it.
    const runnable = await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "Guard run", trigger: { type: "manual", object: "contact" }, run_roles: [r.key],
      actions: [{ type: "find_records", id: "f", object: "contact", where: { field: "secret_code", op: "eq", value: SECRET } }, { type: "update_record", values: { job_title: "{{steps.f.count}}" } }] } });
    expect(runnable.status).toBe(201);
    // It depends on secret_code, which this member's role hides: a run_roles grant doesn't reach past their own access (403, naming nothing).
    const refused = await call("POST", `/v1/automations/${runnable.json.automation.id}/run`, { key: m.key, body: { records: [ids.contact] } });
    expect(refused.status).toBe(403);
    expect(refused.json.detail).not.toMatch(/secret_code/);
    const alr = (await call("POST", "/v1/me/alerts", { key: m.key, body: { name: "G", object: "contact", trigger: { type: "event", event: "contact.updated" }, mine_only: false } })).json.alert.id as string;
    const lead = await create(ws.keys.ops, "lead", { contact: ids.contact, status: "qualified" });
    const spare = await create(ws.keys.ops, "contact", { email: uniqueEmail("spare"), secret_code: SECRET, secret_addr: { city: ADDR_SECRET }, secret_json: { deep: { value: JSON_SECRET } } });
    const spareDeal = await create(ws.keys.ops, "deal", { name: "Spare", primary_contact: ids.contact, deal_secret: DEAL_SECRET });
    // Shared views by an admin whose filters hold hidden values: a view is not a grant, and its definition must not carry them out.
    const guardViews: Record<"contact" | "deal", string> = { contact: "", deal: "" };
    for (const [o, where] of [["contact", { field: "secret_code", op: "eq", value: SECRET }], ["deal", { field: "name", op: "eq", value: sentinels.deal }]] as const) {
      const v = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: o, name: `Guard ${o}`, shared: true, where, columns: ["id", o === "deal" ? "name" : "secret_code"] } });
      expect(v.status).toBe(201);
      guardViews[o] = v.json.data.id;
    }

    const records = { contact: { id: ids.contact, spare: spare.id, create: { email: uniqueEmail("g"), first_name: "G" }, patch: { first_name: "Carla" } },
      deal: { id: ids.deal, spare: spareDeal.id, create: { name: "G deal", primary_contact: ids.contact }, patch: { name: "Deal Visible" } } };
    const bodies: Record<string, (o: "contact" | "deal") => unknown> = {
      "POST /v1/objects/:object/records": (o) => records[o].create,
      "POST /v1/objects/:object/records/batch": (o) => ({ records: [records[o].create] }),
      "PATCH /v1/objects/:object/records/:id": (o) => records[o].patch,
      "POST /v1/query": (o) => ({ object: o }),
      "POST /v1/ops/capture_interest": () => ({ email: freeEmail }), // no domain: the contact's (hidden) account must not be reused
      "POST /v1/ops/convert_lead": () => ({ lead: lead.id }),
      "POST /v1/ops/move_deal_stage": () => ({ deal: ids.deal, stage: "Discovery" }),
      "POST /v1/ops/assign_owner": (o) => ({ record: records[o].id, owner: ws.ownerId }),
      "POST /v1/ops/log_activity": (o) => ({ type: "note", subject: "Guard", related_to: [records[o].id] }),
      "POST /v1/me/notifications/:id/snooze": () => ({ until: new Date(Date.now() + 3_600_000).toISOString() }),
      "PATCH /v1/me/notification-preferences": () => ({ digest_hour: 9 }),
      "POST /v1/me/alerts": (o) => ({ name: "G2", object: o, trigger: { type: "event", event: `${o}.updated` }, mine_only: false }),
      "POST /v1/me/alerts/backtest": (o) => ({ name: "G3", object: o, trigger: { type: "event", event: `${o}.updated` }, mine_only: false }),
      "PATCH /v1/me/alerts/:id": () => ({ name: "G renamed" }),
      "POST /v1/objects/:object/import": (o) => (o === "contact" ? { csv: `email,job_title\n${contactEmail},Guarded\n`, key: "email", dry_run: true }
        : { csv: `id,amount\n${ids.deal},1300\n`, dry_run: true }),
      "POST /v1/aggregate": (o) => ({ object: o, group_by: [{ field: o === "deal" ? "primary_contact" : "owner" }, { field: "created_at", bucket: "day" }], measures: [{ op: "sum", field: "amount" }].filter(() => o === "deal") }),
      "POST /v1/views": (o) => ({ object: o, name: "Member view", sort: [{ field: "created_at" }] }),
      "PATCH /v1/views/:id": () => ({ name: "Renamed" }),
      "PUT /v1/me/preferences": () => ({ "ui.columns": ["id"] }),
      "POST /v1/automations/:id/run": (o) => (o === "contact" ? { records: [ids.contact] } : { records: [ids.contact], dry_run: true }),
      // Write-side routes: the spare (archived by DELETE above) is restored, then previewed as a duplicate to merge and bulk-changed.
      "POST /v1/objects/:object/duplicates": (o) => (o === "contact" ? { fuzzy: true } : { rules: [["primary_contact"]] }),
      "POST /v1/ops/merge_records": (o) => ({ survivor: records[o].id, duplicates: [records[o].spare] }),
      "POST /v1/objects/:object/records/bulk_update": (o) => (o === "contact" ? { ids: [records[o].id, records[o].spare], values: records[o].patch }
        : { where: { field: "primary_contact", op: "eq", value: ids.contact }, values: { amount: 5 } }),
      "POST /v1/objects/:object/records/bulk_archive": (o) => ({ ids: [records[o].spare] }),
    };
    const extraQuery: Record<string, string> = {
      "GET /v1/search": `?q=${SECRET}`, "GET /v1/events": "?limit=200", "GET /v1/objects/:object/records": "?include_hidden=true&limit=200",
      "GET /v1/objects/:object/records/:id": "?include_hidden=true", "GET /v1/objects/:object": "?include_hidden=true",
      "GET /v1/objects/:object/export": "?include_hidden=true",
    };
    let checked = 0;
    let succeeded = 0;
    for (const route of routes) {
      const key = `${route.method} ${route.path}`;
      for (const o of ["contact", "deal"] as const) {
        const kind = route.idParams ? Object.values(route.idParams)[0] : undefined;
        const id = kind === "record" ? (route.method === "DELETE" || route.path.endsWith("/restore") ? records[o].spare : records[o].id)
          : kind === "notification" ? ntf : kind === "alert" ? alr : kind === "role" ? r.id : kind === "member" ? m.id : kind === "view" ? guardViews[o]
          : kind === "automation" ? runnable.json.automation.id : "x_unknown";
        const path = route.path.replace(":object", o).replace(":field", o === "contact" ? "secret_code" : "deal_secret").replace(":id", id) + (extraQuery[key] ?? "");
        const body = route.method === "GET" || route.method === "DELETE" ? undefined : bodies[key]?.(o) ?? {};
        // Every route twice under one key outruns its bucket now that reads and writes both add costly routes:
        // this loop checks what responses contain, so each call starts with a full bucket.
        resetRateLimiter();
        const res = await call(route.method, path, { key: m.key, body });
        // The write-side routes really ran (restored, previewed and grouped the sentinel-bearing records), rather than failing early.
        if (o === "contact" && ["/restore", "/duplicates", "/merge_records", "/bulk_update", "/bulk_archive"].some((s) => route.path.endsWith(s))) {
          expect(res.status, `${key}: ${JSON.stringify(res.json).slice(0, 300)}`).toBe(200);
        }
        checked++;
        if (res.status < 300) succeeded++;
        for (const v of [SECRET, DEAL_SECRET, ADDR_SECRET, ADDR_SECRET.toLowerCase(), JSON_SECRET, secretAcct.id, ...Object.values(sentinels)]) {
          expect(has(res.json, v), `${route.method} ${path} (${res.status}): ${v}`).toBe(false);
        }
      }
    }
    expect(checked).toBe(routes.length * 2);
    // The ops routes worked for this role: the absence of sentinels isn't just a wall of 403s.
    expect(succeeded).toBeGreaterThan(60);
    // The loop spent most of the key's rate-limit bucket (bulk and duplicate requests count as several): a fresh key for the same member.
    m.key = (await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "after the loop", scopes: OPS, owner: m.id } })).json.data.secret;
    const leaks = (label: string, body: unknown) => {
      for (const v of [SECRET, DEAL_SECRET, secretAcct.id, ...Object.values(sentinels)]) expect(has(body, v), `${label}: ${v}`).toBe(false);
    };
    // Read-side features: includes, counts, aggregates over related records, saved views and the OpenAPI document.
    // A second key of the same member: the route loop above used much of the first key's rate-limit burst.
    const reader = (await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "reads", scopes: OPS, owner: m.id } })).json.data.secret as string;
    for (const [method, path, body] of [
      ["GET", "/v1/objects/lead/records?include=contact,contact.email,account&count=true&limit=200", undefined],
      ["GET", "/v1/objects/activity/records?include=actor_contact&fields=subject,related&limit=200", undefined],
      ["POST", "/v1/query", { object: "deal", include: ["primary_contact", "account", "owner"], count: true, limit: 200 }],
      ["POST", "/v1/aggregate", { object: "lead", group_by: [{ field: "contact" }, { field: "account" }] }],
      ["POST", "/v1/aggregate", { object: "task", group_by: [{ field: "status" }, { field: "assignee" }] }],
      ["POST", "/v1/aggregate", { object: "contact", group_by: [{ field: "account" }] }],
      ["POST", "/v1/query", { view: guardViews.deal }], ["POST", "/v1/aggregate", { view: guardViews.contact }],
      ["GET", `/v1/objects/deal/export?view=${guardViews.deal}`, undefined], ["GET", "/v1/views?object=deal", undefined], ["GET", "/v1/views", undefined],
      ["GET", "/v1/openapi.json", undefined], ["GET", "/v1/users", undefined],
    ] as const) {
      const res = await call(method, path, { key: reader, body });
      expect([200, 403], `${method} ${path}: ${JSON.stringify(res.json).slice(0, 200)}`).toContain(res.status);
      leaks(`${method} ${path}`, res.json);
    }
    expect((await call("POST", "/v1/query", { key: reader, body: { view: guardViews.deal } })).status).toBe(403);
    expect((await call("POST", "/v1/aggregate", { key: reader, body: { object: "contact", group_by: [{ field: "account" }] } })).status).toBe(403);
    expect((await call("POST", "/v1/query", { key: reader, body: { object: "deal", include: ["account.name"] } })).status).toBe(403);
    // Exports of every object the copies land in, in both formats: no hidden column, no hidden value.
    const hiddenColumns: Record<string, string[]> = { contact: ["secret_code", "account"], deal: ["deal_secret", "name"], lead: ["interest"], task: ["title"], activity: ["body"] };
    for (const [o, hidden] of Object.entries(hiddenColumns)) {
      for (const format of ["csv", "ndjson"]) {
        const res = await call("GET", `/v1/objects/${o}/export?format=${format}&include_hidden=true`, { key: m.key });
        expect(res.status, `${o} ${format}`).toBe(200);
        leaks(`${o} export ${format}`, res.json);
        const header = format === "csv" ? String(res.json).split("\r\n")[0]!.split(",") : [];
        for (const h of format === "csv" ? hidden : []) expect(header, `${o}.${h}`).not.toContain(h);
      }
    }
    expect((await call("GET", "/v1/objects/account/export", { key: m.key })).status).toBe(403);
    // Import error paths: hidden columns refused whole; row errors in a dry run and a real run; a failing lookup.
    for (const [o, body] of [
      ["contact", { csv: `email,secret_code,account\n${contactEmail},x,${secretAcct.id}\n`, key: "email" }],
      ["deal", { csv: `id,name\n${ids.deal},x\n` }],
      ["lead", { csv: `id,interest\n${lead.id},x\n` }],
      ["deal", { csv: `id,amount\n${spareDeal.id},notanumber\n${ids.deal},5\n`, dry_run: false }],
      ["deal", { csv: `id,amount\n${spareDeal.id},notanumber\n`, dry_run: true }],
      ["deal", { csv: `id,primary_contact\n${ids.deal},${freeEmail}\n${spareDeal.id},nobody@example.com\n`, mapping: { primary_contact: "primary_contact.email" }, dry_run: false }],
      ["contact", { csv: `id,email\n${ids.contact},${freeEmail}\n${spare.id},not-an-email\n`, dry_run: false }],
    ] as const) {
      // The second key: counts and aggregates cost more than one token each, so the first key's burst is spent by now.
      const res = await call("POST", `/v1/objects/${o}/import`, { key: reader, body });
      expect([200, 403, 422], JSON.stringify(body)).toContain(res.status);
      leaks(`import ${o} ${JSON.stringify(body)}`, res.json);
    }
    // The schema document names hidden fields (names are not data) but holds no values.
    const doc = await call("GET", "/v1/schema/export", { key: m.key });
    expect(doc.json.access.find((a: { object: string }) => a.object === "deal").fields).toMatchObject({ name: "none", deal_secret: "none" });
    leaks("schema export", doc.json);
    // Nothing reached the member's notifications either, now that every event has been processed.
    for (let i = 0; i < 10 && (await processEvents(ws.tenantId)) > 0; i++);
    const box = await call("GET", "/v1/me/notifications?state=all&limit=200", { key: m.key });
    expect(box.json.data.some((x: { title: string }) => x.title.startsWith("Copy "))).toBe(true);
    for (const v of [SECRET, DEAL_SECRET, ...Object.values(sentinels)]) expect(has(box.json, v), v).toBe(false);
    // The owner sees every copy through the same paths, so they exist.
    const ownerTimeline = await call("GET", `/v1/records/${ids.contact}/timeline?limit=200`, { key: ws.keys.ops });
    for (const v of [sentinels.lead, sentinels.task, sentinels.deal, sentinels.activity]) expect(has(ownerTimeline.json, v), v).toBe(true);
    // And the owner still sees both values through the same paths.
    expect(has((await call("GET", `/v1/search?q=${SECRET}`, { key: ws.keys.ops })).json, SECRET)).toBe(true);
    expect((await ownerGet("contact", spare.id)).secret_code).toBe(SECRET);
  });
});
