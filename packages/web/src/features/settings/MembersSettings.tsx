import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, MoreHorizontal, Plug, Plus, ShieldPlus, UserCheck, UserX } from "lucide-react";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Avatar } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Checkbox, Skeleton, Switch } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { MemberUser, Members, Role, ServiceAccount, SessionRow } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { describeAgent } from "./AccountSettings";
import { AppsList } from "./ConnectedApps";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

export function useRoles() {
  return useAdmin<{ data: Role[] }>(["roles"], "/v1/roles");
}

/** Whose permission sets are being edited: a member or a service account (they are changed on different routes). */
type SetsTarget = { id: string; name: string; permission_sets?: string[]; kind: "members" | "service-accounts" };

/** Members: add (optionally emailing an invitation), change role, disable or re-enable, see and end their sessions. */
export function MembersSettings() {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const members = useAdmin<{ data: Members }>(["members"], "/v1/members");
  const roles = useRoles();
  const sets = useAdmin<{ data: Role[] }>(["permission-sets"], "/v1/permission-sets");
  const [setsOf, setSetsOf] = useState<SetsTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const [sessionsOf, setSessionsOf] = useState<MemberUser | null>(null);
  const [appsOf, setAppsOf] = useState<MemberUser | null>(null);
  const [disabling, setDisabling] = useState<MemberUser | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "members"] });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { role?: string; active?: boolean } }) => api.patch(`/v1/members/${encodeURIComponent(id)}`, body),
    onSuccess: (_r, v) => {
      void refresh();
      setDisabling(null);
      toast.toast({ tone: "success", title: v.body.role ? "Role changed" : v.body.active ? "Member re-enabled" : "Member disabled" });
    },
    onError: (e) => toast.error(e, "Couldn't change the member"),
  });
  const roleOptions = (roles.data?.data ?? []).filter((r) => !r.archived_at);
  const setOptions = (sets.data?.data ?? []).filter((r) => !r.archived_at);
  const setName = (key: string) => setOptions.find((x) => x.key === key)?.name ?? key;
  /** The sets a member holds, as a button that opens the dialog to change them (plain text for yourself: nobody changes their own). */
  const setsCell = (m: MemberUser | ServiceAccount, kind: SetsTarget["kind"], locked: boolean) => {
    const held = m.permission_sets ?? [];
    const text = held.length ? held.map(setName).join(", ") : "None";
    return locked ? <span className="text-sm text-muted">{text}</span> : (
      <Button size="sm" variant="ghost" aria-label={`Permission sets of ${m.name}: ${text}`} onClick={() => setSetsOf({ id: m.id, name: m.name, permission_sets: held, kind })}>
        <ShieldPlus /> <span className="max-w-48 truncate">{text}</span>
      </Button>
    );
  };
  return (
    <>
      <Section title="Members" description="People who can sign in to this workspace. Service accounts (for integrations) are listed below."
        actions={<Button size="sm" variant="primary" onClick={() => setAdding(true)}><Plus /> Add member</Button>}>
        {members.isPending ? <Skeleton className="h-24" /> : members.error ? <ProblemView error={members.error} onRetry={() => members.refetch()} compact /> : (
          <SimpleTable label="Members" head={["Member", "Role", "Permission sets", "Sign-in", "Status", ""]}>
            {members.data.data.users.map((m) => {
              const self = m.id === s.member.id;
              return (
                <tr key={m.id}>
                  <td className="px-4 py-2"><div className="flex items-center gap-2"><Avatar name={m.name} className="size-7 text-xs" /><div className="min-w-0"><p className="truncate font-medium">{m.name}{self ? <span className="text-subtle"> (you)</span> : null}</p><p className="truncate text-sm text-muted">{m.email}</p></div></div></td>
                  <td className="px-4 py-2">
                    <NativeSelect aria-label={`Role of ${m.name}`} className="h-7 w-40" value={m.role} disabled={self || !m.active || update.isPending}
                      onChange={(e) => update.mutate({ id: m.id, body: { role: e.target.value } })}>
                      {roleOptions.some((r) => r.key === m.role) ? null : <option value={m.role}>{m.role_name}</option>}
                      {roleOptions.map((r) => <option key={r.id} value={r.key}>{r.name}</option>)}
                    </NativeSelect>
                  </td>
                  <td className="px-4 py-2">{setsCell(m, "members", self || !m.active)}</td>
                  <td className="px-4 py-2 text-sm text-muted">
                    {m.sign_in?.last_sign_in_at ? `Last ${formatRelative(m.sign_in.last_sign_in_at)}` : "Never signed in"}
                    {m.sign_in ? <span className="block">{[m.sign_in.has_password && "password", m.sign_in.sso_linked && "SSO", `${m.sign_in.active_sessions} session${m.sign_in.active_sessions === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span> : null}
                  </td>
                  <td className="px-4 py-2">{m.active ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>}</td>
                  <td className="px-4 py-2 text-right">
                    {self ? null : (
                      <Menu>
                        <MenuTrigger asChild><Button size="icon-sm" variant="subtle" aria-label={`Actions for ${m.name}`}><MoreHorizontal /></Button></MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem onSelect={() => setSessionsOf(m)}><LogOut /> Sessions…</MenuItem>
                          <MenuItem onSelect={() => setAppsOf(m)}><Plug /> Connected apps…</MenuItem>
                          {m.active ? <MenuItem danger onSelect={() => setDisabling(m)}><UserX /> Disable…</MenuItem>
                            : <MenuItem onSelect={() => update.mutate({ id: m.id, body: { active: true } })}><UserCheck /> Re-enable</MenuItem>}
                        </MenuContent>
                      </Menu>
                    )}
                  </td>
                </tr>
              );
            })}
          </SimpleTable>
        )}
      </Section>
      {members.data?.data.service_accounts.length ? (
        <Section title="Service accounts" description="Integrations and agents. They use API keys and never sign in.">
          <SimpleTable label="Service accounts" head={["Name", "Role", "Permission sets", "Status"]}>
            {members.data.data.service_accounts.map((a) => (
              <tr key={a.id}><td className="px-4 py-2 font-medium">{a.name}</td><td className="px-4 py-2">{a.role_name ?? a.role}</td><td className="px-4 py-2">{setsCell(a, "service-accounts", !a.active)}</td><td className="px-4 py-2">{a.active ? <Badge tone="success">Active</Badge> : <Badge>Disabled</Badge>}</td></tr>
            ))}
          </SimpleTable>
        </Section>
      ) : null}
      {adding ? <AddMemberDialog roles={roleOptions} onClose={() => setAdding(false)} onAdded={() => {
        setAdding(false);
        void refresh();
      }} /> : null}
      {setsOf ? <MemberSetsDialog target={setsOf} sets={setOptions} onClose={() => setSetsOf(null)} onSaved={() => {
        setSetsOf(null);
        void refresh();
      }} /> : null}
      {appsOf ? <MemberAppsDialog member={appsOf} onClose={() => setAppsOf(null)} /> : null}
      {sessionsOf ? <MemberSessionsDialog member={sessionsOf} onClose={() => setSessionsOf(null)} onChanged={refresh} /> : null}
      <ConfirmDialog open={disabling !== null} onOpenChange={(o) => !o && setDisabling(null)} danger busy={update.isPending} confirmLabel="Disable member"
        title={`Disable ${disabling?.name ?? ""}?`} description="They are signed out everywhere and every API key they hold is revoked. Re-enabling them doesn't bring the keys back."
        onConfirm={() => disabling && update.mutate({ id: disabling.id, body: { active: false } })} />
    </>
  );
}

function AddMemberDialog({ roles, onClose, onAdded }: { roles: Role[]; onClose: () => void; onAdded: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [invite, setInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post("/v1/members", { email: email.trim(), name: name.trim(), role, ...(invite ? { send_invite: true } : {}) }),
    onSuccess: () => {
      toast.toast({ tone: "success", title: `${name} added`, description: invite ? "An invitation email is on its way." : "They can sign in with their email." });
      onAdded();
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Add a member" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="add-member" busy={add.isPending} disabled={!email || !name}>Add member</Button></>}>
        <form id="add-member" className="grid gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          <FormField label="Name" required>{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <FormField label="Email" required>{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</FormField>
          <FormField label="Role" hint="You can grant only roles whose permissions you hold.">{(p) => (
            <NativeSelect {...p} value={role} onChange={(e) => setRole(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.key}>{r.name}</option>)}</NativeSelect>
          )}</FormField>
          <label className="flex items-center gap-3 text-base"><Switch checked={invite} onCheckedChange={setInvite} /> Email them an invitation</label>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Choose the permission sets a member holds on top of their role. Saving sends the whole list. */
function MemberSetsDialog({ target, sets, onClose, onSaved }: { target: SetsTarget; sets: Role[]; onClose: () => void; onSaved: () => void }) {
  const api = useApi();
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set(target.permission_sets ?? []));
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch(`/v1/${target.kind}/${encodeURIComponent(target.id)}`, { permission_sets: [...chosen] }),
    onSuccess: () => {
      toast.toast({ tone: "success", title: `Permission sets of ${target.name} changed` });
      onSaved();
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  const toggle = (key: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(key); else next.delete(key);
    setChosen(next);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Permission sets of ${target.name}`} description="Each set adds to what their role allows. You can give only sets whose permissions and record access you hold yourself."
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={save.isPending} onClick={() => {
          setError(null);
          save.mutate();
        }}>Save</Button></>}>
        {error ? <p role="alert" className="mb-3 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
        {sets.length === 0 ? <p className="text-base text-muted">There are no permission sets yet. Create one in Settings, under Permission sets.</p> : (
          <ul className="grid gap-2.5">
            {sets.map((x) => (
              <li key={x.id}>
                <label className="flex items-start gap-2 text-base">
                  <Checkbox checked={chosen.has(x.key)} onCheckedChange={(v) => toggle(x.key, v === true)} className="mt-0.5" />
                  <span>{x.name}<span className="block text-sm text-muted">{x.description || `${x.permissions.length} permission${x.permissions.length === 1 ? "" : "s"}`}</span></span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MemberSessionsDialog({ member, onClose, onChanged }: { member: MemberUser; onClose: () => void; onChanged: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ data: SessionRow[] }>(["member-sessions", member.id], `/v1/members/${encodeURIComponent(member.id)}/sessions`);
  const revokeAll = useMutation({
    mutationFn: () => api.post<{ data: { revoked: number } }>(`/v1/members/${encodeURIComponent(member.id)}/sessions/revoke`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin", "member-sessions", member.id] });
      onChanged();
      toast.toast({ tone: "success", title: `Signed ${member.name} out of ${r.data.revoked} session${r.data.revoked === 1 ? "" : "s"}` });
    },
    onError: (e) => toast.error(e),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${member.name}'s sessions`} description="Browsers signed in as this member. Their API keys are separate." size="lg"
        footer={<><Button onClick={onClose}>Close</Button><Button variant="danger" busy={revokeAll.isPending} disabled={!q.data?.data.length} onClick={() => revokeAll.mutate()}><LogOut /> Sign out everywhere</Button></>}>
        {q.isPending ? <Skeleton className="h-16" /> : q.error ? <ProblemView error={q.error} compact /> : q.data.data.length === 0 ? <p className="text-base text-muted">No live sessions.</p> : (
          <ul className="divide-y divide-line">
            {q.data.data.map((x) => <li key={x.id} className="py-2 text-base">{describeAgent(x.user_agent)}<span className="block text-sm text-muted">{x.client_address ?? "unknown address"} · signed in {formatDateTime(x.signed_in_at)} · active {formatRelative(x.last_seen_at)}</span></li>)}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A member's connected apps (OAuth, for the MCP servers), for an admin with members:manage: see and disconnect. */
function MemberAppsDialog({ member, onClose }: { member: MemberUser; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`${member.name}'s connected apps`} description="Apps this member approved to use the MCP servers as them. Disconnecting one stops its access at once." size="lg"
        footer={<Button onClick={onClose}>Close</Button>}>
        <div className="px-4 py-4">
          <AppsList listKey={["member-apps", member.id]} listPath="/v1/apps" query={{ member: member.id }} revokePath={(id) => `/v1/apps/${encodeURIComponent(id)}`}
            whose={`${member.name}'s`} emptyText="This member hasn't connected any app." />
        </div>
      </DialogContent>
    </Dialog>
  );
}
