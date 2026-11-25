import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeId } from "../src/lib/ids.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Quotes and orders (docs/data-model.md §5.4, ADR 0014), through real HTTP calls: a quote is made for a
 * deal, priced by its lines, sent (then fixed), and accepted, which makes the order.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

let ws: Workspace;
const inTenant = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
  return fn(tx);
});
const op = (name: string, body: Record<string, unknown>, key = ws.keys.ops) => call("POST", `/v1/ops/${name}`, { key, body });
const get = async (object: string, id: string, key = ws.keys.ops) => (await call("GET", `/v1/objects/${object}/records/${id}`, { key })).json.data;
const listOf = async (object: string, where: unknown) => (await call("POST", "/v1/query", { key: ws.keys.ops, body: { object, where, sort: [{ field: "position" }] } })).json.data as Record<string, unknown>[];

/** An account, a contact and an open deal for them. */
async function deal(name = "Fleet renewal") {
  const account = await create(ws.keys.ops, "account", { name: `Acme ${Math.random().toString(36).slice(2, 7)}`, domain: `acme-${Math.random().toString(36).slice(2, 9)}.example` });
  const contact = await create(ws.keys.ops, "contact", { first_name: "Dana", last_name: "Buyer", email: uniqueEmail("dana"), account: account.id });
  const d = await create(ws.keys.ops, "deal", { name, primary_contact: contact.id, account: account.id, amount: 100 });
  return { account, contact, deal: d };
}

interface Line { description: string; quantity?: number; unit_price: number; discount?: number; tax?: number }
const LINES: Line[] = [
  { description: "Seats", quantity: 12, unit_price: 49.5 },
  { description: "Onboarding", unit_price: 800, discount: 100, tax: 140 },
  { description: "Support hours", quantity: 2.5, unit_price: 120.01 },
];

async function quoteFor(dealId: string, lines: Line[] = LINES) {
  const r = await op("create_quote", { deal: dealId, lines });
  if (r.status !== 200) throw new Error(`create_quote: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.result.quote as Record<string, unknown> & { id: string; number: string };
}

beforeAll(async () => {
  ws = await newWorkspace("Commerce");
});

describe("quotes: made for a deal, priced by their lines", () => {
  it("a new workspace has the commerce module and its four objects", async () => {
    const schema = (await call("GET", "/v1/schema", { key: ws.keys.ops })).json;
    expect(JSON.stringify(schema)).toContain("commerce");
    for (const o of ["quote", "quote_line_item", "order", "order_line_item"]) {
      const d = await call("GET", `/v1/objects/${o}`, { key: ws.keys.ops });
      expect(d.status, o).toBe(200);
    }
    const quote = (await call("GET", "/v1/objects/quote", { key: ws.keys.ops })).json.data;
    const status = quote.fields.find((f: { name: string }) => f.name === "status");
    expect(status.values.map((v: { key: string }) => v.key)).toEqual(["draft", "sent", "accepted", "rejected", "expired", "superseded"]);
    expect((await call("GET", "/v1/commerce-settings", { key: ws.keys.ops })).json.data).toEqual({ quote_requires_deal: true, accept_quote_marks_deal_won: true });
  });

  it("takes its customer and name from the deal, gets a number, and adds its lines up", async () => {
    const d = await deal("Fleet renewal 2027");
    const dry = await op("create_quote", { deal: d.deal.id, lines: LINES, dry_run: true });
    expect(dry.json).toMatchObject({ dry_run: true, result: null });
    const made = await op("create_quote", { deal: d.deal.id, valid_until: "2099-01-31", terms: "Net 30", lines: LINES });
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    const q = made.json.result.quote;
    expect(q).toMatchObject({ name: "Fleet renewal 2027", deal: d.deal.id, account: d.account.id, contact: d.contact.id, status: "draft", revision: 1,
      currency: "USD", valid_until: "2099-01-31", terms: "Net 30" });
    expect(q.id).toMatch(/^quote_/);
    expect(q.number).toMatch(/^Q-\d{4}$/);
    // 12 × 49.50 = 594.00; 800.00; 2.5 × 120.01 = 300.025, rounded to 300.03.
    expect(q).toMatchObject({ subtotal: 1694.03, discount: 100, tax: 140, total: 1734.03 });
    const lines = made.json.result.lines as Record<string, unknown>[];
    expect(lines.map((l) => [l.description, l.quantity, l.line_total, l.position])).toEqual([["Seats", 12, 594, 1], ["Onboarding", 1, 840, 2], ["Support hours", 2.5, 300.03, 3]]);
    expect(lines[0]!.id).toMatch(/^qli_/);
    // The next quote takes the next number.
    const next = await quoteFor(d.deal.id, []);
    expect(Number(next.number.slice(2))).toBe(Number(q.number.slice(2)) + 1);
    expect(next).toMatchObject({ subtotal: 0, total: 0 });
  });

  it("lines can be added, changed and removed while it is a draft, and the quote's amounts follow", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Licence", quantity: 2, unit_price: 100 }]);
    const added = await call("POST", "/v1/objects/quote_line_item/records", { key: ws.keys.ops, body: { quote: q.id, description: "Setup", unit_price: 50 } });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    expect(added.json.data).toMatchObject({ quantity: 1, discount: 0, tax: 0, line_total: 50, position: 2 });
    expect(await get("quote", q.id)).toMatchObject({ subtotal: 250, total: 250 });
    const changed = await call("PATCH", `/v1/objects/quote_line_item/records/${added.json.data.id}`, { key: ws.keys.ops, body: { quantity: 3, discount: 25, tax: 10 } });
    expect(changed.json.data).toMatchObject({ quantity: 3, line_total: 135 });
    expect(await get("quote", q.id)).toMatchObject({ subtotal: 350, discount: 25, tax: 10, total: 335 });
    expect((await call("DELETE", `/v1/objects/quote_line_item/records/${added.json.data.id}`, { key: ws.keys.ops })).status).toBe(200);
    expect(await get("quote", q.id)).toMatchObject({ subtotal: 200, discount: 0, tax: 0, total: 200 });
    expect((await call("POST", `/v1/objects/quote_line_item/records/${added.json.data.id}/restore`, { key: ws.keys.ops })).status).toBe(200);
    expect(await get("quote", q.id)).toMatchObject({ total: 335 });
    // A quote's amounts are never written directly.
    expect((await call("PATCH", `/v1/objects/quote/records/${q.id}`, { key: ws.keys.ops, body: { total: 1 } })).status).toBeGreaterThanOrEqual(400);
    for (const bad of [{ quantity: 0 }, { quantity: 1.23456 }, { unit_price: -1 }, { discount: 9999 }, { tax: -5 }]) {
      const r = await call("POST", "/v1/objects/quote_line_item/records", { key: ws.keys.ops, body: { quote: q.id, description: "Bad", unit_price: 10, ...bad } });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await get("quote", q.id)).toMatchObject({ total: 335 });
  });

  it("needs a deal unless the workspace allows quotes without one", async () => {
    const d = await deal();
    const without = await call("POST", "/v1/objects/quote/records", { key: ws.keys.ops, body: { account: d.account.id, name: "Standalone" } });
    expect(without.status).toBe(422);
    expect(without.json.detail).toContain("made for a deal");
    // Changing the setting needs schema:manage.
    expect((await call("PATCH", "/v1/commerce-settings", { key: ws.keys.ops, body: { quote_requires_deal: false } })).status).toBe(403);
    expect((await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: {} })).status).toBe(422);
    expect((await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: { made_up: true } })).status).toBe(422);
    const off = await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: { quote_requires_deal: false } });
    expect(off.json.data).toEqual({ quote_requires_deal: false, accept_quote_marks_deal_won: true });
    try {
      const alone = await call("POST", "/v1/objects/quote/records", { key: ws.keys.ops, body: { account: d.account.id, name: "Standalone" } });
      expect(alone.status, JSON.stringify(alone.json)).toBe(201);
      expect(alone.json.data).toMatchObject({ name: "Standalone", account: d.account.id, deal: null });
      // Still needs someone to be for.
      const nobody = await call("POST", "/v1/objects/quote/records", { key: ws.keys.ops, body: { name: "For nobody" } });
      expect(nobody.status).toBe(422);
      expect(nobody.json.detail).toContain("account or a contact");
      // It lives its whole life without a deal.
      await call("POST", "/v1/objects/quote_line_item/records", { key: ws.keys.ops, body: { quote: alone.json.data.id, description: "Thing", unit_price: 10 } });
      expect((await op("send_quote", { quote: alone.json.data.id })).status).toBe(200);
      const accepted = await op("accept_quote", { quote: alone.json.data.id });
      expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
      expect(accepted.json.result.order).toMatchObject({ deal: null, account: d.account.id, total: 10 });
      expect(accepted.json.result).not.toHaveProperty("deal");
    } finally {
      await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: { quote_requires_deal: true } });
    }
    const audit = (await call("GET", "/v1/audit-log?action=workspace.commerce_settings_changed", { key: ws.keys.admin })).json.data as unknown[];
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });
});

describe("quotes: sent, then fixed", () => {
  it("send_quote fixes what the quote says, keeps who it was issued to, and refuses an empty quote", async () => {
    const d = await deal();
    const empty = await quoteFor(d.deal.id, []);
    const refused = await op("send_quote", { quote: empty.id });
    expect(refused.status).toBe(422);
    expect(refused.json.detail).toContain("no lines");

    const q = await quoteFor(d.deal.id);
    // The status moves only through the operations.
    for (const status of ["sent", "accepted", "superseded"]) {
      expect((await call("PATCH", `/v1/objects/quote/records/${q.id}`, { key: ws.keys.ops, body: { status } })).status, status).toBe(403);
    }
    expect((await op("send_quote", { quote: q.id, dry_run: true })).json).toMatchObject({ dry_run: true, would: [expect.stringContaining("can't be changed afterwards")] });
    const sent = await op("send_quote", { quote: q.id });
    expect(sent.status, JSON.stringify(sent.json)).toBe(200);
    expect(sent.json.result).toMatchObject({ status: "sent", total: 1734.03 });
    expect(sent.json.result.sent_at).toBeTruthy();
    expect((await op("send_quote", { quote: q.id })).status).toBe(409);

    // Fixed: its name and terms, and its lines.
    const rename = await call("PATCH", `/v1/objects/quote/records/${q.id}`, { key: ws.keys.ops, body: { name: "Other", terms: "Net 90" } });
    expect(rename.status).toBe(409);
    expect(rename.json.detail).toContain("revise_quote");
    const lines = await listOf("quote_line_item", { field: "quote", op: "eq", value: q.id });
    expect(lines).toHaveLength(3);
    expect((await call("PATCH", `/v1/objects/quote_line_item/records/${String(lines[0]!.id)}`, { key: ws.keys.ops, body: { quantity: 99 } })).status).toBe(409);
    expect((await call("DELETE", `/v1/objects/quote_line_item/records/${String(lines[0]!.id)}`, { key: ws.keys.ops })).status).toBe(409);
    expect((await call("POST", "/v1/objects/quote_line_item/records", { key: ws.keys.ops, body: { quote: q.id, description: "Late", unit_price: 1 } })).status).toBe(409);
    expect(await get("quote", q.id)).toMatchObject({ name: q.name, total: 1734.03 });
    // Its owner can still change, and it can be rejected.
    expect((await call("PATCH", `/v1/objects/quote/records/${q.id}`, { key: ws.keys.ops, body: { status: "rejected" } })).status).toBe(200);

    // The database refuses too, whatever the app does; and it keeps the customer's names as sent.
    const uuid = decodeId(q.id)!.uuid;
    await expect(inTenant((tx) => tx`UPDATE quotes SET total_minor = 1 WHERE id = ${uuid}`)).rejects.toThrow(/has been sent cannot be changed/);
    await expect(inTenant((tx) => tx`UPDATE quote_line_items SET quantity = 5 WHERE quote_id = ${uuid}`)).rejects.toThrow(/lines of a quote that has been sent/);
    const [row] = await inTenant((tx) => tx<{ snapshot: { account: { name: string }; contact: { name: string } } }[]>`SELECT snapshot FROM quotes WHERE id = ${uuid}`);
    expect(row!.snapshot.account.name).toBe(d.account.name);
    expect(row!.snapshot.contact.name).toBe("Dana Buyer");
  });

  it("revise_quote makes the next version, which supersedes the one before when it is sent", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Licence", quantity: 2, unit_price: 100 }]);
    expect((await op("revise_quote", { quote: q.id })).status).toBe(409); // a draft is changed directly
    await op("send_quote", { quote: q.id });
    const revised = await op("revise_quote", { quote: q.id });
    expect(revised.status, JSON.stringify(revised.json)).toBe(200);
    const v2 = revised.json.result;
    expect(v2).toMatchObject({ number: `${q.number}-2`, revision: 2, status: "draft", deal: d.deal.id, account: d.account.id, total: 200 });
    expect((await op("revise_quote", { quote: q.id })).status).toBe(409); // there is a draft version already
    const lines = await listOf("quote_line_item", { field: "quote", op: "eq", value: v2.id });
    expect(lines).toHaveLength(1);
    await call("PATCH", `/v1/objects/quote_line_item/records/${String(lines[0]!.id)}`, { key: ws.keys.ops, body: { unit_price: 90 } });
    // The first version is untouched until the new one is sent.
    expect(await get("quote", q.id)).toMatchObject({ status: "sent", total: 200 });
    const sent = await op("send_quote", { quote: v2.id });
    expect(sent.json.result).toMatchObject({ status: "sent", total: 180 });
    expect(await get("quote", q.id)).toMatchObject({ status: "superseded", total: 200 });
    expect((await op("accept_quote", { quote: q.id })).status).toBe(409);
  });
});

describe("quotes: accepted, which makes the order", () => {
  it("accept_quote makes an order with the quote's lines, closes the deal's other quotes and marks the deal won", async () => {
    const d = await deal("Won by quote");
    const other = await quoteFor(d.deal.id, [{ description: "Alternative", unit_price: 5 }]);
    const sentOther = await quoteFor(d.deal.id, [{ description: "Second alternative", unit_price: 6 }]);
    await op("send_quote", { quote: sentOther.id });
    const q = await quoteFor(d.deal.id);
    expect((await op("accept_quote", { quote: q.id })).status).toBe(409); // not sent yet
    await op("send_quote", { quote: q.id });
    const dry = await op("accept_quote", { quote: q.id, dry_run: true });
    expect(dry.json.would).toEqual([`accept quote ${q.number}`, "make an order from it", "mark 2 other open quote(s) of the deal superseded", 'move the deal to "Closed won"']);

    const accepted = await op("accept_quote", { quote: q.id });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    const { quote, order, deal: wonDeal } = accepted.json.result;
    expect(quote).toMatchObject({ status: "accepted" });
    expect(quote.accepted_at).toBeTruthy();
    expect(order).toMatchObject({ quote: q.id, deal: d.deal.id, account: d.account.id, contact: d.contact.id, status: "pending", order_type: "new",
      name: "Won by quote", subtotal: 1694.03, discount: 100, tax: 140, total: 1734.03, currency: "USD" });
    expect(order.id).toMatch(/^ord_/);
    expect(order.number).toMatch(/^O-\d{4}$/);
    expect(wonDeal).toMatchObject({ status: "won" });
    const orderLines = await listOf("order_line_item", { field: "order", op: "eq", value: order.id });
    expect(orderLines.map((l) => [l.description, l.quantity, l.unit_price, l.line_total])).toEqual([["Seats", 12, 49.5, 594], ["Onboarding", 1, 800, 840], ["Support hours", 2.5, 120.01, 300.03]]);
    expect(String(orderLines[0]!.quote_line)).toMatch(/^qli_/);
    expect(await get("quote", other.id)).toMatchObject({ status: "superseded" });
    expect(await get("quote", sentOther.id)).toMatchObject({ status: "superseded" });
    // Once, and one per deal.
    expect((await op("accept_quote", { quote: q.id })).status).toBe(409);
    const late = await quoteFor(d.deal.id);
    await op("send_quote", { quote: late.id });
    const second = await op("accept_quote", { quote: late.id });
    expect(second.status).toBe(409);
    expect(second.json.detail).toContain("already has an accepted quote");

    await processEvents(ws.tenantId);
    const events = ((await call("GET", "/v1/events?limit=200", { key: ws.keys.ops })).json.data as { type: string }[]).map((e) => e.type);
    for (const t of ["quote.sent", "quote.accepted", "order.created", "deal.stage_changed"]) expect(events, t).toContain(t);
    const actions = ((await call("GET", "/v1/audit-log?action=quote.", { key: ws.keys.admin })).json.data as { action: string }[]).map((e) => e.action);
    for (const a of ["quote.sent", "quote.accepted", "quote.superseded"]) expect(actions).toContain(a);
  });

  it("an order is written only by accepting, and only its status changes afterwards", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Thing", unit_price: 10 }]);
    await op("send_quote", { quote: q.id });
    const order = (await op("accept_quote", { quote: q.id })).json.result.order;
    expect((await call("POST", "/v1/objects/order/records", { key: ws.keys.ops, body: { name: "By hand", account: d.account.id } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", "/v1/objects/order_line_item/records", { key: ws.keys.ops, body: { order: order.id, description: "x", unit_price: 1 } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("PATCH", `/v1/objects/order/records/${order.id}`, { key: ws.keys.ops, body: { name: "Renamed" } })).status).toBeGreaterThanOrEqual(400);
    const [line] = await listOf("order_line_item", { field: "order", op: "eq", value: order.id });
    expect((await call("PATCH", `/v1/objects/order_line_item/records/${String(line!.id)}`, { key: ws.keys.ops, body: { quantity: 9 } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("DELETE", `/v1/objects/order_line_item/records/${String(line!.id)}`, { key: ws.keys.ops })).status).toBe(403);
    // Status: pending → active → fulfilled, and no way back.
    expect((await call("PATCH", `/v1/objects/order/records/${order.id}`, { key: ws.keys.ops, body: { status: "fulfilled" } })).status).toBe(422);
    expect((await call("PATCH", `/v1/objects/order/records/${order.id}`, { key: ws.keys.ops, body: { status: "active" } })).json.data.status).toBe("active");
    expect((await call("PATCH", `/v1/objects/order/records/${order.id}`, { key: ws.keys.ops, body: { status: "fulfilled" } })).json.data.status).toBe("fulfilled");
    expect((await call("PATCH", `/v1/objects/order/records/${order.id}`, { key: ws.keys.ops, body: { status: "pending" } })).status).toBe(422);
    const uuid = decodeId(order.id)!.uuid;
    await expect(inTenant((tx) => tx`UPDATE orders SET total_minor = 1 WHERE id = ${uuid}`)).rejects.toThrow(/order cannot be changed/);
    await expect(inTenant((tx) => tx`DELETE FROM order_line_items WHERE order_id = ${uuid}`)).rejects.toThrow(/lines of an order cannot be changed/);
  });

  it("an expired quote isn't accepted, and the deal stays open when the workspace says so", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Thing", unit_price: 10 }]);
    await call("PATCH", `/v1/objects/quote/records/${q.id}`, { key: ws.keys.ops, body: { valid_until: "2020-01-01" } });
    await op("send_quote", { quote: q.id });
    const expired = await op("accept_quote", { quote: q.id });
    expect(expired.status).toBe(409);
    expect(expired.json.detail).toContain("valid until 2020-01-01");

    await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: { accept_quote_marks_deal_won: false } });
    try {
      const d2 = await deal();
      const q2 = await quoteFor(d2.deal.id, [{ description: "Thing", unit_price: 10 }]);
      await op("send_quote", { quote: q2.id });
      const accepted = await op("accept_quote", { quote: q2.id });
      expect(accepted.status).toBe(200);
      expect(accepted.json.result.deal).toMatchObject({ status: "open" });
    } finally {
      await call("PATCH", "/v1/commerce-settings", { key: ws.keys.admin, body: { accept_quote_marks_deal_won: true } });
    }
  });
});

describe("quotes and orders: access and merges", () => {
  it("each operation needs what it writes: quote status to send, orders to accept, and the deal's stage to mark it won", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Thing", unit_price: 10 }]);
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await op("send_quote", { quote: q.id }, reader.key)).status).toBe(403);
    expect((await op("create_quote", { deal: d.deal.id }, reader.key)).status).toBe(403);

    const mk = async (rules: Record<string, unknown>) => (await call("POST", "/v1/roles", { key: ws.keys.admin, body: {
      key: `com_${Math.random().toString(36).slice(2, 9)}`, name: "Commerce test", permissions: ["records:read", "records:write"], ...rules } })).json.data.key as string;
    const noOrders = await memberWithKey(ws, await mk({ objects: { order: { write: false } } }), ["ops:read", "ops:write"]);
    expect((await op("send_quote", { quote: q.id }, noOrders.key)).status).toBe(200);
    const refused = await op("accept_quote", { quote: q.id }, noOrders.key);
    expect(refused.status).toBe(403);
    expect(await get("quote", q.id)).toMatchObject({ status: "sent" });

    // Someone who can't change deal.stage accepts the quote; the deal's stage is left alone, and they are told.
    const noStage = await memberWithKey(ws, await mk({ fields: { deal: { stage: "read" } } }), ["ops:read", "ops:write"]);
    const accepted = await op("accept_quote", { quote: q.id }, noStage.key);
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(accepted.json.result.note).toContain("deal.stage");
    expect(accepted.json.result.deal).toMatchObject({ status: "open" });

    // A quote takes from the deal only what the caller can read there.
    const noAccount = await memberWithKey(ws, await mk({ fields: { deal: { account: "none" } } }), ["ops:read", "ops:write"]);
    const d2 = await deal();
    const made = await op("create_quote", { deal: d2.deal.id }, noAccount.key);
    expect(made.status, JSON.stringify(made.json)).toBe(200);
    expect(await get("quote", made.json.result.quote.id)).toMatchObject({ account: null, contact: d2.contact.id });
  });

  it("merging contacts moves their quotes and orders to the survivor, sent ones included", async () => {
    const d = await deal();
    const q = await quoteFor(d.deal.id, [{ description: "Thing", unit_price: 10 }]);
    await op("send_quote", { quote: q.id });
    const order = (await op("accept_quote", { quote: q.id })).json.result.order;
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Dana", last_name: "Kept", email: uniqueEmail("kept") });
    // The deal's primary contact is the duplicate, so it moves too.
    const dry = await op("merge_records", { survivor: survivor.id, duplicates: [d.contact.id] });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    const token = dry.json.confirm_token ?? dry.json.result?.confirm_token;
    const done = await op("merge_records", { survivor: survivor.id, duplicates: [d.contact.id], dry_run: false, confirm_token: token });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(await get("quote", q.id)).toMatchObject({ contact: survivor.id, status: "accepted" });
    expect(await get("order", order.id)).toMatchObject({ contact: survivor.id });
    // What the quote said when it was sent is kept.
    const [row] = await inTenant((tx) => tx<{ snapshot: { contact: { id: string } } }[]>`SELECT snapshot FROM quotes WHERE id = ${decodeId(q.id)!.uuid}`);
    expect(row!.snapshot.contact.id).toBe(d.contact.id);
  });
});

describe("quotes: automations react to them", () => {
  it("an automation on quote.accepted runs when a quote is accepted", async () => {
    const made = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Kick off onboarding", trigger: { type: "event", event: "quote.accepted" },
      actions: [{ type: "create_record", object: "task", values: { title: "Onboard {{record.name}}", assignee: "{{record.owner}}", related_to: ["{{record.id}}"] } }] } });
    expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
    expect((await call("POST", "/v1/automations", { key: ws.keys.admin, body: { name: "x", trigger: { type: "event", event: "quote.exploded" },
      actions: [{ type: "stop" }] } })).status).toBe(422);
    const d = await deal("Automated");
    const q = await quoteFor(d.deal.id, [{ description: "Thing", unit_price: 10 }]);
    await op("send_quote", { quote: q.id });
    await op("accept_quote", { quote: q.id });
    await processEvents(ws.tenantId);
    const tasks = (await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "task", where: { field: "title", op: "eq", value: "Onboard Automated" } } })).json.data as unknown[];
    expect(tasks).toHaveLength(1);
  });
});
