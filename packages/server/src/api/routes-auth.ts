import { z } from "zod";
import { applyPasswordChange, preparePasswordChange, type PasswordChange } from "../auth/account.js";
import { clearCookie, cookieNames } from "../auth/cookies.js";
import { unlinkSso } from "../auth/oidc.js";
import { sessionInfo, sessionOwner } from "../auth/queries.js";
import { assertMayManageSignInOf, listSessions, requireRecentSignIn, requireSession, revokeOne, revokeUserSessions, sessionPublicId } from "../auth/sessions.js";
import { csrfToken } from "../auth/tokens.js";
import { oauthSettings } from "../config.js";
import { audit } from "../core/audit.js";
import type { Ctx } from "../core/context.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { ApiError, forbidden, notFound } from "../lib/errors.js";
import { getWorkspace, parseMemberId, setSignInSettings } from "../core/workspace.js";
import { grantOwner, listGrants, revokeGrantAudited, revokeUserGrants } from "../oauth/grants.js";
import { route } from "./registry.js";
import { data, dataList, plain, ref, strict, S } from "./responses.js";

/**
 * Signed-in session management (ADR 0009, docs/sign-in.md). Routes under /v1/auth act on the caller's
 * own sign-in and are for browser sessions only; the member routes are for admins (keys or sessions).
 * The sign-in endpoints themselves need no credential and live under /auth (api/auth-public.ts).
 */

route({
  method: "GET", path: "/v1/auth/session", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: plain(ref("SessionInfo")),
  summary: "The current session: who is signed in (and whether they have a password or a single sign-on link), workspace, role, permissions, expiry, "
    + "what this server offers (connected apps), and the CSRF token to send as X-CSRF-Token",
  handler: async ({ tx, ctx }) => {
    const s = requireSession(ctx);
    const row = await sessionInfo(tx, s.id);
    return {
      body: {
        session: { id: sessionPublicId(s.id), method: s.method, signed_in_at: s.signedInAt.toISOString(), expires_at: row!.expires_at.toISOString(),
          idle_expires_at: row!.idle_expires_at.toISOString() },
        csrf_token: csrfToken(s.id),
        member: { id: encodeId("usr", ctx.actor.id!), email: row!.email, name: row!.name, has_password: row!.has_password, sso_linked: row!.sso_linked },
        workspace: await getWorkspace(tx),
        role: ctx.actor.role,
        permissions: [...ctx.permissions],
        // What this server has turned on, so the app needn't probe for it (OAuth for MCP answers its discovery document only when on).
        server: { connected_apps: oauthSettings() !== null },
      },
    };
  },
});

route({
  method: "POST", path: "/v1/auth/sign-out", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: plain(strict({ signed_out: S.bool })),
  summary: "Sign out: ends this session on the server and clears the cookie",
  handler: async ({ tx, ctx }) => {
    const s = requireSession(ctx);
    await revokeOne(tx, ctx, ctx.actor.id!, sessionPublicId(s.id), "signed_out");
    return { body: { signed_out: true }, headers: { "Set-Cookie": clearCookie(cookieNames().session), "Clear-Site-Data": '"cookies", "storage"' } };
  },
});

route({
  method: "GET", path: "/v1/auth/sessions", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: dataList(ref("Session")),
  summary: "My sessions that are still live, newest first; `current` marks this one",
  handler: async ({ tx, ctx }) => ({ body: { data: await listSessions(tx, ctx.actor.id!, requireSession(ctx).id) } }),
});

route({
  method: "POST", path: "/v1/auth/sessions/revoke-others", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: plain(strict({ revoked: S.int, apps_revoked: S.int })),
  summary: "Sign out everywhere else: revoke all my other sessions, and disconnect every app I connected over OAuth",
  handler: async ({ tx, ctx }) => {
    const n = await revokeUserSessions(tx, ctx.actor.id!, "other_sessions_revoked", requireSession(ctx).id);
    // Signing out everywhere includes apps: they act as this member too (ADR 0010). A password change doesn't.
    const apps = await revokeUserGrants(tx, ctx.actor.id!, "signed_out_everywhere");
    await audit(tx, ctx, { action: "auth.sessions_revoked", objectType: "user", recordId: ctx.actor.id, details: { count: n, scope: "others", apps_revoked: apps } });
    return { body: { revoked: n, apps_revoked: apps } };
  },
});

const PasswordBody = z.object({ password: z.string().max(1024), current_password: z.string().max(1024).optional() });

route({
  method: "POST", path: "/v1/auth/password", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: data(strict({ has_password: S.bool, other_sessions_revoked: S.int })),
  summary: "Set or change my password. Needs current_password, or a sign-in in the last 10 minutes (e.g. by email code, to reset). Ends my other sessions",
  body: PasswordBody,
  prepare: ({ ctx, body }) => preparePasswordChange(ctx, { password: body.password, current_password: body.current_password ?? null }),
  handler: async ({ tx, ctx, prepared }) => ({ body: { data: await applyPasswordChange(tx, ctx, prepared as PasswordChange) } }),
});

route({
  method: "DELETE", path: "/v1/auth/password", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: data(strict({ has_password: S.bool, other_sessions_revoked: S.int })),
  summary: "Remove my password (sign in by email code or SSO instead). Same proof as changing it. Ends my other sessions",
  body: PasswordBody.omit({ password: true }).optional() as never,
  prepare: ({ ctx, body }) => preparePasswordChange(ctx, { password: null, current_password: (body as { current_password?: string } | undefined)?.current_password ?? null }),
  handler: async ({ tx, ctx, prepared }) => ({ body: { data: await applyPasswordChange(tx, ctx, prepared as PasswordChange) } }),
});

route({
  method: "DELETE", path: "/v1/sessions/:id", scope: "any", permission: "own_credential", tag: "auth", idParams: { id: "session" },
  response: data(strict({ id: S.str, revoked: S.bool })),
  summary: "Revoke a session: one of my own (from a signed-in session), or (with members:manage, by key or session) a member's",
  handler: async ({ tx, ctx, params }) => {
    const row = await sessionOwner(tx, parseSessionId(params.id!));
    // Ending your own session takes a session: a key, whatever its scopes, ends sessions only through members:manage.
    const own = Boolean(row && ctx.session && ctx.actor.type === "user" && ctx.actor.id === row.user_id);
    // A session you may not act on answers as an unknown one does, so the answer says nothing about which IDs exist.
    if (!row) throw notFound("Session");
    if (!own) await assertMayManageSignInOf(tx, ctx, row.user_id).catch((e: unknown) => { throw e instanceof ApiError && e.status === 403 ? notFound("Session") : e; });
    return { body: { data: await revokeOne(tx, ctx, row.user_id, params.id!, own ? "revoked" : "revoked_by_admin") } };
  },
});

/** A session's UUID from its public ID (ses_…); not found for anything else. */
function parseSessionId(publicId: string): string {
  const d = decodeId(publicId);
  if (d?.prefix !== "ses") throw notFound("Session");
  return d.uuid;
}

route({
  method: "GET", path: "/v1/members/:id/sessions", scope: "admin", permission: "members:manage", tag: "admin", idParams: { id: "member" },
  response: dataList(ref("Session")),
  summary: "A member's live browser sessions (for an access review or an incident)",
  handler: async ({ tx, ctx, params }) => {
    const ref = parseMemberId(params.id!, "user");
    if (!ref) throw notFound("Member");
    await assertMayManageSignInOf(tx, ctx, ref.id);
    return { body: { data: await listSessions(tx, ref.id) } };
  },
});

route({
  method: "POST", path: "/v1/members/:id/sessions/revoke", scope: "admin", permission: "members:manage", tag: "admin", idParams: { id: "member" },
  response: data(strict({ revoked: S.int, apps_revoked: S.int })),
  summary: "Sign a member out everywhere: revoke all their browser sessions and disconnect their OAuth apps (their API keys are unaffected)",
  handler: async ({ tx, ctx, params }) => {
    const ref = parseMemberId(params.id!, "user");
    if (!ref) throw notFound("Member");
    await assertMayManageSignInOf(tx, ctx, ref.id);
    if (ctx.actor.type === "user" && ctx.actor.id === ref.id && ctx.session) throw forbidden("To sign yourself out everywhere, use POST /v1/auth/sessions/revoke-others and then sign out");
    const n = await revokeUserSessions(tx, ref.id, "revoked_by_admin");
    const apps = await revokeUserGrants(tx, ref.id, "signed_out_everywhere");
    await audit(tx, ctx, { action: "auth.sessions_revoked", objectType: "user", recordId: ref.id, details: { count: n, scope: "all", apps_revoked: apps } });
    return { body: { data: { revoked: n, apps_revoked: apps } } };
  },
});

route({
  method: "DELETE", path: "/v1/auth/sso", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: data(strict({ sso_linked: S.bool, unlinked: S.bool })),
  summary: "Unlink my single sign-on: the provider's subject no longer signs me in. Needs a sign-in in the last 10 minutes",
  handler: async ({ tx, ctx }) => {
    requireSession(ctx);
    requireRecentSignIn(ctx);
    return { body: { data: await unlinkSso(tx, ctx, ctx.actor.id!) } };
  },
});

route({
  method: "DELETE", path: "/v1/members/:id/sso", scope: "admin", permission: "members:manage", tag: "admin", idParams: { id: "member" },
  response: data(strict({ sso_linked: S.bool, unlinked: S.bool })),
  summary: "Unlink a member's single sign-on (same rules as revoking their sessions: an owner's only by an owner, never someone with permissions you don't hold)",
  handler: async ({ tx, ctx, params }) => {
    const ref = parseMemberId(params.id!, "user");
    if (!ref) throw notFound("Member");
    await assertMayManageSignInOf(tx, ctx, ref.id);
    return { body: { data: await unlinkSso(tx, ctx, ref.id) } };
  },
});

// --- Connected apps (OAuth for MCP, ADR 0010) -----------------------------------------------------

/** Apps never manage apps: a connected app can't list the member's other connections or disconnect any. */
function refuseApps(ctx: Ctx): void {
  if (ctx.oauth) throw forbidden("Connected apps can't list or disconnect apps; use the connected apps page, or the API with a key or a session");
}

route({
  method: "GET", path: "/v1/auth/apps", scope: "any", permission: "own_credential", credential: "session", tag: "auth",
  response: dataList(ref("ConnectedApp")),
  summary: "Apps I connected over OAuth (for the MCP servers): client, where it sends the browser, scopes, resource, when connected and last used",
  handler: async ({ tx, ctx }) => ({ body: { data: await listGrants(tx, ctx.actor.id!) } }),
});

route({
  method: "DELETE", path: "/v1/auth/apps/:id", scope: "any", permission: "own_credential", credential: "session", tag: "auth", idParams: { id: "grant" },
  response: data(strict({ id: S.str, revoked: S.bool })),
  summary: "Disconnect one of my apps: its access and refresh tokens stop working at once",
  handler: async ({ tx, ctx, params }) => {
    const g = await grantOwner(tx, params.id!);
    if (g.userId !== ctx.actor.id) throw notFound("Connected app");
    return { body: { data: await revokeGrantAudited(tx, ctx, g, false) } };
  },
});

route({
  method: "GET", path: "/v1/apps", scope: "any", permission: "own_credential", tag: "auth",
  response: dataList(ref("ConnectedApp")),
  query: z.object({ member: z.string().max(40).optional() }),
  summary: "Connected apps: the caller's own, or (with members:manage, under the same rules as their sessions) a member's with ?member=usr_…",
  handler: async ({ tx, ctx, query }) => {
    refuseApps(ctx);
    if (!query.member) {
      if (ctx.actor.type !== "user" || !ctx.actor.id) return { body: { data: [] } };
      return { body: { data: await listGrants(tx, ctx.actor.id) } };
    }
    const ref = parseMemberId(query.member, "user");
    if (!ref) throw notFound("Member");
    await assertMayManageSignInOf(tx, ctx, ref.id);
    return { body: { data: await listGrants(tx, ref.id) } };
  },
});

route({
  method: "DELETE", path: "/v1/apps/:id", scope: "any", permission: "own_credential", tag: "auth", idParams: { id: "grant" },
  response: data(strict({ id: S.str, revoked: S.bool })),
  summary: "Disconnect an app: one of the caller's own, or (with members:manage) a member's",
  handler: async ({ tx, ctx, params }) => {
    refuseApps(ctx);
    const g = await grantOwner(tx, params.id!);
    const own = ctx.actor.type === "user" && ctx.actor.id === g.userId;
    // One you may not act on answers as an unknown one does.
    if (!own) await assertMayManageSignInOf(tx, ctx, g.userId).catch((e: unknown) => { throw e instanceof ApiError && e.status === 403 ? notFound("Connected app") : e; });
    return { body: { data: await revokeGrantAudited(tx, ctx, g, !own) } };
  },
});

route({
  method: "PATCH", path: "/v1/workspace/sign-in", scope: "admin", permission: "members:manage", tag: "admin",
  response: data(ref("SignInSettings")),
  summary: "Owner only: allow or refuse password sign-in, single sign-on and connecting apps over OAuth for this workspace; narrow the email domains SSO accepts and the scopes apps may be granted",
  body: z.object({ password: z.boolean().optional(), sso: z.boolean().optional(), sso_allowed_domains: z.array(z.string().max(253)).max(50).optional(),
    oauth_apps: z.boolean().optional(), oauth_scopes: z.array(z.enum(["ops:read", "ops:write", "restricted:read", "admin"])).max(4).optional() }),
  handler: async ({ tx, ctx, body }) => ({ body: { data: await setSignInSettings(tx, ctx, body) } }),
});
