import type { Command } from "commander";
import { accessRows, type ObjectAccess } from "../access.js";
import type { Context } from "../context.js";
import { EXIT, usage } from "../errors.js";
import { clean } from "../output.js";
import { CONNECTED_APP_ID, KEY_ID, MEMBER_ID, ROLE_REF, SESSION_ID, USER_ID } from "../patterns.js";
import type { Act } from "../program.js";
import { registerManage, registerPermissionSets } from "./manage.js";

/** `--permission-sets a,b` as the API's list; "none" (or nothing) is the empty list, which takes every set away. */
const setList = (v: string): string[] => (v.trim() === "none" ? [] : v.split(",").map((x) => x.trim()).filter(Boolean));
/** ", permission sets a, b" for a member that holds any. */
const heldSets = (data: Record<string, unknown>): string => {
  const sets = Array.isArray(data.permission_sets) ? data.permission_sets.map(String) : [];
  return sets.length ? `, permission sets ${sets.map(clean).join(", ")}` : "";
};

const SCOPES = ["admin", "ops:write", "ops:read", "restricted:read"];

/**
 * Prints a new key. The secret goes to stdout once (alone, unless --json), the rest to stderr,
 * so `crm keys create … > key.txt` captures only the secret. It is never written to the config.
 */
function printSecret(ctx: Context, data: Record<string, unknown> & { secret: string }, verb: string): void {
  if (ctx.g.json) return ctx.out.data({ data });
  ctx.out.info(`${verb} ${String(data.id)} (${clean(String(data.name))}, scopes ${(data.scopes as string[]).join(", ")}${data.expires_at ? `, expires ${String(data.expires_at)}` : ""}).`);
  ctx.out.info("The secret is shown once. Store it now:");
  ctx.out.line(data.secret);
}

export function registerAdmin(program: Command, act: Act): void {
  const keys = program.command("keys").description("API keys (needs keys:manage for other members' keys)");
  keys.command("list").description("List API keys (metadata only)").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>("/v1/api-keys");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.map((k) => ({ ...k, status: k.revoked_at ? "revoked" : k.expires_at && Date.parse(String(k.expires_at)) < Date.now() ? "expired" : "active" })),
      ["id", "name", "hint", "scopes", "owner", "status", "last_used_at"]);
  }));
  keys.command("create")
    .description("Create a key; its secret is printed once")
    .requiredOption("--name <name>", "a name to recognise it by")
    .requiredOption("--scopes <list>", `comma-separated: ${SCOPES.join(", ")}`)
    .option("--owner <id>", "the member or service account (usr_… / svc_…) it acts as; default: you")
    .option("--environment <env>", "live or test", "live")
    .option("--expires-in-days <n>", "expire after this many days")
    .action(act(async (ctx, opts: { name: string; scopes: string; owner?: string; environment: string; expiresInDays?: string }) => {
      const scopes = opts.scopes.split(",").map((s) => s.trim()).filter(Boolean);
      if (!scopes.length || scopes.some((s) => !SCOPES.includes(s))) throw usage(`--scopes must be a list of: ${SCOPES.join(", ")}`);
      if (opts.owner && !MEMBER_ID.test(opts.owner)) throw usage("--owner must be a usr_… or svc_… ID");
      const days = opts.expiresInDays === undefined ? undefined : Number(opts.expiresInDays);
      if (days !== undefined && (!Number.isInteger(days) || days < 1)) throw usage("--expires-in-days must be a positive whole number");
      const { data } = await ctx.client().post<{ data: Record<string, unknown> & { secret: string } }>("/v1/api-keys", {
        name: opts.name, scopes, owner: opts.owner, environment: opts.environment, expires_in_days: days,
      });
      printSecret(ctx, data, "Created key");
    }));
  keys.command("rotate <id>")
    .description("Issue a replacement key; the old one keeps working for the overlap window, then expires")
    .option("--overlap-hours <n>", "how long the old key keeps working (0 to 168)", "24")
    .action(act(async (ctx, id: string, opts: { overlapHours: string }) => {
      if (!KEY_ID.test(id)) throw usage(`"${id}" is not a key ID (key_…)`);
      const hours = Number(opts.overlapHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw usage("--overlap-hours must be 0 to 168");
      await ctx.confirm(`Rotate ${id}? The old key stops working in ${hours} hour(s). [y/N] `, `Rotating ${id} expires the old key in ${hours} hour(s)`);
      const { data } = await ctx.client().post<{ data: Record<string, unknown> & { secret: string } }>(`/v1/api-keys/${id}/rotate`, { overlap_hours: hours });
      printSecret(ctx, data, `Rotated ${id}; the replacement is`);
    }));
  keys.command("revoke <id>")
    .description("Revoke a key at once")
    .action(act(async (ctx, id: string) => {
      if (!KEY_ID.test(id)) throw usage(`"${id}" is not a key ID (key_…)`);
      await ctx.confirm(`Revoke ${id}? Anything using it stops working now. [y/N] `, `Revoking ${id} stops it working immediately`);
      const { data } = await ctx.client().post<{ data: unknown }>(`/v1/api-keys/${id}/revoke`);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Revoked ${id}.`);
    }));

  const members = program.command("members").description("Members and service accounts (needs members:manage)");
  members.command("list").description("List members and service accounts").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: { users: Record<string, unknown>[]; service_accounts: Record<string, unknown>[] } }>("/v1/members");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table([...data.users.map((u) => ({ ...u, kind: "member" })), ...data.service_accounts.map((s) => ({ ...s, kind: "service account" }))],
      ["id", "kind", "name", "email", "role", "permission_sets", "active"]);
  }));
  members.command("add")
    .description("Add a member (or a service account with --service-account)")
    .requiredOption("--name <name>", "display name")
    .requiredOption("--role <role>", "role key (admin, member, read_only, a custom role) or role_… ID")
    .option("--email <email>", "the member's email (members only)")
    .option("--permission-sets <list>", "comma-separated permission sets (keys or pset_… IDs) to hold on top of the role")
    .option("--service-account", "add a service account for an integration or agent instead of a person")
    .action(act(async (ctx, opts: { name: string; role: string; email?: string; permissionSets?: string; serviceAccount?: boolean }) => {
      if (!opts.serviceAccount && !opts.email) throw usage("--email is required for a member (or pass --service-account)");
      const sets = opts.permissionSets !== undefined ? { permission_sets: setList(opts.permissionSets) } : {};
      const { data } = opts.serviceAccount
        ? await ctx.client().post<{ data: Record<string, unknown> }>("/v1/service-accounts", { name: opts.name, role: opts.role, ...sets })
        : await ctx.client().post<{ data: Record<string, unknown> }>("/v1/members", { name: opts.name, role: opts.role, email: opts.email, ...sets });
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Added ${String(data.id)} (${clean(String(data.name))}) with role ${String(data.role)}${heldSets(data)}.`);
    }));
  members.command("update <id>")
    .description("Change a member's or service account's role or permission sets, or disable/enable it (disabling revokes its keys)")
    .option("--role <role>", "new role")
    .option("--permission-sets <list>", "the permission sets to hold, comma-separated: the whole list (sets left out are taken away); \"none\" takes them all away")
    .option("--disable", "disable it")
    .option("--enable", "enable it again")
    .action(act(async (ctx, id: string, opts: { role?: string; permissionSets?: string; disable?: boolean; enable?: boolean }) => {
      if (!MEMBER_ID.test(id)) throw usage(`"${id}" is not a member (usr_…) or service account (svc_…) ID`);
      if (opts.disable && opts.enable) throw usage("--disable and --enable cannot be combined");
      if (!opts.role && opts.permissionSets === undefined && !opts.disable && !opts.enable) throw usage("Nothing to change: pass --role, --permission-sets, --disable or --enable");
      if (opts.disable) await ctx.confirm(`Disable ${id} and revoke all its keys? [y/N] `, `Disabling ${id} revokes all its keys`);
      const path = id.startsWith("usr_") ? `/v1/members/${id}` : `/v1/service-accounts/${id}`;
      const { data } = await ctx.client().patch<{ data: Record<string, unknown> }>(path, {
        ...(opts.role ? { role: opts.role } : {}), ...(opts.permissionSets !== undefined ? { permission_sets: setList(opts.permissionSets) } : {}),
        ...(opts.disable ? { active: false } : opts.enable ? { active: true } : {}),
      });
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Updated ${id}: role ${String(data.role)}${heldSets(data)}, ${data.active ? "active" : "disabled"}.`);
    }));

  const roles = program.command("roles").description("Roles and their permissions (every member has one)");
  roles.command("list").description("List roles").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>("/v1/roles");
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.table(data.map((r) => ({ ...r, kind: r.is_system ? "system" : "custom" })), ["key", "name", "kind", "members", "permissions"]);
  }));
  roles.command("get <role>").description("Show a role by key or role_… ID, with its object and field rules and the record access they give").action(act(async (ctx, role: string) => {
    if (!ROLE_REF.test(role)) throw usage(`"${role}" is not a role key or ID`);
    const client = ctx.client();
    const { data } = await client.get<{ data: Record<string, unknown> }>(`/v1/roles/${role}`);
    const access = (await client.get<{ data: { objects: ObjectAccess[] } }>(`/v1/roles/${role}/access`)).data.objects;
    if (ctx.g.json) return ctx.out.data({ data, access });
    for (const [k, v] of Object.entries(data)) {
      if (k === "objects" || k === "fields") continue; // the rules, shown as their effect below
      ctx.out.line(`${k.padEnd(12)} ${clean(Array.isArray(v) ? v.join(", ") : String(v ?? ""))}`);
    }
    const rules = [
      ...Object.entries((data.objects ?? {}) as Record<string, Record<string, boolean | null>>).map(([o, r]) =>
        `${o}: ${Object.entries(r).filter(([, x]) => x !== null).map(([a, x]) => `${a} ${x ? "allowed" : "denied"}`).join(", ")}`),
      ...Object.entries((data.fields ?? {}) as Record<string, Record<string, string>>).flatMap(([o, fs]) => Object.entries(fs).map(([f, a]) => `${o}.${f}: ${a}`)),
    ];
    ctx.out.line(`${"rules".padEnd(12)} ${rules.length ? clean(rules.join("; ")) : "(none: the permissions apply to every object)"}`);
    ctx.out.line();
    ctx.out.table(accessRows(access), ["object", "access", "limited_fields", "restricted"]);
  }));

  const sessions = program.command("sessions").description("Members' browser sign-in sessions (needs members:manage). API keys are separate: see `crm keys`");
  sessions.command("list <member>").description("A member's live browser sessions").action(act(async (ctx, member: string) => {
    if (!USER_ID.test(member)) throw usage(`"${member}" is not a member ID (usr_…)`);
    const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>(`/v1/members/${member}/sessions`);
    if (ctx.g.json) return ctx.out.data({ data });
    if (!data.length) return ctx.out.line(`${member} has no live sessions.`);
    ctx.out.table(data, ["id", "method", "signed_in_at", "last_seen_at", "expires_at", "client_address", "user_agent"]);
  }));
  sessions.command("revoke [session]")
    .description("End one session (ses_…), or every session of a member with --member <usr_…> --all")
    .option("--member <id>", "the member whose sessions to end (with --all)")
    .option("--all", "end all of the member's sessions")
    .action(act(async (ctx, session: string | undefined, opts: { member?: string; all?: boolean }) => {
      if (session && (opts.all || opts.member)) throw usage("Pass a session ID, or --member with --all, not both");
      if (session) {
        if (!SESSION_ID.test(session)) throw usage(`"${session}" is not a session ID (ses_…)`);
        await ctx.confirm(`End session ${session}? Whoever uses it is signed out now. [y/N] `, `Revoking ${session} signs it out immediately`);
        const { data } = await ctx.client().delete<{ data: unknown }>(`/v1/sessions/${session}`);
        if (ctx.g.json) return ctx.out.data({ data });
        return ctx.out.line(`Revoked ${session}.`);
      }
      if (!opts.member || !opts.all) throw usage("Pass a session ID (ses_…), or --member <usr_…> --all");
      if (!USER_ID.test(opts.member)) throw usage(`"${opts.member}" is not a member ID (usr_…)`);
      await ctx.confirm(`Sign ${opts.member} out of every browser session? Their API keys keep working. [y/N] `, `Revoking signs ${opts.member} out everywhere`);
      const { data } = await ctx.client().post<{ data: { revoked: number } }>(`/v1/members/${opts.member}/sessions/revoke`);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Revoked ${data.revoked} session(s) of ${opts.member}.`);
    }));

  const apps = program.command("apps").description("Apps connected over OAuth to the MCP servers: your key owner's, or (with members:manage) a member's");
  apps.command("list").description("Connected apps, newest first")
    .option("--member <id>", "a member's apps (usr_…) instead of your own")
    .action(act(async (ctx, opts: { member?: string }) => {
      if (opts.member && !USER_ID.test(opts.member)) throw usage(`"${opts.member}" is not a member ID (usr_…)`);
      const { data } = await ctx.client().get<{ data: Record<string, unknown>[] }>("/v1/apps", { member: opts.member });
      if (ctx.g.json) return ctx.out.data({ data });
      if (!data.length) return ctx.out.line(opts.member ? `${opts.member} has no connected apps.` : "No connected apps.");
      ctx.out.table(data.map((g) => {
        const c = g.client as { name: string; id: string; kind: string; redirect_host: string };
        return { ...g, app: clean(c.name), client_id: c.id, verified: c.kind === "metadata_document" ? "document" : "self-registered", sends_to: c.redirect_host };
      }), ["id", "app", "verified", "sends_to", "scopes", "resource", "created_at", "last_used_at"]);
    }));
  apps.command("revoke <app>").description("Disconnect an app (ogr_…): its access and refresh tokens stop working at once")
    .action(act(async (ctx, app: string) => {
      if (!CONNECTED_APP_ID.test(app)) throw usage(`"${app}" is not a connected app ID (ogr_…)`);
      await ctx.confirm(`Disconnect ${app}? The app loses access now and must be approved again to reconnect. [y/N] `, `Revoking ${app} disconnects it immediately`);
      const { data } = await ctx.client().delete<{ data: unknown }>(`/v1/apps/${app}`);
      if (ctx.g.json) return ctx.out.data({ data });
      ctx.out.line(`Disconnected ${app}.`);
    }));

  const audit = program.command("audit").description("The audit log (needs audit:read)");
  audit.command("verify").description("Verify the audit log's hash chain and anchors; exits 1 if it fails").action(act(async (ctx) => {
    const { data } = await ctx.client().get<{ data: { ok: boolean; rows_checked: number; unsealed: number; anchors_checked: number; checks: string[]; problem?: string } }>("/v1/audit/verify");
    if (!data.ok) ctx.exitCode = EXIT.failure;
    if (ctx.g.json) return ctx.out.data({ data });
    ctx.out.line(data.ok ? `Audit log verified: ${data.rows_checked} sealed rows, ${data.anchors_checked} anchors, ${data.unsealed} not sealed yet.`
      : `Audit log verification FAILED: ${clean(data.problem ?? "unknown problem")}`);
  }));
  audit.command("log")
    .description("Show audit entries, newest first")
    .option("--limit <n>", "entries (max 500)", "50")
    .option("--action <prefix>", "only actions starting with this, e.g. schema. or contact.exported")
    .option("--record <id>", "only entries about this record, member or key, e.g. con_… or usr_…")
    .option("--before <seq>", "entries before this sequence number (for paging)")
    .action(act(async (ctx, opts: { limit: string; action?: string; record?: string; before?: string }) => {
      const page = await ctx.client().get<{ data: Record<string, unknown>[]; next_before: number | null }>("/v1/audit-log", {
        limit: opts.limit, action: opts.action, record: opts.record, before: opts.before,
      });
      if (ctx.g.json) return ctx.out.data(page);
      ctx.out.table(page.data, ["seq", "at", "action", "actor", "surface", "object", "record_id"]);
      if (page.next_before) ctx.out.info(`More: --before ${page.next_before}`);
    }));

  registerManage(program, act, roles, audit);
  registerPermissionSets(program, act);
}
