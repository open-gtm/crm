# Connecting MCP clients with OAuth

Claude (claude.ai and the Claude apps), ChatGPT, Cursor and Claude Code can connect to hl-crm-db's MCP servers by OAuth: you add the server's URL to the client, the client sends you to your hl-crm-db sign-in page, you approve, and the client gets a token for that one server. API keys keep working exactly as before, for clients that take a header or run the server over stdio ([README](README.md)).

How it is built, and why, is in [ADR 0010](../decisions/0010-oauth-for-mcp.md). The sign-in itself is the ordinary people sign-in ([docs/sign-in.md](../sign-in.md)).

## What the server needs

| Setting | Example | Why |
|---|---|---|
| `PUBLIC_URL` | `https://crm.example.com` | Where people sign in and approve. It is also the OAuth issuer |
| `MCP_PUBLIC_URL` | `https://mcp.example.com` (or the same as `PUBLIC_URL`) | The origin clients reach the MCP server at. Setting it turns OAuth on |
| `MCP_SERVICE_SECRET` | 48 random characters | Shared by the `api` and `mcp` services; `sh scripts/init-env.sh` makes one (or `openssl rand -hex 32`). At least 32 characters with at least 16 different ones (or 64 hex digits); a weak value stops both processes |

Both URLs must be https (plain http only for `localhost`, for trying things on one machine) with no path. Set but wrong, or missing what it needs, and both processes refuse to start. Compose passes all three to both services.

**Hosted clients must reach you.** claude.ai, ChatGPT and Cursor's web agents connect from their own servers, so `MCP_PUBLIC_URL` and `PUBLIC_URL` must be reachable from the internet over https with a certificate they trust. Your browser must reach `PUBLIC_URL` too. Claude Code and other clients on your own computer only need what your computer can reach.

**One origin is the simplest.** If one reverse proxy serves both, with `PUBLIC_URL` and `MCP_PUBLIC_URL` the same, route `/mcp/*` to the `mcp` service (port 8788) and everything else to the `api` service (port 8787). Both services answer `/.well-known/oauth-protected-resource/mcp/…`, so either routing works. Some older clients look for the authorization server's metadata on the MCP server's own origin; with one origin they find it. Set `TRUST_PROXY=true` behind your own proxy so limits see real client addresses.

**The workspace must allow it.** Connecting apps is on for every workspace by default. A workspace owner can turn it off, or limit which scopes apps may get (for example, no `admin`):

```sh
curl -X PATCH https://crm.example.com/v1/workspace/sign-in -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"oauth_scopes": ["ops:read", "ops:write"]}'
```

Turning it off (`{"oauth_apps": false}`) disconnects every app in the workspace at once; turning it back on restores none of them.

## Connecting

The URL to give a client is the MCP endpoint itself:

| Server | URL |
|---|---|
| Ops (records) | `<MCP_PUBLIC_URL>/mcp/ops` |
| Admin (setup, audit log) | `<MCP_PUBLIC_URL>/mcp/admin` |

Add them as two connectors if you want both. Each connection gets a token for its own server only.

- **Claude (claude.ai, desktop and mobile apps):** Settings → Connectors → Add custom connector, paste the URL. Leave the OAuth client ID and secret empty: Claude registers itself. Its callback is `https://claude.ai/api/mcp/auth_callback`.
- **Claude Code:** `claude mcp add --transport http crm-ops <MCP_PUBLIC_URL>/mcp/ops`, then `/mcp` in a session to sign in. It identifies itself with the document at `https://claude.ai/oauth/claude-code-client-metadata` and receives the answer on `http://localhost:<port>/callback`.
- **ChatGPT:** in a workspace that allows custom connectors, add a connector with the URL and OAuth as the authentication. It identifies itself with the document at `https://chatgpt.com/oauth/client.json` and signs its token requests with its own key (`private_key_jwt`), which this server checks against the keys that document publishes. Its callback is `https://chatgpt.com/connector_platform_oauth_redirect`.
- **Cursor:** add the server URL in its MCP settings. Cursor registers itself; its callbacks include `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback`.

Menu names change; the parts that matter are the URL and that the client does OAuth by itself.

The client then opens your browser at `<PUBLIC_URL>/oauth/authorize`. If you aren't signed in, you sign in as usual and come back. If your email belongs to several workspaces, the workspace you sign in to is the one the app reaches; to connect another workspace, sign in to it and connect again.

### A new person connecting from Claude

By default only existing members can connect: someone who isn't a member reaches the sign-in page and can go no further. On a server with self sign-up on (`SIGN_UP=true`, [docs/sign-in.md](../sign-in.md#creating-a-workspace-self-sign-up)), a person the server has never seen can start from the client:

1. They add `<MCP_PUBLIC_URL>/mcp/ops` (or `/mcp/admin`) to Claude or another client, as above.
2. The client opens their browser at the sign-in page. They choose **Create a workspace**, enter their email, and type the code from the email.
3. They name their workspace. It is created, they are its owner, and they are signed in.
4. They land on the consent page for the app that sent them, approve, and are back in the client, connected to their new workspace.

The connection request rides along as `return_to` through every step. The new workspace has no API keys; the app's connection is the only credential. To connect the second server too, they add it and approve again, already signed in.

## The consent page

It shows, before you decide:

- **The app's name, and how far to trust it.** An app identified by a metadata document (Claude Code, ChatGPT) published its name at the address shown, so the name is whatever the owner of that host chose. An app that registered itself (Claude's connectors, Cursor) has proven nothing about who made it: the page says so. Approve only if you just started connecting it yourself.
- **Where you'll be sent afterwards** (the redirect host), first on the page. That is where the approval goes, so it is the site you are trusting. If it isn't the app you meant, cancel. When an app's document is on one site but sends the approval to another, the page says so in red: the name then proves nothing about the site receiving access.
- **A warning when the app runs on your computer** (`localhost`): approve only if you just started it from a program on this machine.
- **What it could do**, in plain words, and anything it asked for that won't be granted, with why: your role can't use it, or the workspace doesn't allow apps to have it. `ops:write` becomes `ops:read` for someone whose role only reads.
- **Who and where:** your name, email and workspace.

Allowing `admin` needs a sign-in in the last 10 minutes; the page links to sign in again and come back. Every connection asks: nothing is remembered, so a new app, a new redirect host or more access always shows this page.

Problems found before you decide (an app asking for a server this one doesn't have, or without PKCE) are shown on a page with a link back to the app; you are never sent somewhere automatically before you've seen the page. An app this server doesn't know, or one asking to be sent somewhere it didn't register, gets a page that doesn't point anywhere.

## What a connected app can do

What the token's scopes unlock, within what your role allows **now**: if your role changes, or object and field rules change, the app's access changes on its next request. If you are disabled, the app stops at once. An ops connection can never use admin tools, and an admin connection's token doesn't work on the ops server (each is issued for its own server). A token works only through the MCP servers: the REST API refuses it, even from the app it was issued to.

| Scope | Lets the app |
|---|---|
| `ops:read` | Read records, the schema, pipelines and recent changes |
| `ops:write` | Also create, change and archive records (it includes `ops:read`) |
| `restricted:read` | See the values of restricted fields |
| `admin` | Change the CRM's setup and read the audit log and members (the admin server only) |

Access tokens last 60 minutes; the app refreshes them itself. A connection lasts at most 180 days, then you approve again. Settings: `OAUTH_ACCESS_TOKEN_MINUTES`, `OAUTH_REFRESH_TOKEN_DAYS` (30), `OAUTH_GRANT_MAX_DAYS`.

Everything an app does is in the audit log with you as the actor, on the `ops-mcp` or `admin-mcp` surface, with `details.oauth_client` (the app) and `details.oauth_grant` (the connection, `ogr_…`).

Each connection is a credential of its own (`oauth:<grant>`, see [permissions](../permissions.md#sessions-and-keys)), apart from your API keys, your browser sessions and your other connections:

- **Rate limit and costs:** its own bucket (bursts of 200, 20 a second), and costly requests (counts, aggregates, merge previews) are charged to it.
- **Long-running requests** (duplicates, merges, bulk changes, imports and exports, aggregates, counts): 2 at once per connection, and 4 at once across all of your connected apps together, so approving many apps doesn't multiply what you can hold. Over either, the tool returns an error that says it is retryable and how many seconds to wait (`_meta.retryable`, `_meta.retry_after_seconds`); a rate-limited request to the endpoint itself answers HTTP 429 with `Retry-After`.
- **Confirm tokens** (the merge and bulk tools' dry runs): usable only through the same connection, so do the dry run and the real run through the same app. Disconnecting the app, or connecting it again (a new connection), voids them.
- **Personal data** under `/v1/me` (personal saved views, preferences, notifications, personal alerts) is yours: the app sees and changes the same ones you do in the browser.
- **Never through an app:** session-only routes (sign-in, sessions, password, SSO, the connected-apps list), creating or rotating keys, changing the workspace's sign-in or OAuth settings, turning on restricted values for a webhook, redirecting a webhook that receives them, or replaying their deliveries (the MCP rules apply because the surface comes from the token).

## Disconnecting

- **You:** in the web UI, Settings → Account → Connected apps (or the user menu's Connected apps). Without the UI, `<PUBLIC_URL>/auth/apps` lists your connected apps (name, where it sends you, scopes, server, when connected and last used) with a Disconnect button. Or `GET /v1/auth/apps` and `DELETE /v1/auth/apps/{id}` from your own front end (session only).
- **Signing out everywhere** (`POST /v1/auth/sessions/revoke-others`) disconnects every app too. Changing your password doesn't.
- **An admin** with `members:manage`: in the web UI, Settings → Members → a member's menu → Connected apps; or `GET /v1/apps?member=usr_…` and `DELETE /v1/apps/{id}`, or `crm apps list --member usr_…` and `crm apps revoke ogr_…`, under the same rules as a member's sessions (an owner's only by an owner, never someone holding permissions you don't). `POST /v1/members/{id}/sessions/revoke` and disabling a member disconnect all of theirs. `GET /v1/access-review` lists each member's apps.
- **The app** can revoke its own tokens (`/oauth/revoke`).

Disconnecting takes effect on the app's next request.

## For client developers

| Document or endpoint | Where |
|---|---|
| Protected resource metadata | `<MCP_PUBLIC_URL>/.well-known/oauth-protected-resource/mcp/ops` (and `/admin`) |
| Authorization server metadata | `<PUBLIC_URL>/.well-known/oauth-authorization-server` (also at `/.well-known/openid-configuration`; this is not an OpenID provider and issues no ID tokens) |
| Authorization, token, revocation, registration | `<PUBLIC_URL>/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/register` |

- Authorization code with PKCE `S256` only; `plain` and requests without PKCE are refused. `response_type=code` only. `prompt=none` is answered with `consent_required`.
- Send `resource` (the MCP endpoint's URL) on both requests. Without it, `scope` containing `admin` means the admin server, otherwise the ops server; with a value that isn't one of the two endpoints, `invalid_target`.
- Every authorization response carries `iss` (RFC 9207), errors included.
- Token requests are `application/x-www-form-urlencoded`. Public clients send `client_id`; metadata-document clients that declare `private_key_jwt` send a client assertion instead (audience: the issuer or the token endpoint; expiry within 10 minutes; a `jti` used once). No client secrets.
- Refresh tokens rotate on every use. Presenting one that was already used revokes the whole connection. Don't refresh twice in parallel with the same token.
- Client ID metadata documents: an https URL with a path, on the default port (443; other ports are refused, for `jwks_uri` too), served with status 200 (redirects are not followed) within 5 seconds including DNS and at most 32 KB, containing `client_id` equal to the URL, `client_name` and `redirect_uris`. Cached per `Cache-Control` (5 minutes to a day). Past that, the cached copy keeps being used while it is fetched again in the background, for up to a day; if that fetch fails, refreshing keeps working on the cached copy but a new authorization needs the document. A failed fetch is remembered for 5 minutes. Whatever went wrong, the answer is the same `invalid_client`; the server's log (`oauth_client_document_refused`, `oauth_key_set_refused`) says why.
- Key sets for `private_key_jwt` are cached for 5 minutes. An assertion with a `kid` the cached set lacks makes the server fetch the set again at most once a minute, so publish a new key a minute before you sign with it.
- Registration takes JSON with `redirect_uris` (https, or http to `localhost`, `127.0.0.1` or `[::1]`) and `client_name`; send `application_type` (`native` for loopback, `web` otherwise). Left out, any loopback redirect URI makes the client `native`. Unused registrations lapse after 24 hours, and may be removed sooner (after 15 minutes) when the server holds 10,000.
- Redirect URIs match exactly, except the port of a loopback URI. Custom schemes aren't accepted.
- The MCP endpoints serve protocol revision 2026-07-28 (per-request `_meta`, `server/discover`, mirrored headers) and 2025-11-25 and earlier (initialize first), on the same URL.

## Limits

All in memory, per process. Addresses are the client address (`TRUST_PROXY` decides which); at the `/oauth/*` endpoints and for document fetches an IPv6 address counts by its /64. Nothing that every user of one client shares is charged for a request that proves nothing, so naming a public client ID can't cut that client off.

| What is counted | Keyed by | Figure | When exceeded |
|---|---|---|---|
| `GET /oauth/authorize` | address | 120 per 15 minutes | 429 page |
| `GET /oauth/authorize` by a signed-in member, client and redirect URI valid | client and workspace | 2,000 per 15 minutes | 429 page |
| `POST /oauth/token` | address | 600 a minute | 429 `slow_down` |
| Token requests that prove nothing (unknown client, no such code or refresh token, failed assertion) | client ID as sent, and address | 300 a minute | 429 `slow_down`, before any work |
| Token requests whose code or refresh token exists (or whose assertion verified) | client and workspace | 1,200 a minute | 429 `slow_down` |
| `POST /oauth/revoke` | address | 120 a minute | 429 |
| `POST /oauth/register` | address | 20 an hour | 429 |
| `POST /oauth/register` | IPv6 /48 | 200 an hour | 429 |
| `POST /oauth/register` | the server | 300 an hour | an error in the log (`oauth_registration_surge`), at most once an hour; nothing refused |
| Live registrations | the server | 10,000 | the oldest never used for a token and over 15 minutes old is removed; if none, 503 |
| Fetches of a known document or key set (cached client, or key set fetched before) | host | 60 a minute | a background refresh is skipped (the cached copy is used); a fetch the request needs: 503 |
| Fetches of URLs never seen | caller address | 20 a minute | 503 `temporarily_unavailable` |
| Fetches of URLs never seen | registrable domain | 30 a minute | 503 |
| Fetches at once, known | the server, per registrable domain | 16, 4 | as for the known budget |
| Fetches at once, never seen | the server, per caller address, per registrable domain | 32, 2, 4 | 503 |
| One fetch | DNS and request together | 5 seconds, 32 KB, port 443 | `invalid_client` (logged) |
| Refused documents remembered | URL | 5 minutes, 5,000 URLs | `invalid_client` with no fetch |
| Cached documents | unexpired copies; per host | 10,000; 500 | expired, then least recently used copies make room; a host's own least recently used past its share |
| Use of a cached document past its cache life | document | 1 day | fetched again (refused if that fails) |
| Key set refetch for an unknown `kid` | key set | once a minute | the cached set is used (the assertion fails) |
| Failed OAuth bearer values at the MCP endpoints | address | 30 a minute | 429 (a token that worked in the last 5 minutes and hasn't been refused since still gets through) |
| Wrong `MCP_SERVICE_SECRET` at the API | address | 30 a minute | 429, before the secret is compared |
| Requests with a connection's tokens | the grant | 20 a second, bursts of 200 | 429 |

The windows for these limits are kept apart from the sign-in limits (100,000 of each at most), and a window that is blocking is the last to be dropped.

## What was and wasn't verified

The test suite (`packages/server/test/oauth.test.ts`) runs a small OAuth client against the real API and MCP apps in one process: discovery from a 401, a metadata-document client served by a fake, a registered client, consent, tokens, MCP calls in both protocol revisions, refresh, revocation, `private_key_jwt`, and the refusals. It does not use the network: the metadata documents come from a stand-in for the outbound request function, so the real DNS and TLS path is only exercised by its own checks on addresses and URLs.

**Nothing here has been tried with a real Claude, ChatGPT or Cursor client.** To try it: expose a test server on https at a public address, set the three settings, add `<MCP_PUBLIC_URL>/mcp/ops` as a custom connector in claude.ai, approve, and ask Claude to list your pipelines. Then disconnect it at `/auth/apps` and check Claude can no longer use it. Do the same with Claude Code (`claude mcp add --transport http …`), and with ChatGPT if you have access to custom connectors. If a client fails, the API log's `oauth_*` events and the audit log say how far it got.
