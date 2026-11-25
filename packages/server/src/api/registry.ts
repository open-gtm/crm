import type { z } from "zod";
import type { Tx } from "../db/pool.js";
import type { Ctx, Permission, Scope } from "../core/context.js";
import type { ResponseSpec } from "./responses.js";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface HandlerArgs<B = unknown, Q = Record<string, string>> {
  tx: Tx;
  ctx: Ctx;
  params: Record<string, string>;
  body: B;
  /** The request's bytes, for a route with `rawBody`. */
  raw?: Buffer;
  query: Q;
  headers: Headers;
  /** What the route's `prepare` returned. */
  prepared?: unknown;
  /**
   * Takes more rate-limit tokens once the work is known (a preview by filter, charged per record it
   * examined). Charged to the same bucket as `cost`: the key, or the signed-in member.
   */
  charge: (tokens: number) => void;
}

export interface HandlerResult {
  status?: number;
  /** JSON, or text (a CSV export) or bytes (a file download), whose Content-Type the handler sets in `headers`. */
  body: unknown;
  headers?: Record<string, string>;
  /** Work to run after the transaction commits (sending an email), never when it rolls back. Not replayed for an idempotent retry. */
  after?: () => Promise<void>;
}

export interface RouteDef<B = unknown, Q = unknown> {
  method: Method;
  path: string;
  /** The key scope family the route belongs to. Picks the MCP surface and, absent `permission`, the permission (see requiredPermission). */
  scope: Scope | "any";
  /**
   * The permission the caller needs. Required for admin routes whose tag doesn't map to one.
   * "own_credential": any authenticated caller, even one whose role holds no permissions, because the
   * route only acts on the caller's own sign-in (reading or ending their session, their password).
   * A list: at least one of these, checked before the body is read, a heavy slot taken or any cost charged;
   * the handler checks what the request needs beyond that (schema packs need one per part). There is no
   * "any permission" option: a route says which permissions admit it, so a new one can't fall open by accident.
   */
  permission?: Permission | readonly Permission[] | "own_credential";
  summary: string;
  tag: string;
  body?: z.ZodType<B>;
  /**
   * The request body is raw bytes (a file upload), read up to `maxBytes()` and handed to the handler as
   * `raw`. Such a route has no JSON `body`. api/app.ts gives it its own size limit in place of the 1 MB one.
   */
  rawBody?: { maxBytes: () => number };
  query?: z.ZodType<Q>;
  /** Path params that hold record or entity IDs, for the cross-tenant test harness. */
  idParams?: Record<string, "record" | "key" | "webhook" | "automation" | "delivery" | "notification" | "alert" | "member" | "service_account" | "role" | "permission_set" | "session" | "view" | "grant" | "file">;
  /**
   * "session": only a signed-in person (browser session) may call it, never an API key: it acts on the
   * person's own sign-in (their session, their password). Unset: keys and sessions alike.
   */
  credential?: "session";
  /**
   * Slow work done before the route's transaction opens, so it doesn't hold a pooled connection
   * (hashing a password, a third-party check). Its result reaches the handler as `prepared`.
   */
  prepare?: (args: Omit<HandlerArgs<B, Q>, "tx" | "prepared">) => Promise<unknown>;
  /**
   * Rate-limit tokens the request takes in all (default 1), from its parsed body and query: for routes
   * whose work grows with them. Charged to the credential's bucket: the key, or for a browser session the member.
   */
  cost?: (body: B, query: Q) => number;
  /** The success response's shape, for the OpenAPI document (api/responses.ts). A test fails for a route without one. */
  response?: ResponseSpec;
  /**
   * A request that can hold its database connection for seconds (a scan, a preview, many writes, an
   * aggregate). At most two run at once per credential (a key, or a signed-in member across all their
   * sessions) and a few server-wide (api/app.ts), so they can't take the whole pool; more are refused
   * with 429 at once. A function decides from the parsed body and query (a batch create's dry run, a list with a count).
   */
  heavy?: boolean | ((body: B, query: Q) => boolean);
  handler: (args: HandlerArgs<B, Q>) => Promise<HandlerResult>;
}

/** Every route the API serves. The OpenAPI document and the cross-tenant tests are built from this list. */
export const routes: RouteDef<never, never>[] = [];

export function route<B = undefined, Q = Record<string, string>>(def: RouteDef<B, Q>): void {
  routes.push(def as unknown as RouteDef<never, never>);
}

export const isWrite = (m: Method) => m !== "GET";

/** Admin-scope routes in these tags need the matching permission unless they say otherwise. */
const ADMIN_TAG_PERMISSION: Record<string, Permission> = {
  schema: "schema:manage", webhooks: "webhooks:manage", automations: "automations:manage", alerts: "alerts:manage",
};

/**
 * The permission a route requires: its explicit `permission` (a list: any one of them), else one derived
 * from its scope (and, for admin routes, its tag). "any" (scope "any" only: who am I, my preferences, the
 * role catalogue) means any key with at least one effective permission. Returns null when nothing applies;
 * app.ts refuses to start then, so an admin route can't fall through unguarded.
 */
export type Required = Permission | readonly Permission[] | "any" | "own_credential";
export function requiredPermission(r: Pick<RouteDef, "scope" | "tag" | "permission">): Required | null {
  if (r.permission) return r.permission;
  switch (r.scope) {
    case "any": return "any";
    case "ops:read": return "records:read";
    case "ops:write": return "records:write";
    case "restricted:read": return "restricted:read";
    case "admin": return ADMIN_TAG_PERMISSION[r.tag] ?? null;
  }
}
