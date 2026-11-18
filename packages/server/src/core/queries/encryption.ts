import type { Tx } from "../../db/pool.js";

/** The SQL of each workspace's data keys (core/encryption.ts; ADR 0012). Keys are stored wrapped, never in the clear. */

/** Stores a workspace's first data key, wrapped by the key provider. */
export async function insertTenantKey(tx: Tx, tenantId: string, provider: string, wrappedKey: Buffer): Promise<void> {
  await tx`INSERT INTO tenant_keys (tenant_id, version, provider, wrapped_key) VALUES (${tenantId}, 1, ${provider}, ${wrappedKey})`;
}

/** The workspace's newest data key that isn't retired, still wrapped. */
export async function currentTenantKey(tx: Tx): Promise<{ version: number; wrapped_key: Buffer } | undefined> {
  const [row] = await tx<{ version: number; wrapped_key: Buffer }[]>`
    SELECT version, wrapped_key FROM tenant_keys WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1`;
  return row;
}
