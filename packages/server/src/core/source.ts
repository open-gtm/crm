import type { Tx } from "../db/pool.js";
import type { Ctx } from "./context.js";
import { apiKeyName, oauthClientName } from "./queries/schema.js";

/**
 * The connected app or API key a request came through, by name: what "through MCP" or "through the API"
 * leaves out. It is a label for people (a key can be renamed); the audit log has the key and grant IDs.
 * Null for a browser session, an automation and the system. Names are kept for a few minutes per process,
 * so writing an event doesn't cost a lookup each time.
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { name: string | null; expires: number }>();

export async function viaOf(tx: Tx, ctx: Ctx): Promise<string | null> {
  const key = ctx.oauth ? `grant:${ctx.oauth.grantId}` : ctx.keyId ? `key:${ctx.keyId}` : null;
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.name;
  const name = (ctx.oauth ? await oauthClientName(tx, ctx.oauth.grantId) : await apiKeyName(tx, ctx.keyId!)) ?? null;
  if (cache.size > 5000) cache.clear();
  cache.set(key, { name, expires: Date.now() + TTL_MS });
  return name;
}

/** Surfaces a change reaches the CRM through without a person at the web UI: API keys, the CLI and the MCP servers. */
export const AGENT_SURFACES = ["api", "cli", "admin-mcp", "ops-mcp"] as const;
