import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, LogOut } from "lucide-react";
import { useEffect, useState, type MouseEvent } from "react";
import { ProblemAlert, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { EmailLevel, NotificationPrefs, SessionRow, Severity } from "@/lib/api/types";
import { formatDateTime, formatRelative, roleLabel } from "@/lib/format";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { confirmMethods, useCapabilities } from "@/lib/signin";
import { ThemeCards } from "./account/ThemeCards";
import { TeamSetting } from "./account/TeamSetting";
import { AppsList } from "./ConnectedApps";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

const ANCHORS: [string, string][] = [
  ["profile", "Profile"], ["appearance", "Appearance"], ["team", "Your team"], ["password", "Password"], ["sessions", "Sessions"], ["connected-apps", "Connected apps"],
];

/** Personal settings as one page: an anchor list on the side, then a section per topic. */
export function AccountSettings() {
  const s = useSession();
  // Jump without touching the router's history; no smooth scrolling, so it is instant for everyone.
  const jump = (id: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView();
  };
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
      <nav aria-label="On this page" className="lg:sticky lg:top-4 lg:w-44 lg:shrink-0">
        <ul className="flex gap-1 overflow-x-auto lg:flex-col">
          {ANCHORS.map(([id, label]) => (
            <li key={id}><a href={`#${id}`} onClick={jump(id)} className="flex h-8 items-center whitespace-nowrap rounded-md px-2 text-base text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">{label}</a></li>
          ))}
          <li><Link to="/settings/notifications" className="flex h-8 items-center whitespace-nowrap rounded-md px-2 text-base text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-focus">Notifications</Link></li>
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <Section id="profile" title="Profile" description="Your name and email are set by a workspace admin.">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div><dt className="text-sm text-muted">Name</dt><dd>{s.member.name}</dd></div>
            <div><dt className="text-sm text-muted">Email</dt><dd className="break-all">{s.member.email}</dd></div>
            <div><dt className="text-sm text-muted">Role</dt><dd>{roleLabel(s.role)}</dd></div>
          </dl>
        </Section>
        <Section id="appearance" title="Appearance" description="Saved to your account, so it follows you to other browsers.">
          <ThemeCards />
        </Section>
        <Section id="team" title="Your team" description="Picks the Home you see first.">
          <TeamSetting />
        </Section>
        <PasswordSection />
        <SessionsSection />
        <ConnectedAppsSection />
      </div>
    </div>
  );
}

function PasswordSection() {
  const api = useApi();
  const qc = useQueryClient();
  const s = useSession();
  const caps = useCapabilities();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const recent = Date.now() - new Date(s.session.signed_in_at).getTime() < 10 * 60_000;
  const hasPassword = s.member.has_password !== false;
  const methods = confirmMethods(caps.data, s);
  const otherWays = [methods.emailCode ? "an emailed code" : null, methods.sso ? "single sign-on" : null].filter(Boolean).join(" or ");
  const set = useMutation({
    mutationFn: () => api.post<{ data: { other_sessions_revoked: number } }>("/v1/auth/password", { password: next, ...(current ? { current_password: current } : {}) }),
    onSuccess: (r) => {
      setCurrent(""); setNext(""); setAgain(""); setError(null);
      void qc.invalidateQueries({ queryKey: qk.session });
      toast.toast({ tone: "success", title: "Password saved", description: r.data.other_sessions_revoked ? `${r.data.other_sessions_revoked} other session(s) were signed out.` : undefined });
    },
    onError: (e) => setError(asProblem(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.request("DELETE", "/v1/auth/password", current ? { body: { current_password: current } } : {}),
    onSuccess: () => {
      setConfirmRemove(false);
      void qc.invalidateQueries({ queryKey: qk.session });
      toast.toast({ tone: "success", title: "Password removed", description: otherWays ? `Sign in with ${otherWays} from now on.` : "Sign in with a one-time link from whoever runs the server from now on." });
    },
    onError: (e) => {
      setConfirmRemove(false);
      setError(asProblem(e));
    },
  });
  if (!s.workspace.sign_in.password || caps.data?.methods.password === false) {
    return (
      <Section id="password" title="Password" description="Password sign-in is turned off here.">
        <p className="text-base text-muted">{otherWays ? `Sign in with ${otherWays}.` : "Sign in with a one-time link from whoever runs the server."}</p>
      </Section>
    );
  }
  return (
    <Section id="password" title="Password" description="12 to 256 characters. Setting or changing it signs out your other sessions.">
      {hasPassword ? null : (
        <div role="note" className="mb-4 flex max-w-md items-start gap-2 rounded-md border border-accent/40 bg-accent-soft/40 px-3 py-2 text-base">
          <KeyRound aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
          <span><strong className="font-medium">Set a password so you can sign in again.</strong> You don't have one yet{otherWays ? "" : ", and without it the only way back in is a new one-time link from whoever runs the server"}.</span>
        </div>
      )}
      <form className="grid max-w-md gap-3.5" onSubmit={(e) => {
        e.preventDefault();
        if (next !== again) return setError("The two new passwords don't match");
        set.mutate();
      }}>
        <ProblemAlert error={error} />
        {hasPassword ? (
          <FormField label="Current password" hint={recent ? "Not needed: you signed in within the last 10 minutes." : "Or leave it empty and confirm it's you another way when asked."}>
            {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </FormField>
        ) : null}
        <FormField label="New password">{(p) => <Input {...p} type="password" autoComplete="new-password" minLength={12} value={next} onChange={(e) => setNext(e.target.value)} />}</FormField>
        <FormField label="New password again">{(p) => <Input {...p} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />}</FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={set.isPending} disabled={next.length < 12}>Save password</Button>
          {hasPassword ? <Button variant="danger-ghost" onClick={() => setConfirmRemove(true)}>Remove password</Button> : null}
        </div>
      </form>
      <ConfirmDialog open={confirmRemove} onOpenChange={setConfirmRemove} danger busy={remove.isPending} confirmLabel="Remove password" title="Remove your password?"
        description={otherWays
          ? `You'll sign in with ${otherWays} instead. Your other sessions are signed out.`
          : "This server can't send sign-in emails and has no single sign-on, so without a password the only way back in is a one-time link printed on the server. Your other sessions are signed out."}
        onConfirm={() => remove.mutate()} />
    </Section>
  );
}

export function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function SessionsSection() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ data: SessionRow[] }>(["my-sessions"], "/v1/auth/sessions");
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "my-sessions"] });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/v1/sessions/${encodeURIComponent(id)}`),
    onSuccess: () => { void refresh(); toast.toast({ tone: "success", title: "Session signed out" }); },
    onError: (e) => toast.error(e),
  });
  const others = useMutation({
    mutationFn: () => api.post<{ revoked: number }>("/v1/auth/sessions/revoke-others"),
    onSuccess: (r) => { void refresh(); toast.toast({ tone: "success", title: `Signed out ${r.revoked} other session${r.revoked === 1 ? "" : "s"}` }); },
    onError: (e) => toast.error(e),
  });
  const list = q.data?.data ?? [];
  return (
    <Section id="sessions" title="Sessions" description="Browsers signed in as you. API keys are separate and keep working."
      actions={list.length > 1 ? <Button size="sm" busy={others.isPending} onClick={() => others.mutate()}><LogOut /> Sign out everywhere else</Button> : null}>
      {q.isPending ? <Skeleton className="h-16" /> : q.error ? <ProblemView error={q.error} compact /> : (
        <SimpleTable label="Your sessions" head={["Device", "Signed in", "Last active", "Ends", ""]}>
          {list.map((x) => (
            <tr key={x.id}>
              <td className="px-4 py-2">{describeAgent(x.user_agent)} {x.current ? <Badge tone="accent">This browser</Badge> : null}<div className="text-sm text-subtle">{x.client_address ?? ""} · {x.method.replace(/_/g, " ")}</div></td>
              <td className="px-4 py-2 text-sm">{formatDateTime(x.signed_in_at)}</td>
              <td className="px-4 py-2 text-sm">{formatRelative(x.last_seen_at)}</td>
              <td className="px-4 py-2 text-sm">{formatDateTime(x.expires_at)}</td>
              <td className="px-4 py-2 text-right">{x.current ? null : <Button size="sm" variant="danger-ghost" onClick={() => revoke.mutate(x.id)}>Sign out</Button>}</td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  );
}

/** Apps (Claude, ChatGPT, Cursor, …) this member connected to the MCP servers by signing in and approving. */
function ConnectedAppsSection() {
  const s = useSession();
  // From the session info: whether this server has OAuth for MCP on (no probing its discovery document).
  const off = s.server?.connected_apps === false;
  return (
    <Section id="connected-apps" title="Connected apps"
      description="AI assistants and other apps you approved to use the CRM's MCP servers as you. Disconnecting one stops its access at once.">
      {off ? (
        <p className="mb-3 text-base text-muted">Connecting apps over OAuth isn't turned on on this server (an operator sets <code>MCP_PUBLIC_URL</code>). Apps connected earlier are still listed until you disconnect them.</p>
      ) : !s.workspace.sign_in.oauth_apps ? (
        <p className="mb-3 text-base text-muted">This workspace doesn't allow connecting new apps; an owner can change that in Workspace sign-in.</p>
      ) : null}
      <AppsList listKey={["my-apps"]} listPath="/v1/auth/apps" revokePath={(id) => `/v1/auth/apps/${encodeURIComponent(id)}`} whose="Your"
        emptyText={off ? "None." : "To connect one, add this CRM's MCP server address as a connector in the app, then sign in and approve it."} />
    </Section>
  );
}

const LEVELS: [EmailLevel, string][] = [["immediate", "Right away"], ["digest", "Daily digest"], ["off", "Off"]];

export function NotificationSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ data: NotificationPrefs }>(["notification-prefs"], "/v1/me/notification-preferences");
  const [draft, setDraft] = useState<NotificationPrefs | null>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.data);
  }, [q.data, draft]);
  const save = useMutation({
    mutationFn: (p: NotificationPrefs) => api.patch<{ data: NotificationPrefs }>("/v1/me/notification-preferences", p),
    onSuccess: (r) => {
      setDraft(r.data);
      void qc.invalidateQueries({ queryKey: ["admin", "notification-prefs"] });
      toast.toast({ tone: "success", title: "Notification settings saved" });
    },
    onError: (e) => toast.error(e, "Couldn't save"),
  });
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  return (
    <Section title="Email notifications" description="Every notification reaches your inbox here; these settings decide which also arrive by email.">
      {q.isPending || !draft ? <Skeleton className="h-40" /> : q.error ? <ProblemView error={q.error} compact /> : (
        <form className="grid max-w-xl gap-4" onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft);
        }}>
          <div className="grid gap-3 sm:grid-cols-3">
            {(["critical", "warning", "info"] as Severity[]).map((sev) => (
              <FormField key={sev} label={sev.charAt(0).toUpperCase() + sev.slice(1)}>{(p) => (
                <NativeSelect {...p} value={draft.email[sev]} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, [sev]: e.target.value as EmailLevel } })}>
                  {LEVELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </NativeSelect>
              )}</FormField>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Digest hour">{(p) => (
              <NativeSelect {...p} value={draft.digest_hour} onChange={(e) => setDraft({ ...draft, digest_hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
              </NativeSelect>
            )}</FormField>
            <FormField label="Time zone">{(p) => (
              <NativeSelect {...p} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
                {[...new Set(["UTC", draft.timezone, ...zones])].map((z) => <option key={z} value={z}>{z}</option>)}
              </NativeSelect>
            )}</FormField>
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium text-muted">Quiet hours (critical alerts still come through)</legend>
            <label className="flex items-center gap-2 text-base">
              <input type="checkbox" checked={draft.quiet_hours !== null} onChange={(e) => setDraft({ ...draft, quiet_hours: e.target.checked ? { start: "22:00", end: "07:00" } : null })} className="size-4 accent-[var(--hl-accent)]" />
              Hold immediate email during quiet hours
            </label>
            {draft.quiet_hours ? (
              <div className="flex items-center gap-2">
                <Input aria-label="Quiet hours start" type="time" className="w-32" value={draft.quiet_hours.start} onChange={(e) => setDraft({ ...draft, quiet_hours: { ...draft.quiet_hours!, start: e.target.value } })} />
                <span className="text-muted">to</span>
                <Input aria-label="Quiet hours end" type="time" className="w-32" value={draft.quiet_hours.end} onChange={(e) => setDraft({ ...draft, quiet_hours: { ...draft.quiet_hours!, end: e.target.value } })} />
              </div>
            ) : null}
          </fieldset>
          <div><Button type="submit" variant="primary" busy={save.isPending}>Save</Button></div>
        </form>
      )}
    </Section>
  );
}
