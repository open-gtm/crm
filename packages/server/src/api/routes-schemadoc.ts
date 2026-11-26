import { z } from "zod";
import { TEXT_MAX } from "../lib/limits.js";
import { applySchema, exportSchema, planSchema, SCHEMA_FORMAT, type SchemaDoc } from "../core/schemadoc.js";
import { FIELD_TYPES } from "../core/fieldtypes.js";
import { route } from "./registry.js";
import { R } from "./responses.js";
import { parseIfMatch } from "./routes.js";

// --- Schema-as-code: export, plan and apply one document (see core/schemadoc.ts) -------------

const FieldType = z.enum(FIELD_TYPES);
const Name = z.string().min(1).max(TEXT_MAX.name);
const Id = z.string().max(40).optional();

/** Strict, so a misspelt property in a hand-written document is an error rather than silently ignored. */
export const DocField = z.object({
  id: Id, name: Name, type: FieldType, label: z.string().optional(), description: z.string().max(TEXT_MAX.description).optional(),
  required: z.boolean().optional(), unique: z.boolean().optional(), hidden: z.boolean().optional(),
  sensitivity: z.enum(["standard", "confidential", "restricted"]).optional(), default: z.unknown().optional(),
  validation: z.object({ min: z.number().optional(), max: z.number().optional(), max_length: z.number().int().positive().optional(),
    pattern: z.string().max(500).optional() }).strict().optional(),
  values: z.array(z.object({ key: z.string(), label: z.string(), category: z.string().optional() }).strict()).max(500).optional(),
  relation: z.object({ to: z.string(), cardinality: z.enum(["many_to_one", "many_to_many"]).optional() }).strict().optional(),
  initial: z.string().optional(), transitions: z.record(z.string(), z.array(z.string())).optional(),
  max: z.number().int().optional(), shape: z.unknown().optional(),
  standard: z.boolean().optional(), read_only: z.boolean().optional(),
}).strict();

const Document = z.object({
  format: z.literal(SCHEMA_FORMAT).optional(),
  schema_version: z.number().int().nonnegative().optional(),
  modules: z.array(z.string()).max(20).optional(),
  objects: z.array(z.object({
    id: Id, name: Name, label: z.string().optional(), plural_label: z.string().optional(), description: z.string().max(TEXT_MAX.description).optional(),
    id_prefix: z.string().optional(), display_field: z.string().optional(), owned: z.boolean().optional(), hidden: z.boolean().optional(),
    standard: z.boolean().optional(), module: z.string().optional(), fields: z.array(DocField).max(300).optional(),
    // The record page layout, checked by core/layouts.ts when the document runs. null: the default page.
    layout: z.unknown().optional(),
  }).strict()).max(150).optional(),
  pipelines: z.array(z.object({
    id: Id, name: Name, is_default: z.boolean().optional(),
    stages: z.array(z.object({ id: Id, name: Name, category: z.enum(["open", "won", "lost"]).optional(),
      probability: z.number().min(0).max(100).nullable().optional() }).strict()).min(1).max(30),
  }).strict()).max(50).optional(),
  // Informational on export (the caller's record access when limited); ignored here.
  access: z.unknown().optional(),
}).strict();

route({
  method: "GET", path: "/v1/schema/export", scope: "ops:read", tag: "schema",
  response: R.object,
  // records:read on at least one object, like GET /v1/schema and GET /v1/objects/:object?include_hidden=true: the document holds
  // nothing those don't. Every object and field is listed (names are not data, ADR 0008), with `access` when the caller's is limited.
  summary: "The workspace schema as one document (modules, objects, fields, pipelines), with its schema_version. Input to plan and apply. "
    + "Lists every object and field; when the key can't read, write and archive everything, `access` says what it can",
  handler: async ({ tx, ctx }) => ({ body: await exportSchema(tx, ctx) }),
});

route({
  method: "POST", path: "/v1/schema/plan", scope: "admin", tag: "schema",
  response: R.object,
  summary: "Diff a schema document against the workspace: ordered changes, what cannot be applied, and drift since its schema_version. Writes nothing",
  heavy: true,
  body: z.object({ document: Document, prune: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, body }) => ({ body: await planSchema(tx, ctx, body.document as SchemaDoc, { prune: body.prune }) }),
});

route({
  method: "POST", path: "/v1/schema/apply", scope: "admin", tag: "schema",
  response: R.object,
  summary: "Make the workspace match a schema document, in one transaction. Send If-Match: <schema_version it was exported at>. "
    + "Refuses (412) to overwrite changes made since then unless accept_drift; archives only with prune; archiving or converting values needs confirm_data_changes",
  body: z.object({ document: Document, prune: z.boolean().optional(), accept_drift: z.boolean().optional(),
    confirm_data_changes: z.boolean().optional() }).strict(),
  heavy: true,
  handler: async ({ tx, ctx, body, headers }) => ({
    body: await applySchema(tx, ctx, body.document as SchemaDoc, {
      ifMatch: parseIfMatch(headers.get("if-match")), acceptDrift: body.accept_drift, prune: body.prune, confirmDataChanges: body.confirm_data_changes,
    }),
  }),
});
