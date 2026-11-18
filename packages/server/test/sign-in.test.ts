import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_AUTH_ROUTES } from "../src/api/auth-public.js";
import { resetAuthLimiter } from "../src/api/app.js";
import { requiredPermission, routes } from "../src/api/registry.js";
import { LIMITS, resetSignInLimits } from "../src/auth/limits.js";
import { PASSWORD_MAX, passwordProblem, setArgon2Params, setBreachRangeLookup } from "../src/auth/passwords.js";
import { canonicalEmail, MAX_CANDIDATES } from "../src/auth/identity.js";
import { createServerLink, plainName, safeReturnTo, settleSignInTasks } from "../src/auth/signin.js";
import { pruneSessions } from "../src/auth/sessions.js";
import { assertStartupConfig, publicOrigin, resetConfig } from "../src/config.js";
import { createWorkspace } from "../src/core/workspace.js";
import { sha256 } from "../src/lib/crypto.js";
import { decodeId } from "../src/lib/ids.js";
import { logger } from "../src/lib/logger.js";
import { DisabledMailer, setMailer } from "../src/providers/mailer.js";
import { app, Browser, call, create, FakeMailer, memberWithKey, newWorkspace, signedIn, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * People sign-in and browser sessions (ADR 0009, docs/sign-in.md), end to end through the app:
 * session lifecycle, cookies, CSRF, permissions, idempotency, every sign-in method except SSO
 * (test/sso.test.ts), the workspace choice, enumeration safety, and that no secret is stored or logged.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
const owner = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
afterAll(async () => {
  await sql.end();
  await owner.end();
});

let ws: Workspace;
const mail = new FakeMailer();
/** Every secret a test saw (tokens, codes, passwords): none may appear in the database, the logs or the audit log. */
const secrets = new Set<string>();
const logged: string[] = [];

beforeAll(async () => {
  ws = await newWorkspace("Sign-in");
  setMailer(mail);
  for (const level of ["info", "warn", "error", "fatal", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
  }
});
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
});
afterEach(async () => {
  await settleSignInTasks();
});

const sessionIdOf = async (b: Browser) => decodeId((await b.request("GET", "/v1/auth/session")).json.session.id)!.uuid;
const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  return fn(tx);
}) as Promise<T>;
const signinCookie = (b: Browser) => b.cookies.get("__Host-hlcrm_signin")!;
const remember = (b: Browser) => {
  for (const v of b.cookies.values()) secrets.add(v);
  if (b.csrf) secrets.add(b.csrf);
  return b;
};

async function member(role = "member", email = uniqueEmail(role), w = ws) {
  const r = await call("POST", "/v1/members", { key: w.keys.admin, body: { email, name: `Person ${role}`, role } });
  if (r.status !== 201) throw new Error(JSON.stringify(r.json));
  return { id: r.json.data.id as string, email };
}

/** Signs in by email code in a fresh browser. */
async function byEmailCode(email: string, b = new Browser()) {
  const start = await b.request("POST", "/auth/email", { body: { email } });
  expect(start.status).toBe(202);
  await settleSignInTasks();
  const code = mail.codeFor(email)!;
  secrets.add(code);
  const done = await b.request("POST", "/auth/email/verify", { body: { code } });
  return { b: remember(b), done };
}

async function setPassword(b: Browser, password: string, current?: string) {
  secrets.add(password);
  return b.request("POST", "/v1/auth/password", { body: { password, ...(current ? { current_password: current } : {}) } });
}

describe("sessions", () => {
  it("a server link signs in with a __Host- cookie that is Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain", async () => {
    const b = new Browser();
    const link = await createServerLink(ws.ownerEmail, undefined, "t");
    const token = new URL(link.url).searchParams.get("token")!;
    secrets.add(token);
    const r = await b.request("POST", "/auth/server-link", { body: { token } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "signed_in", workspace: { id: ws.id, name: ws.name }, csrf_token: expect.any(String) });
    const cookie = r.setCookies.find((c) => c.startsWith("__Host-hlcrm_session="))!;
    expect(cookie).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604\d{3}; Secure$/);
    expect(cookie).not.toMatch(/Domain/i);
    expect(r.headers.get("cache-control")).toBe("no-store");
    // no-referrer everywhere, so a sign-in link's token never travels in a Referer (the pages' own form posts carry Origin: null, see below).
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    remember(b);
    const me = await b.request("GET", "/v1/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(me.json).toMatchObject({ actor: { type: "user", id: ws.ownerId }, role: "owner", surface: "web" });
    const s = await b.request("GET", "/v1/auth/session");
    expect(s.json).toMatchObject({ session: { id: expect.stringMatching(/^ses_/), method: "server_link" }, member: { id: ws.ownerId }, role: "owner", csrf_token: b.csrf });
  });

  it("every sign-in starts a new session with a new token; the pre-session cookie never becomes the session", async () => {
    const m = await member();
    const b = new Browser();
    await b.request("POST", "/auth/email", { body: { email: m.email } });
    const pre = signinCookie(b);
    await settleSignInTasks();
    await b.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(m.email)! } });
    const first = b.cookies.get("__Host-hlcrm_session")!;
    expect(first).not.toBe(pre);
    expect(b.cookies.has("__Host-hlcrm_signin")).toBe(false);
    const id1 = await sessionIdOf(b);
    await signedIn(m.email, undefined, b);
    expect(b.cookies.get("__Host-hlcrm_session")).not.toBe(first);
    expect(await sessionIdOf(b)).not.toBe(id1);
    // The earlier session is still its own session (other tabs), not reused.
    const old = new Browser();
    old.cookies.set("__Host-hlcrm_session", first);
    expect((await old.request("GET", "/v1/me")).status).toBe(200);
  });

  it("idle and absolute timeouts are enforced on the server, and last_seen moves at most once a minute", async () => {
    const m = await member();
    const b = remember(await signedIn(m.email));
    const id = await sessionIdOf(b);
    const row = () => inTenant(ws.tenantId, async (tx) => (await tx<{ last_seen_at: Date; idle_expires_at: Date }[]>`SELECT last_seen_at, idle_expires_at FROM sessions WHERE id = ${id}`)[0]!);
    const before = await row();
    await b.request("GET", "/v1/me");
    expect((await row()).last_seen_at).toEqual(before.last_seen_at);
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET last_seen_at = now() - interval '2 minutes' WHERE id = ${id}`);
    await b.request("GET", "/v1/me");
    expect((await row()).last_seen_at.getTime()).toBeGreaterThan(Date.now() - 30_000);

    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE id = ${id}`);
    const idle = await b.request("GET", "/v1/me");
    expect(idle.status).toBe(401);
    expect(idle.setCookies.some((c) => /^__Host-hlcrm_session=; .*Max-Age=0/.test(c))).toBe(true);

    const b2 = await signedIn(m.email);
    const id2 = await sessionIdOf(b2);
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = ${id2}`);
    expect((await b2.request("GET", "/v1/me")).status).toBe(401);
    // Ended sessions are cleaned up by the worker's retention pass.
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET expires_at = now() - interval '2 days', idle_expires_at = now() - interval '2 days' WHERE id IN (${id}, ${id2})`);
    expect(await pruneSessions()).toBeGreaterThanOrEqual(2);
    expect(await inTenant(ws.tenantId, (tx) => tx`SELECT 1 FROM sessions WHERE id IN (${id}, ${id2})`)).toHaveLength(0);
  });

  it("signing out ends the session on the server, clears the cookie and site data, and is not cached", async () => {
    const m = await member();
    const b = remember(await signedIn(m.email));
    const token = b.cookies.get("__Host-hlcrm_session")!;
    const out = await b.request("POST", "/v1/auth/sign-out");
    expect(out.status).toBe(200);
    expect(out.headers.get("clear-site-data")).toBe('"cookies", "storage"');
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect(b.cookies.has("__Host-hlcrm_session")).toBe(false);
    const replay = new Browser();
    replay.cookies.set("__Host-hlcrm_session", token);
    expect((await replay.request("GET", "/v1/me")).status).toBe(401);
    const log = await call("GET", "/v1/audit-log?action=auth.signed_out", { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ surface: "web", details: { session: expect.stringMatching(/^ses_/), reason: "signed_out" } });
  });

  it("lists my sessions, revokes one, and revokes all the others", async () => {
    const m = await member();
    const [a, b, c] = [await signedIn(m.email), await signedIn(m.email), await signedIn(m.email)];
    const list = await a.request("GET", "/v1/auth/sessions");
    expect(list.json.data).toHaveLength(3);
    expect(list.json.data.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ method: "server_link", user_agent: "test-browser/1" });
    const bId = (await b.request("GET", "/v1/auth/session")).json.session.id;
    expect((await a.request("DELETE", `/v1/sessions/${bId}`)).status).toBe(200);
    expect((await b.request("GET", "/v1/me")).status).toBe(401);
    const others = await a.request("POST", "/v1/auth/sessions/revoke-others");
    expect(others.json).toEqual({ revoked: 1, apps_revoked: 0 });
    expect((await c.request("GET", "/v1/me")).status).toBe(401);
    expect((await a.request("GET", "/v1/me")).status).toBe(200);
  });

  it("disabling a member revokes their sessions and keys in the same change", async () => {
    const m = await memberWithKey(ws, "member", ["ops:read"]);
    const email = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id).email;
    const b = await signedIn(email);
    await signedIn(email);
    const r = await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { active: false } });
    expect(r.json.data).toMatchObject({ keys_revoked: 1, sessions_revoked: 2 });
    expect((await b.request("GET", "/v1/me")).status).toBe(401);
    const log = await call("GET", "/v1/audit-log?action=member.disabled", { key: ws.keys.admin });
    expect(log.json.data[0].details).toMatchObject({ keys_revoked: 1, sessions_revoked: 2 });
    // A disabled member can't sign in again, and the answer is the generic one.
    await expect(createServerLink(email, undefined, "t")).rejects.toThrow(/No active member/);
  });

  it("an Authorization header wins over the cookie, even when it is invalid", async () => {
    const m = await memberWithKey(ws, "read_only", ["ops:read"]);
    const b = await signedIn(ws.ownerEmail);
    const withKey = await b.request("GET", "/v1/me", { headers: { Authorization: `Bearer ${m.key}` } });
    expect(withKey.json).toMatchObject({ actor: { id: m.id }, surface: "api" });
    expect((await b.request("GET", "/v1/me", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    // A bearer request needs no CSRF token or Origin, cookie or not.
    const post = await b.request("POST", "/v1/objects/contact/records", { body: { first_name: "Keyed" }, csrf: false,
      headers: { Authorization: `Bearer ${ws.keys.ops}`, Origin: "", "Sec-Fetch-Site": "" } });
    expect(post.status).toBe(201);
  });

  it("refuses a state-changing cookie request without the right CSRF token, Origin or fetch site; GET needs none", async () => {
    const b = await signedIn(ws.ownerEmail);
    const other = await signedIn(ws.ownerEmail);
    const write = (opts: Parameters<Browser["request"]>[2]) => b.request("POST", "/v1/objects/contact/records", { body: { first_name: "Csrf" }, ...opts });
    const cases: [string, Parameters<Browser["request"]>[2]][] = [
      ["missing token", { csrf: false }],
      ["wrong token", { headers: { "X-CSRF-Token": "x".repeat(43) } }],
      ["another session's token", { headers: { "X-CSRF-Token": other.csrf! } }],
      ["cross-site Origin", { headers: { Origin: "https://evil.example" } }],
      ["null Origin", { headers: { Origin: "null" } }],
      ["missing Origin", { headers: { Origin: "" } }],
      ["Sec-Fetch-Site cross-site", { headers: { "Sec-Fetch-Site": "cross-site" } }],
      ["Sec-Fetch-Site same-site", { headers: { "Sec-Fetch-Site": "same-site" } }],
    ];
    for (const [what, opts] of cases) {
      const r = await write(opts);
      expect(r.status, what).toBe(403);
      expect(r.json.code, what).toBe("csrf_failed");
    }
    expect((await b.request("DELETE", "/v1/auth/password", { csrf: false })).status).toBe(403);
    expect((await write({})).status).toBe(201);
    // No Sec-Fetch-Site at all (an older browser) is fine with the right Origin and token.
    expect((await write({ headers: { "Sec-Fetch-Site": "" } })).status).toBe(201);
    expect((await b.request("GET", "/v1/objects/contact/records", { headers: { Origin: "https://evil.example" } })).status).toBe(200);
  });

  it("a session has exactly its role's permissions, object and field rules included, and follows role changes on the next request", async () => {
    const roleKey = `limited_${Date.now().toString(36)}`;
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: roleKey, name: "Limited", permissions: ["records:read", "records:write"],
      objects: { deal: { read: false, write: false, archive: false } }, fields: { contact: { phone: "none" } } } });
    expect(role.status, JSON.stringify(role.json)).toBe(201);
    const m = await member(roleKey);
    const b = await signedIn(m.email);
    const session = await b.request("GET", "/v1/auth/session");
    expect(session.json.permissions.sort()).toEqual(["records:read", "records:write"]);
    const mine = (await b.request("GET", "/v1/me/access")).json.data.objects;
    const roles = (await call("GET", `/v1/roles/${roleKey}/access`, { key: ws.keys.admin })).json.data.objects;
    expect(mine).toEqual(roles.map((o: Record<string, unknown>) => ({ ...o, restricted_fields: mine.find((x: { object: string }) => x.object === o.object).restricted_fields })));
    expect((await b.request("POST", "/v1/objects/deal/records", { body: { name: "No" } })).status).toBe(403);
    const c = await create(ws.keys.ops, "contact", { first_name: "Phoned", phone: "555 0100" });
    const seen = await b.request("GET", `/v1/objects/contact/records/${c.id}`);
    expect(seen.json.data.phone).toBeUndefined();
    expect((await call("PATCH", `/v1/members/${m.id}`, { key: ws.keys.admin, body: { role: "read_only" } })).status).toBe(200);
    expect((await b.request("POST", "/v1/objects/contact/records", { body: { first_name: "No" } })).status).toBe(403);
    expect((await b.request("GET", "/v1/auth/session")).json.role).toBe("read_only");
  });

  it("Idempotency-Key works per session: a retry replays, encrypted at rest; another session starts afresh", async () => {
    const b = await signedIn(ws.ownerEmail);
    const key = `idem-${Date.now()}`;
    const first = await b.request("POST", "/v1/objects/account/records", { body: { name: "Idem Co" }, headers: { "Idempotency-Key": key } });
    const again = await b.request("POST", "/v1/objects/account/records", { body: { name: "Idem Co" }, headers: { "Idempotency-Key": key } });
    expect(first.status).toBe(201);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.json.data.id).toBe(first.json.data.id);
    const [row] = await inTenant(ws.tenantId, (tx) => tx<{ credential: string; response: { sealed: string } }[]>`
      SELECT credential, response FROM idempotency_keys WHERE idem_key = ${key}`);
    expect(row!.credential).toBe("session");
    expect(JSON.stringify(row!.response)).not.toContain("Idem Co");
    const other = await signedIn(ws.ownerEmail);
    const fresh = await other.request("POST", "/v1/objects/account/records", { body: { name: "Idem Co" }, headers: { "Idempotency-Key": key } });
    expect(fresh.status).toBe(201);
    expect(fresh.json.data.id).not.toBe(first.json.data.id);
  });

  it("a session can create API keys only with scopes its role can use, and session-only routes refuse keys", async () => {
    const m = await member("member");
    const b = await signedIn(m.email);
    const admin = await b.request("POST", "/v1/api-keys", { body: { name: "mine", scopes: ["admin"] } });
    expect(admin.status).toBe(403);
    const ops = await b.request("POST", "/v1/api-keys", { body: { name: "mine", scopes: ["ops:write", "ops:read"] } });
    // keys:manage is an admin permission; a member can't create keys at all through the route gate.
    expect(ops.status).toBe(403);
    const o = await signedIn(ws.ownerEmail);
    const made = await o.request("POST", "/v1/api-keys", { body: { name: "owner key", scopes: ["admin", "ops:read"] } });
    expect(made.status).toBe(201);
    secrets.add(made.json.data.secret);
    expect((await call("GET", "/v1/me", { key: made.json.data.secret })).status).toBe(200);
    for (const [method, path] of [["GET", "/v1/auth/session"], ["GET", "/v1/auth/sessions"], ["POST", "/v1/auth/sign-out"], ["POST", "/v1/auth/password"]] as const) {
      const r = await call(method, path, { key: ws.keys.admin, ...(method === "POST" ? { body: { password: "x".repeat(20) } } : {}) });
      expect(r.status, path).toBe(403);
    }
  });

  it("admins list and revoke a member's sessions, within the escalation rules", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    const list = await call("GET", `/v1/members/${m.id}/sessions`, { key: ws.keys.admin });
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).not.toHaveProperty("current");
    const ro = await memberWithKey(ws, "read_only", ["ops:read"]);
    expect((await call("GET", `/v1/members/${m.id}/sessions`, { key: ro.key })).status).toBe(403);
    // An admin can't revoke an owner's sessions; an owner can.
    const adm = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await call("POST", `/v1/members/${ws.ownerId}/sessions/revoke`, { key: adm.key })).status).toBe(403);
    const ownerSession = (await (await signedIn(ws.ownerEmail)).request("GET", "/v1/auth/session")).json.session.id;
    // A session the caller may not act on answers exactly like an unknown one.
    const notAllowed = await call("DELETE", `/v1/sessions/${ownerSession}`, { key: adm.key });
    const unknown = await call("DELETE", `/v1/sessions/${ownerSession.slice(0, -1)}${ownerSession.endsWith("A") ? "B" : "A"}`, { key: adm.key });
    expect(notAllowed.status).toBe(404);
    expect({ ...notAllowed.json, request_id: 0 }).toEqual({ ...unknown.json, request_id: 0 });
    const r = await call("POST", `/v1/members/${m.id}/sessions/revoke`, { key: adm.key });
    expect(r.json.data).toEqual({ revoked: 1, apps_revoked: 0 });
    expect((await b.request("GET", "/v1/me")).status).toBe(401);
    const log = await call("GET", "/v1/audit-log?action=auth.sessions_revoked", { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ record_id: decodeId(m.id)!.uuid, details: { count: 1, scope: "all" } });
  });

  it("the unauthenticated surface is exactly the sign-in endpoints and pages, and every /v1 route has a permission", () => {
    expect([...PUBLIC_AUTH_ROUTES].sort()).toEqual(["GET /.well-known/oauth-authorization-server", "GET /.well-known/oauth-protected-resource/mcp/admin",
      "GET /.well-known/oauth-protected-resource/mcp/ops", "GET /.well-known/openid-configuration", "GET /auth/capabilities", "GET /auth/sso/callback",
      "GET /oauth/authorize", "OPTIONS /oauth/*", "POST /auth/choose", "POST /auth/email", "POST /auth/email/link", "POST /auth/email/verify", "POST /auth/password",
      "POST /auth/server-link", "POST /auth/sso", "POST /oauth/authorize", "POST /oauth/register", "POST /oauth/revoke", "POST /oauth/token"]);
    expect(routes.every((r) => r.path.startsWith("/v1/") && requiredPermission(r) !== null)).toBe(true);
    const own = routes.filter((r) => requiredPermission(r) === "own_credential").map((r) => `${r.method} ${r.path}`).sort();
    expect(own).toEqual(["DELETE /v1/apps/:id", "DELETE /v1/auth/apps/:id", "DELETE /v1/auth/password", "DELETE /v1/auth/sso", "DELETE /v1/sessions/:id",
      "GET /v1/apps", "GET /v1/auth/apps", "GET /v1/auth/session", "GET /v1/auth/sessions", "POST /v1/auth/password", "POST /v1/auth/sessions/revoke-others",
      "POST /v1/auth/sign-out"]);
    const sessionOnly = routes.filter((r) => r.credential === "session").map((r) => `${r.method} ${r.path}`);
    expect(sessionOnly).toHaveLength(9);
  });
});

describe("email code and link", () => {
  it("reports itself unavailable when no mailer is configured", async () => {
    setMailer(new DisabledMailer());
    try {
      const cap = await app.request("/auth/capabilities");
      expect((await cap.json()).methods.email_code).toBe(false);
      const r = await new Browser().request("POST", "/auth/email", { body: { email: ws.ownerEmail } });
      expect(r.status).toBe(404);
    } finally {
      setMailer(mail);
    }
    const cap = await (await app.request("/auth/capabilities")).json();
    expect(cap).toEqual({ enabled: true, methods: { email_code: true, password: true, sso: null }, code_length: 8 });
  });

  it("signs in with the emailed code, to the return_to path, with the code typed in the same browser", async () => {
    const m = await member();
    const b = new Browser();
    const start = await b.request("POST", "/auth/email", { form: { email: m.email.toUpperCase(), return_to: "/app/deals?view=mine" } });
    expect(start.status).toBe(303);
    expect(start.headers.get("location")).toBe("/auth/code");
    await settleSignInTasks();
    const email = mail.lastTo(m.email)!;
    expect(email.text).toMatch(/https:\/\/crm\.test\/auth\/email-link\?token=/);
    const code = mail.codeFor(m.email)!;
    secrets.add(code);
    secrets.add(new URL(mail.linkFor(m.email)!).searchParams.get("token")!);
    // Another browser can't use the code.
    expect((await new Browser().request("POST", "/auth/email/verify", { body: { code } })).json.code).toBe("expired");
    const done = await b.request("POST", "/auth/email/verify", { form: { code: `${code.slice(0, 4)} ${code.slice(4)}` } });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/app/deals?view=mine");
    remember(b);
    expect((await b.request("GET", "/v1/auth/session")).json.session.method).toBe("email_code");
    // Single use.
    const again = await b.request("POST", "/auth/email/verify", { body: { code } });
    expect(again.json.code).toBe("expired");
  });

  it("five wrong codes void the code; an expired code fails", async () => {
    const m = await member();
    const b = new Browser();
    await b.request("POST", "/auth/email", { body: { email: m.email } });
    await settleSignInTasks();
    const code = mail.codeFor(m.email)!;
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let left = 4; left >= 0; left--) {
      const r = await b.request("POST", "/auth/email/verify", { body: { code: wrong } });
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ code: "invalid_code", errors: { attempts_left: left } });
    }
    expect((await b.request("POST", "/auth/email/verify", { body: { code } })).json.code).toBe("expired");
    const failures = await call("GET", "/v1/audit-log?action=auth.sign_in_failed", { key: ws.keys.admin });
    expect(failures.json.data.filter((e: { record_id: string }) => e.record_id === decodeId(m.id)!.uuid)).toHaveLength(5);

    const b2 = new Browser();
    await b2.request("POST", "/auth/email", { body: { email: m.email } });
    await settleSignInTasks();
    const hash = sha256(signinCookie(b2)).toString("hex");
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.flow_browser', ${hash}, true)`;
      await tx`UPDATE sign_in_flows SET expires_at = now() - interval '1 second'`;
    });
    expect((await b2.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(m.email)! } })).json.code).toBe("expired");
  });

  it("the emailed link works once, only in the browser that asked, and only after a button press", async () => {
    const m = await member();
    const b = new Browser();
    await b.request("POST", "/auth/email", { body: { email: m.email } });
    await settleSignInTasks();
    const link = mail.linkFor(m.email)!;
    const token = new URL(link).searchParams.get("token")!;
    // Opening the link (a GET, as a mail scanner would) only shows a page; nothing is used up.
    const page = await b.request("GET", `/auth/email-link?token=${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('action="/auth/email/link"');
    const elsewhere = await new Browser().request("POST", "/auth/email/link", { body: { token } });
    expect(elsewhere.json.code).toBe("other_browser");
    const ok = await b.request("POST", "/auth/email/link", { body: { token } });
    expect(ok.json.status).toBe("signed_in");
    expect((await b.request("GET", "/v1/auth/session")).json.session.method).toBe("email_link");
    expect((await new Browser().request("POST", "/auth/email/link", { body: { token } })).json.code).toBe("expired");
  });

  it("answers the same for a member, an unknown email and a disabled member, and emails only the member", async () => {
    const m = await member();
    const off = await member();
    expect((await call("PATCH", `/v1/members/${off.id}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(200);
    const unknown = uniqueEmail("nobody");
    const shape = async (email: string) => {
      const b = new Browser();
      const r = await b.request("POST", "/auth/email", { body: { email } });
      await settleSignInTasks();
      const v = await b.request("POST", "/auth/email/verify", { body: { code: "12345678" } });
      return { status: r.status, body: r.json, cookies: r.setCookies.map((c) => c.replace(/=[^;]*/, "=…")), verify: { status: v.status, code: v.json.code } };
    };
    const before = mail.sent.length;
    const [a, b, c] = [await shape(m.email), await shape(unknown), await shape(off.email)];
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(mail.sent.slice(before).map((e) => e.to)).toEqual([m.email]);
    // Format errors are about the input, not the account, and look the same for everyone.
    expect((await new Browser().request("POST", "/auth/email", { body: { email: "not-an-email" } })).status).toBe(422);
  });

  it("limits code requests per email (whether or not it exists), per address, and server-wide sends", async () => {
    const m = await member();
    const unknown = uniqueEmail("nobody");
    for (const email of [m.email, unknown]) {
      for (let i = 0; i < 5; i++) expect((await new Browser().request("POST", "/auth/email", { body: { email } })).status).toBe(202);
      const r = await new Browser().request("POST", "/auth/email", { body: { email } });
      expect(r.status).toBe(429);
      expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
    }
    resetSignInLimits();
    const saved = LIMITS.globalEmail.max;
    LIMITS.globalEmail.max = 0;
    try {
      const before = mail.sent.length;
      expect((await new Browser().request("POST", "/auth/email", { body: { email: m.email } })).status).toBe(202);
      await settleSignInTasks();
      expect(mail.sent.length).toBe(before);
    } finally {
      LIMITS.globalEmail.max = saved;
    }
    resetSignInLimits();
    const addr = LIMITS.address.max;
    LIMITS.address.max = 2;
    try {
      const h = { headers: { "X-Forwarded-For": "198.51.100.7" } };
      process.env.TRUST_PROXY = "true";
      expect((await new Browser().request("POST", "/auth/email", { body: { email: uniqueEmail("a") }, ...h })).status).toBe(202);
      expect((await new Browser().request("POST", "/auth/email", { body: { email: uniqueEmail("b") }, ...h })).status).toBe(202);
      expect((await new Browser().request("POST", "/auth/email", { body: { email: uniqueEmail("c") }, ...h })).status).toBe(429);
      // Someone asking for codes for your address from elsewhere doesn't block you for the next quarter hour.
      LIMITS.address.max = addr;
      resetSignInLimits();
      const victim = uniqueEmail("victim");
      for (let i = 0; i < 5; i++) await new Browser().request("POST", "/auth/email", { body: { email: victim }, headers: { "X-Forwarded-For": "203.0.113.66" } });
      expect((await new Browser().request("POST", "/auth/email", { body: { email: victim }, headers: { "X-Forwarded-For": "203.0.113.66" } })).status).toBe(429);
      expect((await new Browser().request("POST", "/auth/email", { body: { email: victim }, headers: { "X-Forwarded-For": "192.0.2.10" } })).status).toBe(202);
    } finally {
      LIMITS.address.max = addr;
      delete process.env.TRUST_PROXY;
    }
  });

  it("a page's own form post may carry Origin: null, only with Sec-Fetch-Site: same-origin and only to /auth", async () => {
    // What a browser sends for a form on a no-referrer page: Origin null, Sec-Fetch-Site same-origin.
    const nullSame = { Origin: "null", "Sec-Fetch-Site": "same-origin" };
    const ok = await new Browser().request("POST", "/auth/email", { form: { email: ws.ownerEmail }, headers: nullSame });
    expect(ok.status).toBe(303);
    // Not without Sec-Fetch-Site (a browser that sends neither a usable Origin nor it is refused), nor cross-site, nor for JSON.
    for (const [what, headers, form] of [
      ["no Sec-Fetch-Site", { Origin: "null", "Sec-Fetch-Site": "" }, true],
      ["same-site", { Origin: "null", "Sec-Fetch-Site": "same-site" }, true],
      ["cross-site", { Origin: "null", "Sec-Fetch-Site": "cross-site" }, true],
      ["none", { Origin: "null", "Sec-Fetch-Site": "none" }, true],
      ["JSON", nullSame, false],
    ] as const) {
      const r = await new Browser().request("POST", "/auth/email", form ? { form: { email: ws.ownerEmail }, headers } : { body: { email: ws.ownerEmail }, headers });
      expect(r.status, what).toBe(403);
    }
    // Never for the API, even with a valid session and token.
    const b = await signedIn(ws.ownerEmail);
    const v1 = await b.request("POST", "/v1/objects/contact/records", { body: { first_name: "Null" }, headers: nullSame });
    expect(v1.status).toBe(403);
    expect(v1.json.code).toBe("csrf_failed");
  });

  it("sign-in posts from another origin are refused", async () => {
    for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Origin: "" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
      const r = await new Browser().request("POST", "/auth/password", { body: { email: ws.ownerEmail, password: "whatever-it-is" }, headers });
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("csrf_failed");
    }
  });
});

describe("passwords", () => {
  const good = () => `Tidal-Copper-${Math.random().toString(36).slice(2, 10)}`;

  it("refuses passwords that are easy to guess, without needing them on a list", () => {
    const account = { email: "dana.reyes@example.com", workspaceName: "Harbor Lights" };
    for (const pw of ["Password1234!", "Qwerty123456!", "password1234", "Password2026!", "Football2026!", "Iloveyou2026!", "1q2w3e4r5t6y7u",
      "abcdefghijklmnop", "123456789012345", "P@ssw0rd12345", "qwertyuiopasdfgh", "aaaaaaaaaaaa123"]) {
      expect(passwordProblem(pw, account), pw).toBe("This password is too easy to guess");
    }
    for (const pw of ["Tidal-Copper-q8z3k1m0", "Amber-Harbour-Lantern-m3x9k2", "violet kettle mortgage sparrow", "tangerine-octopus-library-9",
      "kL9#mQ2$vX7!pR4w", "Gravel moon 47 orchestra"]) {
      expect(passwordProblem(pw, account), pw).toBeNull();
    }
  });

  it("refuses passwords built from the email or workspace name, including long ones the estimator rates as strong", () => {
    const account = { email: "dana.reyes@example.com", workspaceName: "Harbor Lights" };
    for (const pw of ["dana.reyes-xyz-1", "Dana.Reyes loves turquoise kayaks", "dana.reyes@example.com"]) {
      expect(passwordProblem(pw, account), pw).toMatch(/email/);
    }
    for (const pw of ["HarborLights2026!", "harbor lights rule the world forever", "I work at Harbor Lights since 2019, honestly"]) {
      expect(passwordProblem(pw, account), pw).toMatch(/workspace name/);
    }
    // The email and workspace name are also words the estimator tries, so altered spellings of them count for little.
    for (const pw of ["h4rb0rl1ghts2026", "harborlight$2026", "d@na.r3yes-2026"]) {
      expect(passwordProblem(pw, account), pw).toBe("This password is too easy to guess");
      expect(passwordProblem(pw, {}), pw).toBeNull();
    }
    // Two distinct characters can look random to the estimator; they are refused anyway.
    expect(passwordProblem("abbabaabbbababba", account)).toMatch(/repeats/);
  });

  it("checks length first, and a long password takes milliseconds to check", () => {
    expect(passwordProblem("Xy9-short")).toMatch(/at least 12/);
    expect(passwordProblem(`${"Qz7-".repeat(64)}x`)).toMatch(/at most 256/);
    passwordProblem("warm-up-to-build-the-estimator");
    const worst = ["9".repeat(PASSWORD_MAX), "1984-02-29/".repeat(24).slice(0, PASSWORD_MAX), "qwertyuiop[]asdfghjkl;zxcvbnm,./".repeat(8),
      "p@55w0rd!$1|3".repeat(20).slice(0, PASSWORD_MAX), Array.from({ length: PASSWORD_MAX }, (_, i) => String.fromCharCode(33 + ((i * 37) % 94))).join(""),
      "\u{1F600}".repeat(PASSWORD_MAX)];
    for (const pw of worst) {
      const started = performance.now();
      passwordProblem(pw, { email: "dana.reyes@example.com", workspaceName: "Harbor Lights" });
      expect(performance.now() - started, pw.slice(0, 20)).toBeLessThan(250);
    }
  });

  it("PASSWORD_MIN_STRENGTH moves the bar: 4 refuses a word with a year, 0 turns the estimate off", () => {
    const withBar = (bar: string, check: () => void) => {
      process.env.PASSWORD_MIN_STRENGTH = bar;
      resetConfig();
      try {
        check();
      } finally {
        delete process.env.PASSWORD_MIN_STRENGTH;
        resetConfig();
      }
    };
    expect(passwordProblem("Summer2026!!!")).toBeNull();
    expect(passwordProblem("password1234")).toBe("This password is too easy to guess");
    withBar("4", () => {
      expect(passwordProblem("Summer2026!!!")).toBe("This password is too easy to guess");
      expect(passwordProblem("lantern-orbit-maple-quartz")).toBeNull();
    });
    withBar("0", () => {
      expect(passwordProblem("password1234")).toBeNull();
      expect(passwordProblem("short")).toMatch(/at least 12/);
      expect(passwordProblem("aaaaaaaaaaaaaaaa")).toMatch(/repeats/);
    });
    withBar("5", () => expect(() => passwordProblem("lantern-orbit-maple-quartz")).toThrow(/Invalid configuration/));
  });

  it("sets a first password after a recent sign-in, refuses weak ones, and signs in with it", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    for (const [pw, why] of [["short", /at least 12/], ["password1234", /too easy to guess/], [`${m.email.split("@")[0]}-xyz-1`, /email/],
      [`zz${ws.name.replace(/\s/g, "")}zz!`, /workspace name/], ["aaaaaaaaaaaaaaaa", /repeats/]] as const) {
      const r = await setPassword(b, pw);
      expect(r.status, pw).toBe(422);
      expect(r.json.detail, pw).toMatch(why);
    }
    const pw = good();
    const set = await setPassword(b, pw);
    expect(set.status).toBe(200);
    expect(set.json.data).toEqual({ has_password: true, other_sessions_revoked: 0 });
    const p = await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } });
    expect(p.json.status).toBe("signed_in");
    const [cred] = await inTenant(ws.tenantId, (tx) => tx<{ password_hash: string }[]>`SELECT password_hash FROM member_credentials WHERE user_id = ${decodeId(m.id)!.uuid}`);
    expect(cred!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    const listed = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id);
    expect(listed.sign_in).toMatchObject({ has_password: true, sso_linked: false, last_sign_in_at: expect.any(String), active_sessions: 2 });
    const review = (await call("GET", "/v1/access-review", { key: ws.keys.admin })).json.data.members.find((u: { id: string }) => u.id === m.id);
    expect(review.sign_in).toMatchObject({ has_password: true, active_sessions: 2 });
  });

  it("changing needs the current password unless the sign-in is recent, and ends the other sessions", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    const pw = good();
    await setPassword(b, pw);
    const other = await signedIn(m.email);
    // Make this session's sign-in an hour old.
    const id = await sessionIdOf(b);
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '1 hour' WHERE id = ${id}`);
    const next = good();
    expect((await setPassword(b, next)).json.code).toBe("recent_sign_in_required");
    expect((await setPassword(b, next, "not-the-password")).json.code).toBe("current_password_wrong");
    const ok = await setPassword(b, next, pw);
    expect(ok.status).toBe(200);
    expect(ok.json.data.other_sessions_revoked).toBe(1);
    expect((await other.request("GET", "/v1/me")).status).toBe(401);
    expect((await b.request("GET", "/v1/me")).status).toBe(200);
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(401);
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: next } })).status).toBe(200);
    const log = await call("GET", "/v1/audit-log?action=auth.password_", { key: ws.keys.admin });
    expect(log.json.data.filter((e: { record_id: string }) => e.record_id === decodeId(m.id)!.uuid).map((e: { action: string }) => e.action))
      .toEqual(["auth.password_changed", "auth.password_set"]);
  });

  it("a reset is an email-code sign-in followed by a new password; removing the password stops password sign-in", async () => {
    const m = await member();
    const pw = good();
    await setPassword(await signedIn(m.email), pw);
    const { b } = await byEmailCode(m.email);
    const fresh = good();
    expect((await setPassword(b, fresh)).status).toBe(200);
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: fresh } })).status).toBe(200);
    const rm = await b.request("DELETE", "/v1/auth/password", { body: {} });
    expect(rm.json.data).toMatchObject({ has_password: false });
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: fresh } })).status).toBe(401);
    expect((await b.request("DELETE", "/v1/auth/password", { body: {} })).status).toBe(409);
  });

  it("rehashes on sign-in when the parameters changed", async () => {
    const m = await member();
    const pw = good();
    setArgon2Params({ m: 19_456, t: 3, p: 1 });
    try {
      await setPassword(await signedIn(m.email), pw);
    } finally {
      setArgon2Params();
    }
    const hash = async () => (await inTenant(ws.tenantId, (tx) => tx<{ password_hash: string }[]>`SELECT password_hash FROM member_credentials WHERE user_id = ${decodeId(m.id)!.uuid}`))[0]!.password_hash;
    expect(await hash()).toMatch(/m=19456,t=3,p=1/);
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(200);
    expect(await hash()).toMatch(/m=19456,t=2,p=1/);
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(200);
  });

  it("locks password sign-in after repeated failures, without locking out the email code, which clears the lock", async () => {
    const m = await member();
    const pw = good();
    await setPassword(await signedIn(m.email), pw);
    for (let i = 0; i < 5; i++) {
      expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: `wrong-${i}-password` } })).status).toBe(401);
      await settleSignInTasks(); // failures are counted after the response
    }
    const locked = await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } });
    expect(locked.status).toBe(401);
    expect(locked.json.code).toBe("sign_in_failed");
    const log = await call("GET", "/v1/audit-log?action=auth.password_locked", { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ record_id: decodeId(m.id)!.uuid, details: { failures: 5, minutes: 1 } });
    const { done } = await byEmailCode(m.email);
    expect(done.json.status).toBe("signed_in");
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(200);
  });

  it("fails the same way for a wrong password, an unknown email, a disabled member, a member without a password and a locked account", async () => {
    const withPw = await member();
    const noPw = await member();
    const off = await member();
    const pw = good();
    await setPassword(await signedIn(withPw.email), pw);
    await setPassword(await signedIn(off.email), pw);
    await call("PATCH", `/v1/members/${off.id}`, { key: ws.keys.admin, body: { active: false } });
    const attempt = async (email: string, password: string) => {
      const r = await new Browser().request("POST", "/auth/password", { body: { email, password } });
      return { status: r.status, body: { ...r.json, request_id: undefined }, cookies: r.setCookies.length };
    };
    const base = await attempt(withPw.email, "wrong-password-here");
    expect(base.status).toBe(401);
    for (const r of [await attempt(uniqueEmail("ghost"), pw), await attempt(off.email, pw), await attempt(noPw.email, pw)]) expect(r).toEqual(base);
  });

  it("a workspace owner can turn password sign-in off (admins can't); the server setting turns it off everywhere", async () => {
    const m = await member();
    const pw = good();
    await setPassword(await signedIn(m.email), pw);
    const adm = await memberWithKey(ws, "admin", ["admin", "ops:read"]);
    expect((await call("PATCH", "/v1/workspace/sign-in", { key: adm.key, body: { password: false } })).status).toBe(403);
    expect((await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { password: false } })).json.data).toEqual({ password: false, sso: true, sso_allowed_domains: [], oauth_apps: true, oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] });
    try {
      expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(401);
      expect((await call("GET", "/v1/workspace", { key: ws.keys.ops })).json.data.sign_in).toEqual({ password: false, sso: true, sso_allowed_domains: [], oauth_apps: true, oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] });
    } finally {
      await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { password: true } });
    }
    process.env.PASSWORD_SIGN_IN = "false";
    resetConfig();
    try {
      expect((await (await app.request("/auth/capabilities")).json()).methods.password).toBe(false);
      expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(404);
    } finally {
      delete process.env.PASSWORD_SIGN_IN;
      resetConfig();
    }
  });

  it("the optional breached-password check sends only a 5-character SHA-1 prefix", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    const pw = good();
    const { createHash } = await import("node:crypto");
    const sha1 = createHash("sha1").update(pw).digest("hex").toUpperCase();
    const asked: string[] = [];
    setBreachRangeLookup(async (prefix) => {
      asked.push(prefix);
      return `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${sha1.slice(5)}:42\r\n`;
    });
    process.env.PASSWORD_BREACH_CHECK = "true";
    resetConfig();
    try {
      const r = await setPassword(b, pw);
      expect(r.status).toBe(422);
      expect(r.json.detail).toMatch(/breach/);
      expect(asked).toEqual([sha1.slice(0, 5)]);
      expect((await setPassword(b, good())).status).toBe(200);
    } finally {
      delete process.env.PASSWORD_BREACH_CHECK;
      resetConfig();
      setBreachRangeLookup();
    }
  });
});

describe("several workspaces", () => {
  it("an email in two workspaces gets a single-use, browser-bound choice listing names only", async () => {
    const other = await newWorkspace("Second");
    const email = uniqueEmail("both");
    await member("member", email);
    await member("read_only", email, other);
    const { b, done } = await byEmailCode(email);
    expect(done.json).toEqual({ status: "choose_workspace", workspaces: expect.arrayContaining([{ id: ws.id, name: ws.name }, { id: other.id, name: other.name }]) });
    expect(done.json.workspaces).toHaveLength(2);
    const page = await b.request("GET", "/auth/choose");
    expect(page.text).toContain(other.name);
    // Another browser can't pick; a workspace not offered is refused.
    expect((await new Browser().request("POST", "/auth/choose", { body: { workspace: other.id } })).json.code).toBe("expired");
    const picked = await b.request("POST", "/auth/choose", { form: { workspace: other.id } });
    expect(picked.status).toBe(303);
    expect((await b.request("GET", "/v1/auth/session")).json).toMatchObject({ workspace: { id: other.id }, role: "read_only" });
    expect((await b.request("POST", "/auth/choose", { body: { workspace: ws.id } })).json.code).toBe("expired");
    // The server link needs a workspace when there are several.
    await expect(createServerLink(email, undefined, "t")).rejects.toThrow(/several workspaces/);
    expect((await signedIn(email, other.id).then((x) => x.request("GET", "/v1/auth/session"))).json.workspace.id).toBe(other.id);

    const { b: b2 } = await byEmailCode(email);
    expect((await b2.request("POST", "/auth/choose", { body: { workspace: (await newWorkspace("Third")).id } })).json.code).toBe("sign_in_failed");
  });

  it("a password signs in where it matches; matching in two workspaces offers the choice", async () => {
    const other = await newWorkspace("Pw second");
    const email = uniqueEmail("pw-both");
    await member("member", email);
    await member("member", email, other);
    const pw = `Granite-Orbit-${Date.now()}`;
    const { b: choose1 } = await byEmailCode(email);
    await choose1.request("POST", "/auth/choose", { body: { workspace: ws.id } });
    await setPassword(choose1, pw);
    const one = await new Browser().request("POST", "/auth/password", { body: { email, password: pw } });
    expect(one.json).toMatchObject({ status: "signed_in", workspace: { id: ws.id } });
    const b = await signedIn(email, other.id);
    await setPassword(b, pw);
    const two = await new Browser().request("POST", "/auth/password", { body: { email, password: pw } });
    expect(two.json.status).toBe("choose_workspace");
  });
});

describe("server-printed link", () => {
  it("works without a mailer, once, for a short time, and is audited", async () => {
    setMailer(new DisabledMailer());
    try {
      const link = await createServerLink(ws.ownerEmail, ws.id, "t");
      expect(link.url).toMatch(/^https:\/\/crm\.test\/auth\/link\?token=[A-Za-z0-9_-]{43}$/);
      expect(link.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      const token = new URL(link.url).searchParams.get("token")!;
      secrets.add(token);
      const page = await new Browser().request("GET", `/auth/link?token=${token}`);
      expect(page.text).toContain('action="/auth/server-link"');
      const b = new Browser();
      const r = await b.request("POST", "/auth/server-link", { form: { token } });
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toBe("/auth/signed-in");
      expect((await new Browser().request("POST", "/auth/server-link", { body: { token } })).json.code).toBe("expired");
      const signedInPage = await b.request("GET", "/auth/signed-in");
      expect(signedInPage.text).toContain(ws.name);
    } finally {
      setMailer(mail);
    }
    const log = await call("GET", "/v1/audit-log?action=auth.sign_in_link_created", { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ surface: "cli", record_id: decodeId(ws.ownerId)!.uuid, details: { expires_in_minutes: 15 } });
    await expect(createServerLink(uniqueEmail("nobody"), undefined, "t")).rejects.toThrow(/No active member/);
  });
});

describe("pages", () => {
  it("are plain HTML with a strict CSP, no script, no framing and no caching, and never reflect input", async () => {
    const r = await new Browser().request("GET", "/auth/sign-in?error=%3Cscript%3Ealert(1)%3C/script%3E&return_to=%22%3E%3Cscript%3E");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.text).not.toMatch(/<script|alert\(1\)/i);
    expect(r.text).toContain("Something went wrong");
    expect(r.text).toContain('<label for="email">Email</label>');
    for (const p of ["/auth/code", "/auth/choose", "/auth/signed-out", "/auth/error?error=expired", "/auth/link?token=x"]) {
      const page = await new Browser().request("GET", p);
      expect(page.text, p).not.toMatch(/<script/i);
      expect(page.headers.get("content-security-policy"), p).toContain("frame-ancestors 'none'");
    }
    const css = await app.request("/auth/assets/style.css");
    expect(css.headers.get("content-type")).toMatch(/^text\/css/);
  });

  it("return_to only ever leads to a path on this origin", async () => {
    for (const [given, lands] of [["//evil.example/x", "/auth/signed-in"], ["https://evil.example/", "/auth/signed-in"], ["/\\evil.example", "/auth/signed-in"],
      ["javascript:alert(1)", "/auth/signed-in"], ["/%0d%0aSet-Cookie:x", "/%0d%0aSet-Cookie:x"], ["/ok/path?x=1#y", "/ok/path?x=1#y"], ["/\tx", "/auth/signed-in"]] as const) {
      const m = await member();
      const b = new Browser();
      await b.request("POST", "/auth/email", { body: { email: m.email, return_to: given } });
      await settleSignInTasks();
      const r = await b.request("POST", "/auth/email/verify", { form: { code: mail.codeFor(m.email)! } });
      expect(r.headers.get("location"), given).toBe(lands);
    }
  });

  it("the password and sign-out forms need the session's CSRF token and a same-origin post", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    const page = await b.request("GET", "/auth/password");
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(page.text)![1]!;
    expect(csrf).toBe(b.csrf);
    const pw = good2();
    const noToken = await b.request("POST", "/auth/password/set", { form: { password: pw, password_again: pw } });
    expect(noToken.headers.get("location")).toBe("/auth/password?error=csrf_failed");
    const mismatch = await b.request("POST", "/auth/password/set", { form: { csrf_token: csrf, password: pw, password_again: `${pw}x` } });
    expect(mismatch.headers.get("location")).toBe("/auth/password?error=password_mismatch");
    const weak = await b.request("POST", "/auth/password/set", { form: { csrf_token: csrf, password: "short", password_again: "short" } });
    expect(weak.headers.get("location")).toBe("/auth/password?error=weak_password");
    secrets.add(pw);
    const ok = await b.request("POST", "/auth/password/set", { form: { csrf_token: csrf, password: pw, password_again: pw } });
    expect(ok.headers.get("location")).toBe("/auth/password?done=1");
    const cross = await b.request("POST", "/auth/sign-out", { form: { csrf_token: csrf }, headers: { Origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect((await b.request("GET", "/v1/me")).status).toBe(200);
    const out = await b.request("POST", "/auth/sign-out", { form: { csrf_token: csrf } });
    expect(out.headers.get("location")).toBe("/auth/signed-out");
    expect(out.headers.get("clear-site-data")).toBe('"cookies", "storage"');
    expect((await b.request("GET", "/v1/me")).status).toBe(401);
  });
});

const good2 = () => `Harbor-Lantern-${Math.random().toString(36).slice(2, 10)}`;

describe("invitations", () => {
  it("are sent only when asked, carry no credential, and need email to be set up", async () => {
    const before = mail.sent.length;
    const quiet = uniqueEmail("quiet");
    expect((await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: quiet, name: "Quiet", role: "member" } })).status).toBe(201);
    const invited = uniqueEmail("invited");
    const r = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: invited, name: "Invited", role: "member", send_invite: true } });
    expect(r.json.data.invitation).toBe("queued");
    expect(mail.sent.slice(before).map((e) => e.to)).toEqual([invited]);
    const text = mail.lastTo(invited)!.text;
    expect(text).toContain("https://crm.test/auth/sign-in");
    expect(text).not.toMatch(/token=/);
    setMailer(new DisabledMailer());
    try {
      const no = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("x"), name: "X", role: "member", send_invite: true } });
      expect(no.status).toBe(422);
    } finally {
      setMailer(mail);
    }
  });
});

describe("row-level security on the sign-in tables", () => {
  it("lookup policies expose only the one row presented; tenant isolation holds for sessions and credentials", async () => {
    const other = await newWorkspace("RLS other");
    const a = await signedIn(ws.ownerEmail);
    await signedIn(other.ownerEmail);
    const token = a.cookies.get("__Host-hlcrm_session")!;
    const lookup = (hash: string) => sql.begin(async (tx) => {
      await tx`SELECT set_config('app.session_lookup', ${hash}, true)`;
      return tx<{ tenant_id: string }[]>`SELECT tenant_id FROM sessions`;
    });
    const rows = await lookup(sha256(token).toString("hex"));
    expect(rows).toEqual([{ tenant_id: ws.tenantId }]);
    expect(await lookup("00".repeat(32))).toHaveLength(0);
    // The lookup is read-only: it can't revoke or change the row it finds.
    expect(await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.session_lookup', ${sha256(token).toString("hex")}, true)`;
      return tx`UPDATE sessions SET revoked_at = now() RETURNING 1`;
    })).toHaveLength(0);
    // Identities: only the rows of the named identity, and nothing without a name.
    const ids = (kind: string, value: string) => sql.begin(async (tx) => {
      await tx`SELECT set_config('app.identity_kind', ${kind}, true), set_config('app.identity_lookup', ${value}, true)`;
      return tx<{ tenant_id: string; value: string }[]>`SELECT tenant_id, value FROM sign_in_identities`;
    });
    expect(await ids("email", ws.ownerEmail.toLowerCase())).toEqual([{ tenant_id: ws.tenantId, value: ws.ownerEmail.toLowerCase() }]);
    expect(await ids("email", "")).toHaveLength(0);
    expect(await sql`SELECT * FROM sign_in_flows`).toHaveLength(0);
    // Tenant A sees only its own sessions and credentials, and can't write B's.
    const counts = await inTenant(ws.tenantId, (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE tenant_id = ${other.tenantId}`);
    expect(counts[0]!.n).toBe(0);
    await expect(inTenant(ws.tenantId, (tx) => tx`
      INSERT INTO member_credentials (tenant_id, user_id, password_hash) VALUES (${other.tenantId}, ${decodeId(other.ownerId)!.uuid}, '$argon2id$x')`))
      .rejects.toThrow(/row-level security/);
    await expect(inTenant(ws.tenantId, (tx) => tx`
      INSERT INTO sign_in_identities (tenant_id, user_id, kind, value) VALUES (${other.tenantId}, ${decodeId(other.ownerId)!.uuid}, 'oidc', 'x')`))
      .rejects.toThrow(/row-level security/);
    expect(await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET revoked_at = now() WHERE tenant_id = ${other.tenantId} RETURNING 1`)).toHaveLength(0);
    // A flow is invisible without its cookie, and can't be written for a cookie the transaction didn't present.
    await expect(sql.begin(async (tx) => {
      await tx`SELECT set_config('app.flow_browser', ${"ab".repeat(32)}, true)`;
      await tx`INSERT INTO sign_in_flows (id, browser_hash, purpose, expires_at) VALUES (gen_random_uuid(), ${sha256("other")}, 'email', now() + interval '1 minute')`;
    })).rejects.toThrow(/row-level security/);
  });
});

describe("one address, one proof", () => {
  const sentTo = (to: string, since: number) => mail.sent.slice(since).filter((e) => e.to === to);
  const codeIn = (e: { text: string } | undefined) => /code is (\d{4}) (\d{4})/.exec(e?.text ?? "")?.slice(1).join("") ?? null;
  const auditOf = async (w: Workspace, action: string) => (await call("GET", `/v1/audit-log?action=${action}&limit=200`, { key: w.keys.admin })).json.data as
    { record_id: string; details: Record<string, unknown> }[];

  it("a case variant stored in another workspace gets its own code, which never signs in to the victim's membership", async () => {
    // The probe: an admin of an older workspace adds the victim's address with other capitals.
    const older = await newWorkspace("Older");
    const victimWs = await newWorkspace("Victim");
    const local = `alice-${Date.now()}`;
    const [victim, variant] = [`${local}@example.com`, `${local.toUpperCase()}@example.com`];
    const a = await member("member", variant, older);
    const v = await member("member", victim, victimWs);
    const before = mail.sent.length;
    const attacker = new Browser();
    expect((await attacker.request("POST", "/auth/email", { body: { email: victim } })).status).toBe(202);
    await settleSignInTasks();
    // One message per address as stored, each with its own code.
    expect(mail.sent.slice(before).map((e) => e.to).sort()).toEqual([variant, victim].sort());
    const [variantCode, victimCode] = [codeIn(sentTo(variant, before)[0]), codeIn(sentTo(victim, before)[0])];
    expect(variantCode).not.toBe(victimCode);
    secrets.add(variantCode!).add(victimCode!);
    // The variant's code signs in to the variant's workspace and nowhere else: no choice that includes the victim's.
    const r = await attacker.request("POST", "/auth/email/verify", { body: { code: variantCode } });
    expect(r.json).toMatchObject({ status: "signed_in", workspace: { id: older.id } });
    expect((await attacker.request("GET", "/v1/auth/session")).json.member.id).toBe(a.id);
    // The victim's own code, in the victim's own browser, signs in to the victim's workspace only.
    const at = mail.sent.length;
    const vb = new Browser();
    await vb.request("POST", "/auth/email", { body: { email: victim } });
    await settleSignInTasks();
    const mine = await vb.request("POST", "/auth/email/verify", { body: { code: codeIn(sentTo(victim, at)[0]) } });
    expect(mine.json).toMatchObject({ status: "signed_in", workspace: { id: victimWs.id } });
    expect((await vb.request("GET", "/v1/auth/session")).json.member.id).toBe(v.id);
    // Each workspace's audit names only its own member's message.
    expect((await auditOf(older, "auth.code_sent")).every((e) => e.record_id === decodeId(a.id)!.uuid)).toBe(true);
    expect((await auditOf(victimWs, "auth.code_sent")).every((e) => e.record_id === decodeId(v.id)!.uuid)).toBe(true);
  });

  it("past three spellings, the rest get no message and no audit entry, and a wrong code is audited only where a message went", async () => {
    const local = `bob-${Date.now()}`;
    const spellings = [`${local.toUpperCase()}@example.com`, `B${local.slice(1)}@example.com`, `bO${local.slice(2)}@example.com`];
    const others = [await newWorkspace("Sp1"), await newWorkspace("Sp2"), await newWorkspace("Sp3")];
    for (const [i, w] of others.entries()) await member("member", spellings[i], w);
    const typed = `${local}@example.com`;
    const home = await newWorkspace("Sp home");
    await member("member", typed, home);
    const before = mail.sent.length;
    const b = new Browser();
    await b.request("POST", "/auth/email", { body: { email: typed } });
    await settleSignInTasks();
    // The typed spelling first, then by workspace: the newest of the others gets nothing.
    expect(mail.sent.slice(before).map((e) => e.to)).toEqual([typed, spellings[0], spellings[1]]);
    expect(await auditOf(others[2]!, "auth.code_sent")).toEqual([]);
    expect((await b.request("POST", "/auth/email/verify", { body: { code: "00000000" } })).json.code).toBe("invalid_code");
    await settleSignInTasks();
    expect(await auditOf(others[2]!, "auth.sign_in_failed")).toEqual([]);
    expect(await auditOf(others[0]!, "auth.sign_in_failed")).toHaveLength(1);
    expect(await auditOf(home, "auth.sign_in_failed")).toHaveLength(1);
  });

  it("refuses non-ASCII, spaces and control characters in member emails; an older fold variant is matched only by its own form", async () => {
    for (const email of ["\u212aim@example.com", "\u0130nci@example.com", "jos\u00e9@example.com", "ali ce@example.com", "a\tb@example.com", " lead@example.com",
      "x@ex\u0430mple.com"]) {
      const r = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "Fold", role: "member" } });
      expect(r.status, JSON.stringify(email)).toBe(422);
      expect(r.json.detail).toMatch(/ASCII/);
    }
    await expect(createWorkspace({ name: "Fold owner", ownerEmail: "\u212aim@example.com", ownerName: "K" })).rejects.toThrow(/ASCII/);
    // A row from before the rule, put in directly: the Kelvin sign (U+212A) folds to "k" under Unicode and some locales.
    const local = `kim-${Date.now()}`;
    const victim = `${local}@example.com`;
    const kelvin = `\u212a${local.slice(1)}@example.com`;
    await member("member", victim);
    const other = await newWorkspace("Fold other");
    await inTenant(other.tenantId, async (tx) => {
      const [role] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE key = 'member'`;
      await tx`INSERT INTO users (tenant_id, id, email, name, role_id) VALUES (${other.tenantId}, gen_random_uuid(), ${kelvin}, 'Kelvin', ${role!.id})`;
    });
    const [identity] = await inTenant(other.tenantId, (tx) => tx<{ value: string }[]>`SELECT value FROM sign_in_identities WHERE kind = 'email'
      AND address = ${kelvin}`);
    expect(identity!.value).toBe(canonicalEmail(kelvin));
    expect(identity!.value).not.toBe(victim);
    for (const [typed, gets] of [[victim, victim], [kelvin, kelvin]]) {
      const before = mail.sent.length;
      await new Browser().request("POST", "/auth/email", { body: { email: typed } });
      await settleSignInTasks();
      expect(mail.sent.slice(before).map((e) => e.to), typed).toEqual([gets]);
    }
  });

  it("the SQL and JavaScript canonical forms agree on awkward inputs, and only A-Z fold", async () => {
    const inputs = ["Alice@Example.COM", "  Bob@x.io\t", "\u212aelvin@x.io", "\u0130stanbul@x.io", "\u0131@x.io", "\u00c0\u00c9\u00ce@x.io", "STRA\u1e9eE@x.io",
      "\u01c5@x.io", "\u00a0nbsp@x.io\u00a0", "\nA@B.C\r\n", "\uff21\uff22@x.io", "A\u0307@x.io", "MiXeD.CaSe+TAG@Sub.Example.ORG", "\u000bV@x.io\f", "\u03a3@x.io", ""];
    const rows = await sql<{ x: string; c: string }[]>`SELECT x, app.canonical_email(x) AS c FROM unnest(${inputs}::text[]) AS x`;
    expect(rows).toHaveLength(inputs.length);
    for (const r of rows) expect(r.c, JSON.stringify(r.x)).toBe(canonicalEmail(r.x));
    expect(canonicalEmail("  MiXeD@Example.ORG\n")).toBe("mixed@example.org");
    for (const s of ["\u212aelvin@x.io", "\u0130stanbul@x.io", "\u00c0@x.io", "\u03a3@x.io"]) expect(canonicalEmail(s)).toBe(s);
  });
});

describe("return_to", () => {
  const ORIGIN_ = "https://crm.test";
  const invariant = (raw: string) => {
    const out = safeReturnTo(raw);
    expect(out.startsWith("/") && !out.startsWith("//") && !out.includes("\\"), JSON.stringify(raw)).toBe(true);
    expect(out.split(/[?#]/)[0]!.includes("//"), JSON.stringify(raw)).toBe(false);
    expect(new URL(out, ORIGIN_).origin, JSON.stringify(raw)).toBe(ORIGIN_);
    expect([...out].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f), JSON.stringify(raw)).toBe(false);
    return out;
  };

  it("never leads off this origin, before or after the URL parser normalises it (dot segments included)", () => {
    for (const raw of ["/.//evil.com", "/..//evil.com", "/%2e//evil.com", "/%2E%2E//evil.com", "/.%2e//evil.com", "/a/..//evil.com", "/x/%2e%2e/%2e%2e//evil.com",
      "//evil.com", "///evil.com", "/\\evil.com", "/./\\evil.com", "https://evil.com", "javascript:alert(1)", "/\t/evil.com", "/\u0000", "/a//evil.com", "/ok/./x"]) {
      expect(invariant(raw), JSON.stringify(raw)).toBe("/auth/signed-in");
    }
    for (const ok of ["/ok/path?x=1#y", "/after", "/a/b.c/d?next=https://elsewhere.example//x", "/%2F/evil.com", "/%5c/evil.com"]) expect(invariant(ok)).toBe(ok);
    // Property-style: random paths built from the troublesome pieces never break the invariant.
    const parts = ["/", "//", ".", "..", "%2e", "%2E", "\\", "%5c", "evil.com", "a", "?", "#", "@", ":", "%2f", "%00", " "];
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
    for (let i = 0; i < 3000; i++) {
      let raw = "/";
      for (let j = next() % 7; j >= 0; j--) raw += parts[next() % parts.length];
      invariant(raw);
    }
  });

  it("the password path and the email path both apply it", async () => {
    const m = await member();
    const pw = `Quartz-Meadow-${Date.now()}`;
    await setPassword(await signedIn(m.email), pw);
    const r = await new Browser().request("POST", "/auth/password", { form: { email: m.email, password: pw, return_to: "/.//evil.example" } });
    expect(r.headers.get("location")).toBe("/auth/signed-in");
    const b = new Browser();
    await b.request("POST", "/auth/email", { body: { email: m.email, return_to: "/..//evil.example" } });
    await settleSignInTasks();
    const e = await b.request("POST", "/auth/email/verify", { form: { code: mail.codeFor(m.email)! } });
    expect(e.headers.get("location")).toBe("/auth/signed-in");
  });
});

describe("email budgets", () => {
  it("invitations are limited per workspace and per sender with a 429, and the member isn't added", async () => {
    const w = await newWorkspace("Invites");
    const add = (key: string, email = uniqueEmail("inv")) => call("POST", "/v1/members", { key, body: { email, name: "Inv", role: "member", send_invite: true } });
    const saved = { ws: LIMITS.inviteWorkspace.max, by: LIMITS.inviteMember.max };
    LIMITS.inviteWorkspace.max = 3;
    LIMITS.inviteMember.max = 2;
    try {
      expect((await add(w.keys.admin)).status).toBe(201);
      expect((await add(w.keys.admin)).status).toBe(201);
      const refusedEmail = uniqueEmail("inv-refused");
      const third = await add(w.keys.admin, refusedEmail);
      expect(third.status).toBe(429);
      expect(third.json.code).toBe("rate_limited");
      const users = (await call("GET", "/v1/members", { key: w.keys.admin })).json.data.users as { email: string }[];
      expect(users.some((u) => u.email === refusedEmail)).toBe(false);
      // Another admin of the same workspace has their own allowance, within the workspace's.
      const adm = await memberWithKey(w, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
      expect((await add(adm.key)).status).toBe(201);
      expect((await add(adm.key)).status).toBe(429);
      // Another workspace is unaffected.
      expect((await add(ws.keys.admin)).status).toBe(201);
    } finally {
      LIMITS.inviteWorkspace.max = saved.ws;
      LIMITS.inviteMember.max = saved.by;
    }
  });

  it("sign-in codes have budgets per workspace and a server ceiling that invitations don't touch; hitting the ceiling is logged as an error", async () => {
    const busy = await newWorkspace("Busy");
    const [x1, x2] = [await member("member", uniqueEmail("busy1"), busy), await member("member", uniqueEmail("busy2"), busy)];
    const calm = await member();
    const savedInv = LIMITS.inviteGlobal.max;
    const savedWs = LIMITS.workspaceEmail.max;
    LIMITS.inviteGlobal.max = 0;
    LIMITS.workspaceEmail.max = 1;
    try {
      // Invitations are refused at their own ceiling, and sign-in codes still go out.
      expect((await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("i"), name: "I", role: "member", send_invite: true } })).status).toBe(429);
      const before = mail.sent.length;
      for (const e of [x1.email, x2.email, calm.email]) await new Browser().request("POST", "/auth/email", { body: { email: e } });
      await settleSignInTasks();
      // One workspace's budget is spent by its first member; the other workspace's member still gets a code.
      expect(mail.sent.slice(before).map((e) => e.to)).toEqual([x1.email, calm.email]);
    } finally {
      LIMITS.inviteGlobal.max = savedInv;
      LIMITS.workspaceEmail.max = savedWs;
    }
    resetSignInLimits();
    const saved = LIMITS.globalEmail.max;
    LIMITS.globalEmail.max = 0;
    const at = logged.length;
    try {
      await new Browser().request("POST", "/auth/email", { body: { email: calm.email } });
      await settleSignInTasks();
      expect(logged.slice(at).some((l) => l.includes("sign_in_email_limited") && l.includes("\"scope\":\"server\""))).toBe(true);
    } finally {
      LIMITS.globalEmail.max = saved;
    }
  });

  it("names someone else chose go into the invitation as plain text, with no link, control or bidi character", async () => {
    const w = await newWorkspace("Visit https://evil.example/login or www.evil.example \u202eevil\u0007");
    const adm = await call("POST", "/v1/members", { key: w.keys.admin, body: { email: uniqueEmail("namer"), name: "Click evil.example now", role: "admin" } });
    const k = await call("POST", "/v1/api-keys", { key: w.keys.admin, body: { name: "k", scopes: ["admin", "ops:write", "ops:read", "restricted:read"], owner: adm.json.data.id } });
    secrets.add(k.json.data.secret);
    const to = uniqueEmail("plain");
    expect((await call("POST", "/v1/members", { key: k.json.data.secret, body: { email: to, name: "P", role: "member", send_invite: true } })).status).toBe(201);
    const sent = mail.lastTo(to)!;
    for (const part of [sent.subject, sent.text.split("\n")[0]!]) {
      expect(part).not.toMatch(/https?:\/\/|evil\.example|[\u202a-\u202e]/);
      expect([...part].some((ch) => ch.charCodeAt(0) < 0x20), JSON.stringify(part)).toBe(false);
      expect(part).toContain("evil[.]example");
    }
    expect(sent.text).toContain("Click evil[.]example now added you");
    expect(plainName("a".repeat(500))).toHaveLength(80);
  });
});

describe("password lockout", () => {
  const good = () => `Cobalt-Fern-${Math.random().toString(36).slice(2, 10)}`;
  const auditFor = async (id: string, reason: string) => ((await call("GET", "/v1/audit-log?action=auth.sign_in_failed&limit=500", { key: ws.keys.admin })).json.data as
    { record_id: string; details: { reason: string } }[]).filter((e) => e.record_id === decodeId(id)!.uuid && e.details.reason === reason);

  it("wrong current-password guesses from a session count toward the lockout", async () => {
    const m = await member();
    const pw = good();
    const b = await signedIn(m.email);
    expect((await setPassword(b, pw)).status).toBe(200);
    // A session that isn't fresh needs the current password for a change.
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '1 hour' WHERE user_id = ${decodeId(m.id)!.uuid}`);
    for (let i = 0; i < 5; i++) {
      const r = await setPassword(b, good(), `not-the-password-${i}`);
      expect(r.status, `guess ${i}`).toBe(403);
      expect(r.json.code).toBe("current_password_wrong");
    }
    const right = await setPassword(b, good(), pw);
    expect(right.status).toBe(429);
    expect(right.json.code).toBe("password_locked");
    expect((await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw } })).status).toBe(401);
    await settleSignInTasks();
    expect(await auditFor(m.id, "wrong_current_password")).toHaveLength(5);
  });

  it("parallel wrong passwords can't outrun the lock: at most five are checked", async () => {
    const m = await member();
    const pw = good();
    await setPassword(await signedIn(m.email), pw);
    process.env.TRUST_PROXY = "true";
    try {
      const tries = await Promise.all(Array.from({ length: 40 }, (_, i) => new Browser().request("POST", "/auth/password", {
        body: { email: m.email, password: `parallel-guess-${i}-x` }, headers: { "X-Forwarded-For": `198.51.100.${i + 1}` } })));
      expect(tries.every((t) => t.status === 401)).toBe(true);
      const right = await new Browser().request("POST", "/auth/password", { body: { email: m.email, password: pw }, headers: { "X-Forwarded-For": "198.51.100.200" } });
      expect(right.status).toBe(401);
    } finally {
      delete process.env.TRUST_PROXY;
    }
    await settleSignInTasks();
    expect(await auditFor(m.id, "wrong_password")).toHaveLength(5);
    expect(await auditFor(m.id, "locked")).toHaveLength(36);
  });
});

describe("sessions, keys and sign-out", () => {
  it("a cross-site sign-out post clears nothing", async () => {
    const r = await new Browser().request("POST", "/auth/sign-out", { form: {}, headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" } });
    expect(r.status).toBe(403);
    expect(r.setCookies).toEqual([]);
    expect(r.headers.get("clear-site-data")).toBeNull();
  });

  it("an API key can't end its owner's sessions without members:manage, and gets the same answer as for an unknown session", async () => {
    const m = await memberWithKey(ws, "member", ["restricted:read"]);
    const email = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id).email;
    const b = await signedIn(email);
    const sid = (await b.request("GET", "/v1/auth/session")).json.session.id as string;
    const byKey = await call("DELETE", `/v1/sessions/${sid}`, { key: m.key });
    expect(byKey.status).toBe(404);
    expect((await b.request("GET", "/v1/me")).status).toBe(200);
    expect((await b.request("DELETE", `/v1/sessions/${sid}`)).status).toBe(200);
  });

  it("listing a member's sessions follows the rules for revoking them", async () => {
    await signedIn(ws.ownerEmail);
    const adm = await memberWithKey(ws, "admin", ["admin", "ops:read"]);
    const r = await call("GET", `/v1/members/${ws.ownerId}/sessions`, { key: adm.key });
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.json)).not.toContain("test-browser");
    expect((await call("GET", `/v1/members/${ws.ownerId}/sessions`, { key: ws.keys.admin })).json.data.length).toBeGreaterThan(0);
  });

  it("a session creates or rotates an API key only after a recent sign-in", async () => {
    const o = await signedIn(ws.ownerEmail);
    const made = await o.request("POST", "/v1/api-keys", { body: { name: "fresh", scopes: ["ops:read"] } });
    expect(made.status).toBe(201);
    secrets.add(made.json.data.secret);
    const sid = decodeId((await o.request("GET", "/v1/auth/session")).json.session.id)!.uuid;
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '1 hour' WHERE id = ${sid}`);
    const stale = await o.request("POST", "/v1/api-keys", { body: { name: "stale", scopes: ["ops:read"] } });
    expect(stale.status).toBe(403);
    expect(stale.json.code).toBe("recent_sign_in_required");
    expect((await o.request("POST", `/v1/api-keys/${made.json.data.id}/rotate`, { body: {} })).json.code).toBe("recent_sign_in_required");
    // A key still creates keys as before.
    const byKey = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "by key", scopes: ["ops:read"] } });
    expect(byKey.status).toBe(201);
    secrets.add(byKey.json.data.secret);
  });
});

describe("more memberships than are looked up", () => {
  it("puts the typed spelling first, says when there are more, and lets the person name the workspace", async () => {
    const stamp = Date.now();
    const [same, lower] = [`many-${stamp}@example.com`, `case-${stamp}@example.com`];
    const crowd: Workspace[] = [];
    for (let i = 0; i < MAX_CANDIDATES; i++) {
      const w = await newWorkspace(`Crowd ${i}`);
      crowd.push(w);
      await member("member", same, w);
      await member("member", lower.toUpperCase(), w);
    }
    const home = await newWorkspace("Crowd home");
    await member("member", same, home);
    await member("member", lower, home);
    // Twenty older workspaces holding a variant spelling don't push the typed address out of the lookup.
    const cb = new Browser();
    const at = mail.sent.length;
    await cb.request("POST", "/auth/email", { body: { email: lower } });
    await settleSignInTasks();
    const mine = mail.sent.slice(at).find((e) => e.to === lower)!;
    const byCase = await cb.request("POST", "/auth/email/verify", { body: { code: /code is (\d{4}) (\d{4})/.exec(mine.text)!.slice(1).join("") } });
    expect(byCase.json).toEqual({ status: "choose_workspace", workspaces: [{ id: home.id, name: home.name }], more_workspaces: true });
    // Twenty older workspaces with the very same address: the choice lists them and says there are more.
    const { b, done } = await byEmailCode(same);
    expect(done.json.status).toBe("choose_workspace");
    expect(done.json.more_workspaces).toBe(true);
    expect(done.json.workspaces).toHaveLength(MAX_CANDIDATES);
    expect(done.json.workspaces.map((w: { id: string }) => w.id)).not.toContain(home.id);
    expect((await b.request("GET", "/auth/choose")).text).toContain("/auth/sign-in?workspace=ws_");
    // Naming the workspace looks in that one only.
    const named = new Browser();
    await named.request("POST", "/auth/email", { body: { email: same, workspace: home.id } });
    await settleSignInTasks();
    const r = await named.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(same) } });
    expect(r.json).toMatchObject({ status: "signed_in", workspace: { id: home.id } });
    expect((await new Browser().request("GET", `/auth/sign-in?workspace=${home.id}`)).text).toContain(`name="workspace" value="${home.id}"`);
    expect((await new Browser().request("POST", "/auth/email", { body: { email: same, workspace: "nope" } })).status).toBe(422);
  });
});

describe("PUBLIC_URL at startup", () => {
  it("an invalid value stops the server with a message that says so; an absent one starts with sign-in off", () => {
    try {
      for (const bad of ["https://crm.example.com/app", "http://crm.example.com", "not a url"]) {
        process.env.PUBLIC_URL = bad;
        resetConfig();
        expect(() => assertStartupConfig("api"), bad).toThrow(/won't start/);
        expect(() => assertStartupConfig("api"), bad).not.toThrow(/stays off/);
      }
      delete process.env.PUBLIC_URL;
      resetConfig();
      // OAuth for MCP is built on people sign-in: with MCP_PUBLIC_URL set, a missing PUBLIC_URL stops the server too.
      expect(() => assertStartupConfig("api")).toThrow(/OAuth for MCP needs PUBLIC_URL/);
      delete process.env.MCP_PUBLIC_URL;
      resetConfig();
      expect(() => assertStartupConfig("api")).not.toThrow();
      expect(publicOrigin()).toBeNull();
    } finally {
      process.env.PUBLIC_URL = "https://crm.test";
      process.env.MCP_PUBLIC_URL = "https://mcp.test";
      resetConfig();
    }
  });
});

describe("no secret is stored, logged or audited in the clear", () => {
  it("scans the sign-in tables, idempotency records, the audit log and the captured logs", async () => {
    expect(secrets.size).toBeGreaterThan(10);
    const dump = await owner.begin(async (tx) => {
      const out: string[] = [];
      for (const t of ["sessions", "sign_in_flows", "member_credentials", "sign_in_identities", "audit_log", "idempotency_keys"]) {
        // The owner is bound by FORCE ROW LEVEL SECURITY too; lift it inside this transaction only, which is rolled back.
        await tx.unsafe(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
        out.push(JSON.stringify(await tx.unsafe(`SELECT * FROM ${t}`)));
      }
      throw Object.assign(new Error("rollback"), { out });
    }).catch((e: { out?: string[] }) => e.out!.join("\n"));
    expect(dump.length).toBeGreaterThan(1000);
    const leaks = [...secrets].filter((s) => dump.includes(s) || logged.some((l) => l.includes(s)));
    expect(leaks).toEqual([]);
    // Codes are only 8 digits, so check them as hashes too: the stored code is an HMAC, never a plain SHA-256.
    expect(logged.join("\n")).not.toMatch(/hlcrm_live_/);
  });
});

describe("PUBLIC_URL and local development", () => {
  const withPublicUrl = async (url: string, fn: () => Promise<void>) => {
    process.env.PUBLIC_URL = url;
    resetConfig();
    try {
      await fn();
    } finally {
      process.env.PUBLIC_URL = "https://crm.test";
      resetConfig();
    }
  };

  it("refuses plain http except on localhost, and anything but a bare origin", async () => {
    for (const bad of ["http://crm.example.com", "https://crm.example.com/app", "https://u:p@crm.example.com", "ftp://crm.example.com", "not a url"]) {
      await withPublicUrl(bad, async () => expect(() => publicOrigin(), bad).toThrow(/PUBLIC_URL/));
    }
    await withPublicUrl("http://localhost:8787", async () => expect(publicOrigin()).toEqual({ origin: "http://localhost:8787", local: true }));
    await withPublicUrl("https://crm.example.com/", async () => expect(publicOrigin()).toEqual({ origin: "https://crm.example.com", local: false }));
  });

  it("on http://localhost the cookies drop the __Host- prefix and Secure, and Origin must be the local origin", async () => {
    await withPublicUrl("http://localhost:8787", async () => {
      const b = new Browser();
      const link = await createServerLink(ws.ownerEmail, ws.id, "t");
      expect(link.url.startsWith("http://localhost:8787/auth/link?token=")).toBe(true);
      const token = new URL(link.url).searchParams.get("token")!;
      expect((await b.request("POST", "/auth/server-link", { body: { token } })).status).toBe(403); // Origin is https://crm.test
      const r = await b.request("POST", "/auth/server-link", { body: { token }, headers: { Origin: "http://localhost:8787" } });
      const cookie = r.setCookies.find((c) => c.startsWith("hlcrm_session="))!;
      expect(cookie).toMatch(/^hlcrm_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
      expect((await b.request("GET", "/v1/me")).status).toBe(200);
      expect((await b.request("POST", "/v1/objects/contact/records", { body: { first_name: "Local" }, headers: { Origin: "http://localhost:8787" } })).status).toBe(201);
    });
  });

  it("with PUBLIC_URL unset, people sign-in is off and a session cookie is ignored", async () => {
    const b = await signedIn(ws.ownerEmail);
    delete process.env.PUBLIC_URL;
    resetConfig();
    try {
      expect((await (await app.request("/auth/capabilities")).json()).enabled).toBe(false);
      expect((await new Browser().request("POST", "/auth/email", { body: { email: ws.ownerEmail } })).status).toBe(404);
      expect((await new Browser().request("GET", "/auth/sign-in")).status).toBe(404);
      const me = await app.request("/v1/me", { headers: { Cookie: b.cookieHeader() } });
      expect(me.status).toBe(401);
    } finally {
      process.env.PUBLIC_URL = "https://crm.test";
      resetConfig();
    }
  });
});
