# 0019: Per-workspace limits and usage

Status: accepted (2026-11-25)

## Context

The server was built for one operator running one or a few workspaces they trust. A hosted version puts many workspaces of strangers on one server, and one of them must not be able to use it up. This record takes stock of what was already bounded, adds the ceilings that were missing, and gives the operator a way to set them per workspace (a hosted service maps its plans to them).

### What was already capped, and how

| What | Ceiling | Scope | Where |
|---|---|---|---|
| Files | `FILE_QUOTA_MB` (1024) in all, `FILE_MAX_MB` (10) each, 100 per record | workspace, server-wide value | `core/files.ts`, counted under an advisory lock |
| Automation work | `AUTOMATION_ACTIONS_PER_HOUR` 5000, `_HTTP_` 500, `_EMAILS_` 200 | workspace, server-wide value | `automation_usage` fixed windows in Postgres |
| Automation email | 50 per automation per hour, 5 per recipient per day | automation, recipient | same |
| Custom objects | 100 | workspace, fixed in code | `core/schema.ts` |
| Fields | 300 per object (500 ever, archived included) | object | `core/schema.ts` |
| Webhooks | 50 | workspace, fixed in code | `core/webhooks.ts`, counted without a lock |
| Automations | 200 | workspace, fixed in code | `core/automations.ts`, counted without a lock |
| Shared views | 500; 200 personal per member | workspace, member | `core/views.ts` |
| Preferences | 100 keys, 64 KB per member | member | `core/directory.ts` |
| Connected apps | 50 live grants per member | member | `oauth/authorize.ts` |
| One request's size | 1 MB body, 100 records a batch, 500 rows an import or bulk change, 5000 rows an export, `PACK_LIMITS` | request | each feature |
| Request rate | 20 a second, bursts of 200 | credential (a key, a member's sessions, a connected app) | `api/app.ts`, in memory |
| Long requests | 2 at once per credential, half the pool server-wide | credential, server | `api/app.ts` heavy gate |
| Failed authentication | 30 a minute per address, 10 per key prefix | address | `api/app.ts`, `auth/limits.ts`, in memory |

### What had no ceiling per workspace

- **Records.** Any number, through the API, imports and automations.
- **Members and service accounts.**
- **API keys.** And since the request rate is per key, a workspace could raise its own request rate by minting keys.
- **Custom fields in all.** Bounded only as 100 objects times 300 fields.
- **Requests from the workspace as a whole.**
- Tables that grow with use: the audit log, events, webhook deliveries, notifications. Events and deliveries are pruned after 90 days.

Nothing could be set for one workspace: every ceiling was a constant or one server-wide setting.

## Decision

### One list of limits, each with a server default and a per-workspace value

`core/limits.ts` names thirteen limits: `records`, `members`, `service_accounts`, `api_keys`, `custom_objects`, `custom_fields`, `webhooks`, `automations`, `file_storage_mb`, `requests_per_minute`, and the three hourly automation caps. Each has a server-wide default from an environment setting, and each can have another value for one workspace. A value is a whole number or unlimited.

The existing file quota and the three per-workspace automation caps are in the list under their existing setting names, so they can be set per workspace like the rest. The per-automation and per-recipient email caps are not: they protect the people being emailed, not the server's capacity, and a plan should not buy more of them. The largest single file (`FILE_MAX_MB`) is not either: it sizes the request body limit before the caller is known.

**The defaults change nothing for a running server.** What had no ceiling has none by default (`LIMIT_RECORDS`, `LIMIT_MEMBERS`, `LIMIT_SERVICE_ACCOUNTS`, `LIMIT_API_KEYS`, `LIMIT_CUSTOM_FIELDS`, `LIMIT_REQUESTS_PER_MINUTE`), and the three fixed ceilings keep their values as defaults (`LIMIT_CUSTOM_OBJECTS` 100, `LIMIT_WEBHOOKS` 50, `LIMIT_AUTOMATIONS` 200). A default ceiling on records, however generous, would one day refuse writes on a self-hosted install that was working, on the day it upgraded or the day it grew past it. An operator who shares a server sets the ceilings; one who doesn't is not surprised by them.

Unlimited is written `unlimited`, not `0`: for the automation caps `0` already means "none allowed", and one spelling has to work for every limit.

### Only the operator sets a limit, and the database enforces that

Per-workspace values are rows of `tenant_limits` (a NULL value is unlimited; no row is the server default). The app's database role can read the table and has no INSERT, UPDATE or DELETE on it. The `limits` command writes it, connected as the migrator role, the way `migrate` connects.

So "no API request can change a limit" does not rest on there being no route for it, or on a permission check being right. A request that reached the database through a flaw in the API would still be refused by Postgres. A hosted control plane sets limits with the command or with its own migrator-role connection.

The cost is that the command needs `MIGRATOR_DATABASE_URL`, so in Compose it runs in the `migrate` service, which now also receives the limit settings so that what it prints as "server default" is what the API uses.

Every change is written to the workspace's audit log (`workspace.limits_changed`, actor `system`, surface `cli`, old and new values), so owners can see that and when a limit moved.

### One refusal

A request that would pass a limit gets 409 `limit_reached` with `errors: { limit, used, max, adding }` and a sentence that names the limit and what is in use. The MCP servers pass the code, the sentence and the details to the agent as the tool's error text.

This changes two existing responses. A 101st custom object answered 422 `validation_failed`, and a 51st webhook or 201st automation answered 409 `conflict`; all three now answer 409 `limit_reached`. The file quota answered 409 `conflict` and now answers 409 `limit_reached`. Clients that matched on the status of the webhook, automation and file cases are unaffected; a client that matched 422 for the custom object ceiling is.

The request rate keeps 429 `rate_limited` with `Retry-After`, and adds `errors: { limit: "requests_per_minute", max }`. Automation caps keep their own behaviour inside a run (the run is skipped or fails with the reason, and admins are told once per window).

### Counting things that are few

Members, service accounts, API keys, webhooks and automations are counted with a query at the moment one is added, under a per-workspace advisory lock for that kind of thing, held to the commit. Two requests for the last place can't both get it. Webhooks and automations were counted without a lock before; they are exact now. Nothing is locked or counted when the limit is unlimited, or in a dry run.

- Members and service accounts count while they are not disabled. Re-enabling one takes a place, like adding one.
- API keys count while they work (not revoked, not expired). A rotation's replacement is not checked: it stands in for the key it retires, and refusing a rotation at the limit would stop a workspace doing the safe thing. The two keys a new workspace starts with are not checked either.
- Custom objects and custom fields are counted from the loaded schema, under the schema lock every schema change already takes. That covers the API, schema-as-code apply and packs, which all go through `createObject` and `addField`. A pack that restores an archived object or field is checked too.

### Counting records

Records are the one thing too many to count on every insert. A million-row `count(*)` per create is not acceptable, and neither is a counter row that every create in a workspace locks until it commits: a 500-row import would hold it for seconds, single creates would queue behind it into their statement timeout, and it would add a lock that can deadlock against the unique-value locks.

**A sum of per-transaction rows.** Every record of every object already passes through `record_registry`. A trigger on it adds one to (or takes one from) the row of `record_counts` keyed by the workspace and the current transaction's ID. Each transaction touches only its own row, so creates never wait for each other. The count is `sum(delta)`, a short index scan; it includes what the reading transaction has added itself. Counting in the database, at the one table every record passes through, covers every path that makes a record: single and batch create, import, automations, lead conversion, quotes and orders with their lines, the activity logged when a task is completed, and paths added later. It also covers removal: when records are hard-deleted (a workspace purge, an erasure), the count follows without that code knowing about limits.

Rows are folded into one total row (transaction ID 0) by the worker every five minutes for workspaces with more than 200 of them, and by a transaction that holds the lock described next. Folding deletes only rows it can see, which are committed, and adds their sum to the total in the same statement, so every reader sees the same sum before and after. Nothing depends on folding having run; it keeps the sum short.

**Two checks.** `claimRecords` is called before a record is inserted. It reads the count without a lock and refuses when the new records would not fit. That is the plain, early refusal, and what a dry run reports. It cannot see records other transactions are adding at that moment.

So a transaction that added records also runs an exact check just before it commits (`withTenant` runs registered checks once its work is done). It takes a per-workspace lock, reads the sum, and fails, rolling the transaction back, if the workspace is over. Whoever holds the lock has seen every earlier committer's records, so of several requests for the last place exactly one succeeds. The lock is held for the commit only, not for the work before it, so a long import does not hold up other creates.

A missed `claimRecords` call on some future path cannot corrupt the count, because the trigger keeps it. The worst it does is let that path's records through uncounted against the limit until the next create that is checked.

**Archived records count.** They are stored, they can be restored, and restoring must not fail for lack of room. The limit is on what the workspace holds.

**Every record counts**, including activities, tasks, quote and order lines and the contact-to-account link, because each is a row of `record_registry`. An operation that adds a record on the side is refused at the limit like any other create.

Limits are not checked when a workspace is created (it holds no records) and reading a limit costs one small query per transaction, remembered for the rest of it.

### The request rate

A token bucket per workspace in the API process, a minute's worth deep, checked after the credential's own bucket and charged the same tokens (a route's `cost` included). It is what stops a workspace multiplying its rate by minting keys. The limit is read with a short query and remembered for 30 seconds per process, since it is needed before the request has a transaction; a change therefore takes up to 30 seconds to apply. Every other limit is read in the request's transaction and applies at once.

It is in memory and per process, like every rate limit here (see the security review's note on replicas). A shared store is a separate decision that would cover all of them.

### Reading usage

`GET /v1/workspace/usage` returns every limit with what is in use, the ceiling, and whether the ceiling is the server's default or the workspace's own. It needs any configuration permission (`members:manage`, `schema:manage`, `keys:manage`, `webhooks:manage`, `automations:manage` or `audit:read`): whoever can run into a limit can read them, and the figures are no more than those permissions already show. A new permission was not worth adding for it. It is an admin-scope route, so the ops MCP server does not have it; the admin MCP server has it as `get_usage`, and the CLI as `crm usage`.

## Consequences

- A self-hosted install behaves as before, apart from the changed error for the three fixed ceilings and the file quota.
- A hosted operator sets server-wide defaults in the environment and per-plan values per workspace with `limits`.
- `tenant_limits` and `record_counts` reference `tenant_directory` with `ON DELETE CASCADE`, and the counting trigger does nothing for a workspace whose directory row is gone, so deleting a workspace needs no special handling of either table.
- Every record insert and delete now also writes the transaction's row in `record_counts` (an upsert on the primary key).
- Upgrading counts each workspace's records once, in the migration: one `count(*)` over `record_registry` per workspace.
- Lowering a limit below what a workspace holds removes nothing; the workspace can add no more until it is under.

## Left for later

- Limits per object, a warning before a limit is reached, and events or notifications when one is.
- Request rates shared across API processes.
- Ceilings on the audit log, events, webhook deliveries and notifications.
- Showing usage in the web UI's settings.
