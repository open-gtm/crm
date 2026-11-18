import { z } from "zod";
import { describeAccess } from "../core/access.js";
import { verifyInTx } from "../core/auditchain.js";
import { PREVIEW_PER_TOKEN, previewCreates } from "../core/bulk.js";
import { describeObject, listObjects, schemaChanges, schemaSummary } from "../core/describe.js";
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "../core/keys.js";
import { assignOwner, captureInterest, convertLead, moveDealStage, myOpenTasks, search, timeline } from "../core/ops.js";
import { createPipeline, listPipelines } from "../core/pipelines.js";
import { URL_PREDICATES, type Predicate, type SortInput, type Where } from "../core/query.js";
import { listRecords, readRecord } from "../core/reads.js";
import {
  archiveRecord, createRecord, updateRecord,
} from "../core/records.js";
import { addField, archiveField, createObject, loadSchema, setModules, updateField, updateObject } from "../core/schema.js";
import { FIELD_TYPES } from "../core/fieldtypes.js";
import type { JsonShape } from "../core/catalog.js";
import { actorRef } from "../core/webhooks.js";
import { archiveRole, createRole, getRole, listRoles, permissionCatalog, roleAccess, updateRole } from "../core/roles.js";
import { accessReview, addMember, addServiceAccount, getWorkspace, listMembers, updateMember } from "../core/workspace.js";
import { badRequest, unprocessable } from "../lib/errors.js";
import { requireRecentSignIn } from "../auth/sessions.js";
import { invitationUnavailable, reserveInvitation, sendInvitation } from "../auth/signin.js";
import { encodeId } from "../lib/ids.js";
import { TEXT_MAX } from "../lib/limits.js";
import { SERVER_VERSION } from "../lib/version.js";
import { route } from "./registry.js";
import { createdOrDry, data, dataList, list, nullable, object, plain, R, ref, S } from "./responses.js";

const Values = z.record(z.string(), z.unknown());
const DryRun = z.object({ dry_run: z.boolean().optional() });
const Sensitivity = z.enum(["standard", "confidential", "restricted"]);
const SelectValue = z.object({ key: z.string(), label: z.string(), category: z.string().optional() });
const FieldType = z.enum(FIELD_TYPES);
const FieldInput = z.object({
  api_name: z.string(),
  label: z.string().optional(),
  type: FieldType,
  description: z.string().max(TEXT_MAX.description).optional(),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  default: z.unknown().optional(),
  sensitivity: Sensitivity.optional(),
  hidden: z.boolean().optional(),
  options: z.object({
    values: z.array(SelectValue).max(500).optional(),
    to: z.string().optional(),
    cardinality: z.enum(["many_to_one", "many_to_many"]).optional(),
    initial: z.string().optional(),
    transitions: z.record(z.string(), z.array(z.string())).optional(),
    max: z.number().int().optional().describe("rating: the highest rating, 1 to 10 (default 5)"),
    shape: z.custom<JsonShape>(() => true).optional().describe("json: {type, required, properties, additional_properties}, checked on every write"),
  }).optional(),
  validation: z.object({ min: z.number().optional(), max: z.number().optional(), max_length: z.number().int().positive().optional(), pattern: z.string().max(500).optional() }).optional(),
});
const Query = z.object({
  object: z.string().optional().describe("Required unless view is given"),
  where: z.unknown().optional(),
  sort: z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })).max(3).optional().describe("Up to 3 fields; ties are broken by ID"),
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
  include_archived: z.boolean().optional(),
  count: z.boolean().optional().describe("Also return total (exact up to 10,000) and total_capped"),
  fields: z.array(z.string()).max(100).optional().describe("Return only these fields, plus id, object and version"),
  include: z.array(z.string()).max(18).optional().describe('Many-to-one relations to return inline under `included`: "account", or "account.domain" for a field of it'),
  view: z.string().optional().describe("Run with a saved view's filter, sort and columns; fields given here override the view's"),
  archived_only: z.boolean().optional().describe("Only archived records (merged duplicates among them)"),
});

/** sort=field (with dir, default desc, as before) or sort=a,-b: up to three fields, each ascending unless prefixed with -. */
export function sortFromQuery(sort: string | undefined, dir: string | undefined): SortInput[] | undefined {
  if (!sort) return undefined;
  const parts = sort.split(",").map((s) => s.trim());
  if (parts.length === 1 && !parts[0]!.startsWith("-")) return [{ field: parts[0]!, dir: dir === "asc" ? "asc" : "desc" }];
  return parts.map((p) => (p.startsWith("-") ? { field: p.slice(1), dir: "desc" } : { field: p.replace(/^\+/, ""), dir: "asc" }));
}

/** A comma-separated list parameter (fields=a,b), or undefined when absent. */
export const listParam = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean));

/** fields and include on a single-record read. */
const ShapeQuery = { fields: z.string().max(5_000).optional(), include: z.string().max(2_000).optional() };

export function parseIfMatch(h: string | null): number | undefined {
  if (!h) return undefined;
  const m = /^(?:W\/)?"?v?(\d+)"?$/.exec(h.trim());
  if (!m) throw badRequest('If-Match must be a record version, e.g. "v3"');
  return Number(m[1]);
}

/** Turns `?filter[field]=value` (and `filter[field][op]=value`) into a query tree. */
export function filtersFromQuery(query: Record<string, string>): Where | undefined {
  const preds: Where[] = [];
  for (const [k, v] of Object.entries(query)) {
    const m = /^filter\[([a-z0-9_.]+)\](?:\[([a-z_]+)\])?$/.exec(k);
    if (!m) continue;
    const path = m[1]!.split(".");
    const op = (m[2] ?? "eq") as never;
    // Values stay text: the compiler types them by their field, so filter[zip]=02139 still matches "02139".
    const value: unknown = op === "in" || op === "not_in" ? v.split(",") : v;
    const pred: Predicate = op === "is_null" ? { path, op, value: v !== "false" } : { path, op, value };
    URL_PREDICATES.add(pred);
    preds.push(pred);
  }
  if (preds.length === 0) return undefined;
  return preds.length === 1 ? preds[0] : { and: preds };
}

// --- Workspace and identity -------------------------------------------------------------------

route({
  method: "GET", path: "/v1/me", scope: "any", tag: "workspace", summary: "Who am I: workspace, identity, role, effective permissions and scopes",
  response: plain(object({ workspace: S.obj, actor: S.obj, role: S.str, permissions: S.strs, scopes: S.strs, surface: S.str, server_version: S.str })),
  handler: async ({ tx, ctx }) => ({
    body: {
      workspace: await getWorkspace(tx),
      actor: { type: ctx.actor.type, id: ctx.actor.id ? encodeId(ctx.actor.type === "user" ? "usr" : "svc", ctx.actor.id) : null, role: ctx.actor.role },
      role: ctx.actor.role,
      permissions: [...ctx.permissions],
      scopes: [...ctx.scopes],
      surface: ctx.surface,
      server_version: SERVER_VERSION,
    },
  }),
});

route({
  method: "GET", path: "/v1/me/access", scope: "any", tag: "workspace",
  response: data(object({ permissions: S.strs, objects: list(S.obj) })),
  summary: "What this key can do with records, per object: read, write, archive, and limited or restricted fields",
  handler: async ({ tx, ctx }) => ({ body: { data: { permissions: [...ctx.permissions], objects: describeAccess(ctx, await loadSchema(tx)) } } }),
});

route({
  method: "GET", path: "/v1/workspace", scope: "ops:read", tag: "workspace", summary: "Workspace settings",
  response: data(object({ id: S.str, name: S.str, currency: S.str, modules: S.strs, sign_in: ref("SignInSettings") })),
  handler: async ({ tx }) => ({ body: { data: await getWorkspace(tx) } }),
});

route({
  method: "PATCH", path: "/v1/workspace/modules", scope: "admin", tag: "schema", summary: "Turn modules on or off",
  response: R.object,
  body: DryRun.extend({ modules: z.array(z.string()) }),
  handler: async ({ tx, ctx, body }) => ({ body: await setModules(tx, ctx, body.modules, body.dry_run ?? false) }),
});

// --- Schema ----------------------------------------------------------------------------------

route({
  method: "GET", path: "/v1/schema", scope: "ops:read", tag: "schema", summary: "Compact summary of every object, field and pipeline",
  response: data(object({ schema_version: S.int, currency: S.str, modules: S.strs, objects: list(S.obj), pipelines: list(S.obj) })),
  handler: async ({ tx, ctx }) => ({ body: { data: await schemaSummary(tx, ctx) } }),
});

route({
  method: "GET", path: "/v1/schema/changes", scope: "admin", permission: "audit:read", tag: "schema", summary: "Schema change history, newest first",
  response: R.anyList,
  query: z.object({ limit: z.coerce.number().int().optional() }),
  handler: async ({ tx, query }) => ({ body: { data: await schemaChanges(tx, query.limit) } }),
});

route({
  method: "GET", path: "/v1/objects", scope: "ops:read", tag: "schema", summary: "List objects",
  response: dataList(object({ name: S.str, label: S.str, access: S.obj })),
  handler: async ({ tx, ctx }) => ({ body: { data: await listObjects(tx, ctx) } }),
});

route({
  method: "GET", path: "/v1/objects/:object", scope: "ops:read", tag: "schema", summary: "Describe an object and its fields",
  response: data(object({ name: S.str, label: S.str, fields: list(S.obj), access: S.obj })),
  query: z.object({ include_hidden: z.enum(["true", "false"]).optional() }),
  handler: async ({ tx, ctx, params, query }) => ({ body: { data: await describeObject(tx, ctx, params.object!, { includeHidden: query.include_hidden === "true" }) } }),
});

route({
  method: "POST", path: "/v1/objects", scope: "admin", tag: "schema", summary: "Create a custom object, with its fields",
  response: createdOrDry(),
  body: DryRun.extend({
    api_name: z.string(), label: z.string().optional(), plural_label: z.string().optional(), description: z.string().max(TEXT_MAX.description).optional(),
    id_prefix: z.string().optional(), display_field: z.string().optional(), owned: z.boolean().optional(),
    fields: z.array(FieldInput).max(200).optional(),
  }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    const result = await createObject(tx, ctx, input, dry_run ?? false);
    return { status: dry_run ? 200 : 201, body: result };
  },
});

route({
  method: "PATCH", path: "/v1/objects/:object", scope: "admin", tag: "schema", summary: "Relabel, describe or hide an object",
  response: R.object,
  body: DryRun.extend({ label: z.string().optional(), plural_label: z.string().optional(), description: z.string().optional(), hidden: z.boolean().optional(), display_field: z.string().optional() }),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, ...patch } = body;
    return { body: await updateObject(tx, ctx, params.object!, patch, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/fields", scope: "admin", tag: "schema", summary: "Add a field to any object (relations included)",
  response: createdOrDry(),
  body: FieldInput.extend({ dry_run: z.boolean().optional() }),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, ...input } = body;
    return { status: dry_run ? 200 : 201, body: await addField(tx, ctx, params.object!, input, dry_run ?? false) };
  },
});

route({
  method: "PATCH", path: "/v1/objects/:object/fields/:field", scope: "admin", tag: "schema", summary: "Update a field: label, rules, values, visibility",
  response: R.object,
  body: DryRun.extend({
    api_name: z.string().optional(), label: z.string().optional(), description: z.string().optional(), required: z.boolean().optional(),
    hidden: z.boolean().optional(), sensitivity: Sensitivity.optional(), default: z.unknown().optional(),
    validation: FieldInput.shape.validation, values: z.array(SelectValue).max(500).optional(),
    max: z.number().int().optional().describe("rating: raise the highest rating (lowering it is refused)"),
    shape: z.custom<JsonShape | null>(() => true).optional().describe("json: replace the shape check (null removes it); applies to new writes"),
  }),
  handler: async ({ tx, ctx, params, body }) => {
    const { dry_run, ...patch } = body;
    return { body: await updateField(tx, ctx, params.object!, params.field!, patch, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/fields/:field/archive", scope: "admin", tag: "schema",
  response: R.object,
  summary: "Archive a custom field. Run with dry_run first, then pass back confirm_token",
  body: DryRun.extend({ confirm_token: z.string().optional() }),
  handler: async ({ tx, ctx, params, body }) => ({
    body: await archiveField(tx, ctx, params.object!, params.field!, { dryRun: body.dry_run ?? false, confirm: body.confirm_token }),
  }),
});

route({
  method: "GET", path: "/v1/pipelines", scope: "ops:read", tag: "schema", summary: "Pipelines and their stages",
  response: dataList(object({ id: S.str, name: S.str, stages: list(S.obj) })),
  handler: async ({ tx }) => ({ body: { data: await listPipelines(tx) } }),
});

route({
  method: "POST", path: "/v1/pipelines", scope: "admin", tag: "schema", summary: "Create a pipeline with ordered stages",
  response: createdOrDry(),
  body: DryRun.extend({
    name: z.string(), is_default: z.boolean().optional(),
    stages: z.array(z.object({ name: z.string(), category: z.enum(["open", "won", "lost"]).optional(), probability: z.number().optional() })),
  }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { status: dry_run ? 200 : 201, body: await createPipeline(tx, ctx, input, dry_run ?? false) };
  },
});

// --- Records ---------------------------------------------------------------------------------

route({
  method: "GET", path: "/v1/objects/:object/records", scope: "ops:read", tag: "records",
  summary: "List records. Filter with filter[field]=value or filter[field][op]=value; sort=field&dir=asc|desc, or sort=a,-b (up to 3 fields, - for descending); "
    + "fields=a,b; include=account,account.domain; count=true for total; view=v_… to run a saved view; include_archived=true or archived_only=true",
  response: R.page,
  // A count is a second statement over the same filter, as on POST /v1/query.
  cost: (_, q) => (q.count === "true" ? 2 : 1),
  heavy: (_, q) => q.count === "true",
  handler: async ({ tx, ctx, params, query }) => {
    const limit = query.limit ? Number(query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw unprocessable("limit must be a positive integer");
    const page = await listRecords(tx, ctx, {
      object: params.object!,
      where: filtersFromQuery(query),
      sort: sortFromQuery(query.sort, query.dir),
      limit, cursor: query.cursor, include_archived: query.include_archived === "true", archived_only: query.archived_only === "true", count: query.count === "true",
      fields: listParam(query.fields), include: listParam(query.include), view: query.view,
    }, { includeHidden: query.include_hidden === "true" });
    return { body: page };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/records", scope: "ops:write", tag: "records", summary: "Create a record",
  response: R.created,
  body: Values,
  handler: async ({ tx, ctx, params, body }) => ({ status: 201, body: { data: await createRecord(tx, ctx, params.object!, body) } }),
});

route({
  method: "POST", path: "/v1/objects/:object/records/batch", scope: "ops:write", tag: "records",
  response: { schema: { anyOf: [object({ data: list(ref("Record")) }), ref("CreatePreview")] }, status: 201, alsoStatus: 200,
    description: "The created records (201), or with dry_run what each would do (200)" },
  summary: "Create up to 100 records in one transaction (all or nothing). dry_run: true reports what would be created, with each record's errors, and writes nothing",
  body: z.object({ records: z.array(Values).min(1).max(100), dry_run: z.boolean().optional() }),
  // A dry run does the real work, rolled back: charged and gated like the bulk previews (routes-write.ts).
  cost: (b) => (b.dry_run ? Math.ceil(b.records.length / PREVIEW_PER_TOKEN) : 1),
  heavy: (b) => Boolean(b.dry_run),
  handler: async ({ tx, ctx, params, body }) => {
    if (body.dry_run) return { body: await previewCreates(tx, ctx, params.object!, body.records) };
    const data = [];
    for (const [i, values] of body.records.entries()) {
      try {
        data.push(await createRecord(tx, ctx, params.object!, values));
      } catch (e) {
        if (e instanceof Error && "status" in e) (e as Error).message = `Record ${i}: ${e.message}`;
        throw e;
      }
    }
    return { status: 201, body: { data } };
  },
});

route({
  method: "GET", path: "/v1/objects/:object/records/:id", scope: "ops:read", tag: "records", summary: "Get a record",
  idParams: { id: "record" }, response: R.record,
  query: z.object({ include_hidden: z.enum(["true", "false"]).optional(), ...ShapeQuery }),
  handler: async ({ tx, ctx, params, query }) => {
    const data = await readRecord(tx, ctx, params.object!, params.id!, { fields: listParam(query.fields), include: listParam(query.include) },
      { includeHidden: query.include_hidden === "true" });
    return { body: { data }, headers: { ETag: `"v${String(data.version)}"` } };
  },
});

route({
  method: "PATCH", path: "/v1/objects/:object/records/:id", scope: "ops:write", tag: "records",
  response: R.record,
  summary: "Update a record. Send If-Match with the version you read to avoid overwriting someone else's change",
  idParams: { id: "record" }, body: Values,
  handler: async ({ tx, ctx, params, body, headers }) => {
    const data = await updateRecord(tx, ctx, params.object!, params.id!, body, parseIfMatch(headers.get("if-match")));
    return { body: { data }, headers: { ETag: `"v${String(data.version)}"` } };
  },
});

route({
  method: "DELETE", path: "/v1/objects/:object/records/:id", scope: "ops:write", permission: "records:archive", tag: "records",
  summary: "Archive a record (records are archived, never deleted)", idParams: { id: "record" }, response: R.record,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveRecord(tx, ctx, params.object!, params.id!) } }),
});

route({
  method: "GET", path: "/v1/records/:id", scope: "ops:read", tag: "records", summary: "Get any record by ID (fields= and include= as on a list)", idParams: { id: "record" },
  query: z.object(ShapeQuery), response: R.record,
  handler: async ({ tx, ctx, params, query }) => ({
    body: { data: await readRecord(tx, ctx, null, params.id!, { fields: listParam(query.fields), include: listParam(query.include) }) },
  }),
});

route({
  method: "GET", path: "/v1/records/:id/timeline", scope: "ops:read", tag: "records", summary: "Activities, tasks and stage changes for a record",
  idParams: { id: "record" }, query: z.object({ limit: z.coerce.number().int().optional() }), response: R.anyList,
  handler: async ({ tx, ctx, params, query }) => ({ body: { data: await timeline(tx, ctx, params.id!, query.limit) } }),
});

route({
  method: "POST", path: "/v1/query", scope: "ops:read", tag: "records",
  summary: "Query records with filters, relation paths, sorting on up to 3 fields, cursor paging, an optional capped count, fields, include and saved views",
  body: Query, response: R.page,
  // A count is a second statement over the same filter.
  cost: (b) => (b.count ? 2 : 1),
  // Counting scans up to 10,001 matching records: gated as long-running work, like the list route's count=true.
  heavy: (b) => Boolean(b.count),
  handler: async ({ tx, ctx, body }) => {
    if (!body.object && body.view === undefined) throw unprocessable("object is required (or a view)");
    return { body: await listRecords(tx, ctx, { ...body, object: body.object ?? "", where: body.where as Where | undefined }) };
  },
});

route({
  method: "GET", path: "/v1/search", scope: "ops:read", tag: "records", summary: "Fuzzy search across contacts, accounts, leads, deals and custom objects",
  response: R.records,
  query: z.object({ q: z.string(), objects: z.string().optional(), limit: z.coerce.number().int().optional() }),
  handler: async ({ tx, ctx, query }) => ({ body: { data: await search(tx, ctx, query.q, query.objects?.split(","), query.limit) } }),
});

// --- Operations ------------------------------------------------------------------------------

route({
  method: "POST", path: "/v1/ops/capture_interest", scope: "ops:write", tag: "operations",
  response: R.op,
  summary: "Match or create a contact (and account by domain), then create a lead and a form_submitted activity",
  body: DryRun.extend({
    email: z.string(), first_name: z.string().optional(), last_name: z.string().optional(), company: z.string().optional(),
    domain: z.string().optional(), interest: z.string().optional(), campaign: z.string().optional(), source: z.string().optional(),
    channel: z.string().optional(), form_fields: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await captureInterest(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/ops/convert_lead", scope: "ops:write", tag: "operations", summary: "Convert a qualified lead into a deal",
  response: R.op,
  body: DryRun.extend({ lead: z.string(), deal_name: z.string().optional(), pipeline: z.string().optional(), stage: z.string().optional(),
    amount: z.number().optional(), expected_close_date: z.string().optional() }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await convertLead(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/ops/move_deal_stage", scope: "ops:write", tag: "operations", summary: "Move a deal to another stage (by stage ID or name)",
  response: R.op,
  body: DryRun.extend({ deal: z.string(), stage: z.string(), lost_reason: z.string().optional() }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await moveDealStage(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/ops/assign_owner", scope: "ops:write", tag: "operations", summary: "Assign a record to a member (user ID or email)",
  response: R.op,
  body: DryRun.extend({ record: z.string(), owner: z.string() }),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await assignOwner(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/ops/log_activity", scope: "ops:write", tag: "operations",
  response: R.created,
  summary: "Log an activity (note, call, email, meeting…) about one or more records",
  body: z.object({ type: z.string(), subject: z.string().optional(), body: z.string().optional(), occurred_at: z.string().optional(),
    related_to: z.array(z.string()).max(50), actor_contact: z.string().optional() }),
  handler: async ({ tx, ctx, body }) => ({ status: 201, body: { data: await createRecord(tx, ctx, "activity", body) } }),
});

route({
  method: "GET", path: "/v1/me/tasks", scope: "ops:read", tag: "operations", summary: "My open tasks",
  response: R.records,
  handler: async ({ tx, ctx }) => ({ body: { data: await myOpenTasks(tx, ctx) } }),
});

// --- Administration --------------------------------------------------------------------------

const RoleRef = z.string().min(1).max(64).describe("A role key (admin, member, read_only, or a custom role's key) or role_… ID");
const Allow = z.boolean().nullable().optional();
const RoleRules = {
  objects: z.record(z.string(), z.object({ read: Allow, write: Allow, archive: Allow }).strict().nullable()).optional()
    .describe("Per object: read/write/archive true (allow), false (deny) or null (inherit the role's records:* permission). null clears the object's rule"),
  fields: z.record(z.string(), z.record(z.string(), z.enum(["none", "read"]).nullable()).nullable()).optional()
    .describe("Per object, per field: \"none\" (not visible), \"read\" (not writable) or null (follow the object). null for an object clears its field rules"),
};
const MemberPatch = z.object({ role: RoleRef.optional(), active: z.boolean().optional() });

route({
  method: "GET", path: "/v1/members", scope: "admin", permission: "members:manage", tag: "admin", summary: "Members and service accounts, with their roles",
  response: R.anyList,
  handler: async ({ tx }) => ({ body: { data: await listMembers(tx) } }),
});

route({
  method: "POST", path: "/v1/members", scope: "admin", permission: "members:manage", tag: "admin",
  response: data(S.obj, 201),
  summary: "Add a member with any role you could grant (you must hold all of its permissions). The email must be printable ASCII. send_invite: true emails them the sign-in page's address (off by default; limited per workspace and per sender, 429 past it)",
  body: z.object({ email: z.string(), name: z.string(), role: RoleRef, send_invite: z.boolean().optional() }),
  handler: async ({ tx, ctx, body }) => {
    if (body.send_invite) {
      const why = invitationUnavailable();
      if (why) throw unprocessable(why);
    }
    const member = await addMember(tx, ctx, body);
    if (!body.send_invite) return { status: 201, body: { data: member } };
    // Invitations have budgets of their own (per workspace, per sender); past them, 429 and the member isn't added.
    reserveInvitation(ctx.tenantId, ctx.actor.id);
    const workspace = (await getWorkspace(tx)).name;
    const [inviter] = ctx.actor.type === "user" ? await tx<{ name: string }[]>`SELECT name FROM users WHERE id = ${ctx.actor.id}` : [];
    // Sent once the member exists (after commit), and only because the caller asked.
    return { status: 201, body: { data: member }, after: () => sendInvitation(body.email, workspace, inviter?.name ?? null) };
  },
});

route({
  method: "PATCH", path: "/v1/members/:id", scope: "admin", permission: "members:manage", tag: "admin", idParams: { id: "member" },
  response: R.any,
  summary: "Change a member's role, or disable (active: false) or re-enable them. Disabling revokes all their API keys and ends their sessions",
  body: MemberPatch,
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await updateMember(tx, ctx, params.id!, body, "user") } }),
});

route({
  method: "POST", path: "/v1/service-accounts", scope: "admin", permission: "members:manage", tag: "admin",
  response: data(S.obj, 201),
  summary: "Create a service account (for an integration or agent)",
  body: z.object({ name: z.string(), role: RoleRef }),
  handler: async ({ tx, ctx, body }) => ({ status: 201, body: { data: await addServiceAccount(tx, ctx, body) } }),
});

route({
  method: "PATCH", path: "/v1/service-accounts/:id", scope: "admin", permission: "members:manage", tag: "admin", idParams: { id: "service_account" },
  response: R.any,
  summary: "Change a service account's role, or disable or re-enable it. Disabling revokes all its API keys",
  body: MemberPatch,
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await updateMember(tx, ctx, params.id!, body, "service_account") } }),
});

route({
  method: "GET", path: "/v1/access-review", scope: "admin", permission: "audit:read", tag: "admin",
  response: R.anyData,
  summary: "Access review: every member and service account with role, permissions, status and keys",
  handler: async ({ tx, ctx }) => ({ body: { data: await accessReview(tx, ctx) } }),
});

// --- Roles -----------------------------------------------------------------------------------

route({
  method: "GET", path: "/v1/permissions", scope: "any", tag: "admin", summary: "The permissions a role can be built from",
  response: R.anyList,
  handler: async () => ({ body: { data: permissionCatalog() } }),
});

route({
  method: "GET", path: "/v1/roles", scope: "any", tag: "admin", summary: "Roles: the four system roles and any custom ones",
  response: R.anyList,
  query: z.object({ include_archived: z.enum(["true", "false"]).optional() }),
  handler: async ({ tx, ctx, query }) => ({ body: { data: await listRoles(tx, ctx, { includeArchived: query.include_archived === "true" }) } }),
});

route({
  method: "POST", path: "/v1/roles", scope: "admin", permission: "roles:manage", tag: "admin",
  response: data(S.obj, 201),
  summary: "Create a custom role, optionally copying another role's permissions and rules. You must hold every permission and all record access it grants",
  body: z.object({ key: z.string(), name: z.string(), description: z.string().max(1000).optional(),
    permissions: z.array(z.string()).max(50).optional(), copy_from: RoleRef.optional(), ...RoleRules }),
  handler: async ({ tx, ctx, body }) => ({ status: 201, body: { data: await createRole(tx, ctx, body) } }),
});

route({
  method: "GET", path: "/v1/roles/:id", scope: "any", tag: "admin", summary: "Get a role by key or role_… ID", idParams: { id: "role" },
  response: R.any,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getRole(tx, ctx, params.id!) } }),
});

route({
  method: "GET", path: "/v1/roles/:id/access", scope: "any", tag: "admin", idParams: { id: "role" },
  response: R.anyData,
  summary: "Effective record access of a role, per object: read, write, archive, and limited or restricted fields",
  handler: async ({ tx, ctx, params }) => ({ body: { data: await roleAccess(tx, ctx, params.id!) } }),
});

route({
  method: "PATCH", path: "/v1/roles/:id", scope: "admin", permission: "roles:manage", tag: "admin", idParams: { id: "role" },
  response: R.any,
  summary: "Change a custom role's name, description, permissions or object and field rules. System roles and roles you hold can't be changed",
  body: z.object({ name: z.string().optional(), description: z.string().max(1000).optional(), permissions: z.array(z.string()).max(50).optional(), ...RoleRules }),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await updateRole(tx, ctx, params.id!, body) } }),
});

route({
  method: "DELETE", path: "/v1/roles/:id", scope: "admin", permission: "roles:manage", tag: "admin", idParams: { id: "role" },
  response: R.any,
  summary: "Archive a custom role. Refused while any active member holds it",
  handler: async ({ tx, ctx, params }) => ({ body: { data: await archiveRole(tx, ctx, params.id!) } }),
});

// --- API keys and audit ----------------------------------------------------------------------

route({
  method: "GET", path: "/v1/api-keys", scope: "admin", permission: "keys:manage", tag: "admin", summary: "List API keys (metadata only; secrets are never returned)",
  response: R.anyList,
  handler: async ({ tx, ctx }) => ({ body: { data: await listApiKeys(tx, ctx) } }),
});

route({
  method: "POST", path: "/v1/api-keys", scope: "admin", permission: "keys:manage", tag: "admin",
  response: data(object({ id: S.str, secret: S.str }), 201),
  summary: "Create an API key. The secret is shown once. Scopes can't exceed the calling key's or the owner's role. test keys reach live data (there is no sandbox). From a browser session, needs a sign-in in the last 10 minutes: a key outlives the session",
  body: z.object({ name: z.string(), scopes: z.array(z.enum(["admin", "ops:write", "ops:read", "restricted:read"])).min(1),
    owner: z.string().optional(), environment: z.enum(["live", "test"]).optional(), expires_in_days: z.number().int().positive().max(3650).optional() }),
  handler: async ({ tx, ctx, body, headers }) => {
    if ((headers.get("x-hlcrm-surface") ?? "api").endsWith("mcp") || ctx.surface.endsWith("mcp")) throw badRequest("Keys cannot be created through MCP");
    // A key outlives the session that made it (a password change or "sign out everywhere" doesn't revoke it), so a session needs a fresh sign-in.
    if (ctx.session) requireRecentSignIn(ctx);
    return { status: 201, body: { data: await createApiKey(tx, ctx, body) } };
  },
});

route({
  method: "POST", path: "/v1/api-keys/:id/revoke", scope: "admin", permission: "keys:manage", tag: "admin", summary: "Revoke an API key", idParams: { id: "key" },
  response: R.any,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await revokeApiKey(tx, ctx, params.id!) } }),
});

route({
  method: "POST", path: "/v1/api-keys/:id/rotate", scope: "admin", permission: "keys:manage", tag: "admin",
  summary: "Rotate an API key with an overlap window. From a browser session, needs a sign-in in the last 10 minutes",
  response: R.any,
  idParams: { id: "key" }, body: z.object({ overlap_hours: z.number().int().min(0).max(168).optional() }).optional() as never,
  handler: async ({ tx, ctx, params, body, headers }) => {
    if ((headers.get("x-hlcrm-surface") ?? "api").endsWith("mcp") || ctx.surface.endsWith("mcp")) throw badRequest("Keys cannot be rotated through MCP");
    if (ctx.session) requireRecentSignIn(ctx);
    return { body: { data: await rotateApiKey(tx, ctx, params.id!, (body as { overlap_hours?: number } | undefined)?.overlap_hours) } };
  },
});

route({
  method: "GET", path: "/v1/audit-log", scope: "admin", permission: "audit:read", tag: "admin", summary: "Audit log, newest first",
  response: plain(object({ data: list(S.obj), next_before: nullable(S.int) })),
  query: z.object({ limit: z.coerce.number().int().optional(), before: z.coerce.number().int().optional(), record: z.string().optional(), action: z.string().optional() }),
  handler: async ({ tx, query }) => {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const rows = await tx<{ seq: string; occurred_at: Date; actor_type: string; actor_id: string | null; key_id: string | null; surface: string;
      action: string; object_type: string | null; record_id: string | null; request_id: string | null; details: unknown; sealed: boolean }[]>`
      SELECT seq::text, occurred_at, actor_type, actor_id, key_id, surface, action, object_type, record_id, request_id, details, hash IS NOT NULL AS sealed
      FROM audit_log
      WHERE (${query.before ?? null}::bigint IS NULL OR seq < ${query.before ?? null}::bigint)
        AND (${query.action ?? null}::text IS NULL OR action LIKE ${(query.action ?? "") + "%"})
      ORDER BY audit_log.seq DESC LIMIT ${limit}`;
    return {
      body: {
        data: rows.map((r) => ({
          seq: Number(r.seq), at: r.occurred_at.toISOString(), action: r.action, surface: r.surface,
          actor: r.actor_id ? actorRef(r.actor_type, r.actor_id) : r.actor_type,
          key: r.key_id ? encodeId("key", r.key_id) : null, object: r.object_type, record_id: r.record_id, request_id: r.request_id,
          details: r.details, sealed: r.sealed,
        })),
        next_before: rows.length === limit ? Number(rows[rows.length - 1]!.seq) : null,
      },
    };
  },
});

route({
  method: "GET", path: "/v1/audit/verify", scope: "admin", permission: "audit:read", tag: "admin", summary: "Verify the audit log hash chain and its anchors",
  response: R.anyData,
  // Uses the request transaction: opening a second one here would hold two pooled connections per call.
  // Doesn't wait for the tenant's verify/anchor lock: a concurrent call gets 409 at once instead of holding a connection.
  handler: async ({ tx, ctx }) => ({ body: { data: await verifyInTx(tx, ctx.tenantId, { wait: false }) } }),
});
