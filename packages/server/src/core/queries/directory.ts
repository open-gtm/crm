import type { Tx } from "../../db/pool.js";

/**
 * The SQL of the member directory (owner and assignee pickers, member lookups by email in an import) and of
 * each member's own preferences (core/directory.ts, core/transfer.ts; ADR 0012).
 */

type MemberType = "user" | "service_account";

// --- Member directory -------------------------------------------------------------------------------

/**
 * Active users by name then ID, after the (name, ID) `after` when given, at most `take`. With a search `q`
 * (lowercase; "" for none), those whose name or email starts with `like`, or whose name has a word starting
 * with it (`wordLike`).
 */
export async function activeUsersPage(tx: Tx, p: { q: string; like: string; wordLike: string; after: { n: string; id: string } | null; take: number }) {
  return tx<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email::text AS email FROM users
    WHERE disabled_at IS NULL
      AND (${p.q} = '' OR lower(name) LIKE ${p.like} OR lower(email::text) LIKE ${p.like} OR lower(name) LIKE ${p.wordLike})
      AND (${p.after?.n ?? null}::text IS NULL OR (name, id) > (${p.after?.n ?? ""}, ${p.after?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
    ORDER BY name, id LIMIT ${p.take}`;
}

/** The active users with this email (citext: any case), at most two: enough to tell one from several. */
export async function activeUsersByEmail(tx: Tx, email: string): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND disabled_at IS NULL LIMIT 2`;
}

// --- Preferences ------------------------------------------------------------------------------------

/** A member's preferences, by key. */
export async function preferencesOf(tx: Tx, type: MemberType, id: string): Promise<{ key: string; value: unknown }[]> {
  return tx<{ key: string; value: unknown }[]>`
    SELECT key, value FROM member_preferences WHERE member_type = ${type} AND member_id = ${id} ORDER BY key`;
}

/** Each value's size as the database CHECK measures it (its jsonb text), in the order given. */
export async function preferenceValueSizes(tx: Tx, values: unknown[]): Promise<{ n: number }[]> {
  return tx<{ n: number }[]>`
    SELECT octet_length(x::text)::int AS n FROM jsonb_array_elements(${tx.json(values as never)}::jsonb) WITH ORDINALITY AS e(x, i) ORDER BY i`;
}

/** Serialises one member's preference writes for the rest of the transaction. */
export async function lockPreferences(tx: Tx, tenantId: string, type: MemberType, id: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`prefs:${tenantId}:${type}:${id}`}))`;
}

export async function deletePreference(tx: Tx, type: MemberType, id: string, key: string): Promise<void> {
  await tx`DELETE FROM member_preferences WHERE member_type = ${type} AND member_id = ${id} AND key = ${key}`;
}

export async function upsertPreference(tx: Tx, p: { tenantId: string; type: MemberType; id: string; key: string; value: unknown }): Promise<void> {
  await tx`INSERT INTO member_preferences (tenant_id, member_type, member_id, key, value) VALUES (${p.tenantId}, ${p.type}, ${p.id}, ${p.key}, ${tx.json(p.value as never)})
        ON CONFLICT (tenant_id, member_type, member_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

/** The size of all of a member's preference values together, as the database measures them. */
export async function preferencesTotalBytes(tx: Tx, type: MemberType, id: string): Promise<number> {
  const [total] = await tx<{ n: number }[]>`
    SELECT coalesce(sum(octet_length(value::text)), 0)::int AS n FROM member_preferences WHERE member_type = ${type} AND member_id = ${id}`;
  return total!.n;
}
