import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthLimiter } from "../src/api/app.js";
import { LIMITS, resetSignInLimits } from "../src/auth/limits.js";
import { settleSignInTasks } from "../src/auth/signin.js";
import { resetSignUpAlarms, SIGN_UP_MINUTES } from "../src/auth/signup.js";
import { assertStartupConfig, resetConfig } from "../src/config.js";
import { decodeId } from "../src/lib/ids.js";
import { logger } from "../src/lib/logger.js";
import { DisabledMailer, setMailer } from "../src/providers/mailer.js";
import { app, Browser, call, FakeMailer, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";
import { connectApp, mcpClient, registerClient, tool } from "./oauth-client.js";

/**
 * Self sign-up (ADR 0018, docs/sign-in.md), end to end through the app: off unless the operator turns
 * it on, the whole flow (also from an app's connection request), every limit and cap, that an answer
 * never says whether an address belongs to anyone, and that two workspaces of one address stay apart.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const mail = new FakeMailer();
const logged: { level: string; args: string }[] = [];
let existing: Workspace;

const SETTINGS = ["SIGN_UP", "SIGN_UP_ALLOWED_DOMAINS", "SIGN_UP_MAX_WORKSPACES_PER_EMAIL", "SIGN_UP_WORKSPACES_PER_ADDRESS_DAY", "SIGN_UP_WORKSPACES_PER_HOUR",
  "SIGN_UP_WORKSPACES_PER_DAY", "SIGN_UP_EMAILS_PER_HOUR", "TRUST_PROXY", "SMTP_URL"] as const;

/** Turns sign-up on (or sets anything else) for one test; afterEach puts the environment back. */
function configure(env: Partial<Record<(typeof SETTINGS)[number], string>> = {}) {
  Object.assign(process.env, { SIGN_UP: "true", ...env });
  resetConfig();
}

beforeAll(async () => {
  existing = await newWorkspace("Already here");
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push({ level, args: JSON.stringify(args) }); }) as never);
  }
});
beforeEach(() => {
  setMailer(mail);
  resetSignInLimits();
  resetAuthLimiter();
  resetSignUpAlarms();
  logged.length = 0;
});
afterEach(async () => {
  await settleSignInTasks();
  for (const k of SETTINGS) delete process.env[k];
  resetConfig();
});

/** How many workspaces sign-up has created in this database in the last hour (the table shows itself only to a transaction that says it is counting). */
const signUpsThisHour = () => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.sign_up_count', 'on', true)`;
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM workspace_sign_ups WHERE created_at > now() - interval '1 hour'`;
  return r!.n;
}) as Promise<number>;

const from = (ip: string) => ({ "X-Forwarded-For": ip });

/** Asks for a code and enters it: the browser is left at the step that names the workspace. */
async function proven(email: string, b = new Browser(), headers: Record<string, string> = {}) {
  const start = await b.request("POST", "/auth/sign-up", { body: { email }, headers });
  expect(start.status, JSON.stringify(start.json)).toBe(202);
  await settleSignInTasks();
  const verified = await b.request("POST", "/auth/sign-up/verify", { body: { code: mail.codeFor(email)! }, headers });
  expect(verified.status, JSON.stringify(verified.json)).toBe(200);
  expect(verified.json).toEqual({ status: "name_workspace" });
  return b;
}

/** The whole flow over JSON. Returns the signed-in browser and the last response. */
async function signUp(email: string, name: string, headers: Record<string, string> = {}) {
  const b = await proven(email, new Browser(), headers);
  const done = await b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: name, name: "New Owner" }, headers });
  return { b, done };
}

describe("off by default", () => {
  it("offers nothing: no capability, no link on the sign-in page, and the pages and endpoints answer 404", async () => {
    expect((await (await app.request("/auth/capabilities")).json()).sign_up).toBe(false);
    const page = await new Browser().request("GET", "/auth/sign-in");
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("sign-up");
    expect(page.text).not.toContain("Create a workspace");
    for (const path of ["/auth/sign-up", "/auth/sign-up/code", "/auth/sign-up/workspace"]) {
      expect((await new Browser().request("GET", path)).status, path).toBe(404);
    }
    const before = mail.sent.length;
    for (const [path, body] of [["/auth/sign-up", { email: uniqueEmail("off") }], ["/auth/sign-up/verify", { code: "12345678" }],
      ["/auth/sign-up/workspace", { workspace_name: "Nope" }]] as const) {
      const r = await new Browser().request("POST", path, { body });
      expect(r.status, path).toBe(404);
      expect(r.json.code).toBe("unavailable");
    }
    // A form post lands on a page that says so, and nothing was sent.
    const form = await new Browser().request("POST", "/auth/sign-up", { form: { email: uniqueEmail("off") } });
    expect(form.status).toBe(303);
    expect(form.headers.get("location")).toBe("/auth/sign-up?error=unavailable");
    await settleSignInTasks();
    expect(mail.sent.length).toBe(before);
  });

  it("turned on without email working, it stays unavailable; the server refuses to start that way", async () => {
    configure();
    setMailer(new DisabledMailer());
    expect((await (await app.request("/auth/capabilities")).json()).sign_up).toBe(false);
    expect((await new Browser().request("GET", "/auth/sign-up")).status).toBe(404);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: uniqueEmail("nomail") } })).status).toBe(404);
    expect(() => assertStartupConfig("api")).toThrow(/SIGN_UP needs email: set SMTP_URL/);
    configure({ SMTP_URL: "smtp://localhost:2525" });
    expect(() => assertStartupConfig("api")).not.toThrow();
  });

  it("the server refuses to start with sign-up on and no PUBLIC_URL, or with a domain list that isn't one", () => {
    configure({ SMTP_URL: "smtp://localhost:2525", SIGN_UP_ALLOWED_DOMAINS: "example.com, not a domain" });
    expect(() => assertStartupConfig("api")).toThrow(/SIGN_UP_ALLOWED_DOMAINS must be email domains/);
    configure({ SMTP_URL: "smtp://localhost:2525" });
    const [pub, mcp] = [process.env.PUBLIC_URL, process.env.MCP_PUBLIC_URL];
    delete process.env.PUBLIC_URL;
    delete process.env.MCP_PUBLIC_URL;
    resetConfig();
    try {
      expect(() => assertStartupConfig("api")).toThrow(/SIGN_UP needs PUBLIC_URL/);
    } finally {
      process.env.PUBLIC_URL = pub;
      process.env.MCP_PUBLIC_URL = mcp;
      resetConfig();
    }
  });
});

describe("creating a workspace", () => {
  it("email, code, name: the person is signed in as the owner of a new workspace that has no API keys", async () => {
    configure();
    expect((await (await app.request("/auth/capabilities")).json()).sign_up).toBe(true);
    const email = uniqueEmail("founder");
    const b = new Browser();
    const start = await b.request("POST", "/auth/sign-up", { body: { email } });
    expect(start.status).toBe(202);
    expect(start.json).toEqual({ status: "code_sent", detail: expect.stringContaining(`${SIGN_UP_MINUTES.code} minutes`) });
    const pre = b.cookies.get("__Host-hlcrm_signin")!;
    await settleSignInTasks();
    const message = mail.lastTo(email)!;
    expect(message.subject).toBe("Your code to create a workspace");
    expect(message.text).toContain("https://crm.test/auth/sign-in");
    const code = mail.codeFor(email)!;

    const verified = await b.request("POST", "/auth/sign-up/verify", { body: { code } });
    expect(verified.json).toEqual({ status: "name_workspace" });
    // Proving the address starts a new step under a new cookie, and creates nothing.
    expect(b.cookies.get("__Host-hlcrm_signin")).not.toBe(pre);
    expect(b.cookies.has("__Host-hlcrm_session")).toBe(false);

    const done = await b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: "  Fresh   Co ", name: "Fran Founder", currency: "eur" } });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ status: "signed_in", workspace: { id: expect.stringMatching(/^ws_/), name: "Fresh Co" }, csrf_token: expect.any(String) });
    expect(b.cookies.has("__Host-hlcrm_signin")).toBe(false);

    const me = await b.request("GET", "/v1/me");
    expect(me.json).toMatchObject({ actor: { type: "user" }, role: "owner", surface: "web" });
    const wsInfo = await b.request("GET", "/v1/workspace");
    expect(wsInfo.json.data).toMatchObject({ id: done.json.workspace.id, name: "Fresh Co", currency: "EUR" });
    const members = await b.request("GET", "/v1/members");
    expect(members.json.data.users).toEqual([expect.objectContaining({ email, name: "Fran Founder", role: "owner", active: true })]);
    // No key was minted: there is nowhere on a web page to show a secret once. The owner makes keys later.
    expect((await b.request("GET", "/v1/api-keys")).json.data).toEqual([]);
    // The standard objects and the default pipeline are there, as after `bootstrap`.
    expect((await b.request("POST", "/v1/objects/contact/records", { body: { first_name: "First" } })).status).toBe(201);
    expect((await b.request("GET", "/v1/pipelines")).json.data.length).toBeGreaterThan(0);

    const log = await b.request("GET", "/v1/audit-log?action=workspace.created");
    expect(log.json.data).toHaveLength(1);
    expect(log.json.data[0]).toMatchObject({ actor: "system", surface: "web", details: { name: "Fresh Co", via: "sign_up" } });
    const signedInLog = await b.request("GET", "/v1/audit-log?action=auth.signed_in");
    expect(signedInLog.json.data[0]).toMatchObject({ details: { method: "email_code" } });

    // The steps are spent: neither the code nor the naming step works a second time.
    expect((await b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: "Again" } })).status).toBe(400);
    const other = new Browser();
    other.cookies.set("__Host-hlcrm_signin", pre);
    expect((await other.request("POST", "/auth/sign-up/verify", { body: { code } })).json.code).toBe("expired");

    // From now on the address signs in like any member.
    const again = new Browser();
    await again.request("POST", "/auth/email", { body: { email } });
    await settleSignInTasks();
    const back = await again.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(email)! } });
    expect(back.json).toMatchObject({ status: "signed_in", workspace: { name: "Fresh Co" } });
  });

  it("a workspace made by the operator's bootstrap still gets its two keys, and says how it was made", async () => {
    const log = await call("GET", "/v1/audit-log?action=workspace.created", { key: existing.keys.admin });
    expect(log.json.data[0]).toMatchObject({ surface: "system", details: { via: "bootstrap" } });
    expect((await call("GET", "/v1/api-keys", { key: existing.keys.admin })).json.data).toHaveLength(2);
  });

  it("the built-in pages lead through it, and a name that can't be used costs only another try", async () => {
    configure();
    const email = uniqueEmail("pages");
    const b = new Browser();
    const signIn = await b.request("GET", "/auth/sign-in");
    expect(signIn.text).toContain('<a href="/auth/sign-up">Create a workspace</a>');
    const page = await b.request("GET", "/auth/sign-up");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.text).toContain('<form method="post" action="/auth/sign-up">');
    // The pages' own form posts carry Origin: null (they are served with no-referrer) and Sec-Fetch-Site: same-origin.
    const asPage = { Origin: "null" };
    const start = await b.request("POST", "/auth/sign-up", { form: { email }, headers: asPage });
    expect([start.status, start.headers.get("location")]).toEqual([303, "/auth/sign-up/code"]);
    expect((await b.request("GET", "/auth/sign-up/code")).text).toContain('action="/auth/sign-up/verify"');
    await settleSignInTasks();
    const wrong = await b.request("POST", "/auth/sign-up/verify", { form: { code: "0000 0000" }, headers: asPage });
    expect(wrong.headers.get("location")).toBe("/auth/sign-up/code?error=invalid_code");
    const verified = await b.request("POST", "/auth/sign-up/verify", { form: { code: mail.codeFor(email)! }, headers: asPage });
    expect([verified.status, verified.headers.get("location")]).toEqual([303, "/auth/sign-up/workspace"]);
    const naming = await b.request("GET", "/auth/sign-up/workspace");
    expect(naming.status).toBe(200);
    expect(naming.text).toContain(`Signing up as <strong>${email.replace(/[=]/g, "&#61;")}</strong>`);
    expect(naming.text).not.toContain("already belongs");

    for (const bad of [{ workspace_name: "   " }, { workspace_name: "Fine", currency: "dollars" }, { workspace_name: "x".repeat(201) }, { workspace_name: "a\u0007b" }]) {
      const r = await b.request("POST", "/auth/sign-up/workspace", { form: { currency: "USD", ...bad }, headers: asPage });
      expect([r.status, r.headers.get("location")], JSON.stringify(bad)).toEqual([303, "/auth/sign-up/workspace?error=validation_failed"]);
    }
    expect((await b.request("GET", "/auth/sign-up/workspace?error=validation_failed")).text).toContain('role="alert"');
    const done = await b.request("POST", "/auth/sign-up/workspace", { form: { workspace_name: "Page Co", name: "", currency: "USD" }, headers: asPage });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/auth/signed-in");
    const landed = await b.request("GET", "/auth/signed-in");
    expect(landed.text).toContain("Page Co");
    // With no name given, the owner is named by their address until they change it.
    expect((await b.request("GET", "/v1/members")).json.data.users[0]).toMatchObject({ email, name: email });
    // With no live step, the naming page says to start again.
    const stale = await new Browser().request("GET", "/auth/sign-up/workspace");
    expect(stale.status).toBe(400);
    expect(stale.text).toContain('href="/auth/sign-up"');
  });

  it("posts from another site, or with no Origin, are refused before anything happens", async () => {
    configure();
    const email = uniqueEmail("csrf");
    const before = mail.sent.length;
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email }, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email }, headers: { Origin: "" } })).status).toBe(403);
    expect((await new Browser().request("POST", "/auth/sign-up", { form: { email }, headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    await settleSignInTasks();
    expect(mail.sent.length).toBe(before);
  });

  it("a code works only in the browser that asked for it, and five wrong codes void it", async () => {
    configure();
    const email = uniqueEmail("bound");
    const b = new Browser();
    await b.request("POST", "/auth/sign-up", { body: { email } });
    await settleSignInTasks();
    const code = mail.codeFor(email)!;
    expect((await new Browser().request("POST", "/auth/sign-up/verify", { body: { code } })).json.code).toBe("expired");
    // A sign-in code step can't be finished with it either, nor a sign-up with the sign-in endpoint.
    expect((await b.request("POST", "/auth/email/verify", { body: { code } })).json.code).toBe("expired");
    for (let i = 0; i < 4; i++) {
      const r = await b.request("POST", "/auth/sign-up/verify", { body: { code: "00000000" } });
      expect(r.json).toMatchObject({ code: "invalid_code", errors: { attempts_left: 4 - i } });
    }
    expect((await b.request("POST", "/auth/sign-up/verify", { body: { code: "00000000" } })).json.errors.attempts_left).toBe(0);
    expect((await b.request("POST", "/auth/sign-up/verify", { body: { code } })).json.code).toBe("expired");
  });

  it("the code is stored only as an HMAC, and the flow's address goes when the flow does", async () => {
    configure();
    const email = uniqueEmail("stored");
    const b = new Browser();
    await b.request("POST", "/auth/sign-up", { body: { email } });
    await settleSignInTasks();
    const code = mail.codeFor(email)!;
    const { createHash } = await import("node:crypto");
    const hex = createHash("sha256").update(b.cookies.get("__Host-hlcrm_signin")!).digest("hex");
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.flow_browser', ${hex}, true)`;
      return tx`SELECT purpose, email, code_hash, candidates::text AS candidates FROM sign_in_flows`;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: "sign_up", email, candidates: "[]" });
    expect(JSON.stringify(rows)).not.toContain(code);
    expect((rows[0]!.code_hash as Buffer).length).toBe(32);
    expect(logged.map((l) => l.args).join("\n")).not.toContain(code);
  });
});

describe("from an app's connection request (OAuth for MCP)", () => {
  it("a new person connecting from Claude signs up, lands on the consent page, and the app works in their new workspace", async () => {
    configure();
    const { createHash, randomBytes } = await import("node:crypto");
    const { oauthSettings } = await import("../src/config.js");
    const client = await registerClient("Claude");
    const verifier = randomBytes(32).toString("base64url");
    const q = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope: "ops:read ops:write",
      resource: oauthSettings()!.resources.ops, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st-1" });
    const authorize = `/oauth/authorize?${q}`;
    const b = new Browser();
    const asPage = { Origin: "null" };

    // Not signed in: to the sign-in page, which offers to create a workspace and keeps where the person was going.
    const first = await b.request("GET", authorize);
    expect(first.status).toBe(303);
    const signInUrl = first.headers.get("location")!;
    expect(signInUrl).toBe(`/auth/sign-in?return_to=${encodeURIComponent(authorize)}`);
    const signIn = await b.request("GET", signInUrl);
    const link = /<a href="([^"]+)">Create a workspace<\/a>/.exec(signIn.text)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    expect(link).toBe(`/auth/sign-up?return_to=${encodeURIComponent(authorize)}`);
    const page = await b.request("GET", link);
    const hiddenReturn = /name="return_to" value="([^"]*)"/.exec(page.text)![1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    expect(hiddenReturn).toBe(authorize);
    // And the way back to sign-in keeps it too.
    expect(page.text).toContain(`/auth/sign-in?return_to&#61;${encodeURIComponent(authorize)}`);

    const email = uniqueEmail("claude-user");
    await b.request("POST", "/auth/sign-up", { form: { email, return_to: hiddenReturn }, headers: asPage });
    await settleSignInTasks();
    await b.request("POST", "/auth/sign-up/verify", { form: { code: mail.codeFor(email)! }, headers: asPage });
    const done = await b.request("POST", "/auth/sign-up/workspace", { form: { workspace_name: "Connected Co", name: "Casey", currency: "USD" }, headers: asPage });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(authorize);

    // Back at the app's request, now as the new workspace's owner.
    const consent = await b.request("GET", authorize);
    expect(consent.status).toBe(200);
    expect(consent.text).toContain("Connect Claude?");
    expect(consent.text).toContain("Connected Co");
    const tokens = await connectApp(b, client, "ops", "ops:read ops:write");
    const mcp = await mcpClient("ops", tokens.access_token);
    const made = await tool(mcp, "create_record", { object: "contact", values: { first_name: "Via", last_name: "Claude" } });
    expect(made.isError, made.text).toBe(false);
    const seen = await b.request("GET", "/v1/objects/contact/records");
    expect(seen.json.data.map((r: { last_name: string }) => r.last_name)).toEqual(["Claude"]);
    await mcp.close();
  });

  it("return_to is a path on this origin or it is dropped", async () => {
    configure();
    const email = uniqueEmail("return");
    const b = new Browser();
    await b.request("POST", "/auth/sign-up", { body: { email, return_to: "https://evil.example/x" } });
    await settleSignInTasks();
    await b.request("POST", "/auth/sign-up/verify", { body: { code: mail.codeFor(email)! } });
    const done = await b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: "Return Co" } });
    expect(done.json.return_to).toBe("/auth/signed-in");
    expect((await new Browser().request("GET", "/auth/sign-up?return_to=//evil.example")).text).not.toContain("evil.example");
  });
});

describe("an answer never says whether an address belongs to anyone", () => {
  it("a member's address and an unknown one get the same response, the same email, and no trace in any workspace", async () => {
    configure();
    const unknown = uniqueEmail("nobody");
    const answers = [];
    for (const email of [existing.ownerEmail, unknown]) {
      const r = await new Browser().request("POST", "/auth/sign-up", { body: { email } });
      answers.push({ status: r.status, json: r.json, cookies: r.setCookies.map((c) => c.replace(/=[A-Za-z0-9_-]{43}/, "=…")) });
    }
    expect(answers[0]).toEqual(answers[1]);
    await settleSignInTasks();
    const strip = (t: string) => t.replace(/\d{4} \d{4}/, "…");
    expect(strip(mail.lastTo(existing.ownerEmail)!.text)).toBe(strip(mail.lastTo(unknown)!.text));
    expect(mail.lastTo(existing.ownerEmail)!.subject).toBe(mail.lastTo(unknown)!.subject);
    // Nothing was written to the member's workspace: asking for a sign-up code is not an event there.
    const log = await call("GET", "/v1/audit-log?limit=50", { key: existing.keys.admin });
    expect(log.json.data.map((e: { action: string }) => e.action)).not.toContain("auth.code_sent");
  });

  it("only once the address is proven does the page name the workspaces it already belongs to", async () => {
    configure();
    const b = await proven(existing.ownerEmail);
    const naming = await b.request("GET", "/auth/sign-up/workspace");
    expect(naming.text).toContain(`already belongs to <strong>${existing.name}</strong>`);
    expect(naming.text).toContain('<a href="/auth/sign-in">sign in instead</a>');
  });
});

describe("limits and caps", () => {
  it("an address outside SIGN_UP_ALLOWED_DOMAINS is told so plainly, and gets no email", async () => {
    configure({ SIGN_UP_ALLOWED_DOMAINS: "Example.com, example.org" });
    const before = mail.sent.length;
    const r = await new Browser().request("POST", "/auth/sign-up", { body: { email: "someone@elsewhere.test" } });
    expect([r.status, r.json.code]).toEqual([403, "sign_up_domain"]);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: "x@sub.example.com" } })).status).toBe(403);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: "not-an-email" } })).status).toBe(422);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: "üser@example.com" } })).status).toBe(422);
    await settleSignInTasks();
    expect(mail.sent.length).toBe(before);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: `ok-${Date.now()}@EXAMPLE.com` } })).status).toBe(202);
    const form = await new Browser().request("POST", "/auth/sign-up", { form: { email: "someone@elsewhere.test" }, headers: { Origin: "null" } });
    expect(form.headers.get("location")).toBe("/auth/sign-up?error=sign_up_domain");
    expect((await new Browser().request("GET", "/auth/sign-up?error=sign_up_domain")).text).toContain("only lets addresses at its own domains");
  });

  it("code requests: 10 an hour per client address (an IPv6 /64), and the per-email allowances are shared with sign-in codes", async () => {
    configure({ TRUST_PROXY: "true" });
    for (let i = 0; i < LIMITS.signUpAddress.max; i++) {
      expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: uniqueEmail(`a${i}`) }, headers: from(`2001:db8:5:5::${i + 1}`) })).status).toBe(202);
    }
    const limited = await new Browser().request("POST", "/auth/sign-up", { body: { email: uniqueEmail("a-more") }, headers: from("2001:db8:5:5:ffff::9") });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: uniqueEmail("a-other") }, headers: from("2001:db8:5:6::1") })).status).toBe(202);

    // One inbox: three sign-in codes and two sign-up codes from one address are the five it may have in 15 minutes.
    const victim = uniqueEmail("inbox");
    for (let i = 0; i < 3; i++) expect((await new Browser().request("POST", "/auth/email", { body: { email: victim }, headers: from("203.0.113.70") })).status).toBe(202);
    for (let i = 0; i < 2; i++) expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: victim }, headers: from("203.0.113.70") })).status).toBe(202);
    expect((await new Browser().request("POST", "/auth/sign-up", { body: { email: victim.toUpperCase() }, headers: from("203.0.113.70") })).status).toBe(429);
    expect((await new Browser().request("POST", "/auth/email", { body: { email: victim }, headers: from("203.0.113.70") })).status).toBe(429);
  });

  it("past SIGN_UP_EMAILS_PER_HOUR the email is skipped and an error logged, and the requester is told nothing different", async () => {
    configure({ SIGN_UP_EMAILS_PER_HOUR: "2" });
    const emails = [uniqueEmail("m1"), uniqueEmail("m2"), uniqueEmail("m3"), uniqueEmail("m4")];
    const answers = [];
    for (const email of emails) {
      const r = await new Browser().request("POST", "/auth/sign-up", { body: { email } });
      answers.push([r.status, r.json]);
      await settleSignInTasks();
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(emails.map((e) => Boolean(mail.lastTo(e)))).toEqual([true, true, false, false]);
    const errors = logged.filter((l) => l.level === "error" && l.args.includes("sign_up_email_limited"));
    expect(errors).toHaveLength(1); // once an hour, not once a request
  });

  it("one address may create SIGN_UP_MAX_WORKSPACES_PER_EMAIL workspaces; past it the proven step is refused and kept", async () => {
    configure({ SIGN_UP_MAX_WORKSPACES_PER_EMAIL: "2" });
    const email = uniqueEmail("serial");
    expect((await signUp(email, "One")).done.status).toBe(200);
    // The cap counts the address however it is spelled.
    expect((await signUp(email.toUpperCase().replace("@EXAMPLE.COM", "@example.com"), "Two")).done.status).toBe(200);
    const b = await proven(email);
    const third = await b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: "Three" } });
    expect([third.status, third.json.code]).toEqual([409, "sign_up_cap"]);
    expect(b.cookies.has("__Host-hlcrm_session")).toBe(false);
    // Nothing was created, and the page tells them where to go.
    const naming = await b.request("GET", "/auth/sign-up/workspace?error=sign_up_cap");
    expect(naming.status).toBe(200);
    expect(naming.text).toContain("as many workspaces as one address may");
    expect(naming.text).toContain("<strong>One</strong>, <strong>Two</strong>");
    // Another address is not affected.
    expect((await signUp(uniqueEmail("other"), "Other")).done.status).toBe(200);
  });

  it("one client address may create SIGN_UP_WORKSPACES_PER_ADDRESS_DAY workspaces a day, an IPv6 address counted by its /64", async () => {
    configure({ TRUST_PROXY: "true", SIGN_UP_WORKSPACES_PER_ADDRESS_DAY: "1" });
    const net = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;
    expect((await signUp(uniqueEmail("n1"), "Net one", from(`${net}::1`))).done.status).toBe(200);
    const second = await signUp(uniqueEmail("n2"), "Net two", from(`${net}:abcd::2`));
    expect([second.done.status, second.done.json.code]).toEqual([429, "sign_up_limited"]);
    expect(Number(second.done.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(second.b.cookies.has("__Host-hlcrm_session")).toBe(false);
    // The step is kept: the same person, from an address with room, finishes without starting over.
    const elsewhere = await second.b.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: "Net two" }, headers: from("198.51.100.200") });
    expect(elsewhere.status).toBe(200);
  });

  it("past the server-wide ceiling nothing is created and an error is logged, once", async () => {
    configure({ SIGN_UP_WORKSPACES_PER_HOUR: String((await signUpsThisHour()) + 1) });
    expect((await signUp(uniqueEmail("c1"), "Ceiling one")).done.status).toBe(200);
    for (const n of ["c2", "c3"]) {
      const r = await signUp(uniqueEmail(n), `Ceiling ${n}`);
      expect([r.done.status, r.done.json.code]).toEqual([429, "sign_up_limited"]);
    }
    expect(logged.filter((l) => l.level === "error" && l.args.includes("sign_up_ceiling"))).toHaveLength(1);
    // The daily ceiling works the same way.
    configure({ SIGN_UP_WORKSPACES_PER_DAY: String(await signUpsThisHour()) });
    expect((await signUp(uniqueEmail("c4"), "Ceiling day")).done.status).toBe(429);
    // The operator's own bootstrap is not counted and not held back.
    await expect(newWorkspace("Operator")).resolves.toBeTruthy();
  });

  it("two sign-ups at once can't both fit under a cap", async () => {
    configure({ SIGN_UP_MAX_WORKSPACES_PER_EMAIL: "1" });
    const email = uniqueEmail("race");
    const [a, b] = [await proven(email), await proven(email)];
    const results = await Promise.all([a, b].map((x, i) => x.request("POST", "/auth/sign-up/workspace", { body: { workspace_name: `Race ${i}` } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe("row-level security", () => {
  it("the record of sign-ups holds no address, shows nothing without the sign-up setting, and can't be changed or deleted by the app", async () => {
    configure();
    const email = uniqueEmail("rls");
    const { done } = await signUp(email, "RLS Co");
    const tenant = decodeId(done.json.workspace.id)!.uuid;
    expect(await sql`SELECT * FROM workspace_sign_ups`).toHaveLength(0);
    await expect(sql`INSERT INTO workspace_sign_ups (tenant_id, email_key) VALUES (${tenant}, ${Buffer.alloc(32)})`).rejects.toThrow(/row-level security/);
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.sign_up_count', 'on', true)`;
      const [row] = await tx`SELECT * FROM workspace_sign_ups WHERE tenant_id = ${tenant}`;
      expect((row!.email_key as Buffer).length).toBe(32);
      expect(JSON.stringify(row)).not.toContain(email);
      await expect(tx.savepoint((sp) => sp`UPDATE workspace_sign_ups SET created_at = now() - interval '2 days' WHERE tenant_id = ${tenant}`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`DELETE FROM workspace_sign_ups WHERE tenant_id = ${tenant}`)).rejects.toThrow(/permission denied/);
    });
  });
});

describe("two workspaces of one address", () => {
  it("are separate workspaces: neither sees the other's records or members, and sign-in asks which one", async () => {
    configure();
    const email = uniqueEmail("twice");
    const one = await signUp(email, "First of two");
    const two = await signUp(email, "Second of two");
    expect(one.done.json.workspace.id).not.toBe(two.done.json.workspace.id);
    const made = await one.b.request("POST", "/v1/objects/contact/records", { body: { first_name: "Only", last_name: "InFirst" } });
    expect(made.status).toBe(201);
    expect((await two.b.request("POST", "/v1/query", { body: { object: "contact" } })).json.data).toEqual([]);
    expect((await two.b.request("GET", `/v1/objects/contact/records/${made.json.data.id}`)).status).toBe(404);
    expect((await one.b.request("POST", "/v1/query", { body: { object: "contact" } })).json.data).toHaveLength(1);
    // Each has its own owner row for the address, and its own audit log.
    const ids = await Promise.all([one, two].map(async (x) => (await x.b.request("GET", "/v1/me")).json.actor.id));
    expect(ids[0]).not.toBe(ids[1]);
    for (const x of [one, two]) expect((await x.b.request("GET", "/v1/audit-log?action=workspace.created")).json.data).toHaveLength(1);

    const again = new Browser();
    await again.request("POST", "/auth/email", { body: { email } });
    await settleSignInTasks();
    const choice = await again.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(email)! } });
    expect(choice.json.status).toBe("choose_workspace");
    expect(choice.json.workspaces.map((w: { name: string }) => w.name).sort()).toEqual(["First of two", "Second of two"]);
  });
});
