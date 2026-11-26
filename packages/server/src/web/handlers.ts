import type { Context, Hono } from "hono";
import { applyPasswordChange, preparePasswordChange } from "../auth/account.js";
import { clearCookie, cookieNames, readCookie } from "../auth/cookies.js";
import { passwordPageFacts, signedInPageFacts } from "../auth/queries.js";
import { authorizationOrigin, ssoSettings } from "../auth/oidc.js";
import { resolveSession, revokeOne, sessionPublicId } from "../auth/sessions.js";
import { pendingChoice, safeReturnTo } from "../auth/signin.js";
import { pendingSignUp, signUpOpen } from "../auth/signup.js";
import { csrfToken, csrfTokenMatches, originRefusal } from "../auth/tokens.js";
import type { Ctx } from "../core/context.js";
import { config, oauthSettings, publicOrigin } from "../config.js";
import { withTenant } from "../db/tx.js";
import { ApiError } from "../lib/errors.js";
import { decodeId } from "../lib/ids.js";
import { capabilities } from "../api/auth-public.js";
import type { Env } from "../api/app.js";
import { STYLE, choosePage, codePage, errorPage, linkPage, passwordPage, signInPage, signUpCodePage, signUpPage, signUpWorkspacePage, signedInPage, signedOutPage } from "./pages.js";

/**
 * Handlers for the built-in pages under /auth (templates in web/pages.ts). GET pages change nothing.
 * The three forms that act on a signed-in session (sign out, set or remove a password) carry the
 * session's CSRF token as a hidden field, because a plain form can't send the X-CSRF-Token header,
 * and pass the same Origin and Sec-Fetch-Site checks as the API.
 */

type C = Context<Env>;

/**
 * No script anywhere; styles and form targets from this origin, plus the SSO provider's issuer and
 * authorization endpoint origins (browsers apply form-action to the redirect the SSO form leads to).
 */
function csp(formTargets: string[] = []): string {
  return ["default-src 'none'", "style-src 'self'", "img-src 'self'", `form-action 'self'${formTargets.map((t) => ` ${t}`).join("")}`,
    "frame-ancestors 'none'", "base-uri 'none'"].join("; ");
}

export function html(c: C, body: string, status = 200, formTargets: string[] = []) {
  c.header("Content-Security-Policy", csp(formTargets));
  c.header("Content-Type", "text/html; charset=utf-8");
  return c.body(body, status as 200);
}

/** The signed-in member behind the session cookie, as a request context, or null. */
export async function sessionCtx(c: C): Promise<Ctx | null> {
  const token = readCookie(c.req.header("cookie"), cookieNames().session);
  const p = token ? await resolveSession(token) : null;
  if (!p?.session) return null;
  return { tenantId: p.tenantId, actor: p.actor, keyId: null, session: p.session, permissions: p.permissions, scopes: p.scopes,
    ...(p.records ? { records: p.records } : {}), surface: "web", requestId: c.get("requestId") };
}

/** Checks a session form post: same origin and the session's CSRF token in the `csrf_token` field. */
export function formRefusal(c: C, ctx: Ctx, form: Record<string, unknown>): boolean {
  return Boolean(originRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site") }, { formPost: true }))
    || !csrfTokenMatches(ctx.session!.id, typeof form.csrf_token === "string" ? form.csrf_token : null);
}

const str = (v: unknown) => (typeof v === "string" && v.length <= 1024 && !v.includes("\0") ? v : undefined);

export function mountPages(app: Hono<Env>): void {
  app.get("/auth/assets/style.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(STYLE);
  });

  // Every page below needs PUBLIC_URL; without it people sign-in is off.
  app.use("/auth/*", async (c, next) => {
    if (!publicOrigin() && c.req.path !== "/auth/capabilities" && c.req.path !== "/auth/assets/style.css") return html(c, errorPage("unavailable"), 404);
    return next();
  });

  app.get("/auth/sign-in", async (c) => {
    const cap = capabilities();
    const sso = ssoSettings();
    const returnTo = c.req.query("return_to");
    const targets = sso ? [...new Set([new URL(sso.issuer).origin, ...[await authorizationOrigin(sso)].filter((o): o is string => Boolean(o))])] : [];
    // A workspace ID to look in (the choice page points here with one when there were too many workspaces to list); only an ID shape is carried.
    const named = c.req.query("workspace") ?? "";
    const workspace = decodeId(named)?.prefix === "ws" ? named : null;
    return html(c, signInPage({ email: cap.methods.email_code, password: cap.methods.password, sso: cap.methods.sso?.name ?? null,
      returnTo: returnTo ? safeReturnTo(returnTo) : null, workspace, error: c.req.query("error"), signUp: cap.sign_up }), 200, targets);
  });

  // Self sign-up (ADR 0018). The pages don't exist unless the operator turned it on and email works.
  app.use("/auth/sign-up/*", async (c, next) => (c.req.method === "GET" && !signUpOpen() ? html(c, errorPage("unavailable"), 404) : next()));
  app.get("/auth/sign-up", (c) => {
    if (!signUpOpen()) return html(c, errorPage("unavailable"), 404);
    const returnTo = c.req.query("return_to");
    return html(c, signUpPage({ returnTo: returnTo ? safeReturnTo(returnTo) : null, error: c.req.query("error") }));
  });
  app.get("/auth/sign-up/code", (c) => html(c, signUpCodePage(c.req.query("error"))));
  app.get("/auth/sign-up/workspace", async (c) => {
    const pending = await pendingSignUp(readCookie(c.req.header("cookie"), cookieNames().signin));
    return html(c, signUpWorkspacePage(pending, c.req.query("error")), pending ? 200 : 400);
  });
  app.get("/auth/code", (c) => html(c, codePage(c.req.query("error"))));
  app.get("/auth/email-link", (c) => html(c, linkPage("/auth/email/link", str(c.req.query("token")) ?? null)));
  app.get("/auth/link", (c) => html(c, linkPage("/auth/server-link", str(c.req.query("token")) ?? null)));
  app.get("/auth/choose", async (c) => html(c, choosePage(await pendingChoice(readCookie(c.req.header("cookie"), cookieNames().signin)), c.req.query("error"))));
  app.get("/auth/signed-out", (c) => html(c, signedOutPage()));
  app.get("/auth/error", (c) => html(c, errorPage(c.req.query("error"))));

  app.get("/auth/signed-in", async (c) => {
    const ctx = await sessionCtx(c);
    if (!ctx) return c.redirect("/auth/sign-in", 303);
    const v = (await withTenant(ctx.tenantId, (tx) => signedInPageFacts(tx, ctx.session!.id)))!;
    return html(c, signedInPage({ name: v.name, email: v.email, workspace: v.workspace, role: ctx.actor.role, expiresAt: v.expires_at.toISOString(),
      hasPassword: Boolean(v.has_password), passwordAllowed: v.allowed && config().PASSWORD_SIGN_IN, csrf: csrfToken(ctx.session!.id), apps: Boolean(oauthSettings()) }));
  });

  app.get("/auth/password", async (c) => {
    const ctx = await sessionCtx(c);
    if (!ctx) return c.redirect("/auth/sign-in?return_to=%2Fauth%2Fpassword", 303);
    const v = (await withTenant(ctx.tenantId, (tx) => passwordPageFacts(tx, ctx.actor.id!)))!;
    return html(c, passwordPage({ hasPassword: Boolean(v.has_password), allowed: v.allowed && config().PASSWORD_SIGN_IN, csrf: csrfToken(ctx.session!.id),
      error: c.req.query("error"), done: c.req.query("done") === "1" }));
  });

  for (const action of ["set", "remove"] as const) {
    app.post(`/auth/password/${action}`, async (c) => {
      const ctx = await sessionCtx(c);
      if (!ctx) return c.redirect("/auth/sign-in", 303);
      const form = await c.req.parseBody();
      if (formRefusal(c, ctx, form)) return c.redirect("/auth/password?error=csrf_failed", 303);
      const password = action === "set" ? str(form.password) ?? "" : null;
      if (action === "set" && password !== str(form.password_again)) return c.redirect("/auth/password?error=password_mismatch", 303);
      try {
        const change = await preparePasswordChange(ctx, { password, current_password: str(form.current_password) ?? null });
        await withTenant(ctx.tenantId, (tx) => applyPasswordChange(tx, ctx, change));
        return c.redirect("/auth/password?done=1", 303);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        return c.redirect(`/auth/password?error=${e.code === "validation_failed" ? "weak_password" : encodeURIComponent(e.code)}`, 303);
      }
    });
  }

  app.post("/auth/sign-out", async (c) => {
    // Origin first: a cross-site post (which a browser may send without the cookie) clears nothing.
    if (originRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site") }, { formPost: true })) return html(c, errorPage("csrf_failed"), 403);
    const ctx = await sessionCtx(c);
    if (ctx) {
      const form = await c.req.parseBody();
      if (formRefusal(c, ctx, form)) return html(c, errorPage("csrf_failed"), 403);
      await withTenant(ctx.tenantId, (tx) => revokeOne(tx, ctx, ctx.actor.id!, sessionPublicId(ctx.session!.id), "signed_out"));
    }
    c.header("Set-Cookie", clearCookie(cookieNames().session), { append: true });
    c.header("Clear-Site-Data", '"cookies", "storage"');
    return c.redirect("/auth/signed-out", 303);
  });
}
