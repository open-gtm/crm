import { beforeAll, describe, expect, it } from "vitest";
import { sealTenant, verifyTenant, anchorTenant } from "../src/core/auditchain.js";
import { decodeId } from "../src/lib/ids.js";
import { db } from "../src/db/pool.js";
import { call, create, newWorkspace, type Workspace } from "./helpers.js";

let ws: Workspace;
beforeAll(async () => {
  ws = await newWorkspace("API");
});

const email = (s: string) => `${s}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

describe("authentication and scopes", () => {
  it("rejects missing, malformed and unknown keys with 401", async () => {
    expect((await call("GET", "/v1/me", { key: "" })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: "hlcrm_live_nope" })).status).toBe(401);
    const forged = ws.keys.ops.slice(0, -4) + "AAAA";
    expect((await call("GET", "/v1/me", { key: forged })).status).toBe(401);
  });

  it("reports the caller and effective scopes", async () => {
    const r = await call("GET", "/v1/me", { key: ws.keys.ops });
    expect(r.status).toBe(200);
    expect(r.json.scopes.sort()).toEqual(["ops:read", "ops:write"]);
    expect(r.json.actor.role).toBe("owner");
  });

  it("ops keys cannot change the schema; admin routes are refused on the ops surface even for admin keys", async () => {
    expect((await call("POST", "/v1/objects", { key: ws.keys.ops, body: { api_name: "widget" } })).status).toBe(403);
    const r = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "widget" }, headers: { "X-HLCRM-Surface": "ops-mcp" } });
    expect(r.status).toBe(403);
  });

  it("a key can never exceed its owner's role", async () => {
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: email("member"), name: "Mem", role: "read_only" } });
    expect(m.status).toBe(201);
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "too much", scopes: ["ops:write"], owner: m.json.data.id } });
    expect(k.status).toBe(403);
    const ok = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "reader", scopes: ["ops:read"], owner: m.json.data.id } });
    expect(ok.status).toBe(201);
    expect(ok.json.data.secret).toMatch(/^hlcrm_live_/);
    const list = await call("GET", "/v1/api-keys", { key: ws.keys.admin });
    expect(JSON.stringify(list.json)).not.toContain(ok.json.data.secret);
  });

  it("revoked keys stop working", async () => {
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "temp", scopes: ["ops:read"] } });
    expect((await call("GET", "/v1/me", { key: k.json.data.secret })).status).toBe(200);
    await call("POST", `/v1/api-keys/${k.json.data.id}/revoke`, { key: ws.keys.admin });
    expect((await call("GET", "/v1/me", { key: k.json.data.secret })).status).toBe(401);
  });
});

describe("records", () => {
  it("creates accounts, contacts and deals with relations and defaults", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Acme", domain: "https://www.Acme-Rec.com/about" });
    expect(acct.domain).toBe("acme-rec.com");
    const contact = await create(ws.keys.ops, "contact", { first_name: "Jane", last_name: "Doe", email: email("jane"), account: acct.id });
    expect(contact.display_name).toBe("Jane Doe");
    const deal = await create(ws.keys.ops, "deal", { name: "Pilot", account: acct.id, primary_contact: contact.id, amount: 1234.56, stage: "discovery" });
    expect(deal.amount).toBe(1234.56);
    expect(deal.status).toBe("open");
    expect(deal.probability).toBe(25);
    const c2 = await call("GET", `/v1/records/${contact.id}`, { key: ws.keys.ops });
    expect(c2.json.data.lifecycle_stage).toBe("opportunity");
  });

  it("explains validation errors field by field", async () => {
    const r = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { email: "not-an-email", favorite_color: "blue" } });
    expect(r.status).toBe(422);
    expect(r.json.errors.errors.map((e: { field: string }) => e.field).sort()).toEqual(["email", "favorite_color"]);
  });

  it("rejects duplicates by email", async () => {
    const e = email("dupe");
    await create(ws.keys.ops, "contact", { email: e });
    const r = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: { email: e.toUpperCase() } });
    expect(r.status).toBe(409);
  });

  it("batch create is all or nothing", async () => {
    const tag = `Batch-${Date.now()}`;
    const bad = await call("POST", "/v1/objects/account/records/batch", { key: ws.keys.ops, body: { records: [{ name: `${tag} A` }, { industry: "no name" }] } });
    expect(bad.status).toBe(422);
    expect(bad.json.detail).toContain("Record 1");
    const q = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "account", where: { field: "name", op: "starts_with", value: tag } } });
    expect(q.json.data).toHaveLength(0);
    const good = await call("POST", "/v1/objects/account/records/batch", { key: ws.keys.ops, body: { records: [{ name: `${tag} A` }, { name: `${tag} B` }] } });
    expect(good.status).toBe(201);
    expect(good.json.data).toHaveLength(2);
  });

  it("replays idempotent writes and refuses reuse with a different body", async () => {
    const key = `idem-${Date.now()}`;
    const body = { name: `Idem ${key}` };
    const a = await call("POST", "/v1/objects/account/records", { key: ws.keys.ops, body, headers: { "Idempotency-Key": key } });
    const b = await call("POST", "/v1/objects/account/records", { key: ws.keys.ops, body, headers: { "Idempotency-Key": key } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.json.data.id).toBe(a.json.data.id);
    const c = await call("POST", "/v1/objects/account/records", { key: ws.keys.ops, body: { name: "other" }, headers: { "Idempotency-Key": key } });
    expect(c.status).toBe(422);
  });

  it("uses If-Match to prevent lost updates", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Versioned" });
    const ok = await call("PATCH", `/v1/objects/account/records/${acct.id}`, { key: ws.keys.ops, body: { industry: "A" }, headers: { "If-Match": '"v1"' } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.version).toBe(2);
    const stale = await call("PATCH", `/v1/objects/account/records/${acct.id}`, { key: ws.keys.ops, body: { industry: "B" }, headers: { "If-Match": '"v1"' } });
    expect(stale.status).toBe(412);
  });

  it("deal stages change only through move_deal_stage, which records history", async () => {
    const c = await create(ws.keys.ops, "contact", { email: email("stage") });
    const deal = await create(ws.keys.ops, "deal", { name: "Stage test", primary_contact: c.id });
    const direct = await call("PATCH", `/v1/objects/deal/records/${deal.id}`, { key: ws.keys.ops, body: { stage: "Closed won" } });
    expect(direct.status).toBe(422);
    const dry = await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "Closed won", dry_run: true } });
    expect(dry.json.dry_run).toBe(true);
    const moved = await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "closed WON" } });
    expect(moved.json.result.status).toBe("won");
    const tl = await call("GET", `/v1/records/${deal.id}/timeline`, { key: ws.keys.ops });
    expect(tl.json.data.items.filter((i: { kind: string }) => i.kind === "stage_change")).toHaveLength(2);
    const contact = await call("GET", `/v1/records/${c.id}`, { key: ws.keys.ops });
    expect(contact.json.data.lifecycle_stage).toBe("customer");
  });

  it("captures interest and converts a qualified lead", async () => {
    const e = email("lead");
    const cap = await call("POST", "/v1/ops/capture_interest", { key: ws.keys.ops, body: { email: e, first_name: "Lee", company: "Leadco", interest: "Pro plan" } });
    expect(cap.status).toBe(200);
    const leadId = cap.json.result.lead.id;
    expect(cap.json.result.contact.email).toBe(e);
    const early = await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: leadId } });
    expect(early.status).toBe(422);
    const direct = await call("PATCH", `/v1/objects/lead/records/${leadId}`, { key: ws.keys.ops, body: { status: "converted" } });
    expect(direct.status).toBe(403);
    expect((await call("PATCH", `/v1/objects/lead/records/${leadId}`, { key: ws.keys.ops, body: { status: "qualified" } })).status).toBe(200);
    const conv = await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: leadId, amount: 900 } });
    expect(conv.status).toBe(200);
    expect(conv.json.result.lead.status).toBe("converted");
    expect(conv.json.result.deal.amount).toBe(900);
    const again = await call("PATCH", `/v1/objects/lead/records/${leadId}`, { key: ws.keys.ops, body: { score: 5 } });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("queries with relation paths, sorting and cursors", async () => {
    const tag = `Q${Date.now()}`;
    const acct = await create(ws.keys.ops, "account", { name: `${tag} Corp`, industry: `${tag}-ind` });
    for (let i = 0; i < 5; i++) await create(ws.keys.ops, "contact", { first_name: `${tag}${i}`, email: email(`${tag}${i}`), account: acct.id });
    const q = { object: "contact", where: { path: ["account", "industry"], op: "eq", value: `${tag}-ind` }, sort: [{ field: "first_name", dir: "asc" }], limit: 2 };
    const p1 = await call("POST", "/v1/query", { key: ws.keys.ops, body: q });
    expect(p1.json.data.map((c: { first_name: string }) => c.first_name)).toEqual([`${tag}0`, `${tag}1`]);
    const p2 = await call("POST", "/v1/query", { key: ws.keys.ops, body: { ...q, cursor: p1.json.next_cursor } });
    expect(p2.json.data.map((c: { first_name: string }) => c.first_name)).toEqual([`${tag}2`, `${tag}3`]);
    const bad = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "nope", op: "eq", value: 1 } } });
    expect(bad.status).toBe(422);
    const search = await call("GET", `/v1/search?q=${tag}`, { key: ws.keys.ops });
    expect(search.json.data.length).toBeGreaterThanOrEqual(5);
  });
});

describe("custom objects and fields", () => {
  it("creates a custom object in one call after a dry run, and it works like any other object", async () => {
    const def = {
      api_name: "property", label: "Property", plural_label: "Properties", owned: true,
      fields: [
        { api_name: "address", type: "text", required: true },
        { api_name: "bedrooms", type: "number" },
        { api_name: "list_price", type: "currency" },
        { api_name: "status", type: "status", options: { values: [{ key: "listed", label: "Listed" }, { key: "sold", label: "Sold" }], initial: "listed", transitions: { listed: ["sold"], sold: [] } } },
        { api_name: "seller", type: "relation", options: { to: "contact" } },
        { api_name: "lockbox_code", type: "text", sensitivity: "restricted" },
      ],
    };
    const dry = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { ...def, dry_run: true } });
    expect(dry.status).toBe(200);
    expect(dry.json.changes).toHaveLength(8); // the object, its six fields, and the owner field an owned object gets
    const made = await call("POST", "/v1/objects", { key: ws.keys.admin, body: def });
    expect(made.status).toBe(201);

    const seller = await create(ws.keys.ops, "contact", { email: email("seller") });
    const prop = await create(ws.keys.ops, "property", { address: "1 Main St", bedrooms: 3, list_price: 450000, seller: seller.id, lockbox_code: "lockbox-Zq7-4321" });
    expect(prop.id).toMatch(/^prop_/);
    expect(prop.status).toBe("listed");
    expect(prop.lockbox_code).toBe("[restricted]");

    const admin = await call("GET", `/v1/records/${prop.id}`, { key: ws.keys.admin });
    expect(admin.json.data.lockbox_code).toBe("lockbox-Zq7-4321");
    expect((await call("PATCH", `/v1/objects/property/records/${prop.id}`, { key: ws.keys.ops, body: { status: "sold" } })).status).toBe(200);
    expect((await call("PATCH", `/v1/objects/property/records/${prop.id}`, { key: ws.keys.ops, body: { status: "listed" } })).status).toBe(422);

    const bySeller = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "property", where: { path: ["seller", "email"], op: "eq", value: seller.email } } });
    expect(bySeller.json.data).toHaveLength(1);
    const restrictedFilter = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "property", where: { field: "lockbox_code", op: "eq", value: "lockbox-Zq7-4321" } } });
    expect(restrictedFilter.status).toBe(422);
    const spec = await call("GET", "/v1/openapi.json", { key: ws.keys.ops });
    expect(spec.json.components.schemas.property.required).toEqual(["address"]);
  });

  it("an owned custom object has an owner field to set, filter and show, like a contact's", async () => {
    // As a pack installs it, with a view that shows the owner.
    const pack = { manifest: { name: "appointments", version: "1.0.0", parts: ["schema", "views"] },
      schema: { objects: [{ name: "appointment", id_prefix: "appt", display_field: "title", owned: true, fields: [{ name: "title", type: "text", required: true }] },
        { name: "room", id_prefix: "room", fields: [{ name: "title", type: "text" }] }] },
      views: [{ name: "Upcoming appointments", object: "appointment", columns: ["title", "owner"] }] };
    const plan = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack } });
    expect(plan.status, JSON.stringify(plan.json).slice(0, 400)).toBe(200);
    const applied = await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack, plan_token: plan.json.plan_token } });
    expect(applied.status, JSON.stringify(applied.json).slice(0, 400)).toBe(200);

    const described = await call("GET", "/v1/objects/appointment", { key: ws.keys.admin });
    const owner = described.json.data.fields.find((f: { name: string }) => f.name === "owner");
    expect(owner).toMatchObject({ type: "relation", standard: true, relation: { to: "user", cardinality: "many_to_one" } });
    // An object that is not owned gets none.
    expect((await call("GET", "/v1/objects/room", { key: ws.keys.admin })).json.data.fields.map((f: { name: string }) => f.name)).toEqual(["title"]);

    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: email("appt-owner"), name: "Appt Owner", role: "member" } });
    expect(m.status).toBe(201);
    const member = m.json.data.id as string;
    // Without an owner the creator owns it, as before; with one, that member does.
    const mine = await create(ws.keys.ops, "appointment", { title: "Mine" });
    expect(mine.owner).toBe(ws.ownerId);
    const theirs = await create(ws.keys.ops, "appointment", { title: "Theirs", owner: member });
    expect(theirs.owner).toBe(member);

    const filtered = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "appointment", where: { field: "owner", op: "eq", value: member } } });
    expect(filtered.json.data.map((r: { title: string }) => r.title)).toEqual(["Theirs"]);
    const byEmail = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "appointment", where: { path: ["owner", "name"], op: "eq", value: "Appt Owner" } } });
    expect(byEmail.json.data.map((r: { title: string }) => r.title)).toEqual(["Theirs"]);

    // Changing it, clearing it, and assign_owner all go through the same field.
    const moved = await call("PATCH", `/v1/objects/appointment/records/${mine.id}`, { key: ws.keys.ops, body: { owner: member } });
    expect(moved.json.data.owner).toBe(member);
    const cleared = await call("PATCH", `/v1/objects/appointment/records/${mine.id}`, { key: ws.keys.ops, body: { owner: null } });
    expect(cleared.json.data.owner).toBeNull();
    const assigned = await call("POST", "/v1/ops/assign_owner", { key: ws.keys.ops, body: { record: mine.id, owner: member } });
    expect(assigned.status, JSON.stringify(assigned.json)).toBe(200);
    expect((await call("GET", `/v1/records/${mine.id}`, { key: ws.keys.ops })).json.data.owner).toBe(member);
    // An owner must be a member of this workspace.
    const stranger = await call("POST", "/v1/objects/appointment/records", { key: ws.keys.ops, body: { title: "No one's", owner: `usr_${member.slice(4).split("").reverse().join("")}` } });
    expect(stranger.status).toBe(422);

    // The field is the platform's: relabeled, not renamed, archived or taken by another field.
    expect((await call("PATCH", "/v1/objects/appointment/fields/owner", { key: ws.keys.admin, body: { label: "Host" } })).status).toBe(200);
    expect((await call("PATCH", "/v1/objects/appointment/fields/owner", { key: ws.keys.admin, body: { api_name: "host" } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/appointment/fields/owner/archive", { key: ws.keys.admin, body: { dry_run: true } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/appointment/fields", { key: ws.keys.admin, body: { api_name: "owner", type: "text" } })).status).toBe(409);
    const clash = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "booking", owned: true, fields: [{ api_name: "owner", type: "text" }] } });
    expect(clash.status).toBe(422);

    // A schema export lists the field, and the export applies to a workspace that lacks the object.
    const doc = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    const exported = doc.objects.find((o: { name: string }) => o.name === "appointment");
    expect(exported.fields.map((f: { name: string }) => f.name)).toEqual(["title", "owner"]);
    const other = await newWorkspace("API owner field copy");
    const { id: _id, ...copy } = exported;
    const document = { format: doc.format, objects: [{ ...copy, fields: copy.fields.map(({ id: _f, ...f }: { id: string }) => f) }] };
    const copied = await call("POST", "/v1/schema/apply", { key: other.keys.admin, body: { document, accept_drift: true } });
    expect(copied.status, JSON.stringify(copied.json).slice(0, 400)).toBe(200);
    const there = (await call("GET", "/v1/objects/appointment", { key: other.keys.admin })).json.data.fields;
    expect(there.filter((f: { name: string }) => f.name === "owner")).toMatchObject([{ label: "Host", standard: true }]);
  });

  it("stores restricted values encrypted at rest", async () => {
    const rows = await db().begin(async (tx) => {
      const me = await tx`SELECT tenant_id FROM tenant_directory ORDER BY created_at`;
      const out: unknown[] = [];
      for (const t of me) {
        await tx`SELECT set_config('app.tenant_id', ${t.tenant_id}, true)`;
        out.push(...(await tx`SELECT encrypted::text AS e, data::text AS d FROM records`));
      }
      return out as { e: string; d: string }[];
    });
    const withSecret = rows.filter((r) => r.e !== "{}");
    expect(withSecret.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.e).not.toContain("lockbox-Zq7-4321");
      expect(r.d).not.toContain("lockbox-Zq7-4321");
    }
  });

  it("adds custom fields to standard objects and relabels standard fields, but protects core fields", async () => {
    const add = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tier", type: "single_select", options: { values: [{ key: "gold", label: "Gold" }] } } });
    expect(add.status).toBe(201);
    const c = await create(ws.keys.ops, "contact", { email: email("tier"), tier: "gold" });
    expect(c.tier).toBe("gold");
    expect((await call("PATCH", "/v1/objects/contact/fields/job_title", { key: ws.keys.admin, body: { label: "Role" } })).status).toBe(200);
    expect((await call("PATCH", "/v1/objects/contact/fields/job_title", { key: ws.keys.admin, body: { api_name: "role" } })).status).toBe(403);
    const arch = await call("POST", "/v1/objects/contact/fields/email/archive", { key: ws.keys.admin, body: { dry_run: true } });
    expect(arch.status).toBe(403);
    const noToken = await call("POST", "/v1/objects/contact/fields/tier/archive", { key: ws.keys.admin, body: { dry_run: false } });
    expect(noToken.status).toBe(400);
    const dry = await call("POST", "/v1/objects/contact/fields/tier/archive", { key: ws.keys.admin, body: { dry_run: true } });
    const done = await call("POST", "/v1/objects/contact/fields/tier/archive", { key: ws.keys.admin, body: { dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(done.status).toBe(200);
    const changes = await call("GET", "/v1/schema/changes", { key: ws.keys.admin });
    expect(changes.json.data[0].change).toBe("field_archived");
  });

  it("lets tenants add their own lead statuses mapped to fixed categories", async () => {
    const values = [
      { key: "new", label: "New", category: "new" }, { key: "working", label: "Working", category: "working" },
      { key: "qualified", label: "Qualified", category: "qualified" }, { key: "disqualified", label: "Disqualified", category: "disqualified" },
      { key: "converted", label: "Converted", category: "converted" }, { key: "demo_booked", label: "Demo booked", category: "working" },
    ];
    expect((await call("PATCH", "/v1/objects/lead/fields/status", { key: ws.keys.admin, body: { values } })).status).toBe(200);
    const bad = await call("PATCH", "/v1/objects/lead/fields/status", { key: ws.keys.admin, body: { values: [...values, { key: "x", label: "X", category: "made_up" }] } });
    expect(bad.status).toBe(422);
    const c = await create(ws.keys.ops, "contact", { email: email("demo") });
    const lead = await create(ws.keys.ops, "lead", { contact: c.id, status: "demo_booked" });
    expect(lead.status).toBe("demo_booked");
  });
});

describe("audit log", () => {
  it("records actions with identity, key and surface, and the hash chain verifies", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Audited" });
    const log = await call("GET", "/v1/audit-log?action=account.created", { key: ws.keys.admin });
    const entry = log.json.data.find((e: { record_id: string }) => e.record_id === decodeId(acct.id)!.uuid);
    expect(entry).toMatchObject({ action: "account.created", surface: "api" });
    expect(entry.key).toMatch(/^key_/);
    const me = await call("GET", "/v1/me", { key: ws.keys.admin });
    const tenantId = decodeId(me.json.workspace.id)!.uuid;
    while ((await sealTenant(tenantId)) > 0) { /* seal everything */ }
    await anchorTenant(tenantId);
    const v = await verifyTenant(tenantId);
    expect(v, JSON.stringify(v)).toMatchObject({ ok: true, unsealed: 0 });
    expect(v.anchors_checked).toBe(1);
    const viaApi = await call("GET", "/v1/audit/verify", { key: ws.keys.admin });
    expect(viaApi.json.data.ok).toBe(true);
  });
});
