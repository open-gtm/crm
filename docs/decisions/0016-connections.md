# 0016: Connections, stored credentials for calling other systems

Status: accepted (2026-11-25). Built as described; how to use it is in [connections.md](../connections.md).

## Context

People want to run hl-crm-db beside a CRM they already pay for (Salesforce, HubSpot, Zoho, Microsoft Dynamics): as the CRM of one business unit, as a place to work records and tasks, or to add what their licence lacks. That needs hl-crm-db to call the other system's API.

Today an automation's `http_request` step can do that with `secret_headers`: a value typed into one step, encrypted with the workspace's data key and never returned ([automations.md](../automations.md#http_request)). It has two limits:

- **It only holds a value that doesn't change.** HubSpot gives a long-lived token, so it works. Salesforce (client credentials), Dynamics (client credentials) and Zoho (refresh token) give an access token that lasts about an hour, or until a session times out, and expect the caller to fetch the next one. A pasted header stops working the same day.
- **It belongs to one step.** Ten automations that call the same API hold ten copies of the token. Rotating it means editing all ten, and nothing lists where a credential is used.

The project doesn't want to write and maintain an integration per vendor. It should give operators one place to keep a credential and one way to use it, and leave the rest to documentation ([docs/integrations/](../integrations)).

On who is responsible for storing the secret: the software already stores secrets (webhook signing secrets, `secret_headers`, the OIDC client secret in `.env`) and already encrypts the ones in the database under `HLCRM_MASTER_KEY`. Other self-hosted CRMs do the same. So the line stays where the README draws it: the software encrypts, hides and scopes a credential; the operator keeps the master key, the host and the backups.

## Decision

**A connection is a named credential for one outside host, kept per workspace.** An automation's `http_request` step names a connection instead of carrying its own secret. There is no vendor-specific code: three generic types cover the four CRMs above and most other APIs.

| Type | The operator enters | The server does |
|---|---|---|
| `static_token` | a token | sends it as written |
| `oauth_client_credentials` | token URL, client ID, client secret, optional `scope` and extra form parameters | asks the token URL for an access token when it has none or the one it has is about to expire |
| `oauth_refresh_token` | token URL, client ID, client secret, refresh token | the same, with `grant_type=refresh_token`; if the reply carries a new refresh token, it replaces the stored one in the same transaction |

Every type also has:

- `key`: a lowercase name, unique in the workspace (`salesforce`, `hubspot`), which steps refer to.
- `base_url`: `https://` origin plus an optional path prefix. **The credential is only ever sent to this host, under this prefix.** It is fixed when the connection is saved, and changing it requires entering the secrets again, as a `secret_headers` value is bound to its host today.
- `header` and `prefix`: where the token goes. Default `Authorization` and `Bearer `. Zoho needs `Zoho-oauthtoken `.
- `token_lifetime_minutes`, for the OAuth types: used when the token reply has no `expires_in` (Salesforce's client credentials reply has none). Default 30.

**Using one.** A step gives `"connection": "<key>"` and a `url` that is a path:

```json
{ "type": "http_request", "id": "push", "method": "PATCH", "connection": "salesforce",
  "url": "/services/data/v62.0/sobjects/Contact/HLCRM_Id__c/{{record.id}}",
  "body": { "LastName": "{{record.last_name}}", "Email": "{{record.email}}" } }
```

The request goes to `base_url` plus the path, with today's rules for placeholders in paths and queries. A step with a connection can't set the connection's header, and can't have `secret_headers` at all: a secret of the step's own would travel with it to wherever the connection is later pointed. If the reply is 401 and the connection is an OAuth type, the server drops the cached access token, fetches a new one and sends the request once more; a second 401 fails the step. Nothing else about `http_request` changes: the outbound guard, the caps, the run log, the censored reply.

**Token replies can't move the request.** Salesforce returns an `instance_url` and Zoho an `api_domain`. They are ignored: requests go to `base_url`, which a person typed and an audit entry recorded. The token URL's host is fixed at save too, goes through the same outbound guard, and may differ from the API host (Dynamics signs in at `login.microsoftonline.com`).

**Storage.** A `connections` table with forced row-level security, like every tenant table. Secrets (static token, client secret, refresh token) and the cached access token are sealed with the workspace's data key, with the tenant, the connection ID and the column name as additional data, so a value copied to another row or column doesn't open. The client ID, URLs and scope are not secret and are stored as text. IDs are `conn_…`.

**Secrets are write-only.** The API returns `null` for them, with `has_secret: true` and the time each was last set. Sending `null` on an update keeps the stored value. They are never written to logs, run history, dry runs or idempotency records.

**Refreshing.** A token is fetched when a step needs one, not on a timer, in a transaction of its own that holds the connection's row, so that two runs don't both use a refresh token that rotates. The token request has 10 seconds in all. This is the one place a transaction waits on the network; it holds one row, for a request that happens about once per token lifetime. The access token is cached until one minute before it expires. A token request that fails records the status and the time on the connection (`last_error`), fails the step, and never puts the provider's reply in the run log.

**Who can do what.**

- A new permission, `connections:manage`, creates, changes, tests and archives connections. Owners and admins have it. It is separate from `automations:manage` so that a workspace can let someone write automations against a connection without letting them read or replace credentials for it.
- Naming a connection in a step needs `automations:manage`, as writing the step does.
- Creating a connection or changing a secret needs a recent sign-in, like creating an API key.
- **No change comes through MCP.** The admin MCP server lists connections (`list_connections`: key, type, host, whether it works) and lets an agent name one in an automation. Creating, changing, testing and archiving are refused when the request carries an MCP surface, as creating an API key is: an agent that could change `base_url` or replace a secret could send a credential, or the records a step carries, to a host of its choosing. The project is agent-first for records, schema and layouts; credentials are the exception.

**Testing.** `POST /v1/connections/{id}/test` fetches a token (for the OAuth types) and, if the connection has a `test_path`, sends one `GET` to it. The answer is the two outcomes and the request's status, and nothing from the reply bodies. A token it fetches is kept, so a working test leaves the connection ready.

**Audit.** `connection.created`, `connection.updated` (with the names of what changed, never values), `connection.secret_set`, `connection.tested`, `connection.archived`. A step's use is already in the audit log as `automation.http_request` with the host and status; it gains the connection's ID.

**The web UI.** Settings → Connections, shown to members with `connections:manage`: a list (name, type, host, last used, last error), a form, and a Test button. The form offers presets for HubSpot, Salesforce, Dynamics and Zoho that fill in the type, the URL shapes, the header prefix and a link to the matching guide. A preset is form data in the web package, not server behaviour: the server sees an ordinary connection.

**Archiving** a connection is refused while a live automation names it; the refusal lists them. `GET /v1/connections/{id}` lists the automations that use it. Archiving deletes the secrets, and frees the key for a new connection.

**The key and the type never change.** Steps keep the key, and a type decides which secrets exist.

## Not chosen

- **Credentials in `.env`.** No new storage, but one credential per deployment instead of per workspace, no screen, and a restart to rotate. It also gives every workspace on a shared deployment the same credential.
- **One adapter per CRM** (objects mapped, sync scheduled). This is the integration the project said it wouldn't build: each one needs tests against a vendor's API that changes under it.
- **The authorization-code flow** (a "Connect to Salesforce" button and a redirect back). It needs a public callback URL and one OAuth app per deployment, registered by each operator, and the three types above already cover server-to-server use of all four CRMs. It can be added as a fourth type.
- **Leaving it in `secret_headers` and having the user run a token-refreshing script.** It moves the secret to a cron job nobody audits.

## Consequences

- `secret_headers` stays, for one-off calls. The docs point to connections for anything used twice or anything that expires.
- Losing `HLCRM_MASTER_KEY` makes every connection unusable, as it does restricted fields. Data-key rotation (roadmap) has to re-seal the `connections` columns.
- A connection gives everyone with `automations:manage` the access its credential has in the other system. The guides tell operators to give that credential the narrowest scopes that do the job; the software can't check it.
- Connections aren't in the schema document or in packs. A pack that later carries automations names connections by `key` and the installer asks for the secrets.
- Two things were built with this so that records can also come in. `for_each` can go through a list in an HTTP reply (`"items": "{{steps.fetch.json.records}}"`), with `{{item.<Key>}}` reading an element as the other system wrote it, so a schedule can pull changed records; placeholder paths take capitals for that. And `POST /v1/objects/{object}/records/upsert` (ops MCP `upsert_record`) creates or updates by a unique field in one request, under an import row's access rules, so another system can push a record without first looking it up.
- Still not built: receiving another system's signed webhooks, and paging through a reply (one page of at most 64 KB and 200 elements per run).
- Client credentials go in the token request's form body only. No HTTP Basic at the token URL, no JWT bearer or mutual TLS credentials, no per-member connections (a connection belongs to the workspace), no sharing a connection between workspaces.
- `token_params` are stored and returned as plain text. They are for an `audience` or a `resource`, not for secrets, and the docs say so.
- At most 25 connections per workspace. No `crm` CLI command yet.
- Migration `023_connections.sql` adds the table and the `connections:manage` permission (owner and admin roles of existing workspaces get it; the `admin` key scope unlocks it). Routes are under `/v1/connections`, in the cross-tenant harness. The threat model has T-OUT-11.
