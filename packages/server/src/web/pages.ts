/**
 * The built-in sign-in pages: plain server-rendered HTML with one same-origin stylesheet, no script
 * and no third-party assets. Templates only; the handlers are in web/handlers.ts. A web UI of your
 * own can replace all of this and call the JSON endpoints instead (docs/sign-in.md).
 *
 * Every value is escaped with `esc`. Error messages come from a fixed table keyed by error code, so
 * nothing from the query string is ever echoed into a page.
 */

export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"'`=]/g, (ch) => `&#${ch.charCodeAt(0)};`);

const ERRORS: Record<string, string> = {
  sign_in_failed: "Those details didn't match an account that can sign in here.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  invalid_code: "That code is not right. Check the email and try again.",
  expired: "This sign-in step has expired or was already used. Start again.",
  other_browser: "Open the link in the browser where you asked for the code, or type the code from the email there.",
  unavailable: "That way of signing in isn't available on this server.",
  provider_unavailable: "The single sign-on provider can't be reached. Try again later.",
  validation_failed: "That can't be used. Check what you entered and try again.",
  weak_password: "Choose another password: at least 12 characters, not easy to guess, and not containing your email or the workspace name.",
  current_password_wrong: "Your current password is not right.",
  recent_sign_in_required: "For this, sign in again first (or enter your current password).",
  password_sign_in_off: "Password sign-in is turned off for this workspace.",
  password_mismatch: "The two new passwords don't match.",
  password_locked: "Too many wrong passwords. Wait a while, or sign in again by email code and change it within 10 minutes.",
  csrf_failed: "The form expired or came from another site. Reload the page and try again.",
  busy: "The server is busy. Try again in a moment.",
  conflict: "Something changed meanwhile. Try again.",
};
export const errorText = (code: string | undefined | null): string | null => (code ? ERRORS[code] ?? "Something went wrong. Start again." : null);

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/auth/assets/style.css">
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
</body>
</html>`;
}

const alert = (code: string | undefined | null) => {
  const text = errorText(code);
  return text ? `<p class="error" role="alert">${esc(text)}</p>` : "";
};
const hidden = (name: string, value: string | null | undefined) => (value ? `<input type="hidden" name="${esc(name)}" value="${esc(value)}">` : "");

export interface SignInPageOptions { email: boolean; password: boolean; sso: string | null; returnTo: string | null; workspace?: string | null; error?: string | null }

export function signInPage(o: SignInPageOptions): string {
  const parts: string[] = [alert(o.error)];
  if (o.email) {
    parts.push(`<form method="post" action="/auth/email">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required maxlength="254" autofocus>
${hidden("return_to", o.returnTo)}${hidden("workspace", o.workspace)}
<button type="submit">Email me a sign-in code</button>
</form>`);
  }
  if (o.password) {
    parts.push(`<form method="post" action="/auth/password">
<h2>Or use your password</h2>
<label for="pw-email">Email</label>
<input id="pw-email" name="email" type="email" autocomplete="username" required maxlength="254">
<label for="pw">Password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" required maxlength="1024">
${hidden("return_to", o.returnTo)}${hidden("workspace", o.workspace)}
<button type="submit">Sign in</button>
<p class="hint">No password yet, or forgot it? Use the email code above, then set one.</p>
</form>`);
  }
  if (o.sso) {
    parts.push(`<form method="post" action="/auth/sso">
${hidden("return_to", o.returnTo)}${hidden("workspace", o.workspace)}
<button type="submit">Sign in with ${esc(o.sso)}</button>
</form>`);
  }
  if (!o.email && !o.password && !o.sso) {
    parts.push(`<p>Sign-in isn't set up on this server yet. An operator can print a one-time sign-in link with
<code>hl-crm-db-server sign-in-link --email you@example.com</code>.</p>`);
  }
  return layout("Sign in", parts.join("\n"));
}

export function codePage(error?: string | null): string {
  return layout("Check your email", `${alert(error)}
<p>If that address belongs to a member who can sign in here, we sent an 8-digit code and a link. They work once, for 10 minutes, in this browser.</p>
<form method="post" action="/auth/email/verify">
<label for="code">Sign-in code</label>
<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 \\-]{8,10}" required maxlength="10" autofocus>
<button type="submit">Sign in</button>
</form>
<p><a href="/auth/sign-in">Start again</a></p>`);
}

/** The page a sign-in link opens. Using the link takes a button press, so a mail scanner that fetches links can't use it up. */
export function linkPage(action: "/auth/email/link" | "/auth/server-link", token: string | null): string {
  if (!token) return errorPage("expired");
  return layout("Continue signing in", `<form method="post" action="${action}">
${hidden("token", token)}
<p>Continue to sign in${action === "/auth/email/link" ? " in this browser" : ""}.</p>
<button type="submit" autofocus>Continue</button>
</form>`);
}

/** `more`: the address belongs to more workspaces than are listed, so the page says how to name yours. */
export function choosePage(choice: { workspaces: { id: string; name: string }[]; more: boolean } | null, error?: string | null): string {
  if (!choice || (!choice.workspaces.length && !choice.more)) return errorPage(error ?? "expired");
  const options = choice.workspaces.map((w, i) => `<div class="choice">
<input type="radio" id="ws${i}" name="workspace" value="${esc(w.id)}"${i === 0 ? " checked" : ""}>
<label for="ws${i}">${esc(w.name)}</label>
</div>`).join("\n");
  const more = choice.more ? `<p class="hint">Your address belongs to more workspaces than are listed here. If yours isn't one of them,
ask its admin for the workspace ID (ws_…) and <a href="/auth/sign-in">sign in again</a> with <code>/auth/sign-in?workspace=ws_…</code>.</p>` : "";
  if (!choice.workspaces.length) return layout("Choose a workspace", `${alert(error)}\n${more}`);
  return layout("Choose a workspace", `${alert(error)}
<form method="post" action="/auth/choose">
<fieldset>
<legend>You are a member of several workspaces. Which one?</legend>
${options}
</fieldset>
<button type="submit">Continue</button>
</form>
${more}`);
}

export interface SignedInView { name: string; email: string; workspace: string; role: string; expiresAt: string; hasPassword: boolean; csrf: string; passwordAllowed: boolean;
  /** OAuth for MCP is on: link to the connected apps page. */
  apps?: boolean }

export function signedInPage(v: SignedInView): string {
  return layout("You're signed in", `<dl>
<dt>Signed in as</dt><dd>${esc(v.name)} (${esc(v.email)})</dd>
<dt>Workspace</dt><dd>${esc(v.workspace)}</dd>
<dt>Role</dt><dd>${esc(v.role)}</dd>
<dt>Session ends by</dt><dd><time datetime="${esc(v.expiresAt)}">${esc(v.expiresAt)}</time></dd>
</dl>
${v.apps ? `<p><a href="/auth/apps">Connected apps</a></p>` : ""}
${v.passwordAllowed || v.hasPassword ? `<p><a href="/auth/password">${v.hasPassword ? "Change or remove your password" : "Set a password"}</a></p>` : ""}
${signOutForm(v.csrf)}`);
}

const signOutForm = (csrf: string) => `<form method="post" action="/auth/sign-out">
${hidden("csrf_token", csrf)}
<button type="submit">Sign out</button>
</form>`;

export function passwordPage(o: { hasPassword: boolean; csrf: string; allowed: boolean; error?: string | null; done?: boolean }): string {
  const current = o.hasPassword ? `<label for="current">Current password <span class="hint">(not needed if you signed in within the last 10 minutes)</span></label>
<input id="current" name="current_password" type="password" autocomplete="current-password" maxlength="1024">` : "";
  const set = o.allowed ? `<form method="post" action="/auth/password/set">
${hidden("csrf_token", o.csrf)}
${current}
<label for="new">New password</label>
<input id="new" name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256" aria-describedby="rules">
<p id="rules" class="hint">At least 12 characters, not easy to guess, and not containing your email or the workspace name. A few unrelated words make a good one.</p>
<label for="again">New password again</label>
<input id="again" name="password_again" type="password" autocomplete="new-password" required minlength="12" maxlength="256">
<button type="submit">${o.hasPassword ? "Change password" : "Set password"}</button>
</form>` : `<p>Password sign-in is turned off for this workspace.</p>`;
  const remove = o.hasPassword ? `<form method="post" action="/auth/password/remove">
<h2>Remove your password</h2>
${hidden("csrf_token", o.csrf)}
<label for="current-rm">Current password <span class="hint">(not needed if you signed in within the last 10 minutes)</span></label>
<input id="current-rm" name="current_password" type="password" autocomplete="current-password" maxlength="1024">
<button type="submit">Remove password</button>
</form>` : "";
  return layout(o.hasPassword ? "Your password" : "Set a password", `${alert(o.error)}
${o.done ? `<p class="ok" role="status">Saved. Your other sessions were signed out.</p>` : ""}
${set}
${remove}
<p><a href="/auth/signed-in">Back</a></p>`);
}

export const signedOutPage = () => layout("You're signed out", `<p>Your session has ended.</p>
<p><a href="/auth/sign-in">Sign in again</a></p>`);

export function errorPage(code: string | null | undefined): string {
  return layout("Sign-in problem", `${alert(code ?? "expired")}
<p><a href="/auth/sign-in">Back to sign in</a></p>`);
}

// --- OAuth for MCP (ADR 0010) ----------------------------------------------------------------------

const OAUTH_ERRORS: Record<string, string> = {
  invalid_client: "This app isn't known to this server, or its description couldn't be checked. Nothing was shared with it.",
  invalid_redirect_uri: "This app asked to be sent somewhere it didn't register. Nothing was shared with it, and you weren't sent anywhere.",
  invalid_request: "The connection request isn't valid. Start again from the app.",
  unsupported_response_type: "The app asked for something this server doesn't do. Start again from the app.",
  invalid_target: "The app asked for an MCP server this server doesn't have.",
  invalid_scope: "The app asked for access this server doesn't offer.",
  consent_required: "This server always asks you to approve an app, and the app asked not to be shown anything.",
  temporarily_unavailable: "This can't be done right now. Try again in a few minutes.",
  rate_limited: "Too many connection attempts. Wait a few minutes and try again.",
  unavailable: "Connecting apps isn't turned on for this server.",
  csrf_failed: "The form expired or came from another site. Start again from the app.",
  too_long: "The connection request is too long to continue through sign-in. Start again from the app.",
  too_many_apps: "You have too many connected apps. Disconnect some on the connected apps page, then try again.",
};

/**
 * An authorization problem. `back` is the app's redirect URI with error, state and iss: offered as a
 * link, never followed automatically, so this origin can't be used to bounce a browser to whatever
 * site registered a client (RFC 9700 §4.11.2). Redirects happen only after the member chose.
 */
export function oauthErrorPage(code: string, detail?: string | null, back?: { href: string; host: string } | null): string {
  return layout("Can't connect this app", `<p class="error" role="alert">${esc(OAUTH_ERRORS[code] ?? OAUTH_ERRORS.invalid_request)}</p>
${detail ? `<p class="hint">${esc(detail)}</p>` : ""}
${back ? `<p><a href="${esc(back.href)}" rel="noreferrer">Return to the app at ${esc(back.host)}</a></p>` : `<p><a href="/auth/signed-in">Back to your account</a></p>`}`);
}

export interface ConsentView {
  clientName: string;
  clientId: string;
  /** "metadata_document": described by a document at its client ID URL; "registered": registered itself here, unverified. */
  clientKind: "registered" | "metadata_document";
  redirectHost: string;
  loopback: boolean;
  resourceName: "ops" | "admin";
  resourceUrl: string;
  scopes: { scope: string; text: string }[];
  dropped: { scope: string; why: string }[];
  blocked: string | null;
  /** Approving needs a fresh sign-in: link to sign in again and come back. */
  signInAgain: string | null;
  member: { name: string; email: string };
  workspace: string;
  csrf: string;
  params: Record<string, string>;
}

/**
 * The consent page. It names the app, says how sure we are of that name, shows where the browser
 * will be sent and what the app could do, in plain words. The decision is a form post carrying the
 * session's CSRF token and the request's parameters, which are validated again on the way in.
 */
export function consentPage(v: ConsentView): string {
  const fields = Object.entries(v.params).map(([k, val]) => hidden(k, val)).join("");
  const who = v.clientKind === "metadata_document"
    ? `<p>This app is described by a document at <code>${esc(v.clientId)}</code>, so its name was published by whoever controls <strong>${esc(hostOf(v.clientId))}</strong>.</p>`
    : `<p class="error">This app registered itself with this server a moment ago. Nothing proves who made it or that its name is true. Only continue if you started connecting it yourself, just now.</p>`;
  const local = v.loopback ? `<p class="error">This app receives access on your own computer (<code>${esc(v.redirectHost)}</code>). Only continue if you just started connecting from a program running on this computer.</p>` : "";
  // The site that receives the code is the one being trusted; a document on one host naming another as its redirect is allowed, but said plainly.
  const elsewhere = v.clientKind === "metadata_document" && !v.loopback && hostOf(v.clientId) !== v.redirectHost
    ? `<p class="error" role="alert">The app is described at <strong>${esc(hostOf(v.clientId))}</strong>, but access would be sent to a different site, <strong>${esc(v.redirectHost)}</strong>. Its name proves nothing about that site. Only continue if you trust <strong>${esc(v.redirectHost)}</strong>.</p>`
    : "";
  const dropped = v.dropped.length ? `<p class="hint">Not granted: ${v.dropped.map((d) => `<code>${esc(d.scope)}</code> (${esc(d.why)})`).join(", ")}.</p>` : "";
  const scopes = v.scopes.length ? `<ul>${v.scopes.map((s) => `<li>${esc(s.text)} <span class="hint">(<code>${esc(s.scope)}</code>)</span></li>`).join("")}</ul>` : "";
  const can = !v.blocked && !v.signInAgain;
  return layout(`Connect ${v.clientName}?`, `<p>Access would be sent to <strong>${esc(v.redirectHost)}</strong>.</p>
${who}
${elsewhere}${local}
<dl>
<dt>App</dt><dd>${esc(v.clientName)}</dd>
<dt>After you decide, you go to</dt><dd><strong>${esc(v.redirectHost)}</strong></dd>
<dt>It would reach</dt><dd>The ${v.resourceName} MCP server (<code>${esc(v.resourceUrl)}</code>)</dd>
<dt>As</dt><dd>${esc(v.member.name)} (${esc(v.member.email)}) in ${esc(v.workspace)}</dd>
</dl>
${v.blocked ? `<p class="error" role="alert">${esc(v.blocked)}</p>` : `<h2>It could</h2>\n${scopes}\n<p class="hint">Always within what your role allows now: if your role changes, so does what the app can do.</p>`}
${dropped}
${v.signInAgain ? `<p class="error" role="alert">Giving an app the admin scope needs a sign-in in the last 10 minutes. <a href="${esc(v.signInAgain)}">Sign in again</a> and you'll come back here.</p>` : ""}
<form method="post" action="/oauth/authorize">
${hidden("csrf_token", v.csrf)}${fields}
${can ? `<button type="submit" name="decision" value="approve">Allow</button>\n` : ""}<button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
</form>
<p class="hint">You can disconnect it at any time on <a href="/auth/apps">Connected apps</a>.</p>`);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export interface AppView { id: string; name: string; kind: string; redirectHost: string; scopes: string[]; resource: string; createdAt: string; lastUsedAt: string | null }

export function appsPage(apps: AppView[], csrf: string, done?: boolean): string {
  const rows = apps.map((a) => `<li>
<strong>${esc(a.name)}</strong> ${a.kind === "registered" ? `<span class="hint">(registered itself; unverified)</span>` : ""}<br>
<span class="hint">Sends to ${esc(a.redirectHost)}; ${esc(a.resource)}; scopes ${a.scopes.map((s) => `<code>${esc(s)}</code>`).join(" ")}<br>
Connected <time datetime="${esc(a.createdAt)}">${esc(a.createdAt)}</time>; last used ${a.lastUsedAt ? `<time datetime="${esc(a.lastUsedAt)}">${esc(a.lastUsedAt)}</time>` : "never"}</span>
<form method="post" action="/auth/apps/revoke">
${hidden("csrf_token", csrf)}${hidden("app", a.id)}
<button type="submit" class="secondary">Disconnect</button>
</form>
</li>`).join("\n");
  return layout("Connected apps", `${done ? `<p class="ok" role="status">Disconnected. Its tokens no longer work.</p>` : ""}
${apps.length ? `<ul class="apps">\n${rows}\n</ul>` : "<p>No apps are connected.</p>"}
<p><a href="/auth/signed-in">Back</a></p>`);
}

export const STYLE = `:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --line: #c8c8cc; --accent: #2a5bd7; --on-accent: #fff; --err: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececf0; --bg: #17171a; --line: #4a4a52; --accent: #8fb0ff; --on-accent: #111; --err: #ff8a80; } }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 26rem; margin: 3rem auto; padding: 0 1rem; }
h1 { font-size: 1.5rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
form { margin: 1.25rem 0; }
label { display: block; margin: .75rem 0 .25rem; font-weight: 600; }
input[type=email], input[type=password], input[inputmode=numeric] { box-sizing: border-box; width: 100%; padding: .55rem .6rem; font: inherit;
  border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
button { margin-top: 1rem; padding: .55rem 1rem; font: inherit; border: 0; border-radius: 6px; background: var(--accent); color: var(--on-accent); cursor: pointer; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
fieldset { border: 1px solid var(--line); border-radius: 6px; } .choice label { display: inline; font-weight: 400; }
.error { color: var(--err); font-weight: 600; } .ok { font-weight: 600; } .hint { font-size: .9rem; font-weight: 400; opacity: .8; }
dt { font-weight: 600; } dd { margin: 0 0 .5rem; }
button.secondary { background: transparent; color: var(--fg); border: 1px solid var(--line); margin-left: .5rem; }
ul.apps { padding-left: 1.1rem; } ul.apps li { margin-bottom: 1.25rem; } ul.apps form { margin: .25rem 0; } ul.apps button { margin: .25rem 0 0; }
code { overflow-wrap: anywhere; }
`;
