import { hkdfSync, randomBytes, randomInt } from "node:crypto";
import { masterKey, publicOrigin } from "../config.js";
import { hmac, safeEqual, sha256 } from "../lib/crypto.js";

/**
 * Secrets for people sign-in. Every one is 256 random bits, sent to the browser (a cookie) or the
 * person (an email, a printed link) once, and stored only as a SHA-256 hash or an HMAC.
 */

/** A 256-bit random token, base64url (43 characters). Session cookies, pre-session cookies and link tokens. */
export const newToken = (): string => randomBytes(32).toString("base64url");
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const isToken = (s: unknown): s is string => typeof s === "string" && TOKEN_PATTERN.test(s);
export const tokenHash = (token: string): Buffer => sha256(token);

/** An 8-digit code to type in: short enough to copy, and with 5 attempts a guess succeeds once in 20 million. */
export const newCode = (): string => String(randomInt(0, 100_000_000)).padStart(8, "0");
export const CODE_PATTERN = /^\d{8}$/;

const derived = new Map<string, Buffer>();
/**
 * Keys derived from the master key, one per purpose. They never leave the process, so an HMAC made
 * with one can't be recomputed (or a code brute-forced) from a copy of the database alone.
 */
export function serverKey(purpose: "csrf" | "code" | "oidc" | "sign_up"): Buffer {
  let k = derived.get(purpose);
  if (!k) {
    k = Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), `hl-crm-db/sign-in/${purpose}/v1`, 32));
    derived.set(purpose, k);
  }
  return k;
}

/** The HMAC an emailed code is stored as, bound to its flow so the same code in two flows hashes differently. */
export const codeHash = (flowId: string, code: string): Buffer => Buffer.from(hmac(serverKey("code"), `${flowId}:${code}`), "base64url");

/**
 * The CSRF token of a session: an HMAC of its ID under a server key. Bound to the session (another
 * session's token never matches), nothing to store, and only readable from a same-origin response.
 */
export const csrfToken = (sessionId: string): string => hmac(serverKey("csrf"), `csrf:${sessionId}`);

export function csrfTokenMatches(sessionId: string, presented: string | undefined | null): boolean {
  return typeof presented === "string" && safeEqual(Buffer.from(csrfToken(sessionId)), Buffer.from(presented));
}

/**
 * Why a cookie-authenticated, state-changing request is refused, or null when it may go ahead:
 * Origin must be the public origin (a missing or "null" Origin is refused), Sec-Fetch-Site, when the
 * browser sends it, must be same-origin, and the request must carry the session's CSRF token.
 */
export function csrfRefusal(h: { origin?: string | null; fetchSite?: string | null; token?: string | null }, sessionId: string): string | null {
  const origin = originRefusal(h);
  if (origin) return origin;
  if (!csrfTokenMatches(sessionId, h.token)) return "The X-CSRF-Token header is missing or does not match this session (get it from GET /v1/auth/session)";
  return null;
}

/**
 * The Origin and Sec-Fetch-Site half of csrfRefusal, also applied to the sign-in forms (so no other site can sign a browser in).
 *
 * `formPost`: the request is a server-rendered HTML form post (the /auth sign-in and account pages, the
 * OAuth consent decision at POST /oauth/authorize, POST /auth/apps/revoke). Every page here is served
 * with `Referrer-Policy: no-referrer`, under which browsers send `Origin: null` on a page's own form
 * posts (a fetch() from the app still sends the real Origin). Only for those, `Origin: null` is accepted
 * when the browser also says `Sec-Fetch-Site: same-origin`, which a page can't forge. Never for /v1,
 * JSON bodies, or the OAuth token, revocation and registration endpoints (they take no cookie).
 */
export function originRefusal(h: { origin?: string | null; fetchSite?: string | null }, opts: { formPost?: boolean } = {}): string | null {
  const pub = publicOrigin();
  if (!pub) return "People sign-in is not configured on this server";
  if (opts.formPost && h.origin === "null" && h.fetchSite === "same-origin") return null;
  if (!h.origin || h.origin === "null") return "The request has no Origin header; browsers send one, so it can't be checked";
  if (h.origin !== pub.origin) return "The request comes from another origin";
  if (h.fetchSite && h.fetchSite !== "same-origin") return "The browser reports a cross-site request (Sec-Fetch-Site)";
  return null;
}
