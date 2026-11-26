import { newIdempotencyKey } from "@hl-crm-db/sdk";
import { ApiProblem, asProblem, problemFromResponse } from "./problem";

/**
 * The one way the app talks to the API. Every request goes through `request`, which:
 * - sends the browser session cookie (same origin) and never an Authorization header;
 * - on writes (anything but GET), adds the session's CSRF token and an Idempotency-Key, so a retried
 *   write is replayed by the server rather than repeated;
 * - sends If-Match when a record version is given (a stale write answers 412);
 * - runs at most two "heavy" requests (counts, aggregates, bulk) at a time, the server's per-member limit;
 * - waits out a 429's Retry-After (up to 10 s) and retries with the same idempotency key: once, or up
 *   to five times for too_many_heavy_requests;
 * - after a 403 csrf_failed, fetches a fresh token once and retries;
 * - after a 403 recent_sign_in_required (creating a key, changing a password…), asks the app to have the
 *   person confirm it's them (onRecentSignInRequired) and, when they did, retries once with the new
 *   session's token; otherwise the problem is thrown as usual (its UI offers "Confirm it's you");
 * - calls to the sign-in endpoints (/auth/…) carry neither, since they need no session;
 * - on 401, tells the app (which offers to sign in again) and fails;
 * - turns every failure into an ApiProblem (RFC 9457 detail, request ID, field messages).
 *
 * The CSRF token lives only in this object's memory: never in storage or a URL.
 */

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** The record version read; sent as If-Match: "v<version>". */
  ifMatch?: number;
  /** Reuse a key to make a repeated action safe; one is made for every write otherwise. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** A file's bytes, sent as the body in place of JSON (see `upload`). */
  raw?: Blob;
}

export interface ClientHooks {
  /** Called on any 401: the session ended or was revoked. */
  onUnauthenticated?: (problem: ApiProblem) => void;
  /**
   * Called on a 403 recent_sign_in_required: resolves true once the person signed in again (the new
   * session's CSRF token is then set on this client), false when they didn't. Concurrent requests share one call.
   */
  onRecentSignInRequired?: (problem: ApiProblem) => Promise<boolean>;
  fetch?: typeof fetch;
  /** Longest Retry-After to wait out automatically, in seconds. */
  maxAutoWait?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_PATH = 4096;

/** Builds a same-origin API URL; refuses anything that isn't a plain absolute path under /v1 or /auth. */
export function apiUrl(path: string, query?: Query): string {
  // The API's own paths only.
  if (!/^\/(v1|auth)(\/|$)/.test(path) || path.length > MAX_PATH || /[?#\\]/.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`Refusing to call ${path}: not an API path`);
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/** Encodes one path segment (an ID or object name) for use in apiUrl. */
export const seg = (s: string) => encodeURIComponent(s);

/**
 * Requests the server counts as heavy (aggregates, counted lists and queries, bulk changes, merges,
 * exports, imports). A member may have only two in flight across all their tabs, so this client runs
 * at most two at a time and queues the rest.
 */
export function isHeavy(method: Method, path: string, opts: RequestOptions): boolean {
  const body = opts.body as { count?: boolean; dry_run?: boolean } | undefined;
  if (path === "/v1/aggregate" || path === "/v1/ops/merge_records" || /^\/v1\/objects\/[^/]+\/(records\/bulk_update|records\/bulk_archive|export|import|duplicates)$/.test(path)) return true;
  // Schema and pack plans and applies, automation tests: rare from the app, but the server counts them (packages/server test/web-ui.test.ts keeps this list in step).
  if (method === "POST" && /^\/v1\/(schema\/(plan|apply)|packs\/(plan|apply|[^/]+\/uninstall)|automations\/(test|[^/]+\/test))$/.test(path)) return true;
  if (method === "POST" && (/^\/v1\/automations\/[^/]+\/run$/.test(path) || /\/records\/batch$/.test(path))) return body?.dry_run === true;
  // Files: an upload and a download hold a connection while the bytes move.
  if ((method === "POST" && /^\/v1\/records\/[^/]+\/files$/.test(path)) || (method === "GET" && /^\/v1\/files\/[^/]+\/content$/.test(path))) return true;
  if (method === "POST" && path === "/v1/query") return Boolean(body?.count);
  return method === "GET" && String(opts.query?.count) === "true";
}

const HEAVY_SLOTS = 2;

export class ApiClient {
  private csrf: string | null = null;
  private heavyRunning = 0;
  private heavyWaiting: (() => void)[] = [];
  private refreshing: Promise<string | null> | null = null;
  private confirming: Promise<boolean> | null = null;

  constructor(private readonly hooks: ClientHooks = {}) {}

  setCsrfToken(token: string | null): void {
    this.csrf = token;
  }

  hasCsrfToken(): boolean {
    return this.csrf !== null;
  }

  get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, { query, signal });
  }
  post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("POST", path, { ...opts, body: body ?? {} });
  }
  patch<T>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PATCH", path, { ...opts, body });
  }
  put<T>(path: string, body: unknown, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("PUT", path, { ...opts, body });
  }
  delete<T>(path: string, opts: Omit<RequestOptions, "body"> = {}): Promise<T> {
    return this.request<T>("DELETE", path, opts);
  }
  /** Sends a file's bytes as the request body (a route that takes an upload), with the same CSRF, idempotency and retries as any write. */
  upload<T>(path: string, file: Blob, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { query, raw: file });
  }

  async request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
    if (!isHeavy(method, path, opts)) return this.send<T>(method, path, opts);
    if (this.heavyRunning >= HEAVY_SLOTS) await new Promise<void>((r) => this.heavyWaiting.push(r));
    this.heavyRunning++;
    try {
      return await this.send<T>(method, path, opts);
    } finally {
      this.heavyRunning--;
      this.heavyWaiting.shift()?.();
    }
  }

  private async send<T>(method: Method, path: string, opts: RequestOptions): Promise<T> {
    const url = apiUrl(path, opts.query);
    // The sign-in endpoints (/auth/…) take no session: no CSRF token, and a 401 there is a wrong password, not a lost session.
    const signIn = path.startsWith("/auth/");
    const write = method !== "GET" && !signIn;
    const idem = write ? opts.idempotencyKey ?? newIdempotencyKey() : undefined;
    let csrfRetried = false;
    let reauthed = false;
    let waited = 0;
    for (;;) {
      if (write && !this.csrf) await this.refreshCsrf();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (opts.raw !== undefined) headers["Content-Type"] = "application/octet-stream";
      else if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (write) {
        if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
        headers["Idempotency-Key"] = idem!;
      }
      if (opts.ifMatch !== undefined) headers["If-Match"] = `"v${opts.ifMatch}"`;
      let res: Response;
      try {
        res = await (this.hooks.fetch ?? fetch)(url, {
          method,
          headers,
          body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: opts.signal,
        });
      } catch (e) {
        throw asProblem(e);
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const problem = await problemFromResponse(res);
      if (problem.status === 401 && !signIn) {
        this.csrf = null;
        this.hooks.onUnauthenticated?.(problem);
        throw problem;
      }
      if (problem.status === 403 && problem.code === "csrf_failed" && !csrfRetried) {
        csrfRetried = true;
        this.csrf = null;
        continue;
      }
      if (problem.status === 403 && problem.code === "recent_sign_in_required" && !reauthed && this.hooks.onRecentSignInRequired) {
        reauthed = true;
        if (await this.confirmIdentity(problem)) continue;
      }
      // Too many heavy requests at once (other tabs) is short-lived: retried a few times; other 429s once.
      const heavyBusy = problem.code === "too_many_heavy_requests";
      if (problem.status === 429 && waited < (heavyBusy ? 5 : 1)) {
        const wait = problem.retryAfter ?? 1;
        if (wait <= (this.hooks.maxAutoWait ?? 10)) {
          waited++;
          await (this.hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait * 1000);
          continue;
        }
      }
      throw problem;
    }
  }

  /** Has the person confirm it's them (once, however many requests are waiting for it). */
  private confirmIdentity(problem: ApiProblem): Promise<boolean> {
    this.confirming ??= this.hooks.onRecentSignInRequired!(problem).catch(() => false).finally(() => {
      this.confirming = null;
    });
    return this.confirming;
  }

  /** Fetches the session's CSRF token (once, however many writes are waiting for it). */
  async refreshCsrf(): Promise<string | null> {
    this.refreshing ??= (async () => {
      try {
        const s = await this.get<{ csrf_token: string }>("/v1/auth/session");
        this.csrf = s.csrf_token;
        return this.csrf;
      } catch {
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

export { ApiProblem };
