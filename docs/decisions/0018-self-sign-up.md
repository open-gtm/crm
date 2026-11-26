# 0018: Self sign-up creates a workspace from the sign-in page, off by default

Status: accepted (2026-11-25)

## Context

Until now nobody could sign up. An operator made each workspace with `bootstrap`, an admin added each member, and sign-in only ever found existing members ([ADR 0009](0009-people-sign-in-and-sessions.md)). That is right for someone hosting the CRM for their own company, and it stays the default.

A hosted service needs the opposite first step: a person who has never been seen adds the MCP server's URL to Claude, is sent to the sign-in page ([ADR 0010](0010-oauth-for-mcp.md)), and must be able to create an account there and come back connected. Self-hosters who run the CRM for many small teams want the same.

This is the first path where an unknown caller creates lasting state and has mail sent to an address nobody vouched for. The design is mostly about that.

## Decision

**A server setting, `SIGN_UP`, off by default.** With it off nothing changes: the pages and endpoints answer 404, the sign-in page shows no link, and `GET /auth/capabilities` says `"sign_up": false`. With it on, the server refuses to start unless `PUBLIC_URL` and `SMTP_URL` are set, since a new address is proven by an emailed code. `SIGN_UP_ALLOWED_DOMAINS` optionally limits who may sign up to addresses at the listed domains.

**Three steps, and nothing is created before the last.**

1. `POST /auth/sign-up` with an email. A code is emailed; the browser gets a pre-session cookie.
2. `POST /auth/sign-up/verify` with the code, in the same browser. The address is proven. The browser gets a new pre-session cookie and 30 minutes to finish.
3. `POST /auth/sign-up/workspace` with the workspace's name, and optionally the person's name and a currency. In one transaction the caps are counted, the workspace is created with the person as owner, and a session starts.

Each step takes JSON or a form post from the built-in pages (`/auth/sign-up`, `/auth/sign-up/code`, `/auth/sign-up/workspace`), under the same Origin and `Sec-Fetch-Site` checks as sign-in. The steps are rows in `sign_in_flows` with two new purposes, found only by the hash of the browser's cookie, single-use and pruned like every other flow.

**A separate flow, not a branch of sign-in.** The alternative was one form: enter an email, get a code, and land either in your workspace or on "name your workspace". It reads well, but it would make the sign-in form send mail to any address typed into it, and it would put a new outcome into code whose property is that it answers the same way for everyone. Keeping sign-up apart leaves sign-in exactly as it was. The sign-in page links to sign-up, and sign-up links back; both keep `return_to`.

**It works inside an app's connection request.** `return_to` is stored with the first step and carried to the last, under the same rule as sign-in's (a path on this origin, at most 2,048 characters). A person who arrived from `/oauth/authorize` lands back on the consent page as the owner of their new workspace, having signed in moments ago, so approving the admin scope needs no second sign-in.

**No API keys are minted.** `bootstrap` creates two keys for the owner and prints their secrets once, to the operator's terminal. A browser page is the wrong place to show a secret once: it can be cached, screenshotted or lost to a reload. A workspace made by sign-up starts with none; the owner creates keys in the app when they need one, or connects an app over OAuth and never needs one. `createWorkspaceIn` takes `via: "bootstrap" | "sign_up"` and mints keys only for the first.

**An address may create more than one workspace, up to a cap.** Members are rows per workspace, and one email can already belong to several. A person with an account may want a second, separate workspace, so sign-up doesn't refuse a known address. Once the address is proven, the naming page lists the workspaces it already belongs to and offers sign-in instead, in case that is what the person meant.

**No account enumeration.** The first step looks nothing up, so its answer can't depend on whether the address belongs to anyone: the same status, body and cookie, and the same email. Limits keyed by an email apply to any email. What an address already belongs to is shown only after the address is proven, as the workspace choice does. An address outside `SIGN_UP_ALLOWED_DOMAINS` is refused plainly (`403 sign_up_domain`): that is about what was typed, not about any account.

**Limits, and where each is counted.**

| What | Limit | Counted | Past it |
|---|---|---|---|
| Sign-in and sign-up requests per client address | 60 per 15 minutes (shared with sign-in) | memory | `429` |
| Sign-up codes per client address | 10 an hour | memory | `429` |
| Codes per email, from one address / from anywhere | 5 per 15 minutes / 30 a day (shared with sign-in codes) | memory | `429` |
| Sign-up emails the server sends | `SIGN_UP_EMAILS_PER_HOUR`, 300 | memory | skipped, logged as an error once an hour, the requester told nothing different |
| Wrong codes | 5, then the code is void | database | start again |
| Workspaces one email may create | `SIGN_UP_MAX_WORKSPACES_PER_EMAIL`, 3 | database | `409 sign_up_cap` |
| Workspaces one client address may create in a day | `SIGN_UP_WORKSPACES_PER_ADDRESS_DAY`, 5 | database | `429 sign_up_limited` |
| Workspaces sign-up creates server-wide | `SIGN_UP_WORKSPACES_PER_HOUR`, 50, and `_PER_DAY`, 300 | database | `429 sign_up_limited`, logged as an error once an hour |

A client address is itself for IPv4 and its /64 for IPv6, as everywhere else. The caps on what is created are counted in the database, in a table of their own (`workspace_sign_ups`), so they hold across restarts and across replicas, which the in-memory limits don't. The transaction that creates a workspace takes an advisory lock first, so two sign-ups can't both fit under a cap. A refusal at the last step leaves the proven step unused: a bad name or a busy hour costs another try, not another email.

`workspace_sign_ups` holds one row per workspace created this way: the workspace's ID, an HMAC of the canonical email, an HMAC of the client address, and the time. The HMACs are made with a key derived from the master key, so a copy of the table names nobody. The table has forced row-level security and shows itself only to a transaction that says it is counting sign-ups; the app can insert rows but not change or delete them. A row goes when its workspace does (the foreign key cascades).

**What is audited.** `workspace.created` in the new workspace, by the system on the `web` surface, with `via: "sign_up"` (a `bootstrap` workspace says `via: "bootstrap"`), followed by the owner's `auth.signed_in`. Requests before that have no workspace to be audited in, like sign-in attempts for an address that belongs to nobody; they are rate limited, and the ceilings log an error when reached.

## Consequences

- An operator who turns this on is running a public service: anyone who can receive mail can create a workspace and use storage. The ceilings bound how fast, not whether. Disposable addresses pass, unless `SIGN_UP_ALLOWED_DOMAINS` is set.
- Behind a reverse proxy, `TRUST_PROXY` must be set, or every visitor shares the proxy's address and the per-address limits apply to all of them together (five workspaces a day, by default).
- The server sends email to addresses that never asked for it if someone types them in. The message says nothing was created and carries a code that is useless without the browser that asked. The per-email limits are shared with sign-in codes, so the two forms together send one inbox no more than either did alone.
- A sign-up code is typed in; there is no emailed link for it. One less thing to bind to the browser, and the code page is already open.
- The owner's display name defaults to their address until they give one.

## Not built

- A CAPTCHA or proof-of-work hook, and blocking disposable email domains. The limits above are the abuse controls; a hosted service will want more in front of them.
- Deleting a workspace, per-workspace quotas on records, and billing. A hosted service needs all three before opening sign-up to the public.
- Joining an existing workspace by email domain, and invitations that create the account. Members are still added by an admin.
- Single sign-on as a way to sign up. A new address is proven by an emailed code only.
- A terms-of-service or consent step. An operator who needs one puts it in front of the page.
