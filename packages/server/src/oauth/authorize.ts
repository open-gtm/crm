import { oauthSettings } from "../config.js";
import { grantedPermissions, loadRoleRules } from "../core/access.js";
import { audit } from "../core/audit.js";
import { roleCanUseScope, type Ctx, type Scope } from "../core/context.js";
import { keyOwner } from "../core/keys.js";
import type { Tx } from "../db/pool.js";
import { uuidv7 } from "../lib/ids.js";
import { RECENT_SIGN_IN_SECONDS } from "../auth/sessions.js";
import { consentWorkspace, countLiveGrants, insertCode, memberNameAndEmail } from "./queries.js";
import { ClientError, isLoopback, redirectHost, redirectMatches, resolveClient, type Client } from "./clients.js";
import { CODE_PREFIX, DEFAULT_SCOPES, RESOURCE_SCOPES, RESOURCES, expandScopes, isScope, newSecret, satisfies, secretHash, type ResourceName } from "./scopes.js";

/**
 * The authorization endpoint's rules (ADR 0010): validating a request, working out what the member
 * may grant, and issuing the code once they approve. Templates and HTTP handling are in web/oauth.ts.
 *
 * A request with an unknown client or a redirect URI the client didn't register is answered with an
 * error page that never points at it. Every other problem carries the client's redirect URI with
 * `error`, `state` and `iss` (RFC 9207); web/oauth.ts offers it as a link (see refuse there).
 */

/** Codes are redeemed by the client's back end the moment the browser lands on its redirect URI; a minute is plenty and keeps a leaked code short-lived. */
export const CODE_SECONDS = 60;
/** A member can't hold more live connections than this; past it they revoke some first. */
export const MAX_LIVE_GRANTS = 50;

export interface AuthzRequest {
  client: Client;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: ResourceName;
  resourceUrl: string;
  /** The scope tokens as asked for (empty: the resource's defaults). */
  requested: string[];
  /** The parameters, to carry through the consent form unchanged. */
  params: Record<string, string>;
}

export class AuthorizeError extends Error {
  constructor(readonly code: string, message: string, readonly redirect: { uri: string; state: string | null } | null) {
    super(message);
  }
}

const PARAMS = ["response_type", "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method", "resource", "prompt"] as const;

/** The resource a `resource` parameter names, compared after lowercasing scheme and host (RFC 8707 asks servers to accept either case), or null. */
export function resourceFor(raw: string): ResourceName | null {
  const s = oauthSettings();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.search || u.hash || raw.includes("#") || u.username || u.password) return null;
  const canonical = `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  return RESOURCES.find((r) => s.resources[r] === canonical) ?? null;
}

/**
 * Validates an authorization request. `raw` maps each parameter to every value it was sent with (a
 * parameter sent twice is refused, RFC 6749 §3.1). Client and redirect URI first: until both check
 * out, errors are AuthorizeError with no redirect.
 */
export async function parseAuthorizeRequest(raw: Record<string, string[]>, caller = "unknown"): Promise<AuthzRequest> {
  const s = oauthSettings();
  if (!s) throw new AuthorizeError("unavailable", "OAuth is not turned on for this server", null);
  const one = (k: string) => (raw[k]?.length ? raw[k]![0]! : null);
  if (["client_id", "redirect_uri"].some((k) => (raw[k]?.length ?? 0) > 1)) throw new AuthorizeError("invalid_request", "client_id and redirect_uri may be sent only once", null);
  let client: Client;
  try {
    client = await resolveClient(one("client_id"), { caller });
  } catch (e) {
    if (e instanceof ClientError) throw new AuthorizeError(e.code === "temporarily_unavailable" ? "temporarily_unavailable" : "invalid_client", e.message, null);
    throw e;
  }
  const redirectUri = one("redirect_uri");
  if (!redirectUri) throw new AuthorizeError("invalid_redirect_uri", "redirect_uri is required", null);
  if (!client.redirectUris.some((r) => redirectMatches(r, redirectUri))) {
    throw new AuthorizeError("invalid_redirect_uri", "This redirect URI is not one the app registered", null);
  }
  const stateRaw = one("state");
  const back = (code: string, message: string) => new AuthorizeError(code, message, { uri: redirectUri, state: stateRaw });
  if (stateRaw !== null && stateRaw.length > 1024) throw back("invalid_request", "state is longer than 1024 characters");
  if (PARAMS.some((k) => (raw[k]?.length ?? 0) > 1)) throw back("invalid_request", "A parameter was sent more than once");
  if (one("response_type") !== "code") throw back("unsupported_response_type", "Only response_type=code is supported");
  const challenge = one("code_challenge");
  if (!challenge) throw back("invalid_request", "PKCE is required: send code_challenge and code_challenge_method=S256");
  if (one("code_challenge_method") !== "S256") throw back("invalid_request", "Only code_challenge_method=S256 is supported (plain is refused)");
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw back("invalid_request", "code_challenge must be a base64url SHA-256 (43 characters)");
  if (one("prompt") === "none") throw back("consent_required", "This server always asks the member to approve; prompt=none can't be honoured");
  const requested = (one("scope") ?? "").split(" ").filter(Boolean);
  if (requested.length > 20 || requested.some((t) => t.length > 100)) throw back("invalid_scope", "scope is not valid");
  // Clients following the 2025-06-18 or later specifications always send `resource`. Without it (older
  // clients), the scope decides: admin asks for the admin server, anything else the ops server.
  const resourceRaw = one("resource");
  const resource = resourceRaw === null ? (requested.includes("admin") ? "admin" : "ops") : resourceFor(resourceRaw);
  if (!resource) throw back("invalid_target", "resource must be one of this server's MCP endpoints");
  const params: Record<string, string> = {};
  for (const k of PARAMS) {
    const v = one(k);
    if (v !== null) params[k] = v;
  }
  return { client, redirectUri, state: stateRaw, codeChallenge: challenge, resource, resourceUrl: s.resources[resource], requested, params };
}

/** Where to send the browser with an authorization response: the redirect URI plus the parameters, always with `iss`. */
export function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  u.searchParams.set("iss", oauthSettings()!.issuer);
  return u.toString();
}

export interface ConsentPlan {
  granted: Scope[];
  /** Asked for but not granted, with why, so the page can say so. */
  dropped: { scope: string; why: string }[];
  /** Why nothing can be granted at all (the page then offers only Cancel), or null. */
  blocked: string | null;
  /** The member must sign in again first (the admin scope needs a sign-in in the last 10 minutes). */
  recentSignInNeeded: boolean;
  workspace: string;
  member: { name: string; email: string };
  loopback: boolean;
}

/**
 * What the member can grant this request, in their workspace's transaction. Each requested scope must
 * be one the resource takes, the workspace allows and the member's role can use; `ops:write` falls back
 * to `ops:read` when only reading is allowed. Unknown scopes (`openid`, `offline_access`) are ignored.
 */
export async function planConsent(tx: Tx, ctx: Ctx, req: AuthzRequest): Promise<ConsentPlan> {
  const t = await consentWorkspace(tx);
  const u = await memberNameAndEmail(tx, ctx.actor.id!);
  const owner = await keyOwner(tx, "user", ctx.actor.id!);
  const usable = owner ? [...owner.permissions, ...grantedPermissions(await loadRoleRules(tx, ctx.tenantId, owner.role_id, owner.access_version))] : [];
  const asked = req.requested.length ? req.requested : DEFAULT_SCOPES[req.resource];
  // The workspace's list follows the same hierarchy as tokens: allowing ops:write allows ops:read.
  const workspaceAllows = new Set<Scope>(expandScopes(t!.oauth_scopes));
  const granted = new Set<Scope>();
  const dropped: ConsentPlan["dropped"] = [];
  for (const s of new Set(asked)) {
    if (!isScope(s)) {
      dropped.push({ scope: s, why: "not used by this server" });
      continue;
    }
    if (!RESOURCE_SCOPES[req.resource].includes(s)) {
      dropped.push({ scope: s, why: `not available on the ${req.resource} server` });
      continue;
    }
    const allowed = (x: Scope) => workspaceAllows.has(x) && roleCanUseScope(usable, x);
    if (allowed(s)) granted.add(s);
    else if (s === "ops:write" && allowed("ops:read")) {
      granted.add("ops:read");
      dropped.push({ scope: s, why: workspaceAllows.has(s) ? "your role can only read" : "this workspace lets apps only read" });
    } else dropped.push({ scope: s, why: workspaceAllows.has(s) ? "your role can't use it" : "this workspace doesn't let apps have it" });
  }
  const list = [...granted];
  const blocked = !t!.oauth_apps ? "This workspace doesn't allow connecting apps. An owner can change that."
    : !satisfies(req.resource, list) ? `Nothing the app needs on the ${req.resource} server can be granted (${dropped.map((d) => `${d.scope}: ${d.why}`).join("; ") || "no scope"}).`
      : null;
  const age = Date.now() - (ctx.session?.signedInAt.getTime() ?? 0);
  return { granted: list, dropped, blocked, recentSignInNeeded: list.includes("admin") && age > RECENT_SIGN_IN_SECONDS * 1000,
    workspace: t!.name, member: { name: u!.name, email: u!.email }, loopback: req.client.redirectUris.every(isLoopback) || isLoopback(req.redirectUri) };
}

/** What the consent recorded, for the audit log: never a code or token. */
const consentDetails = (req: AuthzRequest, scopes: Scope[]) => ({ client_id: req.client.clientId, client_name: req.client.name, client_kind: req.client.kind,
  redirect_host: redirectHost(req.redirectUri), resource: req.resourceUrl, scopes });

/** Issues a code after the member approved: single use, CODE_SECONDS, bound to everything the token request must repeat. */
export async function issueCode(tx: Tx, ctx: Ctx, req: AuthzRequest, plan: ConsentPlan): Promise<string> {
  const live = await countLiveGrants(tx, ctx.actor.id!);
  if (live >= MAX_LIVE_GRANTS) throw new AuthorizeError("temporarily_unavailable", `You have ${MAX_LIVE_GRANTS} connected apps; disconnect some first`, null);
  const code = newSecret(CODE_PREFIX);
  await insertCode(tx, { tenantId: ctx.tenantId, id: uuidv7(), codeHash: secretHash(code), userId: ctx.actor.id!, sessionId: ctx.session!.id,
    clientId: req.client.clientId, clientName: req.client.name, clientKind: req.client.kind, redirectUri: req.redirectUri, codeChallenge: req.codeChallenge,
    resource: req.resourceUrl, scopes: plan.granted, seconds: CODE_SECONDS });
  await audit(tx, ctx, { action: "oauth.consent_granted", objectType: "user", recordId: ctx.actor.id, details: consentDetails(req, plan.granted) });
  return code;
}

export async function recordDenial(tx: Tx, ctx: Ctx, req: AuthzRequest): Promise<void> {
  await audit(tx, ctx, { action: "oauth.consent_denied", objectType: "user", recordId: ctx.actor.id, details: consentDetails(req, []) });
}
