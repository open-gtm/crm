import type { Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { BlockedTargetError, checkUrl, safeRequest } from "../lib/outbound.js";
import { audit } from "./audit.js";
import { allSteps, headerAllowed, isHeaderName, type Step } from "./automation-defs.js";
import type { Ctx } from "./context.js";
import { decryptValue, encryptValue } from "./encryption.js";
import {
  archiveConnectionRow, automationsNamingConnections, cacheAccessToken, connectionById, countLiveConnections, insertConnection, liveConnectionByKey,
  liveConnections, setConnectionError, setConnectionRefreshToken, setConnectionSecret, touchConnectionUsed, updateConnectionSettings,
  type ConnectionRow, type ConnectionSettings, type ConnectionType,
} from "./queries/connections.js";
import { policy } from "./webhooks.js";

/**
 * Connections (ADR 0016): a named credential for one outside host. An automation's http_request step
 * names one by key; the request then goes to the connection's base URL plus the step's path, with the
 * credential in one header. The OAuth types fetch an access token from the token URL when they have none
 * or theirs is about to expire. Nothing here knows about any vendor.
 */

export const MAX_CONNECTIONS = 25;
const TOKEN_MAX_BYTES = 64 * 1024;
const TOKEN_DEADLINE_MS = 10_000;
/** A cached access token is used until this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;
/** After a forced refresh, another one within this time reuses its token: two runs that both got a 401 fetch once. */
const FORCE_REUSE_MS = 10_000;
const MAX_CACHE_MS = 24 * 3600 * 1000;
/** Form parameters the server sets itself in a token request. */
const RESERVED_PARAMS = new Set(["grant_type", "client_id", "client_secret", "refresh_token", "scope"]);

const hasControl = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const isOAuth = (t: ConnectionType) => t !== "static_token";
const sealed = (column: "secret" | "refresh_token" | "access_token") => `connection_${column}`;

/** A connection can't give a credential: it is off, archived, incomplete, or its token request failed. Safe to show. */
export class ConnectionError extends Error {}

function publicConnection(c: ConnectionRow) {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: encodeId("conn", c.id), key: c.key, name: c.name, description: c.description, type: c.type, base_url: c.base_url,
    header_name: c.header_name, header_prefix: c.header_prefix, token_url: c.token_url, client_id: c.client_id, scope: c.scope,
    token_params: c.token_params, token_lifetime_minutes: c.token_lifetime_minutes, test_path: c.test_path,
    enabled: c.enabled && !c.archived_at,
    status: c.archived_at ? "archived" : !c.enabled ? "disabled" : c.last_error ? "failing" : "active",
    // Secrets are write-only: only whether each is set, and when.
    has_secret: c.secret !== null, secret_set_at: iso(c.secret_set_at),
    has_refresh_token: c.refresh_token !== null, refresh_token_set_at: iso(c.refresh_token_set_at),
    token_expires_at: iso(c.access_token && c.access_token_expires_at && c.access_token_expires_at.getTime() > Date.now() ? c.access_token_expires_at : null),
    last_used_at: iso(c.last_used_at), last_error: c.last_error, last_error_at: iso(c.last_error_at),
    created_at: c.created_at.toISOString(), updated_at: c.updated_at.toISOString(),
  };
}

function parseConnectionId(publicId: string): string {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "conn") throw notFound(`Connection ${publicId}`);
  return d.uuid;
}

async function loadConnection(tx: Tx, publicId: string, forUpdate = false): Promise<ConnectionRow> {
  const c = await connectionById(tx, parseConnectionId(publicId), forUpdate);
  if (!c) throw notFound(`Connection ${publicId}`);
  return c;
}

// ----------------------------------------------------------------------------------------------
// Validation

function checkedUrl(raw: string, field: "base_url" | "token_url"): URL {
  if (raw.includes("{{")) throw unprocessable(`${field} can't hold placeholders`, { field });
  try {
    const url = checkUrl(raw, policy());
    if (url.hash) throw unprocessable(`${field} can't have a #fragment`, { field });
    return url;
  } catch (e) {
    if (e instanceof BlockedTargetError) throw unprocessable(e.message.replace(/^Webhook URL/, field), { field });
    throw e;
  }
}

/** The origin and an optional path prefix, with no trailing slash, query or fragment. */
function baseUrl(raw: string): string {
  const url = checkedUrl(raw, "base_url");
  if (url.search) throw unprocessable("base_url can't have a query string", { field: "base_url" });
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** A path under a connection's base URL: one leading slash, no `.` or `..` segment (also written %2e), no fragment or backslash. */
export function checkConnectionPath(path: string, what: string): void {
  if (!/^\/(?!\/)/.test(path)) throw unprocessable(`${what} must be a path starting with one "/" (the connection gives the host)`);
  if (path.includes("#") || path.includes("\\")) throw unprocessable(`${what} can't hold "#" or "\\"`);
  const segments = path.split("?")[0]!.split("/").map((s) => s.replace(/%2e/gi, "."));
  if (segments.some((s) => s === "." || s === "..")) throw unprocessable(`${what} can't hold a "." or ".." segment`);
}

export interface ConnectionInput {
  key: string; name: string; description?: string | null; type: ConnectionType; base_url: string;
  header_name?: string; header_prefix?: string; token_url?: string | null; client_id?: string | null; scope?: string | null;
  token_params?: Record<string, string>; token_lifetime_minutes?: number; test_path?: string | null; enabled?: boolean;
  secret?: string | null; refresh_token?: string | null;
}
export type ConnectionPatch = Partial<Omit<ConnectionInput, "key" | "type">>;

function checkSecret(value: string, field: string): string {
  if (!value.trim()) throw unprocessable(`${field} is empty`, { field });
  if (hasControl(value)) throw unprocessable(`${field} holds a line break or control character`, { field });
  return value;
}

/** The settings as they will be stored, checked against the connection's type. */
function settingsFor(type: ConnectionType, s: Omit<ConnectionInput, "key" | "type" | "secret" | "refresh_token">): ConnectionSettings {
  const headerName = s.header_name ?? "Authorization";
  if (!isHeaderName(headerName) || !headerAllowed(headerName)) throw unprocessable(`Header "${headerName}" is not allowed`, { field: "header_name" });
  const headerPrefix = s.header_prefix ?? "Bearer ";
  if (hasControl(headerPrefix)) throw unprocessable("header_prefix holds a line break or control character", { field: "header_prefix" });
  const tokenParams = s.token_params ?? {};
  const names = Object.keys(tokenParams);
  if (names.length > 10) throw unprocessable("At most 10 token_params", { field: "token_params" });
  for (const k of names) {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(k)) throw unprocessable(`token_params: "${k}" is not a usable parameter name`, { field: "token_params" });
    if (RESERVED_PARAMS.has(k.toLowerCase())) throw unprocessable(`token_params: ${k} is set by the connection itself`, { field: "token_params" });
    if (hasControl(tokenParams[k]!)) throw unprocessable(`token_params: ${k} holds a control character`, { field: "token_params" });
  }
  if (s.test_path) checkConnectionPath(s.test_path, "test_path");
  let tokenUrl: string | null = null;
  if (isOAuth(type)) {
    if (!s.token_url) throw unprocessable(`A ${type} connection needs a token_url`, { field: "token_url" });
    if (!s.client_id) throw unprocessable(`A ${type} connection needs a client_id`, { field: "client_id" });
    tokenUrl = checkedUrl(s.token_url, "token_url").toString();
  } else if (s.token_url || s.client_id || s.scope || names.length) {
    throw unprocessable("A static_token connection has no token_url, client_id, scope or token_params");
  }
  return {
    name: s.name, description: s.description ?? null, baseUrl: baseUrl(s.base_url), headerName, headerPrefix, tokenUrl,
    clientId: isOAuth(type) ? s.client_id! : null, scope: isOAuth(type) ? s.scope || null : null, tokenParams,
    tokenLifetimeMinutes: s.token_lifetime_minutes ?? 30, testPath: s.test_path || null, enabled: s.enabled ?? true,
  };
}

// ----------------------------------------------------------------------------------------------
// Managing connections

export async function createConnection(tx: Tx, ctx: Ctx, input: ConnectionInput) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(input.key)) throw unprocessable("key must be lowercase letters, digits and underscores, starting with a letter (at most 40)", { field: "key" });
  const settings = settingsFor(input.type, input);
  if (!input.secret) throw unprocessable(input.type === "static_token" ? "A static_token connection needs its token as secret" : "The client secret is needed as secret", { field: "secret" });
  const secret = checkSecret(input.secret, "secret");
  const refreshToken = input.type === "oauth_refresh_token" ? input.refresh_token : null;
  if (input.type === "oauth_refresh_token" && !refreshToken) throw unprocessable("An oauth_refresh_token connection needs a refresh_token", { field: "refresh_token" });
  if (input.type !== "oauth_refresh_token" && input.refresh_token) throw unprocessable(`A ${input.type} connection has no refresh_token`, { field: "refresh_token" });
  if ((await countLiveConnections(tx)) >= MAX_CONNECTIONS) throw conflict(`A workspace can have at most ${MAX_CONNECTIONS} connections`);
  if (await liveConnectionByKey(tx, input.key)) throw conflict(`A connection with the key "${input.key}" already exists`);
  const id = uuidv7();
  await insertConnection(tx, { ...settings, tenantId: ctx.tenantId, id, key: input.key, type: input.type,
    secret: await encryptValue(tx, ctx.tenantId, id, sealed("secret"), secret),
    refreshToken: refreshToken ? await encryptValue(tx, ctx.tenantId, id, sealed("refresh_token"), checkSecret(refreshToken, "refresh_token")) : null,
    createdBy: ctx.actor.id });
  await audit(tx, ctx, { action: "connection.created", details: { connection: encodeId("conn", id), key: input.key, type: input.type,
    host: new URL(settings.baseUrl).host, token_host: settings.tokenUrl ? new URL(settings.tokenUrl).host : null } });
  return publicConnection((await connectionById(tx, id))!);
}

export async function listConnections(tx: Tx) {
  return (await liveConnections(tx)).map(publicConnection);
}

/** The live automations with a step that names the connection. */
async function usedBy(tx: Tx, key: string): Promise<{ id: string; name: string }[]> {
  const rows = await automationsNamingConnections(tx);
  return rows.filter((a) => allSteps(a.actions as Step[]).some((s) => s.type === "http_request" && s.connection === key))
    .map((a) => ({ id: encodeId("auto", a.id), name: a.name }));
}

export async function getConnection(tx: Tx, publicId: string) {
  const c = await loadConnection(tx, publicId);
  return { ...publicConnection(c), used_by: c.archived_at ? [] : await usedBy(tx, c.key) };
}

/**
 * `onCredentialChange` is called before anything is written when the patch enters a secret or moves where
 * secrets are sent: the route asks a browser session for a recent sign-in there.
 */
export async function updateConnection(tx: Tx, ctx: Ctx, publicId: string, patch: ConnectionPatch, onCredentialChange?: () => void) {
  const c = await loadConnection(tx, publicId, true);
  if (c.archived_at) throw conflict(`Connection ${publicId} is archived`);
  const pick = <K extends keyof ConnectionPatch>(k: K, current: ConnectionPatch[K]) => (patch[k] !== undefined ? patch[k] : current);
  const next = settingsFor(c.type, {
    name: pick("name", c.name)!, description: pick("description", c.description), base_url: pick("base_url", c.base_url)!,
    header_name: pick("header_name", c.header_name), header_prefix: pick("header_prefix", c.header_prefix), token_url: pick("token_url", c.token_url),
    client_id: pick("client_id", c.client_id), scope: pick("scope", c.scope), token_params: pick("token_params", c.token_params),
    token_lifetime_minutes: pick("token_lifetime_minutes", c.token_lifetime_minutes), test_path: pick("test_path", c.test_path), enabled: pick("enabled", c.enabled),
  });
  if (c.type !== "oauth_refresh_token" && patch.refresh_token) throw unprocessable(`A ${c.type} connection has no refresh_token`, { field: "refresh_token" });
  // A stored secret only ever goes where it was entered for: another host or path for the requests, or another
  // token URL, needs every secret again.
  const moved = next.baseUrl !== c.base_url || next.tokenUrl !== c.token_url;
  if (moved || patch.secret || patch.refresh_token) onCredentialChange?.();
  if (moved && !patch.secret) throw unprocessable("base_url or token_url changed, so the secret must be given again (it is not reused)", { field: "secret" });
  if (moved && c.type === "oauth_refresh_token" && !patch.refresh_token) {
    throw unprocessable("base_url or token_url changed, so the refresh_token must be given again (it is not reused)", { field: "refresh_token" });
  }
  const dropToken = moved || next.clientId !== c.client_id || next.scope !== c.scope || JSON.stringify(next.tokenParams) !== JSON.stringify(c.token_params);
  await updateConnectionSettings(tx, c.id, next, dropToken);
  const secretsSet: string[] = [];
  if (patch.secret) {
    await setConnectionSecret(tx, c.id, await encryptValue(tx, ctx.tenantId, c.id, sealed("secret"), checkSecret(patch.secret, "secret")));
    secretsSet.push("secret");
  }
  if (patch.refresh_token) {
    await setConnectionRefreshToken(tx, c.id, await encryptValue(tx, ctx.tenantId, c.id, sealed("refresh_token"), checkSecret(patch.refresh_token, "refresh_token")));
    secretsSet.push("refresh_token");
  }
  const fields = Object.keys(patch).filter((k) => k !== "secret" && k !== "refresh_token");
  if (fields.length) {
    await audit(tx, ctx, { action: "connection.updated", details: { connection: publicId, fields,
      ...(moved ? { host: new URL(next.baseUrl).host, token_host: next.tokenUrl ? new URL(next.tokenUrl).host : null } : {}) } });
  }
  if (secretsSet.length) await audit(tx, ctx, { action: "connection.secret_set", details: { connection: publicId, secrets: secretsSet } });
  return getConnection(tx, publicId);
}

/** Archiving forgets the secrets. Refused while a live automation names the connection. */
export async function archiveConnection(tx: Tx, ctx: Ctx, publicId: string) {
  const c = await loadConnection(tx, publicId, true);
  if (!c.archived_at) {
    const users = await usedBy(tx, c.key);
    if (users.length) {
      throw conflict(`Connection ${c.key} is used by ${users.length === 1 ? "an automation" : `${users.length} automations`}: ${users.slice(0, 10).map((u) => `${u.name} (${u.id})`).join(", ")}. Change or archive ${users.length === 1 ? "it" : "them"} first.`,
        { used_by: users });
    }
    await archiveConnectionRow(tx, c.id);
    await audit(tx, ctx, { action: "connection.archived", details: { connection: publicId, key: c.key } });
  }
  return getConnection(tx, publicId);
}

// ----------------------------------------------------------------------------------------------
// Use by automation steps

/** The connection a step names, for checking the step when it is saved and building its request when it runs. */
export async function connectionForStep(tx: Tx, key: string): Promise<ConnectionRow> {
  const c = await liveConnectionByKey(tx, key);
  if (!c) throw unprocessable(`There is no connection with the key "${key}"`);
  return c;
}

/** The URL template of a step that names a connection: the connection's base URL, then the step's path. */
export const connectionUrl = (c: Pick<ConnectionRow, "base_url">, path: string) => `${c.base_url}${path}`;

interface TokenReply { accessToken: string; expiresInS: number | null; refreshToken: string | null }

/** Asks the token URL for an access token. Throws ConnectionError with a message that holds nothing from the reply but its status and OAuth error code. */
async function requestToken(c: ConnectionRow, secret: string, refreshToken: string | null): Promise<TokenReply> {
  const form = new URLSearchParams(c.token_params);
  form.set("grant_type", c.type === "oauth_refresh_token" ? "refresh_token" : "client_credentials");
  form.set("client_id", c.client_id ?? "");
  form.set("client_secret", secret);
  if (refreshToken !== null) form.set("refresh_token", refreshToken);
  if (c.scope) form.set("scope", c.scope);
  let res: { status: number; body: string };
  try {
    res = await safeRequest(c.token_url!, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" },
      maxBytes: TOKEN_MAX_BYTES, deadlineMs: TOKEN_DEADLINE_MS }, policy());
  } catch (e) {
    if (e instanceof BlockedTargetError) throw new ConnectionError(`the token request was refused: ${e.message.replace(/^Webhook URL/, "the token URL").slice(0, 200)}`);
    const code = (e as NodeJS.ErrnoException).code;
    throw new ConnectionError((e as Error).message?.startsWith("timed out") ? "the token request timed out"
      : `the token request failed (network error${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? ` ${code}` : ""})`);
  }
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(res.body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (res.status < 200 || res.status >= 300) {
    const code = typeof json?.error === "string" && /^[a-z0-9_.-]{1,60}$/i.test(json.error) ? ` (${json.error})` : "";
    throw new ConnectionError(`the token request was answered with HTTP ${res.status}${code}`);
  }
  const accessToken = json?.access_token;
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16_000 || hasControl(accessToken)) {
    throw new ConnectionError("the token reply held no usable access_token");
  }
  const expires = Number(json?.expires_in);
  const rotated = json?.refresh_token;
  return { accessToken, expiresInS: Number.isFinite(expires) && expires > 0 ? expires : null,
    refreshToken: c.type === "oauth_refresh_token" && typeof rotated === "string" && rotated && rotated !== refreshToken && !hasControl(rotated) ? rotated : null };
}

export interface Credential { header: string; value: string; refreshable: boolean }

/**
 * The header a request through the connection carries. In a transaction of its own, which holds the
 * connection's row while it asks for a token: two runs never both spend a refresh token that rotates, and
 * the second finds the first one's token. `force` asks for a new token (after a 401) unless one was
 * fetched moments ago. Throws ConnectionError; a failed token request is recorded on the connection first.
 */
export async function connectionCredential(tenantId: string, id: string, opts: { force?: boolean } = {}): Promise<Credential> {
  const result = await withTenant(tenantId, async (tx): Promise<Credential | { error: string }> => {
    const c = await connectionById(tx, id, true);
    if (!c || c.archived_at) return { error: "the connection no longer exists" };
    if (!c.enabled) return { error: `connection ${c.key} is turned off` };
    if (!c.secret) return { error: `connection ${c.key} has no secret; set it again` };
    const header = (value: string): Credential => ({ header: c.header_name, value: `${c.header_prefix}${value}`, refreshable: isOAuth(c.type) });
    const secret = (await decryptValue(tx, tenantId, c.id, sealed("secret"), c.secret)) as string;
    if (!isOAuth(c.type)) return header(secret);
    const now = Date.now();
    const fresh = c.access_token && c.access_token_expires_at && c.access_token_expires_at.getTime() - EXPIRY_MARGIN_MS > now;
    const justFetched = c.access_token_fetched_at && now - c.access_token_fetched_at.getTime() < FORCE_REUSE_MS;
    if (fresh && (!opts.force || justFetched)) return header((await decryptValue(tx, tenantId, c.id, sealed("access_token"), c.access_token!)) as string);
    if (c.type === "oauth_refresh_token" && !c.refresh_token) return { error: `connection ${c.key} has no refresh token; set it again` };
    const refreshToken = c.refresh_token ? ((await decryptValue(tx, tenantId, c.id, sealed("refresh_token"), c.refresh_token)) as string) : null;
    let reply: TokenReply;
    try {
      reply = await requestToken(c, secret, refreshToken);
    } catch (e) {
      if (!(e instanceof ConnectionError)) throw e;
      await setConnectionError(tx, c.id, e.message.slice(0, 300));
      return { error: `connection ${c.key}: ${e.message}` };
    }
    const lifeMs = Math.min(reply.expiresInS !== null ? reply.expiresInS * 1000 : c.token_lifetime_minutes * 60_000, MAX_CACHE_MS);
    await cacheAccessToken(tx, c.id, await encryptValue(tx, tenantId, c.id, sealed("access_token"), reply.accessToken), new Date(now + lifeMs),
      reply.refreshToken ? await encryptValue(tx, tenantId, c.id, sealed("refresh_token"), reply.refreshToken) : null);
    return header(reply.accessToken);
  });
  if ("error" in result) throw new ConnectionError(result.error);
  return result;
}

export async function markConnectionUsed(tx: Tx, id: string): Promise<void> {
  await touchConnectionUsed(tx, id);
}

// ----------------------------------------------------------------------------------------------
// Testing

/**
 * Fetches a token (the OAuth types) and, when the connection has a test_path, sends one GET to it. The
 * answer is the outcome and the status, never anything from a reply. The token is fetched and kept in a
 * transaction of its own, so a working test leaves the connection ready.
 */
export async function testConnection(tx: Tx, ctx: Ctx, publicId: string) {
  const c = await loadConnection(tx, publicId);
  if (c.archived_at) throw conflict(`Connection ${publicId} is archived`);
  let credential: Credential | null = null;
  let tokenError: string | null = null;
  try {
    credential = await connectionCredential(ctx.tenantId, c.id, { force: true });
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    tokenError = e.message;
  }
  let request: { ok: boolean; status: number | null; error: string | null } | null = null;
  if (credential && c.test_path) {
    try {
      const res = await safeRequest(connectionUrl(c, c.test_path), { method: "GET", headers: { "user-agent": "hl-crm-db-connections/1", [credential.header]: credential.value },
        maxBytes: TOKEN_MAX_BYTES, deadlineMs: TOKEN_DEADLINE_MS, truncate: true }, policy());
      request = { ok: res.status < 400, status: res.status, error: res.status < 400 ? null : `the server answered HTTP ${res.status}` };
    } catch (e) {
      request = { ok: false, status: null, error: e instanceof BlockedTargetError ? e.message.replace(/^Webhook URL/, "The test URL").slice(0, 200)
        : (e as Error).message?.startsWith("timed out") ? "the request timed out" : "network error" };
    }
  }
  const ok = !tokenError && (request ? request.ok : true);
  await audit(tx, ctx, { action: "connection.tested", details: { connection: publicId, ok, status: request?.status ?? null } });
  return {
    ok,
    token: isOAuth(c.type) ? { ok: !tokenError, error: tokenError } : tokenError ? { ok: false, error: tokenError } : null,
    request,
    ...(!isOAuth(c.type) && !c.test_path ? { note: "Nothing was sent: a static token can only be checked with a test_path." } : {}),
  };
}
