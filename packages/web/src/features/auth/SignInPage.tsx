import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Building2, KeyRound, LogIn, Mail } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import { asProblem, type ApiProblem } from "@/lib/api/problem";
import type { SessionInfo, SignInAnswer } from "@/lib/api/types";
import { anyMethod, confirmMethods, useCapabilities } from "@/lib/signin";
import { SignInLinkSteps } from "@/features/shell/FirstRun";
import appRoutes from "@/app-routes.json";

/**
 * The app's own sign-in screens, using the server's JSON sign-in endpoints (/auth/…): password, an
 * emailed code, or single sign-on, then the workspace choice when an email belongs to several. Links
 * from email and from `sign-in-link` go through the server's own pages and land back in the app.
 */

/** Server pages a sign-in may come back to, besides the app's own: OAuth consent and the connected-apps page. */
const SERVER_RETURNS = new Set(["/oauth/authorize", "/auth/apps"]);
const APP_ROUTES = new Set(appRoutes.routes.map((r) => r.slice(1)));

/**
 * Where to go after signing in: a path on this origin only, never the server's built-in signed-in page.
 * Besides the app's pages, the OAuth consent page (an MCP client's authorization request, which sent a
 * signed-out browser here) and the server's connected-apps page. Every caller leaves with a full page
 * load (location.assign/replace), never client routing, so a server page is reached as one.
 */
export function safeReturn(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048 || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || [...raw].some((c) => c.charCodeAt(0) < 0x20)) return "/";
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return "/";
    // An app page (its top-level segment is one of the app's routes, as the server decides), or one of the server pages above.
    const first = u.pathname.slice(1).split("/")[0]!.toLowerCase();
    const appPage = (first === "" ? u.pathname === "/" : APP_ROUTES.has(first)) && first !== "sign-in" && first !== "signed-out";
    if (!appPage && !SERVER_RETURNS.has(u.pathname)) return "/";
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return "/";
  }
}

function Card({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-start justify-center bg-bg px-4 py-12 sm:items-center">
      <main className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="size-8" />
          <span className="text-lg font-semibold">hl-crm-db</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-md">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? <p className="mt-1 text-base text-muted">{subtitle}</p> : null}
          <div className="mt-5">{children}</div>
        </div>
      </main>
    </div>
  );
}

function errorText(p: ApiProblem): string {
  if (p.code === "sign_in_failed") return "That email and password don't match a member who can sign in here.";
  if (p.status === 429) return `Too many attempts. ${p.retryAfter ? `Try again in ${Math.ceil(p.retryAfter / 60)} minute(s).` : "Wait a little and try again."}`;
  return p.detail;
}

type Step = { kind: "start" } | { kind: "code"; email: string } | { kind: "choose"; workspaces: { id: string; name: string }[]; more: boolean };

export function SignInPage() {
  const api = useApi();
  const search = useSearch({ from: "/sign-in" });
  const returnTo = safeReturn(search.return_to);
  const caps = useCapabilities();
  // Already signed in (a second tab, a back button): go straight on. Unless the person was sent here to
  // confirm it's them (reauth=1): then the methods show anyway, for the same member and workspace.
  const reauth = search.reauth === "1";
  const existing = useQuery({
    queryKey: ["auth", "existing"],
    queryFn: ({ signal }) => api.get<SessionInfo>("/v1/auth/session", undefined, signal),
    retry: false,
    staleTime: 0,
  });
  const confirming = reauth && Boolean(existing.data);
  useEffect(() => {
    if (existing.data && !reauth) window.location.replace(returnTo);
  }, [existing.data, returnTo, reauth]);

  const [step, setStep] = useState<Step>({ kind: "start" });
  const knownEmail = confirming ? existing.data!.member.email : null;
  const [typedEmail, setEmail] = useState<string | null>(null);
  const email = typedEmail ?? knownEmail ?? "";
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const finish = (a: SignInAnswer) => {
    if (a.status === "signed_in") {
      window.location.assign(returnTo);
      return;
    }
    if (a.status === "choose_workspace") setStep({ kind: "choose", workspaces: a.workspaces, more: Boolean(a.more_workspaces) });
    if (a.status === "redirect") window.location.assign(a.redirect_url);
  };

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(asProblem(e)));
    } finally {
      setBusy(null);
    }
  };

  const workspaceId = confirming ? existing.data!.workspace.id : search.workspace;
  const withWorkspace = workspaceId ? { workspace: workspaceId } : {};
  const signInPassword = (e: FormEvent) => {
    e.preventDefault();
    void run("password", async () => finish(await api.post<SignInAnswer>("/auth/password", { email, password, return_to: returnTo, ...withWorkspace })));
  };
  const sendCode = () => void run("code", async () => {
    await api.post<SignInAnswer>("/auth/email", { email, return_to: returnTo, ...withWorkspace });
    setNotice(`If ${email} belongs to a member here, a code and a link are on their way. They work once, for 10 minutes, in this browser.`);
    setStep({ kind: "code", email });
  });
  const verify = (e: FormEvent) => {
    e.preventDefault();
    void run("verify", async () => finish(await api.post<SignInAnswer>("/auth/email/verify", { code: code.replace(/\D/g, "") })));
  };
  const sso = () => void run("sso", async () => finish(await api.post<SignInAnswer>("/auth/sso", { return_to: returnTo, ...withWorkspace })));
  const choose = (id: string) => void run(id, async () => finish(await api.post<SignInAnswer>("/auth/choose", { workspace: id })));

  if (caps.isPending || existing.isPending || (existing.data && !reauth)) {
    return <Card title="Sign in"><div className="flex flex-col gap-3" aria-busy="true"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8 w-24" /></div></Card>;
  }
  if (caps.error) return <Card title="Sign in"><ProblemView error={caps.error} onRetry={() => caps.refetch()} /></Card>;
  const c = caps.data;
  if (!c.enabled) {
    return (
      <Card title="Sign-in is off on this server">
        <p className="text-base text-muted">People sign in only when the server has <code className="font-mono">PUBLIC_URL</code> set. Ask whoever runs it, or use an API key with the API or the <code className="font-mono">crm</code> command-line tool.</p>
      </Card>
    );
  }
  const errorBox = error ? <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null;
  // Confirming it's them: only what can work for this member (a password they have, email, single sign-on).
  const m = confirming ? confirmMethods(c, existing.data) : { password: c.methods.password, emailCode: c.methods.email_code, sso: Boolean(c.methods.sso) };

  if (step.kind === "code") {
    return (
      <Card title="Check your email" subtitle={notice}>
        {errorBox}
        <form onSubmit={verify} className="flex flex-col gap-4">
          <FormField label={`${c.code_length}-digit code`}>
            {(p) => <Input {...p} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus className="tabular tracking-widest" />}
          </FormField>
          <Button type="submit" variant="primary" size="lg" busy={busy === "verify"} disabled={code.replace(/\D/g, "").length < c.code_length}>Sign in</Button>
          <Button variant="link" onClick={() => setStep({ kind: "start" })} className="self-start"><ArrowLeft className="size-3.5" /> Use another email</Button>
        </form>
      </Card>
    );
  }

  if (step.kind === "choose") {
    return (
      <Card title="Choose a workspace" subtitle="This email belongs to members of several workspaces.">
        {errorBox}
        <ul className="flex flex-col gap-2">
          {step.workspaces.map((w) => (
            <li key={w.id}>
              <Button className="w-full justify-start" size="lg" busy={busy === w.id} onClick={() => choose(w.id)}>
                <Building2 /> <span className="truncate">{w.name}</span>
              </Button>
            </li>
          ))}
        </ul>
        {step.more ? <p className="mt-3 text-sm text-muted">There are more workspaces than shown. To sign in to another, use a sign-in address with its workspace ID (<code className="font-mono">/sign-in?workspace=ws_…</code>).</p> : null}
      </Card>
    );
  }

  if (confirming && !anyMethod(m)) {
    return (
      <Card title="Confirm it's you" subtitle={<>Sign in again as <strong className="font-medium text-fg">{knownEmail}</strong> to carry on.</>}>
        <SignInLinkSteps session={existing.data!} returnTo={returnTo} />
        <a href={returnTo} className="mt-4 inline-block text-sm text-muted hover:text-fg"><ArrowLeft className="mr-1 inline size-3.5" />Not now: go back</a>
      </Card>
    );
  }
  return (
    <Card title={confirming ? "Confirm it's you" : "Sign in"}
      subtitle={confirming ? <>Sign in again as <strong className="font-medium text-fg">{knownEmail}</strong> to carry on. You'll come back to where you were.</> : "Use the email your workspace added you with."}>
      {errorBox}
      {m.sso && c.methods.sso ? (
        <>
          <Button className="w-full" size="lg" onClick={sso} busy={busy === "sso"}><LogIn /> Continue with {c.methods.sso.name}</Button>
          {m.password || m.emailCode ? <div className="my-4 flex items-center gap-3 text-sm text-subtle"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div> : null}
        </>
      ) : null}
      {m.password || m.emailCode ? (
        <form onSubmit={m.password ? signInPassword : (e) => {
          e.preventDefault();
          sendCode();
        }} className="flex flex-col gap-4">
          <FormField label="Email">
            {(p) => <Input {...p} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!confirming} readOnly={confirming} />}
          </FormField>
          {m.password ? (
            <FormField label="Password">
              {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={confirming} />}
            </FormField>
          ) : null}
          {m.password ? <Button type="submit" variant="primary" size="lg" busy={busy === "password"} disabled={!email || !password}><KeyRound /> Sign in</Button> : null}
          {m.emailCode ? (
            <Button type={m.password ? "button" : "submit"} variant={m.password ? "secondary" : "primary"} size="lg" busy={busy === "code"} disabled={!email}
              onClick={m.password ? sendCode : undefined}>
              <Mail /> Email me a sign-in code
            </Button>
          ) : null}
        </form>
      ) : null}
      {!anyMethod(m) ? (
        <p className="text-base text-muted">This server offers no sign-in method yet. Whoever runs it can print you a one-time sign-in link with <code className="font-mono">docker compose run --rm api sign-in-link --email you@example.com</code>.</p>
      ) : null}
      {!confirming && m.password && !m.emailCode ? (
        <p className="mt-4 text-sm text-subtle">
          No password yet? Whoever runs this server can print you a one-time sign-in link (if that's you: <code className="font-mono">docker compose run --rm api sign-in-link --email you@example.com</code>). Once you're in, set a password when the app offers it.
        </p>
      ) : null}
      {!confirming && c.sign_up ? (
        <p className="mt-4 text-sm text-subtle">
          New here? <a href={`/auth/sign-up?return_to=${encodeURIComponent(returnTo)}`} className="text-fg underline underline-offset-2 hover:no-underline">Create a workspace</a>
        </p>
      ) : null}
      {confirming ? <a href={returnTo} className="mt-4 inline-block text-sm text-muted hover:text-fg"><ArrowLeft className="mr-1 inline size-3.5" />Not now: go back</a> : null}
    </Card>
  );
}

export function SignedOutPage() {
  return (
    <Card title="You're signed out" subtitle="Your session on this device has ended.">
      <Button asChild variant="primary" size="lg" className="w-full"><Link to="/sign-in" search={{}}><LogIn /> Sign in again</Link></Button>
    </Card>
  );
}
