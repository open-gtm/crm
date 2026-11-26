import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { z } from "zod";
import { canAnyObject } from "../core/access.js";
import { ALL_SCOPES, can, credential, RECORD_ACTIONS, SCOPE_PERMISSIONS, type Ctx, type Permission, type Surface } from "../core/context.js";
import { decryptValue, encryptValue } from "../core/encryption.js";
import { authenticate, keyLookup, type Principal } from "../core/keys.js";
import { cookieNames, clearCookie, readCookie } from "../auth/cookies.js";
import { resolveSession } from "../auth/sessions.js";
import { csrfRefusal } from "../auth/tokens.js";
import { oauthSettings, publicOrigin } from "../config.js";
import { mountPublicAuth } from "./auth-public.js";
import { mountOAuth } from "./oauth-public.js";
import { mountPages } from "../web/handlers.js";
import { mountOAuthPages } from "../web/oauth.js";
import { resolveAccessToken } from "../oauth/grants.js";
import { SERVICE_HEADER, isAccessToken, surfaceOf } from "../oauth/scopes.js";
import { safeEqual } from "../lib/crypto.js";
import { mountWebUi, webUi } from "../web/static.js";
import { db, POOL_MAX, type Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { canonicalJson, sha256 } from "../lib/crypto.js";
import { ApiError, forbidden } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { buildOpenApi } from "./openapi.js";
import { claimIdempotencyKey, pingDatabase, priorIdempotentRequest, storeIdempotentResponse } from "./queries.js";
import { isWrite, requiredPermission, routes, type Required } from "./registry.js";
import "./routes.js";
import "./routes-events.js";
import "./routes-alerts.js";
import "./routes-schemadoc.js";
import "./routes-transfer.js";
import "./routes-auth.js";
import "./routes-read.js";
import "./routes-write.js";
import "./routes-packs.js";
import "./routes-files.js";
import "./routes-commerce.js";
import "./routes-layouts.js";
import "./routes-disposal.js";

/** `credential`: what authenticated the request: its kind, its ID (for idempotency) and its rate-limit bucket. */
export type Env = { Variables: { ctx: Ctx; requestId: string; credential: { kind: "key" | "session" | "oauth"; id: string; bucket: string } } };

const SURFACES: Surface[] = ["api", "cli", "admin-mcp", "ops-mcp"];

/** Bounded maps for in-memory limiters: past `max` entries the oldest are dropped (Maps iterate in insertion order). */
function setBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  for (const k of map.keys()) {
    if (map.size <= max) break;
    map.delete(k);
  }
}

/**
 * Per-credential token bucket, keyed by `credential(ctx)` (an API key, or the signed-in member with all
 * their sessions together): sustained 20 requests/second, bursts of 200. A request takes one token; a
 * route with a `cost` takes more once its body and query are read (an import, one per 100 rows like the
 * batch route; a count or an aggregate). `force` takes them whatever is left, down to one bucket of
 * debt: for work charged after it was measured (`HandlerArgs.charge`), so the next requests wait instead.
 */
const buckets = new Map<string, { tokens: number; at: number }>();
function takeToken(key: string, n = 1, force = false): number | null {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: 200, at: now };
  b.tokens = Math.min(200, b.tokens + ((now - b.at) / 1000) * 20);
  b.at = now;
  if (force) b.tokens = Math.max(-200, b.tokens - n);
  // Re-inserting keeps active keys at the young end, so eviction drops idle ones (whose buckets would be full anyway).
  if (force || b.tokens < n) {
    setBounded(buckets, key, b, 50_000);
    return force ? null : Math.ceil((n - b.tokens) / 20);
  }
  b.tokens -= n;
  setBounded(buckets, key, b, 50_000);
  return null;
}

/** For tests: refill every bucket. */
export function resetRateLimiter(): void {
  buckets.clear();
}

/**
 * The heavy-request gate. Routes marked `heavy` (scans, previews, bulk writes, merges, import, export,
 * schema plan and apply) can each hold a pooled connection for seconds, and the pool is shared by every
 * workspace. So at most `perCredential` run at once per credential, and at most `server` in the whole
 * process: half the pool, so ordinary requests always find a connection. A request over either limit
 * is refused at once with 429 (it never queues holding a socket). Mutable for tests.
 */
export const HEAVY_LIMITS = { perCredential: 2, perMemberApps: 4, server: Math.max(1, Math.floor(POOL_MAX / 2)) };
const heavyByCredential = new Map<string, number>();
let heavyInServer = 0;

/**
 * The member behind a connected app, for the second heavy-request count apps have: a member can approve
 * many apps (each its own credential with 2 slots), so all their apps together hold at most
 * `perMemberApps`. Kept apart from the member's browser sessions (`user:…`), which have their own 2.
 */
const appsOfMember = (ctx: Ctx): string | null => (ctx.oauth && ctx.actor.id ? `oauth-member:${ctx.tenantId}:${ctx.actor.id}` : null);

/**
 * Takes a slot for `who` (and, for a connected app, one for its member's apps), or returns null when
 * none is free. The returned function gives them back (once).
 */
function enterHeavy(who: string, member: string | null): (() => void) | null {
  const mine = heavyByCredential.get(who) ?? 0;
  const theirs = member ? heavyByCredential.get(member) ?? 0 : 0;
  if (mine >= HEAVY_LIMITS.perCredential || (member && theirs >= HEAVY_LIMITS.perMemberApps) || heavyInServer >= HEAVY_LIMITS.server) return null;
  const held = member ? [who, member] : [who];
  for (const k of held) heavyByCredential.set(k, (heavyByCredential.get(k) ?? 0) + 1);
  heavyInServer++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    heavyInServer--;
    for (const k of held) {
      const left = (heavyByCredential.get(k) ?? 1) - 1;
      if (left > 0) heavyByCredential.set(k, left);
      else heavyByCredential.delete(k);
    }
  };
}

/**
 * Failed-authentication limiter, checked before the database is touched: per client address
 * (30 failures a minute) and per key lookup prefix (10 a minute), so neither a flood of bogus
 * keys nor guessing at one key's secret costs a transaction each.
 *
 * Many real clients can share one address (the MCP proxy, a reverse proxy without TRUST_PROXY, a
 * Docker bridge), so a blocked address must not lock them all out. From a blocked address:
 *   - a malformed key is refused outright (it can never authenticate);
 *   - a key whose lookup prefix authenticated within the last hour (`knownGood`) is checked as usual;
 *   - any other well-formed key is checked against the database under a small per-address token
 *     bucket, so a valid key that hasn't been seen since the process started still gets in while
 *     a flood of well-formed bogus keys costs a bounded number of lookups.
 * A blocked lookup prefix is refused whatever the address.
 */
const AUTH_WINDOW_MS = 60_000;
const AUTH_LIMITS = { addr: 30, lookup: 10 };
const KNOWN_GOOD_TTL_MS = 60 * 60_000;
const BLOCKED_BUDGET = { perSecond: 2, burst: 10 };
let blockedPerSecond = BLOCKED_BUDGET.perSecond;
const authFailures = new Map<string, { count: number; resetAt: number }>();
/** Lookup prefix → when its trust expires. Dropped when that lookup fails (e.g. the key was revoked). */
const knownGood = new Map<string, number>();
/** Per blocked address: database lookups it may still spend on keys not known to be good. */
const blockedBudget = new Map<string, { tokens: number; at: number }>();

function blockedSeconds(key: string, now: number): number | null {
  const b = authFailures.get(key);
  if (b && b.resetAt > now && b.count >= (key.startsWith("addr:") ? AUTH_LIMITS.addr : AUTH_LIMITS.lookup)) return Math.ceil((b.resetAt - now) / 1000);
  return null;
}

function isKnownGood(lookup: string, now: number): boolean {
  const until = knownGood.get(lookup);
  if (until === undefined) return false;
  if (until > now) return true;
  knownGood.delete(lookup);
  return false;
}

/** Takes one lookup from a blocked address's budget. Returns null if allowed, else seconds to wait. */
function takeBlockedBudget(addr: string, now: number): number | null {
  const b = blockedBudget.get(addr) ?? { tokens: BLOCKED_BUDGET.burst, at: now };
  b.tokens = Math.min(BLOCKED_BUDGET.burst, b.tokens + ((now - b.at) / 1000) * blockedPerSecond);
  b.at = now;
  const wait = b.tokens < 1 ? (blockedPerSecond > 0 ? Math.ceil((1 - b.tokens) / blockedPerSecond) : Math.ceil(AUTH_WINDOW_MS / 1000)) : null;
  if (wait === null) b.tokens -= 1;
  setBounded(blockedBudget, addr, b, 50_000);
  return wait;
}

/** Seconds to wait if this request must be refused before touching the database, else null. */
function authBlockedFor(addr: string, lookup: string | null): number | null {
  const now = Date.now();
  if (lookup) {
    const byLookup = blockedSeconds(`lookup:${lookup}`, now);
    if (byLookup !== null) return byLookup;
  }
  const byAddr = blockedSeconds(`addr:${addr}`, now);
  if (byAddr === null) return null;
  if (!lookup) return byAddr;
  if (isKnownGood(lookup, now)) return null;
  return takeBlockedBudget(addr, now);
}

function recordAuthFailure(addr: string, lookup: string | null): void {
  const now = Date.now();
  if (lookup) knownGood.delete(lookup);
  for (const k of [`addr:${addr}`, ...(lookup ? [`lookup:${lookup}`] : [])]) {
    const b = authFailures.get(k);
    setBounded(authFailures, k, b && b.resetAt > now ? { count: b.count + 1, resetAt: b.resetAt } : { count: 1, resetAt: now + AUTH_WINDOW_MS }, 100_000);
  }
}

/**
 * Invalid session cookies, per client address (30 a minute), checked before the database. Separate
 * from the key limiter, so a client spraying bad keys from a shared address doesn't sign people out.
 * A session token is 256 random bits, so this protects the database, not the tokens.
 */
const SESSION_FAILURES_PER_MINUTE = 30;
function sessionBlockedFor(addr: string): number | null {
  const b = authFailures.get(`cookie:${addr}`);
  const now = Date.now();
  return b && b.resetAt > now && b.count >= SESSION_FAILURES_PER_MINUTE ? Math.ceil((b.resetAt - now) / 1000) : null;
}
function recordSessionFailure(addr: string): void {
  const now = Date.now();
  const b = authFailures.get(`cookie:${addr}`);
  setBounded(authFailures, `cookie:${addr}`, b && b.resetAt > now ? { count: b.count + 1, resetAt: b.resetAt } : { count: 1, resetAt: now + AUTH_WINDOW_MS }, 100_000);
}

/**
 * Wrong MCP_SERVICE_SECRET values per client address (30 a minute), checked before the secret is
 * compared. Counted apart from keys: the MCP process passes callers' API keys on, so their failures
 * land on its address, and must never stop it presenting OAuth tokens with the right secret.
 */
const SERVICE_FAILURES_PER_MINUTE = 30;
/** A store of its own: a flood of bogus API keys from many addresses fills `authFailures`, and must not evict these windows. */
const serviceFailures = new Map<string, { count: number; resetAt: number }>();
function serviceBlockedFor(addr: string): number | null {
  const b = serviceFailures.get(addr);
  const now = Date.now();
  return b && b.resetAt > now && b.count >= SERVICE_FAILURES_PER_MINUTE ? Math.ceil((b.resetAt - now) / 1000) : null;
}
function recordServiceFailure(addr: string): void {
  const now = Date.now();
  const b = serviceFailures.get(addr);
  setBounded(serviceFailures, addr, b && b.resetAt > now ? { count: b.count + 1, resetAt: b.resetAt } : { count: 1, resetAt: now + AUTH_WINDOW_MS }, 100_000);
}

/** Methods that never change state; cookie-authenticated requests with any other method need the CSRF checks. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** For tests: forget recorded failures and trust. `blockedPerSecond: 0` stops the blocked-address budget refilling, for deterministic tests. */
export function resetAuthLimiter(opts: { blockedPerSecond?: number } = {}): void {
  authFailures.clear();
  serviceFailures.clear();
  knownGood.clear();
  blockedBudget.clear();
  blockedPerSecond = opts.blockedPerSecond ?? BLOCKED_BUDGET.perSecond;
}

/**
 * The client address for rate limiting: the socket peer, or, only when TRUST_PROXY is set
 * ("true" or "1"), the last X-Forwarded-For entry (the one our own proxy appended; earlier
 * entries are client-supplied).
 */
export function clientAddress(c: Context<Env>): string {
  // Read per request (config() is cached at first use) with the same meaning as config.ts: "true" or "1" turns it on.
  if (["true", "1"].includes((process.env.TRUST_PROXY ?? "").trim().toLowerCase())) {
    const xff = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
    if (xff?.length) return xff[xff.length - 1]!;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

export function problem(c: Context<Env>, err: ApiError) {
  return c.json(
    { type: `https://hl-crm-db.dev/errors/${err.code}`, title: err.code, status: err.status, detail: err.message, code: err.code,
      request_id: c.get("requestId"), ...(err.details !== undefined ? { errors: err.details } : {}) },
    err.status as 400,
    { "Content-Type": "application/problem+json" },
  );
}

export { requiredPermission };

/**
 * True when the caller holds what a route requires ("any": at least one effective permission). A
 * records:* permission is satisfied by that access on at least one object: a role may read only
 * contacts without holding records:read. The service layer then decides per object and per field.
 */
const isList = (n: Required): n is readonly Permission[] => Array.isArray(n);
function permits(ctx: Ctx, need: Required): boolean {
  if (need === "own_credential") return true;
  if (isList(need)) return need.some((p) => permits(ctx, p));
  if (need === "any") return ctx.permissions.size > 0 || RECORD_ACTIONS.some((a) => canAnyObject(ctx, a));
  const action = /^records:(read|write|archive)$/.exec(need)?.[1] as (typeof RECORD_ACTIONS)[number] | undefined;
  return action ? canAnyObject(ctx, action) : can(ctx, need);
}

/**
 * Idempotent responses are stored for 24 hours, so they must never hold a secret (an API key,
 * a webhook signing secret). Any `secret`/`*_secret` string, or anything shaped like an API key, is
 * dropped from the stored copy and a note says it was only shown in the first response.
 */
const SECRET_NOTE = "The secret is shown only in the first response to this request and is not replayed. If it was lost, rotate it.";
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (typeof v === "string") return /^hlcrm_(live|test)_/.test(v) ? "[redacted]" : v;
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const [k, val] of Object.entries(v)) {
    if (/(^|_)secret$/i.test(k) && typeof val === "string") dropped = true;
    else out[k] = redactSecrets(val);
  }
  if (dropped) out.secret_omitted = SECRET_NOTE;
  return out;
}

/**
 * The stored copy of an idempotent response is an envelope: the redacted body, encrypted with the
 * tenant data key (it can hold decrypted restricted values, which are encrypted at rest everywhere
 * else), bound by AAD to this tenant, key and Idempotency-Key, plus a fingerprint of the caller's
 * effective permissions. A replay under different permissions is refused: the response was
 * shaped by permissions the caller may no longer hold (restricted:read, say).
 */
interface StoredResponse { v: 1 | 2; sealed: string; permissions: string }
/** What v2 seals: the body and the handler's headers (a text body's Content-Type, an ETag). v1 sealed the body alone. */
interface Sealed { body: unknown; headers?: Record<string, string> }
/** Anything shaped like an API key inside a text body (a CSV, say), where there are no fields to drop. */
const KEY_IN_TEXT = /hlcrm_(live|test)_[0-9A-Za-z]+/g;
/** Object and field rules shape responses too, so their version is part of it (absent for roles without rules). */
const permissionFingerprint = (ctx: Ctx) => sha256([...[...ctx.permissions].sort(),
  ...(ctx.records ? [`rules:${ctx.records.version}`, ...ctx.records.unlocked] : [])].join(",")).toString("hex");
const idemAad = (idemKey: string) => `idempotency:${idemKey}`;

async function sealStoredResponse(tx: Tx, ctx: Ctx, credId: string, idemKey: string, body: unknown, headers?: Record<string, string>): Promise<StoredResponse> {
  const sealed: Sealed = { body: typeof body === "string" ? body.replace(KEY_IN_TEXT, "[redacted]") : redactSecrets(body), ...(headers ? { headers } : {}) };
  return { v: 2, sealed: await encryptValue(tx, ctx.tenantId, credId, idemAad(idemKey), sealed), permissions: permissionFingerprint(ctx) };
}

const NOT_REPLAYABLE = "This request was already applied, but its original response can no longer be returned "
  + "(this key's or session's permissions changed since, or the stored copy can't be read). Fetch the current state instead of retrying.";

async function openStoredResponse(tx: Tx, ctx: Ctx, credId: string, idemKey: string, stored: unknown): Promise<Sealed> {
  const s = stored as Partial<StoredResponse> | null;
  // Rows written before responses were sealed have no envelope; they are refused rather than replayed in the clear.
  if (!s || (s.v !== 1 && s.v !== 2) || typeof s.sealed !== "string" || s.permissions !== permissionFingerprint(ctx)) {
    throw new ApiError(409, "idempotency_not_replayable", NOT_REPLAYABLE);
  }
  try {
    const opened = await decryptValue(tx, ctx.tenantId, credId, idemAad(idemKey), s.sealed);
    return s.v === 1 ? { body: opened } : opened as Sealed;
  } catch {
    throw new ApiError(409, "idempotency_not_replayable", NOT_REPLAYABLE);
  }
}

/** Iterative, so a hostile body cannot overflow the stack while it is measured (or later, when it is validated and hashed). */
function jsonDepthExceeds(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d >= max) return true;
    for (const child of Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/**
 * True when any string or key in `value` holds U+0000, which Postgres text and jsonb refuse (a 500
 * if it got that far). Checked for every body, query and path parameter, so no route has to.
 */
export function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      if (v.includes("\0")) return true;
    } else if (v !== null && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (k.includes("\0")) return true;
        stack.push(child);
      }
    }
  }
  return false;
}
const NUL_REFUSED = "Text in the request must not contain NUL (\\u0000) characters";

function principalCtx(p: Principal & { oauth?: { grantId: string; clientId: string } }, surface: Surface, requestId: string): Ctx {
  return { tenantId: p.tenantId, actor: p.actor, keyId: p.keyId, ...(p.session ? { session: p.session } : {}),
    ...(p.oauth ? { oauth: { grantId: p.oauth.grantId, clientId: p.oauth.clientId } } : {}), scopes: p.scopes, permissions: p.permissions,
    ...(p.records ? { records: p.records } : {}), surface, requestId };
}

/** The upload route a request is for, if any: the one kind of route whose body isn't JSON (api/registry.ts `rawBody`). */
function uploadRoute(method: string, path: string) {
  return routes.find((r) => r.rawBody && r.method === method && new RegExp(`^${r.path.replace(/:[a-z_]+/g, "[^/]+")}/?$`).test(path));
}

export function buildApp(): Hono<Env> {
  const app = new Hono<Env>();
  // DENY rather than the default SAMEORIGIN: nothing here, the sign-in pages included, is meant to be framed.
  // Its Referrer-Policy is no-referrer, everywhere: the sign-in pages and the web UI's shell included (a
  // sign-in link's token is in the URL). Their own form posts then carry `Origin: null`, which the Origin
  // check accepts for the server-rendered form posts only (/auth pages, the OAuth consent at /oauth/authorize),
  // and only with `Sec-Fetch-Site: same-origin` (auth/tokens.ts `originRefusal`).
  app.use("*", secureHeaders({ xFrameOptions: "DENY" }));
  // Request bodies are JSON of at most 1 MB, except a file upload (a route with `rawBody`), which has its own limit.
  const jsonLimit = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ code: "payload_too_large", detail: "Request body is larger than 1 MB" }, 413) });
  app.use("*", (c, next) => {
    const upload = uploadRoute(c.req.method, c.req.path);
    if (!upload) return jsonLimit(c, next);
    const max = upload.rawBody!.maxBytes();
    return bodyLimit({ maxSize: max, onError: (cc) => cc.json({ code: "payload_too_large", detail: `The file is larger than ${Math.floor(max / (1024 * 1024))} MB` }, 413) })(c, next);
  });
  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && /^[\w.-]{1,100}$/.test(incoming) ? incoming : randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    const started = Date.now();
    await next();
    logger.info({ requestId, method: c.req.method, path: c.req.routePath, status: c.res.status, ms: Date.now() - started }, "request");
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return problem(c, err);
    if (err instanceof z.ZodError) {
      return problem(c, new ApiError(422, "validation_failed", "Request body or query is invalid",
        err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))));
    }
    const pg = err as { code?: string };
    if (pg.code === "57014") return problem(c, new ApiError(503, "query_timeout", "The query took too long; narrow the filter or page size"));
    if (pg.code === "40001" || pg.code === "40P01") return problem(c, new ApiError(409, "retry", "The request conflicted with another; retry it"));
    logger.error({ requestId: c.get("requestId"), err: { message: err.message, code: pg.code, stack: err.stack } }, "unhandled error");
    return problem(c, new ApiError(500, "internal_error", "Something went wrong. Quote the request ID if you report it."));
  });

  const noRoute = (c: Context<Env>) => problem(c, new ApiError(404, "not_found", `No route for ${c.req.method} ${c.req.path}`));
  app.notFound(noRoute);

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    await pingDatabase(db());
    return c.json({ ok: true });
  });
  app.get("/openapi.json", async (c) => c.json(await buildOpenApi(null)));

  // Sign-in pages and the endpoints that need no credential (ADR 0009). Everything else needs a key or a session.
  for (const path of ["/auth/*", "/v1/auth/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }
  mountPublicAuth(app);
  mountPages(app);
  // OAuth for the remote MCP servers (ADR 0010): discovery, token, revocation, registration, consent.
  mountOAuth(app);
  mountOAuthPages(app);

  // Authentication for everything under /v1: an API key, or (with no Authorization header at all) a session cookie.
  app.use("/v1/*", async (c, next) => {
    const names = publicOrigin() ? cookieNames() : null;
    const cookie = names && c.req.header("authorization") === undefined ? readCookie(c.req.header("cookie"), names.session) : null;
    if (cookie !== null) return sessionAuth(c, next, cookie);
    const auth = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (m && isAccessToken(m[1])) return oauthAuth(c, next, m[1]);
    const addr = clientAddress(c);
    const lookup = m ? keyLookup(m[1]!) : null;
    const blocked = authBlockedFor(addr, lookup);
    if (blocked !== null) {
      logger.warn({ requestId: c.get("requestId"), event: "auth_rate_limited", ip: addr }, "authentication rate limited");
      c.header("Retry-After", String(blocked));
      return problem(c, new ApiError(429, "rate_limited", "Too many failed authentication attempts; wait and retry"));
    }
    const principal = lookup ? await authenticate(m![1]!) : null;
    if (!principal) {
      recordAuthFailure(addr, lookup);
      logger.warn({ requestId: c.get("requestId"), event: "auth_failed", ip: addr }, "authentication failed");
      c.header("WWW-Authenticate", 'Bearer realm="hl-crm-db"');
      return problem(c, new ApiError(401, "unauthenticated", "A valid API key is required (Authorization: Bearer hlcrm_…)"));
    }
    if (lookup) setBounded(knownGood, lookup, Date.now() + KNOWN_GOOD_TTL_MS, 50_000);
    // The surface is client-reported: the MCP proxy sets X-Hlcrm-Surface by convention, and the audit
    // log records what the client claimed. Authorization never depends on it beyond narrowing (see mount).
    const surfaceHeader = (c.req.header("x-hlcrm-surface") ?? "api") as Surface;
    const surface = SURFACES.includes(surfaceHeader) ? surfaceHeader : "api";
    const ctx = principalCtx(principal, surface, c.get("requestId"));
    const bucket = credential(ctx);
    const wait = takeToken(bucket);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return problem(c, new ApiError(429, "rate_limited", "Too many requests for this key; slow down"));
    }
    c.set("credential", { kind: "key", id: principal.keyId!, bucket });
    c.set("ctx", ctx);
    await next();
  });

  /**
   * A browser session (cookie). Only reached when there is no Authorization header: a key always wins.
   * State-changing requests must pass the Origin, Sec-Fetch-Site and CSRF token checks. Rate limited
   * per member (all their sessions together), with the same bucket sizes as a key.
   */
  async function sessionAuth(c: Context<Env>, next: () => Promise<void>, token: string) {
    const addr = clientAddress(c);
    const blocked = sessionBlockedFor(addr);
    if (blocked !== null) {
      c.header("Retry-After", String(blocked));
      return problem(c, new ApiError(429, "rate_limited", "Too many requests with an invalid session; wait and retry"));
    }
    const principal = await resolveSession(token);
    if (!principal?.session) {
      recordSessionFailure(addr);
      logger.warn({ requestId: c.get("requestId"), event: "session_invalid", ip: addr }, "session not valid");
      c.header("Set-Cookie", clearCookie(cookieNames().session));
      return problem(c, new ApiError(401, "unauthenticated", "Your session has ended or is not valid; sign in again"));
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const why = csrfRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site"), token: c.req.header("x-csrf-token") }, principal.session.id);
      if (why) {
        logger.warn({ requestId: c.get("requestId"), event: "csrf_refused", ip: addr }, "cross-site request refused");
        return problem(c, new ApiError(403, "csrf_failed", why));
      }
    }
    // The member's identity (`user:<tenant>:<member>`), shared by all their sessions: the rate limit, the
    // heavy-request gate and confirm tokens all key on it (core/context.ts `credential`).
    const ctx = principalCtx(principal, "web", c.get("requestId"));
    const bucket = credential(ctx);
    const wait = takeToken(bucket);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return problem(c, new ApiError(429, "rate_limited", "Too many requests; slow down"));
    }
    c.set("credential", { kind: "session", id: principal.session.id, bucket });
    c.set("ctx", ctx);
    await next();
    // A browser keeps what it may cache; nothing read with a session should be.
    c.header("Cache-Control", "no-store");
  }

  /**
   * An OAuth access token (ADR 0010). Accepted only from the MCP process, which proves itself with the
   * shared MCP_SERVICE_SECRET: anyone else presenting a token here, the app it was issued to included,
   * is refused, so a stolen MCP token can't reach the REST API directly. The surface comes from the
   * token's resource, not from the caller, and must agree with the endpoint the MCP process serves
   * (X-Hlcrm-Surface): an ops token on the admin endpoint, or the reverse, is invalid there.
   */
  async function oauthAuth(c: Context<Env>, next: () => Promise<void>, token: string) {
    const addr = clientAddress(c);
    const blocked = serviceBlockedFor(addr);
    if (blocked !== null) {
      logger.warn({ requestId: c.get("requestId"), event: "auth_rate_limited", ip: addr }, "OAuth token rate limited: too many wrong service secrets");
      c.header("Retry-After", String(blocked));
      return problem(c, new ApiError(429, "rate_limited", "Too many failed authentication attempts; wait and retry"));
    }
    const s = oauthSettings();
    const presented = c.req.header(SERVICE_HEADER) ?? "";
    if (!s || !safeEqual(Buffer.from(presented), Buffer.from(s.serviceSecret))) {
      recordServiceFailure(addr);
      logger.warn({ requestId: c.get("requestId"), event: "oauth_token_refused", ip: addr }, "OAuth token presented outside the MCP servers");
      c.header("WWW-Authenticate", 'Bearer realm="hl-crm-db"');
      return problem(c, new ApiError(401, "unauthenticated", "OAuth access tokens work only through the MCP servers; the REST API takes an API key (Authorization: Bearer hlcrm_…)"));
    }
    const principal = await resolveAccessToken(token);
    const surface = principal ? surfaceOf(principal.oauth.resource) : null;
    if (!principal || c.req.header("x-hlcrm-surface") !== surface) {
      logger.warn({ requestId: c.get("requestId"), event: "oauth_token_invalid" }, "OAuth access token not valid for this MCP endpoint");
      return problem(c, new ApiError(401, "invalid_token", "The access token is invalid, expired, revoked or issued for another MCP endpoint"));
    }
    // The credential is the grant (one approved connection), `oauth:<grant>` (core/context.ts `credential`):
    // its tokens share one rate-limit bucket, one heavy-request count, one idempotency namespace, one
    // identity for confirm tokens and one in the audit log (details.oauth_grant), across refreshes.
    const ctx = principalCtx(principal, surface!, c.get("requestId"));
    const bucket = credential(ctx);
    const wait = takeToken(bucket);
    if (wait !== null) {
      c.header("Retry-After", String(wait));
      return problem(c, new ApiError(429, "rate_limited", "Too many requests for this connection; slow down"));
    }
    c.set("credential", { kind: "oauth", id: principal.oauth.grantId, bucket });
    c.set("ctx", ctx);
    await next();
  }

  app.get("/v1/openapi.json", async (c) => {
    const ctx = c.get("ctx");
    if (!permits(ctx, "any")) throw forbidden("This key has no effective permissions");
    return c.json(await withTenant(ctx.tenantId, async (tx) => buildOpenApi(tx)));
  });

  for (const r of routes) mount(app, r);
  // The web UI (packages/web), when built and not turned off: after every API route, so it never shadows one.
  mountWebUi(app, webUi(), noRoute);
  return app;
}

function mount(app: Hono<Env>, r: (typeof routes)[number]) {
  const need = requiredPermission(r);
  // Fail closed at startup: a route nobody mapped to a permission must not be served.
  if (need === null) throw new Error(`Route ${r.method} ${r.path} has no permission: set \`permission\` on it`);
  app.on(r.method, r.path, async (c) => {
    const ctx = c.get("ctx");
    const credential = c.get("credential");
    if (r.credential === "session" && !ctx.session) throw forbidden("This is for a signed-in person (a browser session), not an API key or a connected app");
    if (!permits(ctx, need)) {
      const who = ctx.oauth ? "This connected app" : "This key";
      // A connected app is limited by the scopes it was approved with: say which one would allow this.
      const wanted: readonly Permission[] = need === "any" || need === "own_credential" ? [] : isList(need) ? need : [need];
      const scope = ctx.oauth ? ALL_SCOPES.find((sc) => !ctx.scopes.has(sc) && wanted.some((p) => SCOPE_PERMISSIONS[sc].includes(p))) : undefined;
      const hint = scope ? ` (it was connected without the "${scope}" scope; disconnect it and connect it again with that scope, if your role allows it)` : "";
      throw forbidden(need === "any" ? `${who} has no effective permissions`
        : isList(need) ? `This needs one of the permissions ${need.join(", ")}, which ${who.toLowerCase()} doesn't have${hint}`
        : need.startsWith("records:") ? `${who} lacks the "${need}" permission on every object${hint}` : `${who} lacks the "${need}" permission${hint}`);
    }
    // Surface conventions set by the MCP proxy. They only ever narrow what a key may do; since the
    // header is client-chosen they are not a security boundary (the permission check above is).
    if (ctx.surface === "ops-mcp" && r.scope === "admin") throw forbidden("Admin operations are not available on the ops surface");
    if (ctx.surface === "admin-mcp" && !ctx.scopes.has("admin")) throw forbidden("The admin surface requires a key with the admin scope");

    let body: unknown = undefined;
    if (r.body) {
      const text = await c.req.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new ApiError(400, "invalid_json", "Request body is not valid JSON");
      }
      if (jsonDepthExceeds(json, 64)) throw new ApiError(422, "validation_failed", "The request body is nested too deeply (at most 64 levels)");
      if (containsNul(json)) throw new ApiError(422, "validation_failed", NUL_REFUSED);
      body = r.body.parse(json);
    }
    // A file upload: the bytes as sent (the body limit above has bounded them).
    const raw = r.rawBody ? Buffer.from(await c.req.arrayBuffer()) : undefined;
    const rawQuery = c.req.query();
    if (containsNul(rawQuery) || containsNul(c.req.param())) throw new ApiError(422, "validation_failed", NUL_REFUSED);
    const query = r.query ? r.query.parse(rawQuery) : rawQuery;
    const idemKey = c.req.header("idempotency-key");
    if (idemKey !== undefined && !/^[\w.:-]{1,255}$/.test(idemKey)) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key must be 1 to 255 characters of letters, digits, _ . : -");

    // One identity pays for everything: `credential.bucket` is `credential(ctx)` (core/context.ts), the
    // API key or the signed-in member (all their sessions together). The request's token, its `cost`,
    // the heavy-request gate and any work charged afterwards (`charge`) all go to it; confirm tokens bind to it too.
    const who = credential.bucket;
    const isHeavy = typeof r.heavy === "function" ? r.heavy(body as never, query as never) : r.heavy === true;
    const leave = isHeavy ? enterHeavy(who, appsOfMember(ctx)) : () => {};
    if (!leave) {
      c.header("Retry-After", "1");
      throw new ApiError(429, "too_many_heavy_requests", `Too many long-running requests at once (at most ${HEAVY_LIMITS.perCredential} per key, signed-in person `
        + `or connected app, ${HEAVY_LIMITS.perMemberApps} across one person's connected apps, and few on the server); wait for one to finish, then retry`);
    }
    try {
      const cost = r.cost ? Math.min(200, Math.ceil(r.cost(body as never, query as never))) - 1 : 0;
      if (cost > 0) {
        const wait = takeToken(who, cost);
        if (wait !== null) {
          c.header("Retry-After", String(wait));
          throw new ApiError(429, "rate_limited", "Too many requests for this key; slow down (this request counts as several)");
        }
      }
      return await serve(c, r, ctx, credential, body, query, idemKey, raw);
    } finally {
      leave();
    }
  });
}

/**
 * Runs the handler in the tenant's transaction, with idempotent replay. Idempotency records belong to
 * the credential that sent the request: a key, one browser session (a new sign-in starts afresh), or
 * one connected app (its grant, across token refreshes).
 * Work charged afterwards (`charge`) goes to the credential's bucket.
 */
async function serve(c: Context<Env>, r: (typeof routes)[number], ctx: Ctx, credential: Env["Variables"]["credential"], body: unknown, query: unknown, idemKey: string | undefined,
  raw?: Buffer) {
  const charge = (tokens: number) => { if (tokens > 0) takeToken(credential.bucket, Math.ceil(tokens), true); };
  const args = { ctx, params: c.req.param() as Record<string, string>, body: body as never, raw, query: query as never, headers: c.req.raw.headers, charge };
  const prepared = r.prepare ? await r.prepare(args as never) : undefined;
  const credId = credential.id;
  const result = await withTenant(ctx.tenantId, async (tx) => {
    const useIdem = isWrite(r.method) && idemKey;
    // An upload's fingerprint is its bytes and its query (the file's name), so a retry replays and a different file is refused.
    const bodyHash = sha256(canonicalJson({ method: r.method, path: c.req.path, body: body ?? null,
      ...(raw ? { raw: sha256(raw).toString("hex"), query: query ?? null } : {}) }));
    if (useIdem) {
      const claimed = await claimIdempotencyKey(tx, { tenantId: ctx.tenantId, credentialId: credId, credential: credential.kind, key: idemKey, method: r.method,
        path: c.req.path, bodyHash });
      if (!claimed) {
        const prior = await priorIdempotentRequest(tx, credId, idemKey);
        if (!prior || !prior.body_hash.equals(bodyHash)) {
          throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was used with a different request");
        }
        const stored = await openStoredResponse(tx, ctx, credId, idemKey, prior.response);
        return { status: prior.status, body: stored.body, replayed: true, headers: stored.headers, after: undefined };
      }
    }
    const out = await r.handler({ tx, ...args, prepared } as never);
    const status = out.status ?? 200;
    if (useIdem) {
      await storeIdempotentResponse(tx, credId, idemKey, status, await sealStoredResponse(tx, ctx, credId, idemKey, out.body ?? null, out.headers));
    }
    return { status, body: out.body, replayed: false, headers: out.headers, after: out.after };
  });
  if (result.after) await result.after().catch((e: Error) => logger.error({ requestId: ctx.requestId, err: e.message }, "after-commit work failed"));
  if (result.replayed) c.header("Idempotent-Replayed", "true");
  for (const [k, v] of Object.entries(result.headers ?? {})) c.header(k, v);
  // A text body (a CSV export) is sent as is; the handler sets its Content-Type.
  if (typeof result.body === "string") return c.body(result.body, result.status as 200);
  // Bytes (a file download) likewise.
  if (result.body instanceof Uint8Array) return c.body(new Uint8Array(result.body), result.status as 200);
  return c.json(result.body as object, result.status as 200);
}
