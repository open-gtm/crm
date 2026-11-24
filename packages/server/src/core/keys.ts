import { randomBytes } from "node:crypto";
import { db, type Tx } from "../db/pool.js";
import { forbidden, notFound, unprocessable } from "../lib/errors.js";
import { safeEqual, sha256 } from "../lib/crypto.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { accessShortfall, grantedPermissions, loadMemberAccess, recordAccess, roleCtx, unlockedBy } from "./access.js";
import { audit } from "./audit.js";
import { ALL_SCOPES, OWNER_ROLE, can, effectiveAccess, permissionsForScopes, roleCanUseScope, type Ctx, type Scope, type Surface } from "./context.js";
import {
  allApiKeys, apiKeyForUpdate, enterKeyWorkspace, expireKeyWithin, insertApiKey, keyByLookup, linkRotatedKey, memberRoleStatus, narrowToKeyLookup,
  revokeKey, touchKey, type Owner,
} from "./queries/keys.js";
import { loadSchema } from "./schema.js";

export type { Owner } from "./queries/keys.js";

/**
 * API keys look like `hlcrm_live_<12-char lookup><40-char secret>`. The prefix is easy for
 * secret scanners to recognize. Only a SHA-256 hash is stored; the key is shown once.
 */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_PATTERN = /^hlcrm_(live|test)_([0-9A-Za-z]{12})([0-9A-Za-z]{40})$/;

function base62(n: number): string {
  const bytes = randomBytes(n * 2);
  let out = "";
  for (let i = 0; out.length < n && i < bytes.length; i++) {
    if (bytes[i]! < 248) out += BASE62[bytes[i]! % 62];
  }
  return out.length === n ? out : base62(n);
}

/** Who a credential acts as. A key sets `keyId`; a browser session (core/sessions.ts) sets `session` instead. */
export interface Principal {
  tenantId: string;
  keyId: string | null;
  session?: Ctx["session"];
  actor: Ctx["actor"];
  scopes: Set<Scope>;
  permissions: Ctx["permissions"];
  records?: Ctx["records"];
}

/** The 12-character lookup part of a well-formed key, or null. Used to rate-limit failures before touching the database. */
export const keyLookup = (raw: string): string | null => KEY_PATTERN.exec(raw)?.[2] ?? null;

/**
 * Validates a presented key. Returns null for anything invalid, without saying why. The member's
 * role is read on every request, so role changes and disabling take effect immediately. Its object
 * and field rules come from a cache keyed by the role's access_version, which every rule change bumps.
 */
export async function authenticate(raw: string): Promise<Principal | null> {
  const m = KEY_PATTERN.exec(raw);
  if (!m) return null;
  const lookup = m[2]!;
  return db().begin(async (tx) => {
    await narrowToKeyLookup(tx, lookup);
    const key = await keyByLookup(tx, lookup);
    if (!key || !safeEqual(sha256(raw), key.secret_hash)) return null;
    if (key.revoked_at || (key.expires_at && key.expires_at.getTime() <= Date.now())) return null;
    await enterKeyWorkspace(tx, key.tenant_id);
    const owner = await keyOwner(tx, key.owner_type, key.owner_id);
    if (!owner || owner.disabled_at || owner.archived_at) return null;
    await touchKey(tx, key.id);
    return {
      tenantId: key.tenant_id,
      keyId: key.id,
      actor: actorOf(key.owner_type, key.owner_id, owner),
      ...(await memberAccess(tx, key.tenant_id, owner, key.scopes)),
    } satisfies Principal;
  });
}

type MemberType = "user" | "service_account";

/** Everything the member can do: their role and the permission sets they hold, combined (ADR 0013). */
const accessOf = (tx: Tx, tenantId: string, owner: Owner) =>
  loadMemberAccess(tx, tenantId, { id: owner.role_id, permissions: owner.permissions, access_version: owner.access_version }, owner.sets);

/** The actor of a request made as this member: their role's key and the keys of the sets they hold. */
export const actorOf = (type: MemberType, id: string, owner: Owner): Ctx["actor"] =>
  ({ type, id, role: owner.role, ...(owner.sets.length ? { permissionSets: owner.sets.map((s) => s.key) } : {}) });

/**
 * A member's effective access through a credential holding `scopes`: the permissions of their role and
 * permission sets ∩ what the scopes unlock, the scopes those can use, and their combined object and field rules.
 */
export async function memberAccess(tx: Tx, tenantId: string, owner: Owner, scopes: Iterable<Scope>):
  Promise<Pick<Principal, "scopes" | "permissions" | "records">> {
  const member = await accessOf(tx, tenantId, owner);
  const access = effectiveAccess(member.permissions, scopes, grantedPermissions(member.rules));
  const records = recordAccess(member.rules, unlockedBy(permissionsForScopes(access.scopes)), member.version);
  return { scopes: access.scopes, permissions: access.permissions, ...(records ? { records } : {}) };
}

/** A key owner's (or session holder's) role (key, permissions and rules version) and status. */
export async function keyOwner(tx: Tx, type: MemberType, id: string): Promise<Owner | null> {
  return (await memberRoleStatus(tx, type, id)) ?? null;
}

/** The permissions a member's role and permission sets can use, including what their object rules grant (for scope checks). */
export async function usablePermissions(tx: Tx, ctx: Pick<Ctx, "tenantId">, owner: Owner): Promise<string[]> {
  const member = await accessOf(tx, ctx.tenantId, owner);
  return [...member.permissions, ...grantedPermissions(member.rules)];
}

const isSelf = (ctx: Ctx, type: MemberType, id: string) => ctx.actor.type === type && ctx.actor.id === id;

/**
 * The rules for acting on another member's keys: keys:manage, an owner's keys only by an owner,
 * and never for someone whose role holds more than the caller does (that would hand the caller
 * a credential with more access than their own).
 */
async function assertMayManageKeysOf(tx: Tx, ctx: Ctx, type: MemberType, id: string, owner: Owner) {
  if (owner.role === OWNER_ROLE && ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can manage an owner's keys");
  if (isSelf(ctx, type, id)) return;
  if (!can(ctx, "keys:manage")) throw forbidden("Managing other members' keys needs the keys:manage permission");
  const member = await accessOf(tx, ctx.tenantId, owner);
  const over = member.permissions.filter((p) => !ctx.permissions.has(p));
  if (over.length) throw forbidden(`The key owner's role has permissions you don't hold: ${over.join(", ")}`);
  // Record access counts too: a key for someone who can read an object you can't would read it for you.
  const target = roleCtx(ctx, { key: owner.role, permissions: member.permissions }, member.rules, member.version, { restricted: true });
  const short = accessShortfall(ctx, await loadSchema(tx), target);
  if (short.length) throw forbidden(`The key owner's role has record access you don't: ${short.slice(0, 10).join("; ")}`);
}

export interface CreateKeyInput {
  name: string;
  scopes: Scope[];
  owner?: string;            // usr_… or svc_…; defaults to the caller
  environment?: "live" | "test";
  expires_in_days?: number;
}

/**
 * Creates a key and returns its secret once. A key's scopes must be usable by its owner's role
 * and, except at bootstrap, must be scopes the calling key itself has: a key can't mint a broader one.
 * `test` keys are labelled as such but reach the same live data; there is no sandbox.
 */
export async function createApiKey(tx: Tx, ctx: Ctx, input: CreateKeyInput, opts: { bootstrap?: boolean } = {}) {
  if (!input.name?.trim()) throw unprocessable("name is required");
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || scopes.some((s) => !ALL_SCOPES.includes(s))) throw unprocessable(`scopes must be a non-empty subset of: ${ALL_SCOPES.join(", ")}`);
  let ownerType: MemberType;
  let ownerId: string;
  if (input.owner) {
    const d = decodeId(input.owner);
    if (!d || (d.prefix !== "usr" && d.prefix !== "svc")) throw unprocessable("owner must be a user (usr_…) or service account (svc_…) ID");
    ownerType = d.prefix === "usr" ? "user" : "service_account";
    ownerId = d.uuid;
  } else {
    if (ctx.actor.type === "system" || !ctx.actor.id) throw unprocessable("owner is required");
    ownerType = ctx.actor.type === "user" ? "user" : "service_account";
    ownerId = ctx.actor.id;
  }
  const owner = await keyOwner(tx, ownerType, ownerId);
  if (!owner || owner.disabled_at) throw notFound("Key owner");
  if (!opts.bootstrap) {
    // A browser session holds every scope its member's role can use (ADR 0009), so for a person
    // signed in this reads "only scopes your own role can use"; for a key, "only scopes it has".
    const beyond = scopes.filter((s) => !ctx.scopes.has(s));
    if (beyond.length) {
      throw forbidden(ctx.session ? `Your role can't use these scopes, so a key you create can't have them: ${beyond.join(", ")}`
        : `A key can't create a key with scopes it doesn't have: ${beyond.join(", ")}`);
    }
    await assertMayManageKeysOf(tx, ctx, ownerType, ownerId, owner);
  }
  const usable = await usablePermissions(tx, ctx, owner);
  const over = scopes.filter((s) => !roleCanUseScope(usable, s));
  if (over.length) throw forbidden(`The owner's role (${owner.role}) does not allow: ${over.join(", ")}`);
  const env = input.environment ?? "live";
  const lookup = base62(12);
  const secret = `hlcrm_${env}_${lookup}${base62(40)}`;
  const id = uuidv7();
  const expires = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null;
  await insertApiKey(tx, { tenantId: ctx.tenantId, id, ownerType, ownerId, name: input.name, lookup, secretHash: sha256(secret), scopes,
    environment: env, expiresAt: expires, createdBy: ctx.actor.id });
  await audit(tx, ctx, { action: "api_key.created", objectType: "api_key", recordId: id,
    details: { scopes, owner_type: ownerType, owner: encodeId(ownerType === "user" ? "usr" : "svc", ownerId), environment: env } });
  return { id: encodeId("key", id), name: input.name, scopes, environment: env, expires_at: expires?.toISOString() ?? null, secret };
}

export async function listApiKeys(tx: Tx, ctx: Ctx) {
  if (!can(ctx, "keys:manage")) throw forbidden("Listing all keys needs the keys:manage permission");
  const rows = await allApiKeys(tx);
  return rows.map((r) => ({
    id: encodeId("key", r.id), name: r.name, owner: encodeId(r.owner_type === "user" ? "usr" : "svc", r.owner_id),
    scopes: r.scopes, environment: r.environment, hint: `hlcrm_${r.environment}_${r.lookup.slice(0, 4)}…`,
    created_at: r.created_at.toISOString(), expires_at: r.expires_at?.toISOString() ?? null,
    revoked_at: r.revoked_at?.toISOString() ?? null, last_used_at: r.last_used_at?.toISOString() ?? null,
  }));
}

/** Loads a key (locked) and checks the caller may act on it. */
async function keyForChange(tx: Tx, ctx: Ctx, publicId: string) {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "key") throw notFound("API key");
  const key = await apiKeyForUpdate(tx, d.uuid);
  if (!key) throw notFound("API key");
  const owner = await keyOwner(tx, key.owner_type, key.owner_id);
  if (!owner) throw notFound("API key");
  await assertMayManageKeysOf(tx, ctx, key.owner_type, key.owner_id, owner);
  return key;
}

export async function revokeApiKey(tx: Tx, ctx: Ctx, publicId: string) {
  const key = await keyForChange(tx, ctx, publicId);
  await revokeKey(tx, key.id);
  await audit(tx, ctx, { action: "api_key.revoked", objectType: "api_key", recordId: key.id });
  return { id: publicId, revoked: true };
}

/** Issues a replacement key; the old one keeps working for the overlap window, then expires. Same checks as creating one. */
export async function rotateApiKey(tx: Tx, ctx: Ctx, publicId: string, overlapHours = 24) {
  const old = await keyForChange(tx, ctx, publicId);
  if (old.revoked_at || (old.expires_at && old.expires_at.getTime() <= Date.now())) throw notFound("API key");
  const created = await createApiKey(tx, ctx, {
    name: old.name, scopes: old.scopes, environment: old.environment,
    owner: encodeId(old.owner_type === "user" ? "usr" : "svc", old.owner_id),
  });
  const hours = Math.min(Math.max(overlapHours, 0), 168);
  await expireKeyWithin(tx, old.id, hours);
  // The replacement keeps the old key's expiry: rotating must not extend a key's intended lifetime.
  await linkRotatedKey(tx, decodeId(created.id)!.uuid, old.id, old.expires_at);
  await audit(tx, ctx, { action: "api_key.rotated", objectType: "api_key", recordId: old.id, details: { overlap_hours: hours } });
  return { ...created, expires_at: old.expires_at?.toISOString() ?? null, replaces: publicId, old_key_expires_in_hours: hours };
}

export const surfaces: Surface[] = ["api", "cli", "admin-mcp", "ops-mcp"];
