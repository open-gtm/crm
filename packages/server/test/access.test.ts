import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAuthLimiter } from "../src/api/app.js";
import { requiredPermission, routes } from "../src/api/registry.js";
import { SYSTEM_ROLES, systemCtx } from "../src/core/context.js";
import { updateMember } from "../src/core/workspace.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";

let ws: Workspace;
const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());
beforeAll(async () => {
  ws = await newWorkspace("Access");
});

let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;

/** Creates a custom role with the owner's key. */
async function role(permissions: string[], extra: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "Custom", permissions, ...extra } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string; permissions: string[] };
}

async function auditActions(prefix: string) {
  const log = await call("GET", `/v1/audit-log?action=${prefix}&limit=100`, { key: ws.keys.admin });
  return log.json.data as { action: string; record_id: string; details: Record<string, unknown> }[];
}

describe("roles", () => {
  it("lists the permission catalog and the four system roles", async () => {
    const perms = await call("GET", "/v1/permissions", { key: ws.keys.ops });
    expect(perms.json.data.map((p: { key: string }) => p.key)).toContain("records:archive");
    const roles = await call("GET", "/v1/roles", { key: ws.keys.ops });
    const system = roles.json.data.filter((r: { is_system: boolean }) => r.is_system);
    expect(system.map((r: { key: string }) => r.key).sort()).toEqual(["admin", "member", "owner", "read_only"]);
  });

  it("seeds system roles exactly as SYSTEM_ROLES defines them", async () => {
    const roles = await call("GET", "/v1/roles", { key: ws.keys.admin });
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const r = roles.json.data.find((x: { key: string }) => x.key === key);
      expect([...r.permissions].sort(), key).toEqual([...def.permissions].sort());
      expect(r.name).toBe(def.name);
    }
  });

  it("creates, reads, updates and archives a custom role, with audited permission diffs", async () => {
    const key = slug("sales_ops");
    const made = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key, name: "Sales ops", copy_from: "read_only" } });
    expect(made.status).toBe(201);
    expect(made.json.data.permissions.sort()).toEqual(["records:read", "restricted:read"]);
    expect(made.json.data.id).toMatch(/^role_/);
    expect((await call("GET", `/v1/roles/${key}`, { key: ws.keys.admin })).json.data.id).toBe(made.json.data.id);
    expect((await call("GET", `/v1/roles/${made.json.data.id}`, { key: ws.keys.admin })).json.data.key).toBe(key);
    const dupe = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key, name: "Again", permissions: [] } });
    expect(dupe.status).toBe(409);
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "role_x", name: "x" } })).status).toBe(422);
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("x"), name: "x", permissions: ["nope"] } })).status).toBe(422);

    const upd = await call("PATCH", `/v1/roles/${key}`, { key: ws.keys.admin, body: { name: "Sales operations", permissions: ["records:read", "records:write"] } });
    expect(upd.status).toBe(200);
    expect(upd.json.data.permissions).toEqual(["records:read", "records:write"]);
    const updated = (await auditActions("role.updated")).find((e) => e.record_id === decodeId(made.json.data.id)!.uuid)!;
    expect(updated.details).toMatchObject({ permissions_added: ["records:write"], permissions_removed: ["restricted:read"], name_changed: true });

    // Archiving is refused while an active member holds the role.
    const m = await memberWithKey(ws, key, ["ops:read"]);
    expect((await call("DELETE", `/v1/roles/${key}`, { key: ws.keys.admin })).status).toBe(409);
    expect((await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { role: "read_only" } })).status).toBe(200);
    const del = await call("DELETE", `/v1/roles/${key}`, { key: ws.keys.admin });
    expect(del.status).toBe(200);
    expect((await call("GET", `/v1/roles/${key}`, { key: ws.keys.admin })).status).toBe(404);
    const archived = await call("GET", "/v1/roles?include_archived=true", { key: ws.keys.admin });
    expect(archived.json.data.find((r: { key: string }) => r.key === key).archived_at).not.toBeNull();
    expect((await auditActions("role.archived")).some((e) => e.record_id === decodeId(made.json.data.id)!.uuid)).toBe(true);
    // The key is free again.
    expect((await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key, name: "Reused", permissions: [] } })).status).toBe(201);
  });

  it("permissions that reach record data need the record permissions they reach", async () => {
    const perms = (await call("GET", "/v1/permissions", { key: ws.keys.ops })).json.data as { key: string; requires: string[] }[];
    const req = Object.fromEntries(perms.map((p) => [p.key, p.requires]));
    expect(req).toMatchObject({ "automations:manage": ["records:read", "records:write", "records:archive"], "webhooks:manage": ["records:read"],
      "alerts:manage": ["records:read"], "records:read": [] });
    for (const [permissions, missing] of [
      [["automations:manage"], ["records:read", "records:write", "records:archive"]],
      [["automations:manage", "records:read"], ["records:write", "records:archive"]],
      [["webhooks:manage"], ["records:read"]],
      [["alerts:manage", "audit:read"], ["records:read"]],
    ] as const) {
      const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: slug("r"), name: "x", permissions } });
      expect(r.status, JSON.stringify(permissions)).toBe(422);
      expect(r.json.errors).toEqual({ missing });
      expect(r.json.detail).toContain(missing.join(", "));
    }
    // Copying a role and editing one go through the same check.
    const ok = await role(["records:read", "webhooks:manage", "alerts:manage"]);
    expect((await call("PATCH", `/v1/roles/${ok.key}`, { key: ws.keys.admin, body: { permissions: ["webhooks:manage"] } })).status).toBe(422);
    expect((await call("PATCH", `/v1/roles/${ok.key}`, { key: ws.keys.admin, body: { permissions: ["records:read", "records:write", "records:archive", "automations:manage"] } })).status).toBe(200);
    // The database refuses it too.
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      await tx`UPDATE roles SET permissions = '{automations:manage, records:read}' WHERE id = ${decodeId(ok.id)!.uuid}`;
    })).rejects.toThrow(/roles_permission_requires/);
  });

  it("system roles can't be edited or archived", async () => {
    expect((await call("PATCH", "/v1/roles/member", { key: ws.keys.admin, body: { permissions: ["records:read"] } })).status).toBe(403);
    expect((await call("DELETE", "/v1/roles/read_only", { key: ws.keys.admin })).status).toBe(403);
  });
});

describe("permissions decide access", () => {
  it("/v1/me reports role and effective permissions", async () => {
    const me = await call("GET", "/v1/me", { key: ws.keys.ops });
    expect(me.json.role).toBe("owner");
    expect(me.json.permissions.sort()).toEqual(["records:archive", "records:read", "records:write", "views:manage"]);
    expect(me.json.scopes.sort()).toEqual(["ops:read", "ops:write"]);
  });

  it("a custom role limited to records:read cannot write", async () => {
    const r = await role(["records:read"]);
    const m = await memberWithKey(ws, r.key, ["ops:read"]);
    expect((await call("GET", "/v1/objects/contact/records", { key: m.key })).status).toBe(200);
    expect((await call("POST", "/v1/objects/contact/records", { key: m.key, body: { email: uniqueEmail("x") } })).status).toBe(403);
    // Nor can it be given a write key: the role can't use the scope.
    expect((await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "w", scopes: ["ops:write"], owner: m.id } })).status).toBe(403);
  });

  it("archiving a record needs records:archive, not just records:write", async () => {
    const r = await role(["records:read", "records:write"]);
    const m = await memberWithKey(ws, r.key, ["ops:write", "ops:read"]);
    const acct = await create(m.key, "account", { name: "Keep me" });
    expect((await call("DELETE", `/v1/objects/account/records/${acct.id}`, { key: m.key })).status).toBe(403);
    expect((await call("DELETE", `/v1/objects/account/records/${acct.id}`, { key: ws.keys.ops })).status).toBe(200);
  });

  it("a role change takes effect on the next request, with the same key", async () => {
    const m = await memberWithKey(ws, "member", ["ops:write", "ops:read"]);
    expect((await call("POST", "/v1/objects/account/records", { key: m.key, body: { name: "Before" } })).status).toBe(201);
    const demote = await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { role: "read_only" } });
    expect(demote.status).toBe(200);
    expect(demote.json.data.role).toBe("read_only");
    expect((await call("POST", "/v1/objects/account/records", { key: m.key, body: { name: "After" } })).status).toBe(403);
    expect((await call("GET", "/v1/me", { key: m.key })).json.permissions).toEqual(["records:read"]);
    expect((await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { role: "member" } })).status).toBe(200);
    expect((await call("POST", "/v1/objects/account/records", { key: m.key, body: { name: "Again" } })).status).toBe(201);
    const changed = (await auditActions("member.role_changed")).find((e) => e.record_id === decodeId(m.id)!.uuid)!;
    expect(changed.details).toMatchObject({ from: "read_only", to: "member" });
  });

  it("editing a custom role changes its holders' access immediately; a key with no permissions left can do nothing", async () => {
    const r = await role(["records:read"]);
    const m = await memberWithKey(ws, r.key, ["ops:read"]);
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(200);
    expect((await call("PATCH", `/v1/roles/${r.key}`, { key: ws.keys.admin, body: { permissions: [] } })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(403);
    expect((await call("GET", "/v1/openapi.json", { key: m.key })).status).toBe(403);
    expect((await call("GET", "/v1/objects/contact/records", { key: m.key })).status).toBe(403);
  });

  it("disabling a member revokes their keys and blocks authentication; re-enabling doesn't bring keys back", async () => {
    const m = await memberWithKey(ws, "member", ["ops:read"]);
    const second = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "second", scopes: ["ops:write"], owner: m.id } });
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(200);
    const off = await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { active: false } });
    expect(off.status).toBe(200);
    expect(off.json.data).toMatchObject({ active: false, keys_revoked: 2 });
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: second.json.data.secret })).status).toBe(401);
    const review = await call("GET", "/v1/access-review", { key: ws.keys.admin });
    const entry = review.json.data.members.find((x: { id: string }) => x.id === m.id);
    expect(entry.active).toBe(false);
    expect(entry.keys).toHaveLength(2);
    expect(entry.keys.every((k: { revoked_at: string | null; usable: boolean }) => k.revoked_at && !k.usable)).toBe(true);
    const disabled = (await auditActions("member.disabled")).find((e) => e.record_id === decodeId(m.id)!.uuid)!;
    expect(disabled.details).toMatchObject({ keys_revoked: 2 });
    expect((await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { active: true } })).json.data.active).toBe(true);
    expect((await call("GET", "/v1/me", { key: m.key })).status).toBe(401);
  });

  it("disabling a service account revokes its keys", async () => {
    const svc = await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: slug("bot"), role: "member" } });
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "bot", scopes: ["ops:read"], owner: svc.json.data.id } });
    expect((await call("GET", "/v1/me", { key: k.json.data.secret })).status).toBe(200);
    expect((await call("PATCH", `/v1/members/${svc.json.data.id}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(404);
    expect((await call("PATCH", `/v1/service-accounts/${svc.json.data.id}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: k.json.data.secret })).status).toBe(401);
  });

  it("the access review lists every member with role, permissions and keys, and needs audit:read", async () => {
    const r = await call("GET", "/v1/access-review", { key: ws.keys.admin });
    expect(r.status).toBe(200);
    const owner = r.json.data.members.find((x: { id: string }) => x.id === ws.ownerId);
    expect(owner).toMatchObject({ type: "user", active: true, role: { key: "owner", name: "Owner" } });
    expect(owner.permissions).toContain("audit:read");
    expect(owner.keys.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(owner.keys[0]).sort()).toEqual(["created_at", "environment", "expires_at", "id", "last_used_at", "name", "revoked_at", "scopes", "usable"]);
    expect(JSON.stringify(r.json)).not.toMatch(/hlcrm_(live|test)_/);
    const r2 = await role(["members:manage", "records:read"]);
    const m = await memberWithKey(ws, r2.key, ["admin", "ops:read"]);
    expect((await call("GET", "/v1/access-review", { key: m.key })).status).toBe(403);
    const list = await call("GET", "/v1/members", { key: m.key });
    expect(list.json.data.users.find((u: { id: string }) => u.id === m.id)).toMatchObject({ role: r2.key, role_name: "Custom", active: true });
  });
});

describe("privilege escalation rules", () => {
  /** A member who can manage roles and members, but holds neither audit:read nor keys:manage. */
  let mgr: { id: string; key: string; keyId: string };
  let mgrRole: { key: string };
  beforeAll(async () => {
    mgrRole = await role(["roles:manage", "members:manage", "records:read"]);
    mgr = await memberWithKey(ws, mgrRole.key, ["admin", "ops:read"]);
  });

  it("can't create a role with a permission the caller doesn't hold", async () => {
    const bad = await call("POST", "/v1/roles", { key: mgr.key, body: { key: slug("r"), name: "x", permissions: ["records:read", "audit:read"] } });
    expect(bad.status).toBe(403);
    expect((await call("POST", "/v1/roles", { key: mgr.key, body: { key: slug("r"), name: "x", copy_from: "admin" } })).status).toBe(403);
    expect((await call("POST", "/v1/roles", { key: mgr.key, body: { key: slug("r"), name: "x", permissions: ["records:read"] } })).status).toBe(201);
  });

  it("can't edit a role to add a permission the caller doesn't hold", async () => {
    const r = await call("POST", "/v1/roles", { key: mgr.key, body: { key: slug("r"), name: "x", permissions: ["records:read"] } });
    expect((await call("PATCH", `/v1/roles/${r.json.data.key}`, { key: mgr.key, body: { permissions: ["records:read", "keys:manage"] } })).status).toBe(403);
    // Nor edit a role that already holds more than the caller.
    const big = await role(["records:read", "audit:read"]);
    expect((await call("PATCH", `/v1/roles/${big.key}`, { key: mgr.key, body: { permissions: ["records:read"] } })).status).toBe(403);
  });

  it("can't edit (or archive) a role the caller holds", async () => {
    expect((await call("PATCH", `/v1/roles/${mgrRole.key}`, { key: mgr.key, body: { permissions: ["roles:manage", "members:manage"] } })).status).toBe(403);
    expect((await call("DELETE", `/v1/roles/${mgrRole.key}`, { key: mgr.key })).status).toBe(403);
  });

  it("can't assign a role the caller doesn't fully hold, when adding or changing a member", async () => {
    expect((await call("POST", "/v1/members", { key: mgr.key, body: { email: uniqueEmail("e"), name: "E", role: "admin" } })).status).toBe(403);
    expect((await call("POST", "/v1/service-accounts", { key: mgr.key, body: { name: slug("svc"), role: "member" } })).status).toBe(403);
    const plain = await call("POST", "/v1/members", { key: mgr.key, body: { email: uniqueEmail("p"), name: "P", role: "read_only" } });
    // read_only includes restricted:read, which mgr lacks.
    expect(plain.status).toBe(403);
    const lesser = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("l"), name: "L", role: (await role(["records:read"])).key } });
    expect((await call("PATCH", `/v1/members/${lesser.json.data.id}`, { key: mgr.key, body: { role: "admin" } })).status).toBe(403);
    expect((await call("PATCH", `/v1/members/${lesser.json.data.id}`, { key: mgr.key, body: { role: mgrRole.key } })).status).toBe(200);
  });

  it("can't change or disable a member who holds more than the caller", async () => {
    const admin = await memberWithKey(ws, "admin", ["ops:read"]);
    expect((await call("PATCH", `/v1/members/${admin.id}`, { key: mgr.key, body: { active: false } })).status).toBe(403);
  });

  it("nobody can change their own role or disable themselves", async () => {
    expect((await call("PATCH", `/v1/members/${ws.ownerId}`, { key: ws.keys.admin, body: { role: "admin" } })).status).toBe(403);
    expect((await call("PATCH", `/v1/members/${ws.ownerId}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(403);
    expect((await call("PATCH", `/v1/members/${mgr.id}`, { key: mgr.key, body: { role: "read_only" } })).status).toBe(403);
  });

  it("only an owner can assign the owner role", async () => {
    const admin = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await call("POST", "/v1/members", { key: admin.key, body: { email: uniqueEmail("o"), name: "O", role: "owner" } })).status).toBe(403);
    const target = await memberWithKey(ws, "member", ["ops:read"]);
    expect((await call("PATCH", `/v1/members/${target.id}`, { key: admin.key, body: { role: "owner" } })).status).toBe(403);
    expect((await call("POST", "/v1/service-accounts", { key: ws.keys.admin, body: { name: slug("svc"), role: "owner" } })).status).toBe(422);
    const byOwner = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("o"), name: "O", role: "owner" } });
    expect(byOwner.status).toBe(201);
  });

  it("only an owner can change or disable an owner", async () => {
    const admin = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await call("PATCH", `/v1/members/${ws.ownerId}`, { key: admin.key, body: { active: false } })).status).toBe(403);
    expect((await call("PATCH", `/v1/members/${ws.ownerId}`, { key: admin.key, body: { role: "admin" } })).status).toBe(403);
  });

  it("only an owner can create, rotate or revoke an owner's keys", async () => {
    const admin = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await call("POST", "/v1/api-keys", { key: admin.key, body: { name: "x", scopes: ["ops:read"], owner: ws.ownerId } })).status).toBe(403);
    const ownerKey = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "owner spare", scopes: ["ops:read"] } });
    expect((await call("POST", `/v1/api-keys/${ownerKey.json.data.id}/rotate`, { key: admin.key, body: {} })).status).toBe(403);
    expect((await call("POST", `/v1/api-keys/${ownerKey.json.data.id}/revoke`, { key: admin.key })).status).toBe(403);
    expect((await call("GET", "/v1/me", { key: ownerKey.json.data.secret })).status).toBe(200);
    expect((await call("POST", `/v1/api-keys/${ownerKey.json.data.id}/revoke`, { key: ws.keys.admin })).status).toBe(200);
  });

  it("the last active owner can't be demoted or disabled", async () => {
    const solo = await newWorkspace("Solo");
    // Through the API nobody but another owner can target an owner, and nobody can target themselves,
    // so check the rule in the service layer with a system context.
    const ctx = systemCtx(solo.tenantId, "test");
    await expect(withTenant(solo.tenantId, (tx) => updateMember(tx, ctx, solo.ownerId, { active: false }))).rejects.toMatchObject({ status: 409 });
    await expect(withTenant(solo.tenantId, (tx) => updateMember(tx, ctx, solo.ownerId, { role: "admin" }))).rejects.toMatchObject({ status: 409 });
  });

  it("two owners demoting each other at once leaves one owner", async () => {
    const duo = await newWorkspace("Duo");
    const second = await call("POST", "/v1/members", { key: duo.keys.admin, body: { email: uniqueEmail("o2"), name: "O2", role: "owner" } });
    const k = await call("POST", "/v1/api-keys", { key: duo.keys.admin, body: { name: "o2", scopes: ["admin", "ops:write", "ops:read", "restricted:read"], owner: second.json.data.id } });
    const [a, b] = await Promise.all([
      call("PATCH", `/v1/members/${second.json.data.id}`, { key: duo.keys.admin, body: { role: "admin" } }),
      call("PATCH", `/v1/members/${duo.ownerId}`, { key: k.json.data.secret, body: { role: "admin" } }),
    ]);
    // One wins; the other is refused (403 once it's no longer an owner, 409 as last owner or on deadlock).
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const members = await call("GET", "/v1/members", { key: duo.keys.admin });
    expect(members.json.data.users.filter((u: { role: string; active: boolean }) => u.role === "owner" && u.active).length).toBeGreaterThanOrEqual(1);
  });

  it("a key with only the admin scope can't mint a broader key", async () => {
    const adminOnly = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "admin only", scopes: ["admin"] } });
    const k = adminOnly.json.data.secret;
    for (const scopes of [["restricted:read"], ["ops:write"], ["ops:read"], ["admin", "ops:write", "ops:read", "restricted:read"]]) {
      const r = await call("POST", "/v1/api-keys", { key: k, body: { name: "broader", scopes } });
      expect(r.status, JSON.stringify(scopes)).toBe(403);
    }
    expect((await call("POST", "/v1/api-keys", { key: k, body: { name: "same", scopes: ["admin"] } })).status).toBe(201);
    // Rotating a broader key goes through the same check.
    const broad = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "broad", scopes: ["ops:write", "restricted:read"] } });
    expect((await call("POST", `/v1/api-keys/${broad.json.data.id}/rotate`, { key: k, body: {} })).status).toBe(403);
  });

  it("keys for another member need keys:manage and the caller must hold all of that member's permissions", async () => {
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    // An admin-scope-only key holds no records permissions, so it can't act for a reader.
    const adminOnly = (await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "admin only 2", scopes: ["admin"] } })).json.data.secret;
    expect((await call("POST", "/v1/api-keys", { key: adminOnly, body: { name: "x", scopes: ["admin"], owner: reader.id } })).status).toBe(403);
    expect((await call("POST", `/v1/api-keys/${reader.keyId}/rotate`, { key: adminOnly, body: {} })).status).toBe(403);
    expect((await call("POST", `/v1/api-keys/${reader.keyId}/revoke`, { key: adminOnly })).status).toBe(403);
    // Without keys:manage (mgr) the routes are closed.
    expect((await call("POST", "/v1/api-keys", { key: mgr.key, body: { name: "x", scopes: ["ops:read"], owner: reader.id } })).status).toBe(403);
    expect((await call("POST", `/v1/api-keys/${reader.keyId}/revoke`, { key: mgr.key })).status).toBe(403);
    // A full admin can.
    const rot = await call("POST", `/v1/api-keys/${reader.keyId}/rotate`, { key: ws.keys.admin, body: { overlap_hours: 0 } });
    expect(rot.status).toBe(200);
  });

  it("a rotated key keeps the old key's expiry", async () => {
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "short lived", scopes: ["ops:read"], expires_in_days: 3 } });
    const rot = await call("POST", `/v1/api-keys/${k.json.data.id}/rotate`, { key: ws.keys.admin, body: { overlap_hours: 1 } });
    expect(rot.status).toBe(200);
    expect(rot.json.data.expires_at).toBe(k.json.data.expires_at);
    const listed = (await call("GET", "/v1/api-keys", { key: ws.keys.admin })).json.data.find((x: { id: string }) => x.id === rot.json.data.id);
    expect(listed.expires_at).toBe(k.json.data.expires_at);
  });

  it("listing all keys needs keys:manage", async () => {
    expect((await call("GET", "/v1/api-keys", { key: mgr.key })).status).toBe(403);
    expect((await call("GET", "/v1/api-keys", { key: ws.keys.admin })).status).toBe(200);
  });
});

describe("idempotency never stores secrets", () => {
  it("strips API key and webhook secrets from stored responses and says so on replay", async () => {
    const idem = `idem-key-${Date.now()}`;
    const body = { name: "idem key", scopes: ["ops:read"] };
    const first = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body, headers: { "Idempotency-Key": idem } });
    expect(first.status).toBe(201);
    const secret = first.json.data.secret as string;
    expect(secret).toMatch(/^hlcrm_live_/);
    const replay = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body, headers: { "Idempotency-Key": idem } });
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json.data.id).toBe(first.json.data.id);
    expect(replay.json.data.secret).toBeUndefined();
    expect(replay.json.data.secret_omitted).toMatch(/only in the first response/);

    const hookIdem = `idem-hook-${Date.now()}`;
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: "https://idem.example/hook", events: ["contact.*"] }, headers: { "Idempotency-Key": hookIdem } });
    expect(hook.status).toBe(201);
    const whsec = hook.json.data.secret as string;
    expect(whsec).toMatch(/^whsec_/);
    const hookReplay = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: "https://idem.example/hook", events: ["contact.*"] }, headers: { "Idempotency-Key": hookIdem } });
    expect(hookReplay.json.data.secret).toBeUndefined();

    // The declared responses allow for the replay: `secret` is not required, and the note is declared.
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const declared = (path: string) => (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[path]!.post!.responses["201"]!.content["application/json"]!.schema;
    for (const [path, res] of [["/v1/api-keys", first], ["/v1/api-keys", replay], ["/v1/webhooks", hook], ["/v1/webhooks", hookReplay]] as const) {
      expect(validate(doc, declared(path), res.json), `${path} ${res.headers.get("idempotent-replayed") ?? "first"}`).toEqual([]);
    }

    const stored = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ response: unknown }[]>`SELECT response FROM idempotency_keys WHERE idem_key IN (${idem}, ${hookIdem})`;
    });
    expect(stored).toHaveLength(2);
    const text = JSON.stringify(stored);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(whsec);
    expect(text).not.toMatch(/hlcrm_live_|whsec_/);
  });

  it("stores restricted values encrypted, replays them to the same key, and refuses a replay once the key's permissions changed", async () => {
    const field = `passport_${Date.now().toString(36)}`;
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: field, type: "text", sensitivity: "restricted" } })).status).toBe(201);
    const idem = `idem-restricted-${Date.now()}`;
    const body = { first_name: "Rae", email: uniqueEmail("rae"), [field]: "PX-4455-SECRET" };
    const first = await call("POST", "/v1/objects/contact/records", { key: ws.keys.admin, body, headers: { "Idempotency-Key": idem } });
    expect(first.status).toBe(201);
    expect(first.json.data[field]).toBe("PX-4455-SECRET");
    const [stored] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ response: string }[]>`SELECT response::text AS response FROM idempotency_keys WHERE idem_key = ${idem}`;
    });
    expect(stored!.response).not.toContain("PX-4455-SECRET");
    expect(stored!.response).not.toContain(first.json.data.id); // the whole body is sealed, not just restricted values
    const replay = await call("POST", "/v1/objects/contact/records", { key: ws.keys.admin, body, headers: { "Idempotency-Key": idem } });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.json).toEqual(first.json);

    // The same key, after its member lost restricted:read, gets no replay.
    const m = await memberWithKey(ws, "member", ["ops:write", "ops:read", "restricted:read"]);
    const idem2 = `idem-restricted-2-${Date.now()}`;
    const body2 = { first_name: "Ray", email: uniqueEmail("ray"), [field]: "PX-9999-SECRET" };
    expect((await call("POST", "/v1/objects/contact/records", { key: m.key, body: body2, headers: { "Idempotency-Key": idem2 } })).json.data[field]).toBe("PX-9999-SECRET");
    const plain = await role(["records:read", "records:write", "records:archive"]);
    expect((await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { role: plain.key } })).status).toBe(200);
    const refused = await call("POST", "/v1/objects/contact/records", { key: m.key, body: body2, headers: { "Idempotency-Key": idem2 } });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("idempotency_not_replayable");
    expect(refused.json.detail).toMatch(/already applied/);
    expect(JSON.stringify(refused.json)).not.toContain("PX-9999-SECRET");
  });
});

describe("failed authentication is rate limited before the database", () => {
  const prior = process.env.TRUST_PROXY;
  afterEach(() => {
    if (prior === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prior;
    resetAuthLimiter();
  });

  /** Well formed, never valid. Each has its own lookup prefix, so only the address limit applies. */
  const unseen = (i: number) => `hlcrm_live_${String(i).padStart(12, "Q")}${"Z".repeat(40)}`;

  it("per client address: malformed keys are refused outright, well-formed ones get a small lookup budget", async () => {
    process.env.TRUST_PROXY = "true";
    resetAuthLimiter({ blockedPerSecond: 0 });
    const from = (ip: string) => ({ "X-Forwarded-For": `198.51.100.7, ${ip}` });
    for (let i = 0; i < 30; i++) {
      expect((await call("GET", "/v1/me", { key: `bogus-${i}`, headers: from("203.0.113.9") })).status).toBe(401);
    }
    const limited = await call("GET", "/v1/me", { key: "bogus-again", headers: from("203.0.113.9") });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Well-formed keys still reach the database, but only a burst of 10 from a blocked address.
    const statuses = [];
    for (let i = 0; i < 15; i++) statuses.push((await call("GET", "/v1/me", { key: unseen(i), headers: from("203.0.113.9") })).status);
    expect(statuses).toEqual([...Array(10).fill(401), ...Array(5).fill(429)]);
    // Another address (the last X-Forwarded-For hop is the trusted one) is unaffected.
    expect((await call("GET", "/v1/me", { key: unseen(99), headers: from("203.0.113.10") })).status).toBe(401);
  });

  it("a valid key that has never authenticated still gets through a blocked address", async () => {
    process.env.TRUST_PROXY = "true";
    const fresh = await memberWithKey(ws, "read_only", ["ops:read"]);
    resetAuthLimiter(); // as after a restart: nothing is known to be good
    const from = { "X-Forwarded-For": "203.0.113.60" };
    for (let i = 0; i < 30; i++) await call("GET", "/v1/me", { key: `bogus-${i}`, headers: from });
    expect((await call("GET", "/v1/me", { key: "bogus-more", headers: from })).status).toBe(429);
    expect((await call("GET", "/v1/me", { key: fresh.key, headers: from })).status).toBe(200);
  });

  it("a blocked address does not lock out keys that authenticated recently, until they fail", async () => {
    process.env.TRUST_PROXY = "true";
    resetAuthLimiter({ blockedPerSecond: 0 });
    const k = await memberWithKey(ws, "read_only", ["ops:read"]);
    const from = { "X-Forwarded-For": "203.0.113.50" };
    expect((await call("GET", "/v1/me", { key: k.key, headers: from })).status).toBe(200);
    for (let i = 0; i < 30; i++) await call("GET", "/v1/me", { key: `bogus-${i}`, headers: from });
    for (let i = 0; i < 10; i++) expect((await call("GET", "/v1/me", { key: unseen(i), headers: from })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: unseen(10), headers: from })).status).toBe(429); // budget spent
    expect((await call("GET", "/v1/me", { key: k.key, headers: from })).status).toBe(200); // known good: no budget needed
    // Once that key fails (here: revoked) it is no longer trusted, and waits for the budget like any other.
    expect((await call("POST", `/v1/api-keys/${k.keyId}/revoke`, { key: ws.keys.admin })).status).toBe(200);
    expect((await call("GET", "/v1/me", { key: k.key, headers: from })).status).toBe(401);
    expect((await call("GET", "/v1/me", { key: k.key, headers: from })).status).toBe(429);
  });

  it("ignores X-Forwarded-For unless TRUST_PROXY is set", async () => {
    delete process.env.TRUST_PROXY;
    for (let i = 0; i < 30; i++) await call("GET", "/v1/me", { key: `bogus-${i}`, headers: { "X-Forwarded-For": `192.0.2.${i}` } });
    expect((await call("GET", "/v1/me", { key: "bogus-x", headers: { "X-Forwarded-For": "192.0.2.200" } })).status).toBe(429);
  });

  it("per key lookup prefix", async () => {
    process.env.TRUST_PROXY = "true";
    const lookup = ws.keys.ops.slice("hlcrm_live_".length, "hlcrm_live_".length + 12);
    const guess = (i: number) => `hlcrm_live_${lookup}${String(i).padStart(40, "A")}`;
    for (let i = 0; i < 10; i++) {
      expect((await call("GET", "/v1/me", { key: guess(i), headers: { "X-Forwarded-For": `203.0.113.${i + 20}` } })).status).toBe(401);
    }
    expect((await call("GET", "/v1/me", { key: guess(99), headers: { "X-Forwarded-For": "203.0.113.99" } })).status).toBe(429);
  });
});

describe("route permissions", () => {
  it("every route resolves to a permission; admin routes never fall through", () => {
    const unresolved = routes.filter((r) => requiredPermission(r) === null).map((r) => `${r.method} ${r.path}`);
    expect(unresolved).toEqual([]);
    const adminTagged = routes.filter((r) => r.scope === "admin" && r.tag === "admin" && !r.permission).map((r) => `${r.method} ${r.path}`);
    expect(adminTagged).toEqual([]);
    const anyRoutes = routes.filter((r) => requiredPermission(r) === "any").map((r) => `${r.method} ${r.path}`).sort();
    // Only identity and catalogue routes (scope "any") admit any permission; a route can't opt into that with `permission`.
    expect(anyRoutes).toEqual(["GET /v1/me", "GET /v1/me/access", "GET /v1/me/preferences", "GET /v1/permission-sets", "GET /v1/permission-sets/:id",
      "GET /v1/permission-sets/:id/access", "GET /v1/permissions", "GET /v1/roles", "GET /v1/roles/:id",
      "GET /v1/roles/:id/access", "POST /v1/automations/:id/run", "PUT /v1/me/preferences"]);
    expect(routes.filter((r) => (r.permission as unknown) === "any")).toEqual([]);
    // Schema packs need one of the three manage permissions at the gate, then one per part in the handler (core/packs.ts).
    for (const r of routes.filter((x) => x.tag === "packs")) expect(requiredPermission(r), `${r.method} ${r.path}`).toEqual(["schema:manage", "roles:manage", "views:manage"]);
    const of = (m: string, p: string) => requiredPermission(routes.find((r) => r.method === m && r.path === p)!);
    expect(of("DELETE", "/v1/objects/:object/records/:id")).toBe("records:archive");
    expect(of("GET", "/v1/schema/changes")).toBe("audit:read");
    expect(of("POST", "/v1/api-keys")).toBe("keys:manage");
    expect(of("GET", "/v1/audit-log")).toBe("audit:read");
    expect(of("POST", "/v1/webhooks")).toBe("webhooks:manage");
    expect(of("POST", "/v1/objects")).toBe("schema:manage");
  });

  it("the ops MCP surface still can't call admin routes, and the admin surface needs the admin scope", async () => {
    expect((await call("GET", "/v1/members", { key: ws.keys.admin, headers: { "X-HLCRM-Surface": "ops-mcp" } })).status).toBe(403);
    expect((await call("GET", "/v1/objects", { key: ws.keys.ops, headers: { "X-HLCRM-Surface": "admin-mcp" } })).status).toBe(403);
  });
});

describe("roles are isolated by tenant", () => {
  it("a tenant can't see, copy or assign another tenant's role", async () => {
    const other = await newWorkspace("Other");
    const theirs = (await call("POST", "/v1/roles", { key: other.keys.admin, body: { key: slug("theirs"), name: "Theirs", permissions: ["records:read"] } })).json.data;
    expect((await call("GET", `/v1/roles/${theirs.id}`, { key: ws.keys.admin })).status).toBe(404);
    expect((await call("GET", `/v1/roles/${theirs.key}`, { key: ws.keys.admin })).status).toBe(404);
    expect((await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("x"), name: "X", role: theirs.id } })).status).toBe(404);
    const list = await call("GET", "/v1/roles?include_archived=true", { key: ws.keys.admin });
    expect(JSON.stringify(list.json)).not.toContain(theirs.id);
  });

  it("in SQL, RLS hides other tenants' roles, WITH CHECK refuses writing them, and the FK refuses assigning them", async () => {
    const other = await newWorkspace("Other SQL");
    const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
      sql.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
        return fn(tx);
      }) as Promise<T>;
    const [theirs] = await inTenant(other.tenantId, (tx) => tx<{ id: string }[]>`SELECT id FROM roles WHERE key = 'admin'`);
    const seen = await inTenant(ws.tenantId, (tx) => tx`SELECT id FROM roles WHERE id = ${theirs!.id}`);
    expect(seen).toHaveLength(0);
    await expect(inTenant(ws.tenantId, (tx) => tx`
      INSERT INTO roles (tenant_id, id, key, name, permissions) VALUES (${other.tenantId}, gen_random_uuid(), 'sneaky', 'S', '{}')`))
      .rejects.toThrow(/row-level security/);
    const owner = decodeId(ws.ownerId)!.uuid;
    await expect(inTenant(ws.tenantId, (tx) => tx`UPDATE users SET role_id = ${theirs!.id} WHERE id = ${owner}`)).rejects.toThrow(/foreign key/);
    await expect(inTenant(ws.tenantId, (tx) => tx`UPDATE roles SET permissions = '{records:read, everything}' WHERE key = 'member'`)).rejects.toThrow(/check constraint/);
    const updated = await inTenant(ws.tenantId, (tx) => tx`UPDATE roles SET name = 'x' WHERE id = ${theirs!.id} RETURNING id`);
    expect(updated).toHaveLength(0);
  });
});
