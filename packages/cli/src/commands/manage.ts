import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import YAML from "yaml";
import { accessRows, type ObjectAccess } from "../access.js";
import { CliError, EXIT, usage } from "../errors.js";
import { clean } from "../output.js";
import { FIELD_ACCESS_RULE, OBJECT_ACCESS_RULE, ROLE_REF, WEBHOOK_ID } from "../patterns.js";
import type { Act } from "../program.js";

/** Role editing, webhooks, the access review and the event log: the admin gaps the agent skills hit. */

const roleRef = (r: string) => {
  if (!ROLE_REF.test(r)) throw usage(`"${r}" is not a role key or ID`);
  return r;
};
const setRef = (r: string) => {
  if (!ROLE_REF.test(r)) throw usage(`"${r}" is not a permission set key or ID`);
  return r;
};
const webhookId = (id: string) => {
  if (!WEBHOOK_ID.test(id)) throw usage(`"${id}" is not a webhook ID (whk_…)`);
  return id;
};

type Rules = { objects?: Record<string, Record<string, boolean | null> | null>; fields?: Record<string, Record<string, string | null> | null> };
const ALLOW: Record<string, boolean | null> = { allow: true, true: true, deny: false, false: false, inherit: null, null: null };

/**
 * A role body from flags and/or a YAML or JSON file (the API's shape: key, name, description,
 * permissions, copy_from, objects, fields). Flags override the file.
 *   --object deal:read=deny   (allow, deny or inherit; repeatable)
 *   --field contact.email=none (none, read or inherit; repeatable)
 */
export function roleBody(opts: { file?: string; key?: string; name?: string; description?: string; permissions?: string; copyFrom?: string; object?: string[]; field?: string[] }): Record<string, unknown> {
  let body: Record<string, unknown> & Rules = {};
  if (opts.file) {
    if (!existsSync(opts.file)) throw usage(`${opts.file} not found`);
    try {
      const parsed = YAML.parse(readFileSync(opts.file, "utf8"), { uniqueKeys: true, maxAliasCount: 100 }) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it must hold one role (a mapping)");
      body = parsed as typeof body;
    } catch (e) {
      throw new CliError("role_file_invalid", `${opts.file} is not a valid role file: ${(e as Error).message.split("\n")[0]}`, EXIT.usage);
    }
  }
  if (opts.key) body.key = opts.key;
  if (opts.name) body.name = opts.name;
  if (opts.description !== undefined) body.description = opts.description;
  if (opts.copyFrom) body.copy_from = opts.copyFrom;
  if (opts.permissions !== undefined) body.permissions = opts.permissions.split(",").map((p) => p.trim()).filter(Boolean);
  for (const o of opts.object ?? []) {
    const m = OBJECT_ACCESS_RULE.exec(o);
    if (!m || !Object.hasOwn(ALLOW, m[3]!)) throw usage(`--object "${o}" must look like object:read|write|archive=allow|deny|inherit`);
    body.objects = { ...body.objects, [m[1]!]: { ...(body.objects?.[m[1]!] ?? {}), [m[2]!]: ALLOW[m[3]!]! } };
  }
  for (const f of opts.field ?? []) {
    const m = FIELD_ACCESS_RULE.exec(f);
    if (!m) throw usage(`--field "${f}" must look like object.field=none|read|inherit`);
    body.fields = { ...body.fields, [m[1]!]: { ...(body.fields?.[m[1]!] ?? {}), [m[2]!]: m[3] === "inherit" ? null : m[3]! } };
  }
  return body;
}

const roleOptions = (c: Command) => c
  .option("--file <path>", "a YAML or JSON file with the role or permission set (key, name, description, permissions, objects, fields)")
  .option("--name <name>", "display name")
  .option("--description <text>", "what it is for")
  .option("--permissions <list>", "comma-separated permissions (see GET /v1/permissions); replaces the list")
  .option("--object <rule>", "object rule, repeatable: object:read|write|archive=allow|deny|inherit", (v: string, p: string[] = []) => [...p, v])
  .option("--field <rule>", "field rule, repeatable: object.field=none|read|inherit", (v: string, p: string[] = []) => [...p, v]);

export function registerManage(program: Command, act: Act, roles: Command, audit: Command): void {
  roleOptions(roles.command("create").description("Create a custom role from flags or a file")
    .option("--key <key>", "2 to 40 lowercase letters, digits or underscores")
    .option("--copy-from <role>", "start from another role's permissions and rules"))
    .action(act(async (ctx, opts: Parameters<typeof roleBody>[0]) => {
      const body = roleBody(opts);
      if (!body.key || !body.name) throw usage("A role needs a key and a name (--key, --name or the file)");
      const { data } = await ctx.client().post<{ data: Record<string, unknown> }>("/v1/roles", body);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Created role ${clean(String(data.key))} (${String(data.id)}).`);
    }));

  roleOptions(roles.command("update <role>").description("Change a custom role: only what you pass changes; inherit clears a rule"))
    .action(act(async (ctx, role: string, opts: Parameters<typeof roleBody>[0]) => {
      const body = roleBody(opts);
      delete body.key;
      delete body.copy_from;
      if (Object.keys(body).length === 0) throw usage("Nothing to change");
      const { data } = await ctx.client().patch<{ data: Record<string, unknown> }>(`/v1/roles/${roleRef(role)}`, body);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Updated role ${clean(String(data.key))}.`);
    }));

  roles.command("archive <role>").description("Archive a custom role (refused while an active member holds it)").action(act(async (ctx, role: string) => {
    await ctx.confirm(`Archive role ${role}? [y/N] `, `Archiving role ${role} can't be undone`);
    const { data } = await ctx.client().delete<{ data: Record<string, unknown> }>(`/v1/roles/${roleRef(role)}`);
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(`Archived role ${clean(String(data.key))}.`);
  }));

  roles.command("access <role>").description("What the role's holders can do with each object, and their limited fields").action(act(async (ctx, role: string) => {
    const { data } = await ctx.client().get<{ data: { objects: ObjectAccess[] } }>(`/v1/roles/${roleRef(role)}/access`);
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(accessRows(data.objects), ["object", "access", "limited_fields", "restricted"]);
  }));

  audit.command("review").description("The access review: every member and service account with role, permissions, rules and keys").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: { generated_at: string; members: (Record<string, unknown> & { keys: { usable: boolean }[]; record_rules: unknown })[] } }>("/v1/access-review");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.members.map((m) => ({ ...m, status: m.active ? "active" : "disabled", usable_keys: m.keys.filter((k) => k.usable).length,
      rules: m.record_rules && Object.keys(m.record_rules as object).length ? "yes" : "" })), ["id", "type", "name", "email", "role", "status", "usable_keys", "rules"]);
    ctx.out.info(`Generated ${data.generated_at}. Use --json for permissions, rules and every key.`);
  }));

  const webhooks = program.command("webhooks").description("Webhook endpoints and their deliveries (needs webhooks:manage)");
  webhooks.command("list").description("List webhook endpoints").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>("/v1/webhooks");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data, ["id", "url", "events", "status", "created_at"]);
  }));
  webhooks.command("get <id>").description("Show one webhook endpoint").action(act(async (ctx, id: string) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown> }>(`/v1/webhooks/${webhookId(id)}`);
    if (ctx.g.json) return ctx.out.data({ data });
    for (const [k, v] of Object.entries(data)) ctx.out.line(`${k.padEnd(20)} ${clean(v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v))}`);
  }));
  webhooks.command("deliveries <id>").description("The delivery log, newest first (payloads left out)")
    .option("--status <status>", "pending, succeeded or dead")
    .option("--limit <n>", "deliveries (max 200)", "50")
    .option("--before <cursor>", "continue from a previous page")
    .action(act(async (ctx, id: string, opts: { status?: string; limit: string; before?: string }) => {
      const page = await ctx.client().get<{ data: Record<string, unknown>[]; next_before: string | null }>(`/v1/webhooks/${webhookId(id)}/deliveries`,
        { status: opts.status, limit: opts.limit, before: opts.before });
      const rows = page.data.map(({ payload: _payload, ...rest }) => rest);
      if (ctx.g.json) return ctx.out.data({ data: rows, next_before: page.next_before });
      ctx.out.table(rows, ["id", "event_type", "trigger", "status", "attempts", "last_status_code", "last_attempt_at"]);
      if (page.next_before) ctx.out.info(`More: --before ${page.next_before}`);
    }));
  webhooks.command("test <id>").description("Queue a signed webhook.test event (no CRM records)").action(act(async (ctx, id: string) => {
    const { data } = await ctx.client().post<{ data: { delivery: { id: string } } }>(`/v1/webhooks/${webhookId(id)}/test`, {});
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(`Queued test delivery ${data.delivery.id}; the worker sends it within seconds (crm webhooks deliveries ${id}).`);
  }));
  webhooks.command("secret <id>").description("Print the signing secret, alone, to stdout (nothing else is printed there; never stored)")
    .action(act(async (ctx, id: string) => {
      await ctx.confirm(`Print the signing secret of ${id}? [y/N] `, "Printing a webhook secret shows it on this terminal");
      const { data } = await ctx.client().get<{ data: { id: string; secret: string } }>(`/v1/webhooks/${webhookId(id)}/secret`);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.info(`The signing secret of ${id} (store it in the receiver's configuration):`);
      ctx.out.line(data.secret);
    }));

  const events = program.command("events").description("The event log (last 90 days)");
  events.command("list").description("Events, newest first")
    .option("--status <status>", "dead: events whose processing failed every attempt")
    .option("--type <prefix>", "event type or prefix, e.g. deal. or contact.updated")
    .option("--record <id>", "events about one record")
    .option("--limit <n>", "events (max 200)", "50")
    .option("--before <cursor>", "continue from a previous page")
    .action(act(async (ctx, opts: { status?: string; type?: string; record?: string; limit: string; before?: string }) => {
      const page = await ctx.client().get<{ data: (Record<string, unknown> & { processing: Record<string, unknown> })[]; next_before?: string | null }>("/v1/events",
        { status: opts.status, type: opts.type, record: opts.record, limit: opts.limit, before: opts.before });
      if (ctx.g.json) return ctx.out.data(page);
      ctx.out.table(page.data.map((e) => ({ ...e, ...e.processing })), ["id", "type", "record_id", "occurred_at", "status", "attempts", "last_error"]);
      if (page.next_before) ctx.out.info(`More: --before ${page.next_before}`);
    }));
}

/**
 * Permission sets (docs/permissions.md): built like custom roles, held by members on top of their role.
 * The commands mirror `crm roles`; assigning a set to a member is `crm members update --permission-sets`.
 */
export function registerPermissionSets(program: Command, act: Act): void {
  const sets = program.command("permission-sets").description("Permission sets: extra access members hold on top of their role");
  const path = (ref?: string) => (ref === undefined ? "/v1/permission-sets" : `/v1/permission-sets/${setRef(ref)}`);

  sets.command("list").description("List permission sets").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>(path());
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.map((r) => ({ ...r, members: r.active_members })), ["key", "name", "members", "record_permissions", "feature_permissions"]);
  }));

  sets.command("get <set>").description("Show a permission set by key or pset_… ID, with the record access it gives by itself").action(act(async (ctx, ref: string) => {
    const client = ctx.client();
    const { data } = await client.get<{ data: Record<string, unknown> }>(path(ref));
    const access = (await client.get<{ data: { objects: ObjectAccess[] } }>(`${path(ref)}/access`)).data.objects;
    if (ctx.g.json) return ctx.out.data({ data, access });
    for (const [k, v] of Object.entries(data)) {
      if (k === "objects" || k === "fields" || k === "permissions") continue; // shown as the two areas, and as their effect below
      ctx.out.line(`${k.padEnd(20)} ${clean(Array.isArray(v) ? v.join(", ") : String(v ?? ""))}`);
    }
    ctx.out.table(accessRows(access), ["object", "access", "limited_fields", "restricted"]);
  }));

  roleOptions(sets.command("create").description("Create a permission set from flags or a file")
    .option("--key <key>", "2 to 40 lowercase letters, digits or underscores")
    .option("--copy-from <set>", "start from another permission set's permissions and rules"))
    .action(act(async (ctx, opts: Parameters<typeof roleBody>[0]) => {
      const body = roleBody(opts);
      if (!body.key || !body.name) throw usage("A permission set needs a key and a name (--key, --name or the file)");
      const { data } = await ctx.client().post<{ data: Record<string, unknown> }>(path(), body);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Created permission set ${clean(String(data.key))} (${String(data.id)}).`);
    }));

  roleOptions(sets.command("update <set>").description("Change a permission set: only what you pass changes; inherit clears a rule"))
    .action(act(async (ctx, ref: string, opts: Parameters<typeof roleBody>[0]) => {
      const body = roleBody(opts);
      delete body.key;
      delete body.copy_from;
      if (Object.keys(body).length === 0) throw usage("Nothing to change");
      const { data } = await ctx.client().patch<{ data: Record<string, unknown> }>(path(ref), body);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Updated permission set ${clean(String(data.key))}.`);
    }));

  sets.command("archive <set>").description("Archive a permission set (refused while an active member holds it)").action(act(async (ctx, ref: string) => {
    await ctx.confirm(`Archive permission set ${ref}? [y/N] `, `Archiving permission set ${ref} can't be undone`);
    const { data } = await ctx.client().delete<{ data: Record<string, unknown> }>(path(ref));
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(`Archived permission set ${clean(String(data.key))}.`);
  }));

  sets.command("access <set>").description("What the set gives by itself with each object, and its limited fields").action(act(async (ctx, ref: string) => {
    const { data } = await ctx.client().get<{ data: { objects: ObjectAccess[] } }>(`${path(ref)}/access`);
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(accessRows(data.objects), ["object", "access", "limited_fields", "restricted"]);
  }));
}
