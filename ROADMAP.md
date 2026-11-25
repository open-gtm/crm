# Roadmap

hl-crm-db is an open-source, self-hostable CRM database: a Postgres-backed schema engine and record API, a web UI, MCP servers for AI agents, a command-line tool and a TypeScript SDK, all from one Docker image. This page says what exists, what is likely next and what is deliberately left out. It is a statement of intent, not a promise of dates.

Version: **0.1 (Phase 1, MVP).** The software has had automated testing (unit, integration, cross-tenant isolation and browser tests) and no independent security audit or production track record. Treat it accordingly, and read [`SECURITY.md`](SECURITY.md) and the [threat model](docs/security/threat-model.md) before storing real customer data.

## Built

- **Foundations.** One Docker image with `api`, `mcp`, `worker` and `migrate` commands; Postgres as the only required dependency; workspaces isolated with row-level security; roles and permissions with per-object and per-field rules, and permission sets that add access on top of a role; scoped API keys; field-level encryption for restricted values; a tamper-evident audit log.
- **Schema engine.** Standard objects (contacts, accounts, leads, deals, activities, tasks) plus custom objects and fields in one call; 19 field types including address, json, rating, percent and duration; relations; pipelines; schema history.
- **Records API.** REST `/v1` with an OpenAPI document, idempotency keys, `If-Match`, filters across relations, sorting, counts, aggregates, saved views, search, merges, duplicate finder, bulk changes, restore and timelines.
- **MCP servers.** Ops and admin servers over HTTP and stdio, dry-run by default for changes, confirmation tokens, OAuth for remote clients (not yet verified against the hosted clients themselves; see below).
- **People and sign-in.** Browser sessions: email code or link, password, single sign-on (OpenID Connect) and a server-printed link; invite-only.
- **Events and automations.** Outbox, signed webhooks with retries and replay, alerts and notifications, automations with schedules, HTTP requests, email, loops and caps.
- **`crm` CLI.** Schema-as-code (`pull`, `plan`, `apply`), CSV and NDJSON import and export, keys, members, roles, webhooks, automations, audit, and schema packs. Build it from source for now.
- **Schema packs.** Shareable workspace setups (objects, fields, pipelines, roles, shared views), with two MIT example packs (recruiting, support desk).
- **Quotes and orders.** A quote is made for a deal, priced by its lines, sent (then fixed), revised, and accepted, which makes an order and marks the deal won. Both behaviours are workspace settings.
- **Files and notes.** Files attached to any record (Postgres by default, S3-compatible as an option, sealed with the workspace's key there), always served as downloads; notes in Markdown, shown formatted, that can carry files.
- **Web UI.** Lists with filters, sorting and saved views, as a table, a board for any object, a calendar or a grouped table with totals; record pages with timelines, notes and files, with sections that can be arranged per object; a deals board; tasks and inbox; command palette; settings for members, roles, API keys, webhooks, audit log, schema, and read-only automations and installed packs.

## Next

Roughly in this order; the order can change with what testers ask for.

1. **First releases.** Tag `v0.1.0` and publish the image (amd64 and arm64) so the quick start no longer needs a local build; publish the CLI to npm.
2. **Real-client verification of OAuth for MCP** with Claude, ChatGPT and Cursor, and fixes from what that shows.
3. **A `file` field type**, and a virus-scanner hook for uploads ([ADR 0011](docs/decisions/0011-files-and-attachments.md)). Files attached to records are built.
4. **Multi-factor authentication or passkeys** for people sign-in.
5. **Browser editing for automations and packs** (today: CLI and API; the UI lists them read-only).
6. **Sandbox workspaces and promoting a schema** from one workspace to another as a reviewed step.
7. **Records housekeeping:** unmerge, erase, per-workspace quotas, data-key rotation.
8. **A hosted version** is planned. Self-hosting stays a first-class way to run it.

## Designed, not built

- **The rest of commerce, and billing** (a product catalogue with prices, contracts, invoices, payments): quotes and orders are built; for the rest, the data model is in [`docs/data-model.md`](docs/data-model.md), but no tables, API routes or tools exist for it yet.
- **A pack directory** (browse and download packs), with pack signing and review ([`docs/packs.md`](docs/packs.md)).
- **Slack, SMS and push** notification channels: the delivery table has a `channel` column for them ([ADR 0006](docs/decisions/0006-alerts-and-notifications.md)); today notifications go to the in-app inbox and email.

## Deliberately not built

- **Telemetry.** Nothing is sent anywhere by default.
- **A public form-submission endpoint.** Capture leads through the API or MCP with your own key.
- **Extra infrastructure.** No Redis, message broker or search service: Postgres does the queues, search and scheduling.
- **Dedicated database per workspace, table partitioning, and per-field indexes for custom fields.** Shared tables with row-level security are sized for about a million rows per large workspace; these come when a workload needs them.
- **Record-level sharing** ("only records I own"). Access rules are per object and per field.
- **SCIM, self sign-up, and creating workspaces from the browser.** Workspaces are created by the operator (`bootstrap`); only existing members can sign in.
- **Compliance claims.** The project makes none (for example "SOC 2 compliant"). The software provides isolation, roles, encryption and an audit log; running it securely is the operator's job.

## How decisions are made

Significant design choices are written down as short records in [`docs/decisions/`](docs/decisions). Open a pull request (after signing the [CLA](CLA.md)) or an issue to propose a change; new API routes need a cross-tenant test, see [`CONTRIBUTING.md`](CONTRIBUTING.md).
