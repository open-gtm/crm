import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { routes } from "../src/api/registry.js";
import { compileQuery, COUNT_CAP } from "../src/core/query.js";
import { loadSchema } from "../src/core/schema.js";
import { withTenant } from "../src/db/tx.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";

/**
 * Read-side features for lists, boards and saved filters: multi-column sort, counts, aggregates, fields
 * and include, saved views, preferences, the member directory and typed OpenAPI responses. Each is
 * checked against the reader's access as well as for what it returns.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const SECRET = `zq${Date.now().toString(36)}readsentinel`; // deal.deal_secret
const NAME_SECRET = `zq${Date.now().toString(36)}lastnamesentinel`; // contact.last_name, hidden from the limited role
const has = (body: unknown, s: string) => JSON.stringify(body ?? null).includes(s);

let ws: Workspace;
let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;
const deals: { id: string; name: string; amount: number | null }[] = [];
let acct: { id: string };
let contact: { id: string };
/** A role that can't read accounts, deal.deal_secret, deal.amount or contact.last_name. */
let limited: { id: string; key: string };

async function role(permissions: string[], rules: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "Custom", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string };
}
const ALL = ["records:read", "records:write", "records:archive"];
const OPS = ["ops:read", "ops:write"];
const query = (key: string, body: unknown) => call("POST", "/v1/query", { key, body });
const agg = (key: string, body: unknown) => call("POST", "/v1/aggregate", { key, body });

beforeAll(async () => {
  ws = await newWorkspace("Reads");
  for (const [object, body] of [["deal", { api_name: "deal_secret", type: "text" }], ["deal", { api_name: "score", type: "number" }],
    ["deal", { api_name: "tags", type: "multi_select", options: { values: [{ key: "a", label: "A" }] } }],
    ["deal", { api_name: "vault", type: "text", sensitivity: "restricted" }]] as const) {
    const f = await call("POST", `/v1/objects/${object}/fields`, { key: ws.keys.admin, body });
    if (f.status !== 201) throw new Error(`field: ${JSON.stringify(f.json)}`);
  }
  acct = await create(ws.keys.ops, "account", { name: "Acme Reads", domain: `acme-${Date.now()}.example` });
  contact = await create(ws.keys.ops, "contact", { first_name: "Rita", last_name: NAME_SECRET, email: uniqueEmail("rita"), account: acct.id });
  // Names with ties, amounts with ties and nulls, and stages across the pipeline.
  const spec: [string, number | null, string][] = [["Bravo", 300, "Proposal"], ["Alpha", 100, "Qualification"], ["Bravo", null, "Proposal"],
    ["Alpha", 100, "Discovery"], ["Charlie", 50, "Qualification"], ["Bravo", 300, "Negotiation"], ["Alpha", null, "Proposal"]];
  for (const [name, amount, stage] of spec) {
    const d = await create(ws.keys.ops, "deal", { name, amount, stage, primary_contact: contact.id, account: acct.id, deal_secret: SECRET });
    deals.push({ id: d.id, name, amount });
  }
  const r = await role(ALL, {
    objects: { account: { read: false, write: false, archive: false } },
    fields: { deal: { deal_secret: "none", amount: "none" }, contact: { last_name: "none" } },
  });
  limited = await memberWithKey(ws, r.key, OPS);
});

/** Pages through a query to the end, returning the IDs in order. */
async function pageAll(key: string, body: Record<string, unknown>, limit = 2): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await query(key, { ...body, limit, cursor });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    ids.push(...r.json.data.map((x: { id: string }) => x.id));
    cursor = r.json.next_cursor ?? undefined;
    if (!cursor) return ids;
  }
  throw new Error("did not finish");
}

describe("multi-column sort", () => {
  it("pages through several sort keys, nulls last and ties broken by ID, matching one big page", async () => {
    for (const sort of [[{ field: "name", dir: "asc" }, { field: "amount", dir: "desc" }], [{ field: "amount", dir: "asc" }, { field: "name", dir: "desc" }],
      [{ field: "name" }, { field: "amount" }, { field: "created_at", dir: "desc" }]]) {
      const all = (await query(ws.keys.ops, { object: "deal", sort, limit: 200 })).json.data.map((x: { id: string }) => x.id);
      expect(await pageAll(ws.keys.ops, { object: "deal", sort })).toEqual(all);
      expect(await pageAll(ws.keys.ops, { object: "deal", sort }, 1)).toEqual(all);
    }
    const byName = (await query(ws.keys.ops, { object: "deal", sort: [{ field: "name" }, { field: "amount", dir: "desc" }], limit: 200 })).json.data;
    const keyOf = (d: { name: string; amount: number | null }) => `${d.name}:${d.amount ?? "null"}`;
    expect(byName.map(keyOf)).toEqual(["Alpha:100", "Alpha:100", "Alpha:null", "Bravo:300", "Bravo:300", "Bravo:null", "Charlie:50"]);
  });

  it("takes sort=a,-b on lists, and keeps sort=field&dir= working", async () => {
    const viaGet = (await call("GET", "/v1/objects/deal/records?sort=name,-amount&limit=200", { key: ws.keys.ops })).json.data.map((x: { id: string }) => x.id);
    const viaPost = (await query(ws.keys.ops, { object: "deal", sort: [{ field: "name", dir: "asc" }, { field: "amount", dir: "desc" }], limit: 200 })).json.data.map((x: { id: string }) => x.id);
    expect(viaGet).toEqual(viaPost);
    const legacy = (await call("GET", "/v1/objects/deal/records?sort=amount&dir=asc&limit=200", { key: ws.keys.ops })).json.data;
    expect(legacy.map((d: { amount: number | null }) => d.amount)).toEqual([50, 100, 100, 300, 300, null, null]);
  });

  it("never skips or repeats records created within the same millisecond", async () => {
    const all = (await query(ws.keys.ops, { object: "deal", limit: 200 })).json.data.map((x: { id: string }) => x.id);
    expect(await pageAll(ws.keys.ops, { object: "deal" }, 1)).toEqual(all);
    expect(await pageAll(ws.keys.ops, { object: "deal", sort: [{ field: "updated_at", dir: "asc" }] }, 1)).toEqual(
      (await query(ws.keys.ops, { object: "deal", sort: [{ field: "updated_at", dir: "asc" }], limit: 200 })).json.data.map((x: { id: string }) => x.id));
  });

  it("refuses bad sorts, a cursor from another sort, and tampered cursors", async () => {
    for (const sort of [[{ field: "name" }, { field: "amount" }, { field: "score" }, { field: "created_at" }], [{ field: "name" }, { field: "name" }],
      [{ field: "vault" }], [{ field: "tags" }], [{ field: "nope" }], [{ field: "account" }]]) {
      expect((await query(ws.keys.ops, { object: "deal", sort })).status, JSON.stringify(sort)).toBe(422);
    }
    const first = await query(ws.keys.ops, { object: "deal", sort: [{ field: "name" }, { field: "amount" }], limit: 2 });
    const other = await query(ws.keys.ops, { object: "deal", sort: [{ field: "amount" }, { field: "name" }], cursor: first.json.next_cursor });
    expect(other.status).toBe(422);
    expect(other.json.detail).toMatch(/different sort/);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const id = "0190d6c5-7b5a-7c4e-8a3b-1234567890ab";
    for (const cursor of [enc({ s: "name:asc,amount:asc", k: ["x"], id }), enc({ s: "name:asc,amount:asc", k: ["x", "ten"], id }),
      enc({ s: "name:asc,amount:asc", k: ["x", { a: 1 }], id }), enc({ s: "name:asc,amount:asc", k: "x", id }), enc({ s: "name:asc,amount:asc", k: ["x", 1], id: "nope" })]) {
      expect((await query(ws.keys.ops, { object: "deal", sort: [{ field: "name" }, { field: "amount" }], cursor })).status).toBe(422);
    }
    expect((await query(ws.keys.ops, { object: "deal", sort: [{ field: "created_at" }], cursor: enc({ s: "created_at:asc", k: ["2024-02-31"], id }) })).status).toBe(422);
  });

  it("refuses sorting on a field the caller can't read, among others", async () => {
    const r = await query(limited.key, { object: "deal", sort: [{ field: "name" }, { field: "deal_secret" }] });
    expect(r.status).toBe(403);
    expect(has(r.json, SECRET)).toBe(false);
    expect((await call("GET", "/v1/objects/deal/records?sort=name,-amount", { key: limited.key })).status).toBe(403);
  });
});

describe("counts", () => {
  it("counts the matching records under the same filter, the same on every page", async () => {
    const p1 = await query(ws.keys.ops, { object: "deal", where: { field: "name", op: "eq", value: "Bravo" }, count: true, limit: 1 });
    expect(p1.json).toMatchObject({ total: 3, total_capped: false });
    const p2 = await query(ws.keys.ops, { object: "deal", where: { field: "name", op: "eq", value: "Bravo" }, count: true, limit: 1, cursor: p1.json.next_cursor });
    expect(p2.json.total).toBe(3);
    expect((await call("GET", "/v1/objects/deal/records?count=true&filter[name]=Alpha", { key: ws.keys.ops })).json.total).toBe(3);
    expect("total" in (await query(ws.keys.ops, { object: "deal" })).json).toBe(false);
  });

  it("is bounded: the count stops past the cap", async () => {
    const schema = await withTenant(ws.tenantId, (tx) => loadSchema(tx));
    expect(compileQuery(schema, { object: "deal" }).countText).toContain(`LIMIT ${COUNT_CAP + 1}`);
  });

  it("can't count by a field the caller can't read", async () => {
    const r = await query(limited.key, { object: "deal", where: { field: "deal_secret", op: "eq", value: SECRET }, count: true });
    expect(r.status).toBe(403);
  });
});

describe("aggregates", () => {
  it("builds a board: deals by stage, in pipeline order, with count and total amount", async () => {
    const r = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "stage" }], measures: [{ op: "sum", field: "amount" }, { op: "avg", field: "amount" }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.map((g: { group: { stage: { display_name: string } } }) => g.group.stage.display_name)).toEqual(["Qualification", "Discovery", "Proposal", "Negotiation"]);
    const proposal = r.json.data.find((g: { group: { stage: { display_name: string } } }) => g.group.stage.display_name === "Proposal");
    expect(proposal).toMatchObject({ count: 3, values: { sum_amount: 300, avg_amount: 300 }, currency: "USD" });
    expect(proposal.group.stage.id).toMatch(/^stg_/);
    expect(r.json.measures.map((m: { key: string }) => m.key)).toEqual(["count", "sum_amount", "avg_amount"]);
    expect(r.json.truncated).toBe(false);
  });

  it("groups by two fields and date buckets, puts empty keys last, and limits groups", async () => {
    const r = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "name" }, { field: "amount_missing" }] });
    expect(r.status).toBe(422);
    const two = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "name" }, { field: "owner" }], measures: [{ op: "max", field: "amount" }, { op: "count", field: "amount" }] });
    expect(two.status).toBe(200);
    expect(two.json.data.map((g: { group: { name: string } }) => g.group.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(two.json.data[0]).toMatchObject({ count: 3, values: { max_amount: 100, count_amount: 2 } });
    expect(two.json.data[0].group.owner.display_name).toBe("Owner");
    const byMonth = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "created_at", bucket: "month" }, { field: "expected_close_date", bucket: "year" }] });
    expect(byMonth.status).toBe(200);
    expect(byMonth.status).toBe(200);
    expect(byMonth.json.data[0]!.group).toEqual({ created_at: `${new Date().toISOString().slice(0, 7)}-01`, expected_close_date: null });
    const limited1 = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "name" }], limit: 1, order: "count" });
    expect(limited1.json).toMatchObject({ truncated: true });
    expect(limited1.json.data).toHaveLength(1);
    const total = await agg(ws.keys.ops, { object: "deal", where: { field: "name", op: "eq", value: "nobody" }, measures: [{ op: "sum", field: "amount" }, { op: "min", field: "amount" }] });
    expect(total.json.data).toEqual([{ group: {}, count: 0, values: { sum_amount: 0, min_amount: null }, currency: "USD" }]);
  });

  it("refuses shapes it can't bound or answer, with a 422", async () => {
    for (const body of [
      { object: "deal", group_by: [{ field: "amount" }] }, { object: "deal", group_by: [{ field: "tags" }] }, { object: "deal", group_by: [{ field: "vault" }] },
      { object: "deal", group_by: [{ field: "name", bucket: "month" }] }, { object: "deal", group_by: [{ field: "created_at", bucket: "hour" }] },
      { object: "deal", measures: [{ op: "sum", field: "name" }] }, { object: "deal", measures: [{ op: "sum" }] }, { object: "deal", measures: [{ op: "max", field: "vault" }] },
      { object: "deal", group_by: [{ field: "name" }, { field: "owner" }, { field: "stage" }] }, { object: "deal", where: { field: "nope", op: "eq", value: 1 } },
      { object: "user" }, { object: "deal", limit: 0 }, { object: "deal", extra: true },
    ]) {
      const r = await agg(ws.keys.ops, body);
      expect([400, 404, 422], JSON.stringify(body)).toContain(r.status);
    }
  });

  it("never adds up amounts in different currencies", async () => {
    const w = await newWorkspace("Currencies");
    const c = await create(w.keys.ops, "contact", { email: uniqueEmail("cur") });
    const usd = await create(w.keys.ops, "deal", { name: "USD deal", amount: 10, primary_contact: c.id });
    await create(w.keys.ops, "deal", { name: "EUR deal", amount: 20, primary_contact: c.id });
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${w.tenantId}, true)`;
      await tx`UPDATE deals SET currency = 'EUR' WHERE name = 'EUR deal'`;
    });
    const mixed = await agg(w.keys.ops, { object: "deal", measures: [{ op: "sum", field: "amount" }] });
    expect(mixed.status).toBe(422);
    expect(mixed.json.code).toBe("mixed_currencies");
    const byCurrency = await agg(w.keys.ops, { object: "deal", group_by: [{ field: "currency" }], measures: [{ op: "sum", field: "amount" }] });
    expect(byCurrency.json.data).toEqual([
      { group: { currency: "EUR" }, count: 1, values: { sum_amount: 20 }, currency: "EUR" },
      { group: { currency: "USD" }, count: 1, values: { sum_amount: 10 }, currency: "USD" },
    ]);
    expect((await agg(w.keys.ops, { object: "deal", where: { field: "id", op: "eq", value: usd.id }, measures: [{ op: "sum", field: "amount" }] })).json.data[0].currency).toBe("USD");
    expect((await agg(w.keys.ops, { object: "deal" })).status).toBe(200); // counting alone mixes nothing
    // A role that can't read the currency can count deals but not total their amounts.
    const blind = await call("POST", "/v1/roles", { key: w.keys.admin, body: { key: "no_currency", name: "x", permissions: ALL, fields: { deal: { currency: "none" } } } });
    expect(blind.status).toBe(201);
    const m = await memberWithKey(w, "no_currency", OPS);
    expect((await agg(m.key, { object: "deal", measures: [{ op: "sum", field: "amount" }] })).status).toBe(403);
    expect((await agg(m.key, { object: "deal" })).json.data[0].count).toBe(2);
  });

  it("refuses grouping, measuring or filtering on what the caller can't read, and names related records only as the caller sees them", async () => {
    for (const body of [
      { object: "deal", group_by: [{ field: "deal_secret" }] }, { object: "deal", measures: [{ op: "sum", field: "amount" }] },
      { object: "deal", measures: [{ op: "min", field: "amount" }] }, { object: "deal", measures: [{ op: "count", field: "deal_secret" }] },
      { object: "deal", where: { field: "deal_secret", op: "eq", value: SECRET } }, { object: "deal", where: { path: ["account", "name"], op: "eq", value: "Acme Reads" } },
      { object: "deal", where: { path: ["primary_contact", "last_name"], op: "starts_with", value: "zq" } }, { object: "account" },
    ]) {
      const r = await agg(limited.key, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(has(r.json, SECRET) || has(r.json, NAME_SECRET)).toBe(false);
    }
    const byAccount = await agg(limited.key, { object: "deal", group_by: [{ field: "account" }, { field: "primary_contact" }] });
    expect(byAccount.status).toBe(200);
    expect(byAccount.json.data[0].group.account).toEqual({ id: acct.id, display_name: null }); // accounts are unreadable: the ID only
    expect(byAccount.json.data[0].group.primary_contact.display_name).toBe("Rita"); // built without the hidden last name
    expect(has(byAccount.json, NAME_SECRET)).toBe(false);
    const owner = await agg(ws.keys.ops, { object: "deal", group_by: [{ field: "primary_contact" }] });
    expect(owner.json.data[0].group.primary_contact.display_name).toBe(`Rita ${NAME_SECRET}`);
  });
});

describe("fields and include", () => {
  it("returns only the fields asked for, plus id, object and version", async () => {
    const r = await call("GET", "/v1/objects/deal/records?fields=name,amount&limit=1", { key: ws.keys.ops });
    expect(Object.keys(r.json.data[0]).sort()).toEqual(["amount", "id", "name", "object", "version"]);
    const q = await query(ws.keys.ops, { object: "deal", fields: ["display_name", "stage"], limit: 1 });
    expect(Object.keys(q.json.data[0]).sort()).toEqual(["display_name", "id", "object", "stage", "version"]);
    const one = await call("GET", `/v1/objects/deal/records/${deals[0]!.id}?fields=name`, { key: ws.keys.ops });
    expect(Object.keys(one.json.data).sort()).toEqual(["id", "name", "object", "version"]);
    expect((await call("GET", "/v1/objects/deal/records?fields=nope", { key: ws.keys.ops })).status).toBe(422);
    expect((await call("GET", "/v1/objects/deal/records?fields=deal_secret", { key: limited.key })).status).toBe(403);
  });

  it("inlines many-to-one relations, as the reader may see them, without a query per record", async () => {
    const r = await call("GET", "/v1/objects/deal/records?include=account,account.domain,primary_contact.email,owner,stage&fields=name&limit=200", { key: ws.keys.ops });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const d = r.json.data[0];
    expect(d.included.account).toMatchObject({ id: acct.id, object: "account", display_name: "Acme Reads" });
    expect(d.included.account.domain).toMatch(/^acme-/);
    expect(d.included.primary_contact).toMatchObject({ id: contact.id, display_name: `Rita ${NAME_SECRET}` });
    expect(d.included.owner).toMatchObject({ object: "user", display_name: "Owner" });
    expect(d.included.stage.display_name).toBeTruthy();
    expect("account" in d).toBe(false); // fields still limit the record itself
    const any = await call("GET", `/v1/records/${deals[0]!.id}?include=primary_contact`, { key: ws.keys.ops });
    expect(any.json.data.included.primary_contact.id).toBe(contact.id);
    const none = await create(ws.keys.ops, "contact", { email: uniqueEmail("solo") });
    expect((await call("GET", `/v1/objects/contact/records/${none.id}?include=account`, { key: ws.keys.ops })).json.data.included).toEqual({ account: null });
  });

  it("shows a related record on an unreadable object as its ID, and refuses fields the reader can't read", async () => {
    const r = await query(limited.key, { object: "deal", include: ["account", "primary_contact"], limit: 1 });
    expect(r.status).toBe(200);
    expect(r.json.data[0].included.account).toEqual({ id: acct.id, object: "account", display_name: null });
    expect(r.json.data[0].included.primary_contact.display_name).toBe("Rita");
    expect(has(r.json, NAME_SECRET) || has(r.json, SECRET)).toBe(false);
    for (const include of [["account.name"], ["primary_contact.last_name"], ["tags"], ["name"], ["nope"], ["a", "b", "c", "d"].map(() => "x"),
      ["account", "primary_contact", "owner", "stage", "pipeline", "deal_secret"]]) {
      const res = await query(limited.key, { object: "deal", include });
      expect([403, 422], JSON.stringify(include)).toContain(res.status);
      expect(has(res.json, NAME_SECRET)).toBe(false);
    }
    expect((await query(limited.key, { object: "deal", include: ["account.name"] })).status).toBe(403);
  });
});

describe("saved views", () => {
  let member: { id: string; key: string };
  let shared: string;
  beforeAll(async () => {
    member = await memberWithKey(ws, "member", OPS);
    const v = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Big Bravos", shared: true,
      where: { field: "name", op: "eq", value: "Bravo" }, sort: [{ field: "amount", dir: "desc" }], columns: ["name", "amount", "stage"], group_by: [{ field: "stage" }] } });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    shared = v.json.data.id;
  });

  it("runs on lists, queries, aggregates and exports, with request parameters overriding", async () => {
    const list = await call("GET", `/v1/objects/deal/records?view=${shared}`, { key: member.key });
    expect(list.status).toBe(200);
    expect(list.json.data.map((d: { amount: number | null }) => d.amount)).toEqual([300, 300, null]);
    expect(Object.keys(list.json.data[0]).sort()).toEqual(["amount", "id", "name", "object", "stage", "version"]);
    const q = await query(member.key, { view: shared, sort: [{ field: "amount", dir: "asc" }], fields: ["name"] });
    expect(q.json.data.map((d: { name: string }) => d.name)).toEqual(["Bravo", "Bravo", "Bravo"]);
    expect(Object.keys(q.json.data[0]).sort()).toEqual(["id", "name", "object", "version"]);
    const over = await query(member.key, { object: "deal", view: shared, where: { field: "name", op: "eq", value: "Alpha" }, count: true });
    expect(over.json.total).toBe(3);
    const a = await agg(member.key, { view: shared, measures: [{ op: "sum", field: "amount" }] });
    expect(a.json.data.map((g: { count: number }) => g.count)).toEqual([2, 1]);
    const exp = await call("GET", `/v1/objects/deal/export?view=${shared}`, { key: member.key });
    expect(exp.status).toBe(200);
    expect(String(exp.json).trim().split("\r\n")).toHaveLength(4);
    expect((await query(member.key, { object: "contact", view: shared })).status).toBe(422);
    expect((await query(member.key, { view: "vw_nope" })).status).toBe(404);
  });

  it("keeps personal views to their owner; shared views need views:manage to create or change", async () => {
    const mine = await call("POST", "/v1/views", { key: member.key, body: { object: "deal", name: "Mine", where: { field: "name", op: "eq", value: "Alpha" } } });
    expect(mine.status).toBe(201);
    expect(mine.json.data).toMatchObject({ shared: false, mine: true, status: "ok", owner: member.id });
    expect((await call("GET", `/v1/views/${mine.json.data.id}`, { key: ws.keys.ops })).status).toBe(404);
    expect((await call("GET", `/v1/objects/deal/records?view=${mine.json.data.id}`, { key: ws.keys.ops })).status).toBe(404);
    const listed = (await call("GET", "/v1/objects/deal/views", { key: member.key })).json.data.map((v: { id: string }) => v.id);
    expect(listed).toEqual(expect.arrayContaining([mine.json.data.id, shared]));
    expect((await call("GET", "/v1/views", { key: ws.keys.ops })).json.data.map((v: { id: string }) => v.id)).not.toContain(mine.json.data.id);
    for (const [method, path, body] of [["POST", "/v1/views", { object: "deal", name: "x", shared: true }], ["PATCH", `/v1/views/${shared}`, { name: "x" }],
      ["DELETE", `/v1/views/${shared}`, undefined], ["PATCH", `/v1/views/${mine.json.data.id}`, { shared: true }]] as const) {
      const r = await call(method, path, { key: member.key, body });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.detail).toMatch(/views:manage/);
    }
    expect((await call("PATCH", `/v1/views/${mine.json.data.id}`, { key: ws.keys.ops, body: { name: "stolen" } })).status).toBe(404);
    const stale = await call("PATCH", `/v1/views/${mine.json.data.id}`, { key: member.key, body: { name: "Mine 2" }, headers: { "If-Match": '"v9"' } });
    expect(stale.status).toBe(412);
    const renamed = await call("PATCH", `/v1/views/${mine.json.data.id}`, { key: member.key, body: { name: "Mine 2", where: null }, headers: { "If-Match": '"v1"' } });
    expect(renamed.json.data).toMatchObject({ name: "Mine 2", where: null, version: 2 });
    expect((await call("DELETE", `/v1/views/${mine.json.data.id}`, { key: member.key })).status).toBe(200);
    expect((await call("GET", `/v1/views/${mine.json.data.id}`, { key: member.key })).status).toBe(404);
  });

  it("validates a view when it is saved", async () => {
    for (const body of [
      { object: "deal", name: "x", where: { field: "nope", op: "eq", value: 1 } }, { object: "deal", name: "x", sort: [{ field: "tags" }] },
      { object: "deal", name: "x", columns: ["nope"] }, { object: "deal", name: "x", group_by: [{ field: "amount" }] }, { object: "deal", name: "" },
      { object: "deal", name: "x".repeat(101) }, { object: "nope", name: "x" }, { object: "deal", name: "x", where: { field: "vault", op: "eq", value: "a" } },
    ]) {
      const r = await call("POST", "/v1/views", { key: ws.keys.ops, body });
      expect([404, 422], JSON.stringify(body)).toContain(r.status);
    }
    expect((await call("POST", "/v1/views", { key: limited.key, body: { object: "deal", name: "x", columns: ["deal_secret"] } })).status).toBe(403);
    expect((await call("POST", "/v1/views", { key: limited.key, body: { object: "account", name: "x" } })).status).toBe(403);
  });

  it("is not a grant: a shared view on something the reader can't read is refused for them, and its definition withheld", async () => {
    const secretView = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Secret filter", shared: true,
      where: { field: "deal_secret", op: "eq", value: SECRET } } });
    const sortView = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "By amount", shared: true, sort: [{ field: "amount" }] } });
    const colsView = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Columns", shared: true, columns: ["name", "deal_secret", "amount"] } });
    const acctView = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "account", name: "Accounts", shared: true } });
    for (const v of [secretView, sortView, colsView, acctView]) expect(v.status).toBe(201);
    const listing = await call("GET", "/v1/views", { key: limited.key });
    expect(has(listing.json, SECRET)).toBe(false);
    const byId = Object.fromEntries(listing.json.data.map((v: { id: string }) => [v.id, v]));
    expect(byId[secretView.json.data.id]).toMatchObject({ status: "unavailable" });
    expect("where" in byId[secretView.json.data.id]).toBe(false);
    expect(byId[sortView.json.data.id]).toMatchObject({ status: "unavailable" });
    expect(byId[colsView.json.data.id]).toMatchObject({ status: "ok", columns: ["name"] });
    expect(byId[acctView.json.data.id]).toBeUndefined(); // a view of an object the reader can't read isn't listed
    for (const [method, path, body] of [["GET", `/v1/objects/deal/records?view=${secretView.json.data.id}`, undefined],
      ["POST", "/v1/query", { view: secretView.json.data.id }], ["POST", "/v1/aggregate", { view: sortView.json.data.id }],
      ["GET", `/v1/objects/deal/export?view=${secretView.json.data.id}`, undefined], ["GET", `/v1/views/${secretView.json.data.id}`, undefined]] as const) {
      const r = await call(method, path, { key: limited.key, body });
      expect(r.status === 403 || (path.startsWith("/v1/views/") && r.status === 200), `${method} ${path}`).toBe(true);
      expect(has(r.json, SECRET), path).toBe(false);
    }
    expect((await call("GET", `/v1/views/${acctView.json.data.id}`, { key: limited.key })).status).toBe(404);
    const cols = await call("GET", `/v1/objects/deal/records?view=${colsView.json.data.id}&limit=200`, { key: limited.key });
    expect(cols.status).toBe(200);
    expect(Object.keys(cols.json.data[0]).sort()).toEqual(["id", "name", "object", "version"]);
    // Unavailable is decided by the definition and the reader's access alone: the same answer whether or not any record matches.
    const nothing = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "No match", shared: true, where: { field: "deal_secret", op: "eq", value: "absent" } } });
    expect((await query(limited.key, { view: nothing.json.data.id })).json.detail).toBe(
      (await query(limited.key, { view: secretView.json.data.id })).json.detail.replace(secretView.json.data.id, nothing.json.data.id));
    // The admin who wrote it sees it whole.
    expect((await call("GET", `/v1/views/${secretView.json.data.id}`, { key: ws.keys.ops })).json.data.where.value).toBe(SECRET);
  });

  it("fails clearly, never with a 500, when a field it uses is renamed or archived, or its object goes away", async () => {
    const f = await call("POST", "/v1/objects/deal/fields", { key: ws.keys.admin, body: { api_name: "region", type: "single_select", options: { values: [{ key: "eu", label: "EU" }] } } });
    expect(f.status).toBe(201);
    const v = await call("POST", "/v1/views", { key: member.key, body: { object: "deal", name: "EU", where: { field: "region", op: "eq", value: "eu" }, columns: ["region"] } });
    expect(v.status).toBe(201);
    expect((await call("PATCH", "/v1/objects/deal/fields/region", { key: ws.keys.admin, body: { api_name: "territory" } })).status).toBe(200);
    const run = await call("GET", `/v1/objects/deal/records?view=${v.json.data.id}`, { key: member.key });
    expect(run.status).toBe(422);
    expect(run.json.code).toBe("view_invalid");
    expect((await call("GET", `/v1/views/${v.json.data.id}`, { key: member.key })).json.data.status).toBe("broken");
    const g = await call("POST", "/v1/views", { key: member.key, body: { object: "deal", name: "By territory", group_by: [{ field: "territory" }] } });
    const dry = await call("POST", "/v1/objects/deal/fields/territory/archive", { key: ws.keys.admin, body: { dry_run: true } });
    expect((await call("POST", "/v1/objects/deal/fields/territory/archive", { key: ws.keys.admin, body: { dry_run: false, confirm_token: dry.json.confirm_token } })).status).toBe(200);
    expect((await agg(member.key, { view: g.json.data.id })).json.code).toBe("view_invalid");
    // An object whose module is turned off.
    const w = await newWorkspace("Views module");
    const dv = await call("POST", "/v1/views", { key: w.keys.ops, body: { object: "deal", name: "Deals" } });
    expect(dv.status).toBe(201);
    expect((await call("PATCH", "/v1/workspace/modules", { key: w.keys.admin, body: { modules: ["core"] } })).status).toBe(200);
    const off = await query(w.keys.ops, { view: dv.json.data.id });
    expect(off.status).toBe(422);
    expect(off.json.code).toBe("view_invalid");
    expect((await call("GET", "/v1/views", { key: w.keys.ops })).json.data[0]).toMatchObject({ status: "broken", object: null });
    expect((await call("DELETE", `/v1/views/${dv.json.data.id}`, { key: w.keys.ops })).status).toBe(200);
  });
});

describe("preferences", () => {
  it("keeps each member's own small JSON values under validated keys", async () => {
    const m = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await call("GET", "/v1/me/preferences", { key: m.key })).json.data).toEqual({});
    const set = await call("PUT", "/v1/me/preferences", { key: m.key, body: { "deals.columns": ["name", "amount"], "ui:theme": "dark", "last.view": null } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.data).toEqual({ "deals.columns": ["name", "amount"], "ui:theme": "dark" });
    expect((await call("PUT", "/v1/me/preferences", { key: m.key, body: { "ui:theme": null } })).json.data).toEqual({ "deals.columns": ["name", "amount"] });
    expect((await call("GET", "/v1/me/preferences", { key: ws.keys.ops })).json.data).toEqual({});
    for (const body of [{ "Bad Key": 1 }, { "1abc": 1 }, { ["k".repeat(65)]: 1 }, { big: "x".repeat(9_000) }, { token: `hlcrm_live_${"a".repeat(30)}` },
      Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i]))]) {
      expect((await call("PUT", "/v1/me/preferences", { key: m.key, body })).status).toBe(422);
    }
    // The key count is capped across requests too.
    for (let i = 0; i < 2; i++) {
      const r = await call("PUT", "/v1/me/preferences", { key: m.key, body: Object.fromEntries(Array.from({ length: 60 }, (_, j) => [`p${i}_${j}`, j])) });
      expect(r.status).toBe(i === 0 ? 200 : 422);
    }
    expect(Object.keys((await call("GET", "/v1/me/preferences", { key: m.key })).json.data)).toHaveLength(61);
  });
});

describe("member directory", () => {
  it("lists active users' id, name and email to callers who can read a field that refers to users", async () => {
    const off = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("gone"), name: "Gone Person", role: "member" } });
    await call("PATCH", `/v1/members/${off.json.data.id}`, { key: ws.keys.admin, body: { active: false } });
    const r = await call("GET", "/v1/users?limit=500", { key: limited.key });
    expect(r.status).toBe(200);
    const ids = r.json.data.map((u: { id: string }) => u.id);
    expect(ids).toContain(ws.ownerId);
    expect(ids).not.toContain(off.json.data.id);
    expect(Object.keys(r.json.data[0]).sort()).toEqual(["email", "id", "name"]);
    const owner = await call("GET", "/v1/users?q=own", { key: ws.keys.ops });
    expect(owner.json.data.map((u: { name: string }) => u.name)).toContain("Owner");
    const page = await call("GET", "/v1/users?limit=1", { key: ws.keys.ops });
    const next = await call("GET", `/v1/users?limit=1&cursor=${page.json.next_cursor}`, { key: ws.keys.ops });
    expect(next.json.data[0].id).not.toBe(page.json.data[0].id);
    expect((await call("GET", "/v1/users?cursor=bogus", { key: ws.keys.ops })).status).toBe(422);
  });

  it("is refused to a role that can't read any field referring to users, and describe stops listing users for it too", async () => {
    const userFields: Record<string, Record<string, string>> = {};
    const schema = await withTenant(ws.tenantId, (tx) => loadSchema(tx));
    for (const o of schema.objects.values()) {
      for (const f of o.fields) if (f.type === "relation" && f.options.to === "user") (userFields[o.api_name] ??= {})[f.api_name] = "none";
    }
    const r = await role(ALL, { fields: userFields });
    const m = await memberWithKey(ws, r.key, OPS);
    expect((await call("GET", "/v1/users", { key: m.key })).status).toBe(403);
    expect("users" in (await call("GET", "/v1/objects/contact", { key: m.key })).json.data).toBe(false);
    expect((await call("GET", "/v1/objects/contact", { key: ws.keys.ops })).json.data.users.length).toBeGreaterThan(0);
  });
});

describe("tables", () => {
  it("views and preferences are tenant-scoped with forced RLS", async () => {
    const other = await newWorkspace("Reads other");
    const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        return fn(tx);
      }) as Promise<T>;
    const [mine] = await inTenant(ws.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM views`);
    expect(mine!.n).toBeGreaterThan(0);
    expect((await inTenant(other.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM views`))[0]!.n).toBe(0);
    expect((await inTenant(other.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM member_preferences WHERE tenant_id = ${ws.tenantId}`))[0]!.n).toBe(0);
    const [obj] = await inTenant(ws.tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM objects WHERE api_name = 'deal'`);
    await expect(inTenant(other.tenantId, (tx) => tx`INSERT INTO views (tenant_id, id, object_id, name, shared, definition)
      VALUES (${ws.tenantId}, gen_random_uuid(), ${obj!.id}, 'x', true, '{}')`)).rejects.toThrow(/row-level security/);
    await expect(inTenant(other.tenantId, (tx) => tx`INSERT INTO member_preferences (tenant_id, member_type, member_id, key, value)
      VALUES (${ws.tenantId}, 'user', gen_random_uuid(), 'k', '1')`)).rejects.toThrow(/row-level security/);
    await expect(inTenant(other.tenantId, (tx) => tx`INSERT INTO views (tenant_id, id, object_id, name, shared, definition)
      VALUES (${other.tenantId}, gen_random_uuid(), ${obj!.id}, 'x', true, '{}')`)).rejects.toThrow(/foreign key/);
  });

  it("system owner and admin roles hold views:manage; member and read_only don't", async () => {
    const roles = (await call("GET", "/v1/roles", { key: ws.keys.admin })).json.data as { key: string; permissions: string[] }[];
    const of = (k: string) => roles.find((r) => r.key === k)!.permissions;
    expect(of("owner")).toContain("views:manage");
    expect(of("admin")).toContain("views:manage");
    expect(of("member")).not.toContain("views:manage");
    expect(of("read_only")).not.toContain("views:manage");
    const custom = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("vm"), name: "Curator", permissions: ["records:read", "views:manage"] } });
    expect(custom.status).toBe(201);
    const c = await memberWithKey(ws, custom.json.data.key, ["ops:write"]);
    expect((await call("POST", "/v1/views", { key: c.key, body: { object: "deal", name: "Curated", shared: true } })).status).toBe(201);
    const readOnlyKey = await memberWithKey(ws, custom.json.data.key, ["ops:read"]);
    expect((await call("POST", "/v1/views", { key: readOnlyKey.key, body: { object: "deal", name: "Curated", shared: true } })).status).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------
// Typed OpenAPI responses

describe("typed OpenAPI responses", () => {
  it("every route declares its response", () => {
    expect(routes.filter((r) => !r.response).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it("documents responses, problems and one record schema per object", async () => {
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.ops })).json;
    const op = doc.paths["/v1/objects/{object}/records"].get;
    expect(op.responses["200"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/RecordPage" });
    expect(op.responses.default.content["application/problem+json"].schema).toEqual({ $ref: "#/components/schemas/Problem" });
    expect(doc.components.schemas.Record.oneOf).toContainEqual({ $ref: "#/components/schemas/deal_record" });
    expect(doc.components.schemas.deal_record.properties.object).toEqual({ type: "string", const: "deal" });
    expect(doc.paths["/v1/objects/{object}/fields"].post.responses).toHaveProperty("201");
    const pub = (await (await import("./helpers.js")).app.request("/openapi.json")).json() as Promise<Schema>;
    expect(((await pub).components as { schemas: Schema }).schemas).toHaveProperty("Record.properties.id");
  });

  it("real responses of the main record routes match what they declare", async () => {
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.ops })).json as Schema;
    const view = (await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Doc", sort: [{ field: "name" }] } })).json.data.id;
    const samples: [string, string, string, unknown, number][] = [
      ["GET", "/v1/objects/{object}/records", "/v1/objects/deal/records?count=true&include=account,owner&limit=3", undefined, 200],
      ["GET", "/v1/objects/{object}/records", "/v1/objects/contact/records?fields=email&limit=3", undefined, 200],
      ["POST", "/v1/query", "/v1/query", { object: "deal", sort: [{ field: "name" }, { field: "amount", dir: "desc" }], limit: 2, count: true }, 200],
      ["GET", "/v1/objects/{object}/records/{id}", `/v1/objects/deal/records/${deals[0]!.id}`, undefined, 200],
      ["GET", "/v1/records/{id}", `/v1/records/${contact.id}`, undefined, 200],
      ["POST", "/v1/objects/{object}/records", "/v1/objects/contact/records", { email: uniqueEmail("doc") }, 201],
      ["PATCH", "/v1/objects/{object}/records/{id}", `/v1/objects/deal/records/${deals[1]!.id}`, { score: 3 }, 200],
      ["GET", "/v1/search", "/v1/search?q=Acme", undefined, 200],
      ["POST", "/v1/aggregate", "/v1/aggregate", { object: "deal", group_by: [{ field: "stage" }], measures: [{ op: "sum", field: "amount" }] }, 200],
      ["GET", "/v1/views", "/v1/views", undefined, 200],
      ["GET", "/v1/views/{id}", `/v1/views/${view}`, undefined, 200],
      ["GET", "/v1/users", "/v1/users", undefined, 200],
      ["GET", "/v1/me/preferences", "/v1/me/preferences", undefined, 200],
      ["POST", "/v1/query", "/v1/query", { object: "nope" }, 404],
    ];
    for (const [method, template, path, body, status] of samples) {
      const res = await call(method, path, { key: ws.keys.ops, body });
      expect(res.status, path).toBe(status);
      const responses = (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method.toLowerCase()]!.responses;
      const declared = status < 400 ? responses[String(status)]!.content["application/json"]!.schema : responses.default!.content["application/problem+json"]!.schema;
      expect(validate(doc, declared, res.json), `${method} ${path}`).toEqual([]);
    }
    // The checker itself catches drift.
    expect(validate(doc, { $ref: "#/components/schemas/RecordPage" }, { data: [{ id: 1 }] }).length).toBeGreaterThan(0);
  });

  it("real responses of the timeline, schema history and administration routes match what they declare", async () => {
    const w = await newWorkspace("Typed admin");
    const doc = (await call("GET", "/v1/openapi.json", { key: w.keys.admin })).json as Schema;
    const declared = (template: string, method: string, status: number) =>
      (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method.toLowerCase()]!
        .responses[String(status)]!.content["application/json"]!.schema;
    const check = async (method: string, template: string, path: string, body: unknown, status: number, key = w.keys.admin) => {
      const res = await call(method, path, { key, body });
      expect(res.status, `${method} ${path} ${JSON.stringify(res.json)}`).toBe(status);
      expect(validate(doc, declared(template, method, status), res.json), `${method} ${path}`).toEqual([]);
      return res.json;
    };

    // A deal with an activity, a task and a stage change; a schema change.
    const c = await create(w.keys.ops, "contact", { email: uniqueEmail("tl") });
    const deal = await create(w.keys.ops, "deal", { name: "Timeline", primary_contact: c.id });
    await call("POST", "/v1/ops/log_activity", { key: w.keys.ops, body: { type: "note", subject: "Hello", related_to: [deal.id] } });
    await create(w.keys.ops, "task", { title: "Follow up", related_to: [deal.id] });
    await call("POST", "/v1/ops/move_deal_stage", { key: w.keys.ops, body: { deal: deal.id, stage: "Closed won" } });
    const tl = (await check("GET", "/v1/records/{id}/timeline", `/v1/records/${deal.id}/timeline`, undefined, 200, w.keys.ops)).data;
    expect(new Set(tl.items.map((i: { kind: string }) => i.kind))).toEqual(new Set(["activity", "stage_change", "task"]));
    expect((await call("POST", "/v1/objects/deal/fields", { key: w.keys.admin, body: { api_name: "region", type: "text" } })).status).toBe(201);
    expect((await check("GET", "/v1/schema/changes", "/v1/schema/changes", undefined, 200)).data.length).toBeGreaterThan(0);
    await check("GET", "/v1/me/access", "/v1/me/access", undefined, 200, w.keys.ops);

    // Members and service accounts.
    const m = (await check("POST", "/v1/members", "/v1/members", { email: uniqueEmail("typed"), name: "Typed", role: "member" }, 201)).data;
    expect((await call("POST", "/v1/api-keys", { key: w.keys.admin, body: { name: "member key", scopes: ["ops:read"], owner: m.id } })).status).toBe(201);
    expect((await check("PATCH", "/v1/members/{id}", `/v1/members/${m.id}`, { active: false }, 200)).data.keys_revoked).toBe(1);
    await check("PATCH", "/v1/members/{id}", `/v1/members/${m.id}`, { active: true }, 200);
    const sa = (await check("POST", "/v1/service-accounts", "/v1/service-accounts", { name: slug("bot"), role: "member" }, 201)).data;
    await check("PATCH", "/v1/service-accounts/{id}", `/v1/service-accounts/${sa.id}`, { role: "read_only" }, 200);
    const members = (await check("GET", "/v1/members", "/v1/members", undefined, 200)).data;
    expect([members.users.length, members.service_accounts.length]).toEqual([2, 1]);
    const review = (await check("GET", "/v1/access-review", "/v1/access-review", undefined, 200)).data;
    expect(review.members.some((x: { keys: unknown[] }) => x.keys.length > 0)).toBe(true);

    // Roles and permissions.
    await check("GET", "/v1/permissions", "/v1/permissions", undefined, 200);
    const role = (await check("POST", "/v1/roles", "/v1/roles", { key: slug("typed"), name: "Typed", permissions: ["records:read"],
      objects: { deal: { write: false } }, fields: { contact: { email: "none" } } }, 201)).data;
    await check("GET", "/v1/roles", "/v1/roles?include_archived=true", undefined, 200);
    await check("GET", "/v1/roles/{id}", `/v1/roles/${role.key}`, undefined, 200);
    expect((await check("GET", "/v1/roles/{id}/access", `/v1/roles/${role.id}/access`, undefined, 200)).data.objects.length).toBeGreaterThan(0);
    await check("PATCH", "/v1/roles/{id}", `/v1/roles/${role.id}`, { description: "Changed" }, 200);
    await check("DELETE", "/v1/roles/{id}", `/v1/roles/${role.id}`, undefined, 200);

    // API keys and the audit log.
    const keys = (await check("GET", "/v1/api-keys", "/v1/api-keys", undefined, 200)).data as { id: string; revoked_at: string | null; scopes: string[] }[];
    const k = keys.find((x) => !x.revoked_at && x.scopes.includes("ops:read") && !x.scopes.includes("admin"))!;
    const rotated = (await check("POST", "/v1/api-keys/{id}/rotate", `/v1/api-keys/${k.id}/rotate`, { overlap_hours: 1 }, 200)).data;
    await check("POST", "/v1/api-keys/{id}/revoke", `/v1/api-keys/${rotated.id}/revoke`, undefined, 200);
    expect((await check("GET", "/v1/audit/verify", "/v1/audit/verify", undefined, 200)).data.ok).toBe(true);
  });
});
