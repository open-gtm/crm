/**
 * Response shapes the routes declare, as JSON Schema (OpenAPI 3.1). Every route names one (a test
 * fails otherwise), and tests check real responses of the routes against what they declare, so the
 * document a typed client is generated from can't silently drift from the server.
 * Shapes are open (additionalProperties) where the server may add fields later without breaking clients.
 * A property that is free-form by design (event data, a stored filter, a field's value) stays open and
 * says so in its description.
 */

export type JsonSchema = Record<string, unknown>;
export interface ResponseSpec {
  /** The success status (default 200). */
  status?: number;
  /** Another success status with the same shape: 200 for the dry run of a create that answers 201. */
  alsoStatus?: number;
  schema: JsonSchema;
  /** For non-JSON bodies (an export). */
  contentType?: string;
  description?: string;
}

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
export const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
const str: JsonSchema = { type: "string" };
const int: JsonSchema = { type: "integer" };
const bool: JsonSchema = { type: "boolean" };
const time: JsonSchema = { type: "string", format: "date-time" };
export const enumOf = (...values: string[]): JsonSchema => ({ type: "string", enum: values });
const anyObject: JsonSchema = { type: "object", additionalProperties: true };
export const object = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: true });
export const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** A closed object: every property listed, nothing else allowed. For small shapes that are stable by design (sign-in, sessions). */
export const strict = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });

/** `{ data: … }`, the envelope of every JSON response except pages with extra keys and a few operation results. */
export const data = (s: JsonSchema = anyObject, status?: number): ResponseSpec => ({ schema: object({ data: s }), ...(status ? { status } : {}) });
export const dataList = (items: JsonSchema = anyObject): ResponseSpec => data(list(items));
export const plain = (s: JsonSchema, status?: number): ResponseSpec => ({ schema: s, ...(status ? { status } : {}) });

/** A notification as its recipient may see it now (core/notifications.ts publicNotification). */
const notification = {
  id: str, severity: enumOf("info", "warning", "critical"), title: str, body: nullable(str),
  state: enumOf("unread", "acknowledged", "snoozed", "resolved"),
  snoozed_until: { ...nullable(time), description: "While snoozed: when it comes back (a snooze that has run out reads as unread)" },
  fire_count: int, first_fired_at: time, last_fired_at: time,
  source: object({ type: enumOf("alert", "automation"), id: str, name: nullable(str) }),
  record: { ...nullable(object({ id: str, object: str, display_name: { type: "string", description: "\"(not available)\" when the record can't be read" } })),
    description: "The record it is about, or null" },
};

/** A webhook endpoint (core/webhooks.ts publicWebhook). The signing secret is never part of it. */
const webhook = {
  id: str, url: str, description: nullable(str), events: { ...list(str), description: "Subscribed event patterns (\"deal.*\", \"*.created\", \"*\")" },
  include_restricted: bool, enabled: bool,
  status: { ...enumOf("active", "paused", "disabled", "archived"), description: "paused: deliveries are held after repeated failures, until paused_until" },
  consecutive_failures: int, paused_until: nullable(time),
  previous_secret_valid_until: { ...nullable(time), description: "After a rotation: until when the old secret also signs" },
  created_at: time, updated_at: time,
};

/** A record an alert would have fired for, and when. */
const alertSample = object({ record: str, display_name: { ...nullable(str), description: "null when the caller can't read the record" }, at: time });

/** Components every document has. The authenticated document replaces Record with one schema per object. */
export const BASE_SCHEMAS: Record<string, JsonSchema> = {
  Problem: {
    type: "object", description: "An RFC 9457 problem document (application/problem+json)", additionalProperties: true,
    properties: { type: str, title: str, status: int, detail: str, code: str, request_id: str, errors: {} },
    required: ["type", "title", "status", "detail", "code"],
  },
  Record: {
    type: "object", description: "A record as the caller may see it: fields the caller can't read are absent", additionalProperties: true,
    properties: {
      id: str, object: str, display_name: str, version: int, created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" }, archived_at: { type: "string", format: "date-time" }, included: { $ref: "#/components/schemas/Included" },
      merged_into: { type: "string", description: "On a record merged into another (archived): the record that now holds its references, the end of merge_chain" },
      merge_chain: { type: "array", items: str, description: "On a merged record: the survivors it went into, in order (A into B, then B into C: [B, C])" },
    },
    required: ["id", "object"],
  },
  Included: {
    type: "object", description: "Related records asked for with include, by relation field: null when the relation is empty",
    additionalProperties: nullable(object({ id: str, object: str, display_name: nullable(str) }, ["id", "display_name"])),
  },
  RecordPage: object({
    data: list(ref("Record")), next_cursor: nullable(str),
    total: { type: "integer", description: "With count: the matching records, exact up to 10,000" },
    total_capped: { type: "boolean", description: "With count: true when there are more than total" },
  }, ["data", "next_cursor"]),
  OpResult: object({ dry_run: bool, result: {}, would: list(str) }, ["dry_run", "result"]),
  Aggregate: object({
    data: list(object({
      group: { type: "object", additionalProperties: true, description: "Group key per group_by field: a value, null, or {id, display_name} for a relation" },
      count: int,
      values: { type: "object", additionalProperties: { anyOf: [{ type: "number" }, str, { type: "null" }] } },
      currency: { type: "string", description: "With a currency measure: the currency of every amount in this group" },
    }, ["group", "count", "values"])),
    group_by: list(object({ field: str, bucket: str }, ["field"])),
    measures: list(object({ key: str, op: str, field: nullable(str) })),
    truncated: { type: "boolean", description: "True when there are more groups than limit" },
    rows_capped: { type: "boolean", description: "True when more than 100,000 records matched: groups and totals cover only the 100,000 most recently updated" },
  }),
  View: object({
    id: str, object: nullable(str), name: str, shared: bool, owner: nullable(str), mine: bool,
    status: { type: "string", enum: ["ok", "unavailable", "broken"] }, problem: str,
    where: {}, sort: {}, columns: {}, group_by: {}, version: int, created_at: str, updated_at: str,
  }, ["id", "object", "name", "shared", "owner", "mine", "status", "version"]),
  DirectoryUser: object({ id: str, name: str, email: str }),
  CreatePreview: object({
    dry_run: { type: "boolean", const: true }, object: str,
    counts: object({ create: int, error: int }),
    rows: list(object({ index: int, action: { type: "string", enum: ["create", "error"] }, record: anyObject, reason: str, errors: {} }, ["index", "action"])),
  }),
  BulkResult: object({
    dry_run: bool, object: str, op: { type: "string", enum: ["update", "archive"] }, count: int,
    counts: { type: "object", additionalProperties: int, description: "Records per action: the op, skip and error" },
    rows: list(object({ id: str, action: { type: "string", enum: ["update", "archive", "skip", "error"] }, version: int, reason: str, errors: {} }, ["id", "action"])),
    sample: list(ref("Record")),
    confirm_token: { type: "string", description: "From a dry run with no errors: pass it back to run the same change. Single-use, 15 minutes, bound to the credential" },
    no_longer_matching: list(str), new_matches_not_changed: int,
  }, ["dry_run", "object", "op", "count", "counts", "rows"]),
  MergeResult: object({
    dry_run: bool, survivor: ref("Record"), merged: list(str), changes: {}, references: list(anyObject), not_filled: list(anyObject),
    confirm_token: { type: "string", description: "From a dry run: pass it back to apply the same merge. Single-use, 15 minutes, bound to the credential" },
  }, ["dry_run", "survivor", "merged"]),
  DuplicateGroups: object({
    object: str, scanned: int, window_full: bool, fuzzy_scanned: int,
    groups: list(object({ reason: anyObject, count: int, records: list(ref("Record")) })),
    more_groups: bool, skipped_rules: list({}),
  }, ["object", "scanned", "window_full", "groups", "more_groups"]),
  SignInSettings: strict({ password: bool, sso: bool, sso_allowed_domains: list(str),
    oauth_apps: { type: "boolean", description: "Members may connect apps to the MCP servers over OAuth (ADR 0010)" },
    oauth_scopes: { type: "array", items: { type: "string", enum: ["ops:read", "ops:write", "restricted:read", "admin"] }, description: "The scopes connected apps may be granted" } }),
  ConnectedApp: strict({
    id: { type: "string", description: "The grant (ogr_…): one approved connection of one member, one app and one MCP endpoint" },
    member: str,
    client: strict({ id: str, name: str, kind: { type: "string", enum: ["metadata_document", "registered"] }, verified_by_document: bool, redirect_host: str }),
    scopes: list(str), resource: { type: "string", description: "The MCP endpoint the app's tokens are for" },
    created_at: { type: "string", format: "date-time" }, last_used_at: nullable({ type: "string", format: "date-time" }), expires_at: { type: "string", format: "date-time" },
  }),
  Session: strict({
    id: str, method: str, signed_in_at: { type: "string", format: "date-time" }, last_seen_at: { type: "string", format: "date-time" },
    idle_expires_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
    user_agent: nullable(str), client_address: nullable(str),
    current: { type: "boolean", description: "In your own list: true for the session making this request" },
  }, ["id", "method", "signed_in_at", "last_seen_at", "idle_expires_at", "expires_at", "user_agent", "client_address"]),
  SessionInfo: strict({
    session: strict({ id: str, method: str, signed_in_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
      idle_expires_at: { type: "string", format: "date-time" } }),
    csrf_token: { type: "string", description: "Send as X-CSRF-Token on every request that changes something" },
    member: strict({ id: str, email: str, name: str,
      has_password: { type: "boolean", description: "The member has set a password (they can confirm it's them with it)" },
      sso_linked: { type: "boolean", description: "The member is linked to the single sign-on provider" } }),
    workspace: object({ id: str, name: str, sign_in: ref("SignInSettings") }),
    role: str, permissions: list(str),
    server: strict({
      connected_apps: { type: "boolean", description: "OAuth for MCP is turned on on this server (MCP_PUBLIC_URL), so members can connect apps; the workspace may still refuse it (sign_in.oauth_apps)" },
    }),
  }),
  Automation: object({
    id: str, name: str, description: nullable(str), enabled: bool,
    status: { type: "string", enum: ["enabled", "paused", "disabled", "archived"] },
    paused_at: nullable({ type: "string", format: "date-time" }), paused_reason: nullable(str), consecutive_failures: int,
    trigger: { type: "object", additionalProperties: true, description: "{type: event, event, changed_fields?, include_reference_moves?} | {type: schedule, …} | {type: manual, object?}" },
    condition: { description: "A filter in the query format, or null" },
    actions: { type: "array", items: anyObject, description: "The steps; secret header values are always null" },
    hourly_cap: int, run_roles: list(str), next_run_at: nullable({ type: "string", format: "date-time" }), version: int,
    created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
  }, ["id", "name", "enabled", "status", "trigger", "actions", "hourly_cap", "run_roles", "version"]),
  AutomationWrite: object({
    dry_run: bool, summary: str, warnings: list(str), next_runs: list(str),
    automation: { type: "object", additionalProperties: true, description: "The automation as saved (an Automation), or as it would be after a dry run" },
  }, ["dry_run", "summary", "warnings", "automation"]),
  AutomationRun: object({
    id: str, trigger: { type: "string", enum: ["event", "schedule", "manual"] }, event_id: nullable(str), record_id: nullable(str),
    scheduled_for: nullable(str), requested_by: nullable(str),
    requested_via: nullable({ type: "object", additionalProperties: true, description: "For a run requested by hand: the credential it was requested through (kind key, session or oauth, with its ID; for oauth the grant and client)" }),
    status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "skipped"] }, reason: nullable(str),
    cap: nullable(str), failure: nullable({ type: "string", enum: ["data", "target", "config"] }), depth: int, attempts: int,
    usage: anyObject, results: { type: "array", items: anyObject }, started_at: str, finished_at: nullable(str),
  }, ["id", "trigger", "status", "reason", "results", "started_at"]),
  AutomationSettings: strict({ paused: bool, paused_at: nullable(str), paused_reason: nullable(str), external_email: bool, timezone: str }),
  SchedulePreview: strict({ summary: str, timezone: str, next_runs: list(str) }),
  Suppression: strict({ suppressed: bool, recipient: { type: "string", description: "A keyed hash of the mailbox, never the address" },
    since: nullable(str), reason: nullable(str), removed: bool }, ["suppressed", "recipient"]),
  Notification: object(notification),
  NotificationDetail: object({
    ...notification,
    deliveries: { ...list(object({
      channel: enumOf("email"), mode: enumOf("immediate", "digest"), status: enumOf("pending", "sent", "failed", "skipped"), attempts: int,
      scheduled_for: { ...nullable(time), description: "While pending: when it is due to go out" }, last_error: nullable(str), sent_at: nullable(time),
    })), description: "Its email deliveries, oldest first (none when the recipient's preferences turn its severity off)" },
  }),
  NotificationPreferences: object({
    email: { ...object({ info: enumOf("off", "immediate", "digest"), warning: enumOf("off", "immediate", "digest"), critical: enumOf("off", "immediate", "digest") }),
      description: "Per severity: email at once, in the daily digest, or not at all" },
    digest_hour: { type: "integer", minimum: 0, maximum: 23 }, timezone: { type: "string", description: "An IANA time zone name" },
    quiet_hours: { ...nullable(object({ start: str, end: str })), description: "HH:MM to HH:MM local time when non-critical emails wait, or null" },
  }),
  Alert: object({
    id: str, scope: enumOf("workspace", "personal"), owner: { ...nullable(str), description: "A personal alert's member (usr_…); null for a workspace alert" },
    name: str, description: nullable(str), object: str,
    trigger: { type: "object", additionalProperties: true, properties: { type: enumOf("event", "inactive", "field_passed") }, required: ["type"],
      description: "{type: event, event, changed_fields?} | {type: inactive, days} | {type: field_passed, field, offset_hours?}" },
    condition: { description: "A filter in the query format, or null" },
    severity: enumOf("info", "warning", "critical"),
    recipients: object({ record_owner: bool, users: list(str) }), webhooks: list(str), cooldown_hours: nullable(int), enabled: bool,
    status: enumOf("enabled", "disabled", "archived"),
    deadlines: { ...nullable(enumOf("ready", "building")), description: "Time rules: whether their deadlines have been computed yet; null for event rules" },
    version: int, created_at: time, updated_at: time,
  }),
  AlertBacktest: {
    description: "How often a rule would have fired recently, with up to 10 samples. Event rules replay the event history; time rules count records already past their deadline",
    anyOf: [
      object({ window_days: int, would_fire: int, records: int, samples: list(alertSample), approximate: bool, note: str, truncated: bool }),
      object({ window_days: int, would_fire_on_save: int, became_due_in_window: int, samples: list(alertSample), approximate: bool, note: str, truncated: bool }),
    ],
  },
  AlertWrite: object({
    dry_run: bool, summary: str, warnings: list(str), backtest: ref("AlertBacktest"),
    alert: { ...ref("Alert"), description: "The alert as saved; absent on a dry run" },
  }, ["dry_run", "summary", "warnings", "backtest"]),
  Webhook: object(webhook),
  WebhookWithSecret: object({
    ...webhook,
    secret: { ...nullable(str), description: "The signing secret, shown this once; null through MCP" },
    secret_note: { type: "string", description: "Through MCP: where to get the secret instead" },
  }, [...Object.keys(webhook), "secret"]),
  WebhookDelivery: object({
    id: str, webhook_id: str, event_id: nullable(str), event_type: str,
    trigger: { ...enumOf("subscription", "automation", "replay", "test"), description: "What queued it: an event subscription, an automation or alert rule, a replay or a test" },
    automation_id: nullable(str), status: enumOf("pending", "succeeded", "dead"), attempts: int,
    next_attempt_at: nullable(time), last_attempt_at: nullable(time), last_status_code: nullable(int), last_error: nullable(str),
    last_duration_ms: nullable(int), replay_of: { ...nullable(str), description: "On a replay: the delivery it copies" },
    created_at: time, delivered_at: nullable(time),
    payload: { type: "object", additionalProperties: true,
      description: "The body sent: the event (id, type, occurred_at, object, record_id, actor, data) with the record and automation, as queued. Open by design: event data differs per event type. Restricted values are never shown" },
  }),
  AutomationTest: object({
    matched: { type: "boolean", description: "false when the record doesn't match the condition (nothing would happen)" }, explanation: str,
    actions: { type: "array", items: anyObject, description: "Each step that would run, with its (redacted) inputs and what it would do" },
    stopped: { type: "string", description: "When a stop step would end the run: its reason" },
    error: { type: "string", description: "When a step would fail: why" },
  }, ["matched", "explanation", "actions"]),
};

/** The responses map of one operation: the declared success, and problem documents for everything else. */
export function responsesFor(spec: ResponseSpec | undefined): Record<string, unknown> {
  const problem = { description: "An RFC 9457 problem document", content: { "application/problem+json": { schema: ref("Problem") } } };
  if (!spec) return { default: problem };
  const ok = { description: spec.description ?? "Success", content: { [spec.contentType ?? "application/json"]: { schema: spec.schema } } };
  return { [String(spec.status ?? 200)]: ok, ...(spec.alsoStatus ? { [String(spec.alsoStatus)]: { ...ok, description: "Success (a dry run)" } } : {}), default: problem };
}

/** Scalar shapes for route declarations. */
export const S = { str, int, bool, obj: anyObject, any: {} as JsonSchema, strs: list(str), time };

/** A create that answers 201, or 200 for its dry run. */
export const createdOrDry = (s: JsonSchema = anyObject): ResponseSpec => ({ schema: s, status: 201, alsoStatus: 200 });

export const R = {
  record: data(ref("Record")),
  created: data(ref("Record"), 201),
  records: dataList(ref("Record")),
  page: plain(ref("RecordPage")),
  op: plain(ref("OpResult")),
  aggregate: plain(ref("Aggregate")),
  bulk: plain(ref("BulkResult")),
  merge: plain(ref("MergeResult")),
  duplicates: plain(ref("DuplicateGroups")),
  restored: plain(object({ data: ref("Record"), warnings: list(object({ field: str, message: str })) })),
  view: data(ref("View")),
  views: dataList(ref("View")),
  any: data(),
  anyData: data({}),
  anyList: dataList(),
  object: plain(anyObject),
  automation: data(ref("Automation")),
  automations: dataList(ref("Automation")),
  automationWrite: plain(ref("AutomationWrite")),
  automationRuns: dataList(ref("AutomationRun")),
  automationSettings: data(ref("AutomationSettings")),
  schedulePreview: data(ref("SchedulePreview")),
  suppression: data(ref("Suppression")),
  notification: data(ref("NotificationDetail")),
  notificationPreferences: data(ref("NotificationPreferences")),
  attention: data(object({
    generated_at: time,
    counts: { ...object({ critical: int, warning: int, info: int, unread: int, snoozed: int }), description: "Open notifications per severity (not counting snoozed ones), unread, and snoozed" },
    items: { ...list(object({ ...notification, why: { ...nullable(str), description: "The alert's or automation's description" }, next_step: str })),
      description: "Up to 25 open notifications, most severe first" },
    overdue_tasks: { ...nullable(list(object({ id: str, title: str, due_at: time, priority: enumOf("low", "normal", "high", "urgent") }, ["id"]))),
      description: "My overdue open tasks (up to 10), with the fields I can read; null when the list would reveal fields I can't read (see overdue_tasks_note)" },
    overdue_tasks_note: str,
    guidance: str,
  }, ["generated_at", "counts", "items", "overdue_tasks", "guidance"])),
  alert: data(ref("Alert")),
  alerts: dataList(ref("Alert")),
  alertBacktest: data(object({ summary: str, warnings: list(str), backtest: ref("AlertBacktest") })),
  alertWrite: plain(ref("AlertWrite")),
  webhook: data(ref("Webhook")),
  webhooks: dataList(ref("Webhook")),
  webhookWithSecret: data(ref("WebhookWithSecret")),
  webhookDelivery: data(ref("WebhookDelivery")),
  automationTest: data(ref("AutomationTest")),
};
