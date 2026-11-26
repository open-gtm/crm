# Where a change came from

hl-crm-db is changed by people in the web UI, by agents over MCP, by scripts with API keys and by the `crm` command-line tool. Configuration changes say which of these made them, so that a person looking at the schema or a page layout can tell what an agent did.

## What is recorded

| | Meaning |
|---|---|
| `surface` | How the request arrived: `web` (a signed-in person), `admin-mcp` or `ops-mcp` (an MCP server), `cli` (the `crm` tool), `api` (an API key used directly), `automation`, `system` |
| `actor` | The member or service account it acted as (`usr_…`, `svc_…`) |
| `via` | The connected app or API key it came through, by the name it had then: "Claude Desktop", "Billing sync". Null for a browser session |
| `pack` | The schema pack that made the change, when one did |

`via` is a label for people. A key can be renamed and two can share a name; the audit log has the key and OAuth grant IDs.

The surface of an API key's request is what its client reports in the `X-HLCRM-Surface` header (the MCP servers and the CLI set it). A connected app's surface is fixed by its token. It tells honest clients apart; it is not a security boundary.

## Where it is shown

- **Schema changes.** `GET /v1/schema/changes` (and the admin MCP `get_schema_changes`) list every change with `surface`, `actor`, `via` and `pack`; `?object=` narrows it to one object and its fields. Needs `audit:read`.
- **Objects and fields.** `GET /v1/objects` and `GET /v1/objects/{object}` give each object's and field's `origin`: `standard` (built in), `custom` (made in this workspace) or `pack`, with the pack's name. Callers with `audit:read` also get `last_change` beside the object and each field: what changed, when, and its source.
- **Events.** An event's `actor` has the surface and, in `GET /v1/events`, `via`: on the caller's own events and for callers with `audit:read`; to others the surface is enough. The list filters by `actor` (`me` or an ID), `surface` (`agents` is API keys, the CLI and both MCP servers together) and `since`. Webhook payloads don't carry `via`.
- **Summaries for admins.** `GET /v1/events/summary` (`audit:read`) counts changes per member, surface and app or key over the last hours (24 by default, 168 at most). Reads are not recorded, so it counts changes only. `GET /v1/automations/runs/summary` counts every automation's runs by status, with each one's newest failure.
- **Page layouts.** Every change to a layout's shared draft and every published version carries its source ([ADR 0017](decisions/0017-agent-first-page-layouts.md)).

The web UI shows these in Settings → Objects & fields, in the layout editor's history, on a record's "Changes by agents", and on Home ("Your agents", and the admin Home).
