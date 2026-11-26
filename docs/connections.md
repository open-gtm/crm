# Connections

A connection is a stored credential for one outside system: the CRM you already use, a billing API, a messaging service. An automation's `http_request` step names a connection and gives a path, and hl-crm-db adds the credential and sends the request. There is no code for any particular vendor: you describe how the other system's API authenticates, once.

Use a connection instead of a step's `secret_headers` when a credential is used by more than one automation, or when it expires and has to be fetched again (most OAuth APIs).

Managing connections needs `connections:manage` (owners and admins have it). Naming one in a step needs `automations:manage`. Design and reasons: [ADR 0016](decisions/0016-connections.md). Setup guides: [HubSpot](integrations/hubspot.md), [Salesforce](integrations/salesforce.md).

## The three types

| Type | You enter | What the server does |
|---|---|---|
| `static_token` | a token (`secret`) | sends it as written |
| `oauth_client_credentials` | `token_url`, `client_id`, the client secret (`secret`), optionally `scope` and `token_params` | asks the token URL for an access token (`grant_type=client_credentials`) when it holds none or the one it holds is about to expire |
| `oauth_refresh_token` | the same, and a `refresh_token` | the same with `grant_type=refresh_token`; when the reply gives a new refresh token, it replaces the stored one |

Every connection also has:

| Field | Meaning |
|---|---|
| `key` | The name steps use, such as `salesforce`. Lowercase letters, digits and underscores. It can't be changed. |
| `base_url` | `https://` and a host, with an optional path prefix. **The credential is only ever sent under it.** No query string. |
| `header_name`, `header_prefix` | Where the credential goes. Default `Authorization` and `Bearer ` (with its space). |
| `token_lifetime_minutes` | OAuth types: how long an access token is kept when the token reply has no `expires_in`. Default 30. |
| `test_path` | Optional: a path that answers a `GET` with a status under 400 when the credential works. |
| `token_params` | OAuth types: up to 10 extra form parameters for the token request (an `audience`, a `resource`). They are **not** secret and are returned by the API. |

## Create one

In the web UI: **Settings → Connections → New connection**. "Set up for" fills the form for HubSpot, Salesforce, Microsoft Dynamics 365 or Zoho CRM; replace every `YOUR-…` part.

Through the API, with an admin key:

```sh
curl -s -X POST localhost:8787/v1/connections -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "salesforce", "name": "Salesforce", "type": "oauth_client_credentials",
  "base_url": "https://acme.my.salesforce.com",
  "token_url": "https://acme.my.salesforce.com/services/oauth2/token",
  "client_id": "3MVG9…", "secret": "…",
  "test_path": "/services/data/"
}'
curl -s -X POST localhost:8787/v1/connections/conn_…/test -H "Authorization: Bearer $ADMIN_KEY"
# {"data": {"ok": true, "token": {"ok": true, "error": null}, "request": {"ok": true, "status": 200, "error": null}}}
```

`GET /v1/connections` lists them, `GET /v1/connections/{id}` adds `used_by` (the automations that name it), `PATCH` changes one, `DELETE` archives it. A workspace can have 25.

## Use one in an automation

```json
{ "type": "http_request", "id": "push", "method": "PATCH", "connection": "salesforce",
  "url": "/services/data/v62.0/sobjects/Contact/HLCRM_Id__c/{{record.id}}",
  "body": { "LastName": "{{record.last_name}}", "Email": "{{record.email}}" } }
```

- `url` is a path starting with `/`. The request goes to the connection's `base_url` followed by it. Placeholders fill the path and query as in any `http_request` step ([automations.md](automations.md#http_request)); a `.` or `..` segment is refused.
- The step can't set the connection's header, and can't have `secret_headers`: the credential is the connection's.
- A reply of 401 through an OAuth connection is taken to mean the token ran out early: the server fetches one new token and sends the request once more. A second 401 fails the step.
- A dry run and the run log show the header's name and "(secret, not shown)", never its value.
- Everything else is as for any `http_request` step: the outbound guard, the hourly caps, one attempt, no retries.

## What is kept secret, and how

- `secret`, `refresh_token` and the access token the server fetched are encrypted with the workspace's data key (which `HLCRM_MASTER_KEY` wraps), each bound to its workspace, connection and column.
- They are write-only. The API answers with `has_secret`, `secret_set_at`, `has_refresh_token` and `token_expires_at`, never a value. On an update, leaving `secret` out (or `null`) keeps the stored one.
- **A stored secret is never sent somewhere new.** Changing `base_url` or `token_url` needs every secret in the same request.
- A token reply can't redirect anything: fields such as `instance_url` or `api_domain` are ignored.
- When a token request fails, the connection's `last_error` and the run's reason hold the HTTP status and the OAuth error code (`invalid_client`), and nothing else from the reply.
- Archiving deletes the secrets. It is refused while an automation names the connection.
- **Not through MCP.** An agent can list connections (`list_connections` on the admin server) and name one in an automation. Creating, changing, testing and archiving are refused through MCP, so a prompt-injected agent can't point a credential at a host of its choosing.
- From the web UI, creating a connection, entering a secret or moving a URL asks for a sign-in in the last 10 minutes.
- Every change is in the audit log: `connection.created`, `connection.updated` (which fields, and the new hosts), `connection.secret_set`, `connection.tested`, `connection.archived`. Each use is `automation.http_request` with the connection's ID.

What the software can't do for you: back up `HLCRM_MASTER_KEY` (without it every connection must be entered again), and give the credential the narrowest access in the other system that does the job. Everyone with `automations:manage` can write a step that uses a connection.

## Limits

- Client credentials and refresh tokens are sent in the form body of the token request (`client_secret_post`). Providers that only take HTTP Basic authentication, a signed JWT or a client certificate at the token URL aren't supported.
- There is no "sign in with…" button (the authorization-code flow). Get a refresh token from the provider's own console and paste it.
- A connection belongs to the workspace, not to a member.
- To bring records in, either a scheduled automation fetches a list through a connection and goes through it ([for_each over an HTTP reply](automations.md#steps): one page of at most 64 KB and 200 elements per run, no paging), or the other system calls `POST /v1/objects/{object}/records/upsert` with an API key, or you import a file with `crm data import --key` ([cli.md](cli.md)).
- Connections aren't part of the schema document or of packs, and the `crm` CLI has no command for them yet (`crm api GET /v1/connections` works).
