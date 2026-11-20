import { createHash } from "node:crypto";
import { createLocalJWKSet, errors as joseErrors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { config, publicOrigin } from "../config.js";
import type { Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { audit } from "../core/audit.js";
import type { Ctx } from "../core/context.js";
import { hmac, safeEqual } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { checkUrl, safeRequest } from "../lib/outbound.js";
import { activeMemberships, canonicalEmail, lookupIdentity, oidcIdentity, type Membership } from "./identity.js";
import { consumeSsoFlow, insertSsoFlow, linkSsoSubject, removeSsoLink } from "./queries.js";
import { webCtx, type ClientMeta } from "./sessions.js";
import { FLOW_MINUTES, completeSignIn, expired, failed, limitAddress, namedWorkspace, safeReturnTo, unavailable, withFlows, type SignInResult } from "./signin.js";
import { isToken, newToken, serverKey, tokenHash } from "./tokens.js";

/**
 * Single sign-on through one OpenID Connect provider (ADR 0009): the authorization code flow with
 * PKCE (S256), `state` and `nonce`. All three are derived from the pre-session cookie with a server
 * key, so they are bound to the browser and nothing secret is stored. The ID token is verified with
 * `jose` against the provider's published keys; discovery, keys and the token request go through
 * lib/outbound.ts (SSRF checks, pinned DNS, timeouts, size limits). Members are matched, never created.
 *
 * Trust: single sign-on trusts the configured provider to verify email addresses. A verified email
 * matches existing members (in workspaces that allow SSO, within their allowed domains) and links
 * them to the provider's subject; an owner can turn SSO off for a workspace or narrow its domains,
 * and a member or admin can unlink.
 */

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

const DOC_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;
const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 600_000;
/** Asymmetric algorithms only: never `none`, never an HMAC keyed with the (shared) client secret. */
const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

let discovery: { at: number; issuer: string; doc: Discovery } | undefined;
let jwks: { at: number; uri: string; set: JSONWebKeySet } | undefined;

/** For tests: forget the cached discovery document and keys. */
export function resetOidcCache(): void {
  discovery = undefined;
  jwks = undefined;
  discoveryFailedAt = undefined;
}

export interface SsoSettings { issuer: string; clientId: string; clientSecret: string; name: string; domains: string[] }

/** The configured provider, or null when single sign-on is off. */
export function ssoSettings(): SsoSettings | null {
  const c = config();
  if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID || !c.OIDC_CLIENT_SECRET || !publicOrigin()) return null;
  return { issuer: c.OIDC_ISSUER, clientId: c.OIDC_CLIENT_ID, clientSecret: c.OIDC_CLIENT_SECRET, name: c.OIDC_DISPLAY_NAME,
    domains: c.OIDC_ALLOWED_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean) };
}

export const redirectUri = () => `${publicOrigin()!.origin}/auth/sso/callback`;
const policy = () => ({ allowInsecure: config().OIDC_ALLOW_INSECURE_ISSUER });

async function getJson(url: string, init?: { method: "POST"; body: string; headers: Record<string, string> }): Promise<{ status: number; json: unknown }> {
  const r = await safeRequest(url, { method: init?.method ?? "GET", body: init?.body, headers: init?.headers, maxBytes: DOC_BYTES, timeoutMs: TIMEOUT_MS }, policy());
  let json: unknown;
  try {
    json = JSON.parse(r.body);
  } catch {
    throw new Error(`${new URL(url).pathname} did not return JSON (status ${r.status})`);
  }
  return { status: r.status, json };
}

const isUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//.test(v);

/** The provider's discovery document. Its `issuer` must equal the configured issuer exactly. */
export async function providerDocument(s: SsoSettings): Promise<Discovery> {
  if (discovery && discovery.issuer === s.issuer && Date.now() - discovery.at < DISCOVERY_TTL_MS) return discovery.doc;
  // After a failure, wait a little before asking again, so sign-in attempts can't turn into a stream of outbound requests.
  if (discoveryFailedAt && Date.now() - discoveryFailedAt < 30_000) throw new Error("discovery failed recently");
  try {
    return await fetchDiscovery(s);
  } catch (e) {
    discoveryFailedAt = Date.now();
    throw e;
  }
}

let discoveryFailedAt: number | undefined;

async function fetchDiscovery(s: SsoSettings): Promise<Discovery> {
  const { status, json } = await getJson(`${s.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const d = json as Partial<Discovery>;
  if (status !== 200 || !d || typeof d !== "object") throw new Error(`discovery answered ${status}`);
  if (d.issuer !== s.issuer) throw new Error("the discovery document names a different issuer");
  if (!isUrl(d.authorization_endpoint) || !isUrl(d.token_endpoint) || !isUrl(d.jwks_uri)) throw new Error("the discovery document is missing an endpoint");
  // The browser is sent to the authorization endpoint, so it gets the same https rule as what the server fetches.
  checkUrl(d.authorization_endpoint, policy());
  const doc = { issuer: d.issuer, authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri };
  discovery = { at: Date.now(), issuer: s.issuer, doc };
  return doc;
}

async function keySet(uri: string, refresh: boolean): Promise<JSONWebKeySet> {
  if (!refresh && jwks && jwks.uri === uri && Date.now() - jwks.at < JWKS_TTL_MS) return jwks.set;
  const { status, json } = await getJson(uri);
  const set = json as JSONWebKeySet;
  if (status !== 200 || !set || !Array.isArray(set.keys)) throw new Error(`the key set answered ${status}`);
  jwks = { at: Date.now(), uri, set };
  return set;
}

/** Values bound to one browser's pre-session cookie. */
const bound = (browserToken: string, what: "state" | "nonce" | "pkce") => hmac(serverKey("oidc"), `${what}:${browserToken}`);
const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** The origin of the provider's authorization endpoint (the sign-in form is redirected there), or null if discovery fails. */
export async function authorizationOrigin(s: SsoSettings): Promise<string | null> {
  return providerDocument(s).then((d) => new URL(d.authorization_endpoint).origin, () => null);
}

/** Starts single sign-on: a new pre-session cookie and the provider URL to send the browser to. `workspace` (optional) looks in that one only. */
export async function startSso(returnTo: unknown, meta: ClientMeta, rawWorkspace?: unknown): Promise<{ browserToken: string; url: string }> {
  const s = ssoSettings();
  if (!s) throw unavailable("Single sign-on");
  const workspace = namedWorkspace(rawWorkspace);
  limitAddress(meta);
  let doc: Discovery;
  try {
    doc = await providerDocument(s);
  } catch (e) {
    logger.warn({ event: "sso_discovery_failed", err: (e as Error).message }, "single sign-on: discovery failed");
    throw new ApiError(502, "provider_unavailable", "The single sign-on provider can't be reached; try again later");
  }
  const browserToken = newToken();
  await withFlows({ browser: browserToken }, (tx) => insertSsoFlow(tx, { browserHash: tokenHash(browserToken), returnTo: safeReturnTo(returnTo), workspaceId: workspace,
    minutes: FLOW_MINUTES.oidc }));
  const url = new URL(doc.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: s.clientId, redirect_uri: redirectUri(), scope: "openid email profile",
    state: bound(browserToken, "state"), nonce: bound(browserToken, "nonce"), code_challenge: challenge(bound(browserToken, "pkce")), code_challenge_method: "S256" })) {
    url.searchParams.set(k, v);
  }
  return { browserToken, url: url.toString() };
}

/** Why an ID token's claims are refused, or null. The signature, issuer, audience and expiry are checked by jwtVerify first. */
function claimProblem(p: JWTPayload, s: SsoSettings, nonce: string): string | null {
  if (typeof p.nonce !== "string" || !safeEqual(Buffer.from(p.nonce), Buffer.from(nonce))) return "nonce";
  if (Array.isArray(p.aud) && p.aud.length > 1 && p.azp === undefined) return "azp_missing";
  if (p.azp !== undefined && p.azp !== s.clientId) return "azp";
  if (typeof p.sub !== "string" || !p.sub || p.sub.length > 255) return "sub";
  if (p.email_verified !== true) return "email_unverified";
  if (typeof p.email !== "string" || p.email.length > 254 || !p.email.includes("@")) return "email";
  const domain = emailDomain(p.email);
  if (s.domains.length && !s.domains.includes(domain)) return "email_domain";
  return null;
}

/** The SSO failure reasons a test can see in logs; the person is shown one generic message. */
export type SsoFailure = "state" | "provider_error" | "token_request" | "id_token" | "nonce" | "azp" | "azp_missing" | "sub" | "email_unverified" | "email" | "email_domain" | "no_member";

const emailDomain = (email: string) => canonicalEmail(email).split("@").pop()!;

class SsoFailed extends Error {
  constructor(readonly reason: SsoFailure, detail?: string) {
    super(detail ?? reason);
  }
}

/**
 * Finishes single sign-on at the redirect URI. The flow is used up first, so a callback can't be
 * replayed. Prefers members already linked to this provider subject; otherwise matches the verified
 * email to members not linked to another subject, and links them (a changed email at the provider
 * can then never move a sign-in to someone else). Every sign-in, by subject too, is checked against
 * the server's and the workspace's allowed domains and the workspace's SSO switch.
 */
export async function finishSso(browserToken: string | null, query: { code?: string; state?: string; error?: string }, meta: ClientMeta): Promise<SignInResult> {
  const s = ssoSettings();
  if (!s) throw unavailable("Single sign-on");
  limitAddress(meta);
  if (!isToken(browserToken)) throw expired();
  const flow = await withFlows({ browser: browserToken }, consumeSsoFlow);
  if (!flow) throw expired();
  try {
    const state = bound(browserToken, "state");
    if (typeof query.state !== "string" || !safeEqual(Buffer.from(query.state), Buffer.from(state))) throw new SsoFailed("state");
    if (query.error || typeof query.code !== "string" || !query.code || query.code.length > 2048) throw new SsoFailed("provider_error", String(query.error ?? "no code").slice(0, 100));
    const doc = await providerDocument(s);
    const basic = Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString("base64");
    const token = await getJson(doc.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: query.code, redirect_uri: redirectUri(), code_verifier: bound(browserToken, "pkce") }).toString() })
      .catch((e: Error) => { throw new SsoFailed("token_request", e.message); });
    const idToken = (token.json as { id_token?: unknown } | null)?.id_token;
    if (token.status !== 200 || typeof idToken !== "string") throw new SsoFailed("token_request", `status ${token.status}`);
    const payload = await verifyIdToken(idToken, s, doc);
    const why = claimProblem(payload, s, bound(browserToken, "nonce"));
    if (why) throw new SsoFailed(why as SsoFailure);
    const { members, more } = await ssoMembers(s, payload.sub!, payload.email as string, flow.workspace_id, meta);
    if (members.length === 0 && !more) throw new SsoFailed("no_member");
    return await completeSignIn(members, "oidc", flow.return_to, meta, more);
  } catch (e) {
    if (!(e instanceof SsoFailed)) throw e;
    logger.warn({ requestId: meta.requestId, event: "sso_failed", reason: e.reason }, "single sign-on refused");
    throw failed("Single sign-on didn't work for this account. Ask an admin of your workspace, or sign in another way");
  }
}

async function verifyIdToken(idToken: string, s: SsoSettings, doc: Discovery): Promise<JWTPayload> {
  const opts = { issuer: doc.issuer, audience: s.clientId, algorithms: ALGORITHMS, requiredClaims: ["exp", "iat", "sub", "nonce"], clockTolerance: 60 };
  try {
    return (await jwtVerify(idToken, createLocalJWKSet(await keySet(doc.jwks_uri, false)), opts)).payload;
  } catch (e) {
    // A key the cached set doesn't have may be a rotation: fetch the set again, once.
    if (e instanceof joseErrors.JWKSNoMatchingKey) {
      try {
        return (await jwtVerify(idToken, createLocalJWKSet(await keySet(doc.jwks_uri, true)), opts)).payload;
      } catch (e2) {
        throw new SsoFailed("id_token", (e2 as Error).message);
      }
    }
    throw new SsoFailed("id_token", (e as Error).message);
  }
}

async function ssoMembers(s: SsoSettings, subject: string, email: string, workspace: string | null, meta: ClientMeta): Promise<{ members: Membership[]; more: boolean }> {
  const domain = emailDomain(email);
  const allowed = (m: Membership) => m.ssoAllowed && (m.ssoDomains.length === 0 || m.ssoDomains.includes(domain));
  const bySubject = await lookupIdentity("oidc", oidcIdentity(s.issuer, subject), workspace);
  const linked = await activeMemberships(bySubject.candidates);
  if (linked.length) return { members: linked.filter(allowed), more: bySubject.more };
  const found = await lookupIdentity("email", email, workspace);
  const byEmail = (await activeMemberships(found.candidates)).filter((m) => !m.oidc && allowed(m));
  for (const m of byEmail) {
    await withTenant(m.tenantId, async (tx) => {
      if (await linkSsoSubject(tx, m.tenantId, m.userId, s.issuer, subject)) {
        await audit(tx, webCtx(m.tenantId, m.userId, m.role, meta), { action: "auth.sso_linked", objectType: "user", recordId: m.userId, details: { issuer: s.issuer } });
      }
    });
  }
  return { members: byEmail, more: found.more };
}

/**
 * Removes a member's single sign-on link, so the provider's subject no longer signs them in. A later
 * SSO sign-in with a verified email that matches them links them again, unless the workspace turned
 * SSO off or its allowed domains exclude that email. Audited when there was a link.
 */
export async function unlinkSso(tx: Tx, ctx: Ctx, userId: string): Promise<{ sso_linked: false; unlinked: boolean }> {
  const old = await removeSsoLink(tx, userId);
  if (old) await audit(tx, ctx, { action: "auth.sso_unlinked", objectType: "user", recordId: userId, details: { issuer: old.issuer } });
  return { sso_linked: false, unlinked: old !== undefined };
}
