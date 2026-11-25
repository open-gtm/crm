import type { Tx } from "../../db/pool.js";
import type { Permission, Scope } from "../context.js";
import { memberSetsColumn, type HeldSetRow } from "./roles.js";

/**
 * The SQL of API keys (core/keys.ts; ADR 0012): looking a presented key up, its owner's role, and creating,
 * rotating and revoking keys. Only a key's SHA-256 hash is stored. The code that calls these keeps its checks,
 * errors, audits and the order of statements in its transaction.
 */

type MemberType = "user" | "service_account";

// --- Authenticating a key ---------------------------------------------------------------------------

/** Lets the transaction find one key by its lookup part, before its workspace is known. */
export async function narrowToKeyLookup(tx: Tx, lookup: string): Promise<void> {
  await tx`SELECT set_config('app.key_lookup', ${lookup}, true)`;
}

export interface KeyByLookupRow { tenant_id: string; id: string; owner_type: MemberType; owner_id: string; secret_hash: Buffer;
  scopes: Scope[]; expires_at: Date | null; revoked_at: Date | null }

/** The key with this lookup part, in whatever state (after narrowToKeyLookup). */
export async function keyByLookup(tx: Tx, lookup: string): Promise<KeyByLookupRow | undefined> {
  const [key] = await tx<KeyByLookupRow[]>`
      SELECT tenant_id, id, owner_type, owner_id, secret_hash, scopes, expires_at, revoked_at FROM api_keys WHERE lookup = ${lookup}`;
  return key;
}

/** Ends the key lookup and enters the key's workspace. */
export async function enterKeyWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.key_lookup', '', true), set_config('app.tenant_id', ${tenantId}, true)`;
}

/** Records that a key was used, at most once a minute. */
export async function touchKey(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE api_keys SET last_used_at = now() WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
}

/** A key owner's (or session holder's) role and status. */
export interface Owner { role: string; role_id: string; access_version: string; permissions: Permission[]; disabled_at: Date | null; archived_at: Date | null;
  /** The permission sets the member holds (ADR 0013). `permissions` is the role's alone. */
  sets: HeldSetRow[] }

/** A member's role (key, ID, permissions and rules version), whether they are disabled and whether the role is archived. */
export async function memberRoleStatus(tx: Tx, type: MemberType, id: string): Promise<Owner | undefined> {
  const [o] = type === "user"
    ? await tx<Owner[]>`SELECT r.key AS role, r.id AS role_id, r.access_version::text, r.permissions, m.disabled_at, r.archived_at, ${memberSetsColumn(tx, "user")}
                        FROM users m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id WHERE m.id = ${id}`
    : await tx<Owner[]>`SELECT r.key AS role, r.id AS role_id, r.access_version::text, r.permissions, m.disabled_at, r.archived_at, ${memberSetsColumn(tx, "service_account")}
                        FROM service_accounts m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id WHERE m.id = ${id}`;
  return o;
}

// --- Managing keys ----------------------------------------------------------------------------------

export async function insertApiKey(tx: Tx, k: { tenantId: string; id: string; ownerType: MemberType; ownerId: string; name: string; lookup: string;
  secretHash: Buffer; scopes: Scope[]; environment: string; expiresAt: Date | null; createdBy: string | null }): Promise<void> {
  await tx`
    INSERT INTO api_keys (tenant_id, id, owner_type, owner_id, name, lookup, secret_hash, scopes, environment, expires_at, created_by)
    VALUES (${k.tenantId}, ${k.id}, ${k.ownerType}, ${k.ownerId}, ${k.name}, ${k.lookup}, ${k.secretHash}, ${k.scopes},
            ${k.environment}, ${k.expiresAt}, ${k.createdBy})`;
}

export interface KeyListRow { id: string; name: string; owner_type: string; owner_id: string; scopes: string[]; environment: string;
  created_at: Date; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null; lookup: string }

/** Every key in the workspace, newest first. */
export async function allApiKeys(tx: Tx): Promise<KeyListRow[]> {
  return tx<KeyListRow[]>`
    SELECT id, name, owner_type, owner_id, scopes, environment, created_at, expires_at, revoked_at, last_used_at, lookup
    FROM api_keys ORDER BY created_at DESC`;
}

export interface KeyForChangeRow { id: string; name: string; owner_type: MemberType; owner_id: string; scopes: Scope[]; environment: "live" | "test";
  revoked_at: Date | null; expires_at: Date | null }

/** A key, locked for the rest of the transaction. */
export async function apiKeyForUpdate(tx: Tx, id: string): Promise<KeyForChangeRow | undefined> {
  const [key] = await tx<KeyForChangeRow[]>`
    SELECT id, name, owner_type, owner_id, scopes, environment, revoked_at, expires_at FROM api_keys WHERE id = ${id} FOR UPDATE`;
  return key;
}

/** Revokes a key, keeping the first revocation's time. */
export async function revokeKey(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${id}`;
}

/** Makes a key expire within `hours`, never later than it already would. */
export async function expireKeyWithin(tx: Tx, id: string, hours: number): Promise<void> {
  await tx`UPDATE api_keys SET expires_at = least(coalesce(expires_at, 'infinity'), now() + make_interval(hours => ${hours}))
           WHERE id = ${id}`;
}

/** Marks a key as the replacement of `rotatedFrom`, with the expiry it inherits. */
export async function linkRotatedKey(tx: Tx, id: string, rotatedFrom: string, expiresAt: Date | null): Promise<void> {
  await tx`UPDATE api_keys SET rotated_from = ${rotatedFrom}, expires_at = ${expiresAt} WHERE id = ${id}`;
}

/** Revokes every live key a member holds. Returns how many. */
export async function revokeKeysOf(tx: Tx, ownerType: MemberType, ownerId: string): Promise<number> {
  const revoked = await tx`UPDATE api_keys SET revoked_at = now()
                               WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} AND revoked_at IS NULL RETURNING id`;
  return revoked.length;
}

export interface KeyReviewRow { id: string; owner_type: MemberType; owner_id: string; name: string; scopes: string[]; environment: string;
  created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }

/** Every key in the workspace, oldest first, for the access review. */
export async function keysForAccessReview(tx: Tx): Promise<KeyReviewRow[]> {
  return tx<KeyReviewRow[]>`
    SELECT id, owner_type, owner_id, name, scopes, environment, created_at, last_used_at, expires_at, revoked_at FROM api_keys ORDER BY created_at`;
}
