import type { Context, Hono } from "hono";
import { clearCookie, cookieNames, readCookie, setCookie } from "../auth/cookies.js";
import { finishSso, ssoSettings, startSso } from "../auth/oidc.js";
import { FLOW_MINUTES, chooseWorkspace, passwordSignIn, startEmailSignIn, useEmailLink, useServerLink, verifyEmailCode, type SignInResult } from "../auth/signin.js";
import { SIGN_UP_MINUTES, createFromSignUp, signUpOpen, startSignUp, verifySignUpCode } from "../auth/signup.js";
import { originRefusal } from "../auth/tokens.js";
import { config, publicOrigin } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getMailer } from "../providers/mailer.js";
import { clientAddress, containsNul, problem, type Env } from "./app.js";

/**
 * The unauthenticated surface (ADR 0009). Everything here works without a key or session; it is the
 * whole list, and test/sign-in.test.ts asserts it. Each POST accepts JSON (for a front end of your
 * own, answered in JSON) or a form post from the built-in pages (answered with a 303 to the next
 * page). Both must come from the public origin (Origin and Sec-Fetch-Site), so another site can't
 * sign a browser in or start a sign-in for it.
 */
export const PUBLIC_AUTH_ROUTES = [
  "GET /auth/capabilities", "POST /auth/email", "POST /auth/email/verify", "POST /auth/email/link", "POST /auth/password",
  "POST /auth/server-link", "POST /auth/choose", "POST /auth/sso", "GET /auth/sso/callback",
  // Self sign-up (ADR 0018, auth/signup.ts): 404 unless the operator set SIGN_UP=true. A code proves the
  // address, then the proven address names its workspace; nothing is created before that last step.
  "POST /auth/sign-up", "POST /auth/sign-up/verify", "POST /auth/sign-up/workspace",
  // OAuth for MCP (ADR 0010, api/oauth-public.ts and web/oauth.ts). The authorization endpoint shows
  // consent only to a signed-in session; its POST also needs the session's CSRF token. The others are
  // for clients: discovery, registration (rate limited and capped), token and revocation.
  "GET /.well-known/oauth-authorization-server", "GET /.well-known/openid-configuration",
  "GET /.well-known/oauth-protected-resource/mcp/ops", "GET /.well-known/oauth-protected-resource/mcp/admin",
  "GET /oauth/authorize", "POST /oauth/authorize", "POST /oauth/token", "POST /oauth/revoke", "POST /oauth/register", "OPTIONS /oauth/*",
] as const;

type C = Context<Env>;
const meta = (c: C) => ({ requestId: c.get("requestId"), userAgent: c.req.header("user-agent") ?? null, address: clientAddress(c) });
const signinCookie = (c: C) => readCookie(c.req.header("cookie"), cookieNames().signin);
const isJson = (c: C) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");

/** Which methods this server offers. Says nothing about any account or workspace. */
export function capabilities() {
  const sso = ssoSettings();
  const on = Boolean(publicOrigin());
  return {
    enabled: on,
    methods: {
      email_code: on && getMailer().enabled,
      password: on && config().PASSWORD_SIGN_IN,
      sso: on && sso ? { name: sso.name, start: "/auth/sso" } : null,
    },
    code_length: 8,
    /** Whether a person may create a workspace of their own here (POST /auth/sign-up). False unless the operator turned it on. */
    sign_up: on && Boolean(signUpOpen()),
  };
}

/** Request fields as strings: a JSON object or a form. Anything else is empty; NUL characters are refused. */
async function fields(c: C): Promise<Record<string, string>> {
  let raw: Record<string, unknown>;
  try {
    raw = isJson(c) ? ((await c.req.json()) ?? {}) : ((await c.req.parseBody()) as Record<string, unknown>);
  } catch {
    throw new ApiError(400, "invalid_request", "The request body could not be read");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.length <= 4096) out[k] = v;
  if (containsNul(out)) throw new ApiError(422, "validation_failed", "Text in the request must not contain NUL (\\u0000) characters");
  return out;
}

type Outcome = SignInResult | { status: "code_sent"; browserToken: string } | { status: "redirect"; browserToken: string; url: string }
  | { status: "sign_up_code_sent"; browserToken: string } | { status: "name_workspace"; browserToken: string };

const CODE_SENT = "If this email belongs to a member who can sign in here, a code and a link are on their way. "
  + `They work once, for ${FLOW_MINUTES.email} minutes, in this browser.`;

const SIGN_UP_CODE_SENT = `A code is on its way to that address. It works once, for ${SIGN_UP_MINUTES.code} minutes, in this browser.`;

/** Sends an outcome as JSON or, for a form post, as a redirect to the next page; sets and clears the cookies it implies. */
function respond(c: C, out: Outcome, json: boolean) {
  const names = cookieNames();
  if (out.status === "signed_in") {
    c.header("Set-Cookie", setCookie(names.session, out.session.token, (out.session.expiresAt.getTime() - Date.now()) / 1000), { append: true });
    c.header("Set-Cookie", clearCookie(names.signin), { append: true });
    if (!json) return c.redirect(out.returnTo, 303);
    return c.json({ status: "signed_in", workspace: out.workspace, return_to: out.returnTo, csrf_token: out.session.csrfToken,
      expires_at: out.session.expiresAt.toISOString(), idle_expires_at: out.session.idleExpiresAt.toISOString() });
  }
  const minutes = out.status === "choose_workspace" ? FLOW_MINUTES.choose : out.status === "code_sent" ? FLOW_MINUTES.email
    : out.status === "sign_up_code_sent" ? SIGN_UP_MINUTES.code : out.status === "name_workspace" ? SIGN_UP_MINUTES.workspace : FLOW_MINUTES.oidc;
  c.header("Set-Cookie", setCookie(names.signin, out.browserToken, minutes * 60), { append: true });
  if (out.status === "sign_up_code_sent") return json ? c.json({ status: "code_sent", detail: SIGN_UP_CODE_SENT }, 202) : c.redirect("/auth/sign-up/code", 303);
  if (out.status === "name_workspace") return json ? c.json({ status: "name_workspace" }) : c.redirect("/auth/sign-up/workspace", 303);
  if (out.status === "choose_workspace") {
    return json ? c.json({ status: "choose_workspace", workspaces: out.workspaces, ...(out.more ? { more_workspaces: true } : {}) }) : c.redirect("/auth/choose", 303);
  }
  if (out.status === "code_sent") return json ? c.json({ status: "code_sent", detail: CODE_SENT }, 202) : c.redirect("/auth/code", 303);
  return json ? c.json({ status: "redirect", redirect_url: out.url }) : c.redirect(out.url, 303);
}

/** A refused step: problem+json, or back to the page with a fixed error code (the page picks the message; nothing is reflected). */
function refuse(c: C, err: unknown, json: boolean, page: string) {
  if (!(err instanceof ApiError)) throw err;
  const retry = (err.details as { retry_after?: number } | undefined)?.retry_after;
  if (retry) c.header("Retry-After", String(retry));
  if (json) return problem(c, err);
  return c.redirect(`${page}?error=${encodeURIComponent(err.code)}`, 303);
}

export function mountPublicAuth(app: Hono<Env>): void {
  const off = (c: C) => problem(c, new ApiError(404, "not_found", "People sign-in is off on this server (PUBLIC_URL is not set)"));

  app.get("/auth/capabilities", (c) => c.json(capabilities()));

  const post = (path: string, page: string, run: (c: C, f: Record<string, string>) => Promise<Outcome>) => app.post(path, async (c) => {
    if (!publicOrigin()) return off(c);
    const json = isJson(c);
    const why = originRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site") }, { formPost: !json });
    if (why) {
      logger.warn({ requestId: c.get("requestId"), event: "csrf_refused", path }, "cross-site sign-in request refused");
      return problem(c, new ApiError(403, "csrf_failed", why));
    }
    try {
      return respond(c, await run(c, await fields(c)), json);
    } catch (e) {
      return refuse(c, e, json, page);
    }
  });

  post("/auth/email", "/auth/sign-in", async (c, f) => ({ status: "code_sent", ...(await startEmailSignIn(f.email, f.return_to, meta(c), f.workspace)) }));
  post("/auth/email/verify", "/auth/code", (c, f) => verifyEmailCode(signinCookie(c), f.code, meta(c)));
  post("/auth/email/link", "/auth/error", (c, f) => useEmailLink(signinCookie(c), f.token, meta(c)));
  post("/auth/password", "/auth/sign-in", (c, f) => passwordSignIn(f.email, f.password, f.return_to, meta(c), f.workspace));
  post("/auth/server-link", "/auth/error", (c, f) => useServerLink(f.token, meta(c)));
  post("/auth/choose", "/auth/choose", (c, f) => chooseWorkspace(signinCookie(c), f.workspace, meta(c)));
  post("/auth/sso", "/auth/sign-in", async (c, f) => ({ status: "redirect", ...(await startSso(f.return_to, meta(c), f.workspace)) }));

  post("/auth/sign-up", "/auth/sign-up", async (c, f) => ({ status: "sign_up_code_sent", ...(await startSignUp(f.email, f.return_to, meta(c))) }));
  post("/auth/sign-up/verify", "/auth/sign-up/code", async (c, f) => ({ status: "name_workspace", ...(await verifySignUpCode(signinCookie(c), f.code, meta(c))) }));
  post("/auth/sign-up/workspace", "/auth/sign-up/workspace", (c, f) => createFromSignUp(signinCookie(c), f, meta(c)));

  // The provider redirects the browser here (a top-level GET from its origin, so no Origin check applies;
  // the state value bound to this browser's cookie is what ties the answer to the request).
  app.get("/auth/sso/callback", async (c) => {
    if (!publicOrigin()) return off(c);
    const q = c.req.query();
    try {
      return respond(c, await finishSso(signinCookie(c), { code: q.code, state: q.state, error: q.error }, meta(c)), false);
    } catch (e) {
      return refuse(c, e, false, "/auth/error");
    }
  });
}
