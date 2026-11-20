import type { Tx } from "../../db/pool.js";
import type { FieldLimit, Permission } from "../context.js";

/**
 * The SQL of roles and their object and field rules (core/roles.ts, core/access.ts; ADR 0008, ADR 0012).
 * The code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

export interface RoleRow {
  id: string; key: string; name: string; description: string; permissions: Permission[]; is_system: boolean;
  created_at: Date; updated_at: Date; archived_at: Date | null; access_version: string;
}

/** The columns of a RoleRow, as a fragment of the query that selects them. */
const roleColumns = (tx: Tx) => tx`id, key, name, description, permissions, is_system, created_at, updated_at, archived_at, access_version::text`;

// --- Roles ------------------------------------------------------------------------------------------

/** Seeds the system roles for the tenant in `app.tenant_id` (app.seed_system_roles, migration 006). */
export async function insertSystemRoles(tx: Tx): Promise<void> {
  await tx`SELECT app.seed_system_roles()`;
}

/** A live (not archived) role by ID or key; `lock` takes a row lock on it. */
export async function liveRole(tx: Tx, ref: { id: string } | { key: string }, lock: "share" | "update" | null): Promise<RoleRow | undefined> {
  const by = "id" in ref ? tx`id = ${ref.id}` : tx`key = ${ref.key}`;
  const suffix = lock === "update" ? tx`FOR UPDATE` : lock === "share" ? tx`FOR SHARE` : tx``;
  const [row] = await tx<RoleRow[]>`SELECT ${roleColumns(tx)} FROM roles WHERE ${by} AND archived_at IS NULL ${suffix}`;
  return row;
}

/** A role by ID, archived or not, locked against changes (FOR SHARE) for the rest of the transaction. */
export async function roleForShare(tx: Tx, id: string): Promise<RoleRow | undefined> {
  const [row] = await tx<RoleRow[]>`SELECT id, key, name, description, permissions, is_system, created_at, updated_at, archived_at, access_version::text
                                     FROM roles WHERE id = ${id} FOR SHARE`;
  return row;
}

/** How many active users and service accounts hold a role. */
export async function activeMemberCount(tx: Tx, roleId: string): Promise<number | undefined> {
  const [r] = await tx<{ n: number }[]>`
    SELECT (SELECT count(*) FROM users WHERE role_id = ${roleId} AND disabled_at IS NULL)::int
         + (SELECT count(*) FROM service_accounts WHERE role_id = ${roleId} AND disabled_at IS NULL)::int AS n`;
  return r?.n;
}

/** Every role (live ones only, unless `includeArchived`), system roles first, each with how many active members hold it. */
export async function rolesWithMemberCounts(tx: Tx, includeArchived: boolean): Promise<(RoleRow & { members: number })[]> {
  return tx<(RoleRow & { members: number })[]>`
    SELECT r.id, r.key, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at, r.archived_at, r.access_version::text,
      ((SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.disabled_at IS NULL)
       + (SELECT count(*) FROM service_accounts s WHERE s.role_id = r.id AND s.disabled_at IS NULL))::int AS members
    FROM roles r WHERE ${includeArchived ? tx`true` : tx`r.archived_at IS NULL`}
    ORDER BY r.is_system DESC, r.created_at, r.key`;
}

export async function insertRole(tx: Tx, r: { tenantId: string; id: string; key: string; name: string; description: string; permissions: Permission[];
  createdBy: string | null }): Promise<void> {
  await tx`INSERT INTO roles (tenant_id, id, key, name, description, permissions, created_by)
             VALUES (${r.tenantId}, ${r.id}, ${r.key}, ${r.name}, ${r.description}, ${r.permissions}, ${r.createdBy})`;
}

export async function updateRoleDefinition(tx: Tx, id: string, name: string, description: string, permissions: Permission[]): Promise<void> {
  await tx`UPDATE roles SET name = ${name}, description = ${description}, permissions = ${permissions} WHERE id = ${id}`;
}

export async function archiveRoleRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE roles SET archived_at = now() WHERE id = ${id}`;
}

// --- Object and field rules -------------------------------------------------------------------------

export interface RoleRuleRow { kind: "o" | "f"; id: string; can_read: boolean | null; can_write: boolean | null; can_archive: boolean | null; access: FieldLimit | null }

/** A role's object rules (kind "o", by object ID) and field rules (kind "f", by field ID). */
export async function roleRuleRows(tx: Tx, roleId: string): Promise<RoleRuleRow[]> {
  return tx<RoleRuleRow[]>`
    SELECT 'o' AS kind, object_id AS id, can_read, can_write, can_archive, NULL::text AS access FROM role_object_permissions WHERE role_id = ${roleId}
    UNION ALL
    SELECT 'f', field_id, NULL, NULL, NULL, access FROM role_field_permissions WHERE role_id = ${roleId}`;
}

/** Sets a role's rule on one object. The rule tables' triggers (migration 008) move the role to a new access_version. */
export async function upsertObjectRule(tx: Tx, r: { tenantId: string; roleId: string; objectId: string; read: boolean | null; write: boolean | null;
  archive: boolean | null; updatedBy: string | null }): Promise<void> {
  await tx`INSERT INTO role_object_permissions (tenant_id, role_id, object_id, can_read, can_write, can_archive, updated_by)
               VALUES (${r.tenantId}, ${r.roleId}, ${r.objectId}, ${r.read}, ${r.write}, ${r.archive}, ${r.updatedBy})
               ON CONFLICT (tenant_id, role_id, object_id) DO UPDATE SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
                 can_archive = EXCLUDED.can_archive, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function deleteObjectRule(tx: Tx, roleId: string, objectId: string): Promise<void> {
  await tx`DELETE FROM role_object_permissions WHERE role_id = ${roleId} AND object_id = ${objectId}`;
}

/** Sets a role's limit on one field. */
export async function upsertFieldRule(tx: Tx, r: { tenantId: string; roleId: string; fieldId: string; access: FieldLimit; updatedBy: string | null }): Promise<void> {
  await tx`INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access, updated_by)
               VALUES (${r.tenantId}, ${r.roleId}, ${r.fieldId}, ${r.access}, ${r.updatedBy})
               ON CONFLICT (tenant_id, role_id, field_id) DO UPDATE SET access = EXCLUDED.access, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function deleteFieldRule(tx: Tx, roleId: string, fieldId: string): Promise<void> {
  await tx`DELETE FROM role_field_permissions WHERE role_id = ${roleId} AND field_id = ${fieldId}`;
}
