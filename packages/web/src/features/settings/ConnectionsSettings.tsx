import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Pencil, Plug, PlugZap, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Skeleton, Switch } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { Connection, ConnectionTest, ConnectionType } from "@/lib/api/types";
import { DocsLink } from "@/lib/docs";
import { formatDateTime, formatRelative } from "@/lib/format";
import { Section, useAdmin } from "./SettingsLayout";

const statusTone = (s: string) => (s === "active" ? "success" : s === "failing" ? "danger" : "neutral");
const TYPE_LABELS: Record<ConnectionType, string> = {
  static_token: "Token", oauth_client_credentials: "OAuth client credentials", oauth_refresh_token: "OAuth refresh token",
};

/**
 * Starting values for the systems the guides cover. A preset only fills in the form: the server sees an
 * ordinary connection and knows nothing about any vendor. YOUR-… parts must be replaced before saving.
 */
interface Preset {
  label: string; guide?: string; type: ConnectionType; key: string; base_url: string; token_url?: string; scope?: string;
  header_prefix?: string; test_path?: string; token_lifetime_minutes?: number; note?: string;
}
export const PRESETS: Record<string, Preset> = {
  custom: { label: "Another system", type: "static_token", key: "", base_url: "" },
  hubspot: { label: "HubSpot", guide: "integrations/hubspot.md", type: "static_token", key: "hubspot", base_url: "https://api.hubapi.com",
    test_path: "/crm/v3/objects/contacts?limit=1", note: "The token is a HubSpot service key, or the access token of a private app." },
  salesforce: { label: "Salesforce", guide: "integrations/salesforce.md", type: "oauth_client_credentials", key: "salesforce",
    base_url: "https://YOUR-DOMAIN.my.salesforce.com", token_url: "https://YOUR-DOMAIN.my.salesforce.com/services/oauth2/token",
    test_path: "/services/data/", token_lifetime_minutes: 30, note: "The client ID and secret are the consumer key and secret of an External Client App with the client credentials flow on." },
  dynamics: { label: "Microsoft Dynamics 365", type: "oauth_client_credentials", key: "dynamics", base_url: "https://YOUR-ORG.crm.dynamics.com/api/data/v9.2",
    token_url: "https://login.microsoftonline.com/YOUR-TENANT-ID/oauth2/v2.0/token", scope: "https://YOUR-ORG.crm.dynamics.com/.default", test_path: "/WhoAmI",
    note: "The client ID and secret come from a Microsoft Entra app registration that is an application user in the Dataverse environment." },
  zoho: { label: "Zoho CRM", type: "oauth_refresh_token", key: "zoho", base_url: "https://www.zohoapis.com/crm/v8", token_url: "https://accounts.zoho.com/oauth/v2/token",
    header_prefix: "Zoho-oauthtoken ", note: "Use your data centre's addresses (zohoapis.eu and accounts.zoho.eu in Europe, and so on). The refresh token comes from a Self Client in Zoho's API console." },
};

export function ConnectionsSettings() {
  const list = useAdmin<{ data: Connection[] }>(["connections"], "/v1/connections");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Section title="Connections"
        description={<>Stored credentials for calling other systems, such as the CRM you already use. An automation's HTTP step names a connection and gives a path; the credential is only ever sent to the connection's base URL. Secrets are encrypted and never shown again. Guides: <DocsLink page="integrations/hubspot.md">HubSpot</DocsLink>, <DocsLink page="integrations/salesforce.md">Salesforce</DocsLink>.</>}
        actions={<Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus /> New connection</Button>}>
        {list.isPending ? <Skeleton className="h-20" /> : list.error ? <ProblemView error={list.error} compact /> : list.data.data.length === 0 ? <p className="text-base text-muted">No connections yet.</p> : (
          <ul className="-m-4 divide-y divide-line">
            {list.data.data.map((c) => (
              <li key={c.id}>
                <Link to="/settings/connections/$connectionId" params={{ connectionId: c.id }} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <Plug className="size-4 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-medium">{c.name} <span className="font-mono text-sm font-normal text-muted">{c.key}</span></p>
                    <p className="truncate text-sm text-muted">{TYPE_LABELS[c.type]} · <span className="font-mono">{c.base_url}</span>{c.last_used_at ? ` · used ${formatRelative(c.last_used_at)}` : ""}</p>
                  </div>
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                  <ChevronRight className="size-4 text-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {creating ? <ConnectionDialog onClose={() => setCreating(false)} onSaved={(c) => {
        setCreating(false);
        void navigate({ to: "/settings/connections/$connectionId", params: { connectionId: c.id } });
      }} /> : null}
    </>
  );
}

const keyFrom = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "").slice(0, 40);

/** Creates a connection, or changes one. Secrets are typed here and nowhere shown again; left empty on a change, the stored ones stay. */
function ConnectionDialog({ current, onClose, onSaved }: { current?: Connection; onClose: () => void; onSaved: (c: Connection) => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const [preset, setPreset] = useState("custom");
  const [f, setF] = useState({
    name: current?.name ?? "", key: current?.key ?? "", type: current?.type ?? ("static_token" as ConnectionType), base_url: current?.base_url ?? "",
    token_url: current?.token_url ?? "", client_id: current?.client_id ?? "", scope: current?.scope ?? "", header_name: current?.header_name ?? "Authorization",
    header_prefix: current?.header_prefix ?? "Bearer ", test_path: current?.test_path ?? "", token_lifetime_minutes: String(current?.token_lifetime_minutes ?? 30),
  });
  const [keyTouched, setKeyTouched] = useState(Boolean(current));
  const [secret, setSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<typeof f>) => setF((prev) => ({ ...prev, ...patch }));
  const oauth = f.type !== "static_token";
  const p = PRESETS[preset]!;
  const choose = (name: string) => {
    const next = PRESETS[name]!;
    setPreset(name);
    setKeyTouched(name !== "custom");
    set({ name: name === "custom" ? "" : next.label, key: next.key, type: next.type, base_url: next.base_url, token_url: next.token_url ?? "", scope: next.scope ?? "",
      header_name: "Authorization", header_prefix: next.header_prefix ?? "Bearer ", test_path: next.test_path ?? "", token_lifetime_minutes: String(next.token_lifetime_minutes ?? 30) });
  };
  const unfilled = [f.base_url, f.token_url, f.scope].some((v) => v.includes("YOUR-"));
  const moved = Boolean(current) && (f.base_url.trim().replace(/\/+$/, "") !== current!.base_url || (oauth && f.token_url.trim() !== (current!.token_url ?? "")));
  const needsSecret = !current || moved;
  const ready = f.name.trim() && f.key && f.base_url.trim() && !unfilled && (!oauth || (f.token_url.trim() && f.client_id.trim()))
    && (!needsSecret || (secret && (f.type !== "oauth_refresh_token" || refreshToken)));
  const save = useMutation({
    // The request holds secrets: nothing of it stays in the mutation cache once the dialog is gone.
    gcTime: 0,
    mutationFn: () => {
      const body = {
        name: f.name.trim(), base_url: f.base_url.trim(), header_name: f.header_name.trim() || "Authorization", header_prefix: f.header_prefix,
        test_path: f.test_path.trim() || null,
        ...(oauth ? { token_url: f.token_url.trim(), client_id: f.client_id.trim(), scope: f.scope.trim() || null, token_lifetime_minutes: Number(f.token_lifetime_minutes) || 30 } : {}),
        ...(secret ? { secret } : {}), ...(refreshToken ? { refresh_token: refreshToken } : {}),
      };
      return current
        ? api.patch<{ data: Connection }>(`/v1/connections/${encodeURIComponent(current.id)}`, body)
        : api.post<{ data: Connection }>("/v1/connections", { ...body, key: f.key, type: f.type });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["admin"] });
      onSaved(r.data);
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  const secretLabel = f.type === "static_token" ? "Token" : "Client secret";
  const keep = current && !moved ? "Leave empty to keep the stored one." : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg" title={current ? `Change ${current.name}` : "New connection"}
        description="The credential is sent only to the base URL, in one header, by automations' HTTP steps."
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="connection-form" busy={save.isPending} disabled={!ready}>{current ? "Save" : "Create connection"}</Button></>}>
        <form id="connection-form" className="grid gap-3.5 sm:grid-cols-2" onSubmit={(e) => {
          e.preventDefault();
          if (ready) save.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg sm:col-span-2">{error}</p> : null}
          {current ? null : (
            <FormField label="Set up for" className="sm:col-span-2" hint={p.note ? <>{p.note}{p.guide ? <> <DocsLink page={p.guide}>Setup guide</DocsLink></> : null}</> : "Fills in the form below. You can change every value."}>
              {(a) => <NativeSelect {...a} value={preset} onChange={(e) => choose(e.target.value)}>{Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</NativeSelect>}
            </FormField>
          )}
          <FormField label="Name" required>{(a) => <Input {...a} autoFocus value={f.name} onChange={(e) => set({ name: e.target.value, ...(keyTouched ? {} : { key: keyFrom(e.target.value) }) })} />}</FormField>
          <FormField label="Key" required hint={current ? "Steps name the connection by this. It can't be changed." : "Steps name the connection by this: lowercase letters, digits and underscores."}>
            {(a) => <Input {...a} className="font-mono" disabled={Boolean(current)} value={f.key} onChange={(e) => {
              setKeyTouched(true);
              set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") });
            }} />}
          </FormField>
          {current ? null : (
            <FormField label="Type" className="sm:col-span-2">
              {(a) => <NativeSelect {...a} value={f.type} onChange={(e) => set({ type: e.target.value as ConnectionType })}>{Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</NativeSelect>}
            </FormField>
          )}
          <FormField label="Base URL" required className="sm:col-span-2" error={f.base_url.includes("YOUR-") ? "Replace the YOUR-… part with your own" : null}
            hint={moved ? "Changed: the secrets must be entered again, because a stored secret is never sent somewhere new." : "https:// and the host, with an optional path prefix. Steps give the rest of the path."}>
            {(a) => <Input {...a} type="url" className="font-mono" placeholder="https://api.example.com" value={f.base_url} onChange={(e) => set({ base_url: e.target.value })} />}
          </FormField>
          {oauth ? (
            <>
              <FormField label="Token URL" required className="sm:col-span-2" error={f.token_url.includes("YOUR-") ? "Replace the YOUR-… part with your own" : null}>
                {(a) => <Input {...a} type="url" className="font-mono" value={f.token_url} onChange={(e) => set({ token_url: e.target.value })} />}
              </FormField>
              <FormField label="Client ID" required>{(a) => <Input {...a} className="font-mono" autoComplete="off" value={f.client_id} onChange={(e) => set({ client_id: e.target.value })} />}</FormField>
              <FormField label="Scope" error={f.scope.includes("YOUR-") ? "Replace the YOUR-… part with your own" : null}>{(a) => <Input {...a} className="font-mono" value={f.scope} onChange={(e) => set({ scope: e.target.value })} />}</FormField>
            </>
          ) : null}
          <FormField label={secretLabel} required={needsSecret} hint={keep} className={f.type === "oauth_refresh_token" ? undefined : "sm:col-span-2"}>
            {(a) => <Input {...a} type="password" autoComplete="off" className="font-mono" value={secret} onChange={(e) => setSecret(e.target.value)} />}
          </FormField>
          {f.type === "oauth_refresh_token" ? (
            <FormField label="Refresh token" required={needsSecret} hint={keep}>
              {(a) => <Input {...a} type="password" autoComplete="off" className="font-mono" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} />}
            </FormField>
          ) : null}
          <FormField label="Header" hint="The header the credential goes in.">{(a) => <Input {...a} className="font-mono" value={f.header_name} onChange={(e) => set({ header_name: e.target.value })} />}</FormField>
          <FormField label="Prefix" hint="Written before the token, with its space.">{(a) => <Input {...a} className="font-mono" value={f.header_prefix} onChange={(e) => set({ header_prefix: e.target.value })} />}</FormField>
          <FormField label="Test path" hint="A path that answers a GET when the credential works." className={oauth ? undefined : "sm:col-span-2"}>
            {(a) => <Input {...a} className="font-mono" placeholder="/v1/me" value={f.test_path} onChange={(e) => set({ test_path: e.target.value })} />}
          </FormField>
          {oauth ? (
            <FormField label="Token lifetime (minutes)" hint="Used when the provider doesn't say how long a token lasts.">
              {(a) => <Input {...a} type="number" min={1} max={1440} value={f.token_lifetime_minutes} onChange={(e) => set({ token_lifetime_minutes: e.target.value })} />}
            </FormField>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** What a test found, in one sentence. */
export function describeTest(t: ConnectionTest): string {
  if (t.token && !t.token.ok) return t.token.error ?? "The token request failed";
  if (t.request && !t.request.ok) return `${t.token ? "A token was issued, but the test request failed: " : "The test request failed: "}${t.request.error ?? "no answer"}`;
  if (t.request) return `${t.token ? "A token was issued and the" : "The"} test request was answered with HTTP ${String(t.request.status)}.`;
  return t.token ? "A token was issued. Set a test path to check a request too." : t.note ?? "Nothing to test: set a test path.";
}

export function ConnectionDetail() {
  const { connectionId } = useParams({ strict: false }) as { connectionId?: string };
  const id = connectionId ?? "";
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const conn = useAdmin<{ data: Connection }>(["connection", id], `/v1/connections/${encodeURIComponent(id)}`);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/v1/connections/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e, "Couldn't change the connection"),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ data: ConnectionTest }>(`/v1/connections/${encodeURIComponent(id)}/test`),
    onSuccess: (r) => {
      setTested(r.data);
      void refresh();
    },
    onError: (e) => toast.error(e, "Couldn't test the connection"),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/v1/connections/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void refresh();
      toast.toast({ tone: "success", title: "Connection archived" });
      void navigate({ to: "/settings/connections" });
    },
    onError: (e) => {
      setDeleting(false);
      toast.error(e, "Couldn't archive the connection");
    },
  });
  if (conn.error) return <ProblemView error={conn.error} />;
  if (!conn.data) return <Skeleton className="h-64 max-w-4xl" />;
  const c = conn.data.data;
  const usedBy = c.used_by ?? [];
  const row = (label: string, value: React.ReactNode) => <div><dt className="text-sm text-muted">{label}</dt><dd className="break-all text-base">{value}</dd></div>;
  return (
    <>
      <Link to="/settings/connections" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Connections</Link>
      <Section title={c.name} description={<>Steps use it with <code className="font-mono">"connection": "{c.key}"</code> and a path as their URL.</>}
        actions={<>
          <Button size="sm" busy={test.isPending} onClick={() => test.mutate()}><PlugZap /> Test</Button>
          <Button size="sm" onClick={() => setEditing(true)}><Pencil /> Change…</Button>
          <Button size="sm" variant="danger-ghost" onClick={() => setDeleting(true)}><Trash2 /> Archive…</Button>
        </>}>
        {tested ? <p role="status" className={`mb-4 rounded-md border px-3 py-2 text-base ${tested.ok ? "border-line bg-surface-2" : "border-danger/40 bg-danger-soft text-danger-fg"}`}>{describeTest(tested)}</p> : null}
        {c.last_error ? <p className="mb-4 text-base text-danger-fg">Last token request failed{c.last_error_at ? ` (${formatRelative(c.last_error_at)})` : ""}: {c.last_error}.</p> : null}
        <dl className="grid gap-3 sm:grid-cols-2">
          {row("Status", <Badge tone={statusTone(c.status)}>{c.status}</Badge>)}
          <div><label className="flex items-center gap-2 text-base"><Switch checked={c.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Enabled" /> Enabled</label></div>
          {row("Type", TYPE_LABELS[c.type])}
          {row("Base URL", <span className="font-mono">{c.base_url}</span>)}
          {row("Header", <span className="font-mono">{c.header_name}: {c.header_prefix}…</span>)}
          {row(c.type === "static_token" ? "Token" : "Client secret", c.has_secret ? `Set ${c.secret_set_at ? formatDateTime(c.secret_set_at) : ""}. Not shown.` : "Not set")}
          {c.type !== "static_token" ? row("Token URL", <span className="font-mono">{c.token_url}</span>) : null}
          {c.type !== "static_token" ? row("Client ID", <span className="font-mono">{c.client_id}</span>) : null}
          {c.type !== "static_token" && c.scope ? row("Scope", <span className="font-mono">{c.scope}</span>) : null}
          {c.type === "oauth_refresh_token" ? row("Refresh token", c.has_refresh_token ? `Set ${c.refresh_token_set_at ? formatDateTime(c.refresh_token_set_at) : ""}. Not shown.` : "Not set") : null}
          {c.type !== "static_token" ? row("Access token", c.token_expires_at ? `Held until ${formatDateTime(c.token_expires_at)}` : "None held; one is fetched when a step needs it") : null}
          {row("Test path", c.test_path ? <span className="font-mono">{c.test_path}</span> : "None")}
          {row("Last used", c.last_used_at ? formatRelative(c.last_used_at) : "Never")}
        </dl>
      </Section>
      <Section title="Used by" description="Automations with a step that names this connection. Anyone who can manage automations can write such a step.">
        {usedBy.length === 0 ? <p className="text-base text-muted">No automation uses it yet.</p> : (
          <ul className="grid gap-1 text-base">{usedBy.map((a) => <li key={a.id}>{a.name} <span className="font-mono text-sm text-muted">{a.id}</span></li>)}</ul>
        )}
      </Section>
      {editing ? <ConnectionDialog current={c} onClose={() => setEditing(false)} onSaved={() => {
        setEditing(false);
        setTested(null);
      }} /> : null}
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} danger busy={remove.isPending} confirmLabel="Archive connection" title={`Archive ${c.name}?`}
        description={usedBy.length ? "Automations still use it, so this will be refused: change or archive them first." : "Its secrets are deleted. This can't be undone; a new connection can take the same key."}
        onConfirm={() => remove.mutate()} />
    </>
  );
}
