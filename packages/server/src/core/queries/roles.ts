import type { Tx } from "../../db/pool.js";
import type { FieldLimit, Permission } from "../context.js";

/**
 * The SQL of roles and their object and field rules (core/roles.ts, core/access.ts; ADR 0008, ADR 0012).
 * The code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

/** A role (every member has exactly one) or a permission set (a member can hold several; ADR 0013). Both are rows of `roles`. */
export type RoleKind = "role" | "permission_set";

export interface RoleRow {
  id: string; key: string; name: string; description: string; permissions: Permission[]; is_system: boolean;
  created_at: Date; updated_at: Date; archived_at: Date | null; access_version: string;
}

type MemberType = "user" | "service_account";

/** The columns of a RoleRow, as a fragment of the query that selects them. */
const roleColumns = (tx: Tx) => tx`id, key, name, description, permissions, is_system, created_at, updated_at, archived_at, access_version::text`;

// --- Roles ------------------------------------------------------------------------------------------

/** Seeds the system roles for the tenant in `app.tenant_id` (app.seed_system_roles, migration 006). */
export async function insertSystemRoles(tx: Tx): Promise<void> {
  await tx`SELECT app.seed_system_roles()`;
}

/** A live (not archived) role, or permission set, by ID or key; `lock` takes a row lock on it. */
export async function liveRole(tx: Tx, ref: { id: string } | { key: string }, lock: "share" | "update" | null, kind: RoleKind = "role"): Promise<RoleRow | undefined> {
  const by = "id" in ref ? tx`id = ${ref.id}` : tx`key = ${ref.key}`;
  const suffix = lock === "update" ? tx`FOR UPDATE` : lock === "share" ? tx`FOR SHARE` : tx``;
  const [row] = await tx<RoleRow[]>`SELECT ${roleColumns(tx)} FROM roles WHERE ${by} AND kind = ${kind} AND archived_at IS NULL ${suffix}`;
  return row;
}

/** A role by ID, archived or not, locked against changes (FOR SHARE) for the rest of the transaction. */
export async function roleForShare(tx: Tx, id: string): Promise<RoleRow | undefined> {
  const [row] = await tx<RoleRow[]>`SELECT id, key, name, description, permissions, is_system, created_at, updated_at, archived_at, access_version::text
                                     FROM roles WHERE id = ${id} FOR SHARE`;
  return row;
}

/** How many active users and service accounts hold a role, or (kind "permission_set") a permission set. */
export async function activeMemberCount(tx: Tx, roleId: string, kind: RoleKind = "role"): Promise<number | undefined> {
  const [r] = kind === "role"
    ? await tx<{ n: number }[]>`
        SELECT (SELECT count(*) FROM users WHERE role_id = ${roleId} AND disabled_at IS NULL)::int
             + (SELECT count(*) FROM service_accounts WHERE role_id = ${roleId} AND disabled_at IS NULL)::int AS n`
    : await tx<{ n: number }[]>`
        SELECT (SELECT count(*) FROM member_permission_sets h JOIN users u ON u.tenant_id = h.tenant_id AND u.id = h.user_id
                WHERE h.permission_set_id = ${roleId} AND u.disabled_at IS NULL)::int
             + (SELECT count(*) FROM member_permission_sets h JOIN service_accounts s ON s.tenant_id = h.tenant_id AND s.id = h.service_account_id
                WHERE h.permission_set_id = ${roleId} AND s.disabled_at IS NULL)::int AS n`;
  return r?.n;
}

/** Every role (live ones only, unless `includeArchived`), system roles first, each with how many active members hold it. */
export async function rolesWithMemberCounts(tx: Tx, includeArchived: boolean, kind: RoleKind = "role"): Promise<(RoleRow & { members: number })[]> {
  const members = kind === "role"
    ? tx`((SELECT count(*) FROM users u WHERE u.role_id = r.id AND u.disabled_at IS NULL)
         + (SELECT count(*) FROM service_accounts s WHERE s.role_id = r.id AND s.disabled_at IS NULL))::int`
    : tx`((SELECT count(*) FROM member_permission_sets h JOIN users u ON u.tenant_id = h.tenant_id AND u.id = h.user_id
           WHERE h.permission_set_id = r.id AND u.disabled_at IS NULL)
         + (SELECT count(*) FROM member_permission_sets h JOIN service_accounts s ON s.tenant_id = h.tenant_id AND s.id = h.service_account_id
            WHERE h.permission_set_id = r.id AND s.disabled_at IS NULL))::int`;
  return tx<(RoleRow & { members: number })[]>`
    SELECT r.id, r.key, r.name, r.description, r.permissions, r.is_system, r.created_at, r.updated_at, r.archived_at, r.access_version::text,
      ${members} AS members
    FROM roles r WHERE r.kind = ${kind} AND ${includeArchived ? tx`true` : tx`r.archived_at IS NULL`}
    ORDER BY r.is_system DESC, r.created_at, r.key`;
}

export async function insertRole(tx: Tx, r: { tenantId: string; id: string; key: string; name: string; description: string; permissions: Permission[];
  createdBy: string | null; kind?: RoleKind }): Promise<void> {
  await tx`INSERT INTO roles (tenant_id, id, key, name, description, permissions, created_by, kind)
             VALUES (${r.tenantId}, ${r.id}, ${r.key}, ${r.name}, ${r.description}, ${r.permissions}, ${r.createdBy}, ${r.kind ?? "role"})`;
}

export async function updateRoleDefinition(tx: Tx, id: string, name: string, description: string, permissions: Permission[]): Promise<void> {
  await tx`UPDATE roles SET name = ${name}, description = ${description}, permissions = ${permissions} WHERE id = ${id}`;
}

export async function archiveRoleRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE roles SET archived_at = now() WHERE id = ${id}`;
}

// --- Object and field rules -------------------------------------------------------------------------

export interface RoleRuleRow { kind: "o" | "f"; id: string; can_read: boolean | null; can_write: boolean | null; can_archive: boolean | null;
  access: FieldLimit | null; object_id: string | null }

/** A role's (or permission set's) object rules (kind "o", by object ID) and field rules (kind "f", by field ID, with the field's object). */
export async function roleRuleRows(tx: Tx, roleId: string): Promise<RoleRuleRow[]> {
  return tx<RoleRuleRow[]>`
    SELECT 'o' AS kind, object_id AS id, can_read, can_write, can_archive, NULL::text AS access, NULL::uuid AS object_id
    FROM role_object_permissions WHERE role_id = ${roleId}
    UNION ALL
    SELECT 'f', p.field_id, NULL, NULL, NULL, p.access, f.object_id
    FROM role_field_permissions p JOIN fields f ON f.tenant_id = p.tenant_id AND f.id = p.field_id WHERE p.role_id = ${roleId}`;
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

// --- Permission sets held by members (ADR 0013) -----------------------------------------------------

/** A permission set a member holds: enough to combine it with their role (core/access.ts loadMemberAccess). */
export interface HeldSetRow { id: string; key: string; name: string; permissions: Permission[]; access_version: string }

/**
 * The live permission sets a member holds, as a JSON column named `sets`, for a query whose member row is
 * `m` (a user, or a service account when `type` says so). Every query that reads a member's role selects
 * it too, so nothing decides a member's access from their role alone.
 */
export const memberSetsColumn = (tx: Tx, type: MemberType = "user") => tx`
  (SELECT coalesce(json_agg(json_build_object('id', ps.id, 'key', ps.key, 'name', ps.name, 'permissions', ps.permissions,
            'access_version', ps.access_version::text) ORDER BY ps.key), '[]'::json)
   FROM member_permission_sets h JOIN roles ps ON ps.tenant_id = h.tenant_id AND ps.id = h.permission_set_id
   WHERE h.tenant_id = m.tenant_id AND ${type === "user" ? tx`h.user_id = m.id` : tx`h.service_account_id = m.id`} AND ps.archived_at IS NULL) AS sets`;

/** Gives a member a permission set. Giving one they already hold changes nothing. */
export async function insertMemberSet(tx: Tx, r: { tenantId: string; type: MemberType; memberId: string; setId: string; assignedBy: string | null }): Promise<void> {
  if (r.type === "user") {
    await tx`INSERT INTO member_permission_sets (tenant_id, permission_set_id, user_id, assigned_by)
               VALUES (${r.tenantId}, ${r.setId}, ${r.memberId}, ${r.assignedBy}) ON CONFLICT DO NOTHING`;
  } else {
    await tx`INSERT INTO member_permission_sets (tenant_id, permission_set_id, service_account_id, assigned_by)
               VALUES (${r.tenantId}, ${r.setId}, ${r.memberId}, ${r.assignedBy}) ON CONFLICT DO NOTHING`;
  }
}

/** Takes a permission set away from a member. */
export async function deleteMemberSet(tx: Tx, type: MemberType, memberId: string, setId: string): Promise<void> {
  if (type === "user") await tx`DELETE FROM member_permission_sets WHERE user_id = ${memberId} AND permission_set_id = ${setId}`;
  else await tx`DELETE FROM member_permission_sets WHERE service_account_id = ${memberId} AND permission_set_id = ${setId}`;
}
