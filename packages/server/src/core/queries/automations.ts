import type { Tx } from "../../db/pool.js";
import type { AutomationRow, Step, Trigger } from "../automation-defs.js";
import { memberSetsColumn, type HeldSetRow } from "./roles.js";

/**
 * The SQL of automation definitions, the workspace's automation settings and the email suppression list
 * (core/automations.ts, automation-defs.ts, automation-access.ts and the settings and suppression reads of
 * automation-runner.ts; ADR 0012). Runs, caps and the worker's leasing are in automation-runs.ts. The
 * callers keep their checks, errors, audits and the order of statements in each transaction.
 */

// --- Automations ------------------------------------------------------------------------------------

/** One automation, archived or not; `forUpdate` locks it. */
export async function automationById(tx: Tx, id: string, forUpdate = false): Promise<AutomationRow | undefined> {
  const [a] = forUpdate
    ? await tx<AutomationRow[]>`SELECT * FROM automations WHERE id = ${id} FOR UPDATE`
    : await tx<AutomationRow[]>`SELECT * FROM automations WHERE id = ${id}`;
  return a;
}

/** The automations that aren't archived, oldest first. */
export async function liveAutomations(tx: Tx): Promise<AutomationRow[]> {
  return tx<AutomationRow[]>`SELECT * FROM automations WHERE archived_at IS NULL ORDER BY created_at`;
}

/** How many automations the workspace has that aren't archived. */
export async function countLiveAutomations(tx: Tx): Promise<number | undefined> {
  const [count] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM automations WHERE archived_at IS NULL`;
  return count?.n;
}

/** The enabled, unpaused automations that listen for an event type, oldest first. */
export async function automationsListeningFor(tx: Tx, eventType: string): Promise<AutomationRow[]> {
  return tx<AutomationRow[]>`
    SELECT * FROM automations WHERE enabled AND archived_at IS NULL AND paused_at IS NULL AND trigger->>'event' = ${eventType} ORDER BY created_at`;
}

/** Automations with a next scheduled run that aren't archived. */
export async function scheduledAutomations(tx: Tx): Promise<AutomationRow[]> {
  return tx<AutomationRow[]>`SELECT * FROM automations WHERE next_run_at IS NOT NULL AND archived_at IS NULL`;
}

/**
 * `condition` undefined is stored as SQL NULL; anything else (null too) as JSON. `secrets` is the encrypted
 * secret header values, or null.
 */
export async function insertAutomation(tx: Tx, a: { tenantId: string; id: string; name: string; description: string | null; enabled: boolean; trigger: Trigger;
  condition: unknown; actions: Step[]; hourlyCap: number; createdBy: string | null; runRoles: string[]; nextRunAt: Date | null; secrets: string | null }): Promise<void> {
  await tx`
    INSERT INTO automations (tenant_id, id, name, description, enabled, trigger, condition, actions, hourly_cap, created_by, run_roles, next_run_at, secrets)
    VALUES (${a.tenantId}, ${a.id}, ${a.name}, ${a.description}, ${a.enabled}, ${tx.json(a.trigger as never)},
            ${a.condition === undefined ? null : tx.json(a.condition as never)}, ${tx.json(a.actions as never)}, ${a.hourlyCap}, ${a.createdBy},
            ${a.runRoles}, ${a.nextRunAt}, ${a.secrets})`;
}

/** Saves an automation's new definition, one version up. `condition` null or undefined is stored as SQL NULL. */
export async function updateAutomationDefinition(tx: Tx, id: string, a: { name: string; description: string | null; enabled: boolean; trigger: Trigger;
  condition: unknown; actions: Step[]; hourlyCap: number; runRoles: string[]; secrets: string | null; nextRunAt: Date | null }): Promise<void> {
  await tx`
    UPDATE automations SET name = ${a.name}, description = ${a.description}, enabled = ${a.enabled},
      trigger = ${tx.json(a.trigger as never)}, condition = ${a.condition == null ? null : tx.json(a.condition as never)},
      actions = ${tx.json(a.actions as never)}, hourly_cap = ${a.hourlyCap}, run_roles = ${a.runRoles}, secrets = ${a.secrets},
      next_run_at = ${a.nextRunAt}, version = version + 1
    WHERE id = ${id}`;
}

/** Archives and disables an automation, dropping its next scheduled run. */
export async function archiveAutomationRow(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE automations SET archived_at = now(), enabled = false, next_run_at = NULL WHERE id = ${id}`;
}

/** Pauses an automation, dropping its next scheduled run. */
export async function pauseAutomationRow(tx: Tx, id: string, reason: string): Promise<void> {
  await tx`UPDATE automations SET paused_at = now(), paused_reason = ${reason}, next_run_at = NULL WHERE id = ${id}`;
}

/** Resumes a paused automation with its failure count reset. */
export async function resumeAutomationRow(tx: Tx, id: string, nextRunAt: Date | null): Promise<void> {
  await tx`UPDATE automations SET paused_at = NULL, paused_reason = NULL, consecutive_failures = 0,
               next_run_at = ${nextRunAt} WHERE id = ${id}`;
}

export async function setNextRun(tx: Tx, id: string, at: Date | null): Promise<void> {
  await tx`UPDATE automations SET next_run_at = ${at} WHERE id = ${id}`;
}

/** Drops an automation's next scheduled run. */
export async function clearNextRun(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE automations SET next_run_at = NULL WHERE id = ${id}`;
}

/** Clears an automation's count of failed runs in a row. */
export async function clearAutomationFailures(tx: Tx, id: string): Promise<void> {
  await tx`UPDATE automations SET consecutive_failures = 0 WHERE id = ${id}`;
}

/** Counts one more failed run in a row, returning the count and whether it is paused. */
export async function countAutomationFailure(tx: Tx, id: string) {
  const [row] = await tx<{ consecutive_failures: number; paused_at: Date | null }[]>`
    UPDATE automations SET consecutive_failures = consecutive_failures + 1 WHERE id = ${id} RETURNING consecutive_failures, paused_at`;
  return row;
}

/** Runs a condition query compiled by core/query.ts (compileQuery): the rows it matched. */
export async function compiledConditionRows(tx: Tx, text: string, params: unknown[]) {
  return tx.unsafe(text, params as never[]);
}

// --- Roles an automation's access is checked against ------------------------------------------------

/** A role, enough to build its context. */
export interface RoleForCtx { id: string; key: string; permissions: string[]; access_version: string; sets?: HeldSetRow[] }

/** The roles that aren't archived, by key. */
export async function liveRoles(tx: Tx): Promise<RoleForCtx[]> {
  return tx<RoleForCtx[]>`
    SELECT id, key, permissions, access_version::text FROM roles WHERE kind = 'role' AND archived_at IS NULL ORDER BY key`;
}

/** A member's role, whatever its state. */
export async function roleOfUser(tx: Tx, userId: string): Promise<RoleForCtx | undefined> {
  const [m] = await tx<RoleForCtx[]>`
        SELECT r.id, r.key, r.permissions, r.access_version::text, ${memberSetsColumn(tx, "user")}
        FROM users m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id WHERE m.id = ${userId}`;
  return m;
}

/** A service account's role, whatever its state. */
export async function roleOfServiceAccount(tx: Tx, serviceAccountId: string): Promise<RoleForCtx | undefined> {
  const [m] = await tx<RoleForCtx[]>`
        SELECT r.id, r.key, r.permissions, r.access_version::text, ${memberSetsColumn(tx, "service_account")}
        FROM service_accounts m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id WHERE m.id = ${serviceAccountId}`;
  return m;
}

// --- Workspace settings -----------------------------------------------------------------------------

export interface Settings { paused_at: Date | null; paused_reason: string | null; external_email: boolean; timezone: string }

/** The workspace's automation settings, or undefined when they were never set. */
export async function automationSettings(tx: Tx): Promise<Settings | undefined> {
  const [s] = await tx<Settings[]>`SELECT paused_at, paused_reason, external_email, timezone FROM automation_settings`;
  return s;
}

export async function saveAutomationSettings(tx: Tx, tenantId: string, s: Settings): Promise<void> {
  await tx`INSERT INTO automation_settings (tenant_id, paused_at, paused_reason, external_email, timezone)
           VALUES (${tenantId}, ${s.paused_at}, ${s.paused_reason}, ${s.external_email}, ${s.timezone})
           ON CONFLICT (tenant_id) DO UPDATE SET paused_at = EXCLUDED.paused_at, paused_reason = EXCLUDED.paused_reason,
             external_email = EXCLUDED.external_email, timezone = EXCLUDED.timezone`;
}

// --- The suppression list ---------------------------------------------------------------------------

/** Adds an address (by its keyed hash) to the list; nothing when it is already there. */
export async function insertSuppression(tx: Tx, tenantId: string, hash: Buffer, reason: string | null, createdBy: string | null): Promise<void> {
  await tx`INSERT INTO email_suppressions (tenant_id, address_hash, reason, created_by) VALUES (${tenantId}, ${hash}, ${reason}, ${createdBy})
           ON CONFLICT (tenant_id, address_hash) DO NOTHING`;
}

/** The oldest entry for either hash (an address's mailbox, and the address itself). */
export async function suppressionOf(tx: Tx, mailboxHash: Buffer, addressHash: Buffer) {
  const [row] = await tx<{ created_at: Date; reason: string | null }[]>`
    SELECT created_at, reason FROM email_suppressions WHERE address_hash IN (${mailboxHash}, ${addressHash}) ORDER BY created_at LIMIT 1`;
  return row;
}

/** Whether either hash is on the list. */
export async function isListedSuppressed(tx: Tx, mailboxHash: Buffer, addressHash: Buffer): Promise<boolean> {
  const [row] = await tx`SELECT 1 FROM email_suppressions WHERE address_hash IN (${mailboxHash}, ${addressHash}) LIMIT 1`;
  return Boolean(row);
}

/** Takes both hashes off the list; true when anything was removed. */
export async function deleteSuppression(tx: Tx, mailboxHash: Buffer, addressHash: Buffer): Promise<boolean> {
  const gone = await tx`DELETE FROM email_suppressions WHERE address_hash IN (${mailboxHash}, ${addressHash}) RETURNING 1`;
  return gone.length > 0;
}
