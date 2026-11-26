# Workspace limits

A server can hold many workspaces. A limit says how much one of them may hold or do, so that one workspace cannot use up a server it shares with others. Whoever runs the server sets the limits. Nothing in the API, the MCP servers, the CLI or the web UI changes one, whatever the caller's role.

The design and the reasons for it are in [ADR 0019](decisions/0019-workspace-limits.md).

## The limits

Each limit has a server-wide default, read from an environment setting. The value is a whole number, or `unlimited`.

| Limit | What it counts | Setting | Default |
|---|---|---|---|
| `records` | Records of every object, archived ones included. Activities, tasks, quote and order lines and the link between a contact and an account are records too | `LIMIT_RECORDS` | unlimited |
| `members` | Members who can sign in. Disabled members don't count | `LIMIT_MEMBERS` | unlimited |
| `service_accounts` | Service accounts that aren't disabled | `LIMIT_SERVICE_ACCOUNTS` | unlimited |
| `api_keys` | API keys that work: not revoked, not expired | `LIMIT_API_KEYS` | unlimited |
| `custom_objects` | Custom objects | `LIMIT_CUSTOM_OBJECTS` | 100 |
| `custom_fields` | Custom fields in the whole workspace, on standard and custom objects. One object holds at most 300 fields whatever this says | `LIMIT_CUSTOM_FIELDS` | unlimited |
| `webhooks` | Webhook endpoints that aren't archived | `LIMIT_WEBHOOKS` | 50 |
| `automations` | Automations that aren't archived | `LIMIT_AUTOMATIONS` | 200 |
| `file_storage_mb` | What the files attached to records hold in all, in MB | `FILE_QUOTA_MB` | 1024 |
| `requests_per_minute` | API requests in a minute from all the workspace's keys, people and connected apps together | `LIMIT_REQUESTS_PER_MINUTE` | unlimited |
| `automation_actions_per_hour` | Action steps automations run in a clock hour | `AUTOMATION_ACTIONS_PER_HOUR` | 5000 |
| `automation_http_per_hour` | HTTP requests automations send in a clock hour | `AUTOMATION_HTTP_PER_HOUR` | 500 |
| `automation_emails_per_hour` | Emails automations send in a clock hour | `AUTOMATION_EMAILS_PER_HOUR` | 200 |

The defaults change nothing for a server that was running before limits existed. What had no ceiling still has none, and custom objects, webhooks and automations keep the ceilings they always had.

Other ceilings are the same for every workspace and are not limits in this sense: the size of one file (`FILE_MAX_MB`), 300 fields on one object, 500 shared views, the sizes of a batch, an import and a bulk change, and each key's own request rate (20 a second, bursts of 200).

## Setting a limit for one workspace

The `limits` command shows one workspace's limits, and sets them when it is given `key=value` pairs:

```sh
docker compose run --rm migrate limits --workspace ws_01JD…
docker compose run --rm migrate limits --workspace ws_01JD… records=50000 members=10 requests_per_minute=600
docker compose run --rm migrate limits --workspace ws_01JD… webhooks=unlimited automations=default
```

A value is a whole number, `unlimited`, or `default` to go back to the server's setting. The command prints every limit of the workspace and whether its value is the server's default or was set for this workspace.

- **It runs where `migrate` runs.** The command connects with `MIGRATOR_DATABASE_URL`. The limits are kept in a table the API's database role can read and cannot write, so no request to the API can change a limit, even through a flaw in the API. Without Docker Compose: `hl-crm-db-server limits --workspace ws_… records=50000`, with `MIGRATOR_DATABASE_URL` set.
- **It reads the same settings as the API.** Compose passes the limit settings to the `migrate` service too, so "server default" in what the command prints is what the API uses.
- **Each change is written to the workspace's audit log** as `workspace.limits_changed`, with the old and new values, so the workspace's owners can see it.
- **A change applies at once**, except `requests_per_minute`, which each API process picks up within 30 seconds.
- **Lowering a limit below what a workspace holds removes nothing.** The workspace keeps what it has and can add no more until it is under the limit again.

## What a workspace sees

`GET /v1/workspace/usage` returns what the workspace uses against each limit. It needs a configuration permission (any of `members:manage`, `schema:manage`, `keys:manage`, `webhooks:manage`, `automations:manage`, `audit:read`). `crm usage` prints the same, and the admin MCP server has it as the `get_usage` tool.

```json
{ "data": { "limits": [
  { "key": "records", "description": "Records of every object, archived ones included", "kind": "count", "used": 48211, "limit": 50000, "source": "workspace" },
  { "key": "webhooks", "description": "Webhook endpoints that aren't archived", "kind": "count", "used": 3, "limit": 50, "source": "server" },
  { "key": "requests_per_minute", "description": "…", "kind": "rate", "used": null, "limit": 600, "source": "workspace" }
] } }
```

`limit: null` is unlimited. `source` is `workspace` when the operator set the value for this workspace, else `server`. Hourly limits report the current clock hour. `used` is `null` for `requests_per_minute`, which each API process counts in its own memory.

## What a refused request looks like

A request that would pass a limit is refused with status 409 and the code `limit_reached`. Nothing is changed.

```json
{ "status": 409, "code": "limit_reached",
  "detail": "This workspace is at its limit of 50000 records (50000 in use). Free some up, or ask whoever runs the server to raise the limit.",
  "errors": { "limit": "records", "used": 50000, "max": 50000, "adding": 1 } }
```

Through an MCP server the same text and details reach the agent as the tool's error, so it can say which limit is full.

- A batch create and an import are all or nothing, as before: if some rows don't fit, none are made. A dry run marks the rows that would not fit. A failed import answers 422 `import_failed` as for any other row error, and each failed row carries the same `errors` object.
- A workspace over its request rate gets 429 `rate_limited` with a `Retry-After` header and `errors: { "limit": "requests_per_minute", "max": … }`.
- An automation that reaches an hourly cap stops as it did before limits existed: the run is skipped or fails with the reason, and admins are told once per window ([automations.md](automations.md)).

## How records are counted

- **Archived records count.** An archived record is still stored and can be restored, so archiving frees no room, and restoring needs none.
- **Anything that adds a record is refused at the limit**, including a step that adds one on the side: completing a task logs an activity, converting a lead logs one, accepting a quote makes an order with its lines.
- **The count is exact.** Of several requests competing for the last place, one gets it. They wait for each other only at the moment they commit, so a long import does not hold up other requests.
- **Reading the count is cheap.** The database keeps a running sum, so neither `GET /v1/workspace/usage` nor a create counts rows. The worker folds the sum's parts together every few minutes; nothing depends on that having run.

## What is not built

- **Limits per object** (so many deals, so many contacts). The limit is on all records together.
- **A warning before a limit is reached.** A workspace learns it is full when a request is refused, or by reading its usage.
- **Request rates shared across API processes.** Each process counts for itself, like every rate limit in this server, so a workspace served by three API processes can make up to three times its `requests_per_minute`.
- **Limits on tables that grow with use** but have no limit of their own: the audit log, events, webhook deliveries and notifications. Events and deliveries are pruned after 90 days; the audit log is kept.
