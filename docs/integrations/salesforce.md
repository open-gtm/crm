# Using hl-crm-db beside Salesforce

This is a guide to connecting the two yourself. hl-crm-db has no Salesforce integration: you create an External Client App in Salesforce, store its credentials in hl-crm-db as a [connection](../connections.md), and write automations that call Salesforce's API.

Salesforce renames Setup screens between releases. If a label below isn't there, type the words in bold into Setup's Quick Find. These steps follow Salesforce's documented client credentials flow and have not been run against a live org by this project.

What works today, and what doesn't:

| Direction | How | Status |
|---|---|---|
| hl-crm-db → Salesforce, when a record changes | an automation's `http_request` step through a [connection](../connections.md), which fetches Salesforce's access tokens | works |
| hl-crm-db → Salesforce, with retries | a webhook to a small service of yours that holds the Salesforce credentials | works |
| Salesforce → hl-crm-db, in bulk | a report or Data Loader export, `crm data import --key` | works |
| Salesforce → hl-crm-db, on a schedule | an automation runs a SOQL query for the contacts changed since the last run and upserts each | works; one page per run |
| Salesforce → hl-crm-db, as it happens | a Flow HTTP callout to `POST /v1/objects/contact/records/upsert` with an ops key | works; needs your API reachable over HTTPS |
| Both through an AI client | add both MCP servers to Claude, ChatGPT or Cursor | works; see the end |

## 1. Create the credential in Salesforce

Your org needs API access: Enterprise, Unlimited, Performance and Developer editions have it, and Professional needs it added.

### An integration user

Requests will run as one Salesforce user, with that user's access. Don't use an administrator.

1. **Setup → Users → New User.** If your org has the **Salesforce Integration** user licence (most Enterprise and Unlimited orgs include five), use it with the **Minimum Access - API Only Integrations** profile.
2. Give the user a permission set that allows read and edit on only the objects and fields hl-crm-db should touch (for the examples below: Contact).

### An External Client App

1. **Setup → External Client App Manager → New External Client App.** Name it `hl-crm-db`, give a contact email, and leave the distribution state as **Local**.
2. Under **API (Enable OAuth Settings)**, tick **Enable OAuth**.
   - **Callback URL**: required but unused by this flow. Enter `https://localhost/unused`.
   - **OAuth Scopes**: add **Manage user data via APIs (api)** and nothing else.
3. Under **Flow Enablement**, tick **Enable Client Credentials Flow** and accept the warning. Click **Create**.
4. Open the app's **Policies** tab and click **Edit**. Under **OAuth Policies**, tick **Enable Client Credentials Flow** and enter the integration user's username in **Run As (Username)**. Save.
5. Open the **Settings** tab → **OAuth Settings** → **Consumer Key and Secret**. Salesforce asks you to verify your identity, then shows both. The consumer key is the client ID; the consumer secret is the client secret.

If you can't see External Client App Manager, your profile lacks the permission to create them: ask a Salesforce admin.

### Check it

Your My Domain host is under **Setup → My Domain** (`yourcompany.my.salesforce.com`; a sandbox is `yourcompany--name.sandbox.my.salesforce.com`). Use it, not `login.salesforce.com`: this flow only works on the My Domain host.

```sh
SF=https://yourcompany.my.salesforce.com
curl -s -X POST $SF/services/oauth2/token \
  -d grant_type=client_credentials -d client_id=$SF_CLIENT_ID -d client_secret=$SF_CLIENT_SECRET
# {"access_token": "00D…", "instance_url": "https://yourcompany.my.salesforce.com", "token_type": "Bearer", …}

curl -s $SF/services/data/ -H "Authorization: Bearer <access_token>"     # lists the API versions your org supports
```

The reply has no refresh token and no `expires_in`. The access token stops working when the integration user's session times out (**Setup → Session Settings**, 2 hours by default), and the caller asks for another the same way.

## 2. Decide how records are matched

**In Salesforce**, add an external ID field to Contact that holds the hl-crm-db record ID: **Setup → Object Manager → Contact → Fields & Relationships → New**, type **Text** (length 40), field name `HLCRM_Id`, with **External ID** and **Unique** ticked. Its API name is `HLCRM_Id__c`. Make it visible and editable to the integration user's permission set.

**In hl-crm-db**, add a unique field for Salesforce's ID, with the admin key:

```sh
curl -s -X POST localhost:8787/v1/objects/contact/fields -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"api_name": "salesforce_id", "type": "text", "label": "Salesforce ID", "unique": true}'
```

Salesforce IDs come in a 15-character and an 18-character form. Store the 18-character one everywhere (the API returns it; reports show the 15-character one unless you add a `CASESAFEID()` formula column).

## 3. Push a contact to Salesforce when it changes

In the web UI, go to **Settings → Connections → New connection** and choose **Salesforce** under "Set up for". Replace `YOUR-DOMAIN` in both addresses, enter the consumer key as the client ID and the consumer secret as the client secret, and create it. The values:

| Field | Value |
|---|---|
| Type | OAuth client credentials (`oauth_client_credentials`) |
| Key | `salesforce` |
| Base URL | `https://yourcompany.my.salesforce.com` |
| Token URL | `https://yourcompany.my.salesforce.com/services/oauth2/token` |
| Client ID, client secret | the consumer key and secret |
| Token lifetime | 30 minutes (the reply gives none; keep it under your session timeout) |
| Test path | `/services/data/` |

Press **Test**: it should say a token was issued and the test request was answered with HTTP 200. If the token request fails, the message has Salesforce's error code: `invalid_client_id` or `invalid_client` means the key or secret is wrong, and `invalid_grant` usually means the Run As user isn't set or the flow isn't enabled in the app's policies. The same can be done through the API ([connections.md](../connections.md#create-one)).

hl-crm-db fetches an access token when a step needs one, keeps it for the token lifetime, and fetches another when Salesforce answers 401.

Then the automation (`POST /v1/automations`, with `"dry_run": true` first):

```json
{
  "name": "Contact to Salesforce",
  "trigger": { "type": "event", "event": "contact.updated", "changed_fields": ["email", "first_name", "last_name", "phone"] },
  "actions": [
    {
      "type": "http_request", "id": "push", "method": "PATCH", "connection": "salesforce",
      "url": "/services/data/v62.0/sobjects/Contact/HLCRM_Id__c/{{record.id}}",
      "body": { "FirstName": "{{record.first_name}}", "LastName": "{{record.last_name}}", "Email": "{{record.email}}", "Phone": "{{record.phone}}" }
    },
    { "type": "update_record", "if": { "field": "salesforce_id", "op": "is_null", "value": true }, "values": { "salesforce_id": "{{steps.push.json.id}}" } }
  ],
  "hourly_cap": 500
}
```

A `PATCH` to an external ID path is Salesforce's upsert: it creates the contact if no contact has that `HLCRM_Id__c` and updates it otherwise. Replace `v62.0` with a version from the list in step 1. `LastName` is required by Salesforce on create. Make a second automation on `contact.created`.

### Keeping the Salesforce secret out of hl-crm-db

If you'd rather not store the client secret here, register a webhook for `contact.created` and `contact.updated` ([webhooks.md](../webhooks.md)) that points at a small service you run. It checks the signature, fetches a Salesforce token as in step 1 (and again after a 401), and sends the same `PATCH`. Webhooks are also retried for about 22 hours, which an `http_request` step is not.

## 4. Bring Salesforce records in

**In bulk.** Export contacts with Data Loader or a report, including the 18-character ID, then:

```sh
crm data import contact sf-contacts.csv --map "Id=salesforce_id" --map "Email=email" \
  --map "FirstName=first_name" --map "LastName=last_name" --key salesforce_id          # shows what would change
crm data import contact sf-contacts.csv … --key salesforce_id --apply
```

A later export imported the same way updates the contacts it knows and creates the rest.

**On a schedule.** An automation asks Salesforce for the contacts changed in the last hour and creates or updates each one here (`POST /v1/automations`, with `"dry_run": true` first):

```json
{
  "name": "Contacts from Salesforce",
  "trigger": { "type": "schedule", "every": { "hours": 1 } },
  "actions": [
    {
      "type": "http_request", "id": "fetch", "method": "GET", "connection": "salesforce",
      "url": "/services/data/v62.0/query?q=SELECT+Id,FirstName,LastName,Email,Phone+FROM+Contact+WHERE+LastModifiedDate+>+{{now-1h}}+ORDER+BY+LastModifiedDate+LIMIT+100"
    },
    {
      "type": "for_each", "items": "{{steps.fetch.json.records}}",
      "steps": [ {
        "type": "upsert_record", "object": "contact", "key": "salesforce_id",
        "values": { "salesforce_id": "{{item.Id}}", "first_name": "{{item.FirstName}}", "last_name": "{{item.LastName}}", "email": "{{item.Email}}", "phone": "{{item.Phone}}" }
      } ]
    }
  ],
  "hourly_cap": 10
}
```

- One run takes one page: at most 100 contacts here (the reply must stay under 64 KB), and at most 200 per run whatever the `LIMIT`. If more than that change in an hour, run it more often (every 15 minutes at the shortest) with a matching window, or use the bulk import for the backlog. There is no paging.
- `{{item.Id}}` and the other keys are written as Salesforce writes them, capitals included. The `Id` in a query reply is the 18-character form.
- The integration user must be able to read every field in the `SELECT`; Salesforce answers 400 otherwise, and the run is listed as failed.
- A contact changed here by this automation is then sent back by the push automation of section 3 once, since an automation only ignores its own changes. Salesforce's `LastModifiedDate` moves, so the next pull fetches it again and finds nothing to change, and it ends there. To avoid the echo, have the pull also set a field of your own and give the push a `condition` that leaves such changes out.

**As it happens.** Have Salesforce call hl-crm-db:

1. In hl-crm-db, create an API key with only the `ops:write` scope, for a member whose role can write only the objects Salesforce should touch (Settings → API keys).
2. In Salesforce, **Setup → Named Credentials**: an External Credential with a custom header `Authorization` = `Bearer <that key>`, and a Named Credential whose URL is your hl-crm-db API. Grant the External Credential's principal to the users whose changes should sync.
3. A record-triggered Flow on Contact with an **HTTP Callout** action (run asynchronously) that sends `POST /v1/objects/contact/records/upsert` with the body `{"key": "salesforce_id", "values": {"salesforce_id": "<the contact's Id>", "email": "…", "first_name": "…", "last_name": "…"}}`.

The request creates the contact, or updates the one with that `salesforce_id`, and answers with `action`: `created`, `updated` or `unchanged`. hl-crm-db must be reachable from Salesforce over HTTPS, which the Docker quick start is not; the schedule above needs no inbound access.

## 5. Both in one AI client

Salesforce offers hosted MCP servers for an org, reached through an External Client App of their own; see Salesforce's "Hosted MCP Servers" documentation for the address and setup in your org. Add one and hl-crm-db's ops server ([docs/mcp](../mcp/README.md)) to the same client, and the agent can read from one and write to the other with no sync: "take the open opportunities for the EMEA team from Salesforce and make a deal here for each, with its account and primary contact".

- Each person signs in to Salesforce with their own user, so the agent sees what they may see.
- Every write to hl-crm-db is in its audit log under the member whose key or sign-in the client used.
- Record content from either system is untrusted text to the agent. Read [prompt injection](../mcp/README.md#prompt-injection-what-protects-you-and-what-does-not) before letting an agent copy between them unattended.

## Keeping it safe

- The integration user's permission set is the real limit on what hl-crm-db can do in Salesforce. Keep it to the objects and fields you sync. Anyone with `automations:manage` in the workspace can write a step that uses the connection.
- The `api` scope alone is enough. Don't add `full` or `refresh_token`.
- Back up `HLCRM_MASTER_KEY`. Without it the stored client secret can't be read and has to be entered again.
- To rotate, generate a new consumer secret in the External Client App and enter it on the connection (**Change…**). No automation needs editing.
- Salesforce counts every call against the org's daily API request limit (**Setup → Company Information → API Requests, Last 24 Hours**). hl-crm-db sends at most 500 automation HTTP requests an hour per workspace by default (`AUTOMATION_HTTP_PER_HOUR`).
