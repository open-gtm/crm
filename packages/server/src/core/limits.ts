import postgres from "postgres";
import { config } from "../config.js";
import type { Tx } from "../db/pool.js";
import { txState, withTenant } from "../db/tx.js";
import { ApiError, ConfigError } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { audit } from "./audit.js";
import { systemCtx } from "./context.js";
import {
  automationUsageIn, deleteLimitOverride, enterWorkspace, upsertLimitOverride, workspaceExists, countActiveServiceAccounts, countActiveUsers, countUsableKeys, foldRecordCounts, limitOverrides, lockLimit, lockRecordCount,
  recordCount, tryLockRecordCount, usageCounts,
} from "./queries/limits.js";
import { countLiveAutomations } from "./queries/automations.js";
import { countLiveWebhooks } from "./queries/webhooks.js";
import type { Schema } from "./schema.js";

/**
 * Per-workspace limits (ADR 0019): how much one workspace may hold or do on a server it shares with
 * others. Each limit has a server-wide default from an environment setting, and the operator can set
 * another value for one workspace (the `limits` command; table tenant_limits, which the app role can
 * only read). null is "unlimited".
 *
 * `kind` says how a limit is counted: "count" limits are things that exist now, "rate" limits are
 * things done in a window of time.
 */
export const LIMITS = {
  records: { env: "LIMIT_RECORDS", kind: "count", unit: "records", what: "Records of every object, archived ones included" },
  members: { env: "LIMIT_MEMBERS", kind: "count", unit: "members", what: "Members who can sign in (disabled ones don't count)" },
  service_accounts: { env: "LIMIT_SERVICE_ACCOUNTS", kind: "count", unit: "service accounts", what: "Service accounts that aren't disabled" },
  api_keys: { env: "LIMIT_API_KEYS", kind: "count", unit: "API keys", what: "API keys that work: not revoked, not expired" },
  custom_objects: { env: "LIMIT_CUSTOM_OBJECTS", kind: "count", unit: "custom objects", what: "Custom objects" },
  custom_fields: { env: "LIMIT_CUSTOM_FIELDS", kind: "count", unit: "custom fields", what: "Custom fields, on standard and custom objects together" },
  webhooks: { env: "LIMIT_WEBHOOKS", kind: "count", unit: "webhooks", what: "Webhook endpoints that aren't archived" },
  automations: { env: "LIMIT_AUTOMATIONS", kind: "count", unit: "automations", what: "Automations that aren't archived" },
  file_storage_mb: { env: "FILE_QUOTA_MB", kind: "count", unit: "MB of files", what: "What the files attached to records hold in all, in MB" },
  requests_per_minute: { env: "LIMIT_REQUESTS_PER_MINUTE", kind: "rate", unit: "API requests a minute",
    what: "API requests in a minute, from all the workspace's keys, people and connected apps together (counted per API process)" },
  automation_actions_per_hour: { env: "AUTOMATION_ACTIONS_PER_HOUR", kind: "rate", unit: "automation actions an hour", what: "Action steps automations run in an hour" },
  automation_http_per_hour: { env: "AUTOMATION_HTTP_PER_HOUR", kind: "rate", unit: "automation HTTP requests an hour", what: "HTTP requests automations send in an hour" },
  automation_emails_per_hour: { env: "AUTOMATION_EMAILS_PER_HOUR", kind: "rate", unit: "automation emails an hour", what: "Emails automations send in an hour" },
} as const satisfies Record<string, { env: string; kind: "count" | "rate"; unit: string; what: string }>;

export type LimitKey = keyof typeof LIMITS;
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];
export const isLimitKey = (s: string): s is LimitKey => Object.hasOwn(LIMITS, s);
export type LimitValues = Record<LimitKey, number | null>;

/** The largest value a limit can be set to; past it "unlimited" is what is meant. */
export const LIMIT_MAX = 1e12;

/** The server's defaults, from its settings. */
export function serverLimits(): LimitValues {
  const c = config();
  return {
    records: c.LIMIT_RECORDS, members: c.LIMIT_MEMBERS, service_accounts: c.LIMIT_SERVICE_ACCOUNTS, api_keys: c.LIMIT_API_KEYS,
    custom_objects: c.LIMIT_CUSTOM_OBJECTS, custom_fields: c.LIMIT_CUSTOM_FIELDS, webhooks: c.LIMIT_WEBHOOKS, automations: c.LIMIT_AUTOMATIONS,
    file_storage_mb: c.FILE_QUOTA_MB, requests_per_minute: c.LIMIT_REQUESTS_PER_MINUTE,
    automation_actions_per_hour: c.AUTOMATION_ACTIONS_PER_HOUR, automation_http_per_hour: c.AUTOMATION_HTTP_PER_HOUR,
    automation_emails_per_hour: c.AUTOMATION_EMAILS_PER_HOUR,
  };
}

interface Resolved { values: LimitValues; overridden: Set<LimitKey> }

async function load(tx: Tx): Promise<Resolved> {
  const values = serverLimits();
  const overridden = new Set<LimitKey>();
  for (const row of await limitOverrides(tx)) {
    // A key this version doesn't know (set by a newer one, then rolled back) is ignored.
    if (!isLimitKey(row.key)) continue;
    values[row.key] = row.value;
    overridden.add(row.key);
  }
  return { values, overridden };
}

const SCRATCH = "limits";
interface Scratch { resolved?: Resolved; records?: { used: number } }

/** What this module keeps for the transaction, or a throwaway when there is no withTenant transaction around. */
function scratch(): Scratch {
  const s = txState()?.scratch;
  if (!s) return {};
  let mine = s.get(SCRATCH) as Scratch | undefined;
  if (!mine) s.set(SCRATCH, mine = {});
  return mine;
}

/** The workspace's limits: the server's defaults with what the operator set for it. Read once per transaction. */
async function resolved(tx: Tx): Promise<Resolved> {
  const s = scratch();
  return s.resolved ??= await load(tx);
}

/** One limit of the transaction's workspace; null is unlimited. */
export async function limitOf(tx: Tx, key: LimitKey): Promise<number | null> {
  return (await resolved(tx)).values[key];
}

/**
 * The refusal every limit gives: 409 `limit_reached`, with the limit's key, what is in use, the
 * ceiling and how much the request would add under `errors`, so a client or an agent can say exactly
 * what is full. Nothing the caller can change raises a limit, so the message says who can.
 */
export function limitReached(key: LimitKey, used: number, max: number, adding = 1): ApiError {
  const unit = LIMITS[key].unit;
  const more = adding > 1 ? `, and this would add ${adding}` : "";
  return new ApiError(409, "limit_reached",
    `This workspace is at its limit of ${max} ${unit} (${used} in use${more}). Free some up, or ask whoever runs the server to raise the limit.`,
    { limit: key, used, max, adding });
}

// --- Things that are counted with a query -------------------------------------------------------------

type Counted = "members" | "service_accounts" | "api_keys" | "webhooks" | "automations";
const COUNTERS: Record<Counted, (tx: Tx) => Promise<number>> = {
  members: countActiveUsers, service_accounts: countActiveServiceAccounts, api_keys: countUsableKeys,
  webhooks: async (tx) => (await countLiveWebhooks(tx)) ?? 0, automations: async (tx) => (await countLiveAutomations(tx)) ?? 0,
};

/**
 * Refuses when adding `adding` of something would pass the workspace's limit. Call it just before the
 * insert: requests adding the same kind of thing to a workspace go one at a time from here to their
 * commit, so two at once can't both take the last place. Nothing is locked or counted when the limit
 * is unlimited, or in a preview (which adds nothing).
 */
export async function assertRoom(tx: Tx, tenantId: string, key: Counted, adding = 1): Promise<void> {
  const max = await limitOf(tx, key);
  if (max === null) return;
  if (!txState()?.preview) await lockLimit(tx, tenantId, key);
  const used = await COUNTERS[key](tx);
  if (used + adding > max) throw limitReached(key, used, max, adding);
}

/**
 * The same for custom objects and custom fields, counted from the schema the caller has loaded (schema
 * changes already go one at a time: core/schema.ts lockSchema).
 */
export async function assertSchemaRoom(tx: Tx, schema: Schema, add: { objects?: number; fields?: number }): Promise<void> {
  const used = schemaUsage(schema);
  for (const [key, adding, have] of [["custom_objects", add.objects ?? 0, used.custom_objects], ["custom_fields", add.fields ?? 0, used.custom_fields]] as const) {
    if (adding <= 0) continue;
    const max = await limitOf(tx, key);
    if (max !== null && have + adding > max) throw limitReached(key, have, max, adding);
  }
}

/** Refuses when the schema, as it now is, holds more than the workspace's limits allow (after a change whose size wasn't known beforehand). */
export async function assertSchemaWithin(tx: Tx, schema: Schema): Promise<void> {
  const used = schemaUsage(schema);
  for (const key of ["custom_objects", "custom_fields"] as const) {
    const max = await limitOf(tx, key);
    if (max !== null && used[key] > max) throw limitReached(key, max, max, used[key] - max);
  }
}

function schemaUsage(schema: Schema): { custom_objects: number; custom_fields: number } {
  const objects = [...schema.objects.values()];
  return { custom_objects: objects.filter((o) => !o.is_system).length,
    custom_fields: objects.reduce((n, o) => n + o.fields.filter((f) => !f.is_system).length, 0) };
}

// --- Records ------------------------------------------------------------------------------------------

/** Past this many rows the count is folded into one while the lock is held anyway. */
const FOLD_AFTER_ROWS = 200;

/**
 * Call before inserting `n` records. Refuses when they would pass the workspace's record limit, and
 * otherwise arranges the exact check for the end of the transaction (`finalRecordCheck`).
 *
 * This first check takes no lock, so it can't see records other transactions are adding right now; it
 * is here to refuse early and plainly, and to answer a dry run. Within one transaction it reads the
 * count once and then counts what it has let through; when that reaches the limit it reads the count
 * again, because rows rolled back to a savepoint (a failed row of an import) were let through but
 * never added.
 */
export async function claimRecords(tx: Tx, tenantId: string, n = 1): Promise<void> {
  const max = await limitOf(tx, "records");
  if (max === null) return;
  const s = scratch();
  if (!s.records || s.records.used + n > max) s.records = { used: (await recordCount(tx)).n };
  if (s.records.used + n > max) throw limitReached("records", s.records.used, max, n);
  s.records.used += n;
  const state = txState();
  if (!state) {
    // No transaction-end hook to hang the exact check on: take the lock now and hold it to the commit.
    await lockRecordCount(tx, tenantId);
    const now = (await recordCount(tx)).n;
    if (now + n > max) throw limitReached("records", now, max, n);
    return;
  }
  // A preview is rolled back by its caller: it adds nothing, so there is nothing to check at the end.
  if (!state.preview) state.beforeCommit.set("limits:records", (t) => finalRecordCheck(t, tenantId));
}

/**
 * The exact check, run once the transaction's work is done and just before it commits. Transactions
 * that added records to this workspace take one lock here, so each sees every record committed before
 * it and its own, and the one that would pass the limit is refused (and rolled back). The lock is held
 * only for the commit, not for the work: a long import doesn't make other requests wait.
 */
async function finalRecordCheck(tx: Tx, tenantId: string): Promise<void> {
  const max = await limitOf(tx, "records");
  if (max === null) return;
  await lockRecordCount(tx, tenantId);
  const { n, rows } = await recordCount(tx);
  if (n > max) throw limitReached("records", Math.min(n, max), max, Math.max(1, n - max));
  if (rows > FOLD_AFTER_ROWS) await foldRecordCounts(tx, tenantId);
}

/**
 * Folds a workspace's record count into one row when it has grown to many (one per transaction that
 * added records). The worker calls this for every workspace; reading the count never needs it to have run.
 */
export async function compactRecordCount(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    if ((await recordCount(tx)).rows <= FOLD_AFTER_ROWS || !(await tryLockRecordCount(tx, tenantId))) return false;
    await foldRecordCounts(tx, tenantId);
    return true;
  });
}

// --- Usage --------------------------------------------------------------------------------------------

const HOUR = 3_600_000;
const MB = 1024 * 1024;

export interface UsageLine { key: LimitKey; description: string; kind: "count" | "rate"; used: number | null; limit: number | null; source: "server" | "workspace" }

/**
 * What the workspace uses against each of its limits. `limit` null is unlimited; `used` null is not
 * known here (requests are counted in each API process's memory). `source` says whether the limit is
 * the server's default or one the operator set for this workspace. Hourly limits report the current
 * clock hour.
 */
export async function getUsage(tx: Tx, schema: Schema): Promise<{ limits: UsageLine[] }> {
  const { values, overridden } = await resolved(tx);
  const counts = await usageCounts(tx);
  const inSchema = schemaUsage(schema);
  const windowStart = new Date(Math.floor(Date.now() / HOUR) * HOUR);
  const hourly = new Map((await automationUsageIn(tx, ["actions", "http", "email"], windowStart)).map((r) => [r.bucket, r.n]));
  const used: Record<LimitKey, number | null> = {
    records: (await recordCount(tx)).n, members: counts.members, service_accounts: counts.service_accounts, api_keys: counts.api_keys,
    custom_objects: inSchema.custom_objects, custom_fields: inSchema.custom_fields, webhooks: counts.webhooks, automations: counts.automations,
    file_storage_mb: Math.ceil((counts.file_bytes / MB) * 100) / 100, requests_per_minute: null,
    automation_actions_per_hour: hourly.get("actions") ?? 0, automation_http_per_hour: hourly.get("http") ?? 0, automation_emails_per_hour: hourly.get("email") ?? 0,
  };
  return { limits: LIMIT_KEYS.map((key) => ({ key, description: LIMITS[key].what, kind: LIMITS[key].kind, used: used[key], limit: values[key],
    source: overridden.has(key) ? "workspace" as const : "server" as const })) };
}

// --- The request rate, which is checked before a request has a transaction ------------------------------

const RATE_TTL_MS = 30_000;
const rateCache = new Map<string, { perMinute: number | null; at: number }>();

/**
 * A workspace's requests_per_minute, remembered for 30 seconds per process: it is needed for every
 * request, before the request's own transaction. A change made with the `limits` command therefore
 * takes up to 30 seconds to apply to the request rate (every other limit applies at once).
 */
export async function requestRateOf(tenantId: string): Promise<number | null> {
  const hit = rateCache.get(tenantId);
  const now = Date.now();
  if (hit && now - hit.at < RATE_TTL_MS) return hit.perMinute;
  const perMinute = await withTenant(tenantId, (tx) => limitOf(tx, "requests_per_minute"));
  rateCache.delete(tenantId);
  rateCache.set(tenantId, { perMinute, at: now });
  // Bounded like the other in-memory limiters: the oldest entries go first.
  for (const k of rateCache.keys()) {
    if (rateCache.size <= 50_000) break;
    rateCache.delete(k);
  }
  return perMinute;
}

/** Forgets remembered request rates (after a limit is set in this process; for tests). */
export function resetLimitCache(tenantId?: string): void {
  if (tenantId) rateCache.delete(tenantId);
  else rateCache.clear();
}

// --- Setting a workspace's limits: the operator's command, never the API --------------------------------

/** What `limits` takes for one key: a number, null for unlimited, or "default" to go back to the server's setting. */
export type LimitChange = number | null | "default";

/** Reads `records=50000`, `webhooks=unlimited`, `members=default` into changes. Throws ConfigError on anything else. */
export function parseLimitChanges(args: string[]): Partial<Record<LimitKey, LimitChange>> {
  const out: Partial<Record<LimitKey, LimitChange>> = {};
  for (const arg of args) {
    const m = /^([a-z_]+)=(.+)$/.exec(arg.trim().toLowerCase());
    if (!m || !isLimitKey(m[1]!)) throw new ConfigError(`"${arg}" is not a limit. Write key=value, with one of: ${LIMIT_KEYS.join(", ")}`);
    const raw = m[2]!;
    if (raw !== "default" && raw !== "unlimited" && !/^\d{1,13}$/.test(raw)) throw new ConfigError(`${m[1]}: "${raw}" is not a whole number, "unlimited" or "default"`);
    const value: LimitChange = raw === "default" ? "default" : raw === "unlimited" ? null : Number(raw);
    if (typeof value === "number" && value > LIMIT_MAX) throw new ConfigError(`${m[1]}: at most ${LIMIT_MAX}; write "unlimited" for no limit`);
    if (value === 0 && (m[1] === "members" || m[1] === "requests_per_minute")) throw new ConfigError(`${m[1]}: must be at least 1`);
    out[m[1]] = value;
  }
  return out;
}

export interface WorkspaceLimitLine { key: LimitKey; limit: number | null; source: "server" | "workspace" }

/**
 * Shows one workspace's limits and, with `changes`, sets them first. Connects as the migrator role
 * (`migratorUrl`), the only role that can write tenant_limits: a limit is the operator's to set, so no
 * credential the API accepts can change one. Each change is written to the workspace's audit log.
 */
export async function workspaceLimits(migratorUrl: string, workspace: string, changes: Partial<Record<LimitKey, LimitChange>> = {}):
  Promise<{ workspace: string; limits: WorkspaceLimitLine[] }> {
  const id = decodeId(workspace);
  if (!id || id.prefix !== "ws") throw new ConfigError("--workspace takes a workspace ID (ws_…), as `bootstrap` printed it and GET /v1/workspace returns it");
  const sql = postgres(migratorUrl, { max: 1, onnotice: () => {} });
  try {
    return await sql.begin(async (tx) => {
      if (!(await workspaceExists(tx, id.uuid))) throw new ConfigError(`No workspace ${workspace} on this server`);
      await enterWorkspace(tx, id.uuid);
      const before = await load(tx);
      const changed: Record<string, { from: number | null; to: number | null }> = {};
      for (const [key, change] of Object.entries(changes) as [LimitKey, LimitChange][]) {
        if (change === "default") await deleteLimitOverride(tx, key);
        else await upsertLimitOverride(tx, id.uuid, key, change);
        const to = change === "default" ? serverLimits()[key] : change;
        if (before.values[key] !== to) changed[key] = { from: before.values[key], to };
      }
      if (Object.keys(changed).length) {
        await audit(tx, { ...systemCtx(id.uuid, "operator"), surface: "cli" }, { action: "workspace.limits_changed", details: { limits: changed } });
      }
      const after = await load(tx);
      return { workspace: encodeId("ws", id.uuid), limits: LIMIT_KEYS.map((key) => ({ key, limit: after.values[key],
        source: after.overridden.has(key) ? "workspace" as const : "server" as const })) };
    });
  } finally {
    await sql.end({ timeout: 5 });
    resetLimitCache(id.uuid);
  }
}
