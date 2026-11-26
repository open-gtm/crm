# Signing in people

API keys are for machines: scripts, integrations, agents and the `crm` CLI. People sign in from a browser instead, and get a session. This page covers how people sign in, the settings, the rules for anyone building their own front end against the API, and what is limited and audited. Why it is built this way is in [ADR 0009](decisions/0009-people-sign-in-and-sessions.md).

The server ships a few plain sign-in pages under `/auth/…`, and serves the web UI ([`packages/web`](../packages/web/README.md)) when it is built: the app has its own sign-in screens at `/sign-in` that use the JSON endpoints below, and a sign-in that names no `return_to` lands in the app. Without the UI (`WEB_UI=false`, or an API-only build), the built-in pages only show who you are and let you set a password, see your connected apps or sign out. A front end of your own can use the same session through the API; the web UI is a working example of the rules below.

## Who can sign in

Only existing, active members. By default nobody can sign up: no sign-in method creates a member or a workspace. An admin adds people with `POST /v1/members` (or `crm members add`), and the operator makes workspaces with `bootstrap`. Service accounts never sign in; they use keys.

An operator can let people create a workspace of their own from the sign-in page: see [Creating a workspace](#creating-a-workspace-self-sign-up). It is off unless `SIGN_UP=true`.

A member is a row per workspace, so the same email can be a member of several workspaces. A person proves who they are once, then picks the workspace. Each session belongs to one workspace. With one match there is no extra step.

**Email addresses.** A member's email must be printable ASCII with no spaces or control characters; anything else is refused with `422` when a member or workspace is created. Internationalized addresses (non-ASCII local parts or domains) are not supported yet, because sign-in can't safely tell apart addresses whose letters fold into each other (the Kelvin sign `K` and `k`, dotted capital `İ` and `i`). Sign-in matches an email in one canonical form: surrounding whitespace trimmed and only `A`–`Z` lowercased, computed the same way in the database (`app.canonical_email`) and in the server, never by the database locale's case rules. Rows created before this rule that hold non-ASCII addresses keep working, matched only by that canonical form.

**Lots of workspaces.** At most 20 memberships are looked up per sign-in, members stored with exactly the typed address first, then by workspace. When an address belongs to more, the workspace choice says so (`more_workspaces: true` in JSON), and the person can name their workspace: every sign-in request takes an optional `workspace` (`ws_…`), and `/auth/sign-in?workspace=ws_…` carries it through the built-in forms. Disabled members are never looked up.

## Ways to sign in

| Method | Needs | Notes |
|---|---|---|
| Email code or link | `PUBLIC_URL`, `SMTP_URL` | An 8-digit code and a link, both single-use, valid 10 minutes, and only in the browser that asked |
| Password | `PASSWORD_SIGN_IN` on (the default), and the workspace allowing it | A member has no password until they set one after signing in another way |
| Single sign-on (OpenID Connect) | `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | One provider per server. Matches existing members by verified email, then remembers the provider's subject |
| Server-printed link | Shell access to the server | For the first owner before email works, or any time email isn't an option. Valid 15 minutes, single-use |

`GET /auth/capabilities` says which methods this server offers. It reveals nothing about any account or workspace:

```json
{ "enabled": true, "methods": { "email_code": true, "password": true, "sso": { "name": "Okta", "start": "/auth/sso" } }, "code_length": 8, "sign_up": false }
```

### Email code and link

The person enters their email. The answer is always the same ("if this email belongs to a member, a code is on its way"), and the browser gets a short-lived pre-session cookie. If the email belongs to an active member, the server sends an email with the code and a link.

**A code proves the address it was sent to, and nothing else.** Every message goes to an address exactly as it is stored, and its code and link sign in only the memberships stored with exactly that address. When the typed address matches members stored with different spellings (`alice@…` in one workspace, `ALICE@…` in another), each spelling gets its own message with its own code, the typed spelling first, at most three; none of them unlocks the others. So an admin who adds a variant of your address to their workspace receives, at most, a code for their own workspace. Audit entries for an attempt (`auth.code_sent`, `auth.sign_in_failed`) go only to the workspaces whose members were sent a message.

- **The code** is typed into the same browser. Five wrong codes void it.
- **The link** must be opened in the same browser too. Opening it shows a page with a Continue button; only pressing it signs in, so a mail scanner that fetches links can't use the link up. A link opened in another browser does nothing, and the person is told to use the browser where they asked, or to type the code there. This is the safer choice: an intercepted or forwarded email is not enough to sign in.
- Links are built from `PUBLIC_URL`, never from the request's Host header.
- Without `SMTP_URL` this method is reported as unavailable and refused; it never pretends to send.

### Password

People set a password while signed in, on `/auth/password` or with `POST /v1/auth/password`. Rules: 12 to 256 characters, no composition rules; passwords that are easy to guess, and passwords containing the email's local part or the workspace name, are refused. How easy a password is to guess is estimated on the server by [zxcvbn-ts](https://github.com/zxcvbn-ts/zxcvbn), using dictionaries that ship with it, so nothing is sent anywhere. It spots common passwords, words and names, dates, keyboard runs, repeats and l33t spellings, and also tries the email and workspace name; a password rated below 3 of 4 is refused. `PASSWORD_MIN_STRENGTH` changes that bar: 4 also refuses a word with a year and punctuation (`Summer2026!!!`) and short phrases, and 0 turns the estimate off. With `PASSWORD_BREACH_CHECK=true`, new passwords are also checked against the Have I Been Pwned range API: only the first 5 characters of the password's SHA-1 leave the server. It is off by default because it calls a third party; if the service can't be reached, the password is accepted and a warning logged.

- **A first password** needs no current one while the sign-in is recent. The web UI offers it as soon as a member without one signs in by a server-printed link (a welcome step, skippable), and afterwards as a dismissible card on Home (the dismissal is the per-member preference `hint.set_password.dismissed`) and a note in Settings → Account that stays until a password is set. It never offers one where the server or the workspace turned passwords off.
- **Changing or removing** a password needs the current password, or a sign-in within the last 10 minutes.
- **Reset** is: sign in with an email code (or SSO, or a server link), then set a new password. No separate reset flow, no reset tokens.
- **Every change ends the member's other sessions.**
- **Storage:** argon2id at 19 MiB, 2 passes, 1 lane (Node's built-in `crypto.argon2`, Node 24.7.0 or later), as a self-describing string. Where argon2 isn't available at runtime, scrypt (N=2^17, r=8, p=1). A sign-in with a hash made under older parameters stores a new one.
- **Turning it off:** `PASSWORD_SIGN_IN=false` turns password sign-in off for the server. An owner can turn it off for one workspace with `PATCH /v1/workspace/sign-in {"password": false}`. Either way, existing hashes stay but aren't used.
- **A password proves one membership.** With the same email in several workspaces, a password signs in only where it matches.

### Single sign-on

One OpenID Connect provider, set by `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`. Register this redirect URI with the provider, exactly:

```
<PUBLIC_URL>/auth/sso/callback
```

The server uses the authorization code flow with PKCE (S256), `state` and `nonce`, all bound to the browser. It checks the ID token's signature against the provider's published keys, the issuer (it must equal the discovery document's, which must equal `OIDC_ISSUER`), the audience, `azp` when present (required when there are several audiences), expiry and the nonce. The provider must say `email_verified: true`. The verified email is matched, in its canonical form, to existing active members. On the first sign-in the provider's subject is stored for the member, and later sign-ins match by subject first, so a changed email at the provider can't make someone else's account theirs. A member already linked to a different subject is not matched by email.

**What single sign-on trusts.** It trusts the configured provider to verify email addresses. A provider that lets someone claim an address they don't own lets them into every workspace on this server where that address is a member and SSO is allowed. So:

- **Per workspace, the owner decides.** `PATCH /v1/workspace/sign-in {"sso": false}` turns SSO off for the workspace, and `{"sso_allowed_domains": ["example.com"]}` accepts only those email domains there (on top of the server-wide `OIDC_ALLOWED_DOMAINS`, which it can only narrow; `[]` clears it). SSO is on by default, so on a server with one workspace, configuring the provider is all it takes.
- **Checked every time.** The server's and the workspace's domain lists and the workspace's switch apply to every SSO sign-in, including members already linked by subject, against the email the provider reports now.
- **Unlinking.** A member removes their own link with `DELETE /v1/auth/sso` (from a session, after a sign-in in the last 10 minutes); an admin with `members:manage` removes a member's with `DELETE /v1/members/{id}/sso` (an owner's only by an owner, never someone holding permissions you don't). Both are audited (`auth.sso_unlinked`). A later SSO sign-in whose verified email matches the member links them again, unless the workspace turned SSO off or narrowed its domains.
- `GET /v1/members` and `GET /v1/access-review` show who is linked (`sign_in.sso_linked`).

The sign-in page's Content-Security-Policy allows its SSO form to reach both the issuer's origin and the authorization endpoint's (from discovery), so providers whose authorization endpoint is on another host (AWS Cognito, for example) work in browsers that apply `form-action` to redirects.

Requests to the provider (discovery, keys, token) go through the same outbound guard as webhooks: https only (unless `OIDC_ALLOW_INSECURE_ISSUER=true`, for an internal provider), private and metadata addresses refused, DNS pinned, 8-second timeout, 64 KB per response.

### Server-printed link

On the server (or in its container):

```sh
docker compose run --rm api sign-in-link --email you@example.com [--workspace ws_…] [--return-to /settings/api-keys]
# outside Docker Compose:
hl-crm-db-server sign-in-link --email you@example.com [--workspace ws_…] [--return-to /settings/api-keys]
```

It prints one link and nothing else to stdout (a short note goes to stderr). The link works once, for 15 minutes, in any browser: it is not bound to a browser because it is delivered out of band, which is why its life is short. Treat it like a password until it is used. It works without email, and creating it is audited (`auth.sign_in_link_created`). `bootstrap` prints this command, in both forms, for the new owner, and says to set a password once signed in.

- **`--return-to`** is where the link lands once used: a path on this server, checked with the same rule as every sign-in's `return_to` (below). A value the rule would change or refuse makes the command fail, rather than quietly landing somewhere else. Without it, the link lands in the app.
- **In a browser that is already signed in**, the link works too: the new session's cookie replaces the old one in that browser (the old session is left to expire, as after any sign-in). That is how someone with no password, no email and no single sign-on confirms it's them (below).
- **Errors** (no `PUBLIC_URL`, an unknown email, a bad option) are one plain line on stderr and exit code 1, as for every server command; only an unexpected failure is logged with its stack trace.

### Confirming it's you

Creating or rotating an API key, changing a password without the current one and unlinking single sign-on need a sign-in in the last 10 minutes (`403 recent_sign_in_required` otherwise). The web UI then shows "Confirm it's you", offering only what can work for this member right now: it reads `GET /auth/capabilities` and the session info (`member.has_password`, the workspace's `sign_in`):

- **a password the member has**, in the dialog itself: once confirmed, the action goes ahead;
- **an emailed code or single sign-on**, if the server has them, on the sign-in page (`/sign-in?reauth=1&return_to=…`), which comes back to the page;
- **none of those** (a fresh self-hosted install: no password yet, no `SMTP_URL`, no SSO): the exact command to print a new link, with the member's email, workspace and `--return-to` the current page, for example `docker compose run --rm api sign-in-link --email you@example.com --workspace ws_… --return-to /settings/api-keys`, and, for someone who doesn't run the server, to ask whoever does for a new link. Opening that link in the same browser (another tab is fine) lands on the page again; the dialog, if still open, notices the new recent session and the action carries on.

The return path travels in the link itself (`--return-to`, stored with the link on the server), not in browser storage, so it works whichever tab or window opens the link.

## Creating a workspace (self sign-up)

Off by default. With `SIGN_UP=true`, anyone who can prove an email address can create a workspace and becomes its owner. It needs `PUBLIC_URL` and `SMTP_URL`; with either missing the server refuses to start. `GET /auth/capabilities` says `"sign_up": true` when it is on and email works. Why it is built this way is in [ADR 0018](decisions/0018-self-sign-up.md).

Turning it on makes the server a public service: read [Limits](#limits) and set `TRUST_PROXY` if the server is behind a reverse proxy, or every visitor counts as one client address.

1. On the sign-in page, **Create a workspace** opens `/auth/sign-up`. The person enters their email and gets an 8-digit code, valid once, for 10 minutes, in that browser.
2. They enter the code. Nothing has been created yet. They have 30 minutes for the next step.
3. They name the workspace (and, optionally, themselves and a currency; the default is USD). The workspace is created, they are its owner, and they are signed in.

- **It keeps where the person was going.** `return_to` is carried from the first step to the last, so someone sent here by an app's connection request ([OAuth for MCP](mcp/oauth.md#a-new-person-connecting-from-claude)) lands back on its consent page. With none, they land in the app.
- **No API keys are made.** `bootstrap` prints two keys to the operator's terminal; a web page is no place to show a secret once. The owner creates keys in the app (Settings → API keys) when they need one.
- **An address that already has an account can still create another workspace,** up to `SIGN_UP_MAX_WORKSPACES_PER_EMAIL` (3). The naming page lists the workspaces the address already belongs to and offers sign-in instead. The workspaces are separate: different members, records and audit logs. Sign-in then asks which one.
- **`SIGN_UP_ALLOWED_DOMAINS`** (comma-separated, for example `example.com,example.org`) limits sign-up to addresses at those domains. Anyone else is told so (`403 sign_up_domain`) and gets no email. Subdomains are not included.
- **Everything else is as after `bootstrap`:** the standard objects, the default pipeline, the system roles. Other people are still added by an admin.

Not built: a CAPTCHA, blocking disposable email domains, signing up through single sign-on, and deleting a workspace.

## Sessions

A session is a row in Postgres. The browser holds only a random 256-bit token in an HttpOnly cookie; the database holds its SHA-256. No token is ever given to page scripts.

- **Lifetime:** idle timeout `SESSION_IDLE_TIMEOUT_MINUTES` (default 720, 12 hours) and absolute timeout `SESSION_ABSOLUTE_TIMEOUT_HOURS` (default 168, 7 days). Both are enforced on the server. Activity extends the idle timeout at most once a minute, never past the absolute one.
- **Every sign-in is a new session.** Nothing from before sign-in becomes the session.
- **A session is the member with their whole role.** Permissions, object and field rules are read on every request, as for a key, so a role change takes effect on the next request. A session is not narrowed by scopes the way a key is: it holds every scope its role can use.
- **Ending it:** sign out (`POST /v1/auth/sign-out`, or the button on `/auth/signed-in`), revoke one of your own from a session (`DELETE /v1/sessions/{id}`), revoke all your others (`POST /v1/auth/sessions/revoke-others`). An API key ends sessions only through `members:manage`. Admins with `members:manage` list a member's sessions (`GET /v1/members/{id}/sessions`, with client address and user agent) and end them (`POST /v1/members/{id}/sessions/revoke`, or `DELETE /v1/sessions/{id}`), under the same rules as changing a member (an owner's only by an owner, never someone holding permissions you don't), for listing as for revoking. A session you may not act on gets the same `404` as one that doesn't exist. `crm sessions list|revoke` does the same from the CLI.
- **API keys outlive sessions.** A key made from a session is a separate credential: signing out, "revoke others", a password change and an admin's session revoke leave it working. Revoke keys separately (`POST /v1/api-keys/{id}/revoke`); the access review lists every key. Creating or rotating a key from a session needs a sign-in in the last 10 minutes.
- **Disabling a member** ends all their sessions in the same transaction that revokes their keys and disconnects their apps. Changing or removing a password ends the member's other sessions.

## Connected apps

With OAuth for MCP turned on ([`docs/mcp/oauth.md`](mcp/oauth.md)), an MCP client such as Claude or ChatGPT sends you to `/oauth/authorize`. Without a session it sends you to sign in first, with the request as `return_to`, and you come back to a consent page naming the app, where it will send you, what it could do and as whom. Approving `admin` needs a sign-in in the last 10 minutes. The app then acts as you, within your role, on one MCP server only.

- `/auth/apps` (linked from `/auth/signed-in`) lists your connected apps with a Disconnect button, as does the web UI under Settings → Account, which learns whether connecting apps is on from the session (`server.connected_apps`). `GET /v1/auth/apps` and `DELETE /v1/auth/apps/{id}` do the same from your own front end (session only).
- **Signing out everywhere** (`POST /v1/auth/sessions/revoke-others`, or an admin's `POST /v1/members/{id}/sessions/revoke`) also disconnects every app, because the apps act as you. A password change doesn't disconnect them, as it doesn't revoke API keys.
- An owner can turn connecting apps off for the workspace (which disconnects every app) or limit the scopes apps may get: `PATCH /v1/workspace/sign-in {"oauth_apps": false}` or `{"oauth_scopes": ["ops:read", "ops:write"]}`.
- **Cleanup:** the worker deletes sessions a day after they end, and expired sign-in steps, every hour.

## Building your own front end

Serve it from the same origin as the API (`PUBLIC_URL`). The rules:

**Cookies.** The session cookie is `__Host-hlcrm_session` (`Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`). During sign-in a second cookie, `__Host-hlcrm_signin`, binds the steps to the browser. With `PUBLIC_URL=http://localhost:…` (local development only) they are named `hlcrm_session` and `hlcrm_signin` and are not `Secure`; plain http on any other host is refused at startup.

**Credentials.** Send no `Authorization` header from the browser. If a request has one, it is treated as an API key request and the cookie is ignored, even if the key is invalid.

**CSRF.** Every request that isn't `GET`, `HEAD` or `OPTIONS` and is authenticated by the cookie must:

1. carry `X-CSRF-Token` with the session's token, from `GET /v1/auth/session` (`csrf_token`) or the sign-in response. It is bound to the session: another session's token doesn't work. It is never put in a URL.
2. come with `Origin` equal to `PUBLIC_URL`. A missing or `null` Origin is refused (the one exception, for the built-in pages' own form posts, is below).
3. if the browser sends `Sec-Fetch-Site`, have it be `same-origin`.

A refusal is `403` with code `csrf_failed`. `GET` routes don't change state. (Two write audit entries: CSV export and revealing a webhook secret.) API key requests are not affected by any of this.

**Signing in from your own page.** Each endpoint takes JSON (and answers JSON) or a form post (and answers with a redirect to the next built-in page). They need the same `Origin` and `Sec-Fetch-Site` as above.

| Request | Body | Answer |
|---|---|---|
| `POST /auth/email` | `email`, optional `return_to`, optional `workspace` | `202 {"status": "code_sent"}`, always |
| `POST /auth/email/verify` | `code` | `signed_in` or `choose_workspace` |
| `POST /auth/email/link` | `token` (from the emailed link) | `signed_in` or `choose_workspace` |
| `POST /auth/password` | `email`, `password`, optional `return_to`, optional `workspace` | `signed_in`, `choose_workspace`, or `401 sign_in_failed` |
| `POST /auth/sso` | optional `return_to`, optional `workspace` | `{"status": "redirect", "redirect_url": …}`: send the browser there |
| `GET /auth/sso/callback` | (from the provider) | redirect to `return_to`, `/auth/choose` or `/auth/error` |
| `POST /auth/server-link` | `token` | `signed_in` or `choose_workspace` |
| `POST /auth/choose` | `workspace` (`ws_…`) | `signed_in` |
| `POST /auth/sign-up` | `email`, optional `return_to` | `202 {"status": "code_sent"}`, always; `403 sign_up_domain` for an address outside `SIGN_UP_ALLOWED_DOMAINS`; `404` when sign-up is off |
| `POST /auth/sign-up/verify` | `code` | `{"status": "name_workspace"}` |
| `POST /auth/sign-up/workspace` | `workspace_name`, optional `name`, optional `currency` | `signed_in`; `409 sign_up_cap` or `429 sign_up_limited` (the step can be tried again) |

`signed_in` sets the session cookie and returns `workspace`, `return_to`, `csrf_token`, `expires_at` and `idle_expires_at`. `choose_workspace` returns the workspaces (ID and name only), and `more_workspaces: true` when the address belongs to more than are listed; the choice works once, for 5 minutes, in this browser. `workspace` (`ws_…`) looks in that workspace only. `return_to` must be a path on this origin of at most 2,048 characters (long enough for an OAuth authorization request): it is checked before and after normalisation, dot segments (`/./`, `/../`, also percent-encoded) are refused, and anything doubtful becomes `/auth/signed-in`.

**Session endpoints** (session only; API keys are refused): `GET /v1/auth/session` (who is signed in, with `member.has_password` and `member.sso_linked`; the workspace and its sign-in settings; role and permissions; the CSRF token; and `server.connected_apps`, whether this server has OAuth for MCP on, so a front end needn't probe for it), `POST /v1/auth/sign-out` (also sends `Clear-Site-Data: "cookies", "storage"`), `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke-others`, `POST /v1/auth/password` (`password`, optional `current_password`), `DELETE /v1/auth/password` (optional `current_password`), `DELETE /v1/auth/sso`. The built-in sign-out form checks Origin before anything else: a cross-site post clears no cookie and sends no `Clear-Site-Data`. Everything else under `/v1` works with a session as with a key, including `Idempotency-Key` (stored per session: a new sign-in starts afresh). That includes the read features (counts, aggregates, saved views, `/v1/me/preferences`, `/v1/users`); `POST /v1/query` and `POST /v1/aggregate` need the CSRF token too, since they aren't `GET`. Personal views and preferences belong to the member, so their sessions and keys share them ([permissions](permissions.md#sessions-and-keys)). The OpenAPI document (`/v1/openapi.json`) describes the session cookie as a security scheme next to bearer keys; the `/auth` endpoints are described here, not there.

All `/auth` and `/v1/auth` responses have `Cache-Control: no-store`, as do all responses to a session. Every response, the built-in pages and the web UI's HTML shell included, has `Referrer-Policy: no-referrer`, so a sign-in link's single-use token (in the `/auth/link` page's URL) never reaches `document.referrer` or a `Referer` header. The built-in pages also send a Content-Security-Policy with no script, `frame-ancestors 'none'` and `X-Frame-Options: DENY`.

**Form posts from the built-in pages.** Under `no-referrer`, browsers (Chromium, Firefox and WebKit alike) send `Origin: null` on a page's own HTML form post, together with `Sec-Fetch-Site: same-origin`; a `fetch()` from a page still sends the real `Origin`. So a server-rendered HTML form post (not JSON) is also accepted with `Origin: null` when, and only when, it carries `Sec-Fetch-Site: same-origin`, which a page can't set. That covers the `/auth` pages' forms, the OAuth consent decision (`POST /oauth/authorize`) and the connected-apps page's disconnect (`POST /auth/apps/revoke`); each still needs the session's CSRF token. Nothing under `/v1` accepts `Origin: null`, nor does any JSON request or the OAuth token, revocation and registration endpoints (they take no cookie). The consent page is `no-referrer` too, so its URL (with the client's `state`) and the authorization code in the redirect it leads to never travel in a `Referer`. A browser that sends neither a usable `Origin` nor `Sec-Fetch-Site` on a form post is refused (`403 csrf_failed`); every current browser sends both.

## No account enumeration

The answer to "email me a code" is the same whether the email belongs to an active member, a disabled one or nobody, and so is the answer to a wrong password, a member without a password, a workspace that turned passwords off, and a locked account. Finding the memberships and sending the email happen after the response, and a password check for an unknown email still costs one hash. Rate limits keyed by email apply whether or not the email exists. The workspace choice is only shown after the person has proved the identity. One timing difference remains: a password that is checked against several workspaces (the same email with a password in each) takes one hash per workspace.

Self sign-up keeps the same property. Asking for a sign-up code looks nothing up, so the answer and the email are the same for an address that already belongs to a member and one that belongs to nobody; the limits keyed by email apply to any email. The workspaces an address already belongs to are named only after the address is proven with the code, as the workspace choice does.

## Limits

All in memory, per process, except where the table says otherwise. A client address is counted as itself for IPv4 and by its /64 for IPv6 (one subscriber's allocation), here and at the API's own limits on failed keys and invalid session cookies, so a host can't get a fresh allowance from each address it holds.

| Limit | Value |
|---|---|
| Sign-in requests per client address | 60 per 15 minutes |
| Code requests per email, from one address | 5 per 15 minutes |
| Code requests per email, from anywhere | 30 a day |
| Password attempts per email, from one address | 10 per 15 minutes |
| Sign-in emails per workspace they are for | 60 a minute (a message for several workspaces goes out if any has room; past it, skipped and logged) |
| Sign-in emails the server sends | 600 a minute, a last resort (past it, skipped and logged as an error; the requester isn't told either way) |
| Invitations per workspace / per sender / server-wide | 50 an hour / 20 an hour / 120 a minute; a separate budget from sign-in email; past it `429` and the member isn't added |
| Invalid session cookies per client address | 30 a minute, before the database is touched |
| Requests per signed-in member (all their sessions) | 20 a second, bursts of 200 (as per key); a count takes 2, an aggregate 2 plus one per grouping and measure, an import one per 100 rows |
| Password hashes at once | 4 running, 64 waiting; past that a sign-in gets `503` |
| Sign-up codes per client address | 10 an hour. Sign-up codes also count toward the two per-email code limits above, so one inbox gets no more mail for there being two forms |
| Sign-up emails the server sends | `SIGN_UP_EMAILS_PER_HOUR` (300); past it, skipped and logged as an error, and the requester isn't told |
| Workspaces one email may create by sign-up | `SIGN_UP_MAX_WORKSPACES_PER_EMAIL` (3), in all; counted in the database; past it `409 sign_up_cap` |
| Workspaces one client address may create by sign-up | `SIGN_UP_WORKSPACES_PER_ADDRESS_DAY` (5) a day; counted in the database; past it `429 sign_up_limited` |
| Workspaces sign-up creates, server-wide | `SIGN_UP_WORKSPACES_PER_HOUR` (50) and `SIGN_UP_WORKSPACES_PER_DAY` (300); counted in the database; past either `429 sign_up_limited` and an error in the log (`sign_up_ceiling`), at most once an hour |

**Lockout.** After 5 password failures in a row, password sign-in for that member locks for 1 minute, then 2, 4 and so on up to an hour per further failure. Each attempt is counted before the password is checked, and the fifth locks at once, so many guesses sent in parallel still get only five checks. Wrong `current_password` guesses when changing a password from a session count the same way (and a locked member gets `429 password_locked` there). It locks only password sign-in. The email code, SSO and server links still work, and any successful sign-in clears the lock. So someone guessing at a password can keep that member's password sign-in locked, but can't keep the member out.

Someone who requests codes for your email from elsewhere can use up its daily allowance (30), which blocks email sign-in for that address until the window ends; password, SSO and an operator's link still work. Behind a reverse proxy, set `TRUST_PROXY=true` so limits see real client addresses.

## What is audited

In the member's workspace, with surface `web` and the session ID (`ses_…`) in `details.session` when a session is acting:

| Action | When |
|---|---|
| `auth.signed_in` | Every sign-in, with `method` (`email_code`, `email_link`, `password`, `oidc`, `server_link`) |
| `auth.sign_in_failed` | A wrong code, a link opened in another browser, a wrong password, an attempt on a locked password; with `method` and `reason`. Recorded by the system against the member |
| `auth.code_sent` | A sign-in email was sent |
| `auth.password_locked` | Password sign-in locked, with the failure count and minutes |
| `auth.sso_linked`, `auth.sso_unlinked` | A member was linked to a provider subject, or the link was removed (by the member or an admin) |
| `auth.sign_in_link_created` | A server-printed link was made (surface `cli`) |
| `auth.signed_out`, `auth.session_revoked`, `auth.sessions_revoked` | A session ended by its owner or an admin |
| `auth.password_set`, `auth.password_changed`, `auth.password_removed` | With how many other sessions ended |
| `workspace.sign_in_changed` | An owner changed the workspace's password or SSO switch or SSO domains, or its OAuth app settings, with what changed (and how many apps a switch-off disconnected) |
| `oauth.consent_granted`, `oauth.consent_denied` | A member approved or cancelled connecting an app, with the client, redirect host, scopes and MCP server |
| `oauth.token_issued`, `oauth.token_refreshed`, `oauth.token_revoked` | Surface `oauth`, with the connection (`ogr_…`) and the client |
| `oauth.code_reuse_detected`, `oauth.refresh_reuse_detected` | A code or a used refresh token was presented again; the connection was revoked |
| `oauth.grant_revoked` | A member or an admin disconnected an app |
| `member.disabled` | Now also with `sessions_revoked` and `apps_revoked` |
| `workspace.created` | With `via`: `bootstrap` (the operator's command, surface `system`) or `sign_up` (a person on the sign-in page, surface `web`, followed by their `auth.signed_in`) |

Attempts for an email that belongs to nobody have no workspace to be audited in; they are rate limited and, for SSO, logged with a reason (never the email). No audit entry, log line or table holds a code, token, password or CSRF token: sessions and links are stored as SHA-256 hashes, codes as an HMAC under a key derived from `HLCRM_MASTER_KEY`, and the CSRF token is computed, not stored.

`GET /v1/members` and `GET /v1/access-review` show each member's `sign_in`: whether a password is set, whether single sign-on is linked, the last sign-in and the number of live sessions. The access review also lists each member's connected apps.

## Invitations

`POST /v1/members` with `"send_invite": true` emails the new member the address of the sign-in page. It is off by default, so adding a member never emails anyone unless asked. The email carries no credential: they sign in with a code like everyone else. It needs `PUBLIC_URL` and `SMTP_URL`; without them the request is refused before the member is added. Invitations are limited per workspace and per sender, separately from sign-in email (see Limits); past a limit the request gets `429` and the member isn't added. The workspace's and the inviter's names go into the email as plain text, at most 80 characters, with control and formatting characters removed and links defused (no `scheme://`, and a dot inside a word shows as `[.]`), so a name can't carry a clickable link.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `PUBLIC_URL` | unset (people sign-in off) | The origin people use, e.g. `https://crm.example.com`. No path. https, or http only for localhost. Set but invalid, the server refuses to start (unset it to turn sign-in off) |
| `SESSION_IDLE_TIMEOUT_MINUTES` | 720 | Idle timeout (5 to 43,200) |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | 168 | Absolute timeout (1 to 2,160) |
| `PASSWORD_SIGN_IN` | `true` | Password sign-in on the server |
| `PASSWORD_MIN_STRENGTH` | 3 | How hard to guess a new password must be, as zxcvbn rates it (0 to 4). 4 is stricter; 0 turns the estimate off; below 3 is weaker than recommended |
| `PASSWORD_BREACH_CHECK` | `false` | Check new passwords against Have I Been Pwned |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | unset | Single sign-on; all three or none |
| `OIDC_DISPLAY_NAME` | `single sign-on` | The button label ("Sign in with …") |
| `OIDC_ALLOWED_DOMAINS` | empty (any) | Comma-separated email domains SSO accepts, checked on every SSO sign-in. Each workspace's owner can narrow it further |
| `OIDC_ALLOW_INSECURE_ISSUER` | `false` | Allow an http or private-address provider |
| `SMTP_URL`, `SMTP_FROM` | unset | Email, also used for alerts |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client addresses (only behind your own proxy) |
| `MCP_PUBLIC_URL`, `MCP_SERVICE_SECRET` | unset | OAuth for the MCP servers (connected apps); see [`docs/mcp/oauth.md`](mcp/oauth.md) |
| `SIGN_UP` | `false` | Let anyone who proves an email address create a workspace. Needs `PUBLIC_URL` and `SMTP_URL`, or the server refuses to start |
| `SIGN_UP_ALLOWED_DOMAINS` | empty (any) | Comma-separated email domains that may sign up |
| `SIGN_UP_MAX_WORKSPACES_PER_EMAIL` | 3 | Workspaces one address may create by sign-up |
| `SIGN_UP_WORKSPACES_PER_ADDRESS_DAY` | 5 | Workspaces one client address may create by sign-up in a day |
| `SIGN_UP_WORKSPACES_PER_HOUR`, `SIGN_UP_WORKSPACES_PER_DAY` | 50, 300 | Server-wide ceilings on workspaces created by sign-up |
| `SIGN_UP_EMAILS_PER_HOUR` | 300 | Server-wide ceiling on sign-up codes emailed |

## Not built

Multi-factor authentication (TOTP) and passkeys, SCIM, a CAPTCHA for self sign-up, browser or OAuth sign-in for the `crm` CLI, and internationalized email addresses.
