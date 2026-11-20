import { z } from "zod";
import type { Ctx, Permission } from "../core/context.js";
import { forbidden } from "../lib/errors.js";
import { TEXT_MAX } from "../lib/limits.js";
import { applyPack, listPacks, PACK_LIMITS, uninstallPack, type Pack } from "../core/packs.js";
import { route } from "./registry.js";
import { dataList, list, nullable, object, plain, S } from "./responses.js";
import { DocField } from "./routes-schemadoc.js";

// --- Schema packs: plan, apply, list and uninstall (see core/packs.ts) ----------------------------

/**
 * A pack as the CLI sends it. Strict everywhere: a pack is untrusted input, so an unknown property is an
 * error rather than ignored. No IDs: a pack names things; the server records which IDs it owns.
 */
const Name = z.string().min(1).max(TEXT_MAX.name);
const PackField = DocField.omit({ id: true, standard: true, read_only: true }).strict();
const PackObject = z.object({
  name: Name, label: z.string().max(TEXT_MAX.name).optional(), plural_label: z.string().max(TEXT_MAX.name).optional(), description: z.string().max(TEXT_MAX.description).optional(),
  id_prefix: z.string().max(PACK_LIMITS.idPrefix).optional(), display_field: z.string().max(TEXT_MAX.identifier).optional(), owned: z.boolean().optional(), hidden: z.boolean().optional(),
  fields: z.array(PackField).max(PACK_LIMITS.fieldsPerObject).optional(),
}).strict();
const PackPipeline = z.object({
  name: Name,
  stages: z.array(z.object({ name: Name, category: z.enum(["open", "won", "lost"]).optional(), probability: z.number().min(0).max(100).nullable().optional() }).strict())
    .min(1).max(PACK_LIMITS.stagesPerPipeline),
}).strict();
const RuleAction = z.boolean().nullable().optional();
const PackRole = z.object({
  key: z.string().max(PACK_LIMITS.roleKey), name: z.string().max(PACK_LIMITS.roleName), description: z.string().max(PACK_LIMITS.description).optional(),
  permissions: z.array(z.string().max(PACK_LIMITS.permission)).max(PACK_LIMITS.permissionsPerRole),
  objects: z.record(z.string().max(TEXT_MAX.identifier), z.object({ read: RuleAction, write: RuleAction, archive: RuleAction }).strict()).optional(),
  fields: z.record(z.string().max(TEXT_MAX.identifier), z.record(z.string().max(TEXT_MAX.identifier), z.enum(["none", "read"]))).optional(),
}).strict();
const PackView = z.object({
  name: z.string().min(1).max(PACK_LIMITS.viewName), object: z.string().max(TEXT_MAX.identifier), where: z.unknown().optional(),
  sort: z.array(z.object({ field: z.string().max(TEXT_MAX.fieldPath), dir: z.enum(["asc", "desc"]).optional() }).strict()).max(PACK_LIMITS.viewSortKeys).optional(),
  columns: z.array(z.string().max(TEXT_MAX.fieldPath)).max(PACK_LIMITS.viewColumns).optional(),
  group_by: z.array(z.object({ field: z.string().max(TEXT_MAX.fieldPath), bucket: z.enum(["day", "week", "month", "quarter", "year"]).optional() }).strict()).max(PACK_LIMITS.viewGroupKeys).optional(),
}).strict();
export const PackBody = z.object({
  manifest: z.object({
    name: z.string().max(TEXT_MAX.identifier), version: z.string().max(PACK_LIMITS.version), description: z.string().max(PACK_LIMITS.description).optional(),
    min_server_version: z.string().max(PACK_LIMITS.version).optional(), modules: z.array(z.string().max(PACK_LIMITS.module)).max(PACK_LIMITS.modules).optional(),
    parts: z.array(z.string().max(PACK_LIMITS.part)).max(PACK_LIMITS.parts), license: z.string().max(PACK_LIMITS.license).optional(),
  }).strict(),
  schema: z.object({
    objects: z.array(PackObject).max(PACK_LIMITS.objects).optional(), pipelines: z.array(PackPipeline).max(PACK_LIMITS.pipelines).optional(),
  }).strict().optional(),
  roles: z.array(PackRole).max(PACK_LIMITS.roles).optional(),
  views: z.array(PackView).max(PACK_LIMITS.views).optional(),
}).strict();

/** Names that would be dropped silently when parsed (a "__proto__" key) are refused instead: a pack says exactly what it holds. */
function protoKeyIn(v: unknown, depth = 0): boolean {
  if (depth > 64 || typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return v.some((x) => protoKeyIn(x, depth + 1));
  return Object.keys(v).some((k) => k === "__proto__" || protoKeyIn((v as Record<string, unknown>)[k], depth + 1));
}
const Checked = <T extends z.ZodType>(schema: T) => z.preprocess((v, ctx) => {
  if (protoKeyIn(v)) ctx.addIssue({ code: "custom", message: 'A pack can\'t use "__proto__" as a name or key' });
  return v;
}, schema);

/**
 * Every pack route first needs one of the three permissions a pack part can need, checked at the gate: before
 * the body is read, the schema or pack row is locked, a heavy slot is taken or any cost is charged. A caller
 * without any of them gets the same 403 whether or not a pack exists. The per-part checks (core/packs.ts) follow.
 */
const PACK_GATE = ["schema:manage", "roles:manage", "views:manage"] as const satisfies readonly Permission[];

/**
 * Installing and uninstalling packs is for people, with a key or a browser session, never for a connected app
 * (OAuth) or through MCP: a pack creates roles and changes the schema in one step, and there is no MCP tool
 * for packs by design. Planning and listing write nothing, so they stay open to any caller past the gate; a
 * plan_token from a connected app is bound to it, so it can't be applied anywhere. Keyed on the surface a
 * connected app's token fixes, and on the header a key's MCP client sends.
 */
function assertNotApp(ctx: Ctx, headers: Headers, what: string): void {
  if (ctx.oauth) throw forbidden(`Connected apps can't ${what} schema packs; use the CLI (crm pack) or the API with a key or a browser session`);
  if ((headers.get("x-hlcrm-surface") ?? "api").endsWith("mcp") || ctx.surface.endsWith("mcp")) throw forbidden(`Schema packs can't be ${what === "install" ? "installed" : "uninstalled"} through MCP; use the CLI (crm pack)`);
}

/** Work grows with what the pack holds: every object, role and view is several statements, a plan runs them all once more. */
const packCost = (p: z.infer<typeof PackBody>) => 2 + Math.ceil(((p.schema?.objects?.length ?? 0) + (p.roles?.length ?? 0) + (p.views?.length ?? 0)) / 5);

const Change = object({ change: S.str, object: S.str, field: S.str, before: S.any, after: S.any, warning: S.str, data_affecting: S.bool, widens_access: S.strs },
  ["change", "object"]);
const PlanShape = {
  dry_run: S.bool, applied: S.bool,
  pack: object({ name: S.str, version: S.str, description: S.str }),
  installed: nullable(object({ version: S.str, status: S.str })),
  action: { type: "string", enum: ["install", "upgrade", "reapply", "reinstall"] },
  changes: list(Change), unsupported: list(object({ path: S.str, message: S.str })), notes: list(S.str),
  /** Changed in this workspace since the pack wrote it, so left as it is. */
  kept: list(object({ path: S.str, message: S.str })),
  /** With overwrite_changes: what the workspace has and what the pack writes instead, and how that widens access. */
  overwritten: list(object({ path: S.str, before: S.any, after: S.any, widens_access: S.strs }, ["path", "before", "after"])),
  plan_token: S.str,
};
const PLAN_REQUIRED = ["dry_run", "applied", "pack", "installed", "action", "changes", "unsupported", "notes", "kept", "overwritten"];
const PlanOptions = {
  prune: z.boolean().optional(),
  overwrite_changes: z.boolean().optional().describe("Replace what was changed in this workspace since the pack wrote it (listed under kept otherwise)"),
  allow_downgrade: z.boolean().optional().describe("Apply a version older than the one last installed"),
};
const PackOut = object({
  name: S.str, version: S.str, status: { type: "string", enum: ["installed", "uninstalled"] }, description: S.str,
  owns: object({ objects: S.strs, fields: S.strs, pipelines: S.strs, roles: S.strs, views: S.strs }),
  installed_at: S.str, installed_by: nullable(S.str), updated_at: S.str,
});

route({
  method: "POST", path: "/v1/packs/plan", scope: "admin", permission: PACK_GATE, tag: "packs",
  summary: "Plan installing or upgrading a schema pack: every change it would make, what this workspace can't take, what was changed here and is kept, "
    + "and notes. Writes nothing. Returns the plan_token apply needs. Needs schema:manage, roles:manage and views:manage for the parts the pack holds",
  heavy: true,
  cost: (b) => packCost(b.pack),
  response: plain(object(PlanShape, [...PLAN_REQUIRED, "plan_token"])),
  body: Checked(z.object({ pack: PackBody, ...PlanOptions }).strict()),
  handler: async ({ tx, ctx, body }) => ({
    body: await applyPack(tx, ctx, body.pack as Pack, { dryRun: true, prune: body.prune, overwriteChanges: body.overwrite_changes, allowDowngrade: body.allow_downgrade }),
  }),
});

route({
  method: "POST", path: "/v1/packs/apply", scope: "admin", permission: PACK_GATE, tag: "packs",
  summary: "Install, upgrade or re-apply a schema pack in one transaction (schema, roles and views together), as planned: needs the plan's plan_token "
    + "and is refused (409 plan_changed) if what it would do changed since. The same version again writes nothing; an older one needs allow_downgrade; "
    + "archiving fields, converting values or restoring records needs confirm_data_changes, and widening access needs confirm_access_changes. "
    + "Not for connected apps (OAuth) or through MCP",
  heavy: true,
  cost: (b) => packCost(b.pack),
  response: plain(object(PlanShape, PLAN_REQUIRED)),
  body: Checked(z.object({
    pack: PackBody, ...PlanOptions, plan_token: z.string().max(TEXT_MAX.token).optional(),
    confirm_data_changes: z.boolean().optional(), confirm_access_changes: z.boolean().optional(),
  }).strict()),
  handler: async ({ tx, ctx, body, headers }) => {
    assertNotApp(ctx, headers, "install");
    return { body: await applyPack(tx, ctx, body.pack as Pack, {
      dryRun: false, prune: body.prune, overwriteChanges: body.overwrite_changes, allowDowngrade: body.allow_downgrade, planToken: body.plan_token,
      confirmDataChanges: body.confirm_data_changes, confirmAccessChanges: body.confirm_access_changes,
    }) };
  },
});

route({
  method: "GET", path: "/v1/packs", scope: "admin", permission: PACK_GATE, tag: "packs",
  summary: "Installed schema packs (and uninstalled ones, which a reinstall restores), with what each owns. Needs schema:manage, roles:manage or views:manage",
  response: dataList(PackOut),
  handler: async ({ tx, ctx }) => ({ body: { data: await listPacks(tx, ctx) } }),
});

route({
  method: "POST", path: "/v1/packs/:name/uninstall", scope: "admin", permission: PACK_GATE, tag: "packs",
  summary: "Uninstall a pack: archive the objects, fields and roles it created and delete its views unless changed (records and values are kept). "
    + "A dry run by default; the real run needs its confirm_token, and confirm_records when records or values would be hidden. in_use lists automations and "
    + "alert rules that use what it would archive (its objects, fields, or roles in run_roles): the real run is refused (409 pack_in_use) while any is listed. "
    + "Not for connected apps (OAuth) or through MCP",
  heavy: true,
  cost: () => 3,
  response: plain(object({
    dry_run: S.bool, pack: object({ name: S.str, version: S.str }), records: S.int, values: S.int, changes: list(Change), notes: list(S.str),
    in_use: list(object({ kind: { type: "string", enum: ["automation", "alert"] }, id: S.str, name: S.str, uses: S.strs })),
    warning: S.str, confirm_token: S.str,
  }, ["dry_run", "pack", "records", "values", "changes", "notes", "in_use"])),
  body: z.object({ dry_run: z.boolean().optional(), confirm_token: z.string().max(TEXT_MAX.token).optional(), confirm_records: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, params, body, headers }) => {
    assertNotApp(ctx, headers, "uninstall");
    return { body: await uninstallPack(tx, ctx, params.name!, { dryRun: body.dry_run ?? true, confirmToken: body.confirm_token, confirmRecords: body.confirm_records }) };
  },
});
