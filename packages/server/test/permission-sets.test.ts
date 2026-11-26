import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Permission sets (ADR 0013), through real HTTP calls: a member keeps one role and holds any number of
 * sets, each built like a custom role, and their access is the union. A value a member must not see is
 * a sentinel, so a leak anywhere in a response is a plain substring match.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const SECRET = `zq${Date.now().toString(36)}marginsentinel`; // deal.margin_note
let ws: Workspace;
let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;
const ids = { contact: "", deal: "" };
const OPS = ["ops:read", "ops:write"];
const has = (body: unknown, s: string) => JSON.stringify(body ?? null).includes(s);

async function pset(body: Record<string, unknown>, key = ws.keys.admin) {
  const r = await call("POST", "/v1/permission-sets", { key, body: { key: slug("ps"), name: "Set", ...body } });
  if (r.status !== 201) throw new Error(`permission set failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string; permissions: string[]; record_permissions: string[]; feature_permissions: string[];
    objects: Record<string, unknown>; fields: Record<string, unknown> };
}

async function role(permissions: string[], rules: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "Custom", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string };
}

const assign = (memberId: string, sets: string[], key = ws.keys.admin) =>
  call("PATCH", `/v1/${memberId.startsWith("svc_") ? "service-accounts" : "members"}/${memberId}`, { key, body: { permission_sets: sets } });

beforeAll(async () => {
  ws = await newWorkspace("Permission sets");
  const f = await call("POST", "/v1/objects/deal/fields", { key: ws.keys.admin, body: { api_name: "margin_note", type: "text" } });
  if (f.status !== 201) throw new Error(`field: ${JSON.stringify(f.json)}`);
  const contact = await create(ws.keys.ops, "contact", { first_name: "Petra", email: uniqueEmail("petra") });
  const deal = await create(ws.keys.ops, "deal", { name: "Set Deal", primary_contact: contact.id, amount: 500, margin_note: SECRET });
  Object.assign(ids, { contact: contact.id, deal: deal.id });
});

describe("permission sets: definition", () => {
  it("are created, read, changed and archived like custom roles, with their own IDs and key namespace", async () => {
    const r = await role(["records:read"]);
    // The same key as a role is fine: roles and sets are named separately.
    const made = await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: r.key, name: "Deal desk", description: "Deals",
      permissions: ["views:manage", "records:read"], objects: { deal: { read: true, write: true } } } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const s = made.json.data;
    expect(s.id).toMatch(/^pset_/);
    expect(s).not.toHaveProperty("is_system");
    expect(s.record_permissions).toEqual(["records:read"]);
    expect(s.feature_permissions).toEqual(["views:manage"]);
    expect(s.objects).toEqual({ deal: { read: true, write: true, archive: null } });
    expect(s.active_members).toBe(0);

    // Sets are not roles and roles are not sets, by key or by ID.
    expect((await call("GET", `/v1/roles/${s.id}`, { key: ws.keys.admin })).status).toBe(404);
    expect((await call("GET", `/v1/permission-sets/${r.id}`, { key: ws.keys.admin })).status).toBe(404);
    const roles = (await call("GET", "/v1/roles", { key: ws.keys.admin })).json.data as { id: string }[];
    expect(roles.some((x) => x.id === s.id)).toBe(false);
    const sets = (await call("GET", "/v1/permission-sets", { key: ws.keys.admin })).json.data as { id: string }[];
    expect(sets.map((x) => x.id)).toContain(s.id);
    expect(sets.some((x) => x.id === r.id)).toBe(false);

    const dup = await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: r.key, name: "Again" } });
    expect(dup.status).toBe(409);
    expect((await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: "pset_x", name: "x" } })).status).toBe(422);

    const patched = await call("PATCH", `/v1/permission-sets/${s.id}`, { key: ws.keys.admin, body: { name: "Deal desk 2", fields: { deal: { margin_note: "none" } } } });
    expect(patched.status, JSON.stringify(patched.json)).toBe(200);
    expect(patched.json.data.fields).toEqual({ deal: { margin_note: "none" } });
    const access = await call("GET", `/v1/permission-sets/${s.key}/access`, { key: ws.keys.admin });
    expect(access.json.data.permission_set).toBe(s.key);
    const deal = (access.json.data.objects as { object: string; read: boolean; write: boolean; fields: Record<string, string> }[]).find((o) => o.object === "deal")!;
    expect(deal).toMatchObject({ read: true, write: true, fields: { margin_note: "none" } });

    const gone = await call("DELETE", `/v1/permission-sets/${s.id}`, { key: ws.keys.admin });
    expect(gone.json.data).toEqual({ id: s.id, key: s.key, archived: true });
    expect((await call("GET", `/v1/permission-sets/${s.id}`, { key: ws.keys.admin })).status).toBe(404);
  });

  it("the catalog says which permissions are about records and which are features", async () => {
    const cat = (await call("GET", "/v1/permissions", { key: ws.keys.ops })).json.data as { key: string; category: string }[];
    const of = (c: string) => cat.filter((p) => p.category === c).map((p) => p.key);
    expect(of("records")).toEqual(["records:read", "records:write", "records:archive", "restricted:read"]);
    expect(of("features")).toEqual(["schema:manage", "members:manage", "roles:manage", "keys:manage", "webhooks:manage", "automations:manage",
      "alerts:manage", "audit:read", "views:manage", "connections:manage"]);
  });

  it("keep the rules of roles: what reaches records needs record access, and managers can't be limited", async () => {
    const lone = await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: slug("ps"), name: "x", permissions: ["automations:manage"] } });
    expect(lone.status).toBe(422);
    expect(lone.json.detail).toContain("permission set must also hold");
    const limited = await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: slug("ps"), name: "x",
      permissions: ["records:read", "webhooks:manage"], fields: { deal: { margin_note: "none" } } } });
    expect(limited.status).toBe(422);
    const chain = await call("POST", "/v1/permission-sets", { key: ws.keys.admin, body: { key: slug("ps"), name: "x", objects: { deal: { write: true } } } });
    expect(chain.status).toBe(422);
    expect(chain.json.detail).toContain("write needs read");
  });

  it("need roles:manage to change, and are readable by any member", async () => {
    const plain = await memberWithKey(ws, "member", OPS);
    expect((await call("GET", "/v1/permission-sets", { key: plain.key })).status).toBe(200);
    expect((await call("POST", "/v1/permission-sets", { key: plain.key, body: { key: slug("ps"), name: "x" } })).status).toBe(403);
  });
});

describe("permission sets: a member's access is their role and their sets together", () => {
  it("a set adds an object the role can't reach, and taking it away removes it on the next request", async () => {
    const r = await role([], { objects: { contact: { read: true, write: true } } });
    const m = await memberWithKey(ws, r.key, OPS);
    expect((await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key })).status).toBe(403);
    const deals = await pset({ objects: { deal: { read: true } } });
    const given = await assign(m.id, [deals.key]);
    expect(given.status, JSON.stringify(given.json)).toBe(200);
    expect(given.json.data.permission_sets).toEqual([deals.key]);

    const got = await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key });
    expect(got.status).toBe(200);
    // Read only: the set gave read, nothing gives write.
    expect((await call("PATCH", `/v1/objects/deal/records/${ids.deal}`, { key: m.key, body: { name: "x" } })).status).toBe(403);
    expect((await call("GET", `/v1/objects/contact/records/${ids.contact}`, { key: m.key })).status).toBe(200);
    const me = await call("GET", "/v1/me", { key: m.key });
    expect(me.json.role).toBe(r.key);
    expect(me.json.permission_sets).toEqual([deals.key]);
    const mine = (await call("GET", "/v1/me/access", { key: m.key })).json.data.objects as { object: string; read: boolean; write: boolean }[];
    expect(mine.find((o) => o.object === "deal")).toMatchObject({ read: true, write: false });
    expect(mine.find((o) => o.object === "account")).toMatchObject({ read: false });

    expect((await assign(m.id, [])).json.data.permission_sets).toEqual([]);
    expect((await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key })).status).toBe(403);
  });

  it("the most permissive wins: a deny or a hidden field only shapes the part it is in", async () => {
    // The role reads everything except deals, and hides nothing; one set reads deals but hides the margin note.
    const r = await role(["records:read", "records:write"], { objects: { deal: { read: false, write: false } } });
    const m = await memberWithKey(ws, r.key, OPS);
    const hidden = await pset({ objects: { deal: { read: true } }, fields: { deal: { margin_note: "none" } } });
    await assign(m.id, [hidden.key]);
    const first = await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key });
    expect(first.status).toBe(200);
    expect(has(first.json, SECRET)).toBe(false);
    // Filtering on the hidden field is refused: which records match would reveal it.
    const q = await call("POST", "/v1/query", { key: m.key, body: { object: "deal", where: { field: "margin_note", op: "eq", value: SECRET } } });
    expect(q.status).toBe(403);
    // A second set that reads and writes deals without a limit lifts both.
    const full = await pset({ objects: { deal: { read: true, write: true } } });
    await assign(m.id, [hidden.key, full.key]);
    const second = await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key });
    expect(second.json.data.margin_note).toBe(SECRET);
    const wrote = await call("PATCH", `/v1/objects/deal/records/${ids.deal}`, { key: m.key, body: { margin_note: SECRET } });
    expect(wrote.status, JSON.stringify(wrote.json)).toBe(200);
    // And a set whose field is read-only doesn't take the write away either.
    const readOnly = await pset({ objects: { deal: { read: true, write: true } }, fields: { deal: { margin_note: "read" } } });
    await assign(m.id, [hidden.key, full.key, readOnly.key]);
    expect((await call("PATCH", `/v1/objects/deal/records/${ids.deal}`, { key: m.key, body: { margin_note: SECRET } })).status).toBe(200);
    // Without the unlimited set, the widest the others give the field is read.
    await assign(m.id, [hidden.key, readOnly.key]);
    expect((await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: m.key })).json.data.margin_note).toBe(SECRET);
    const refused = await call("PATCH", `/v1/objects/deal/records/${ids.deal}`, { key: m.key, body: { margin_note: "x" } });
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toContain("deal.margin_note");
    expect((await call("PATCH", `/v1/objects/deal/records/${ids.deal}`, { key: m.key, body: { name: "Set Deal" } })).status).toBe(200);
  });

  it("a set gives a feature: a member manages webhooks through a set, and loses it with the set", async () => {
    const m = await memberWithKey(ws, "member", ["admin", ...OPS]).catch(() => null);
    // A member's role can't use the admin scope, so the key is made after the set makes it usable.
    expect(m).toBeNull();
    const user = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("hooks"), name: "Hooks", role: "member" } });
    const hooks = await pset({ permissions: ["records:read", "webhooks:manage"] });
    expect((await assign(user.json.data.id, [hooks.key])).status).toBe(200);
    const key = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "hooks", scopes: ["admin", "ops:read"], owner: user.json.data.id } });
    expect(key.status, JSON.stringify(key.json)).toBe(201);
    expect((await call("GET", "/v1/webhooks", { key: key.json.data.secret })).status).toBe(200);
    expect((await call("GET", "/v1/automations", { key: key.json.data.secret })).status).toBe(403);
    await assign(user.json.data.id, []);
    expect((await call("GET", "/v1/webhooks", { key: key.json.data.secret })).status).toBe(403);
  });

  it("service accounts hold sets too, and members can be added with them", async () => {
    const deals = await pset({ objects: { deal: { read: true } } });
    const r = await role([], { objects: { contact: { read: true } } });
    const svc = await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: slug("bot"), role: r.key, permission_sets: [deals.id] } });
    expect(svc.status, JSON.stringify(svc.json)).toBe(201);
    expect(svc.json.data.permission_sets).toEqual([deals.key]);
    const key = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "bot", scopes: ["ops:read"], owner: svc.json.data.id } });
    expect((await call("GET", `/v1/objects/deal/records/${ids.deal}`, { key: key.json.data.secret })).status).toBe(200);
    const user = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("withset"), name: "W", role: r.key, permission_sets: [deals.key] } });
    expect(user.json.data.permission_sets).toEqual([deals.key]);
    const listed = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data;
    expect(listed.users.find((u: { id: string }) => u.id === user.json.data.id).permission_sets).toEqual([deals.key]);
    expect(listed.service_accounts.find((u: { id: string }) => u.id === svc.json.data.id).permission_sets).toEqual([deals.key]);
    expect((await call("GET", `/v1/permission-sets/${deals.id}`, { key: ws.keys.admin })).json.data.active_members).toBe(2);
    // Held by active members, so it can't be archived until it is taken away.
    expect((await call("DELETE", `/v1/permission-sets/${deals.id}`, { key: ws.keys.admin })).status).toBe(409);
    await assign(user.json.data.id, []);
    await assign(svc.json.data.id, []);
    expect((await call("DELETE", `/v1/permission-sets/${deals.id}`, { key: ws.keys.admin })).status).toBe(200);
  });

  it("the access review lists each member's sets and their permissions together", async () => {
    const hooks = await pset({ permissions: ["records:read", "webhooks:manage"], objects: { deal: { read: true } } });
    const user = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("review"), name: "Review", role: "read_only", permission_sets: [hooks.key] } });
    const review = (await call("GET", "/v1/access-review", { key: ws.keys.admin })).json.data.members as
      { id: string; permissions: string[]; effective_permissions: string[]; permission_sets: { key: string; permissions: string[]; record_rules: { objects: unknown } }[] }[];
    const row = review.find((x) => x.id === user.json.data.id)!;
    expect(row.permissions).toEqual(["records:read", "restricted:read"]);
    expect(row.permission_sets).toEqual([expect.objectContaining({ key: hooks.key, permissions: ["records:read", "webhooks:manage"],
      record_rules: { objects: { deal: { read: true, write: null, archive: null } }, fields: {} } })]);
    expect([...row.effective_permissions].sort()).toEqual(["records:read", "restricted:read", "webhooks:manage"]);
  });
});

describe("permission sets: nobody grants what they don't hold", () => {
  it("assigning needs members:manage, every permission of the set and its record access", async () => {
    // A manager who can manage members and roles, reads contacts only, and has no webhooks:manage.
    const mgrRole = await role(["members:manage", "roles:manage"], { objects: { contact: { read: true } } });
    const mgr = await memberWithKey(ws, mgrRole.key, ["admin", "ops:read"]);
    const target = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("target"), name: "T", role: mgrRole.key } });
    const hooks = await pset({ permissions: ["records:read", "webhooks:manage"] });
    const deals = await pset({ objects: { deal: { read: true } } });
    const contacts = await pset({ objects: { contact: { read: true } } });

    const noPermission = await assign(target.json.data.id, [hooks.key], mgr.key);
    expect(noPermission.status).toBe(403);
    expect(noPermission.json.detail).toContain("permissions you don't hold");
    const noAccess = await assign(target.json.data.id, [deals.key], mgr.key);
    expect(noAccess.status).toBe(403);
    expect(noAccess.json.detail).toContain("record access you don't");
    expect((await assign(target.json.data.id, [contacts.key], mgr.key)).status).toBe(200);
    // Nor can they build such a set themselves.
    expect((await call("POST", "/v1/permission-sets", { key: mgr.key, body: { key: slug("ps"), name: "x", objects: { deal: { read: true } } } })).status).toBe(403);

    // Once the target holds more than the manager (through a set the admin gave), the manager can't act on them at all.
    expect((await assign(target.json.data.id, [contacts.key, deals.key])).status).toBe(200);
    const blocked = await call("PATCH", `/v1/members/${target.json.data.id}`, { key: mgr.key, body: { active: false } });
    expect(blocked.status).toBe(403);
    // And can't mint a key for them: it would read deals for the manager.
    const plainMember = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("keys"), name: "K", role: mgrRole.key, permission_sets: [deals.key] } });
    const keyMgrRole = await role(["keys:manage", "members:manage", "roles:manage"], { objects: { contact: { read: true } } });
    const keyMgr = await memberWithKey(ws, keyMgrRole.key, ["admin", "ops:read"]);
    const minted = await call("POST", "/v1/api-keys", { key: keyMgr.key, body: { name: "x", scopes: ["ops:read"], owner: plainMember.json.data.id } });
    expect(minted.status).toBe(403);
  });

  it("nobody changes their own sets, or a set they hold", async () => {
    const mgrRole = await role(["members:manage", "roles:manage", "records:read"]);
    const mgr = await memberWithKey(ws, mgrRole.key, ["admin", "ops:read"]);
    const set = await pset({ objects: { contact: { read: true } } });
    const self = await assign(mgr.id, [set.key], mgr.key);
    expect(self.status).toBe(403);
    expect((await assign(mgr.id, [set.key])).status).toBe(200);
    const change = await call("PATCH", `/v1/permission-sets/${set.id}`, { key: mgr.key, body: { name: "mine" } });
    expect(change.status).toBe(403);
    expect(change.json.detail).toContain("permission set you hold");
    expect((await call("DELETE", `/v1/permission-sets/${set.id}`, { key: mgr.key })).status).toBe(403);
  });

  it("refuses unknown sets, a role given as a set, too many sets, and a set given as a role", async () => {
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("bad"), name: "B", role: "member" } });
    expect((await assign(m.json.data.id, ["no_such_set"])).status).toBe(422);
    expect((await assign(m.json.data.id, ["admin"])).status).toBe(422);
    const set = await pset({ objects: { contact: { read: true } } });
    expect((await call("PATCH", `/v1/members/${m.json.data.id}`, { key: ws.keys.admin, body: { role: set.id } })).status).toBe(404);
    expect((await assign(m.json.data.id, Array.from({ length: 21 }, (_, i) => `s${i}`))).status).toBe(422);
    // The database refuses it too, whatever the app does.
    const [row] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ id: string }[]>`SELECT id FROM roles WHERE kind = 'permission_set' AND key = ${set.key}`;
    });
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      await tx`UPDATE users SET role_id = ${row!.id} WHERE email = ${ws.ownerEmail}`;
    })).rejects.toThrow(/must be a role/);
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      await tx`UPDATE roles SET kind = 'role' WHERE id = ${row!.id}`;
    })).rejects.toThrow(/cannot change kind/);
  });

  it("changes are audited by name", async () => {
    const set = await pset({ objects: { contact: { read: true } } });
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("audit"), name: "A", role: "member" } });
    await assign(m.json.data.id, [set.key]);
    await assign(m.json.data.id, []);
    const created = (await call("GET", "/v1/audit-log?action=permission_set.", { key: ws.keys.admin })).json.data as { action: string; details: { key: string } }[];
    expect(created.some((e) => e.action === "permission_set.created" && e.details.key === set.key)).toBe(true);
    const changes = (await call("GET", "/v1/audit-log?action=member.permission_sets_changed", { key: ws.keys.admin })).json.data as
      { details: { added: string[]; removed: string[] } }[];
    expect(changes.some((e) => e.details.added.includes(set.key))).toBe(true);
    expect(changes.some((e) => e.details.removed.includes(set.key))).toBe(true);
  });
});
