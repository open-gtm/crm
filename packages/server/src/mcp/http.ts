import { createHash } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { HlCrmClient, HlCrmError } from "@hl-crm-db/sdk";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "../lib/logger.js";
import { addressKey } from "../lib/outbound.js";
import { protectedResourceMetadata, resourceMetadataUrl } from "../oauth/metadata.js";
import { DEFAULT_SCOPES, REQUIRED_SCOPES, RESOURCES, SERVICE_HEADER, isAccessToken, looksLikeApiKey, satisfies, type ResourceName } from "../oauth/scopes.js";
import { SERVER_INFO, buildAdminServer, buildOpsServer } from "./tools.js";

export interface McpOAuth { issuer: string; mcpOrigin: string; resources: Record<ResourceName, string>; serviceSecret: string }

export interface McpAppOptions {
  apiUrl: string;
  /** Browser origins allowed to call the MCP endpoints. Requests without an Origin header (CLI clients) are allowed. */
  allowedOrigins?: string[];
  fetch?: typeof fetch;
  /** OAuth for MCP (ADR 0010), from config.ts oauthSettings(); absent or null: API keys only, as before. */
  oauth?: McpOAuth | null;
}

/** MCP 2026-07-28: stateless, no initialize; every request carries its version in the header and in `_meta`. */
export const MODERN_VERSION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const SUPPORTED = [MODERN_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];
/** Methods 2026-07-28 removed or that these servers don't offer (no change notifications): unknown in the modern era. */
const NOT_MODERN = new Set(["initialize", "ping", "logging/setLevel", "subscriptions/listen", "resources/subscribe", "resources/unsubscribe"]);
const NAMED = new Map([["tools/call", "name"], ["prompts/get", "name"], ["resources/read", "uri"]]);

/**
 * Failed OAuth bearer values per client address, before the API is asked: 30 a minute. The API trusts
 * this process (it holds MCP_SERVICE_SECRET), so the flood protection for OAuth tokens sits here. Many
 * clients can share an address (a proxy without TRUST_PROXY), so a token that worked in the last five
 * minutes still gets through from a blocked address (until the API refuses it once); the API validates it every time regardless.
 * API keys aren't counted here: the API's own limiter handles them, as before.
 */
const failures = new Map<string, { count: number; resetAt: number }>();
const knownGood = new Map<string, number>();
const tokenKey = (t: string) => createHash("sha256").update(t).digest("base64url");
const FAILURES_PER_MINUTE = 30;
function blockedFor(addr: string): number | null {
  const f = failures.get(addr);
  return f && f.resetAt > Date.now() && f.count >= FAILURES_PER_MINUTE ? Math.ceil((f.resetAt - Date.now()) / 1000) : null;
}
function recordFailure(addr: string): void {
  const now = Date.now();
  const f = failures.get(addr);
  failures.delete(addr);
  failures.set(addr, f && f.resetAt > now ? { count: f.count + 1, resetAt: f.resetAt } : { count: 1, resetAt: now + 60_000 });
  for (const k of failures.keys()) {
    if (failures.size <= 50_000) break;
    failures.delete(k);
  }
}
function markGood(token: string): void {
  const k = tokenKey(token);
  knownGood.delete(k);
  knownGood.set(k, Date.now() + 5 * 60_000);
  for (const old of knownGood.keys()) {
    if (knownGood.size <= 50_000) break;
    knownGood.delete(old);
  }
}
const isKnownGood = (token: string) => (knownGood.get(tokenKey(token)) ?? 0) > Date.now();
/** For tests. */
export function resetMcpLimiter(): void {
  failures.clear();
  knownGood.clear();
}

function clientAddress(c: Context): string {
  if (["true", "1"].includes((process.env.TRUST_PROXY ?? "").trim().toLowerCase())) {
    const xff = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
    if (xff?.length) return xff[xff.length - 1]!;
  }
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
}

const rpcError = (c: Context, status: number, code: number, message: string, id: unknown = null, data?: unknown) =>
  c.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }, status as 400);

/** A header value under the 2026-07-28 encoding: plain, or `=?base64?…?=`. */
function headerValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : raw;
}

/**
 * Hosted MCP endpoints over Streamable HTTP, stateless. Each request authenticates with either:
 *   - an hl-crm-db API key, passed to the API on that caller's behalf, as before; or
 *   - an OAuth access token issued for this endpoint (ADR 0010). It is sent to the API only together
 *     with MCP_SERVICE_SECRET, which the API requires before it accepts any such token; the API checks
 *     the token's audience against the endpoint (X-Hlcrm-Surface) and enforces every rule.
 * Both MCP revisions are served: 2025-11-25 and earlier (initialize, then requests) through the SDK, and
 * 2026-07-28 (per-request metadata, server/discover) by adapting each request to the SDK and back.
 */
export function buildMcpApp(opts: McpAppOptions): Hono {
  const app = new Hono();
  app.use("*", secureHeaders());
  // The same 1 MB limit as the API: the body is parsed here before the API sees any of it.
  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ jsonrpc: "2.0", error: { code: -32600, message: "Request body is larger than 1 MB" }, id: null }, 413) }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  const oauth = opts.oauth ?? null;

  for (const surface of RESOURCES) {
    app.get(`/.well-known/oauth-protected-resource/mcp/${surface}`, (c) => {
      c.header("Access-Control-Allow-Origin", "*");
      if (!oauth) return c.json({ error: "not_found", error_description: "OAuth is not turned on for this server" }, 404);
      return c.json(protectedResourceMetadata(oauth.resources[surface], oauth.issuer, surface));
    });
  }

  for (const surface of RESOURCES) {
    /** The challenge on a 401 (and, with error="insufficient_scope", a 403): where to find out how to get a token, and which scopes to ask for. */
    const challenge = (params: Record<string, string> = {}) => {
      if (!oauth) return 'Bearer realm="hl-crm-db"';
      const all = { ...params, resource_metadata: resourceMetadataUrl(oauth.mcpOrigin, surface), scope: params.scope ?? DEFAULT_SCOPES[surface].join(" ") };
      return `Bearer ${Object.entries(all).map(([k, v]) => `${k}="${v.replace(/["\\]/g, "")}"`).join(", ")}`;
    };
    const unauthorized = (c: Context, message: string, invalid: boolean) => {
      c.header("WWW-Authenticate", challenge(invalid ? { error: "invalid_token" } : {}));
      return rpcError(c, 401, -32001, message);
    };

    app.all(`/mcp/${surface}`, async (c) => {
      const origin = c.req.header("origin");
      if (origin && !(opts.allowedOrigins ?? []).includes(origin)) {
        return c.json({ error: "origin not allowed" }, 403);
      }
      if (c.req.method !== "POST") {
        return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless; use POST" }, id: null }, 405);
      }
      const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
      if (!m) {
        return unauthorized(c, oauth ? "Sign in: connect this server with OAuth, or send an hl-crm-db API key (Authorization: Bearer hlcrm_…)"
          : "Send an hl-crm-db API key: Authorization: Bearer hlcrm_…", false);
      }
      const addr = addressKey(clientAddress(c));
      const bearer = m[1]!;
      const isKey = looksLikeApiKey(bearer);
      const blocked = isKey || isKnownGood(bearer) ? null : blockedFor(addr);
      if (blocked !== null) {
        c.header("Retry-After", String(blocked));
        return rpcError(c, 429, -32001, "Too many failed authentication attempts; wait and retry");
      }
      if (!isKey && !(oauth && isAccessToken(bearer))) {
        recordFailure(addr);
        return unauthorized(c, oauth ? "The access token is not valid here" : "Invalid or expired API key", true);
      }
      const base = opts.fetch ?? fetch;
      // The service secret goes only with an OAuth token, and only to the API (apiUrl is operator configuration, never caller input).
      const viaService: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set(SERVICE_HEADER, oauth!.serviceSecret);
        return base(input, { ...init, headers });
      };
      // apiUrl is operator configuration (in Compose, http://api:8787 on the private network), never caller input.
      const client = new HlCrmClient({ baseUrl: opts.apiUrl, apiKey: bearer, surface: `${surface}-mcp`, fetch: isKey ? opts.fetch : viaService, allowInsecureHttp: true });
      try {
        const me = await client.get<{ scopes: string[] }>("/v1/me");
        if (!isKey && !satisfies(surface, me.scopes)) {
          c.header("WWW-Authenticate", challenge({ error: "insufficient_scope", scope: REQUIRED_SCOPES[surface].join(" ") }));
          return rpcError(c, 403, -32003, `This connection lacks the ${REQUIRED_SCOPES[surface].join(" or ")} scope (or the member's role no longer allows it)`);
        }
        if (!isKey) markGood(bearer);
        if (surface === "admin" && !me.scopes.includes("admin")) {
          return c.json({ jsonrpc: "2.0", error: { code: -32003, message: "The admin MCP server needs a key with the admin scope" }, id: null }, 403);
        }
        if (surface === "ops" && !me.scopes.some((s) => s.startsWith("ops:"))) {
          return c.json({ jsonrpc: "2.0", error: { code: -32003, message: "The ops MCP server needs a key with ops:read or ops:write" }, id: null }, 403);
        }
      } catch (e) {
        const status = e instanceof HlCrmError ? e.status : 502;
        if (status === 401) {
          // Revoked or expired since it last worked: it loses its pass past the limiter at once, not after five minutes.
          if (!isKey) {
            knownGood.delete(tokenKey(bearer));
            recordFailure(addr);
          }
          return unauthorized(c, isKey ? "Invalid or expired API key" : "The access token is invalid, expired, revoked or not for this endpoint", true);
        }
        if (status === 429) {
          // The caller's rate limit (or the API's limiter): temporary, so say when to come back rather than calling the API unavailable.
          const wait = (e as HlCrmError).retryAfter ?? 1;
          c.header("Retry-After", String(wait));
          return rpcError(c, 429, -32005, `Rate limited: ${(e as HlCrmError).message}. Retry after ${wait} second${wait === 1 ? "" : "s"}`, null, { retry_after_seconds: wait });
        }
        if (!isKey && status === 403) {
          c.header("WWW-Authenticate", challenge({ error: "insufficient_scope", scope: REQUIRED_SCOPES[surface].join(" ") }));
          return rpcError(c, 403, -32003, "This connection can't do anything here (the member's role allows nothing it was granted)");
        }
        if (isKey && status === 403) {
          // A key the API refuses on this surface (an ops key on /mcp/admin): say so, rather than "unavailable".
          return rpcError(c, 403, -32003, `${(e as HlCrmError).message}. Use the key made for this endpoint: the admin key for /mcp/admin, the ops key for /mcp/ops`);
        }
        logger.error({ err: (e as Error).message }, "mcp: api unreachable");
        return c.json({ jsonrpc: "2.0", error: { code: -32002, message: "The CRM API is unavailable" }, id: null }, 502);
      }
      const text = await c.req.text();
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        msg = undefined;
      }
      const run = async (headers: Headers, body: string) => {
        const server = surface === "ops" ? buildOpsServer(client) : buildAdminServer(client);
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        await server.connect(transport);
        return transport.handleRequest(new Request(c.req.raw.url, { method: "POST", headers, body }));
      };
      const rec = msg && typeof msg === "object" && !Array.isArray(msg) ? msg as { id?: unknown; method?: unknown; params?: Record<string, unknown> } : null;
      const metaVersion = (rec?.params?._meta as Record<string, unknown> | undefined)?.[META_VERSION];
      const headerVersion = c.req.header("mcp-protocol-version");
      if (headerVersion !== MODERN_VERSION && metaVersion === undefined) return run(new Headers(c.req.raw.headers), text);
      return modern(c, surface, rec, headerVersion, metaVersion, text, run);
    });
  }
  return app;
}

/**
 * One request in the 2026-07-28 era: the mirrored headers must match the body, server/discover is
 * answered here, and anything else runs through the SDK as a 2025-11-25 request whose result gets the
 * fields 2026-07-28 adds (resultType, serverInfo in _meta, cache hints on lists).
 */
async function modern(c: Context, surface: ResourceName, rec: { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null,
  headerVersion: string | undefined, metaVersion: unknown, text: string, run: (h: Headers, body: string) => Promise<Response>): Promise<Response> {
  if (!rec || typeof rec.method !== "string") return rpcError(c, 400, -32600, "The body must be one JSON-RPC request or notification");
  const id = rec.id;
  if (metaVersion === undefined || headerVersion === undefined || headerVersion !== metaVersion) {
    return rpcError(c, 400, -32020, "Header mismatch: MCP-Protocol-Version must be sent and equal _meta io.modelcontextprotocol/protocolVersion", id);
  }
  if (metaVersion !== MODERN_VERSION) return rpcError(c, 400, -32022, "Unsupported protocol version", id, { supported: SUPPORTED, requested: metaVersion });
  if (headerValue(c.req.header("mcp-method")) !== rec.method) return rpcError(c, 400, -32020, "Header mismatch: Mcp-Method must equal the body's method", id);
  const nameField = NAMED.get(rec.method);
  if (nameField && headerValue(c.req.header("mcp-name")) !== rec.params?.[nameField]) {
    return rpcError(c, 400, -32020, `Header mismatch: Mcp-Name must equal the body's params.${nameField}`, id);
  }
  if (id === undefined) return c.body(null, 202);
  if (NOT_MODERN.has(rec.method)) return rpcError(c, 404, -32601, `Method not found: ${rec.method}`, id);
  const headers = new Headers(c.req.raw.headers);
  headers.set("mcp-protocol-version", "2025-11-25");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  const info = SERVER_INFO[surface];
  if (rec.method === "server/discover") {
    // The SDK knows the capabilities and instructions; ask it the legacy way.
    const init = await run(headers, JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "discover", version: "0" } } }));
    const r = (await init.json() as { result?: { capabilities?: Record<string, unknown>; instructions?: string } }).result ?? {};
    return c.json({ jsonrpc: "2.0", id, result: { resultType: "complete", supportedVersions: SUPPORTED, capabilities: { tools: {} },
      ...(r.instructions ? { instructions: r.instructions } : {}), _meta: { "io.modelcontextprotocol/serverInfo": info }, ttlMs: 300_000, cacheScope: "private" } });
  }
  const res = await run(headers, text);
  if (res.status === 202 || !(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const out = await res.json() as { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number } };
  if (out.error) return c.json(out, (out.error.code === -32601 ? 404 : res.status) as 200);
  const result = { ...out.result, resultType: "complete", _meta: { ...(out.result?._meta as object | undefined), "io.modelcontextprotocol/serverInfo": info },
    // Tool lists change only with a new server version; each member's access can differ, so no shared cache.
    ...(rec.method.endsWith("/list") ? { ttlMs: 300_000, cacheScope: "private" } : {}) };
  return c.json({ ...out, result }, res.status as 200);
}
