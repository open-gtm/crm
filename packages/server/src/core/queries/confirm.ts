import type { Tx } from "../../db/pool.js";

/** The SQL of confirm tokens (core/confirm.ts; ADR 0012): a spent token's hash is kept until it expires. */

/** Records a token as spent. False when it already was (a concurrent spend waits for the first). */
export async function spendConfirmToken(tx: Tx, tenantId: string, tokenHash: Buffer, expiresAt: Date): Promise<boolean> {
  const spent = await tx`INSERT INTO confirm_tokens (tenant_id, token_hash, expires_at) VALUES (${tenantId}, ${tokenHash}, ${expiresAt})
    ON CONFLICT DO NOTHING RETURNING 1`;
  return spent.length > 0;
}
