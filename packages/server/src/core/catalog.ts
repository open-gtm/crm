/**
 * The standard object catalog: the single definition of the Core and Sales modules.
 * It is seeded into each workspace's metadata (objects, fields) when the workspace is
 * created, so standard and custom objects are discovered the same way.
 * Every `column` here must exist in the migrations; a test checks this.
 */

export type FieldType =
  | "text" | "long_text" | "number" | "currency" | "boolean" | "date" | "datetime"
  | "single_select" | "multi_select" | "email" | "phone" | "url" | "relation" | "status"
  | "address" | "json" | "rating" | "percent" | "duration";

export type Sensitivity = "standard" | "confidential" | "restricted";

export interface SelectValue { key: string; label: string; category?: string }

export interface FieldOptions {
  /** single_select, multi_select, status */
  values?: SelectValue[];
  /** relation: target object api_name, or one of the platform entities user | pipeline | stage */
  to?: string;
  cardinality?: "many_to_one" | "many_to_many";
  /** status: the default value for new records */
  initial?: string;
  /** status: categories that can only be reached through a named operation */
  operation_only_categories?: string[];
  /** rating: the highest rating (1 to 10, default 5) */
  max?: number;
  /** json: an optional declarative check of the value's shape (core/fieldtypes.ts JsonShape) */
  shape?: JsonShape;
}

/** A small declarative subset of a JSON value's shape: its kind, required keys and the kinds of named keys. Not JSON Schema. */
export interface JsonShape {
  type?: JsonKind;
  required?: string[];
  properties?: Record<string, JsonKind>;
  /** false: keys other than `properties` are refused. */
  additional_properties?: boolean;
}
export type JsonKind = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface CatalogField {
  api_name: string;
  label: string;
  type: FieldType;
  column: string;
  description?: string;
  required?: boolean;
  read_only?: boolean;
  /** Set on create only; later changes go through a named operation. */
  create_only?: boolean;
  sensitivity?: Sensitivity;
  options?: FieldOptions;
}

export interface CatalogObject {
  api_name: string;
  label: string;
  plural_label: string;
  description: string;
  id_prefix: string;
  module: "core" | "sales";
  table: string;
  owned: boolean;
  fields: CatalogField[];
}

/** The owner of an owned object's records: on the standard objects below, and on every owned custom object (core/schema.ts). */
export const OWNER_FIELD: CatalogField = {
  api_name: "owner", label: "Owner", type: "relation", column: "owner_id",
  description: "The user who owns this record.", options: { to: "user", cardinality: "many_to_one" },
};
const owner = OWNER_FIELD;

const lifecycle: SelectValue[] = [
  { key: "subscriber", label: "Subscriber", category: "subscriber" },
  { key: "lead", label: "Lead", category: "lead" },
  { key: "opportunity", label: "Opportunity", category: "opportunity" },
  { key: "customer", label: "Customer", category: "customer" },
  { key: "former_customer", label: "Former customer", category: "former_customer" },
];

export const CATALOG: CatalogObject[] = [
  {
    api_name: "account", label: "Account", plural_label: "Accounts", id_prefix: "acct", module: "core",
    table: "accounts", owned: true,
    description: "An organization or company. Deduplicated on its primary domain.",
    fields: [
      { api_name: "name", label: "Name", type: "text", column: "name", required: true },
      { api_name: "domain", label: "Domain", type: "text", column: "primary_domain",
        description: "Primary web domain, e.g. acme.com. Unique per workspace." },
      { api_name: "industry", label: "Industry", type: "text", column: "industry" },
      { api_name: "employee_count", label: "Employees", type: "number", column: "employee_count" },
      { api_name: "type", label: "Type", type: "single_select", column: "type", options: { values: [
        { key: "prospect", label: "Prospect" }, { key: "customer", label: "Customer" },
        { key: "partner", label: "Partner" }, { key: "former_customer", label: "Former customer" },
      ] } },
      { api_name: "parent_account", label: "Parent account", type: "relation", column: "parent_account_id",
        options: { to: "account", cardinality: "many_to_one" } },
      owner,
    ],
  },
  {
    api_name: "contact", label: "Contact", plural_label: "Contacts", id_prefix: "con", module: "core",
    table: "contacts", owned: true,
    description: "A person, whether or not they are a customer yet. Deduplicated on email.",
    fields: [
      { api_name: "first_name", label: "First name", type: "text", column: "first_name", sensitivity: "confidential" },
      { api_name: "last_name", label: "Last name", type: "text", column: "last_name", sensitivity: "confidential" },
      { api_name: "email", label: "Email", type: "email", column: "primary_email", sensitivity: "confidential",
        description: "Primary email. Unique per workspace." },
      { api_name: "phone", label: "Phone", type: "phone", column: "primary_phone", sensitivity: "confidential" },
      { api_name: "job_title", label: "Job title", type: "text", column: "job_title" },
      { api_name: "lifecycle_stage", label: "Lifecycle stage", type: "status", column: "lifecycle_stage",
        options: { values: lifecycle, initial: "subscriber" } },
      { api_name: "source", label: "Source", type: "text", column: "source" },
      { api_name: "account", label: "Primary account", type: "relation", column: "primary_account_id",
        options: { to: "account", cardinality: "many_to_one" } },
      owner,
    ],
  },
  {
    api_name: "account_contact", label: "Account contact", plural_label: "Account contacts", id_prefix: "acon",
    module: "core", table: "account_contacts", owned: false,
    description: "A person's relationship to an organization: role, primary flag and dates.",
    fields: [
      { api_name: "account", label: "Account", type: "relation", column: "account_id", required: true, create_only: true,
        options: { to: "account", cardinality: "many_to_one" } },
      { api_name: "contact", label: "Contact", type: "relation", column: "contact_id", required: true, create_only: true,
        options: { to: "contact", cardinality: "many_to_one" } },
      { api_name: "role", label: "Role", type: "text", column: "role" },
      { api_name: "is_primary", label: "Primary", type: "boolean", column: "is_primary" },
      { api_name: "start_date", label: "Start date", type: "date", column: "start_date" },
      { api_name: "end_date", label: "End date", type: "date", column: "end_date" },
    ],
  },
  {
    api_name: "activity", label: "Activity", plural_label: "Activities", id_prefix: "act", module: "core",
    table: "activities", owned: false,
    description: "Something that happened: an email, call, meeting, note or form fill. Activities are history and are not edited, except notes.",
    fields: [
      { api_name: "type", label: "Type", type: "single_select", column: "type_key", required: true, create_only: true,
        description: "An activity type key, e.g. note, call_logged, email_sent, meeting_held." },
      { api_name: "occurred_at", label: "Occurred at", type: "datetime", column: "occurred_at", create_only: true },
      { api_name: "subject", label: "Subject", type: "text", column: "subject" },
      { api_name: "body", label: "Body", type: "long_text", column: "body", sensitivity: "confidential" },
      { api_name: "actor_contact", label: "Done by contact", type: "relation", column: "actor_contact_id", create_only: true,
        options: { to: "contact", cardinality: "many_to_one" } },
      { api_name: "actor_user", label: "Done by user", type: "relation", column: "actor_user_id", read_only: true,
        options: { to: "user", cardinality: "many_to_one" } },
      { api_name: "source", label: "Source", type: "text", column: "source", create_only: true },
    ],
  },
  {
    api_name: "task", label: "Task", plural_label: "Tasks", id_prefix: "task", module: "core",
    table: "tasks", owned: false,
    description: "An action an internal user needs to take.",
    fields: [
      { api_name: "title", label: "Title", type: "text", column: "title", required: true },
      { api_name: "description", label: "Description", type: "long_text", column: "description" },
      { api_name: "assignee", label: "Assignee", type: "relation", column: "assignee_user_id",
        description: "Defaults to the calling user.", options: { to: "user", cardinality: "many_to_one" } },
      { api_name: "due_at", label: "Due", type: "datetime", column: "due_at" },
      { api_name: "priority", label: "Priority", type: "single_select", column: "priority", options: { values: [
        { key: "low", label: "Low" }, { key: "normal", label: "Normal" },
        { key: "high", label: "High" }, { key: "urgent", label: "Urgent" },
      ] } },
      { api_name: "status", label: "Status", type: "status", column: "status", options: { initial: "open", values: [
        { key: "open", label: "Open", category: "open" },
        { key: "in_progress", label: "In progress", category: "in_progress" },
        { key: "done", label: "Done", category: "done" },
        { key: "cancelled", label: "Cancelled", category: "cancelled" },
      ] } },
      { api_name: "completed_at", label: "Completed at", type: "datetime", column: "completed_at", read_only: true },
    ],
  },
  {
    api_name: "lead", label: "Lead", plural_label: "Leads", id_prefix: "lead", module: "sales",
    table: "leads", owned: true,
    description: "A person's expressed interest. Always belongs to one contact. Becomes a deal through convert_lead.",
    fields: [
      { api_name: "contact", label: "Contact", type: "relation", column: "contact_id", required: true, create_only: true,
        options: { to: "contact", cardinality: "many_to_one" } },
      { api_name: "account", label: "Account", type: "relation", column: "account_id",
        options: { to: "account", cardinality: "many_to_one" } },
      { api_name: "interest", label: "Interest", type: "text", column: "interest_text" },
      { api_name: "campaign", label: "Campaign", type: "text", column: "interest_campaign" },
      { api_name: "source", label: "Source", type: "text", column: "source" },
      { api_name: "channel", label: "Channel", type: "text", column: "channel" },
      { api_name: "status", label: "Status", type: "status", column: "status", options: {
        initial: "new", operation_only_categories: ["converted"], values: [
          { key: "new", label: "New", category: "new" },
          { key: "working", label: "Working", category: "working" },
          { key: "qualified", label: "Qualified", category: "qualified" },
          { key: "disqualified", label: "Disqualified", category: "disqualified" },
          { key: "converted", label: "Converted", category: "converted" },
        ] } },
      { api_name: "disqualification_reason", label: "Disqualification reason", type: "text", column: "disqualification_reason" },
      { api_name: "score", label: "Score", type: "number", column: "score" },
      { api_name: "converted_deal", label: "Converted deal", type: "relation", column: "converted_deal_id", read_only: true,
        options: { to: "deal", cardinality: "many_to_one" } },
      { api_name: "converted_at", label: "Converted at", type: "datetime", column: "converted_at", read_only: true },
      owner,
    ],
  },
  {
    api_name: "deal", label: "Deal", plural_label: "Deals", id_prefix: "deal", module: "sales",
    table: "deals", owned: true,
    description: "A qualified opportunity in a pipeline. Change its stage with move_deal_stage.",
    fields: [
      { api_name: "name", label: "Name", type: "text", column: "name", required: true },
      { api_name: "account", label: "Account", type: "relation", column: "account_id",
        options: { to: "account", cardinality: "many_to_one" } },
      { api_name: "primary_contact", label: "Primary contact", type: "relation", column: "primary_contact_id", required: true,
        options: { to: "contact", cardinality: "many_to_one" } },
      { api_name: "pipeline", label: "Pipeline", type: "relation", column: "pipeline_id", create_only: true,
        description: "Defaults to the workspace's default pipeline.", options: { to: "pipeline", cardinality: "many_to_one" } },
      { api_name: "stage", label: "Stage", type: "relation", column: "stage_id", create_only: true,
        description: "Stage ID or stage name. Defaults to the pipeline's first stage. Change later with move_deal_stage.",
        options: { to: "stage", cardinality: "many_to_one" } },
      { api_name: "amount", label: "Amount", type: "currency", column: "amount_minor" },
      { api_name: "currency", label: "Currency", type: "text", column: "currency", read_only: true },
      { api_name: "expected_close_date", label: "Expected close date", type: "date", column: "expected_close_date" },
      { api_name: "probability", label: "Probability (%)", type: "number", column: "probability" },
      { api_name: "status", label: "Status", type: "single_select", column: "status_category", read_only: true,
        description: "Derived from the stage: open, won or lost.", options: { values: [
          { key: "open", label: "Open" }, { key: "won", label: "Won" }, { key: "lost", label: "Lost" },
        ] } },
      { api_name: "lost_reason", label: "Lost reason", type: "text", column: "lost_reason" },
      { api_name: "source_lead", label: "Source lead", type: "relation", column: "source_lead_id", read_only: true,
        options: { to: "lead", cardinality: "many_to_one" } },
      { api_name: "last_activity_at", label: "Last activity", type: "datetime", column: "last_activity_at", read_only: true },
      { api_name: "stage_entered_at", label: "Stage entered at", type: "datetime", column: "stage_entered_at", read_only: true },
      owner,
    ],
  },
  {
    api_name: "deal_contact", label: "Deal contact", plural_label: "Deal contacts", id_prefix: "dcon", module: "sales",
    table: "deal_contacts", owned: false,
    description: "A person involved in a deal, with their role.",
    fields: [
      { api_name: "deal", label: "Deal", type: "relation", column: "deal_id", required: true, create_only: true,
        options: { to: "deal", cardinality: "many_to_one" } },
      { api_name: "contact", label: "Contact", type: "relation", column: "contact_id", required: true, create_only: true,
        options: { to: "contact", cardinality: "many_to_one" } },
      { api_name: "role", label: "Role", type: "single_select", column: "role", options: { values: [
        { key: "decision_maker", label: "Decision maker" }, { key: "champion", label: "Champion" },
        { key: "influencer", label: "Influencer" }, { key: "signer", label: "Signer" },
        { key: "billing", label: "Billing contact" },
      ] } },
    ],
  },
];

export const ACTIVITY_TYPES = [
  { key: "note", label: "Note", editable: true },
  { key: "email_sent", label: "Email sent" },
  { key: "email_opened", label: "Email opened" },
  { key: "email_replied", label: "Email replied" },
  { key: "form_submitted", label: "Form submitted" },
  { key: "meeting_scheduled", label: "Meeting scheduled" },
  { key: "meeting_held", label: "Meeting held" },
  { key: "call_logged", label: "Call logged" },
  { key: "task_completed", label: "Task completed" },
  { key: "lead_converted", label: "Lead converted" },
  { key: "deal_stage_changed", label: "Deal stage changed" },
];

export const DEFAULT_PIPELINE = {
  name: "Sales",
  stages: [
    { name: "Qualification", category: "open", probability: 10 },
    { name: "Discovery", category: "open", probability: 25 },
    { name: "Proposal", category: "open", probability: 50 },
    { name: "Negotiation", category: "open", probability: 75 },
    { name: "Closed won", category: "won", probability: 100 },
    { name: "Closed lost", category: "lost", probability: 0 },
  ],
} as const;

/** Platform entities that relation fields can point at, but which are not records. */
export const ENTITIES = {
  user: { prefix: "usr", table: "users" },
  pipeline: { prefix: "pipe", table: "pipelines" },
  stage: { prefix: "stg", table: "stages" },
} as const;
export type EntityName = keyof typeof ENTITIES;
// Own-property checks: `in` and bracket lookups would also find Object.prototype members ("constructor").
export const isEntity = (name: string): name is EntityName => typeof name === "string" && Object.hasOwn(ENTITIES, name);

/** Looks up a tenant-supplied key in a constant table without walking the prototype chain. */
export const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Status categories per standard object, and the allowed moves between them. */
export const STATUS_MACHINES: Record<string, Record<string, string[]>> = {
  "lead.status": {
    new: ["working", "qualified", "disqualified"],
    working: ["qualified", "disqualified"],
    qualified: ["working", "disqualified", "converted"],
    disqualified: ["working"],
    converted: [],
  },
  "task.status": {
    open: ["in_progress", "done", "cancelled"],
    in_progress: ["open", "done", "cancelled"],
    done: ["open"],
    cancelled: ["open"],
  },
  "contact.lifecycle_stage": {
    subscriber: ["lead", "opportunity", "customer", "former_customer"],
    lead: ["subscriber", "opportunity", "customer", "former_customer"],
    opportunity: ["subscriber", "lead", "customer", "former_customer"],
    customer: ["former_customer", "opportunity", "lead", "subscriber"],
    former_customer: ["customer", "opportunity", "lead", "subscriber"],
  },
};

/** Columns that store a status category alongside the status value. */
export const STATUS_CATEGORY_COLUMNS: Record<string, string> = {
  "lead.status": "status_category",
  "task.status": "status_category",
  "contact.lifecycle_stage": "lifecycle_category",
};
