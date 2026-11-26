import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PORT, SERVER, serverEnv } from "./env";

/**
 * Self sign-up (ADR 0018) in a real browser, the way a new person meets it: an MCP client sends a
 * browser nobody has seen to /oauth/authorize; the sign-in page offers "Create a workspace"; the person
 * proves their email with the code, names a workspace, and lands on the consent page as its owner;
 * approving reaches the client with a code. Every step is one of the server's own form posts, which
 * browsers send with Origin: null under no-referrer. Runs in Chromium, Firefox and WebKit.
 *
 * Sign-up is off in the API the other specs use (as it is by default), so this one starts its own on
 * another port, with SIGN_UP=true and a mail server of its own that keeps what it is sent.
 */

const API_PORT = PORT + 3;
const ORIGIN = `http://localhost:${API_PORT}`;
const MCP_ORIGIN = `http://localhost:${API_PORT + 1}`;

/** A mail server that accepts everything and keeps it: just enough SMTP for one message per connection. */
function mailSink(): { server: Server; messages: { to: string; raw: string }[] } {
  const messages: { to: string; raw: string }[] = [];
  const server = createTcpServer((socket) => {
    let buffer = "";
    let to = "";
    let inData = false;
    socket.write("220 sink ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push({ to, raw: buffer.slice(0, end) });
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write("250 kept\r\n");
          continue;
        }
        const eol = buffer.indexOf("\r\n");
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === "RCPT") to = /<([^>]+)>/.exec(line)?.[1] ?? "";
        if (verb === "DATA") {
          inData = true;
          socket.write("354 go on\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
    socket.on("error", () => {});
  });
  return { server, messages };
}

let api: ChildProcess;
let sink: ReturnType<typeof mailSink>;

test.beforeAll(async () => {
  sink = mailSink();
  await new Promise<void>((r) => sink.server.listen(0, "127.0.0.1", r));
  const smtpPort = (sink.server.address() as AddressInfo).port;
  api = spawn(join(SERVER, "node_modules", ".bin", "tsx"), ["src/cli.ts", "api"], { cwd: SERVER, stdio: "ignore", env: {
    ...serverEnv(), API_PORT: String(API_PORT), PUBLIC_URL: ORIGIN, MCP_PUBLIC_URL: MCP_ORIGIN, SMTP_URL: `smtp://127.0.0.1:${smtpPort}`, SIGN_UP: "true",
    // Every browser here comes from this machine, run after run.
    SIGN_UP_WORKSPACES_PER_ADDRESS_DAY: "100000", SIGN_UP_WORKSPACES_PER_HOUR: "100000", SIGN_UP_WORKSPACES_PER_DAY: "100000",
  } });
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${ORIGIN}/readyz`).then((r) => r.ok).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the sign-up API didn't start");
});

test.afterAll(async () => {
  api?.kill();
  await new Promise<void>((r) => sink.server.close(() => r()));
});

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const m = [...sink.messages].reverse().find((x) => x.to === email);
    const code = m && /code is (\d{4}) (\d{4})/.exec(m.raw);
    if (code) return `${code[1]}${code[2]}`;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no sign-up email arrived for ${email}`);
}

test("a new person sent by an MCP client creates a workspace and comes back connected", async ({ browser, browserName }) => {
  expect((await (await fetch(`${ORIGIN}/auth/capabilities`)).json() as { sign_up: boolean }).sign_up).toBe(true);
  // The client: registered with a loopback redirect, listening for the browser to come back.
  let arrived!: (v: { url: URL; headers: IncomingHttpHeaders }) => void;
  const arrival = new Promise<{ url: URL; headers: IncomingHttpHeaders }>((r) => (arrived = r));
  const client = createHttpServer((req, res) => {
    arrived({ url: new URL(req.url ?? "/", "http://localhost"), headers: req.headers });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("the client got it");
  });
  await new Promise<void>((r) => client.listen(0, "localhost", r));
  const redirect = `http://localhost:${(client.address() as AddressInfo).port}/callback`;
  const registered = await fetch(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: `Sign-up client ${browserName}`, redirect_uris: ["http://localhost:51234/callback"], application_type: "native",
      grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }) });
  expect(registered.status).toBe(201);
  const clientId = (await registered.json() as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString("base64url");
  const state = `st-${randomBytes(8).toString("hex")}`;
  const authorize = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: "ops:read ops:write",
    resource: `${MCP_ORIGIN}/mcp/ops`, state, code_challenge: s256(verifier), code_challenge_method: "S256" })}`;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posts: { path: string; origin?: string; site?: string; referer?: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") void r.allHeaders().then((h) => posts.push({ path: new URL(r.url()).pathname, origin: h.origin, site: h["sec-fetch-site"], referer: h.referer }), () => {});
  });

  // Nobody is signed in: the sign-in page, which offers to create a workspace and keeps the request.
  await page.goto(`${ORIGIN}${authorize}`);
  await page.waitForURL((u) => u.pathname === "/auth/sign-in");
  await page.getByRole("link", { name: "Create a workspace" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/sign-up");
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(authorize);

  const email = `new-${browserName}-${Date.now().toString(36)}@example.com`;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/sign-up/code");
  // A wrong code says so and lets them try again.
  await page.getByLabel("Code").fill("0000 0000");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert")).toContainText("That code is not right");
  await page.getByLabel("Code").fill(await codeFor(email));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/sign-up/workspace");
  await expect(page.getByText(email)).toBeVisible();

  const workspace = `Fresh ${browserName} ${Date.now().toString(36)}`;
  await page.getByLabel(/Workspace name/).fill(workspace);
  await page.getByLabel("Your name").fill("Nia Newcomer");
  const consent = page.waitForResponse((r) => new URL(r.url()).pathname === "/oauth/authorize" && r.request().method() === "GET");
  await page.getByRole("button", { name: "Create workspace" }).click();
  expect((await consent).status()).toBe(200);
  // Back at the client's request, as the owner of the workspace made a moment ago.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Sign-up client ${browserName}`);
  await expect(page.getByText(`Nia Newcomer (${email}) in ${workspace}`)).toBeVisible();

  await page.getByRole("button", { name: "Allow" }).click();
  const back = await arrival;
  await page.waitForURL((u) => u.pathname === "/callback", { timeout: 10_000 }).catch(() => {});
  client.close();
  expect(back.url.searchParams.get("state")).toBe(state);
  const code = back.url.searchParams.get("code")!;
  expect(code).toBeTruthy();
  expect(back.headers.referer).toBeUndefined();

  // Each step went out as the page's own form post, and the server took it (recorded per engine).
  for (const path of ["/auth/sign-up", "/auth/sign-up/verify", "/auth/sign-up/workspace", "/oauth/authorize"]) {
    const post = posts.find((p) => p.path === path);
    expect(post, `${browserName} ${path}`).toBeTruthy();
    expect(post!.site).toBe("same-origin");
    expect([ORIGIN, "null"]).toContain(post!.origin);
  }
  expect(posts.filter((p) => p.referer && (p.referer.includes(state) || p.referer.includes(code)))).toEqual([]);
  test.info().annotations.push({ type: "sign-up-post", description: `${browserName}: Origin ${posts.find((p) => p.path === "/auth/sign-up")!.origin ?? "(none)"}` });

  // The code is good, and the new owner is in their own workspace in the app.
  const token = await fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId, resource: `${MCP_ORIGIN}/mcp/ops` }).toString() });
  expect(token.status).toBe(200);
  await page.goto(`${ORIGIN}/auth/signed-in`);
  await expect(page.getByText(workspace)).toBeVisible();
  await expect(page.getByText("owner", { exact: true })).toBeVisible();
  await ctx.close();
});

test("the app's own sign-in screen offers it too, and without a destination the new owner lands in the app", async ({ page, browserName }) => {
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByRole("link", { name: "Create a workspace" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/sign-up");
  const email = `app-${browserName}-${Date.now().toString(36)}@example.com`;
  await page.getByLabel("Your email").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await page.waitForURL((u) => u.pathname === "/auth/sign-up/code");
  await page.getByLabel("Code").fill(await codeFor(email));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel(/Workspace name/).fill(`App ${browserName}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  const session = await page.evaluate(async () => (await fetch("/v1/auth/session")).json()) as { role: string; workspace: { name: string } };
  expect(session).toMatchObject({ role: "owner", workspace: { name: `App ${browserName}` } });
});
