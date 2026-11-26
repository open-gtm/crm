# Using hl-crm-db beside HubSpot

This is a guide to connecting the two yourself. hl-crm-db has no HubSpot integration: you create a credential in HubSpot, store it in hl-crm-db as a [connection](../connections.md), and write automations that call HubSpot's API. HubSpot's screens and limits are HubSpot's; they were checked against its developer documentation on 2026-11-25 and may have changed.

What works today, and what doesn't:

| Direction | How | Status |
|---|---|---|
| hl-crm-db → HubSpot, when a record changes | an automation's `http_request` step through a connection | works |
| HubSpot → hl-crm-db, in bulk | export from HubSpot, `crm data import --key` | works |
| HubSpot → hl-crm-db, on a schedule | an automation fetches the contacts changed since the last run and upserts each | works; one page per run |
| HubSpot → hl-crm-db, as it happens | HubSpot calls `POST /v1/objects/contact/records/upsert` with an ops key (a workflow webhook action, or your own script) | works; needs your API reachable over HTTPS |
| Both through an AI client | add both MCP servers to Claude, ChatGPT or Cursor | works; see the end |

## 1. Choose a HubSpot credential

| Credential | Use it when | Notes |
|---|---|---|
| **Service key** | you only call HubSpot's REST API | Recommended. Belongs to the account, not a person. No webhooks. Announced as a public beta in February 2026. |
| **Project-based app with static auth** | you also want HubSpot's webhooks | Built with the HubSpot CLI; installs in one account. |
| **Legacy private app** | you already have one | Existing ones keep working. HubSpot removed creating new ones (28 September 2026 for new accounts, 26 October 2026 for existing ones). |

All three give a token that doesn't expire by itself and is sent as `Authorization: Bearer <token>`.

### Create a service key

You need to be a super admin or have the **Developer tools access** permission.

1. In HubSpot, go to **Development → Keys → Service keys** (also reachable from **Settings → Integrations → Service Keys**).
2. Click **Create service key** and name it, for example `hl-crm-db`.
3. Click **Add new scope**, tick the scopes you need, and click **Update**. For the examples below: `crm.objects.contacts.read` and `crm.objects.contacts.write`. Add the `companies` and `deals` pairs only if you'll sync those. A key can only have scopes you have yourself.
4. Click **Create** and confirm.
5. Open the key, click **Show**, then **Copy**.

To rotate it later, use **Rotate** on the key: **Rotate and expire later** keeps the old value working for 7 days.

### Or: a project-based app with static auth

```sh
npm install -g @hubspot/cli@latest
hs account auth
hs project create      # choose App, distribution "private", auth "static"
hs project upload
```

In the app's `app-hsmeta.json`, `distribution` is `"private"` and `auth.type` is `"static"`, with your scopes in `auth.requiredScopes`. Then in HubSpot: **Development → Projects →** your project **→** the app **→ Distribution → Manage distribution → Install now**. The access token is on the **Distribution** tab after installing (**Show**).

### Check the token

```sh
curl -s "https://api.hubapi.com/crm/v3/objects/contacts?limit=1" -H "Authorization: Bearer $HUBSPOT_TOKEN"
```

## 2. Decide how records are matched

Each side needs a field holding the other side's ID, so that a second sync updates instead of creating a duplicate.

**In HubSpot**, create a contact property that holds the hl-crm-db record ID and requires unique values: **Settings → Properties → Create property**, single-line text, internal name `hlcrm_id`, with **Require unique values for this property** ticked. (HubSpot can also match contacts on `email`, but an upsert keyed on email replaces the whole contact rather than changing the properties you send.)

**In hl-crm-db**, add a unique field for HubSpot's ID, with the admin key:

```sh
curl -s -X POST localhost:8787/v1/objects/contact/fields -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"api_name": "hubspot_id", "type": "text", "label": "HubSpot ID", "unique": true}'
```

## 3. Store the token in hl-crm-db

In the web UI, go to **Settings → Connections → New connection** and choose **HubSpot** under "Set up for". It fills in the type (`static_token`), the base URL `https://api.hubapi.com` and a test path. Paste the token and create it, then press **Test**: it should say the test request was answered with HTTP 200.

Or through the API, with an admin key:

```sh
curl -s -X POST localhost:8787/v1/connections -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "hubspot", "name": "HubSpot", "type": "static_token", "base_url": "https://api.hubapi.com",
  "secret": "<your HubSpot token>", "test_path": "/crm/v3/objects/contacts?limit=1" }'
```

The token is encrypted with the workspace's data key and never returned. Managing connections needs `connections:manage` and can't be done through MCP. See [connections.md](../connections.md).

## 4. Push a contact to HubSpot when it changes

Send this to `POST /v1/automations` with a key that has `automations:manage`. Send it with `"dry_run": true` first to read what it will do.

```json
{
  "name": "Contact to HubSpot",
  "trigger": { "type": "event", "event": "contact.updated", "changed_fields": ["email", "first_name", "last_name", "phone"] },
  "condition": { "field": "email", "op": "is_null", "value": false },
  "actions": [
    {
      "type": "http_request", "id": "push", "method": "POST", "connection": "hubspot",
      "url": "/crm/v3/objects/contacts/batch/upsert",
      "body": { "inputs": [ {
        "idProperty": "hlcrm_id", "id": "{{record.id}}",
        "properties": { "email": "{{record.email}}", "firstname": "{{record.first_name}}", "lastname": "{{record.last_name}}", "phone": "{{record.phone}}" }
      } ] }
    },
    { "type": "update_record", "values": { "hubspot_id": "{{steps.push.json.results.0.id}}" } }
  ],
  "hourly_cap": 500
}
```

- Make a second automation with the same steps on `contact.created`.
- The last step writes HubSpot's ID back. An automation never reacts to its own change, so this doesn't loop.
- `http_request` is sent once and not retried. A failed run is in `GET /v1/automations/{id}/runs`; run it again with `POST /v1/automations/{id}/run`.
- A workspace sends at most 500 automation HTTP requests an hour by default (`AUTOMATION_HTTP_PER_HOUR`). HubSpot allows 100 requests per 10 seconds on Free and Starter and 190 on Professional and Enterprise, with a daily limit shared across the account.

## 5. Bring HubSpot records in

**In bulk.** Export contacts from HubSpot as CSV with the **Record ID** column, then:

```sh
crm data import contact hubspot-contacts.csv --map "Record ID=hubspot_id" --map "Email=email" \
  --map "First Name=first_name" --map "Last Name=last_name" --key hubspot_id          # shows what would change
crm data import contact hubspot-contacts.csv … --key hubspot_id --apply
```

Run the same command after a later export: rows whose `hubspot_id` is known are updated, the others are created.

**On a schedule.** An automation asks HubSpot for the contacts changed in the last hour and creates or updates each one here. Send it to `POST /v1/automations` (with `"dry_run": true` first):

```json
{
  "name": "Contacts from HubSpot",
  "trigger": { "type": "schedule", "every": { "hours": 1 } },
  "actions": [
    {
      "type": "http_request", "id": "fetch", "method": "POST", "connection": "hubspot",
      "url": "/crm/v3/objects/contacts/search",
      "body": {
        "filterGroups": [ { "filters": [ { "propertyName": "lastmodifieddate", "operator": "GTE", "value": "{{now-1h | epoch_ms}}" } ] } ],
        "properties": ["email", "firstname", "lastname", "phone"],
        "sorts": [ { "propertyName": "lastmodifieddate", "direction": "ASCENDING" } ],
        "limit": 100
      }
    },
    {
      "type": "for_each", "items": "{{steps.fetch.json.results}}",
      "steps": [ {
        "type": "upsert_record", "object": "contact", "key": "hubspot_id",
        "values": { "hubspot_id": "{{item.id}}", "email": "{{item.properties.email}}", "first_name": "{{item.properties.firstname}}", "last_name": "{{item.properties.lastname}}", "phone": "{{item.properties.phone}}" }
      } ]
    }
  ],
  "hourly_cap": 10
}
```

- One run takes one page: at most 100 contacts here (HubSpot's search allows 200 a page; the reply must stay under 64 KB), and at most 200 per run whatever the page. If more than that change in an hour, run it more often (every 15 minutes at the shortest) with a matching window, or use the bulk import for the backlog. There is no paging.
- Contacts use `lastmodifieddate`; companies and deals use `hs_lastmodifieddate`. HubSpot's search can take a few moments to show a change, so a window slightly longer than the schedule (`now-70m`) misses less, and a contact pulled twice is simply left unchanged.
- A contact changed here by this automation doesn't start the push automation of section 4: an automation never reacts to its own changes, but another automation does, so the push would send the same values back to HubSpot once. HubSpot sees no change and it ends there. To avoid even that, have the pull also set a field of your own (say `synced_from: "hubspot"`) and give the push a `condition` that leaves such changes out.
- A contact with no email in HubSpot fails its `upsert_record` if your contacts require one; the run stops there and is listed as failed with the reason.

**As it happens.** Have HubSpot call hl-crm-db. Create an API key for this with only the `ops:write` scope, for a member whose role can write only the objects HubSpot should touch (Settings → API keys). A HubSpot workflow's **Send a webhook** action, or a script of your own, then sends one request per contact:

```sh
curl -s -X POST https://crm.example.com/v1/objects/contact/records/upsert -H "Authorization: Bearer <that key>" -H "Content-Type: application/json" \
  -d '{"key": "hubspot_id", "values": {"hubspot_id": "151", "email": "jane@acme.com", "first_name": "Jane"}}'
```

It creates the contact, or updates the one with that `hubspot_id`, and answers with `action`: `created`, `updated` or `unchanged`. hl-crm-db must be reachable from HubSpot over HTTPS, which the Docker quick start is not; the schedule above needs no inbound access.

## 6. Both in one AI client

HubSpot runs its own MCP server at `https://mcp.hubspot.com`. Add it and hl-crm-db's ops server ([docs/mcp](../mcp/README.md)) to the same client, and the agent can read from one and write to the other with no sync at all: "find the HubSpot contacts created this week at companies over 200 people and add them here as leads".

- HubSpot's server signs each person in with OAuth. In HubSpot: **Development → MCP Connectors → Create MCP connector**, then give the client the connector's client ID and secret. Each person gets what their own HubSpot permissions allow.
- hl-crm-db's destructive tools (merges, bulk changes, archiving) default to a dry run or need a confirmation, and every write is in the audit log under the member whose key or sign-in the client used.
- Record content from either system is untrusted text to the agent. Read [prompt injection](../mcp/README.md#prompt-injection-what-protects-you-and-what-does-not) before letting an agent copy between them unattended.

## Keeping it safe

- Give the HubSpot credential only the scopes the automations use. Anyone with `automations:manage` in the workspace can write a step that uses the connection.
- Don't put the token in a plain `headers` value, a URL or a record. Only a connection (or a step's `secret_headers`) is encrypted and hidden.
- Back up `HLCRM_MASTER_KEY`. Without it the stored token can't be read and has to be entered again.
- When someone who knew the token leaves, rotate it in HubSpot (**Rotate and expire later** gives 7 days) and enter the new one on the connection: **Change…**, paste it, save. No automation needs editing.
