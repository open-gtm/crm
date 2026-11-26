# Automations

An automation is "when **trigger** happens (and the record matches **condition**), run **steps**". It is stored as validated JSON; nothing in it is ever run as code. Creating, changing, pausing and archiving automations needs `automations:manage` (see [permissions](permissions.md)). The API is under `/v1/automations`; the admin MCP server and `crm automations` (see [cli.md](cli.md)) use the same API.

```json
{
  "name": "Welcome new contacts",
  "trigger": { "type": "event", "event": "contact.created" },
  "condition": { "field": "email", "op": "is_null", "value": false },
  "actions": [
    { "type": "send_email", "to": { "field": "email" }, "subject": "Welcome, {{record.first_name}}", "body": "Hi {{record.first_name}}, …" }
  ],
  "hourly_cap": 100
}
```

Every create and update can be sent with `"dry_run": true` first: it returns a plain-language `summary` (with every URL and email recipient as written), `warnings`, and for a schedule the `next_runs`. `POST /v1/automations/{id}/test` (or `POST /v1/automations/test` for a draft) runs it against one record, or with no record for a schedule, inside a transaction that is rolled back: records it would create or change are shown, HTTP requests and emails are described (exact URL, headers with secrets hidden, recipient) and never sent.

## Triggers

| Trigger | Shape | Starts with |
|---|---|---|
| Record event | `{"type": "event", "event": "deal.created"}` (`type` may be left out) | the record the event is about |
| Schedule | `{"type": "schedule", "daily": {"at": "09:00"}, "timezone": "Europe/Berlin"}` | no record |
| On request | `{"type": "manual", "object": "contact"}` (`object` optional) | the record asked for, or none |

**Events** that can trigger: `<object>.created`, `<object>.updated` (optionally only when one of `changed_fields` changed), `<object>.archived`, `<object>.restored`, `<object>.merged` (runs on the survivor), `deal.stage_changed`, `lead.converted`, `quote.sent` and `quote.accepted`, for every object including custom ones.

Deliberately **not** triggers:

- **Moved references after a merge.** A merge re-points references on other records, and each of those records gets an `<object>.updated` event with `reference_move: true` (`<object>.archived`, marked the same way, for a second copy the merge archived, such as a duplicate deal-contact link). One merge can touch up to 1,000 records, so `*.updated` and `*.archived` automations skip these unless the trigger sets `"include_reference_moves": true`. (Before step 5 they did trigger; this is a change for existing `*.updated` automations.) The duplicates themselves get their normal `<object>.archived` event (with `merged_into`), which does trigger, and the survivor `<object>.merged`.
- `alert.fired`: an alert would run an automation, which could fire the alert again.
- `schema.*`, `webhook.test`, `automation.*`: configuration and the engine's own events.

An automation never reacts to a change it made itself.

### The schedule language

One of:

| Rule | Example | Notes |
|---|---|---|
| `every` | `{"every": {"minutes": 30}}`, `{"every": {"hours": 6}}` | At least 15 minutes, at most 168 hours. Ticks are aligned to the clock in UTC (every 30 minutes runs at :00 and :30). |
| `daily` | `{"daily": {"at": "09:00"}}` | 24-hour local time. |
| `weekly` | `{"weekly": {"days": ["mon", "thu"], "at": "07:30"}}` | Days: `sun` … `sat`. |
| `monthly` | `{"monthly": {"day": 1, "at": "08:00"}}`, `{"day": "last"}` | A day past the month's end (31 in April) runs on the month's last day. |

Times are in the trigger's `timezone` (an IANA name such as `America/Denver`), or the workspace's (`PATCH /v1/automation-settings {"timezone": …}`, default UTC). A local time skipped by a daylight-saving change runs at the first moment after it. Cron strings are not accepted.

`GET /v1/automations/{id}/schedule?count=5` lists the next runs of a saved schedule; `POST /v1/automations/schedule-preview {"trigger": {…}}` does the same for a draft.

How schedules run: the next tick is stored on the automation (like an alert's deadlines). The worker locks due automations, adds one run per tick (a run is unique per automation and tick) and moves the next tick past now, all in one transaction, so a tick is queued exactly once. If the worker was down for several ticks, the automation runs once, not once per missed tick. A tick that comes while the previous run is still queued or running is recorded as a skipped run ("the previous run was still in progress"): runs of one automation never overlap.

A scheduled run has no trigger record, so its steps either work on fixed values (create a record, call a URL, email a member) or go through records with `for_each` over a query (below). `{{record…}}` placeholders, `condition`, and steps that need a current record are refused outside `for_each`.

### Running on request

`POST /v1/automations/{id}/run` with `{"records": ["con_…"]}` (up to 25; leave out for a schedule or a manual trigger without an object). Each record gets its own run; the response (202) has the run IDs, and `GET /v1/automations/{id}/runs` has the results. Any automation can be run this way: an event automation runs for the records you name, checking its condition when it runs, a schedule runs now.

A run acts with the automation's own access, not the caller's, so running needs one of:

- `automations:manage`, or
- a role the automation lists in `run_roles` (set by someone with `automations:manage`), together with `records:write`. Such a caller must be able to read every record they pass, gets run IDs back but never step output, can't do a dry run (it would show what the automation reads with its own access), and can't see the run history. A `run_roles` grant lets a member start what an admin designed, not reach past their own record access, so the request is also refused (403) when the automation **depends on** anything the caller's role can't read (the same set as for recipients, below: the trigger, condition, every `if`, `find_records` and `for_each` filter and sort, and every field a placeholder names), without saying which field, or when it **writes** an object or field the caller's role can't write. Otherwise `find_records secret eq X` followed by `update_record job_title = {{steps.f.count}}` would tell them a value they can't read.

The default is the first: `run_roles` is empty until an admin fills it. Requests are rate limited (they cost more than one request), count against the automation's `hourly_cap` (429 past it), and at most 25 requested runs of one automation can wait at a time. `{"dry_run": true}` (managers only) runs the first five records with no side effects and returns each one's steps. A record merged into another can't be run on (409, naming the survivor in `merged_into`): its references are on the survivor now.

**Which credential.** An API key, a browser session (with its CSRF token) and an app the member connected over OAuth can all ask, each with the permissions it carries: a connection's scopes narrow the member's role like a key's, so an `ops:read` connection never runs an automation (it has no `records:write`), even when the role is in `run_roles`. Only the admin MCP server has `run_automation`, and it defaults to a dry run. The run history's `requested_by` names the member; `requested_via` names the credential (`key`, `session`, or `oauth` with the grant and client), as the audit entry `automation.run_requested` does. The rate-limit cost and a dry run's heavy-request slot go to that credential; the hourly cap counts runs, whoever asked. See the credential table in [`docs/permissions.md`](permissions.md#sessions-and-keys).

## Steps

`actions` holds up to 20 steps (40 in all with `for_each` bodies). Every step may have an `id` (lowercase, used to reach its output as `{{steps.<id>.…}}`) and an `if` gate:

- a filter in the query language, checked against the current record: `"if": {"field": "amount", "op": "gt", "value": 10000}`, or
- a test on an earlier step's output: `"if": {"output": "{{steps.call.status}}", "op": "eq", "value": 200}` (ops: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `is_null`, `contains`).

A step whose gate does not match is skipped and logged as skipped.

The **current record** is the trigger record, or inside `for_each` the item.

| Step | Example | Output for later steps |
|---|---|---|
| `update_record` | `{"type": "update_record", "values": {"status": "contacted"}}`; `"record": "{{steps.person.id}}", "object": "contact"` updates another record (with `record`, `object` is required: the values are checked against it at save, and a record of another object is refused when it runs) | `id`, `record` |
| `create_record` | `{"type": "create_record", "object": "task", "values": {"title": "Call {{record.first_name}}", "assignee": "{{record.owner}}", "due_at": "{{today+2d}}", "related_to": ["{{record.id}}"]}}` | `id`, `record` |
| `upsert_record` | `{"type": "upsert_record", "id": "person", "object": "contact", "key": "email", "values": {"email": "{{record.email}}", "first_name": "{{record.first_name}}"}}` | `id`, `action` (`created`, `updated`, `unchanged`) |
| `find_records` | `{"type": "find_records", "id": "open", "object": "deal", "where": {"field": "account", "op": "eq", "value": "{{record.account}}"}, "limit": 50}` | `count`, `ids`, `records`, `first`, `truncated` |
| `notify` | `{"type": "notify", "title": "Big deal: {{record.name}}", "recipients": {"record_owner": true, "users": ["usr_…"]}}` | `notified` |
| `send_webhook` | `{"type": "send_webhook", "webhook": "whk_…"}` | `delivery` |
| `http_request` | see below | `status`, `ok`, `json`, `snippet` |
| `send_email` | see below | `sent` |
| `for_each` | `{"type": "for_each", "query": {"object": "contact", "where": {…}, "limit": 100}, "steps": [ … ]}` or `"over": "<find_records id>"`, or `"items": "{{steps.<http id>.json.<list>}}"` | `count`, `truncated` |
| `stop` | `{"type": "stop", "reason": "nothing to do"}` | ends the run (it succeeds; the reason is kept) |

**upsert_record** matches the way import does: the `key` is `id` or a field whose values are unique (custom unique fields, `contact.email`, `account.domain`), normalised as the database compares it (emails ignore case; domains are compared as domains). A match with nothing to change is left alone. More than one match fails the step.

**find_records** returns at most `limit` records (default 25, at most 200); `truncated` says more matched.

**The field types address, json, rating, percent and duration** ([`data-model.md`](data-model.md)) work in every step:

- **Writing.** A step writes a whole value under the field's name: an address as an object of its parts (`{"hq": {"line1": "{{record.street}}", "city": "Austin", "country": "US"}}`, or `"hq": "{{record.hq}}"` to copy a whole address), a json value as any JSON (strings inside it are filled; keys never are), a rating, percent or duration as a number (percent also as `"12.5%"`, duration also as `"PT1H30M"`). A part or path is not a field: `"hq.city"` or `"meta.a"` as a value key is refused at save. Values without placeholders are checked at save as the field checks them (a rating past its `max`, an unknown address part, a json value over 16 KB, a duration in years: 422); values with placeholders when the step runs, and a value the field refuses then is a `data` failure.
- **Filters and sorts.** `find_records`, `for_each` queries, step `if` gates and conditions filter by address parts (`{"field": "hq.city", …}`) and json paths (`{"field": "meta.plan.tier", "op": "eq", …}`), and sort by address parts (`[{"field": "hq.country"}, {"field": "hq.city"}]`) and by rating, percent and duration, through the query compiler at save, as `POST /v1/query` does. A whole address or json value can't be sorted.
- **Upsert keys** are `id` or a unique field, so never an address or json field (neither can be unique).
- **Who can read what.** A part or path depends on its field: a recipient, or a `run_roles` member running it, who can't read `hq` is treated as unable to read `hq.city`, `hq.display` or a sort by `hq.city` (skipped, or 403), and writing a part counts as writing the field.
- **Placeholders** reach into values: `{{record.hq.city}}`, `{{record.hq.display}}` (the one-line address), `{{record.meta.plan}}` (json keys must be lowercase names or list positions to be reachable), and the filters `duration` (`5400` → `1h 30m`) and `percent` / `percent:1` (`12.5` → `12.5%`). A restricted address or json field is refused at save, part by part, and a part of a value the automation holds as restricted is refused when it runs, never filled as empty.

**for_each** goes through the records of an earlier `find_records` step or of its own `query` (default 50, at most 200 per run), or through a list in an HTTP reply (below). When more records match than the cap, the run log says so (`truncated: true` and a note) and the rest are left for the next run. `for_each` can't be nested. Its body sees the item as `{{item.<field>}}`.

**for_each over an HTTP reply.** `"items": "{{steps.<id>.json.<path>}}"` names a list in the parsed JSON reply of an earlier `http_request` step, and the body runs once per element, at most 200 per run:

```json
{ "type": "http_request", "id": "fetch", "method": "GET", "connection": "salesforce",
  "url": "/services/data/v62.0/query?q=SELECT+Id,FirstName,LastName,Email+FROM+Contact+WHERE+LastModifiedDate+>+{{now-1h}}+LIMIT+100" },
{ "type": "for_each", "items": "{{steps.fetch.json.records}}", "steps": [
  { "type": "upsert_record", "object": "contact", "key": "salesforce_id",
    "values": { "salesforce_id": "{{item.Id}}", "first_name": "{{item.FirstName}}", "last_name": "{{item.LastName}}", "email": "{{item.Email}}" } } ] }
```

- `items` is exactly one placeholder into an `http_request` step's `json`. Inside the body `{{item.<key>}}` reads the element, with keys written as the other system writes them (capitals included). There is no current record, so steps that need one (`update_record` without `record`, `notify`, an `if` filter) are refused at save; `upsert_record`, `create_record` and `http_request` work.
- The elements are another system's data: they are filled in as values, bounded like any placeholder, and never evaluated.
- A reply is cut at 64 KB and must parse as JSON, so ask the other system for a page that fits (a `LIMIT`, a page size) and a window that matches the schedule (`{{now-1h}}` for an hourly run; `{{now-1h | epoch_ms}}` for APIs that take milliseconds). What didn't fit is not fetched: there is no paging.
- A reply that holds no list there fails the run as a data failure. On a deployment that allows private targets (`WEBHOOK_ALLOW_INSECURE_TARGETS=true`) replies are not kept, so there is nothing to go through.

### http_request

```json
{
  "type": "http_request", "id": "push", "method": "POST",
  "url": "https://api.example.com/contacts?source={{record.id}}",
  "headers": { "X-Source": "crm" },
  "secret_headers": { "Authorization": "Bearer …" },
  "body": { "email": "{{record.email}}", "name": "{{record.first_name}}" }
}
```

- The URL's scheme and host are fixed when the automation is saved; placeholders may only fill the path and query, each value percent-encoded as one part (a value can't add a path segment, a query parameter or another host). A filled path segment may not be empty, `.` or `..` (also written `%2e`), which the URL parser would drop or climb out of: `…/lists/123/members/{{record.x}}/tags` with `x = ".."` would otherwise call `…/lists/123/tags` with the same secret headers. After filling, the URL must have the template's number of path segments and every segment written without a placeholder unchanged; otherwise the step fails as a data failure (below).
- Sent through the same outbound guard as webhooks (`lib/outbound.ts`): `https://` only, no credentials in the URL, internal host names and private, loopback, link-local, CGNAT, reserved and metadata addresses refused, DNS resolved once and the connection pinned to the checked address, no redirects followed, 5 s DNS and 10 s request timeouts, replies cut at 64 KB.
- `body` is JSON: placeholders are filled as values, so a record value with quotes or line breaks can't change the document's shape. Only POST, PUT and PATCH take a body.
- Header values written in the automation may not hold line breaks or control characters (refused at save); control characters a placeholder brings in from a record are removed, so a record can't start another header. `Host`, `Content-Length`, `Content-Type`, `Transfer-Encoding`, `Connection` and other hop-by-hop headers, and names starting with `hlcrm-`, are not allowed. Every request carries `hlcrm-automation` and `hlcrm-run` headers.
- **`secret_headers`** are write-only: they are encrypted with the workspace's key, returned as `null` by the API, never written to logs, the run history or dry runs (shown as "(secret, not shown)"). Sending `null` back on an update keeps the stored value, unless the step now points at another host or changes the path before its first placeholder (`https://api.example.com/v1/lists/123/members/` in the example above): then the value must be given again. A step with secret headers needs an `id`.
- A reply with status 400 or higher, a timeout or a refused address fails the step and the run. Later steps can use `{{steps.<id>.status}}`, `ok`, `json` (parsed JSON, with credential-like keys censored) and `snippet` (the first 500 characters, censored the same way). When the deployment allows private targets (`WEBHOOK_ALLOW_INSECURE_TARGETS=true`), the target may be an internal service, so its reply is neither kept nor shown: only the status.
- **With private targets allowed, the status is still an oracle.** `status`, `ok` and the error (`network error (ECONNREFUSED)`, a timeout) can be tested in a later step's `if` and written to a record, so an admin can learn whether an internal host answers and with which status: one bit per request into the internal network. Only turn the setting on where everyone with `automations:manage` may probe the services the server can reach.
- The run log has the method, the URL without query values (they may carry personal data), header names, the status and the snippet. The audit log has `automation.http_request` with the host and status.
- Restricted values are never read: automations read records without `restricted:read`, a placeholder that names a restricted field (on the record, the item, or a step's found or written records) is refused when the automation is saved, in any step, and one that names a hidden field is refused in HTTP and email steps. A restricted value that reaches a placeholder another way (a whole record through `{{steps.found.first | json}}`) fails the step, whatever the step does: written to a record, the "[restricted]" the automation reads would replace the real value. The runner holds restricted values as a marker, not as text, so a record whose text is literally "[restricted]" is sent like any other.
- **Who set the URL.** A run started by a member's change, or by a member asking for it, skips an `http_request` whose URL is filled from a field that member changed (or from the record they chose), when their role can't read everything the run depends on (see send_email below).

**With a connection.** `"connection": "<key>"` names a [connection](connections.md), a credential stored once for the workspace. `url` is then a path (`"/v1/contacts/{{record.id}}"`) under the connection's base URL, and the connection adds its header, fetching an OAuth access token first when it needs one. Such a step can't set that header or have `secret_headers`. A 401 through an OAuth connection gets one new token and one more try. A connection that is turned off, or whose token request fails, fails the step as a configuration failure, with the status and OAuth error code of the token reply and nothing else from it.

**http_request or send_webhook?** Use `send_webhook` to deliver an event to a receiver you control: it is signed (Standard Webhooks), retried for about 22 hours, logged per delivery and replayable, and the payload is the event with the record. Use `http_request` to call someone else's API in the shape it expects (any method, your own JSON body and headers, an API key in a secret header): it is sent once per run, not signed and not retried, and later steps can use its reply.

### send_email

```json
{ "type": "send_email", "to": { "field": "email" }, "subject": "Your order {{record.name}}", "body": "Hello {{record.first_name}},\n…" }
```

`to` is exactly one of `{"member": "usr_…" or a member's email}`, `{"record_owner": true}`, `{"field": "<an email field of the current record>"}` or `{"address": "someone@example.com"}`.

- Plain text only. The subject is one line (line breaks and control characters removed, at most 200 characters); nothing in a record can add a header or a recipient. Every email ends with a line naming the workspace.
- **Addresses.** An address from a record (or a member's own, for an older member row from before sign-in's ASCII rule) is emailed when the record's email check would accept it (no spaces, one `@`, a dot in the domain) and it holds nothing that could change a header: no `<>,;:"()[]\`, no control characters, no leading, trailing or doubled dot. Only ASCII addresses are emailed (SMTP without SMTPUTF8 can't carry the rest; member addresses are ASCII already). An address that fails, or an empty email field, **skips that email** with the reason in the run log; the run goes on. A fixed `to.address` is checked the same way at save.
- **Members** (named, the record's owner, or an address that belongs to an active member) follow the notification rule: their role must be able to read the record and **everything the run depends on**, or they are skipped. That set is worked out from the definition, the same at save and at run: the trigger's object and fields, the condition, every `if` filter (on any step, `stop` included), every `find_records` and `for_each` filter and sort (inside `for_each` too), every field any placeholder names (through step outputs to the fields of the records they carry; a whole found record counts as every field of its object), the email field and the owner field used. Otherwise a member gated on `job_title eq "CEO"` learns the title from whether the email arrives. After any step whose gate or text uses another step's output (`if: {"output": "{{steps…}}"}` included), a member whose role has object or field rules gets nothing. Placeholders are filled from records as their role sees them. Saving names the members who will be skipped, as alerts do.
- **Anyone else** is new outbound reach, so it is off until an admin turns on `external_email` (`PATCH /v1/automation-settings`, not through MCP: refused for a key that sends an MCP surface and for any connected app). Until then the step fails with that message. Addresses on the workspace's **suppression list** are skipped. Each mailbox gets at most `AUTOMATION_EMAILS_PER_RECIPIENT_DAY` (default 5) automation emails a day from a workspace, counting `ann+anything@x.com` as `ann@x.com` (plus-addressing can't get past the cap); past that the email is skipped (the run goes on).
- **An address someone else controls gets what the run read.** External email carries the fields its template names, and the outcome of everything the run depends on, to whoever holds the recipient address. When the address comes from a record field (`to.field`) and the run was started by a member's change that touched that field (or by a member asking for a run on a record they chose), and that member's role can't read everything the run depends on, the email is skipped and the run log says why: otherwise a member who can write `email` but can't read `job_title` could point an email that holds the title at themselves. Saving warns, naming the roles that can't read it, whenever an automation emails addresses outside the workspace. Not covered: an address changed by an import or another automation, or by a member long before a later scheduled run. Keep external emails to what everyone who can change the address may read.
- The run log and the audit log (`automation.email_sent`) name a member by ID and anyone else by a keyed hash (`sha256:…`), never by address: the address is personal data from a record. A mail server's refusal often quotes the recipient ("550 <ann@…> rejected"); addresses are replaced by `<address>` in the run log and the server log.
- The suppression list: `POST /v1/email-suppressions {"email"}` and `POST /v1/email-suppressions/remove` (both need `automations:manage`: a key with only `records:write` could otherwise stop the workspace's email to anyone, and only an admin could undo it), and `POST /v1/email-suppressions/check` (`records:read`; the free-text reason is shown only to callers with `automations:manage`). An entry covers the mailbox: suppressing `ann@x.com` stops `ann+news@x.com`, and suppressing `ann+news@x.com` stops `ann@x.com` and every other `+tag` (one person's mailbox, whichever form they wrote). Only the keyed hash is stored. Removing an address is refused through MCP, like turning external email on. Mailboxes are compared in sign-in's canonical form (trimmed, ASCII letters lower-cased), so `Ann@X.com` and `ann@x.com` are one entry; non-ASCII addresses are refused (422). There is no unauthenticated "this address asked to stop" route yet.
- Email goes through the server's SMTP settings (`SMTP_URL`); with none, the step fails.

## Placeholders

`{{…}}` in step values, titles, URLs, headers, bodies and subjects. What they can reach:

| Placeholder | Is |
|---|---|
| `{{record.<field>}}` | the trigger record (read fresh at each step) |
| `{{item.<field>}}` | the current `for_each` item |
| `{{steps.<id>.<output>}}` | an earlier step's output; paths go into objects and lists: `{{steps.found.first.email}}`, `{{steps.found.records.0.id}}` |
| `{{event.type}}`, `{{event.id}}` | the triggering event (event runs) |
| `{{run.id}}`, `{{automation.id}}`, `{{automation.name}}` | this run and automation |
| `{{today}}`, `{{today+3d}}`, `{{now}}`, `{{now-2h}}` | dates (UTC); units `m`, `h`, `d` |

Filters, applied left to right: `upper`, `lower`, `trim`, `default:"text"`, `truncate:N`, `count`, `join:", "`, `number` / `number:2`, `date`, `datetime`, `epoch_ms` (milliseconds since 1970), `add_days:N`, `json`, `duration` (seconds as `1d 2h 3m 4s`), `percent` / `percent:1` (percentage points as `12.5%`). Example: `{{record.due_at | add_days:7 | date}}`.

Rules: a path is names and list positions only (field names are lowercase; the keys of an HTTP reply may have capitals), through own properties of plain objects (never a prototype, a method or anything outside the table above). Nothing is evaluated: a record value that looks like a placeholder is copied as text, not filled again. A value that is only a placeholder keeps its type (a number stays a number); inside text it becomes text. Each place escapes what it inserts: URL parts are percent-encoded (and a path segment can't be empty, `.` or `..`), header values lose control characters, email subjects are one line, JSON bodies take values as values. `number` takes 0 to 10 decimals and `add_days` −36,500 to 36,500, checked at save; a filter that can't use a value fails the step as a data failure.

**Size.** A text holds at most 50 placeholders, a step 200 (refused at save). What a fill produces is bounded while it is filled, per placeholder and in total, and the step fails as soon as it would pass: email body 64 KB, subject 200 characters, each header value 2 KB, URL 8 KB, HTTP body 64 KB, a record value its field's own maximum (2,000 characters for text, 100,000 for long text, or the field's `max_length`; 4 KB for an address, all parts together; 16 KB for a json value; 64 characters for a rating, percent or duration; 10,000 for other types), notification title 500 and body 4,000 characters, filters 16 KB. So one placeholder that yields a large step output can't be repeated into megabytes: `{{steps.f.records | json}}` forty times fails at 64 KB in an email body instead of building 6 MB.

## Limits

| Limit | Value |
|---|---|
| Runs per automation per hour | `hourly_cap`, default 100 (requests over it get 429; event and schedule runs past it are skipped) |
| Runs per automation per record in 10 minutes | 5; more are skipped as a loop |
| Causation depth (automations triggering automations) | 5 |
| Action steps per workspace per hour | `AUTOMATION_ACTIONS_PER_HOUR`, default 5,000; the operator can set another value for one workspace ([limits.md](limits.md)) |
| HTTP requests per workspace per hour | `AUTOMATION_HTTP_PER_HOUR`, default 500, or the workspace's own value; 20 per run |
| Emails per workspace / per automation per hour | `AUTOMATION_EMAILS_PER_HOUR` 200 (or the workspace's own value), `AUTOMATION_EMAILS_PER_AUTOMATION_HOUR` 50; 50 per run |
| Emails per recipient per day | `AUTOMATION_EMAILS_PER_RECIPIENT_DAY`, default 5 |
| Steps executed per run | 1,000 (each `for_each` iteration's steps count) |
| Run time | 10 s inside event processing, 60 s for a queued run, 20 s for a test; checked between steps and inside long ones (each `for_each` item, each recipient, before each query) |
| Event processing per workspace per pass of the worker | 2 s, checked between events (the rest wait for the next pass) |
| Step outputs kept during a run | 256 KB, and only the outputs a later step uses |
| Fill output | see Placeholders: Size |
| Step log of one run | 300 steps and 256 KB; each step's detail cut to 8 KB (long text and lists shortened) in run history and test replies |
| Automations per workspace | 200 |

A run that reaches a workspace or per-run cap is recorded as **skipped** with the cap named (`cap` in run history: `actions`, `http`, `email`, `email:<automation>`, `hourly`, or `run` for a per-run cap); one that runs out of time or steps **fails**. The first time a workspace or automation cap skips a run in its window (the hour), every member who can manage automations gets an inbox notification naming the cap; later skips in the same window only show in run history.

**Data failures don't pause automations.** Every failed run records what caused it (`failure` in run history):

- `data`: a value from a record or what the target said about it. A fill past its budget, a filter that can't use a value, a record value a field refuses, a URL whose path would change, a target's 4xx other than those below, a recipient the mail server refused (SMTP reply 501, 550, 551, 553 or 555). The step and run fail and are logged, but the run **doesn't count towards the automatic pause**: outside content (a web form, an import) must not be able to switch an admin's automation off and so drop later events. An address that can't be emailed, a suppressed address and a per-recipient cap **skip only that email**.
- `target`: 5xx, 408, 429, timeouts, DNS, TLS and connection errors, other SMTP errors.
- `config`: the automation's own definition or setup: 401, 403, 404, 405 and 407 (the wrong URL, or a missing or wrong key), a restricted value, external email off, no SMTP, the time or step budget.

`target` and `config` failures count. The server-wide email ceiling is no fault of the automation: the run is skipped as a cap, never failed. That ceiling (600 a minute per process) is automation email's own: sign-in codes and invitations have their own budgets in a separate store, so neither can use up or evict the other's.

**Archived and merged records.** `find_records` and `for_each` never return archived records. An `update_record` whose record was archived or merged after the run was queued (or that a placeholder names) is refused by the write side; the step fails as `data` (so it never counts towards the automatic pause), and the reason names the survivor of a merge. The update is not redirected to the survivor: its values were meant for the duplicate. A record ID written into the step itself is a `config` failure. `create_record`, `update_record` and `upsert_record` go through the normal record validation one record at a time (never the bulk routes, so no confirm token is involved); `upsert_record` matches as import does.

**Where runs happen.** An event automation whose steps are only plain record writes (`update_record`, `create_record`), `notify`, `send_webhook` and `stop` runs inside event processing, in the same transaction that marks the event processed: exactly once per event, all or nothing. Any automation with a step that queries (`find_records`, `upsert_record`, `for_each`), calls out (`http_request`) or emails (`send_email`), and every scheduled or requested run, is **queued**: the worker leases it and runs it step by step, each step's changes committed together with the run's cursor. Event processing gives each workspace at most 2 s per pass, so one workspace whose automations are slow delays the others' automations, alert triggers and webhook deliveries by about that, not until its queue is empty. If the worker stops mid-run, the run is picked up again after its lease (2 minutes) and continues after the last finished step, inside a `for_each` with the same items, and with the per-run counters it had (steps, HTTP requests, emails), so per-run caps hold across attempts. What is saved per step is small: the cursor, the loop's item IDs and the counters; the outputs only when one a later step uses changed, and the step log every 25 steps and around each send (a log entry or two can be missing after a stop). HTTP requests and emails are sent between transactions, so one that was sent just before a stop can be sent again (at least once). A run is given up after 3 attempts. One automation's queued runs never overlap.

**Fairness.** Each worker pass starts at most one queued run per workspace, at most four at once on a worker, and does not wait for slow runs: a workspace with a long run or a large backlog holds one slot while the others carry on, and the passes go round the workspaces in turn.

**Kill switches.** `POST /v1/automations/{id}/pause` (with an optional `reason`) stops new runs of one automation from events, its schedule and requests; queued runs are skipped; `.../resume` starts it again. `PATCH /v1/automation-settings {"paused": true}` does the same for every automation in the workspace. An automation whose runs fail 5 times in a row (`target` or `config` failures; `data` failures neither count nor reset the count) pauses itself, emits an `automation.paused` event and notifies every member who can manage automations, saying how many queued runs will be skipped. **Events and ticks while an automation (or the workspace) is paused are not replayed later**, whether the pause was by hand or automatic: resuming starts with the next event.

**Run history.** `GET /v1/automations/{id}/runs` (with `status` and `limit`) lists runs newest first: how it was triggered (`event`, `schedule`, `manual`, with the event, tick or requester), status (`queued`, `running`, `succeeded`, `failed`, `skipped`), the reason, `cap` (the cap behind a skip), `failure` (`data`, `target` or `config`), and each step's redacted inputs and outcome. `crm automations runs` shows these as `skipped (cap)` and `failed (data)`. Runs are kept 90 days.

## Not supported in this version

- Delays, waits and "send a reminder in 3 days" (use a schedule, or an alert rule's time trigger).
- Loops other than `for_each`, nested `for_each`, branches beyond `if` and `stop`, and running code of any kind.
- Cron expressions; schedules more often than every 15 minutes.
- HTML email, attachments, a reply-to or sender per automation, and a one-click unsubscribe link (suppressions are added through the API).
- Retries of a failed `http_request` (use `send_webhook` for retried delivery).
- Automations in the schema document (`crm schema pull/apply`): see below.

## Automations and schema-as-code

Automations are not in the schema document. A later "pack" that exports and imports them would need: stable automation IDs (the `auto_…` IDs), steps that name webhooks, members and roles by something that survives a move between workspaces (or a mapping at import), secret header values left out of the export and asked for again on import (the API already treats them as write-only), and the import applied as a dry run first, since an imported automation can send data out.
