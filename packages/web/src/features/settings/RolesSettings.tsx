import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Check, ChevronRight, Lock, Minus, Pencil, Plus, Shield } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Checkbox, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem, PERMISSION_LABELS } from "@/lib/api/problem";
import type { ObjectMeta, PermissionInfo, Role, RoleAccess, RoleObjectRule } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";
import { useDescribes, useObjects } from "@/meta/hooks";
import { useRoles } from "./MembersSettings";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

/**
 * Roles and permission sets are built and edited the same way (permissions, object rules, field rules).
 * A member has exactly one role; permission sets are extra, a member can hold several, and their access
 * is everything their role and sets allow together.
 */
type Kind = "role" | "permission_set";
const KINDS = {
  role: {
    api: "/v1/roles", list: "/settings/roles", detail: "/settings/roles/$roleId", listKey: "roles", title: "Roles", one: "role", One: "Role",
    blurb: "A role is a set of permissions, plus (for custom roles) rules per object and per field. Every member has one.",
    empty: "No roles.",
  },
  permission_set: {
    api: "/v1/permission-sets", list: "/settings/permission-sets", detail: "/settings/permission-sets/$roleId", listKey: "permission-sets",
    title: "Permission sets", one: "permission set", One: "Permission set",
    blurb: "A permission set adds access on top of a member's role: what they can do with each object and field, and which features they can use. A member can hold several, and gets everything their role and their sets allow. Assign them in Members.",
    empty: "No permission sets yet.",
  },
} as const;

export function usePermissionSets() {
  return useAdmin<{ data: Role[] }>(["permission-sets"], "/v1/permission-sets");
}

export const RolesSettings = () => <DefinitionList kind="role" />;
export const PermissionSetsSettings = () => <DefinitionList kind="permission_set" />;
export const RoleDetail = () => <DefinitionDetail kind="role" />;
export const PermissionSetDetail = () => <DefinitionDetail kind="permission_set" />;

function DefinitionList({ kind }: { kind: Kind }) {
  const k = KINDS[kind];
  const s = useSession();
  const asRoles = useRoles();
  const asSets = usePermissionSets();
  const roles = kind === "role" ? asRoles : asSets;
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const rows = roles.data?.data.filter((r) => !r.archived_at) ?? [];
  return (
    <Section title={k.title} description={k.blurb}
      actions={s.can("roles:manage") ? <Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus /> New {k.one}</Button> : null}>
      {roles.isPending ? <Skeleton className="h-24" /> : roles.error ? <ProblemView error={roles.error} compact /> : rows.length === 0 ? <EmptyState title={k.empty} /> : (
        <ul className="-m-4 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={k.detail} params={{ roleId: r.key }} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                <Shield className="size-4 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.name} {kind === "permission_set" ? null : r.is_system ? <Badge>System</Badge> : <Badge tone="accent">Custom</Badge>}</p>
                  <p className="truncate text-sm text-muted">{r.description || `${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"}`}</p>
                </div>
                <span className="text-sm text-subtle">{r.active_members} member{r.active_members === 1 ? "" : "s"}</span>
                <ChevronRight className="size-4 text-subtle" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating ? <RoleEditor kind={kind} onClose={() => setCreating(false)} onSaved={(r) => {
        setCreating(false);
        void navigate({ to: k.detail, params: { roleId: r.key } });
      }} /> : null}
    </Section>
  );
}

const tri = (v: boolean | null | undefined) => (v === true ? <Check className="size-4 text-success" aria-label="yes" /> : <Minus className="size-4 text-subtle" aria-label="no" />);

function DefinitionDetail({ kind }: { kind: Kind }) {
  const k = KINDS[kind];
  const { roleId } = useParamsSafe();
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const role = useAdmin<{ data: Role }>([kind, roleId], `${k.api}/${encodeURIComponent(roleId)}`);
  const access = useAdmin<{ data: RoleAccess }>([`${kind}-access`, roleId], `${k.api}/${encodeURIComponent(roleId)}/access`);
  const perms = useAdmin<{ data: PermissionInfo[] }>(["permissions"], "/v1/permissions");
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const labels = useSchemaLabels(access.data?.data.objects.map((o) => o.object) ?? []);
  const archive = useMutation({
    mutationFn: () => api.delete(`${k.api}/${encodeURIComponent(roleId)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", k.listKey] });
      toast.toast({ tone: "success", title: `${k.One} archived` });
      void navigate({ to: k.list });
    },
    onError: (e) => {
      setArchiving(false);
      toast.error(e, `Couldn't archive the ${k.one}`);
    },
  });
  if (role.error) return <ProblemView error={role.error} />;
  if (!role.data) return <Skeleton className="h-64 max-w-4xl" />;
  const r = role.data.data;
  const held = kind === "role" ? s.role === r.key : (s.permission_sets ?? []).includes(r.key);
  const editable = s.can("roles:manage") && !r.is_system && !held;
  const catalog = perms.data?.data ?? [];
  const records = r.permissions.filter((p) => isRecordPermission(catalog, p));
  const features = r.permissions.filter((p) => !isRecordPermission(catalog, p));
  const chips = (list: string[]) => (
    <ul className="flex flex-wrap gap-1.5">{list.length ? list.map((p) => <li key={p}><Badge title={p}>{capFirst(PERMISSION_LABELS[p] ?? p)}</Badge></li>) : <li className="text-base text-muted">None</li>}</ul>
  );
  return (
    <>
      <Link to={k.list} className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> {k.title}</Link>
      <Section title={r.name} description={r.description ?? undefined}
        actions={editable ? <><Button size="sm" onClick={() => setEditing(true)}><Pencil /> Edit</Button><Button size="sm" variant="danger-ghost" onClick={() => setArchiving(true)}>Archive…</Button></> : null}>
        <p className="mb-3 text-sm text-muted">
          Key <code className="font-mono">{r.key}</code> · {r.active_members} active member{r.active_members === 1 ? "" : "s"}
          {r.is_system ? " · System roles can't be changed; make a custom role from one instead." : held ? ` · You hold this ${k.one}, so you can't change it.` : ""}
        </p>
        <h3 className="mb-2 text-sm font-medium text-muted">Objects and fields: for every object, unless a rule below says otherwise</h3>
        {chips(records)}
        <h3 className="mb-2 mt-4 text-sm font-medium text-muted">Features</h3>
        {chips(features)}
      </Section>
      <Section title={kind === "role" ? "Effective record access" : "Record access this set gives"}
        description={kind === "role" ? "What holders of this role can do with each object, after its permissions and rules. Fields with a rule are listed. Permission sets a member holds add to this."
          : "What this set gives by itself, per object. A member gets this together with their role and their other sets: the widest access wins."}>
        {access.isPending ? <Skeleton className="h-40" /> : access.error ? <ProblemView error={access.error} compact /> : (
          <SimpleTable label="Effective access" head={["Object", "Read", "Write", "Archive", "Limited fields", "Restricted values"]}>
            {access.data.data.objects.map((o) => (
              <tr key={o.object}>
                <td className="px-4 py-2 font-medium"><bdi>{plainLabel(labels.object(o.object))}</bdi>{o.rule ? <Badge className="ml-2" tone="accent">rule</Badge> : null}</td>
                <td className="px-4 py-2">{tri(o.read)}</td><td className="px-4 py-2">{tri(o.write)}</td><td className="px-4 py-2">{tri(o.archive)}</td>
                <td className="px-4 py-2 text-sm">{Object.entries(o.fields).map(([f, a]) => <span key={f} className="mr-2 inline-flex items-center gap-1">{a === "none" ? <Lock className="size-3" aria-hidden /> : null}<bdi>{plainLabel(labels.field(o.object, f))}</bdi>: {a === "none" ? "hidden" : a === "read" ? "read only" : a}</span>)}</td>
                <td className="px-4 py-2 text-sm">{o.restricted_fields.map((f) => `${plainLabel(labels.field(o.object, f.field))} (${f.values === "visible" ? "visible" : "hidden"})`).join(", ")}</td>
              </tr>
            ))}
          </SimpleTable>
        )}
      </Section>
      {editing ? <RoleEditor kind={kind} role={r} onClose={() => setEditing(false)} onSaved={() => {
        setEditing(false);
        void qc.invalidateQueries({ queryKey: ["admin"] });
      }} /> : null}
      <ConfirmDialog open={archiving} onOpenChange={setArchiving} danger busy={archive.isPending} confirmLabel={`Archive ${k.one}`} title={`Archive ${r.name}?`}
        description={`A ${k.one} can be archived only when no active member holds it.`} onConfirm={() => archive.mutate()} />
    </>
  );
}

const capFirst = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/** True for the permissions about records (objects and fields refine them); everything else is a feature. */
const isRecordPermission = (catalog: PermissionInfo[], key: string) =>
  (catalog.find((c) => c.key === key)?.category ?? (/^(records|restricted):/.test(key) ? "records" : "features")) === "records";

/** Labels for objects and fields by API name, from describe (the API name when it can't be read). */
function useSchemaLabels(objects: string[]) {
  const all = useObjects();
  const metas = useDescribes(objects);
  return useMemo(() => {
    const byObject = new Map((all.data ?? []).map((o) => [o.name, o.plural_label]));
    const fields = new Map<string, Map<string, string>>();
    for (const m of metas) if (m.data) fields.set(m.data.name, new Map(m.data.fields.map((f) => [f.name, f.label])));
    return {
      object: (o: string) => byObject.get(o) ?? o,
      field: (o: string, f: string) => fields.get(o)?.get(f) ?? f,
    };
    // describes' data identity changes when any describe loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all.data, metas.map((m) => m.dataUpdatedAt).join(",")]);
}

function useParamsSafe(): { roleId: string } {
  const p = useParams({ strict: false }) as { roleId?: string };
  return { roleId: p.roleId ?? "" };
}

type Allow = "inherit" | "allow" | "deny";
const toAllow = (v: boolean | null | undefined): Allow => (v === true ? "allow" : v === false ? "deny" : "inherit");
const fromAllow = (a: Allow) => (a === "allow" ? true : a === "deny" ? false : null);

/**
 * Create or change a custom role or a permission set, in its two areas: objects and fields (the record
 * permissions, which apply to every object, and rules per object and per field), and features (with what
 * a feature requires added for you).
 */
function RoleEditor({ kind, role, onClose, onSaved }: { kind: Kind; role?: Role; onClose: () => void; onSaved: (r: Role) => void }) {
  const k = KINDS[kind];
  const api = useApi();
  const perms = useAdmin<{ data: PermissionInfo[] }>(["permissions"], "/v1/permissions");
  const objects = useObjects();
  const metas = useDescribes((objects.data ?? []).map((o) => o.name));
  const [key, setKey] = useState(role?.key ?? "");
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<Set<string>>(new Set(role?.permissions ?? (kind === "role" ? ["records:read"] : [])));
  const [objectRules, setObjectRules] = useState<Record<string, RoleObjectRule>>(role?.objects ?? {});
  const [fieldRules, setFieldRules] = useState<Record<string, Record<string, "none" | "read">>>(role?.fields ?? {});
  const [openObject, setOpenObject] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const catalog = perms.data?.data ?? [];
  const metaByName = useMemo(() => new Map(metas.filter((m) => m.data).map((m) => [m.data!.name, m.data!])), [metas]);

  const toggle = (p: string, on: boolean) => {
    const next = new Set(permissions);
    if (on) {
      next.add(p);
      for (const req of catalog.find((c) => c.key === p)?.requires ?? []) next.add(req);
    } else next.delete(p);
    setPermissions(next);
  };
  const setRule = (o: string, a: keyof RoleObjectRule, v: Allow) => {
    const cur = objectRules[o] ?? { read: null, write: null, archive: null };
    const next = { ...cur, [a]: fromAllow(v) };
    const copy = { ...objectRules };
    if (next.read === null && next.write === null && next.archive === null) delete copy[o];
    else copy[o] = next;
    setObjectRules(copy);
  };
  const setField = (o: string, f: string, v: "follow" | "none" | "read") => {
    const cur = { ...(fieldRules[o] ?? {}) };
    if (v === "follow") delete cur[f]; else cur[f] = v;
    const copy = { ...fieldRules };
    if (Object.keys(cur).length) copy[o] = cur; else delete copy[o];
    setFieldRules(copy);
  };

  const permissionBox = (p: PermissionInfo) => (
    <label key={p.key} className="flex items-start gap-2 text-base">
      <Checkbox checked={permissions.has(p.key)} onCheckedChange={(v) => toggle(p.key, v === true)} className="mt-0.5" />
      <span><code className="font-mono text-sm">{p.key}</code><span className="block text-sm text-muted">{p.description}</span></span>
    </label>
  );

  const save = useMutation({
    mutationFn: async () => {
      // A PATCH changes only what it names: rules that were removed are sent as null.
      const objs: Record<string, RoleObjectRule | null> = { ...objectRules };
      for (const o of Object.keys(role?.objects ?? {})) if (!objs[o]) objs[o] = null;
      const fields: Record<string, Record<string, "none" | "read" | null> | null> = {};
      for (const o of new Set([...Object.keys(role?.fields ?? {}), ...Object.keys(fieldRules)])) {
        const now = fieldRules[o];
        if (!now) { fields[o] = null; continue; }
        const m: Record<string, "none" | "read" | null> = { ...now };
        for (const f of Object.keys(role?.fields?.[o] ?? {})) if (!(f in now)) m[f] = null;
        fields[o] = m;
      }
      const body = { name: name.trim(), description: description.trim() || undefined, permissions: [...permissions], objects: objs, fields };
      return role
        ? (await api.patch<{ data: Role }>(`${k.api}/${encodeURIComponent(role.key)}`, body)).data
        : (await api.post<{ data: Role }>(k.api, { key: key.trim(), ...body, objects: objectRules, fields: fieldRules })).data;
    },
    onSuccess: onSaved,
    onError: (e) => setError(asProblem(e).detail),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={role ? `Edit ${role.name}` : `New ${k.one}`} size="xl"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="role-form" busy={save.isPending} disabled={!name.trim() || (!role && !key.trim())}>Save {k.one}</Button></>}>
        <form id="role-form" className="grid gap-5" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          <div className="grid gap-3.5 sm:grid-cols-2">
            {role ? null : <FormField label="Key" required hint="2 to 40 lowercase letters, digits or underscores">{(p) => <Input {...p} value={key} pattern="[a-z][a-z0-9_]{1,39}" onChange={(e) => setKey(e.target.value)} autoFocus />}</FormField>}
            <FormField label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
            <FormField label="Description" className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
          </div>
          <fieldset>
            <legend className="mb-1 text-base font-medium">Objects and fields</legend>
            <p className="mb-2 text-sm text-muted">For every object{kind === "permission_set" ? " (leave these off to give access object by object below)" : ""}:</p>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              {catalog.filter((p) => isRecordPermission(catalog, p.key)).map(permissionBox)}
            </div>
            <p className="mb-2 text-sm text-muted">Per object and field (inherit follows the choices above):</p>
            {/* A focusable region, so the table can be scrolled sideways from the keyboard on a phone. */}
            <div className="overflow-x-auto rounded-md border border-line focus-visible:outline-2 focus-visible:outline-focus" role="region" aria-label="Object and field rules" tabIndex={0}>
              <table className="w-full min-w-[34rem] text-base">
                <thead className="bg-surface-2 text-sm text-muted"><tr><th scope="col" className="px-3 py-2 text-left font-medium">Object</th>{["Read", "Write", "Archive"].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left font-medium">{h}</th>)}<th scope="col" className="px-3 py-2 text-left font-medium">Fields</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {(objects.data ?? []).map((o) => {
                    const rule = objectRules[o.name];
                    const meta = metaByName.get(o.name);
                    const limited = Object.keys(fieldRules[o.name] ?? {}).length;
                    return (
                      <FragmentRows key={o.name} open={openObject === o.name} meta={meta} rules={fieldRules[o.name] ?? {}} onField={(f, v) => setField(o.name, f, v)}>
                        <tr>
                          <th scope="row" className="px-3 py-1.5 text-left font-medium">{o.label}</th>
                          {(["read", "write", "archive"] as const).map((a) => (
                            <td key={a} className="px-3 py-1.5">
                              <NativeSelect aria-label={`${o.label} ${a}`} className="h-7 w-28 text-sm" value={toAllow(rule?.[a])} onChange={(e) => setRule(o.name, a, e.target.value as Allow)}>
                                <option value="inherit">Inherit</option><option value="allow">Allow</option><option value="deny">Deny</option>
                              </NativeSelect>
                            </td>
                          ))}
                          <td className="px-3 py-1.5">
                            <Button size="sm" variant="ghost" aria-expanded={openObject === o.name} onClick={() => setOpenObject(openObject === o.name ? null : o.name)}>
                              {limited ? `${limited} limited` : "Limit fields"}
                            </Button>
                          </td>
                        </tr>
                      </FragmentRows>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-1 text-base font-medium">Features</legend>
            <p className="mb-2 text-sm text-muted">What holders can do in the CRM beyond records. Adding one also adds what it requires.</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.filter((p) => !isRecordPermission(catalog, p.key)).map(permissionBox)}
            </div>
            <p className="mt-2 text-sm text-subtle">{k.One}s that manage automations, webhooks, alerts or the schema must have unrestricted record access; the server says so if a rule conflicts.</p>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FragmentRows({ children, open, meta, rules, onField }: {
  children: React.ReactNode; open: boolean; meta: ObjectMeta | undefined; rules: Record<string, "none" | "read">; onField: (f: string, v: "follow" | "none" | "read") => void;
}) {
  return (
    <>
      {children}
      {open ? (
        <tr><td colSpan={5} className="bg-surface-2 px-3 py-2">
          {meta ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {meta.fields.map((f) => (
                <label key={f.name} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{f.label}</span>
                  <NativeSelect aria-label={`${meta.label} ${f.label} access`} className="h-7 w-32 text-sm" value={rules[f.name] ?? "follow"} onChange={(e) => onField(f.name, e.target.value as "follow" | "none" | "read")}>
                    <option value="follow">Follow object</option><option value="read">Read only</option><option value="none">Hidden</option>
                  </NativeSelect>
                </label>
              ))}
            </div>
          ) : <EmptyState title="Loading fields…" />}
        </td></tr>
      ) : null}
    </>
  );
}
