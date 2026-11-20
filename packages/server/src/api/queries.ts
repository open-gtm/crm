import type { Sql, Tx } from "../db/pool.js";

/**
 * The SQL of the request pipeline itself (api/app.ts): the readiness probe and idempotent replay
 * (ADR 0012). Route handlers call core/ or auth/ for their data; this is only what app.ts runs around them.
 */

/** Runs a trivial statement, so the readiness probe fails while the database can't be reached. */
export async function pingDatabase(sql: Sql): Promise<void> {
  await sql`SELECT 1`;
}

/**
 * Claims an Idempotency-Key for this credential with a placeholder response. False when the
 * credential already used the key (the request is then a replay, or a reuse with another body).
 */
export async function claimIdempotencyKey(tx: Tx, k: { tenantId: string; credentialId: string; credential: string; key: string; method: string; path: string;
  bodyHash: Buffer }): Promise<boolean> {
  const inserted = await tx`
        INSERT INTO idempotency_keys (tenant_id, credential_id, credential, idem_key, method, path, body_hash, status, response)
        VALUES (${k.tenantId}, ${k.credentialId}, ${k.credential}, ${k.key}, ${k.method}, ${k.path}, ${k.bodyHash}, 0, '{}')
        ON CONFLICT DO NOTHING RETURNING 1`;
  return inserted.length > 0;
}

/** What the first request with this credential and Idempotency-Key sent and got back. */
export async function priorIdempotentRequest(tx: Tx, credentialId: string, key: string) {
  const [prior] = await tx<{ body_hash: Buffer; status: number; response: unknown }[]>`
          SELECT body_hash, status, response FROM idempotency_keys WHERE credential_id = ${credentialId} AND idem_key = ${key}`;
  return prior;
}

/** Stores the response to replay for this credential and Idempotency-Key (already sealed by the caller). */
export async function storeIdempotentResponse(tx: Tx, credentialId: string, key: string, status: number, response: unknown): Promise<void> {
  await tx`UPDATE idempotency_keys SET status = ${status}, response = ${tx.json(response as never)}
               WHERE credential_id = ${credentialId} AND idem_key = ${key}`;
}
