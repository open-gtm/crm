import { z } from "zod";
import {
  discardDraft, getDraft, getLayout, getVersion, listVersions, publishDraft, resetLayout, restoreVersion, reviewChange, setDraft, setLayout, undoChange,
} from "../core/layouts.js";
import { unprocessable } from "../lib/errors.js";
import { route } from "./registry.js";
import { data, dataList, list, nullable, object, S } from "./responses.js";

// --- Record page layouts (core/layouts.ts; ADR 0015, ADR 0017) ---------------------------------

const Component = { type: "object", additionalProperties: true,
  description: "One part of the page: {id, type, …}. Types: fields {name, columns: 1|2, collapsed, fields: [names]}, related {object, field, rows}, tasks {rows}, quotes {rows}, "
    + "stage_path {field}, agent_changes {days}, timeline, notes, files, related_lists (every related list not placed on its own)" };
const LayoutDoc = object({
  header: object({ key_facts: { ...nullable(S.strs), description: "Up to 6 field names shown in the header; null leaves them to the page" } }),
  top: { ...list(Component), description: "Across the top of the page: a stage_path, or nothing" },
  columns: object({ left: list(Component), main: list(Component), right: list(Component) }),
});
const Source = object({
  surface: { type: "string", description: "web, admin-mcp, cli, api or system; unknown for versions from before history was kept" },
  actor: { ...nullable(S.str), description: "The member or service account (usr_…, svc_…)" },
  via: { ...nullable(S.str), description: "The connected app or API key the change came through, by name" },
});
const Layout = object({
  object: S.str,
  custom: { type: "boolean", description: "False when no layout is published: the record page is the default one" },
  version: { type: "integer", description: "The published version; 0 when none ever was" },
  layout: LayoutDoc,
  sections: { ...list(object({ title: S.str, fields: { ...S.strs, description: "Field names, in order" } })), description: "The layout's field sections; empty when no layout is published" },
  updated_at: nullable(S.time),
});
const Changes = { ...S.strs, description: "What changes, one sentence each" };
const Change = object({
  id: S.str, revision: S.int, summary: S.str, changes: Changes, note: { ...nullable(S.str), description: "What was asked for, when the change came with a note" },
  source: Source, at: S.time, reviewed: S.bool, can_undo: { type: "boolean", description: "Only the newest change to a draft can be undone" },
});
const Draft = object({
  object: S.str, has_draft: S.bool, revision: { type: "integer", description: "Send it back with a change; 0 when there is no draft" }, layout: LayoutDoc,
  published_version: S.int, published_custom: S.bool,
  stale: { type: "boolean", description: "The published layout changed since the draft was started" },
  diff: { ...S.strs, description: "What the draft changes in the published layout" }, changes: list(Change), updated_at: nullable(S.time),
});
const DraftWrite = object({
  dry_run: S.bool, saved: S.bool, revision: S.int, object: S.str, layout: LayoutDoc, changes: Changes, warnings: S.strs,
  diff_from_published: S.strs, restored_from: S.int,
}, ["dry_run", "saved", "revision", "object", "layout", "changes", "warnings", "diff_from_published"]);
const Version = object({
  version: S.int, current: S.bool, summary: S.str, changes: Changes,
  contributors: { ...list(object({ actor: nullable(S.str), surface: S.str, via: nullable(S.str), summary: S.str, note: nullable(S.str), at: S.time })),
    description: "Who changed the draft that became this version, oldest first" },
  restored_from: nullable(S.int), source: Source, at: S.time, default_page: S.bool, layout: LayoutDoc,
}, ["version", "current", "summary", "changes", "contributors", "restored_from", "source", "at", "default_page"]);

const Note = z.string().max(500).nullable().optional().describe("What was asked for, in a sentence: shown with the change");
const LayoutBody = z.unknown().describe("{header: {key_facts}, top: [...], columns: {left, main, right}}");
const manage = { scope: "admin", permission: "schema:manage", tag: "schema" } as const;

route({
  method: "GET", path: "/v1/objects/:object/layout", scope: "ops:read", tag: "schema",
  summary: "How the object's record page is arranged: key facts, and columns of components. Fields the layout leaves out are shown after its sections",
  response: data(Layout),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getLayout(tx, ctx, params.object!) } }),
});

route({
  method: "PUT", path: "/v1/objects/:object/layout", ...manage,
  summary: "Publish a layout in one step, without the shared draft (schema-as-code and scripts). Send `layout`, or `sections` to replace only the field sections. dry_run: true answers with what would change",
  response: data(object({ ...(Layout.properties as Record<string, never>), dry_run: S.bool, published: S.bool, changes: Changes, warnings: S.strs }, ["object", "custom", "version", "layout", "sections", "updated_at"])),
  body: z.object({ sections: z.array(z.object({ title: z.string(), fields: z.array(z.string()).max(100) }).strict()).min(1).max(20).optional(),
    layout: LayoutBody.optional(), note: Note, dry_run: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, params, body }) => {
    const out = await setLayout(tx, ctx, params.object!, body);
    const current = await getLayout(tx, ctx, params.object!);
    return { body: { data: { ...current, ...(out.dry_run ? { layout: out.layout } : {}), dry_run: out.dry_run, published: out.published, changes: out.changes, warnings: out.warnings } } };
  },
});

route({
  method: "DELETE", path: "/v1/objects/:object/layout", ...manage,
  summary: "Publish the default page as the next version: the object has no layout of its own again",
  response: data(Layout),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await resetLayout(tx, ctx, params.object!) } }),
});

route({
  method: "GET", path: "/v1/objects/:object/layout/draft", ...manage,
  summary: "The shared draft of the object's layout, what it changes, and who changed it through what. With no draft, the published layout",
  response: data(Draft),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getDraft(tx, ctx, params.object!) } }),
});

route({
  method: "PUT", path: "/v1/objects/:object/layout/draft", ...manage,
  summary: "Change the shared draft. Send the whole layout and the revision you read. dry_run: true saves nothing and answers with what would change. Publishing is a separate step",
  response: data(DraftWrite),
  body: z.object({ layout: LayoutBody, revision: z.number().int().min(0).optional(), note: Note, dry_run: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await setDraft(tx, ctx, params.object!, body) } }),
});

route({
  method: "DELETE", path: "/v1/objects/:object/layout/draft", ...manage,
  summary: "Discard the shared draft. The published layout is untouched",
  response: data(Draft),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await discardDraft(tx, ctx, params.object!) } }),
});

route({
  method: "POST", path: "/v1/objects/:object/layout/draft/undo", ...manage,
  summary: "Take back the newest change to the draft",
  response: data(Draft),
  body: z.object({ change: z.string().max(60) }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await undoChange(tx, ctx, params.object!, body.change) } }),
});

route({
  method: "POST", path: "/v1/objects/:object/layout/draft/review", ...manage,
  summary: "Mark a change to the draft as looked at and kept (a person reviewing what an agent did)",
  response: data(Draft),
  body: z.object({ change: z.string().max(60) }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await reviewChange(tx, ctx, params.object!, body.change) } }),
});

route({
  method: "POST", path: "/v1/objects/:object/layout/publish", ...manage,
  summary: "Publish the draft as the next version: every record page shows it from then on. dry_run: true answers with what would change",
  response: data(object({ dry_run: S.bool, published: S.bool, object: S.str, version: S.int, would_publish: S.int, changes: Changes, stale: S.bool, layout: LayoutDoc },
    ["dry_run", "published", "object", "version", "changes", "stale", "layout"])),
  body: z.object({ note: Note, dry_run: z.boolean().optional(), revision: z.number().int().min(0).optional(),
    overwrite: z.boolean().optional().describe("Publish even though the published layout changed since the draft was started") }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await publishDraft(tx, ctx, params.object!, body) } }),
});

route({
  method: "GET", path: "/v1/objects/:object/layout/versions", ...manage,
  summary: "The layout's published versions, newest first, each with who published it and through what",
  response: dataList(Version),
  query: z.object({ limit: z.coerce.number().int().optional() }),
  handler: async ({ tx, ctx, params, query }) => ({ body: { data: await listVersions(tx, ctx, params.object!, query.limit) } }),
});

route({
  method: "GET", path: "/v1/objects/:object/layout/versions/:version", ...manage,
  summary: "One published version, with its layout",
  response: data(Version),
  handler: async ({ tx, ctx, params }) => {
    if (!/^\d{1,9}$/.test(params.version!)) throw unprocessable("version must be a number");
    return { body: { data: await getVersion(tx, ctx, params.object!, Number(params.version)) } };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/layout/restore", ...manage,
  summary: "Put an earlier version into the draft, to be looked at and published like any change. dry_run: true answers with what would change",
  response: data(DraftWrite),
  body: z.object({ version: z.number().int().positive(), revision: z.number().int().min(0).optional(), dry_run: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: { data: await restoreVersion(tx, ctx, params.object!, body) } }),
});
