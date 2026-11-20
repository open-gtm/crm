import type { Tx } from "../db/pool.js";
import { encodeId, uuidv7 } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { insertAuditEntry } from "./queries/audit.js";

export interface AuditEntry {
  action: string;
  objectType?: string | null;
  recordId?: string | null;
  /** Never put confidential or restricted values here: names of changed fields, not their values. */
  details?: Record<string, unknown>;
}

/**
 * Writes an audit row in the caller's transaction, so it commits or rolls back with the change.
 * A browser session has no key, so its ID goes in `details.session`; an app connected over OAuth
 * names its grant and client in `details.oauth_grant` and `details.oauth_client` (the row's hashed
 * columns are fixed). Never a token.
 */
export async function audit(tx: Tx, ctx: Ctx, entry: AuditEntry): Promise<void> {
  const details = { ...entry.details, ...(ctx.session ? { session: encodeId("ses", ctx.session.id) } : {}),
    ...(ctx.oauth ? { oauth_grant: encodeId("ogr", ctx.oauth.grantId), oauth_client: ctx.oauth.clientId } : {}) };
  await insertAuditEntry(tx, { tenantId: ctx.tenantId, id: uuidv7(), actorType: ctx.actor.type, actorId: ctx.actor.id, keyId: ctx.keyId, surface: ctx.surface,
    action: entry.action, objectType: entry.objectType ?? null, recordId: entry.recordId ?? null, requestId: ctx.requestId, details });
}
