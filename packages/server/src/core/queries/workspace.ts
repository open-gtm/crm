import type { Tx } from "../../db/pool.js";
import { OWNER_ROLE, type Permission } from "../context.js";

/**
 * The SQL of the workspace itself, its members and its service accounts (core/workspace.ts; ADR 0012). The
 * code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

type MemberType = "user" | "service_account";

// --- The workspace ----------------------------------------------------------------------------------

/** Lists a new workspace in the tenant directory, which every workspace has a row in. */
export async function registerTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx`INSERT INTO tenant_directory (tenant_id) VALUES (${tenantId})`;
}

/** Enters a workspace in a transaction opened outside withTenant (creating the workspace). */
export async function enterWorkspace(tx: Tx, tenantId: string): Promise<void> {
  await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
}

export async function insertTenant(tx: Tx, tenantId: string, name: string, currency: string): Promise<void> {
  await tx`INSERT INTO tenants (tenant_id, name, currency) VALUES (${tenantId}, ${name}, ${currency})`;
}

/** Adds one of the activity types every workspace starts with. */
export async function insertSystemActivityType(tx: Tx, t: { tenantId: string; key: string; label: string; editable: boolean }): Promise<void> {
  await tx`INSERT INTO activity_types (tenant_id, key, label, is_system, editable)
               VALUES (${t.tenantId}, ${t.key}, ${t.label}, true, ${t.editable})`;
}

export interface WorkspaceRow { tenant_id: string; name: string; kind: string; currency: string; modules: string[]; schema_version: string; created_at: Date;
  password_sign_in: boolean; sso_sign_in: boolean; sso_allowed_domains: string[]; oauth_apps: boolean; oauth_scopes: string[] }

/** The workspace the transaction is in. */
export async function workspaceRow(tx: Tx): Promise<WorkspaceRow | undefined> {
  const [t] = await tx<WorkspaceRow[]>`
    SELECT tenant_id, name, kind, currency, modules, schema_version::text, created_at, password_sign_in, sso_sign_in, sso_allowed_domains,
           oauth_apps, oauth_scopes FROM tenants`;
  return t;
}

/** Changes the sign-in and OAuth settings given; null leaves one as it is. */
export async function updateSignInSettings(tx: Tx, s: { password: boolean | null; sso: boolean | null; ssoAllowedDomains: string[] | null;
  oauthApps: boolean | null; oauthScopes: string[] | null }): Promise<void> {
  await tx`UPDATE tenants SET password_sign_in = coalesce(${s.password}::boolean, password_sign_in),
                              sso_sign_in = coalesce(${s.sso}::boolean, sso_sign_in),
                              sso_allowed_domains = coalesce(${s.ssoAllowedDomains}::text[], sso_allowed_domains),
                              oauth_apps = coalesce(${s.oauthApps}::boolean, oauth_apps),
                              oauth_scopes = coalesce(${s.oauthScopes}::text[], oauth_scopes)`;
}

// --- Members and service accounts -------------------------------------------------------------------

export async function insertUser(tx: Tx, u: { tenantId: string; id: string; email: string; name: string; roleId: string }): Promise<void> {
  await tx`INSERT INTO users (tenant_id, id, email, name, role_id) VALUES (${u.tenantId}, ${u.id}, ${u.email}, ${u.name}, ${u.roleId})`;
}

export async function insertServiceAccount(tx: Tx, s: { tenantId: string; id: string; name: string; roleId: string; createdBy: string | null }): Promise<void> {
  await tx`INSERT INTO service_accounts (tenant_id, id, name, role_id, created_by) VALUES (${s.tenantId}, ${s.id}, ${s.name}, ${s.roleId}, ${s.createdBy})`;
}

export interface MemberRow { id: string; email: string | null; name: string; disabled_at: Date | null; created_at: Date;
  role_id: string; role_key: string; role_name: string; permissions: Permission[]; access_version: string }

/** Every user (or every service account) with their role, oldest first. A service account's email is null. */
export async function membersWithRoles(tx: Tx, type: MemberType): Promise<MemberRow[]> {
  return type === "user"
    ? tx<MemberRow[]>`SELECT m.id, m.email::text AS email, m.name, m.disabled_at, m.created_at, r.id AS role_id, r.key AS role_key,
                        r.name AS role_name, r.permissions, r.access_version::text
                      FROM users m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id ORDER BY m.created_at`
    : tx<MemberRow[]>`SELECT m.id, NULL AS email, m.name, m.disabled_at, m.created_at, r.id AS role_id, r.key AS role_key,
                        r.name AS role_name, r.permissions, r.access_version::text
                      FROM service_accounts m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id ORDER BY m.created_at`;
}

export interface SignInFactsRow { id: string; has_password: boolean; sso_linked: boolean; last_sign_in_at: Date | null; active_sessions: number }

/** Per user, for an access review (no secrets): whether a password is set, whether SSO is linked, the last sign-in and live sessions. */
export async function memberSignInFacts(tx: Tx): Promise<SignInFactsRow[]> {
  return tx<SignInFactsRow[]>`
    SELECT u.id, c.password_hash IS NOT NULL AS has_password, c.oidc_subject IS NOT NULL AS sso_linked, c.last_sign_in_at,
           (SELECT count(*)::int FROM sessions s WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.revoked_at IS NULL
              AND s.expires_at > now() AND s.idle_expires_at > now()) AS active_sessions
    FROM users u LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id`;
}

export interface MemberRoleRow { id: string; disabled_at: Date | null; role_id: string; role_key: string; permissions: Permission[]; access_version: string }

/** A member's state and role; `lock` locks the member's row (FOR UPDATE OF m) for the rest of the transaction. */
export async function memberWithRole(tx: Tx, type: MemberType, id: string, lock: boolean): Promise<MemberRoleRow | undefined> {
  const table = type === "user" ? tx`users` : tx`service_accounts`;
  const [m] = await tx<MemberRoleRow[]>`
    SELECT m.id, m.disabled_at, r.id AS role_id, r.key AS role_key, r.permissions, r.access_version::text
    FROM ${table} m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
    WHERE m.id = ${id} ${lock ? tx`FOR UPDATE OF m` : tx``}`;
  return m;
}

/** The active owners other than `userId`, locked: whether someone else would still be an owner. */
export async function otherActiveOwnersForUpdate(tx: Tx, userId: string): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
      SELECT u.id FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
      WHERE r.key = ${OWNER_ROLE} AND r.is_system AND u.disabled_at IS NULL AND u.id <> ${userId} FOR UPDATE OF u`;
}

export async function setMemberRole(tx: Tx, type: MemberType, id: string, roleId: string): Promise<void> {
  const table = type === "user" ? tx`users` : tx`service_accounts`;
  await tx`UPDATE ${table} SET role_id = ${roleId} WHERE id = ${id}`;
}

/** Turns a member on (disabled_at cleared) or off (disabled now). */
export async function setMemberActive(tx: Tx, type: MemberType, id: string, active: boolean): Promise<void> {
  const table = type === "user" ? tx`users` : tx`service_accounts`;
  await tx`UPDATE ${table} SET disabled_at = ${active ? null : tx`now()`} WHERE id = ${id}`;
}
