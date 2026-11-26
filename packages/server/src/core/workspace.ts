import type { Tx } from "../db/pool.js";
import { db } from "../db/pool.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { audit } from "./audit.js";
import { ACTIVITY_TYPES, DEFAULT_PIPELINE } from "./catalog.js";
import { OWNER_ROLE, can, systemCtx, type Ctx } from "./context.js";
import { createTenantKey } from "./encryption.js";
import { createApiKey } from "./keys.js";
import { loadRoleRules, memberPermissions } from "./access.js";
import { insertDefaultPipeline, insertStage } from "./queries/pipelines.js";
import { keysForAccessReview, revokeKeysOf } from "./queries/keys.js";
import { deleteMemberSet, insertMemberSet, roleForShare } from "./queries/roles.js";
import {
  enterWorkspace, insertServiceAccount, insertSystemActivityType, insertTenant, insertUser, memberSignInFacts, membersWithRoles, memberWithRole,
  otherActiveOwnersForUpdate, registerTenant, setMemberActive, setMemberRole, updateSignInSettings, workspaceRow, type MemberRow,
} from "./queries/workspace.js";
import { assertCoversRole, memberRef, publicRules, resolveRole, seedSystemRoles, type RoleRow } from "./roles.js";
import { loadSchema, seedStandardObjects } from "./schema.js";
import { canonicalEmail, memberEmailProblem } from "../auth/identity.js";
import { revokeUserSessions } from "../auth/sessions.js";
import { listGrants, revokeUserGrants } from "../oauth/grants.js";

export interface CreateWorkspaceInput { name: string; ownerEmail: string; ownerName: string; currency?: string }

/**
 * How a workspace comes to be: `bootstrap` (the operator's command, the default) mints the owner's two
 * keys and returns their secrets once, for a terminal; `sign_up` (a person on the sign-in page, ADR 0018)
 * mints none, since a browser page is no place to show a secret: the owner makes keys later, signed in.
 */
export interface CreateWorkspaceOptions { via?: "bootstrap" | "sign_up"; requestId?: string }

function checkedWorkspaceInput(input: CreateWorkspaceInput) {
  if (!input.name?.trim()) throw unprocessable("Workspace name is required");
  const emailProblem = memberEmailProblem(input.ownerEmail);
  if (emailProblem) throw unprocessable(`Owner email: ${emailProblem}`);
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw unprocessable("currency must be an ISO 4217 code");
  return { currency };
}

/**
 * Creates a workspace in the caller's transaction, which it leaves inside the new workspace: tenant,
 * system roles, owner, standard objects, default pipeline and data key, and (at bootstrap only) two keys
 * for the owner, admin and ops, whose secrets are returned once and never stored.
 */
export async function createWorkspaceIn(tx: Tx, input: CreateWorkspaceInput, opts: CreateWorkspaceOptions = {}) {
  const { currency } = checkedWorkspaceInput(input);
  const via = opts.via ?? "bootstrap";
  const tenantId = uuidv7();
  const ownerId = uuidv7();
  await registerTenant(tx, tenantId);
  await enterWorkspace(tx, tenantId);
  await insertTenant(tx, tenantId, input.name, currency);
  await seedSystemRoles(tx);
  const owner = await resolveRole(tx, OWNER_ROLE);
  await insertUser(tx, { tenantId, id: ownerId, email: input.ownerEmail, name: input.ownerName, roleId: owner.id });
  const ctx: Ctx = { ...systemCtx(tenantId, opts.requestId ?? "bootstrap"), ...(via === "sign_up" ? { surface: "web" as const } : {}) };
  await seedStandardObjects(tx, tenantId);
  for (const t of ACTIVITY_TYPES) {
    await insertSystemActivityType(tx, { tenantId, key: t.key, label: t.label, editable: "editable" in t ? Boolean(t.editable) : false });
  }
  const pipelineId = uuidv7();
  await insertDefaultPipeline(tx, tenantId, pipelineId, DEFAULT_PIPELINE.name);
  let position = 0;
  for (const s of DEFAULT_PIPELINE.stages) {
    await insertStage(tx, { tenantId, id: uuidv7(), pipelineId, name: s.name, position: position++, category: s.category, probability: s.probability });
  }
  await createTenantKey(tx, tenantId);
  await audit(tx, ctx, { action: "workspace.created", details: { name: input.name, via } });
  let keys: { admin: string; ops: string } | null = null;
  if (via === "bootstrap") {
    const ownerCtx: Ctx = { ...ctx, actor: { type: "user", id: ownerId, role: OWNER_ROLE } };
    const adminKey = await createApiKey(tx, ownerCtx, { name: "Owner admin key", scopes: ["admin", "ops:write", "ops:read", "restricted:read"] }, { bootstrap: true });
    const opsKey = await createApiKey(tx, ownerCtx, { name: "Owner ops key", scopes: ["ops:write", "ops:read"] }, { bootstrap: true });
    keys = { admin: adminKey.secret, ops: opsKey.secret };
  }
  return {
    tenantId, ownerId,
    workspace: { id: encodeId("ws", tenantId), name: input.name, currency },
    owner: { id: encodeId("usr", ownerId), email: input.ownerEmail },
    keys,
  };
}

/** Creates a workspace as the operator does (`bootstrap`, the demo seed, tests): in its own transaction, with the owner's two keys. */
export async function createWorkspace(input: CreateWorkspaceInput) {
  checkedWorkspaceInput(input);
  return db().begin(async (tx) => {
    const ws = await createWorkspaceIn(tx, input);
    return { workspace: ws.workspace, owner: ws.owner, keys: ws.keys! };
  });
}

export async function getWorkspace(tx: Tx) {
  const t = await workspaceRow(tx);
  if (!t) throw new Error("workspace missing");
  return { id: encodeId("ws", t.tenant_id), name: t.name, kind: t.kind, currency: t.currency, modules: t.modules,
    schema_version: Number(t.schema_version), created_at: t.created_at.toISOString(),
    sign_in: { password: t.password_sign_in, sso: t.sso_sign_in, sso_allowed_domains: t.sso_allowed_domains, oauth_apps: t.oauth_apps, oauth_scopes: t.oauth_scopes } };
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * How members of this workspace may sign in: password on or off, single sign-on on or off, and the
 * email domains SSO accepts here (empty: any the server accepts; it can only narrow the server's
 * OIDC_ALLOWED_DOMAINS). The server settings must allow a method too. Owners only: it decides how
 * every member, owners included, may prove who they are.
 */
export async function setSignInSettings(tx: Tx, ctx: Ctx, input: { password?: boolean; sso?: boolean; sso_allowed_domains?: string[];
  oauth_apps?: boolean; oauth_scopes?: string[] }) {
  if (ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can change how members sign in");
  if (input.password === undefined && input.sso === undefined && input.sso_allowed_domains === undefined && input.oauth_apps === undefined && input.oauth_scopes === undefined) {
    throw unprocessable("Send password, sso, sso_allowed_domains, oauth_apps and/or oauth_scopes");
  }
  // OAuth apps act through the MCP servers; an app can never change how members sign in or who may connect apps.
  if (ctx.oauth) throw forbidden("Connected apps can't change the workspace's sign-in or OAuth settings");
  const domains = input.sso_allowed_domains === undefined ? undefined : [...new Set(input.sso_allowed_domains.map((d) => canonicalEmail(d)))];
  const bad = domains?.filter((d) => !DOMAIN.test(d)) ?? [];
  if (bad.length) throw unprocessable(`Not an email domain (ASCII, e.g. example.com): ${bad.slice(0, 5).join(", ")}`);
  await updateSignInSettings(tx, { password: input.password ?? null, sso: input.sso ?? null, ssoAllowedDomains: domains ?? null,
    oauthApps: input.oauth_apps ?? null, oauthScopes: input.oauth_scopes ? [...new Set(input.oauth_scopes)] : null });
  // Turning apps off ends every connection now; narrowing scopes applies to existing tokens on their next request.
  const appsRevoked = input.oauth_apps === false ? await revokeUserGrants(tx, null, "workspace_disabled") : 0;
  await audit(tx, ctx, { action: "workspace.sign_in_changed", details: { ...(input.password !== undefined ? { password: input.password } : {}),
    ...(input.sso !== undefined ? { sso: input.sso } : {}), ...(domains ? { sso_allowed_domains: domains } : {}),
    ...(input.oauth_apps !== undefined ? { oauth_apps: input.oauth_apps, apps_revoked: appsRevoked } : {}),
    ...(input.oauth_scopes ? { oauth_scopes: [...new Set(input.oauth_scopes)] } : {}) } });
  return (await getWorkspace(tx)).sign_in;
}

// --- Members ------------------------------------------------------------------------------------

type MemberType = "user" | "service_account";

const memberId = (type: MemberType, id: string) => encodeId(type === "user" ? "usr" : "svc", id);

const roleRef = (m: MemberRow) => ({ key: m.role_key, name: m.role_name });

/** The keys of the permission sets a member holds, in key order. */
const setKeys = (m: { sets: { key: string }[] }) => m.sets.map((x) => x.key);

/** A member can hold this many permission sets; every request combines them, so the number is bounded. */
const MAX_SETS_PER_MEMBER = 20;

/**
 * Sign-in facts per member, for a periodic access review (no secrets): whether a password is set,
 * whether single sign-on is linked, the last sign-in and how many browser sessions are live.
 */
async function signInFacts(tx: Tx): Promise<Map<string, { has_password: boolean; sso_linked: boolean; last_sign_in_at: string | null; active_sessions: number }>> {
  const rows = await memberSignInFacts(tx);
  return new Map(rows.map((r) => [r.id, { has_password: Boolean(r.has_password), sso_linked: Boolean(r.sso_linked),
    last_sign_in_at: r.last_sign_in_at?.toISOString() ?? null, active_sessions: r.active_sessions }]));
}

export async function listMembers(tx: Tx) {
  const [users, services, facts] = [await membersWithRoles(tx, "user"), await membersWithRoles(tx, "service_account"), await signInFacts(tx)];
  return {
    users: users.map((u) => ({ id: memberId("user", u.id), email: u.email, name: u.name, role: u.role_key, role_name: u.role_name,
      permission_sets: setKeys(u), active: !u.disabled_at, sign_in: facts.get(u.id) })),
    service_accounts: services.map((s) => ({ id: memberId("service_account", s.id), name: s.name, role: s.role_key, role_name: s.role_name,
      permission_sets: setKeys(s), active: !s.disabled_at })),
  };
}

/** Everything granted to a role is checked against the caller here: nobody hands out a permission, or record access, they don't hold. */
async function assertCanAssign(tx: Tx, ctx: Ctx, role: RoleRow, type: MemberType) {
  if (role.key === OWNER_ROLE) {
    if (type === "service_account") throw unprocessable("Service accounts can't hold the owner role");
    if (ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can grant the owner role");
  }
  const missing = role.permissions.filter((p) => !ctx.permissions.has(p));
  if (missing.length) throw forbidden(`The ${role.key} role has permissions you don't hold: ${missing.join(", ")}`);
  await assertCoversRole(tx, ctx, await loadSchema(tx), role, `The ${role.key} role`);
}

/**
 * Resolves the permission sets named for a member (keys or pset_… IDs), each locked so it can't be
 * archived meanwhile. `held` are the sets the member already has: keeping one needs no new grant, so
 * only the others are checked against the caller, who can't hand out a permission or record access
 * they don't hold, through a set as through a role.
 */
async function setsToAssign(tx: Tx, ctx: Ctx, refs: unknown, held: ReadonlySet<string> = new Set()): Promise<RoleRow[]> {
  if (!Array.isArray(refs) || refs.some((r) => typeof r !== "string")) throw unprocessable("permission_sets must be a list of permission set keys or pset_… IDs");
  if (refs.length > MAX_SETS_PER_MEMBER) throw unprocessable(`A member can hold at most ${MAX_SETS_PER_MEMBER} permission sets`);
  const out = new Map<string, RoleRow>();
  for (const ref of refs as string[]) {
    const set = await resolveRole(tx, ref, "share", "permission_set").catch(() => { throw unprocessable(`permission_sets: no permission set "${ref}"`); });
    out.set(set.id, set);
  }
  const schema = await loadSchema(tx);
  for (const set of out.values()) {
    if (held.has(set.id)) continue;
    const missing = set.permissions.filter((p) => !ctx.permissions.has(p));
    if (missing.length) throw forbidden(`The ${set.key} permission set has permissions you don't hold: ${missing.join(", ")}`);
    await assertCoversRole(tx, ctx, schema, set, `The ${set.key} permission set`);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function giveSets(tx: Tx, ctx: Ctx, type: MemberType, memberUuid: string, sets: RoleRow[]) {
  for (const set of sets) await insertMemberSet(tx, { tenantId: ctx.tenantId, type, memberId: memberUuid, setId: set.id, assignedBy: ctx.actor.id });
}

export async function addMember(tx: Tx, ctx: Ctx, input: { email: string; name: string; role: string; permission_sets?: string[]; send_invite?: boolean }) {
  if (!can(ctx, "members:manage")) throw forbidden("Adding members needs the members:manage permission");
  const emailProblem = memberEmailProblem(input.email);
  if (emailProblem) throw unprocessable(emailProblem);
  const role = await resolveRole(tx, input.role, "share");
  await assertCanAssign(tx, ctx, role, "user");
  const sets = input.permission_sets !== undefined ? await setsToAssign(tx, ctx, input.permission_sets) : [];
  const id = uuidv7();
  try {
    await insertUser(tx, { tenantId: ctx.tenantId, id, email: input.email, name: input.name ?? input.email, roleId: role.id });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A member with this email already exists");
    throw e;
  }
  await giveSets(tx, ctx, "user", id, sets);
  await audit(tx, ctx, { action: "member.added", objectType: "user", recordId: id,
    details: { role: role.key, permissions: role.permissions, ...(sets.length ? { permission_sets: sets.map((x) => x.key) } : {}),
      ...(input.send_invite ? { invitation: "queued" } : {}) } });
  return { id: memberId("user", id), email: input.email, name: input.name, role: role.key, role_name: role.name, permission_sets: sets.map((x) => x.key),
    active: true, ...(input.send_invite ? { invitation: "queued" } : {}) };
}

export async function addServiceAccount(tx: Tx, ctx: Ctx, input: { name: string; role: string; permission_sets?: string[] }) {
  if (!can(ctx, "members:manage")) throw forbidden("Adding service accounts needs the members:manage permission");
  if (!input.name?.trim()) throw unprocessable("name is required");
  const role = await resolveRole(tx, input.role, "share");
  await assertCanAssign(tx, ctx, role, "service_account");
  const sets = input.permission_sets !== undefined ? await setsToAssign(tx, ctx, input.permission_sets) : [];
  const id = uuidv7();
  try {
    await insertServiceAccount(tx, { tenantId: ctx.tenantId, id, name: input.name, roleId: role.id, createdBy: ctx.actor.id });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A service account with this name already exists");
    throw e;
  }
  await giveSets(tx, ctx, "service_account", id, sets);
  await audit(tx, ctx, { action: "service_account.created", objectType: "service_account", recordId: id,
    details: { role: role.key, permissions: role.permissions, ...(sets.length ? { permission_sets: sets.map((x) => x.key) } : {}) } });
  return { id: memberId("service_account", id), name: input.name, role: role.key, role_name: role.name, permission_sets: sets.map((x) => x.key), active: true };
}

/** A member's identity and role, locked for the rest of the transaction. */
export async function loadMember(tx: Tx, type: MemberType, id: string, lock = false) {
  return (await memberWithRole(tx, type, id, lock)) ?? null;
}

/** Parses a member ID: `usr_…` or `svc_…`, optionally restricted to one kind. */
export function parseMemberId(publicId: string, only?: MemberType): { type: MemberType; id: string } | null {
  const d = decodeId(publicId);
  if (!d || (d.prefix !== "usr" && d.prefix !== "svc")) return null;
  const type: MemberType = d.prefix === "usr" ? "user" : "service_account";
  return only && only !== type ? null : { type, id: d.uuid };
}

export interface UpdateMemberInput { role?: string; permission_sets?: string[]; active?: boolean }

/**
 * Changes a member's role, replaces the permission sets they hold, and/or turns them off or on. Disabling revokes every key the member
 * holds in the same transaction, so deprovisioning can't leave a working credential behind.
 */
export async function updateMember(tx: Tx, ctx: Ctx, publicId: string, patch: UpdateMemberInput, only?: MemberType) {
  if (!can(ctx, "members:manage")) throw forbidden("Changing members needs the members:manage permission");
  const ref = parseMemberId(publicId, only);
  if (!ref) throw notFound("Member");
  const current = await loadMember(tx, ref.type, ref.id, true);
  if (!current) throw notFound("Member");
  if (patch.role === undefined && patch.active === undefined && patch.permission_sets === undefined) throw unprocessable("Send role, permission_sets and/or active");
  if (ctx.actor.type === ref.type && ctx.actor.id === ref.id) throw forbidden("You can't change your own role or permission sets, or disable yourself");
  // Acting on someone with more access than you is a way around the grant rules (and lets you lock out admins).
  // Their access is their role and every permission set they hold.
  const over = memberPermissions(current).filter((p) => !ctx.permissions.has(p));
  if (over.length) throw forbidden(`This member has permissions you don't hold: ${over.join(", ")}`);
  await assertCoversRole(tx, ctx, await loadSchema(tx), memberRef(current), "This member");
  if (current.role_key === OWNER_ROLE && ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can change or disable an owner");

  const heldSets = new Set(current.sets.map((x) => x.id));
  const sets = patch.permission_sets !== undefined ? await setsToAssign(tx, ctx, patch.permission_sets, heldSets) : null;
  const setsAdded = sets?.filter((x) => !heldSets.has(x.id)) ?? [];
  const setsRemoved = sets ? current.sets.filter((x) => !sets.some((y) => y.id === x.id)) : [];

  const role = patch.role !== undefined ? await resolveRole(tx, patch.role, "share") : null;
  const roleChanges = role !== null && role.id !== current.role_id;
  const wasActive = !current.disabled_at;
  const active = patch.active ?? wasActive;
  if (roleChanges) await assertCanAssign(tx, ctx, role, ref.type);
  if (active && !wasActive && !roleChanges) {
    // Re-enabling grants the member's role again; it must still exist and be grantable by the caller.
    const held = await roleForShare(tx, current.role_id);
    if (!held || held.archived_at) throw unprocessable("This member's role was archived; re-enable them with a new role");
    await assertCanAssign(tx, ctx, held, ref.type);
  }
  const losesOwner = current.role_key === OWNER_ROLE && wasActive && (!active || roleChanges);
  if (losesOwner) {
    const others = await otherActiveOwnersForUpdate(tx, ref.id);
    if (others.length === 0) throw conflict("This is the last active owner; make someone else an owner first");
  }

  const objectType = ref.type;
  let keysRevoked = 0;
  let sessionsRevoked = 0;
  let appsRevoked = 0;
  if (roleChanges) {
    await setMemberRole(tx, ref.type, ref.id, role.id);
    await audit(tx, ctx, { action: `${ref.type === "user" ? "member" : "service_account"}.role_changed`, objectType, recordId: ref.id,
      details: { from: current.role_key, to: role.key,
        permissions_added: role.permissions.filter((p) => !current.permissions.includes(p)),
        permissions_removed: current.permissions.filter((p) => !role.permissions.includes(p)) } });
  }
  if (setsAdded.length || setsRemoved.length) {
    await giveSets(tx, ctx, ref.type, ref.id, setsAdded);
    for (const x of setsRemoved) await deleteMemberSet(tx, ref.type, ref.id, x.id);
    const gained = [...new Set(setsAdded.flatMap((x) => x.permissions))];
    await audit(tx, ctx, { action: `${ref.type === "user" ? "member" : "service_account"}.permission_sets_changed`, objectType, recordId: ref.id,
      details: { added: setsAdded.map((x) => x.key), removed: setsRemoved.map((x) => x.key), permissions_in_added_sets: gained } });
  }
  if (active !== wasActive) {
    await setMemberActive(tx, ref.type, ref.id, active);
    if (!active) {
      keysRevoked = await revokeKeysOf(tx, ref.type, ref.id);
      // Browser sessions end in the same transaction, so a disabled person is signed out everywhere at once.
      if (ref.type === "user") sessionsRevoked = await revokeUserSessions(tx, ref.id, "member_disabled");
      // And every app they connected over OAuth, with its tokens.
      if (ref.type === "user") appsRevoked = await revokeUserGrants(tx, ref.id, "member_disabled");
    }
    await audit(tx, ctx, { action: `${ref.type === "user" ? "member" : "service_account"}.${active ? "enabled" : "disabled"}`, objectType, recordId: ref.id,
      details: active ? { role: (role ?? { key: current.role_key }).key }
        : { role: current.role_key, keys_revoked: keysRevoked, ...(ref.type === "user" ? { sessions_revoked: sessionsRevoked, apps_revoked: appsRevoked } : {}) } });
  }
  const after = (await membersWithRoles(tx, ref.type)).find((m) => m.id === ref.id)!;
  return { id: memberId(ref.type, ref.id), ...(after.email ? { email: after.email } : {}), name: after.name, role: after.role_key,
    role_name: after.role_name, permission_sets: setKeys(after), active: !after.disabled_at, ...(keysRevoked ? { keys_revoked: keysRevoked } : {}),
    ...(sessionsRevoked ? { sessions_revoked: sessionsRevoked } : {}), ...(appsRevoked ? { apps_revoked: appsRevoked } : {}) };
}

/**
 * Who can do what: every member and service account with their role, permissions and keys.
 * This is what an operator exports for a periodic access review.
 */
export async function accessReview(tx: Tx, ctx: Ctx) {
  if (!can(ctx, "audit:read")) throw forbidden("The access review needs the audit:read permission");
  const keys = await keysForAccessReview(tx);
  const keysOf = (type: MemberType, id: string) => keys.filter((k) => k.owner_type === type && k.owner_id === id).map((k) => ({
    id: encodeId("key", k.id), name: k.name, scopes: k.scopes, environment: k.environment, created_at: k.created_at.toISOString(),
    last_used_at: k.last_used_at?.toISOString() ?? null, expires_at: k.expires_at?.toISOString() ?? null,
    revoked_at: k.revoked_at?.toISOString() ?? null,
    usable: !k.revoked_at && (!k.expires_at || k.expires_at.getTime() > Date.now()),
  }));
  // Object and field rules are part of what a member can do, so the review shows them with the permissions.
  const schema = await loadSchema(tx);
  const facts = await signInFacts(tx);
  // Apps connected over OAuth act as their member, so they are part of what each member can do.
  const grants = await listGrants(tx, null);
  const members = [...(await membersWithRoles(tx, "user")).map((m) => ({ m, type: "user" as const })),
    // "service_account" is a member type here, not a credential, so the secret scanner's match on the next line is silenced.
    ...(await membersWithRoles(tx, "service_account")).map((m) => ({ m, type: "service_account" as const }))]; // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account
  const out = [];
  for (const { m, type } of members) {
    // Each set the member holds, with what it adds; effective_permissions is the role's and every set's together.
    const sets = [];
    for (const x of m.sets) {
      sets.push({ key: x.key, name: x.name, permissions: x.permissions, record_rules: publicRules(schema, await loadRoleRules(tx, ctx.tenantId, x.id, x.access_version)) });
    }
    out.push({
      id: memberId(type, m.id), type, ...(m.email ? { email: m.email } : {}), name: m.name, active: !m.disabled_at,
      role: roleRef(m), permissions: m.permissions, record_rules: publicRules(schema, await loadRoleRules(tx, ctx.tenantId, m.role_id, m.access_version)),
      permission_sets: sets, effective_permissions: memberPermissions(m),
      created_at: m.created_at.toISOString(), keys: keysOf(type, m.id),
      ...(type === "user" ? { sign_in: facts.get(m.id), apps: grants.filter((g) => g.member === memberId("user", m.id)) } : {}),
    });
  }
  return { generated_at: new Date().toISOString(), members: out };
}
