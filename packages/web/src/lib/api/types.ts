/**
 * Typed shapes of the API responses the app uses. Record shapes are deliberately loose: what an object
 * holds comes from describe at runtime (src/meta), never from these types. The record, page,
 * aggregate and view shapes come from the SDK (@hl-crm-db/sdk), which mirrors the server's
 * declared responses; the rest are written here for the routes the app calls (see README.md, "Types").
 */
import type { AggregateRequest, AggregateResult, GroupBy, Page, QueryRequest, RecordData, SavedView, Sort, Where } from "@hl-crm-db/sdk";

export type { AggregateRequest, AggregateResult, GroupBy, Page, QueryRequest, RecordData, SavedView, Sort, Where };

export interface Envelope<T> { data: T }

/** The scopes a connected app (OAuth, for the MCP servers) may be granted. */
export type OAuthScope = "ops:read" | "ops:write" | "restricted:read" | "admin";
export interface SignInSettings { password: boolean; sso: boolean; sso_allowed_domains: string[]; oauth_apps: boolean; oauth_scopes: OAuthScope[] }

/** One approved connection (an OAuth grant) of one member, one app and one MCP endpoint. */
export interface ConnectedApp {
  id: string; member: string;
  client: { id: string; name: string; kind: "metadata_document" | "registered"; verified_by_document: boolean; redirect_host: string };
  scopes: string[]; resource: string; created_at: string; last_used_at: string | null; expires_at: string;
}

export type AutomationStatus = "enabled" | "paused" | "disabled" | "archived";
export interface Automation {
  id: string; name: string; description?: string | null; enabled: boolean; status: AutomationStatus;
  paused_at?: string | null; paused_reason?: string | null; consecutive_failures?: number;
  trigger: { type: "event" | "schedule" | "manual" | (string & {}); event?: string; object?: string; [k: string]: unknown };
  hourly_cap: number; run_roles: string[]; next_run_at?: string | null; version: number; updated_at?: string;
}
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped";
export interface AutomationRun {
  id: string; trigger: string; status: RunStatus; reason: string | null; cap?: string | null; failure?: "data" | "target" | "config" | null;
  started_at: string; finished_at?: string | null;
}

export interface InstalledPack {
  name: string; version: string; status: "installed" | "uninstalled"; description: string;
  owns: { objects: string[]; fields: string[]; pipelines: string[]; roles: string[]; views: string[] };
  installed_at: string; installed_by: string | null; updated_at: string;
}

export interface Workspace {
  id: string; name: string; currency: string; modules: string[]; kind?: string; sign_in: SignInSettings; schema_version?: number;
}

export interface SessionInfo {
  session: { id: string; method: string; signed_in_at: string; expires_at: string; idle_expires_at: string };
  csrf_token: string;
  /** `has_password` and `sso_linked` decide which ways of confirming it's them can work (lib/signin.ts). */
  member: { id: string; email: string; name: string; has_password: boolean; sso_linked: boolean };
  workspace: Workspace;
  role: string;
  /** Keys of the permission sets the member holds on top of their role. */
  permission_sets?: string[];
  permissions: string[];
  /** What this server has turned on: connecting apps over OAuth for the MCP servers (MCP_PUBLIC_URL). */
  server: { connected_apps: boolean };
}

export interface Capabilities {
  enabled: boolean;
  methods: { email_code: boolean; password: boolean; sso: { name: string; start: string } | null };
  code_length: number;
  /** A person may create a workspace of their own on this server (the built-in page at /auth/sign-up). Absent on older servers. */
  sign_up?: boolean;
}

export type SignInAnswer =
  | { status: "signed_in"; workspace: { id: string; name: string }; return_to: string; csrf_token: string; expires_at: string; idle_expires_at: string }
  | { status: "choose_workspace"; workspaces: { id: string; name: string }[]; more_workspaces?: boolean }
  | { status: "code_sent"; detail?: string }
  | { status: "redirect"; redirect_url: string };

/** The field types this UI knows. A newer server may send others: see `KnownFieldType` and meta/registry.tsx's fallback. */
export type KnownFieldType =
  | "text" | "long_text" | "number" | "currency" | "boolean" | "date" | "datetime" | "single_select" | "multi_select"
  | "email" | "phone" | "url" | "relation" | "status" | "address" | "json" | "rating" | "percent" | "duration";
// Any string, so describe output from a newer server type-checks; the registry shows unknown types read-only.
export type FieldType = KnownFieldType | (string & {});

/** One part of an address field (describe's `parts`): filterable, sortable and groupable as `field.part`. */
export interface AddressPart { name: string; label?: string; type?: string }

export interface SelectValue { key: string; label: string; category?: string }

export type FieldAccess = "none" | "read" | "write";

export interface FieldMeta {
  name: string;
  label: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  read_only?: boolean;
  create_only?: boolean;
  unique?: boolean;
  hidden?: boolean;
  sensitivity?: "confidential" | "restricted";
  standard?: boolean;
  values?: SelectValue[];
  relation?: { to: string; cardinality: "many_to_one" | "many_to_many" };
  initial?: string;
  /** Custom status fields: status key → keys it may move to. */
  transitions?: Record<string, string[]>;
  /** Standard status fields: category → categories it may move to. */
  category_transitions?: Record<string, string[]>;
  /** Categories only a named operation may set (a lead's "converted"). */
  operation_only_categories?: string[];
  default?: unknown;
  validation?: { min?: number; max?: number; max_length?: number; pattern?: string };
  access?: FieldAccess;
  /** address: its parts (line1, line2, city, region, postal_code, country). */
  parts?: (AddressPart | string)[];
  /** json: the expected shape, informational; `path_filters: true` when the API filters by a path inside it. */
  shape?: unknown;
  path_filters?: boolean;
  /** rating: the highest value (1..max). percent: the bounds, in percentage points. */
  max?: number;
  min?: number;
  /** percent: "percent"; duration: "seconds". */
  unit?: string;
}

export interface ObjectAccess { read: boolean; write: boolean; archive: boolean }

export interface ObjectSummary {
  name: string; label: string; plural_label: string; description?: string; id_prefix: string; standard: boolean;
  module?: string; owned: boolean; display_field?: string; hidden?: boolean; field_count: number; access: ObjectAccess;
}

export interface Stage { id: string; name: string; category: "open" | "won" | "lost"; default_probability: number | null }
export interface Pipeline { id: string; name: string; is_default: boolean; stages: Stage[] }
export interface ActivityType { key: string; label: string; editable: boolean }
export interface DirectoryUser { id: string; name: string; email: string }

export interface ObjectMeta extends Omit<ObjectSummary, "field_count" | "hidden"> {
  currency: string;
  system_fields: string[];
  fields: FieldMeta[];
  users?: DirectoryUser[];
  pipelines?: Pipeline[];
  activity_types?: ActivityType[];
  virtual_fields?: { name: string; type: string; description: string }[];
}

export interface RelatedRef { id: string; object: string | null; display_name: string | null }

export interface TimelineItem {
  kind: "activity" | "task" | "stage_change";
  at: string;
  item: RecordData & { from?: string | null; to?: string; status?: string; related?: RelatedRef[] };
}

export interface OpResult<T = unknown> { dry_run: boolean; result: T; would?: string[] }

export type Severity = "info" | "warning" | "critical";
export interface NotificationItem {
  id: string; severity: Severity; title: string; body: string | null;
  state: "unread" | "acknowledged" | "snoozed" | "resolved"; snoozed_until: string | null;
  fire_count: number; first_fired_at: string; last_fired_at: string;
  source: { type: "alert" | "automation"; id: string; name: string | null };
  record: { id: string; object: string; display_name: string } | null;
  why?: string | null;
}
export interface Attention {
  generated_at: string;
  counts: { critical: number; warning: number; info: number; unread: number; snoozed: number };
  items: NotificationItem[];
  overdue_tasks: { id: string; title?: string; due_at?: string; priority?: string }[] | null;
  overdue_tasks_note?: string;
  guidance: string;
}
export type EmailLevel = "off" | "immediate" | "digest";
export interface NotificationPrefs {
  email: Record<Severity, EmailLevel>; digest_hour: number; timezone: string; quiet_hours: { start: string; end: string } | null;
}

export interface SessionRow {
  id: string; method: string; signed_in_at: string; last_seen_at: string; idle_expires_at: string; expires_at: string;
  user_agent: string | null; client_address: string | null; current?: boolean;
}

export interface MemberUser {
  id: string; email: string; name: string; role: string; role_name: string; permission_sets?: string[]; active: boolean;
  sign_in?: { has_password: boolean; sso_linked: boolean; last_sign_in_at: string | null; active_sessions: number };
}
export interface ServiceAccount { id: string; name: string; role: string; role_name?: string; permission_sets?: string[]; active: boolean }
export interface Members { users: MemberUser[]; service_accounts: ServiceAccount[] }

/** A file attached to a record. `content_type` is detected by the server, for showing; downloads are always attachments. */
export interface FileInfo {
  id: string; record: string; name: string; size: number; content_type: string; sha256: string; scan_status: string;
  uploaded_by: string | null; created_at: string;
}

export interface RoleObjectRule { read: boolean | null; write: boolean | null; archive: boolean | null }
export interface Role {
  /** `is_system` is absent on a permission set (there are no system sets). */
  id: string; key: string; name: string; description: string | null; permissions: string[]; is_system?: boolean;
  objects: Record<string, RoleObjectRule>; fields: Record<string, Record<string, "none" | "read">>;
  created_at: string; updated_at: string; archived_at: string | null; active_members: number;
}
/** `category`: "records" is what may be done with records (objects and fields refine it); "features" is a feature of the CRM. */
export interface PermissionInfo { key: string; description: string; category?: "records" | "features"; requires: string[] }
export interface AccessRow {
  object: string; read: boolean; write: boolean; archive: boolean; rule: RoleObjectRule | null;
  fields: Record<string, FieldAccess>; restricted_fields: { field: string; values: "visible" | "redacted" }[];
}
export interface RoleAccess { role?: string; permission_set?: string; permissions: string[]; objects: AccessRow[] }

export interface ApiKey {
  id: string; name: string; owner: string; scopes: string[]; environment: "live" | "test"; hint: string;
  created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null;
}

export interface Webhook {
  id: string; url: string; description: string | null; events: string[]; enabled: boolean; include_restricted?: boolean;
  created_at: string; consecutive_failures?: number; paused_until?: string | null; secret?: string; [k: string]: unknown;
}
export interface Delivery {
  id: string; status: "pending" | "succeeded" | "dead" | string; attempts: number; event_type?: string; event?: string;
  last_status?: number | null; last_error?: string | null; created_at?: string; next_attempt_at?: string | null; [k: string]: unknown;
}

export interface AuditEntry {
  seq: number; at: string; action: string; surface: string; actor: string; key: string | null; object: string | null;
  record_id: string | null; request_id: string | null; details: unknown; sealed: boolean;
}
