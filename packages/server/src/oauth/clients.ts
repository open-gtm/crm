import { isIP } from "node:net";
import { db, type Tx } from "../db/pool.js";
import { encodeId, uuidv7 } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { BlockedTargetError, checkUrl, safeRequest, type FetchResult } from "../lib/outbound.js";
import { config } from "../config.js";
import { LIMITS, hit } from "../auth/limits.js";
import {
  allowClientPrune, clientExists, countHostDocuments, countLiveDocuments, countLiveRegistrations, deleteExpiredAssertions, deleteExpiredDocuments,
  deleteLapsedClients, evictLeastRecentDocument, evictOldestUnusedRegistration, insertRegistration, markClientUsed, narrowToClient, openClientRegistry,
  storedClientRow, upsertDocument, type ClientRow,
} from "./queries.js";

/**
 * OAuth clients (ADR 0010). Two kinds, and no allowlist: any client that registers or presents a
 * valid metadata document may ask, and the member decides on the consent page.
 *
 *   metadata_document  the client_id is an https URL serving a JSON document about the client (Client
 *                      ID Metadata Documents). Fetched through lib/outbound.ts (https on port 443 only,
 *                      private and metadata addresses refused, DNS pinned, no redirects, 5 s for DNS and
 *                      request together, 32 KB), cached per its Cache-Control within bounds and refreshed
 *                      in the background once stale; failures cached briefly in memory.
 *   registered         made by POST /oauth/register (RFC 7591) with no authentication, so it proves
 *                      nothing about who made it; rate limited, capped, and lapses if unused.
 *
 * Clients hold no secrets: registered clients are public; metadata-document clients may instead
 * authenticate at the token endpoint with a signed assertion (private_key_jwt, oauth/token.ts).
 */

export interface Client {
  clientId: string;
  kind: "registered" | "metadata_document";
  name: string;
  clientUri: string | null;
  redirectUris: string[];
  applicationType: "web" | "native";
  authMethod: "none" | "private_key_jwt";
  jwksUri: string | null;
  /** Came from this server's own records (a cached document or a registration), not fetched just now. */
  stored?: boolean;
}

export class ClientError extends Error {
  constructor(readonly code: "invalid_client" | "invalid_client_metadata" | "invalid_redirect_uri" | "temporarily_unavailable", message: string) {
    super(message);
  }
}

// --- Redirect URIs --------------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);
/** Characters that change how text reads without being seen: zero-width, direction overrides and isolates, the byte order mark. */
const isFormatting = (code: number) => (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;
const hasControl = (s: string) => [...s].some((ch) => isControl(ch.codePointAt(0)!));

/** True for http://localhost, 127.0.0.1 or [::1] (any port): a native app's loopback redirect (RFC 8252 §7.3). */
export function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Why a redirect URI can't be registered or used, or null. https, or plain http to a loopback address
 * only; absolute, no fragment, no credentials, at most 2000 characters. Custom schemes aren't accepted.
 */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return "a redirect URI must be a URL of at most 2000 characters";
  if (/\s/.test(raw) || hasControl(raw)) return "a redirect URI must not contain spaces or control characters";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "a redirect URI must be an absolute URL";
  }
  if (u.hash || raw.includes("#")) return "a redirect URI must not have a fragment";
  if (u.username || u.password) return "a redirect URI must not contain credentials";
  if (u.protocol === "https:") return u.hostname ? null : "a redirect URI needs a host";
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return "a redirect URI must use https, or http to localhost, 127.0.0.1 or [::1]";
}

/**
 * Whether a requested redirect URI matches a registered one: exactly, character for character, except
 * that for loopback http the port may differ (RFC 8252 §7.3: native apps pick a free port at run time).
 * Everything else about a loopback URI (host, path, query) must still match exactly.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!isLoopback(registered) || !isLoopback(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  // Compare the raw text with the port removed, so no normalisation by the URL parser can make two differ-looking URIs equal.
  const strip = (raw: string, u: URL) => (u.port ? raw.replace(`${u.hostname}:${u.port}`, u.hostname) : raw);
  return a.hostname === b.hostname && strip(registered, a) === strip(requested, b);
}

export const redirectHost = (uri: string): string => {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
};

// --- Database --------------------------------------------------------------------------------------

const fromRow = (r: ClientRow, stored = true): Client => ({ clientId: r.client_id, kind: r.kind, name: r.client_name, clientUri: r.client_uri, redirectUris: r.redirect_uris,
  applicationType: r.application_type, authMethod: r.token_endpoint_auth_method, jwksUri: r.jwks_uri, stored });

/** A transaction that sees only the client named (the client_lookup policy). */
function withClient<T>(clientId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().begin(async (tx) => {
    await narrowToClient(tx, clientId);
    return fn(tx);
  }) as Promise<T>;
}

async function storedClient(clientId: string): Promise<ClientRow | null> {
  return withClient(clientId, (tx) => storedClientRow(tx, clientId));
}

/**
 * The client a client_id names, or a ClientError. A URL is a metadata document (cached or fetched);
 * anything else must be a live registration. `allowStale` (the token and revocation endpoints) keeps
 * using a cached document past its cache life when fetching it again fails, so an app's host being
 * down for a while doesn't end its connections: the grant already pinned the redirect URI the member
 * saw. `caller` is the requesting address's limit key (auth/limits.ts addressKey): fetches of URLs
 * never seen before are charged to it.
 */
export async function resolveClient(clientId: unknown, opts: { allowStale?: boolean; caller?: string } = {}): Promise<Client> {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 500 || hasControl(clientId)) {
    throw new ClientError("invalid_client", "client_id is missing or not valid");
  }
  if (clientId.startsWith("https://") || clientId.startsWith("http://")) return metadataClient(clientId, opts.allowStale ?? false, opts.caller ?? "unknown");
  const row = await storedClient(clientId);
  if (!row || row.kind !== "registered" || row.expires_at.getTime() <= Date.now()) throw new ClientError("invalid_client", "This client is not registered here (or its registration lapsed)");
  return fromRow(row);
}

/** Records that a client was used for a grant: a registration then lives at least as long as its refresh tokens can. */
export async function touchClient(clientId: string): Promise<void> {
  const days = config().OAUTH_REFRESH_TOKEN_DAYS + 1;
  await withClient(clientId, (tx) => markClientUsed(tx, clientId, days));
}

// --- Client ID metadata documents ----------------------------------------------------------------

const DOC_BYTES = 32 * 1024;
/** DNS and the request together: a slow host holds a fetch slot at most this long. */
const DOC_DEADLINE_MS = 5_000;
const CACHE_MIN_S = 300;
const CACHE_MAX_S = 86_400;
/** How long past its cache life a cached document may still be used (when its host is down, or while it is refreshed). Checked here, not left to the hourly prune. */
export const STALE_MAX_MS = 86_400_000;
const NEGATIVE_TTL_MS = 5 * 60_000;
const MAX_NEGATIVE = 5_000;
const MAX_CACHED_DOCUMENTS = 10_000;
/** One host's documents can fill at most this much of the cache; past it, a new one replaces that host's least recently used. */
const MAX_DOCUMENTS_PER_HOST = 500;
/**
 * Concurrent fetches. Clients already known (a cached document, a key set fetched before) have a pool
 * of their own, so a flood of new URLs can't hold every slot; URLs never seen before are also held to
 * a few per caller address and per registrable domain, in both pools.
 */
const SLOTS = { known: 16, fresh: 32, perCaller: 2, perDomain: 4 };
/** What every refused or unfetchable document or key set answers: the reason is logged, never told to the caller, so this server can't be used to probe other hosts. */
const REFUSED = "This app's client metadata document or key set could not be fetched or isn't acceptable; the server's log says why";

export type DocumentTransport = (url: string, opts: { method: "GET"; headers: Record<string, string>; maxBytes: number; deadlineMs: number }) => Promise<FetchResult>;
/** The real fetch: the SSRF guard with no exceptions (no setting allows http or private addresses here). */
const defaultTransport: DocumentTransport = (url, opts) => safeRequest(url, opts, { allowInsecure: false });
let transport: DocumentTransport = defaultTransport;
/** For tests: serve metadata documents and key sets from a fake. The URL checks before it still apply. */
export function setDocumentTransport(t: DocumentTransport | null): void {
  transport = t ?? defaultTransport;
}

const negative = new Map<string, number>();
/** Known documents whose last refresh failed: an authorization then needs a fresh copy again (the token endpoint keeps using the cached one). */
const refreshFailed = new Map<string, number>();
const inFlight = new Map<string, Promise<FetchResult>>();
const refreshing = new Set<Promise<unknown>>();
const busy = { known: 0, fresh: 0 };
const busyKeys = new Map<string, number>();
/** For tests. */
export function resetClientCaches(): void {
  negative.clear();
  refreshFailed.clear();
  inFlight.clear();
  busyKeys.clear();
  busy.known = 0;
  busy.fresh = 0;
}
/** For tests and shutdown: waits for background refreshes of cached documents. */
export async function settleClientRefreshes(): Promise<void> {
  while (refreshing.size) await Promise.all([...refreshing]);
}

const remember = <V>(map: Map<string, V>, key: string, value: V, max: number) => {
  map.delete(key);
  map.set(key, value);
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
};

/**
 * The registrable part of a host, roughly (there is no public suffix list here): the last two labels,
 * or three under a two-letter country code with a short second level (co.uk, com.au). An IP is itself.
 */
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(h)) return h;
  const labels = h.split(".");
  const n = labels.length >= 3 && labels.at(-1)!.length === 2 && labels.at(-2)!.length <= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Takes a fetch slot, or null when the pool, the caller's share or the domain's share is full. */
function takeSlot(known: boolean, caller: string, domain: string): (() => void) | null {
  const pool = known ? "known" : "fresh";
  const keys = [`${pool}:d:${domain}`, ...(known ? [] : [`c:${caller}`])];
  if (busy[pool] >= SLOTS[pool] || (busyKeys.get(keys[0]!) ?? 0) >= SLOTS.perDomain || (!known && (busyKeys.get(keys[1]!) ?? 0) >= SLOTS.perCaller)) return null;
  const add = (d: number) => {
    busy[pool] += d;
    for (const k of keys) {
      const n = (busyKeys.get(k) ?? 0) + d;
      if (n > 0) busyKeys.set(k, n);
      else busyKeys.delete(k);
    }
  };
  add(1);
  return () => add(-1);
}

/**
 * Fetches a document or key set under the guard, the budgets and the slots. `known`: the URL is a
 * cached client's document or a key set fetched before, charged to its host's own budget; otherwise
 * it is charged to the caller's address and to the registrable domain, so URLs nobody has seen can't
 * use up what a real client on the same host needs. One fetch per URL at a time.
 */
function guardedFetch(url: string, known: boolean, caller: string): Promise<FetchResult> {
  const pending = inFlight.get(url);
  if (pending) return pending;
  const u = new URL(url);
  const domain = registrableDomain(u.hostname);
  const release = takeSlot(known, caller, domain);
  if (!release) return Promise.reject(new ClientError("temporarily_unavailable", "Too many client documents are being fetched right now; try again shortly"));
  const over = known ? hit(LIMITS.oauthDocumentHost, u.host) : hit(LIMITS.oauthDocumentNewCaller, caller) ?? hit(LIMITS.oauthDocumentNewDomain, domain);
  if (over !== null) {
    release();
    return Promise.reject(new ClientError("temporarily_unavailable", "Too many client documents fetched for this host or from this address; try again shortly"));
  }
  const p = transport(url, { method: "GET", headers: { accept: "application/json" }, maxBytes: DOC_BYTES, deadlineMs: DOC_DEADLINE_MS }).finally(() => {
    release();
    inFlight.delete(url);
  });
  inFlight.set(url, p);
  return p;
}

/**
 * Why a client_id can't be a metadata document URL, or null: https on the default port with a host
 * and a path other than `/`, no query, fragment, credentials or dot segments, and a host that isn't an
 * internal name or a blocked address (checkUrl). The fetch then checks the resolved addresses too.
 * Port 443 only, so naming a URL can't make this server knock on other ports of other hosts.
 */
export function clientIdUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "client_id is not a valid URL";
  }
  if (u.protocol !== "https:") return "a client_id URL must use https";
  if (u.port) return "a client_id URL must use the default https port (443)";
  if (u.username || u.password || u.search || u.hash || raw.includes("#") || raw.includes("?")) return "a client_id URL must have no credentials, query or fragment";
  if (u.pathname === "/" || u.pathname === "") return "a client_id URL must have a path";
  if (raw.split("/").some((s) => /^(?:\.|%2e){1,2}$/i.test(s))) return "a client_id URL must not contain . or .. segments";
  if (u.href !== raw) return "a client_id URL must be in its normal form";
  try {
    checkUrl(raw, { allowInsecure: false });
  } catch (e) {
    return e instanceof BlockedTargetError ? e.message.replace(/^Webhook URL/, "The client_id URL") : "client_id is not allowed";
  }
  return null;
}

/**
 * A metadata-document client. A cached copy within its cache life is used as is. Past it (up to
 * STALE_MAX_MS), the cached copy is used while a refresh runs in the background (stale while
 * revalidate), so a client already known never waits for, or is refused a slot by, its own host;
 * except that once a refresh has failed, an authorization needs a fresh copy (the token and
 * revocation endpoints keep using the cached one). Anything else is fetched now.
 */
async function metadataClient(url: string, allowStale: boolean, caller: string): Promise<Client> {
  const why = clientIdUrlProblem(url);
  if (why) throw new ClientError("invalid_client", why);
  const row = await storedClient(url);
  const doc = row?.kind === "metadata_document" ? row : null;
  const age = doc ? Date.now() - doc.expires_at.getTime() : Infinity;
  if (doc && age < 0) return fromRow(doc, true);
  if (doc && age <= STALE_MAX_MS && (allowStale || !refreshFailed.has(url))) {
    refreshInBackground(url, caller);
    return fromRow(doc, true);
  }
  return fetchDocument(url, doc !== null, caller);
}

function refreshInBackground(url: string, caller: string): void {
  if (inFlight.has(url)) return;
  const p = fetchDocument(url, true, caller).catch(() => {}).finally(() => refreshing.delete(p));
  refreshing.add(p);
}

/** Seconds a fetched document may be cached: its max-age (no-store and no-cache count as the minimum), between 5 minutes and a day. */
function cacheSeconds(header: string | string[] | undefined): number {
  const cc = (Array.isArray(header) ? header.join(",") : header ?? "").toLowerCase();
  const m = /max-age=(\d+)/.exec(cc);
  const s = /no-store|no-cache/.test(cc) || !m ? CACHE_MIN_S : Number(m[1]);
  return Math.min(CACHE_MAX_S, Math.max(CACHE_MIN_S, s));
}

async function fetchDocument(url: string, known: boolean, caller: string): Promise<Client> {
  const until = negative.get(url);
  if (until !== undefined && until > Date.now()) throw new ClientError("invalid_client", REFUSED);
  const fail = (reason: string): never => {
    remember(negative, url, Date.now() + NEGATIVE_TTL_MS, MAX_NEGATIVE);
    if (known) remember(refreshFailed, url, Date.now(), MAX_NEGATIVE);
    logger.warn({ event: "oauth_client_document_refused", url, reason }, "client metadata document refused");
    throw new ClientError("invalid_client", REFUSED);
  };
  let res: FetchResult;
  try {
    res = await guardedFetch(url, known, caller);
  } catch (e) {
    if (e instanceof ClientError) throw e;
    return fail(`could not be fetched (${e instanceof BlockedTargetError ? e.message : "unreachable, too large or too slow"})`);
  }
  // Redirects are never followed: the document must be served at the client_id URL itself.
  if (res.status !== 200) return fail(`answered HTTP ${res.status}, not 200`);
  if (Buffer.byteLength(res.body) > DOC_BYTES) return fail("is larger than 32 KB");
  let doc: unknown;
  try {
    doc = JSON.parse(res.body);
  } catch {
    return fail("is not JSON");
  }
  const client = parseDocument(url, doc);
  if (typeof client === "string") return fail(client);
  refreshFailed.delete(url);
  await cacheDocument(client, cacheSeconds(res.headers["cache-control"]));
  return client;
}

const plainText = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // Control and formatting characters (bidi overrides and the like) are dropped: a name must read as what it is.
  const t = [...v].filter((ch) => !isControl(ch.codePointAt(0)!) && !isFormatting(ch.codePointAt(0)!)).join("").trim();
  return t ? t.slice(0, max) : null;
};

/**
 * The application type redirect URIs imply, one rule for documents and registrations: any loopback
 * URI makes the client native (a web client may use only https on a non-loopback host).
 */
export const impliedApplicationType = (uris: string[]): Client["applicationType"] => (uris.some(isLoopback) ? "native" : "web");

/** Validates a metadata document. Returns the client, or why it is refused. */
export function parseDocument(url: string, doc: unknown): Client | string {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "The client's metadata document is not a JSON object";
  const d = doc as Record<string, unknown>;
  if (d.client_id !== url) return "The client's metadata document has a client_id other than its own URL";
  const name = plainText(d.client_name, 100);
  if (!name) return "The client's metadata document has no client_name";
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0 || d.redirect_uris.length > 20) return "The client's metadata document needs 1 to 20 redirect_uris";
  for (const r of d.redirect_uris) {
    const why = redirectUriProblem(r);
    if (why) return `The client's metadata document lists a redirect URI this server refuses: ${why}`;
  }
  if (Object.keys(d).some((k) => k.startsWith("client_secret"))) return "A client metadata document must not carry a client secret";
  const method = d.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "private_key_jwt") return "The client's token_endpoint_auth_method must be none or private_key_jwt";
  let jwksUri: string | null = null;
  if (method === "private_key_jwt") {
    if (typeof d.jwks_uri !== "string" || clientIdUrlProblem(d.jwks_uri)) return "A private_key_jwt client's metadata document needs an https jwks_uri on port 443";
    jwksUri = d.jwks_uri;
  }
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))) {
    return "The client's grant_types must include authorization_code";
  }
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes("code"))) return "The client's response_types must include code";
  const uris = d.redirect_uris as string[];
  const clientUri = typeof d.client_uri === "string" && /^https:\/\//.test(d.client_uri) && d.client_uri.length <= 500 ? d.client_uri : null;
  return { clientId: url, kind: "metadata_document", name, clientUri, redirectUris: uris, applicationType: impliedApplicationType(uris), authMethod: method, jwksUri };
}

/**
 * Keeps a fetched document. A document already cached is always updated. A new one makes room when
 * the cache is full (expired copies first, then the least recently used), and when its host already
 * fills its share, it replaces that host's least recently used: no flood of documents, from one host
 * or many, can stop known clients being refreshed. Only unexpired copies count against the cap.
 */
async function cacheDocument(c: Client, seconds: number): Promise<void> {
  try {
    await db().begin(async (tx) => {
      await openClientRegistry(tx, c.clientId);
      const exists = await clientExists(tx, c.clientId);
      if (!exists) {
        const prefix = `${new URL(c.clientId).origin}/`;
        const lru = (sameHost: boolean) => evictLeastRecentDocument(tx, sameHost ? prefix : null);
        const host = await countHostDocuments(tx, prefix);
        if (host >= MAX_DOCUMENTS_PER_HOST) await lru(true);
        else {
          const all = await countLiveDocuments(tx);
          if (all >= MAX_CACHED_DOCUMENTS) {
            const expired = await deleteExpiredDocuments(tx);
            if (!expired) await lru(false);
            logger.warn({ event: "oauth_client_cache_full", evicted: expired || 1 }, "client document cache full; made room");
          }
        }
      }
      await upsertDocument(tx, uuidv7(), c, seconds);
    });
  } catch (e) {
    logger.warn({ event: "oauth_client_cache_failed", err: (e as Error).message }, "could not cache a client metadata document");
  }
}

/** Fetches a private_key_jwt client's key set (same guard, budgets and slots as documents; `known` as for guardedFetch). */
export async function fetchKeySet(uri: string, known: boolean, caller: string): Promise<unknown> {
  const why = clientIdUrlProblem(uri);
  if (why) throw new ClientError("invalid_client", why);
  const refuse = (reason: string): never => {
    logger.warn({ event: "oauth_key_set_refused", url: uri, reason }, "client key set refused");
    throw new ClientError("invalid_client", REFUSED);
  };
  let res: FetchResult;
  try {
    res = await guardedFetch(uri, known, caller);
  } catch (e) {
    if (e instanceof ClientError) throw e;
    return refuse(`could not be fetched (${e instanceof BlockedTargetError ? e.message : "unreachable, too large or too slow"})`);
  }
  if (res.status !== 200) return refuse(`answered HTTP ${res.status}`);
  try {
    return JSON.parse(res.body);
  } catch {
    return refuse("is not JSON");
  }
}

// --- Dynamic client registration (RFC 7591) -------------------------------------------------------

/** Registrations that never led to a token lapse after this long. */
export const UNUSED_REGISTRATION_HOURS = 24;
const MAX_REGISTRATIONS = 10_000;

/** Under a full registry, an unused registration younger than this is never evicted: someone may be approving it right now. */
const EVICT_AFTER_MINUTES = 15;

/**
 * Registers a public client. `application_type` is honoured when given: "web" may use only https
 * redirect URIs on a non-loopback host, "native" also loopback http. Left out, it is inferred by the
 * same rule (any loopback URI: native), because clients written against earlier MCP revisions don't
 * send it. When the registry is full, the oldest registration never used for a token makes room (a
 * used one never does), so a flood of registrations can't lock out real ones.
 */
export async function registerClient(body: unknown): Promise<Client & { issuedAt: Date }> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientError("invalid_client_metadata", "The body must be a JSON object");
  const b = body as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) throw new ClientError("invalid_redirect_uri", "redirect_uris must list 1 to 10 URIs");
  for (const u of uris) {
    const why = redirectUriProblem(u);
    if (why) throw new ClientError("invalid_redirect_uri", why);
  }
  const redirectUris = [...new Set(uris as string[])];
  const type = b.application_type;
  if (type !== undefined && type !== "web" && type !== "native") throw new ClientError("invalid_client_metadata", "application_type must be web or native");
  if (type === "web" && redirectUris.some(isLoopback)) throw new ClientError("invalid_redirect_uri", "A web application can't use a loopback redirect URI; register it as native");
  const applicationType = type ?? impliedApplicationType(redirectUris);
  const method = b.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new ClientError("invalid_client_metadata", "Registered clients are public: token_endpoint_auth_method must be none");
  if (b.grant_types !== undefined && !(Array.isArray(b.grant_types) && b.grant_types.every((g) => g === "authorization_code" || g === "refresh_token"))) {
    throw new ClientError("invalid_client_metadata", "grant_types may hold only authorization_code and refresh_token");
  }
  if (b.response_types !== undefined && !(Array.isArray(b.response_types) && b.response_types.every((r) => r === "code"))) {
    throw new ClientError("invalid_client_metadata", "response_types may hold only code");
  }
  const name = plainText(b.client_name, 100) ?? "Unnamed app";
  const clientUri = typeof b.client_uri === "string" && /^https:\/\//.test(b.client_uri) && b.client_uri.length <= 500 ? b.client_uri : null;
  const id = uuidv7();
  const clientId = encodeId("oac", id);
  const issuedAt = await db().begin(async (tx) => {
    await openClientRegistry(tx, clientId);
    const count = await countLiveRegistrations(tx);
    if (count >= MAX_REGISTRATIONS) {
      const evicted = await evictOldestUnusedRegistration(tx, EVICT_AFTER_MINUTES);
      if (!evicted) throw new ClientError("temporarily_unavailable", "This server has as many registered apps as it keeps; try again later");
      logger.warn({ event: "oauth_registry_full" }, "client registry full; the oldest unused registration was removed");
    }
    return insertRegistration(tx, { id, clientId, name, clientUri, redirectUris, applicationType, hours: UNUSED_REGISTRATION_HOURS });
  }) as Date;
  return { clientId, kind: "registered", name, clientUri, redirectUris, applicationType, authMethod: "none", jwksUri: null, issuedAt };
}

/** Deletes lapsed registrations, stale cached documents and used assertion IDs. The worker runs this hourly. */
export async function pruneClients(): Promise<number> {
  return db().begin(async (tx) => {
    await allowClientPrune(tx);
    const a = await deleteLapsedClients(tx);
    const b = await deleteExpiredAssertions(tx);
    return a + b;
  }) as Promise<number>;
}
