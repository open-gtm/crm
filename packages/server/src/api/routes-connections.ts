import { z } from "zod";
import { requireRecentSignIn } from "../auth/sessions.js";
import {
  archiveConnection, createConnection, getConnection, listConnections, testConnection, updateConnection,
} from "../core/connections.js";
import type { Ctx } from "../core/context.js";
import { forbidden } from "../lib/errors.js";
import { route } from "./registry.js";
import { R } from "./responses.js";
import { viaMcp } from "./routes-events.js";

/**
 * Connections (ADR 0016). Every route needs connections:manage (the tag's permission). Changes never come
 * through MCP: a prompt-injected agent could otherwise point a stored credential at a host of its choosing,
 * or replace it. An agent can list connections and name one in an automation.
 */

const Secret = z.string().min(1).max(8000).nullable().optional();
const ConnectionBody = z.object({
  key: z.string().min(1).max(40).describe("Lowercase name steps use, e.g. salesforce. It can't be changed later"),
  name: z.string().min(1).max(100),
  description: z.string().max(2000).nullable().optional(),
  type: z.enum(["static_token", "oauth_client_credentials", "oauth_refresh_token"]),
  base_url: z.string().min(1).max(500).describe("https:// origin and an optional path prefix. The credential is only sent under it"),
  header_name: z.string().min(1).max(100).optional().describe("Default Authorization"),
  header_prefix: z.string().max(40).optional().describe("Default \"Bearer \""),
  token_url: z.string().max(500).nullable().optional(),
  client_id: z.string().max(500).nullable().optional(),
  scope: z.string().max(1000).nullable().optional(),
  token_params: z.record(z.string(), z.string().max(500)).optional().describe("Extra form parameters for the token request"),
  token_lifetime_minutes: z.number().int().min(1).max(1440).optional().describe("Used when the token reply has no expires_in. Default 30"),
  test_path: z.string().max(500).nullable().optional().describe("A path that answers a GET with a status under 400 when the credential works"),
  enabled: z.boolean().optional(),
  secret: Secret.describe("Write-only. The token (static_token) or the client secret. null or absent on an update keeps the stored one"),
  refresh_token: Secret.describe("Write-only. oauth_refresh_token only"),
}).strict();

function notThroughMcp(headers: Headers, ctx: Ctx): void {
  if (viaMcp(headers, ctx)) throw forbidden("Connections can't be created, changed or tested through MCP. Ask the user to do it in Settings → Connections or through the API.");
}

route({
  method: "GET", path: "/v1/connections", scope: "admin", tag: "connections", summary: "List connections. Secrets are never returned",
  response: R.connections,
  handler: async ({ tx }) => ({ body: { data: await listConnections(tx) } }),
});

route({
  method: "POST", path: "/v1/connections", scope: "admin", tag: "connections",
  summary: "Create a connection: a stored credential for one outside host, which http_request steps name. Not through MCP. From a browser session, needs a sign-in in the last 10 minutes",
  response: { ...R.connection, status: 201 },
  body: ConnectionBody,
  handler: async ({ tx, ctx, body, headers }) => {
    notThroughMcp(headers, ctx);
    if (ctx.session) requireRecentSignIn(ctx);
    const created = await createConnection(tx, ctx, body);
    return { status: 201, body: { data: { ...created, used_by: [] } } };
  },
});

route({
  method: "GET", path: "/v1/connections/:id", scope: "admin", tag: "connections", summary: "Get a connection and the automations that use it",
  response: R.connection,
  idParams: { id: "connection" },
  handler: async ({ tx, params }) => ({ body: { data: await getConnection(tx, params.id!) } }),
});

route({
  method: "PATCH", path: "/v1/connections/:id", scope: "admin", tag: "connections",
  summary: "Change a connection. A new base_url or token_url needs the secrets again. Not through MCP. Entering a secret or moving a URL from a browser session needs a recent sign-in",
  response: R.connection,
  idParams: { id: "connection" }, body: ConnectionBody.omit({ key: true, type: true }).partial().strict(),
  handler: async ({ tx, ctx, params, body, headers }) => {
    notThroughMcp(headers, ctx);
    return { body: { data: await updateConnection(tx, ctx, params.id!, body, () => { if (ctx.session) requireRecentSignIn(ctx); }) } };
  },
});

route({
  method: "DELETE", path: "/v1/connections/:id", scope: "admin", tag: "connections",
  summary: "Archive a connection and forget its secrets. Refused while an automation names it. Not through MCP",
  response: R.connection,
  idParams: { id: "connection" },
  handler: async ({ tx, ctx, params, headers }) => {
    notThroughMcp(headers, ctx);
    return { body: { data: await archiveConnection(tx, ctx, params.id!) } };
  },
});

route({
  method: "POST", path: "/v1/connections/:id/test", scope: "admin", tag: "connections", heavy: true,
  summary: "Fetch a token (OAuth types) and send one GET to the connection's test_path. Answers with outcomes and statuses only. Not through MCP",
  response: R.connectionTest,
  idParams: { id: "connection" },
  handler: async ({ tx, ctx, params, headers }) => {
    notThroughMcp(headers, ctx);
    return { body: { data: await testConnection(tx, ctx, params.id!) } };
  },
});
