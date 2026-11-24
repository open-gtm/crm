import type { Tx } from "../../db/pool.js";
import type { AutomationRow } from "../automation-defs.js";
import type { FieldMeta } from "../schema.js";

/**
 * The SQL of schema packs (core/packs.ts; ADR 0012): the installed_packs rows, and the reads and writes a pack
 * makes on what it owns (objects, fields, roles, views) and on what may use it (automations, alert rules,
 * webhooks). Creating and changing roles, views and fields goes through their own modules, not these. The
 * code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

// --- Installed packs --------------------------------------------------------------------------------

/** An installed_packs row. `owned` is as stored: core/packs.ts reads it with ownedFrom. */
export interface InstalledPackRow { name: string; version: string; status: "installed" | "uninstalled"; description: string; owned: unknown;
  installed_at: Date; installed_by: string | null; updated_at: Date }

/** A pack's row; `lock` locks it for the rest of the transaction. */
export async function installedPack(tx: Tx, name: string, lock: boolean): Promise<InstalledPackRow | undefined> {
  const [row] = lock
    ? await tx<InstalledPackRow[]>`SELECT * FROM installed_packs WHERE name = ${name} FOR UPDATE`
    : await tx<InstalledPackRow[]>`SELECT * FROM installed_packs WHERE name = ${name}`;
  return row;
}

/** Every pack row, installed or uninstalled, by name. */
export async function installedPacks(tx: Tx): Promise<InstalledPackRow[]> {
  return tx<InstalledPackRow[]>`SELECT * FROM installed_packs ORDER BY name`;
}

/** Records what a pack owns (and last wrote), without changing its version or status. */
export async function setPackOwned(tx: Tx, name: string, owned: unknown, updatedBy: string | null): Promise<void> {
  await tx`UPDATE installed_packs SET owned = ${tx.json(owned as never)}, updated_by = ${updatedBy} WHERE name = ${name}`;
}

/** Records a pack as installed at `version`, owning `owned`. */
export async function upsertInstalledPack(tx: Tx, p: { tenantId: string; name: string; version: string; description: string; owned: unknown;
  actorId: string | null }): Promise<void> {
  await tx`
    INSERT INTO installed_packs (tenant_id, name, version, status, description, owned, installed_by, updated_by)
    VALUES (${p.tenantId}, ${p.name}, ${p.version}, 'installed', ${p.description}, ${tx.json(p.owned as never)}, ${p.actorId}, ${p.actorId})
    ON CONFLICT (tenant_id, name) DO UPDATE SET version = EXCLUDED.version, status = 'installed', description = EXCLUDED.description,
      owned = EXCLUDED.owned, updated_by = EXCLUDED.updated_by`;
}

export async function markPackUninstalled(tx: Tx, name: string, updatedBy: string | null): Promise<void> {
  await tx`UPDATE installed_packs SET status = 'uninstalled', updated_by = ${updatedBy} WHERE name = ${name}`;
}

// --- Objects and fields a pack owns -----------------------------------------------------------------

/** When an object was archived (null: it is live); undefined when there is no such object. */
export async function objectArchivedAt(tx: Tx, id: string): Promise<{ archived_at: Date | null } | undefined> {
  const [o] = await tx<{ archived_at: Date | null }[]>`SELECT archived_at FROM objects WHERE id = ${id}`;
  return o;
}

export async function restoreObject(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE objects SET archived_at = NULL, updated_at = now() WHERE id = ${id}`;
}

export async function archiveObject(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE objects SET archived_at = now(), updated_at = now() WHERE id = ${id}`;
}

/** How many live records an object holds, counted up to 10001. */
export async function liveRecordCount(tx: Tx, objectId: string): Promise<number> {
  const [held] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM records WHERE object_id = ${objectId} AND archived_at IS NULL LIMIT 10001) s`;
  return held!.n;
}

/** How many live records the objects hold together, counted up to 10001. */
export async function liveRecordCountIn(tx: Tx, objectIds: string[]): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (SELECT 1 FROM records WHERE object_id = ANY(${objectIds}::uuid[]) AND archived_at IS NULL LIMIT 10001) s`;
  return r!.n;
}

/** A field, archived or not, with what restoring it needs to know. */
export async function fieldForRestore(tx: Tx, id: string): Promise<(FieldMeta & { archived_at: Date | null }) | undefined> {
  const [f] = await tx<(FieldMeta & { archived_at: Date | null })[]>`
      SELECT id, api_name, object_id, type, storage_key, sensitivity, archived_at FROM fields WHERE id = ${id}`;
  return f;
}

/** True when the object has a live field with this name. */
export async function liveFieldNamed(tx: Tx, objectId: string, apiName: string): Promise<boolean> {
  const [taken] = await tx`SELECT 1 FROM fields WHERE object_id = ${objectId} AND api_name = ${apiName} AND archived_at IS NULL`;
  return Boolean(taken);
}

export async function restoreField(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE fields SET archived_at = NULL, updated_at = now() WHERE id = ${id}`;
}

// --- Roles and views a pack owns --------------------------------------------------------------------

/** A live role's definition, as a pack compares it. */
export async function liveRoleDefinition(tx: Tx, id: string): Promise<{ id: string; name: string; description: string; permissions: string[]; access_version: string } | undefined> {
  const [r] = await tx<{ id: string; name: string; description: string; permissions: string[]; access_version: string }[]>`
      SELECT id, name, description, permissions, access_version::text FROM roles WHERE id = ${id} AND kind = 'role' AND archived_at IS NULL`;
  return r;
}

/** True when the role exists and isn't archived. */
export async function isRoleLive(tx: Tx, id: string): Promise<boolean> {
  const [r] = await tx`SELECT 1 FROM roles WHERE id = ${id} AND kind = 'role' AND archived_at IS NULL`;
  return Boolean(r);
}

/** True when a live role has this key. */
export async function roleKeyTaken(tx: Tx, key: string): Promise<boolean> {
  const [taken] = await tx`SELECT 1 FROM roles WHERE key = ${key} AND kind = 'role' AND archived_at IS NULL`;
  return Boolean(taken);
}

/** The keys of those of these roles that are live. */
export async function liveRoleKeys(tx: Tx, ids: string[]): Promise<{ key: string }[]> {
  return tx<{ key: string }[]>`SELECT key FROM roles WHERE id = ANY(${ids}::uuid[]) AND kind = 'role' AND archived_at IS NULL`;
}

/** A view's name, definition and version: what a pack compares with what it last wrote. */
export async function viewSnapshot(tx: Tx, id: string): Promise<{ name: string; definition: unknown; version: number } | undefined> {
  const [r] = await tx<{ name: string; definition: unknown; version: number }[]>`SELECT name, definition, version FROM views WHERE id = ${id}`;
  return r;
}

/** A view's definition, name and version: what a pack compares with what it would write. */
export async function viewDefinition(tx: Tx, id: string): Promise<{ definition: unknown; name: string; version: number } | undefined> {
  const [row] = await tx<{ definition: unknown; name: string; version: number }[]>`SELECT definition, name, version FROM views WHERE id = ${id}`;
  return row;
}

export async function viewExists(tx: Tx, id: string): Promise<boolean> {
  const [r] = await tx`SELECT 1 FROM views WHERE id = ${id}`;
  return Boolean(r);
}

export async function viewVersion(tx: Tx, id: string): Promise<{ version: number } | undefined> {
  const [row] = await tx<{ version: number }[]>`SELECT version FROM views WHERE id = ${id}`;
  return row;
}

// --- What may use a pack ----------------------------------------------------------------------------

/** Up to 1000 automations that aren't archived. */
export async function liveAutomations(tx: Tx): Promise<AutomationRow[]> {
  return tx<AutomationRow[]>`SELECT * FROM automations WHERE archived_at IS NULL ORDER BY name, id LIMIT 1000`;
}

export interface AlertRuleUseRow { id: string; name: string; scope: string; object: string; trigger: Record<string, unknown>; condition: unknown }

/** Up to 1000 alert rules that aren't archived: what each looks at. */
export async function liveAlertRules(tx: Tx): Promise<AlertRuleUseRow[]> {
  return tx<AlertRuleUseRow[]>`
    SELECT id, name, scope, object, trigger, condition FROM alert_rules WHERE archived_at IS NULL ORDER BY name, id LIMIT 1000`;
}

/** Up to 1000 webhooks that aren't archived, with the events they subscribe to. */
export async function liveWebhookEvents(tx: Tx): Promise<{ id: string; events: string[] }[]> {
  return tx<{ id: string; events: string[] }[]>`SELECT id, events FROM webhooks WHERE archived_at IS NULL ORDER BY id LIMIT 1000`;
}
