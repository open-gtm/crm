export type Scope = "admin" | "ops:write" | "ops:read" | "restricted:read";
export type Surface = "api" | "cli" | "admin-mcp" | "ops-mcp" | "automation" | "system" | "web" | "oauth";
/** How a browser session was signed in (ADR 0009). */
export type SignInMethod = "email_code" | "email_link" | "password" | "oidc" | "server_link";
export type ActorType = "user" | "service_account" | "system" | "automation";

export const ALL_SCOPES: Scope[] = ["admin", "ops:write", "ops:read", "restricted:read"];

/**
 * Everything a role can be allowed to do. A role is a named set of these (see core/roles.ts);
 * workspaces define their own roles from this list. Keep it in step with the CHECK constraint
 * on roles.permissions.
 */
export const PERMISSIONS = {
  "records:read": "Read records, the schema, pipelines and events",
  "records:write": "Create and update records and run sales operations",
  "records:archive": "Archive records",
  "restricted:read": "See the values of restricted fields",
  "schema:manage": "Change objects, fields, pipelines and modules",
  "members:manage": "Add, change and disable members and service accounts",
  "roles:manage": "Create and change roles and permission sets",
  "keys:manage": "Create, rotate and revoke API keys for other members, and list all keys",
  "webhooks:manage": "Manage webhook endpoints and their deliveries",
  "automations:manage": "Manage automations",
  "alerts:manage": "Manage workspace alert rules",
  "audit:read": "Read the audit log, schema history and access review",
  "views:manage": "Create, change and delete views shared with the workspace",
  "connections:manage": "Create, change and test connections: stored credentials automations use to call other systems",
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
export const isPermission = (s: string): s is Permission => Object.hasOwn(PERMISSIONS, s);

/**
 * Permissions that reach record data on their own, so a role holding one must also hold what it
 * reaches: automations read, write and archive records (they run with those permissions), and
 * webhook payloads and alert backtests carry record contents. Without this, a role could read or
 * change records through configuration it manages. Kept in step with the CHECK on roles.permissions.
 */
export const PERMISSION_REQUIRES: Partial<Record<Permission, Permission[]>> = {
  "automations:manage": ["records:read", "records:write", "records:archive"],
  "webhooks:manage": ["records:read"],
  "alerts:manage": ["records:read"],
};

/** What a permission set lacks to satisfy PERMISSION_REQUIRES, in catalog order. Empty when it is complete. */
export function missingRequired(permissions: Iterable<string>): Permission[] {
  const have = new Set(permissions);
  const need = new Set<Permission>();
  for (const p of have) for (const r of (isPermission(p) ? PERMISSION_REQUIRES[p] : undefined) ?? []) if (!have.has(r)) need.add(r);
  return ALL_PERMISSIONS.filter((p) => need.has(p));
}

/**
 * What each key scope can unlock. A key's effective permissions are its member's role
 * permissions ∩ the permissions its scopes unlock, so a scope narrows a key and never widens it.
 * views:manage is unlocked by both ops:write and admin: shared views are workspace configuration, yet
 * not a grant, so a key for record work and a key for configuration may each change them. Managing a
 * view still needs records:read on its object, which admin alone does not unlock.
 */
export const SCOPE_PERMISSIONS: Record<Scope, Permission[]> = {
  "ops:read": ["records:read"],
  "ops:write": ["records:read", "records:write", "records:archive", "views:manage"],
  "restricted:read": ["restricted:read"],
  admin: ["schema:manage", "members:manage", "roles:manage", "keys:manage", "webhooks:manage", "automations:manage", "alerts:manage", "audit:read", "views:manage", "connections:manage"],
};

/** The built-in roles every workspace starts with. They cannot be edited; custom roles can. */
export const SYSTEM_ROLES: Record<"owner" | "admin" | "member" | "read_only", { name: string; description: string; permissions: Permission[] }> = {
  owner: { name: "Owner", description: "Full access. Only an owner can grant or remove the owner role.", permissions: ALL_PERMISSIONS },
  admin: { name: "Admin", description: "Full access to data and configuration.", permissions: ALL_PERMISSIONS },
  member: { name: "Member", description: "Works with records.", permissions: ["records:read", "records:write", "records:archive", "restricted:read"] },
  read_only: { name: "Read only", description: "Reads records.", permissions: ["records:read", "restricted:read"] },
};
export const OWNER_ROLE = "owner";

/** The permissions a set of key scopes can unlock, before the role is applied. */
export function permissionsForScopes(scopes: Iterable<Scope>): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of SCOPE_PERMISSIONS[s] ?? []) out.add(p);
  return out;
}

/**
 * The permissions that make a scope worth having. "ops:write" also unlocks reading, but a role that can only
 * read gains nothing from it. views:manage alone doesn't make admin worth having: without records:read, an
 * admin-only key could not use it, so a role whose only configuration permission is views:manage gets no admin key.
 */
const SCOPE_CORE: Record<Scope, Permission[]> = {
  ...SCOPE_PERMISSIONS,
  "ops:write": ["records:write", "records:archive", "views:manage"],
  admin: SCOPE_PERMISSIONS.admin.filter((p) => p !== "views:manage"),
};

/** True when a role with these permissions can use the scope at all. A key may only carry scopes its member's role can use. */
export function roleCanUseScope(rolePermissions: Iterable<string>, scope: Scope): boolean {
  const role = new Set(rolePermissions);
  return (SCOPE_CORE[scope] ?? []).some((p) => role.has(p));
}

/**
 * Effective access for a key: role permissions ∩ scope permissions, and the scopes the role can still use.
 * `granted` lists record permissions the role's object rules grant on some object (see core/access.ts):
 * they make a scope usable without becoming role-wide permissions.
 */
export function effectiveAccess(rolePermissions: Iterable<string>, keyScopes: Iterable<Scope>, granted: Iterable<Permission> = []):
  { permissions: Set<Permission>; scopes: Set<Scope> } {
  const role = new Set([...rolePermissions].filter(isPermission));
  const usable = new Set([...role, ...granted]);
  const permissions = new Set<Permission>();
  const scopes = new Set<Scope>();
  for (const s of keyScopes) {
    if (!roleCanUseScope(usable, s)) continue;
    scopes.add(s);
    for (const p of SCOPE_PERMISSIONS[s] ?? []) if (role.has(p)) permissions.add(p);
  }
  return { permissions, scopes };
}

export type RecordAction = "read" | "write" | "archive";
export const RECORD_ACTIONS: RecordAction[] = ["read", "write", "archive"];
/** null inherits the role's records:* permission for that action; true grants it on this object; false denies it. */
export interface ObjectRule { read: boolean | null; write: boolean | null; archive: boolean | null }
export type FieldLimit = "none" | "read";

/**
 * A role's per-object and per-field rules, keyed by object and field IDs, plus what the key's scopes
 * unlock (`unlocked`): an object rule can grant only what the key could use anyway. Absent on internal
 * contexts, which follow their permissions alone. Helpers are in core/access.ts.
 */
export interface RecordAccess {
  objects: ReadonlyMap<string, ObjectRule>;
  fields: ReadonlyMap<string, FieldLimit>;
  unlocked: ReadonlySet<RecordAction>;
  /** Changes whenever the rules do; part of the idempotency fingerprint. */
  version: string;
}

/** Who is acting, on which tenant, through which surface. Passed to every service call. */
export interface Ctx {
  tenantId: string;
  /**
   * `role` is the role's key (owner, admin, member, read_only or a custom role's key). `permissionSets` are the
   * keys of the permission sets the member holds on top of it (ADR 0013); absent means none.
   */
  actor: { type: ActorType; id: string | null; role: string; permissionSets?: string[] };
  keyId: string | null;
  /**
   * The browser session, when a signed-in person (not an API key) is acting. `signedInAt` is when they
   * proved who they are; every sign-in starts a new session, so it is never older than the session.
   */
  session?: { id: string; signedInAt: Date; method: SignInMethod };
  /**
   * The OAuth grant, when a member acts through an app they connected (ADR 0010): only through the MCP
   * servers, with the surface fixed by the token's resource. Audit entries name the grant and client.
   */
  oauth?: { grantId: string; clientId: string };
  /** The schema pack being applied or uninstalled, by name: its schema changes are recorded as the pack's. */
  pack?: string;
  /** What this request may do. Every authorization decision reads this, through `can`. */
  permissions: ReadonlySet<Permission>;
  /** Per-object and per-field rules of the role, when it has any. Read through core/access.ts. */
  records?: RecordAccess;
  /** The key's scopes that are still in effect. Used to pick a surface (admin or ops), not to authorize. */
  scopes: ReadonlySet<Scope>;
  surface: Surface;
  requestId: string;
  /** How many automation hops led to this change (0 for a person or key). Bounds automation loops. */
  causationDepth?: number;
  /** The automation acting, when surface is "automation". */
  automationId?: string;
}

export const can = (ctx: Ctx, permission: Permission): boolean => ctx.permissions.has(permission);

/**
 * Who is calling: the one identity that rate limits, costs, the heavy-request gate, idempotency and
 * confirm tokens key on. An API key is `key:<key ID>`. An app connected over OAuth is its grant,
 * `oauth:<grant ID>` (one approved connection; its refreshed tokens share it). Anything else with an
 * actor (a browser session) is the actor in its workspace, `user:<tenant>:<member>`: every session of
 * one member shares it, and no two members (or workspaces) do. A context with no actor ID (internal
 * work) is the workspace. Never empty.
 *
 * So a confirm token minted in one of a member's browser sessions works in their other sessions, never
 * for another member, and never for an API key or a connected app (not even the same member's: each is
 * its own credential, often with narrower scopes); one minted through a connected app works only
 * through that connection.
 */
export const credential = (ctx: Ctx): string =>
  ctx.keyId ? `key:${ctx.keyId}` : ctx.oauth ? `oauth:${ctx.oauth.grantId}`
    : ctx.actor.id ? `${ctx.actor.type}:${ctx.tenantId}:${ctx.actor.id}` : `${ctx.actor.type}@${ctx.tenantId}`;

/** True when `ctx` holds every permission in `permissions`. Used to stop anyone granting more than they hold. */
export const holdsAll = (ctx: Ctx, permissions: Iterable<string>): boolean => {
  for (const p of permissions) if (!isPermission(p) || !ctx.permissions.has(p)) return false;
  return true;
};

/** A copy of `ctx` limited to the given scopes (and the permissions they unlock that `ctx` already holds). */
export function narrowTo(ctx: Ctx, scopes: Scope[]): Ctx {
  const allowed = permissionsForScopes(scopes);
  const records = ctx.records && { ...ctx.records, unlocked: new Set(RECORD_ACTIONS.filter((a) => ctx.records!.unlocked.has(a) && allowed.has(`records:${a}`))) };
  return { ...ctx, scopes: new Set(scopes), permissions: new Set([...ctx.permissions].filter((p) => allowed.has(p))), ...(records ? { records } : {}) };
}

/** A copy of `ctx` without one permission, e.g. to render a record with restricted values redacted. */
export function without(ctx: Ctx, permission: Permission): Ctx {
  return { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== permission)),
    scopes: permission === "restricted:read" ? new Set([...ctx.scopes].filter((s) => s !== "restricted:read")) : ctx.scopes };
}

/** A copy of `ctx` that can also read restricted values. For internal use where the grant was checked earlier. */
export function withRestricted(ctx: Ctx): Ctx {
  return { ...ctx, permissions: new Set([...ctx.permissions, "restricted:read" as const]), scopes: new Set([...ctx.scopes, "restricted:read" as const]) };
}

/** A context for internal work (workers, bootstrap). `scopes` limits it; the default is everything. */
export function systemCtx(tenantId: string, requestId = "system", scopes: Scope[] = ALL_SCOPES): Ctx {
  return {
    tenantId,
    actor: { type: "system", id: null, role: OWNER_ROLE },
    keyId: null,
    permissions: permissionsForScopes(scopes),
    scopes: new Set(scopes),
    surface: "system",
    requestId,
  };
}

/** The user ID to use as a default owner or assignee, if the actor is a user. */
export const actorUserId = (ctx: Ctx): string | null => (ctx.actor.type === "user" ? ctx.actor.id : null);
