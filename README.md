# hl-crm-db

hl-crm-db (headless CRM database) is an open-source CRM backend with no required UI: a database, schema engine, record API and MCP servers. Work with it from Claude or any MCP client, from your own code through the REST API, from the `crm` command-line tool, or in a browser with the web UI the API serves. Self-host it with Docker: Postgres is the only other dependency.

Status: **v0.1, Phase 1 MVP.** Built: foundations, schema engine and custom objects, records API with saved views, merges, bulk changes and restore, MCP servers with OAuth for remote clients, people sign-in from a browser, a web UI, events and automations (schedules, HTTP requests, email, loops), signed webhooks, alerts and notifications, the `crm` CLI with schema-as-code and CSV import and export, field types from text to address, json, rating, percent and duration, and schema packs that set up a workspace for a use case (recruiting, a support desk). See [`ROADMAP.md`](ROADMAP.md) for what is built, what is next and what is deliberately left out.

**What to expect.** This is a first release for testers. It has automated tests (unit, integration, cross-tenant isolation and browser tests) but no independent security audit and no production track record, and there is no published image or npm package yet. Back up your database and your `.env` (it holds the encryption master key), and report problems through the repository's issues (security problems: see [`SECURITY.md`](SECURITY.md)).


## Quick start (Docker)

Needs [Docker](https://docs.docker.com/get-docker/) with Compose, and Git. Allow about 10 minutes, most of it the first build of the image.

No release image is published yet (`ghcr.io/open-gtm/crm` does not exist until a release is tagged), so these steps build the image from this checkout. Run them in a terminal:

```sh
git clone https://github.com/open-gtm/crm.git && cd crm
sh scripts/init-env.sh   # writes .env with random secrets (never commit it)
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml   # use the image built from this checkout
docker compose up -d --build   # builds the image, then starts Postgres, migrations, API (:8787), MCP (:8788), worker
docker compose run --rm api bootstrap --name "My Company" --email you@example.com --owner-name "Your Name"
docker compose run --rm api sign-in-link --email you@example.com
```

- `docker compose up -d --build` is finished when `docker compose ps` shows `api` and `mcp` as `healthy` (the `migrate` service exits by itself once the database is set up).
- `bootstrap` prints two API keys, once. Keep them in a password manager (see below). It also prints the next command to run, `sign-in-link`, with your email and the new workspace's ID.
- `sign-in-link` prints a one-time address. Open it in your browser and press **Continue**: you are signed in to the web UI as the owner. The link works once and for 15 minutes; print another any time with the same command. (It needs `PUBLIC_URL`, which `init-env.sh` sets to `http://localhost:8787`.)
- The first page after that link is a short welcome that offers to **set a password**. Do it: without a password (and with no email set up) the only way back in is another `sign-in-link`. If you skip it, a card on Home and a note in Settings → Account keep offering it.
- Some actions need a sign-in in the last 10 minutes: creating or rotating an API key, changing your password. Later than that, the app asks you to confirm it's you with your password. With no password yet, it shows the exact `sign-in-link` command to run instead (with `--return-to`, so the new link brings you back to the same page); open the link in the same browser and what you were doing carries on.
- Run the `export COMPOSE_FILE=…` line again in any new terminal, or every `docker compose` command will try to pull the image that doesn't exist yet. Once a release is published, leave it out and Compose pulls the image (amd64 and arm64).

The two keys:

- **Admin key**: changes the shape of the CRM (objects, fields, pipelines), manages members and keys, and can read and write data.
- **Ops key**: everyday work with records. It cannot change the schema.

**Roles and permissions.** Each member has one role (owner, admin, member, read_only, or a custom role you define), and a role is a set of permissions, optionally with rules per object and per field. A member can also hold permission sets, which add access on top of the role: per object and field, and per feature. A key's scopes can only narrow what its member is allowed, never widen it. Roles and permission sets are managed in the web UI (Settings → Roles, Settings → Permission sets), with `crm roles` and `crm permission-sets` or through the REST API. See [`docs/permissions.md`](docs/permissions.md), including its limits.

Optional demo data: `docker compose run --rm api seed` creates a separate "Demo Co" workspace with accounts, contacts, deals and leads, and prints its keys.

To pin a release once images are published, set `HLCRM_VERSION=0.1.0` in `.env`. Optional settings (email, webhook targets) are listed in [`.env.example`](.env.example).

**If something goes wrong:** `docker compose ps` shows what is running, and `docker compose logs api` (or `migrate`, `mcp`, `worker`, `postgres`) shows why something isn't. Compose publishes ports 8787 (API and web UI), 8788 (MCP) and 5433 (Postgres) on your own machine only; if another program already uses one, either stop it or change the number before the colon in that `ports:` line of `docker-compose.yml` (and `PUBLIC_URL` in `.env` to match for 8787). `.env` is read once when Postgres first starts: to start over from nothing, run `docker compose down -v` (this deletes the database) and `sh scripts/init-env.sh` after deleting `.env`.

### Upgrading

Back up first, then update the code and start again. Starting runs any new database migrations before the API comes up, and they are one-way.

```sh
docker compose exec -T postgres pg_dump -U postgres hlcrm > backup-$(date +%F).sql   # a copy of the database
git pull
docker compose up -d --build    # with a published image: docker compose pull && docker compose up -d
```

Keep your `.env` (it holds `HLCRM_MASTER_KEY`, which the database backup does not).

### Running it for real

Compose binds every port to 127.0.0.1, and terminating TLS in front of the API and MCP ports is your job. If a reverse proxy sits in front of the API, set `TRUST_PROXY=true` so failed-login limits use the real client address, and only then. Back up Postgres, and keep a copy of `HLCRM_MASTER_KEY` outside the database backups: without it, restricted fields can't be decrypted. The software enforces workspace isolation, roles and permissions, scoped keys, field encryption and a tamper-evident audit log. Running it securely (hosts, network, backups, access, monitoring) is your responsibility, and the software itself makes no compliance claims such as "SOC 2 compliant".

## Use it from Claude

### Claude Code

```sh
claude mcp add --transport http crm-ops http://localhost:8788/mcp/ops \
  --header "Authorization: Bearer <your ops key>"
claude mcp add --transport http crm-admin http://localhost:8788/mcp/admin \
  --header "Authorization: Bearer <your admin key>"
```

Then ask, for example: *"Add these accounts and contacts to the CRM, then create a deal for each account in the Proposal stage: …"*

### Claude Desktop (stdio)

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crm-ops": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--network", "hl-crm-db_default",
               "-e", "HLCRM_API_URL=http://api:8787", "-e", "HLCRM_API_KEY=<your ops key>",
               "hl-crm-db:local", "mcp-stdio", "--surface", "ops"]
    }
  }
}
```

To add it to claude.ai, ChatGPT or Cursor as a remote connector, turn on OAuth for MCP (`MCP_PUBLIC_URL`, with `PUBLIC_URL` and `MCP_SERVICE_SECRET`): you then paste `<MCP_PUBLIC_URL>/mcp/ops` into the client, sign in and approve. See [`docs/mcp/oauth.md`](docs/mcp/oauth.md); it hasn't been tried with those clients yet. API keys keep working for clients that take a header.

The tools are documented in [`docs/mcp/`](docs/mcp/README.md).

## Use it from the REST API

```sh
KEY=hlcrm_live_…   # your ops key
curl -s localhost:8787/v1/schema -H "Authorization: Bearer $KEY"

curl -s -X POST localhost:8787/v1/objects/account/records -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Idempotency-Key: acme-1" \
  -d '{"name": "Acme", "domain": "acme.com"}'

curl -s -X POST localhost:8787/v1/objects/contact/records/batch -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"records": [{"first_name": "Jane", "email": "jane@acme.com", "account": "acct_…"}]}'

curl -s -X POST localhost:8787/v1/query -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"object": "contact", "where": {"path": ["account", "domain"], "op": "eq", "value": "acme.com"}}'

# A pipeline board: deals per stage with their total amount
curl -s -X POST localhost:8787/v1/aggregate -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"object": "deal", "group_by": [{"field": "stage"}], "measures": [{"op": "sum", "field": "amount"}]}'

# A table: two sort fields, a count, chosen columns and the account's name inline
curl -s "localhost:8787/v1/objects/deal/records?sort=-amount,name&count=true&fields=name,amount,stage&include=account" -H "Authorization: Bearer $KEY"
```

The OpenAPI document is at `GET /v1/openapi.json` (send a key like any other request). It is generated from the code and includes your workspace's own objects, with a response schema for every route, so a typed client can be generated from it. Conventions:

- Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem documents, and every response has an `X-Request-Id`.
- Writes accept an `Idempotency-Key`, so a retried request is replayed instead of repeated.
- `PATCH` accepts `If-Match: "v<version>"`, so a stale write returns 412 instead of overwriting.
- Lists use cursor pagination (`next_cursor`), sort on up to three fields, and can count matches (`count`, exact up to 10,000).
- Reads can return chosen fields (`fields`) and related records' names inline (`include`).
- `POST /v1/aggregate` counts and totals records per group; saved views (`/v1/views`) keep a filter, sort and columns by name; `GET /v1/users` lists members for owner pickers; `/v1/me/preferences` keeps UI state. See [`docs/data-model.md`](docs/data-model.md#reading-records).

## Sign in from a browser

API keys are for machines. People sign in from a browser with an emailed code or link, a password, single sign-on (any OpenID Connect provider) or a one-time link printed on the server (`docker compose run --rm api sign-in-link --email you@example.com`, optionally with `--return-to /a/page` to land on that page), and get a server-side session. Only existing members can sign in. Set `PUBLIC_URL` to turn it on (`scripts/init-env.sh` already sets it for local use). On a fresh install with no email, a password is how you sign in again: the app offers to set one right after your first sign-in. See [`docs/sign-in.md`](docs/sign-in.md).

## The web UI

The API serves a web app at `PUBLIC_URL` (the Docker image includes it): lists with filters, sorting, saved views and inline editing, record pages with related records, notes, files and a timeline, a deals board, your tasks and inbox, a command palette, and settings for members, roles, API keys, webhooks and the audit log, each shown only when your role allows it. Every screen is built from your workspace's metadata, so custom objects and fields work with no change. Sign in at `/sign-in`, or open a link from `docker compose run --rm api sign-in-link --email you@example.com` (outside Docker: `hl-crm-db-server sign-in-link …`). `WEB_UI=false` turns it off for an API-only deployment. To run it in development, retheme it or fork it, see [`packages/web/README.md`](packages/web/README.md).

## Use it from the command line

The `crm` CLI keeps the workspace schema in a file you review and apply (`crm schema pull`, `plan`, `apply`), imports and exports CSV, and manages keys, members and roles. It isn't on npm yet: build it from source. See [`docs/cli.md`](docs/cli.md).

## Quotes and orders

A quote is made for a deal, priced by its lines, sent, and accepted, which makes an order:

```sh
curl -s -X POST localhost:8787/v1/ops/create_quote -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"deal": "deal_…", "lines": [{"description": "Seats", "quantity": 12, "unit_price": 49.5}]}'
curl -s -X POST localhost:8787/v1/ops/send_quote   -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"quote": "quote_…"}'
curl -s -X POST localhost:8787/v1/ops/accept_quote -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"quote": "quote_…"}'
```

A sent quote can't be changed (`revise_quote` makes the next version), and accepting one marks its deal won. Whether a quote needs a deal, and whether accepting marks the deal won, are workspace settings. See [`docs/data-model.md`](docs/data-model.md#quotes-and-orders-as-built).

## Files and notes

Any record can have files attached, and notes are written in Markdown and shown formatted:

```sh
curl -s -X POST "localhost:8787/v1/records/deal_…/files?name=contract.pdf" -H "Authorization: Bearer $KEY" --data-binary @contract.pdf
curl -s -OJ localhost:8787/v1/files/file_…/content -H "Authorization: Bearer $KEY"
```

Files are kept in Postgres unless you set `FILE_STORE=s3`, are limited to 10 MB each by default, and are always sent as downloads (there is no virus scanner built in). See [`docs/data-model.md`](docs/data-model.md#files-and-notes).

## Custom objects

An admin can create a custom object in one call. It gets REST endpoints, search, timelines and MCP access immediately:

```sh
curl -s -X POST localhost:8787/v1/objects -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "api_name": "property", "owned": true,
  "fields": [
    {"api_name": "address", "type": "text", "required": true},
    {"api_name": "list_price", "type": "currency"},
    {"api_name": "seller", "type": "relation", "options": {"to": "contact"}}
  ]}'
```

Field types: text, long_text, number, currency, boolean, date, datetime, single_select, multi_select, email, phone, url, relation, status, address, json, rating, percent and duration ([`docs/data-model.md`](docs/data-model.md#field-types)).

Add `"dry_run": true` to see the diff first. Through the admin MCP server, schema changes are dry runs by default. To keep the schema in a reviewed file instead, use the CLI: `crm schema pull`, `crm schema plan`, `crm schema apply` (see [`docs/cli.md`](docs/cli.md)).

## Schema packs

A schema pack is a folder holding a manifest, a schema document, and optionally roles and shared views. It sets up a workspace for one use case. `crm pack plan <dir>` shows what it would change, and `crm pack install <dir>` applies it in one transaction. Upgrades change only what the pack created, and uninstall archives it. Two examples are in [`packs/`](packs). A pack from someone else is untrusted input: read [`docs/packs.md`](docs/packs.md) before installing one.

## Architecture

```
crm CLI         MCP: /mcp/admin, /mcp/ops    your code / curl
      └───────────────────┼───────────────────────┘
                          ▼  HTTPS + API key
              REST API /v1: auth, permissions, scopes, rate limits, idempotency
              Service layer: the only place business rules live
                          ▼  one transaction per request, tenant set with SET LOCAL
              PostgreSQL: row-level security on every tenant table
                          ▲
              Worker: events, automations, alerts, webhook and email delivery, audit-log sealing
```

- **The API is the only enforcement point.** The MCP servers and the `crm` CLI are thin clients that call the API with the caller's own key.
- **Standard objects** (Contact, Account, Lead, Deal, Activity, Task, …) are typed tables. **Custom fields and objects** are JSONB validated against metadata, so schema changes never run DDL.
- **Events, automations and webhooks:** every change is an event; automations and signed webhooks act on them. See [`docs/webhooks.md`](docs/webhooks.md) and [`docs/alerts.md`](docs/alerts.md).
- **Isolation, keys, encryption and audit:** see [`docs/security/threat-model.md`](docs/security/threat-model.md).
- **Full design:** [`docs/data-model.md`](docs/data-model.md), the decision records in [`docs/decisions/`](docs/decisions) and [`ROADMAP.md`](ROADMAP.md).

```
packages/server   API, service layer, MCP servers, worker, migrations (one Docker image)
packages/sdk      thin fetch-based client for the REST API (used by the MCP servers and the CLI)
packages/cli      the `crm` command-line tool (npm name hl-crm-db, not published yet): see docs/cli.md
packages/web      the web UI, served by the API from the same origin: see packages/web/README.md
deploy/           Postgres role setup
docs/             data model, decisions, security, compliance, MCP reference, guides
```

## Development

Needs Node 24 or newer (`.nvmrc` selects 26, which CI and the image use) and pnpm (`corepack enable` picks the version in `package.json`; Node 25 and later no longer bundle corepack, so install it first with `npm install --global corepack`).

```sh
pnpm install
sh scripts/init-env.sh --dev       # a fresh setup: also creates the hlcrm_test database
docker compose up -d postgres     # tests use the hlcrm_test database on port 5433
pnpm build && pnpm lint && pnpm typecheck && pnpm test
pnpm check:licenses               # the web UI's production dependencies must be permissively licensed
```

The tests read the passwords from the repository's `.env`. **They wipe and rebuild the database they point at (`hlcrm_test` by default)**, so never aim them at a database you care about. The test database is only created when `HLCRM_CREATE_TEST_DB=true` is set the first time Postgres initializes its volume. `--dev` writes that into `.env`; you can also set it yourself before the first `docker compose up -d postgres`. An existing database volume is not affected, so it needs no change, and it will not gain the test database either: remove the volume to start over, or create it by hand:

```sh
docker compose exec -T postgres psql -U postgres -d postgres -c "CREATE DATABASE hlcrm_test OWNER hlcrm_migrator"
docker compose exec -T postgres psql -U postgres -d hlcrm_test -c "REVOKE ALL ON DATABASE hlcrm_test FROM PUBLIC; GRANT CONNECT ON DATABASE hlcrm_test TO hlcrm_app"
```

To test against another Postgres (another port, or a machine that isn't yours), set `TEST_DB_HOST=host:port` (and `TEST_DB_NAME`), or give both `TEST_DATABASE_URL` (the `hlcrm_app` role) and `TEST_MIGRATOR_URL` (the `hlcrm_migrator` role). The `.env` that `scripts/init-env.sh` writes for the quick start (without `--dev`) works for tests too, once that database exists.

To run your own build of the image: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build` (the quick start's `COMPOSE_FILE` does the same).

Tests run against a real Postgres as the restricted app role. They include a cross-tenant harness that calls every route with another workspace's IDs.

## License

The server ([`packages/server`](packages/server)) and the web UI ([`packages/web`](packages/web)) are [AGPL-3.0-only](LICENSE), the same license as Metabase's open-source edition. You can self-host and modify hl-crm-db freely. If you offer a modified version to others over a network, you must publish your changes under the same license.

The SDK in [`packages/sdk`](packages/sdk) and the `crm` CLI in [`packages/cli`](packages/cli) are [MIT](packages/sdk/LICENSE) ([CLI licence](packages/cli/LICENSE)). The example schema packs in [`packs/`](packs) are [MIT](packs/LICENSE) too, so you can copy them into your own packs. Applications and MCP servers that only call the API over the network, including through the MIT SDK, are not covered by the AGPL and can use any license. This is a plain-language summary, not legal advice.

Contributions are welcome under a [contributor license agreement](CLA.md); see [`CONTRIBUTING.md`](CONTRIBUTING.md).
