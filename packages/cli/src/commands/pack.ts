import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import type { Context } from "../context.js";
import { CliError, EXIT, usage } from "../errors.js";
import { clean, type Out } from "../output.js";
import { packTemplate, readPack, summarize, type PackPayload } from "../packfile.js";
import { SHORT_NUMBER } from "../patterns.js";
import type { Act } from "../program.js";
import { describeChange, type SchemaDoc } from "../schemafile.js";

/** What a pack plan or apply returns (POST /v1/packs/plan and /apply). */
interface PackPlan {
  dry_run: boolean; applied: boolean;
  pack: { name: string; version: string; description: string };
  installed: { version: string; status: string } | null;
  action: "install" | "upgrade" | "reapply" | "reinstall";
  changes: { change: string; object: string; field?: string; before?: unknown; after?: unknown; warning?: string; data_affecting?: boolean; widens_access?: string[] }[];
  unsupported: { path: string; message: string }[];
  notes: string[];
  /** Changed in this workspace since the pack wrote it, so left as it is. */
  kept: { path: string; message: string }[];
  /** With --overwrite-changes: the workspace's copy and the pack's, and what of that widens access. */
  overwritten: { path: string; before: unknown; after: unknown; widens_access?: string[] }[];
  plan_token?: string;
}

/** The permissions a pack's roles may hold (core/packs.ts PACK_ROLE_PERMISSIONS). */
const ROLE_PERMISSIONS = ["records:read", "records:write", "records:archive", "restricted:read", "views:manage"];
const show = (v: unknown) => clean(JSON.stringify(v ?? null));
const asMap = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const isMap = (v: unknown) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** Each key whose value differs, before → after, one level into maps (a role's objects.ticket): what a person reviews before an overwrite. */
function diffLines(before: unknown, after: unknown, prefix = ""): string[] {
  const b = asMap(before);
  const a = asMap(after);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null))
    .flatMap((k) => (!prefix && (isMap(b[k]) || isMap(a[k])) ? diffLines(b[k], a[k], `${k}.`) : [`${clean(prefix + k)}: ${show(b[k])} → ${show(a[k])}`]));
}

function renderPackPlan(out: Out, plan: PackPlan, verbose: boolean): void {
  const was = plan.installed ? `${plan.installed.status} ${plan.installed.version}` : "not installed";
  out.line(out.paint("bold", `Pack ${clean(plan.pack.name)} ${clean(plan.pack.version)}: ${plan.action} (${was})`));
  if (plan.pack.description) out.line(out.paint("dim", `  ${clean(plan.pack.description)}`));
  if (plan.changes.length === 0) out.line("  No changes.");
  for (const c of plan.changes) {
    const { sign, text } = describeChange(c);
    const tone = sign === "+" ? "add" : sign === "-" ? "remove" : "change";
    out.line(`  ${out.paint(tone, sign)} ${clean(text)}${c.data_affecting ? out.paint("warn", "  [changes stored data]") : ""}${c.widens_access?.length ? out.paint("warn", "  [gives more access]") : ""}`);
    if (c.warning) out.line(out.paint("dim", `      ${clean(c.warning)}`));
    // A role's permissions and rules, and a view's definition, before and after: what the change does, not just that it happens.
    if (c.change === "role_updated") {
      const d = asMap(c.after);
      for (const p of (d.permissions_added as string[] | undefined) ?? []) out.line(`      + permission ${clean(p)}`);
      for (const p of (d.permissions_removed as string[] | undefined) ?? []) out.line(`      - permission ${clean(p)}`);
      for (const k of ["name", "description"]) if (d[k]) out.line(`      ${k}: ${show(asMap(d[k]).before)} → ${show(asMap(d[k]).after)}`);
      for (const k of ["objects", "fields"]) {
        for (const [what, x] of Object.entries(asMap(d[k]))) out.line(`      ${k}.${clean(what)}: ${show(asMap(x).before)} → ${show(asMap(x).after)}`);
      }
    }
    if (c.change === "view_updated") for (const l of diffLines(c.before, c.after)) out.line(`      ${l}`);
  }
  if (plan.kept.length) {
    out.line();
    out.line(out.paint("warn", "Changed in this workspace since the pack wrote it, so kept as it is (--overwrite-changes replaces them):"));
    for (const k of plan.kept) out.line(`  = ${clean(k.path)}`);
  }
  if (plan.overwritten.length) {
    out.line();
    out.line(out.paint("warn", "Overwrites changes made in this workspace (now → the pack's):"));
    for (const o of plan.overwritten) {
      out.line(`  ! ${clean(o.path)}${o.widens_access?.length ? out.paint("warn", "  [gives more access]") : ""}`);
      for (const l of diffLines(o.before, o.after)) out.line(`      ${l}`);
      for (const w of o.widens_access ?? []) out.line(out.paint("warn", `      gives more access: ${clean(w)}`));
    }
  }
  if (plan.unsupported.length) {
    out.line();
    out.line(out.paint("remove", "Cannot be applied:"));
    for (const u of plan.unsupported) out.line(`  ! ${clean(u.path)}: ${clean(u.message)}`);
  }
  if (plan.notes.length) {
    if (verbose) for (const n of plan.notes) out.line(out.paint("dim", `  ${clean(n)}`));
    else out.line(out.paint("dim", `${plan.notes.length} note(s); --verbose lists them`));
  }
  out.line();
  out.line(`${plan.changes.length} change(s).`);
}

/** A copy without `keys`: workspace IDs and informational flags a pack never carries. */
const without = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

interface FieldInfo { type: string; keys: string[]; max: number }
/** Operators whose values are compared whole: a prefix or substring could be any text a person typed. */
const CONFIG_OPS = ["eq", "neq", "in", "not_in"];
/**
 * True when every condition in a view filter tests emptiness, or compares whole values that are configuration,
 * not record data: a select's or status's option keys, true or false, or a rating from 1 to its max. Anything
 * else (a prefix, a free-text value, a value no option has) may be someone's data, so the filter is left out.
 */
function configOnly(where: unknown, fields: Map<string, FieldInfo>, depth = 0): boolean {
  if (depth > 10 || typeof where !== "object" || where === null) return false;
  const w = where as Record<string, unknown>;
  if (Array.isArray(w.and) || Array.isArray(w.or)) return ((w.and ?? w.or) as unknown[]).every((x) => configOnly(x, fields, depth + 1));
  if (Object.hasOwn(w, "not")) return configOnly(w.not, fields, depth + 1);
  if (w.op === "is_null") return w.value === undefined || typeof w.value === "boolean";
  const f = typeof w.field === "string" ? fields.get(w.field) : undefined;
  if (!f || typeof w.op !== "string") return false;
  // A multi-select is filtered with contains, on one option key; a rating, whose values are 1 to its max, also by order.
  const ordered = f.type === "rating" && ["gt", "gte", "lt", "lte"].includes(w.op);
  if (!(CONFIG_OPS.includes(w.op) || ordered || (w.op === "contains" && f.type === "multi_select"))) return false;
  const values = Array.isArray(w.value) ? w.value : [w.value];
  if (values.length === 0) return false;
  return values.every((v) => {
    if (["single_select", "multi_select", "status"].includes(f.type)) return typeof v === "string" && f.keys.includes(v);
    if (f.type === "boolean") return v === true || v === false || v === "true" || v === "false";
    if (f.type === "rating") return (typeof v === "number" || (typeof v === "string" && SHORT_NUMBER.test(v))) && Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= f.max;
    return false;
  });
}

async function exportPack(ctx: Context, dir: string, o: { name: string; version: string; description?: string; object: string[]; role: string[]; pipeline: string[]; views?: boolean }) {
  if (existsSync(dir) && readdirSync(dir).length) throw usage(`${dir} exists and is not empty; export writes a new pack folder`);
  const client = ctx.client();
  const doc = await client.get<SchemaDoc & { objects: Record<string, unknown>[]; pipelines: Record<string, unknown>[] }>("/v1/schema/export");
  const warnings: string[] = [];
  const wanted = o.object.length ? o.object : doc.objects.filter((x) => !x.standard).map((x) => String(x.name));
  const strip = (f: Record<string, unknown>) => {
    const rest = without(f, ["id", "standard", "read_only"]);
    // A relation's default is a record ID: record data of this workspace, meaningless in another.
    if (rest.type === "relation") delete rest.default;
    return rest;
  };
  const objects: Record<string, unknown>[] = [];
  for (const name of wanted) {
    const obj = doc.objects.find((x) => x.name === name);
    if (!obj) throw usage(`There is no object "${name}" in this workspace`);
    const fields = (obj.fields as Record<string, unknown>[]).filter((f) => !obj.standard || !f.standard).map(strip);
    if (obj.standard) {
      if (fields.length) objects.push({ name, fields });
      else warnings.push(`${name} is a standard object with no custom fields; left out`);
      continue;
    }
    objects.push({ ...without(obj, ["id", "standard", "module", "fields"]), fields });
  }
  const names = new Set(objects.map((x) => String(x.name)));
  for (const x of objects) {
    for (const f of x.fields as Record<string, unknown>[]) {
      const to = (f.relation as { to?: string } | undefined)?.to;
      if (to && !names.has(to) && !doc.objects.some((d) => d.name === to && d.standard) && !["user"].includes(to)) {
        warnings.push(`${String(x.name)}.${String(f.name)} relates to ${to}, which is not in the pack; installing it elsewhere needs that object`);
      }
    }
  }
  const pipelines = o.pipeline.map((p) => {
    const found = doc.pipelines.find((x) => x.name === p);
    if (!found) throw usage(`There is no pipeline "${p}"`);
    return { name: found.name, stages: (found.stages as Record<string, unknown>[]).map((s) => without(s, ["id"])) };
  });
  const roles: Record<string, unknown>[] = [];
  if (o.role.length) {
    const all = (await client.get<{ data: { id: string; key: string; is_system: boolean }[] }>("/v1/roles")).data;
    for (const key of o.role) {
      const r = all.find((x) => x.key === key);
      if (!r) throw usage(`There is no role "${key}"`);
      if (r.is_system) throw usage(`${key} is a system role; packs carry custom roles only`);
      const full = (await client.get<{ data: { key: string; name: string; description: string; permissions: string[]; objects: unknown; fields: unknown } }>(`/v1/roles/${encodeURIComponent(r.id)}`)).data;
      const dropped = full.permissions.filter((p) => !ROLE_PERMISSIONS.includes(p));
      if (dropped.length) warnings.push(`role ${key}: left out ${dropped.join(", ")} (a pack's roles hold record permissions and views:manage only)`);
      roles.push({ key: full.key, name: full.name, ...(full.description ? { description: full.description } : {}),
        permissions: full.permissions.filter((p) => ROLE_PERMISSIONS.includes(p)), objects: full.objects, fields: full.fields });
    }
  }
  const views: Record<string, unknown>[] = [];
  if (o.views) {
    const all = (await client.get<{ data: { object: string | null; name: string; shared: boolean; status: string; where: unknown; sort: unknown; columns: unknown; group_by: unknown }[] }>("/v1/views")).data;
    for (const v of all.filter((x) => x.shared && x.status === "ok" && x.object && names.has(x.object))) {
      const fields = new Map(((doc.objects.find((d) => d.name === v.object)?.fields ?? []) as { name: string; type: string; values?: { key: string }[]; max?: number }[])
        .map((f) => [f.name, { type: f.type, keys: (f.values ?? []).map((x) => x.key), max: f.max ?? 5 }]));
      // Filter values can be record data (an email, a name); a filter is kept only when it holds none.
      const keepWhere = v.where != null && configOnly(v.where, fields);
      if (v.where != null && !keepWhere) {
        warnings.push(`view "${v.name}" on ${v.object}: its filter may hold record values (only whole option keys, true/false and ratings are kept), so it was left out; add it back by hand`);
      }
      views.push({ name: v.name, object: v.object, ...(keepWhere ? { where: v.where } : {}),
        ...(v.sort ? { sort: v.sort } : {}), ...(v.columns ? { columns: v.columns } : {}), ...(v.group_by ? { group_by: v.group_by } : {}) });
    }
  }
  const parts = ["schema", ...(roles.length ? ["roles"] : []), ...(views.length ? ["views"] : [])];
  const manifest = { name: o.name, version: o.version, ...(o.description ? { description: o.description } : {}), modules: ["core"], parts };
  mkdirSync(dir, { recursive: true });
  const write = (file: string, body: unknown, header: string) => {
    const d = new YAML.Document(body);
    d.commentBefore = ` ${header}`;
    writeFileSync(join(dir, file), d.toString({ lineWidth: 0 }), { flag: "wx" });
  };
  write("pack.yaml", manifest, "Exported with crm pack export. Check it before sharing: docs/packs.md");
  write("schema.yaml", { objects, ...(pipelines.length ? { pipelines } : {}) }, "The schema part (no IDs): objects, fields and pipelines");
  if (roles.length) write("roles.yaml", { roles }, "Roles the pack creates");
  if (views.length) write("views.yaml", { views }, "Shared views the pack creates");
  return { dir, manifest, counts: { objects: objects.length, pipelines: pipelines.length, roles: roles.length, views: views.length }, warnings };
}

export function registerPack(program: Command, act: Act, collect: (v: string, p?: string[]) => string[]): void {
  const pack = program.command("pack").description("Schema packs: share and install a workspace setup (objects, fields, pipelines, roles, views). See docs/packs.md");

  pack.command("init <dir>")
    .description("Write a small example pack to a new folder, to edit")
    .action(act(async (ctx, dir: string) => {
      if (existsSync(dir) && readdirSync(dir).length) throw usage(`${dir} exists and is not empty`);
      mkdirSync(dir, { recursive: true });
      const template = packTemplate();
      for (const [file, text] of Object.entries(template)) writeFileSync(join(dir, file), text, { flag: "wx" });
      if (ctx.g.json) return ctx.out.data({ dir, files: Object.keys(template) });
      ctx.out.line(`Wrote ${Object.keys(template).join(", ")} to ${dir}. Edit them, then: crm pack validate ${dir} and crm pack plan ${dir}`);
    }));

  pack.command("validate <dir>")
    .description("Check a pack's files and manifest without a server (crm pack plan checks it against a workspace)")
    .action(act(async (ctx, dir: string) => {
      const p = readPack(dir);
      const counts = summarize(p);
      if (ctx.g.json) return ctx.out.data({ valid: true, name: p.manifest.name, version: p.manifest.version, parts: p.manifest.parts, counts });
      ctx.out.line(`${clean(p.manifest.name)} ${clean(p.manifest.version)}: valid. ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}.`);
    }));

  pack.command("export <dir>")
    .description("Write a pack from this workspace: custom objects with their fields, and chosen pipelines, roles and shared views. Never records, members or keys")
    .requiredOption("--name <name>", "the pack's name (lowercase letters, digits, hyphens)")
    .option("--pack-version <version>", "the pack's version", "0.1.0")
    .option("--description <text>", "one sentence on what it sets up")
    .option("--object <name>", "an object to include (repeatable; default: every custom object). A standard object adds only its custom fields", collect, [])
    .option("--pipeline <name>", "a pipeline to include (repeatable)", collect, [])
    .option("--role <key>", "a custom role to include (repeatable)", collect, [])
    .option("--views", "include the shared views on the included objects (filters that may hold record values are left out)")
    .action(act(async (ctx, dir: string, o: { name: string; packVersion: string; description?: string; object: string[]; pipeline: string[]; role: string[]; views?: boolean }) => {
      const r = await exportPack(ctx, dir, { ...o, version: o.packVersion });
      if (ctx.g.json) return ctx.out.data(r);
      for (const w of r.warnings) ctx.out.info(`Note: ${w}`);
      ctx.out.line(`Wrote ${dir}: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(", ")}. Read it through before sharing it.`);
    }));

  type PlanFlags = { prune?: boolean; overwriteChanges?: boolean; allowDowngrade?: boolean; verbose?: boolean };
  const flags = (o: PlanFlags) => ({ ...(o.prune ? { prune: true } : {}), ...(o.overwriteChanges ? { overwrite_changes: true } : {}), ...(o.allowDowngrade ? { allow_downgrade: true } : {}) });
  const plan = async (ctx: Context, p: PackPayload, o: PlanFlags) => ctx.client().post<PackPlan>("/v1/packs/plan", { pack: p, ...flags(o) });
  const OVERWRITE_HELP = "replace what was changed in this workspace since the pack wrote it (kept otherwise); the plan shows each before and after";

  pack.command("plan <dir>")
    .description("Show what installing (or upgrading to) a pack would change in this workspace. Writes nothing")
    .option("--prune", "also plan removing what an earlier version created and this one leaves out")
    .option("--overwrite-changes", OVERWRITE_HELP)
    .option("--allow-downgrade", "plan a version older than the one last installed")
    .option("--verbose", "list notes")
    .addHelpText("after", "\nExit codes: 0 nothing to change, 5 changes to apply, 1 the pack asks for something this workspace can't take.")
    .action(act(async (ctx, dir: string, o: PlanFlags) => {
      const p = await plan(ctx, readPack(dir), o);
      ctx.exitCode = p.unsupported.length ? EXIT.failure : p.changes.length ? EXIT.changes : EXIT.ok;
      if (ctx.g.json) return ctx.out.data(p);
      renderPackPlan(ctx.out, p, Boolean(o.verbose));
    }));

  pack.command("install <dir>")
    .description("Install or upgrade a pack: shows the plan, asks for confirmation, then applies it in one transaction")
    .option("--prune", "remove what an earlier version created and this one leaves out (fields and roles are archived, unchanged views deleted)")
    .option("--overwrite-changes", OVERWRITE_HELP)
    .option("--allow-downgrade", "install a version older than the one last installed")
    .option("--verbose", "list notes")
    .addHelpText("after", "\nWith --no-input (or without a terminal) --yes is required. Read a pack from someone else before installing it: docs/packs.md.")
    .action(act(async (ctx, dir: string, o: PlanFlags) => {
      const body = readPack(dir);
      const p = await plan(ctx, body, o);
      if (!ctx.g.json) renderPackPlan(ctx.out, p, Boolean(o.verbose));
      if (p.unsupported.length) throw new CliError("pack_unsupported", "The pack asks for things this workspace can't take (listed above)", EXIT.failure, { details: p.unsupported });
      if (p.changes.length === 0 && p.action === "reapply") {
        if (ctx.g.json) ctx.out.data(p);
        else ctx.out.line(`${clean(p.pack.name)} ${clean(p.pack.version)} is installed and up to date; nothing to do.`);
        return;
      }
      const affecting = p.changes.filter((c) => c.data_affecting).length;
      const wider = p.changes.filter((c) => c.widens_access?.length).length + p.overwritten.filter((x) => x.widens_access?.length).length;
      const extra = [affecting ? `${affecting} changing stored data` : "", p.overwritten.length ? `${p.overwritten.length} overwriting changes made here` : "",
        wider ? `${wider} giving more access` : ""].filter(Boolean);
      await ctx.confirm(`${p.action === "install" ? "Install" : "Apply"} ${clean(p.pack.name)} ${clean(p.pack.version)}: ${p.changes.length} change(s)${extra.length ? `, ${extra.join(", ")}` : ""}? [y/N] `,
        `${p.changes.length} change(s) to apply${extra.length ? ` (${extra.join(", ")})` : ""}`);
      // The server applies exactly this plan or refuses (plan_changed): the token binds it.
      const r = await ctx.client().post<PackPlan>("/v1/packs/apply", { pack: body, ...flags(o), plan_token: p.plan_token,
        ...(affecting ? { confirm_data_changes: true } : {}), ...(wider ? { confirm_access_changes: true } : {}) });
      if (ctx.g.json) return ctx.out.data(r);
      ctx.out.line(`${r.applied ? "Applied" : "Nothing to apply for"} ${clean(r.pack.name)} ${clean(r.pack.version)} (${r.changes.length} change(s)).`);
    }));

  pack.command("list")
    .description("Packs installed in this workspace (and uninstalled ones, which a reinstall restores)")
    .action(act(async (ctx) => {
      const rows = (await ctx.client().get<{ data: { name: string; version: string; status: string; description: string; owns: Record<string, string[]>; updated_at: string }[] }>("/v1/packs")).data;
      if (ctx.g.json) return ctx.out.data(rows);
      if (!rows.length) return void ctx.out.line("No packs installed.");
      ctx.out.table(rows.map((r) => ({ ...r, owns: Object.entries(r.owns).filter(([, v]) => v.length).map(([k, v]) => `${v.length} ${k}`).join(", ") })),
        ["name", "version", "status", "owns", "updated_at"]);
    }));

  pack.command("uninstall <name>")
    .description("Archive what a pack created (objects, fields, roles; its unchanged views are deleted). Records and values are kept; reinstalling restores them")
    .option("--confirm-records", "uninstall even though the pack's objects or fields hold records (they are hidden, not deleted)")
    .action(act(async (ctx, name: string, o: { confirmRecords?: boolean }) => {
      const path = `/v1/packs/${encodeURIComponent(name)}/uninstall`;
      const dry = await ctx.client().post<{ changes: PackPlan["changes"]; notes: string[]; records: number; values: number; warning?: string; confirm_token: string;
        in_use?: { kind: string; id: string; name: string; uses: string[] }[] }>(path, { dry_run: true });
      const inUse = dry.in_use ?? [];
      if (!ctx.g.json) {
        ctx.out.line(ctx.out.paint("bold", `Uninstall ${clean(name)}:`));
        for (const c of dry.changes) {
          const { sign, text } = describeChange(c);
          ctx.out.line(`  ${ctx.out.paint(sign === "-" ? "remove" : "change", sign)} ${clean(text)}`);
        }
        for (const n of dry.notes) ctx.out.line(ctx.out.paint("dim", `  ${clean(n)}`));
        if (dry.warning) ctx.out.line(ctx.out.paint("warn", clean(dry.warning)));
        if (inUse.length) {
          ctx.out.line(ctx.out.paint("warn", "In use (change or archive these first; the uninstall is refused while any is listed):"));
          for (const u of inUse) ctx.out.line(`  ${u.kind} ${clean(u.id)} ${clean(u.name)}: ${u.uses.map(clean).join(", ")}`);
        }
      }
      if (inUse.length) {
        throw new CliError("pack_in_use", `${inUse.length} automation(s) or alert rule(s) use what uninstalling ${name} would archive: `
          + `${inUse.slice(0, 5).map((u) => `${u.kind} ${u.id}`).join(", ")}. Change or archive them first`, EXIT.conflict);
      }
      if ((dry.records || dry.values) && !o.confirmRecords) {
        throw new CliError("records_exist", `${dry.warning ?? "The pack's objects hold records"}. Pass --confirm-records to uninstall anyway`, EXIT.conflict);
      }
      await ctx.confirm(`Uninstall ${clean(name)} (${dry.changes.length} change(s))? [y/N] `, `Uninstalling ${name} archives what it created`);
      const r = await ctx.client().post<{ changes: unknown[] }>(path, { dry_run: false, confirm_token: dry.confirm_token, ...(o.confirmRecords ? { confirm_records: true } : {}) });
      if (ctx.g.json) return ctx.out.data(r);
      ctx.out.line(`Uninstalled ${clean(name)} (${r.changes.length} change(s)). Reinstalling it restores its objects and fields.`);
    }));
}
