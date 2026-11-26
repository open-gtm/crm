# The `crm` command-line tool

`crm` is a client for the hl-crm-db REST API. It keeps the workspace schema in a file you can review and version (schema-as-code), moves records in and out as CSV, and covers everyday administration: keys, members, roles and the audit log. It only talks to the API over HTTP with your API key, so it can do exactly what that key can do and nothing more. Every rule is enforced by the server.

The package lives in [`packages/cli`](../packages/cli). Its npm name will be `hl-crm-db` (the `crm` name is taken on npm) and it is MIT licensed, like the SDK. It is not published yet.

## Install from source

Needs Node 24 and pnpm.

```sh
git clone https://github.com/open-gtm/crm.git && cd crm
pnpm install
pnpm --filter @hl-crm-db/sdk build && pnpm --filter hl-crm-db build
node packages/cli/dist/main.js --help
```

To have a `crm` command, link it globally (`cd packages/cli && pnpm link --global`) or add an alias: `alias crm="node $PWD/packages/cli/dist/main.js"`.

## Logging in

```sh
crm auth login --url https://crm.example.com              # prompts for the key, without echo
# For the Docker quick start on your own machine: crm auth login --url http://localhost:8787 (paste the admin key)
echo "$HLCRM_KEY" | crm auth login --url https://crm.example.com --with-token --name prod
crm auth status
crm auth logout
```

- The key is read from a hidden prompt or from stdin (`--with-token`), never from an argument: arguments end up in shell history and in `ps` output.
- `login` checks the key with `GET /v1/me` before saving anything.
- `logout` removes the key from the config file. The key still works until it is revoked (`crm keys revoke <id>`).
- The CLI never prints a key. It shows only its hint, such as `hlcrm_live_ab12…`.

### HTTPS

The URL must use `https://`. Plain `http://` is accepted only for `localhost`, `127.0.0.1` and `[::1]`, or when you pass `--insecure-http` (or set `HLCRM_INSECURE_HTTP=1`). Use that only on a private network you control: the key crosses the network unencrypted. `login` remembers the choice for that remote. The CLI never follows redirects, so the key can't be sent on to another host.

### Saved remotes

```sh
crm remote list
crm remote use prod
crm remote remove staging
crm --remote staging schema plan     # use a remote for one command
```

### The config file

Remotes and their keys are kept in `config.json` in:

| Platform | Directory |
|---|---|
| Linux and macOS | `$XDG_CONFIG_HOME/hl-crm-db`, or `~/.config/hl-crm-db` when that is unset (macOS uses `~/.config` too, like most developer tools) |
| Windows | `%APPDATA%\hl-crm-db` |
| Anywhere | `$HLCRM_CONFIG_DIR`, if set |

The directory is created with mode `0700` and the file with `0600`, and the file is replaced atomically on each write. On Linux and macOS the CLI refuses to read a config file that other users can read or that belongs to another user. If that happens, fix the mode (`chmod 600 …/config.json`) and consider rotating the keys in it. Only the keys you log in with are stored there. Keys created with `crm keys create` are never written to it.

### Environment variables

| Variable | Meaning |
|---|---|
| `HLCRM_API_URL` | The API URL. Overrides the saved remote's URL. Without `HLCRM_API_KEY` it must be on the saved remote's origin (scheme, host and port), or the CLI refuses (exit 2) rather than send the saved key to another server; set `HLCRM_API_KEY` as well, or use `--remote`. |
| `HLCRM_API_KEY` | The API key. Overrides the saved remote's key. With both set, no config file is needed (CI). |
| `HLCRM_INSECURE_HTTP=1` | Same as `--insecure-http`. |
| `HLCRM_CONFIG_DIR` | Where the config file lives. |
| `NO_COLOR` | Turns colour off. Colour is also off when output is not a terminal, and with `--json`. |

In CI, put the key in the CI system's secret store and expose it as `HLCRM_API_KEY`. Give CI a key with only the scopes it needs: `ops:read` to pull the schema, `admin` (a role with `schema:manage`) to plan or apply it, `ops:write` to import.

## Global options

| Option | Meaning |
|---|---|
| `--json` | Machine output: one JSON document on stdout. Errors are a JSON object on stderr: `{"error": {"code", "message", "status", "request_id", "details"}, "exit_code"}`. |
| `--no-input` | Never prompt. A confirmation that is needed and not given with `--yes` is an error (exit 6), never consent. Without a terminal the CLI behaves as if `--no-input` were set. |
| `-y`, `--yes` | Confirm without asking. |
| `--remote <name>` | Use a saved remote other than the current one. |
| `--insecure-http` | Allow `http://` to a host other than localhost (see above). |

Results go to stdout. Progress, warnings and errors go to stderr, so `crm … > file` captures only the result. Text that comes from the server is made safe for a terminal: tables and messages drop control characters and bidi controls (which can reorder what a terminal shows), `--json` output escapes C1 and bidi controls (still the same JSON), and raw output (`crm api` on a non-JSON response, `data export -o -`, `schema pull -o -`) drops control characters other than newline and tab when stdout is a terminal. Piped or redirected, raw output is passed through byte for byte. Errors print the API's problem `detail` and the `request_id`; quote the request ID when you report a problem.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. For `schema plan`: no changes. |
| 1 | Failure: the request was refused (for example a validation error), an import had row errors, `audit verify` found a problem, or the schema file asks for something apply cannot do. |
| 2 | Usage: a bad argument or option, a missing file, an invalid URL or schema file. |
| 3 | Authentication or permission: not logged in, the key was refused (401), or it lacks a permission (403). |
| 4 | Conflict: schema drift that the change would overwrite, a version mismatch, a duplicate (409, 412, 428). |
| 5 | `schema plan` found changes to apply. |
| 6 | A confirmation was needed and not given: `--no-input` (or no terminal) without `--yes`, or the answer was no. |

The `code` in `--json` errors is the API's error code when the API refused (`schema_drift`, `validation_failed`, `forbidden`, `import_failed`, …) or one of the CLI's own: `usage`, `not_logged_in`, `unknown_remote`, `config_insecure`, `config_invalid`, `confirmation_required`, `not_confirmed`, `env_url_mismatch`, `output_is_symlink`, `output_not_a_file`, `schema_file_invalid`, `schema_unsupported`, `schema_drift`, `file_not_found`, `csv_invalid`, `csv_row_too_large`, `network_error`, `timeout`.

## Checking a setup: `crm doctor`

```sh
crm doctor
```

It checks the config file's permissions, which remote and key are in use and where they came from, that the API can be reached, that the key works and as whom, clock skew against the server's `Date` header (a warning past 60 seconds), the server version against the CLI version, the permissions the key has, and its record access from `GET /v1/me/access`: "read, write and archive on every object and field", or what is less than that (`deal: none`, `contact: read`, `contact.phone: read`). A custom role can limit objects and fields ([`permissions.md`](permissions.md#object-and-field-access)), and a key's scopes narrow it further. It exits 3 when the key fails and 1 when anything else fails.

## Raw requests: `crm api`

For anything the CLI has no command for:

```sh
crm api GET /v1/schema
crm api GET '/v1/objects/contact/records?filter[email]=jane@example.com'
crm api POST /v1/objects/contact/records --data '{"email": "jane@example.com"}'
crm api PATCH /v1/objects/contact/fields/email --data @patch.json
echo '{"label": "E-mail"}' | crm api PATCH /v1/objects/contact/fields/email --data -
```

It sends the key, an `Idempotency-Key` on writes, and `If-Match` with `--if-match <version>`. The path must be a path on the API (`/v1/…`): a full URL, or `.` or `..` segments, are refused, so the key never goes to another server. Redirects are never followed for the same reason.

## Schema-as-code

The workspace schema (its modules, objects, fields, pipelines and stages) can be kept in one file:

```sh
crm schema pull                      # writes crm.schema.yaml
$EDITOR crm.schema.yaml
crm schema plan                      # what would change; exit 5 when there are changes
crm schema apply                     # shows the plan, asks, applies in one transaction
crm schema describe contact          # fields of one object, with this key's access to each
```

`-f` / `-o` choose the file. A name ending in `.json` is read and written as JSON, anything else as YAML. `pull -o -` writes to stdout.

### The file format

```yaml
# Written by crm schema pull. Comments you add are kept by YAML tools but not by pull, which rewrites the file.
format: hl-crm-db/schema@1
schema_version: 42            # the workspace version this file was pulled at; used to detect drift
modules: [core, sales]        # modules that are on
objects:
  - id: obj_01JD…             # IDs track things across renames; keep them. New entries need none
    name: contact             # api_name
    label: Contact
    plural_label: Contacts
    id_prefix: con
    owned: true
    standard: true            # informational: standard object (ignored on input)
    module: core              # informational
    fields:
      - id: fld_01JD…
        name: email
        type: email
        label: E-mail         # standard fields can be relabeled, hidden and made required
        standard: true
      - id: fld_01JE…
        name: tier            # a custom field
        type: single_select
        label: Tier
        values:
          - { key: gold, label: Gold }
          - { key: silver, label: Silver }
  - name: property            # a new custom object: no id yet
    label: Property
    plural_label: Properties
    id_prefix: prop           # record IDs look like prop_01J…
    owned: true               # adds an owner field (a member; set, filter and show it like a contact's owner)
    display_field: address
    fields:
      - { name: address, type: text, required: true }
      - { name: bedrooms, type: number, validation: { min: 0 } }
      - { name: list_price, type: currency }
      - name: status
        type: status
        values: [{ key: listed, label: Listed }, { key: under_offer, label: Under offer }, { key: sold, label: Sold }]
        initial: listed
        transitions: { listed: [under_offer], under_offer: [listed, sold] }
      - { name: seller, type: relation, relation: { to: contact, cardinality: many_to_one } }
      - { name: notes, type: long_text, hidden: true, sensitivity: confidential }
pipelines:
  - id: pipe_01JD…
    name: Sales
    is_default: true
    stages:
      - { id: stg_01JD…, name: Qualification, category: open, probability: 10 }
      - { id: stg_01JD…, name: Won, category: won, probability: 100 }
      - { id: stg_01JD…, name: Lost, category: lost, probability: 0 }
```

Field properties: `name`, `type` (text, long_text, number, currency, boolean, date, datetime, single_select, multi_select, email, phone, url, relation, status, address, json, rating, percent, duration; see [field types](data-model.md#field-types)), `label`, `description`, `required`, `unique`, `hidden`, `sensitivity` (standard, confidential, restricted), `default`, `validation` (`min`/`max` for numbers, percent and duration, `max_length`/`pattern` for text), `values` (select and status fields), `relation` (`to`, `cardinality`), `initial` and `transitions` (status fields), `max` (rating: 1 to 10; can be raised, not lowered) and `shape` (json: `type`, `required`, `properties`, `additional_properties`). `standard` and `read_only` are written by `pull` for information and ignored on input. Unknown properties are an error, so a typo doesn't pass silently.

### How a file is matched to the workspace

- Each object, field, pipeline and stage is matched by its `id` first. Changing `name` while keeping the `id` is a **rename**, not a delete and an add.
- An entry without an `id`, or with an ID from another workspace, is matched by name. The plan lists these matches, so a hand-written file works and you can see what it matched.
- Anything not matched is created.
- A property you leave out of an entry is left as it is. To turn a flag off, write `false`. To clear a default, write `default: null`.
- An object or field in the workspace but not in the file is left alone. Leaving the `fields:` list out of an object leaves all its fields alone. Leaving `pipelines:` out leaves all pipelines alone.

### What apply can and cannot change

It can:

- turn modules on or off (the API's rules apply: a module with records can't be turned off);
- create custom objects with their fields, in an order that lets new objects relate to each other;
- relabel, describe or hide any object, and change a custom object's display field;
- add fields to any object; rename custom fields; change labels, descriptions, `required`, `hidden`, defaults, validation and select or status values (values can be added and relabeled, not removed); raise or lower sensitivity between standard and confidential (a standard field's can only be raised);
- retype a custom field along a safe path: text → long_text, and rating, percent or duration → number (no data change); number → currency, single_select → multi_select (stored values are converted);
- archive custom fields that are missing from the file, with `--prune`;
- create pipelines, rename them, make one the default, and add, rename, reorder and re-weight their stages.

It cannot, and `plan` lists each case under "Cannot be applied" (apply then refuses the whole file):

- rename an object, or change its `id_prefix` or `owned`;
- rename or retype a standard field, or change any field's `unique`, relation target or cardinality, a status field's `initial` or `transitions`, or make a field restricted or unrestricted;
- change a stage's category, or remove pipelines, stages or objects (with `--prune`).

For those, add a new field or object, or use the API directly.

### Plan

`crm schema plan` sends the file to `POST /v1/schema/plan`. The server runs the whole apply inside a transaction savepoint and rolls it back, so the plan is exactly what apply would do, including every validation error, and nothing is written. It prints:

- the changes in order (`+` adds, `~` changes, `-` archives), with warnings, and `[changes stored data]` on archives and value conversions;
- what cannot be applied;
- **drift**: every schema change made in the workspace since the file's `schema_version` (from the schema history), with who made it, when and through which surface. Changes the plan would overwrite are marked: those that change something the plan also changes (matched by ID), and those whose name the plan would add again, such as a field archived or renamed since the pull that the file still lists, or a name created since. When there are more than 500, or the file's `schema_version` is newer than the workspace's (it was pulled from another workspace), the drift can't be listed and counts as a conflict;
- how many entries were matched by name (`--verbose` lists them, and the notes about things left alone).

Exit codes for CI: 0 no changes, 5 changes to apply, 4 the changes would overwrite drift (or drift can't be listed), 1 the file asks for something apply cannot do.

### Apply

`crm schema apply` plans first and shows the plan. Then:

1. If the file asks for something that can't be done, it stops (exit 1).
2. If there is nothing to change, it stops (exit 0). Applying the same file twice is a no-op.
3. If the plan would change something that was changed in the workspace since the file was pulled, it stops (exit 4). Drift the plan doesn't touch, such as a field someone else added, doesn't block it. `--accept-drift` overwrites drift on purpose.
4. It asks for confirmation. With `--no-input` or without a terminal, `--yes` is required. Archiving fields (`--prune`) or converting stored values always needs `--yes` or a yes at the prompt.
5. It sends `POST /v1/schema/apply` with `If-Match: <schema_version from the file>`. The server repeats every check and applies all the changes in one transaction: all of them or none.

Schema changes in a workspace are serialised: plan, apply and every other schema change (the object, field, pipeline and module routes, MCP tools) take one lock per workspace before they read the schema. Apply measures drift after it has the lock, so a change committed while it waited is reported as drift (412), never silently overwritten. An `If-Match` newer than the workspace's version is refused with 412 `schema_version_ahead`. One document may make at most 500 changes, and plan or apply gives up with 503 `work_budget_exceeded` (nothing changed) after 20 seconds; apply a large document in parts (entries left out are left as they are).

Apply doesn't modify your file. Run `crm schema pull` afterwards to record the new version and the IDs of anything created. A stale `schema_version` is safe: drift is judged by what the plan would overwrite, not by the number alone. A file without `schema_version` can only be applied with `--accept-drift`.

On the server, plan and apply need the `schema:manage` permission (an admin key). A role with `schema:manage` must have unrestricted record access (no denying object rule, no field rule), so plan and apply always see the whole workspace. Export needs only `records:read` on at least one object, like the other schema reads.

**Modules.** Objects of a module that is turned off are left out of the export, as `GET /v1/objects` leaves them out. Apply leaves objects a document doesn't list alone, with `--prune` too, so such a document doesn't archive or change them.

**Record access and the file.** Object and field names are not data, so the document lists every object and field whatever the key can read, as `GET /v1/objects/{object}?include_hidden=true` does. When the key can't read, write and archive everything (a custom role with object or field rules, or a key without `ops:write`), the export also carries `access`, the same list as `GET /v1/me/access`. `crm schema pull` leaves `access` out of the file, so the file is the same whoever pulls it, and prints a note with the limits instead. Plan and apply ignore `access` if a document has it. `crm schema describe` shows the key's access per object (`read, write, archive` or `none`) and per field (`write`, `read` or `none`). Each change is written to the schema history and the audit log, and the apply itself is audited as `schema.applied` with the versions before and after, the number of changes and whether drift was overwritten.

### API

| Route | Permission | Notes |
|---|---|---|
| `GET /v1/schema/export` | `records:read` (on at least one object) | The document, with `schema_version`, and `access` when the key's record access is limited. |
| `POST /v1/schema/plan` | `schema:manage` | Body `{document, prune?}`. Writes nothing. |
| `POST /v1/schema/apply` | `schema:manage` | Body `{document, prune?, accept_drift?, confirm_data_changes?}`, header `If-Match: "<schema_version>"`. Errors: 412 `schema_drift` (with the conflicting changes), 412 `schema_version_ahead`, 428 `if_match_required`, 409 `confirmation_required`, 422 `schema_unsupported`, 503 `work_budget_exceeded`. |

## Records

```sh
crm data list contact --filter email=jane@example.com
crm data list deal --filter 'amount[gt]=10000' --sort amount --limit 20
crm data list deal --sort name,-amount --fields name,amount,stage --count
crm data list deal --view v_01JD…
crm data get con_01JD…
crm data aggregate deal --group-by stage --sum amount
crm data aggregate contact --group-by created_at:month,lifecycle_stage
```

`--filter` takes `field=value` or `field[op]=value` (ops: eq, neq, in, not_in, gt, gte, lt, lte, contains, starts_with, is_null) and relation paths such as `account.domain=acme.com`, exactly like the API's `filter[…]` parameters. Values are sent as text and the server types each by its field, so `--filter zip=02139` matches the text `02139` and `--filter 'amount[gt]=100'` compares numbers.

`data list` options:

- `--sort a,-b` sorts by up to three fields, ascending unless prefixed with `-`. A single field without `-` sorts newest first unless `--asc` is given, as before.
- `--fields name,amount` shows only those fields (the table shows them as columns; `--json` returns them with `id`, `object` and `version`).
- `--count` prints how many records match (exact up to 10,000) on stderr, or adds `total` and `total_capped` to `--json` output.
- `--view v_…` runs a saved view: its filter, sort and columns. `--filter`, `--sort` and `--fields` replace the view's. Views are saved through the API (`POST /v1/views`).

`data aggregate <object>` counts records per group (`POST /v1/aggregate`): `--group-by` takes up to two fields, a date with a bucket as `field:month` (day, week, month, quarter, year); `--sum`, `--avg`, `--min` and `--max` take a number or currency field and can be repeated; `--filter` works as in `data list`; `--order count` puts the largest groups first; `--view` uses a saved view's filter and grouping; `--limit` caps the groups (at most 1,000). The table shows relation keys by name. An aggregate looks at the 100,000 most recently updated matching records at most; when more match, the CLI says the figures are partial (`rows_capped` in `--json`). Amounts in different currencies are never added together: the API refuses such a total, and `--group-by currency` gives one per currency. Grouping by or measuring a field the key can't read is refused like a filter on it.

### Export

```sh
crm data export contact -o contacts.csv
crm data export deal -o deals.ndjson --format ndjson --filter 'amount[gt]=10000'
```

- Uses `GET /v1/objects/:object/export`, which takes the same filters and sort as the list route and applies the same permissions and record access. An object the key can't read is refused (403) before anything is written; the CLI prints the API's message and leaves an existing output file as it was. A field the key can't read (a field rule `none`) has no column at all: its name isn't secret (`schema describe` lists it), but an empty column would read as "no value". Filtering or sorting on such a field, or following a relation path into an object or field the key can't read, is refused like in `data list`. A relation to a record on an object the key can't read is its ID, as everywhere; NDJSON activities and tasks name related records in `related` only where the key can read them. Restricted values appear as `[restricted]` unless the key has `restricted:read`, and hidden fields are left out unless `--include-hidden` is given.
- One response holds at most 5,000 rows. When there are more, the response has an `X-Next-Cursor` header and the CLI requests the next part until it has everything. Each response is a complete CSV file, and the CLI drops the repeated header. The server never holds more than one response's rows in memory.
- Columns: `id`, then each field the key can read in field order (relations as record IDs; an address as one column per part, `hq.line1` … `hq.country`; a json value as one cell of JSON text; percent in percentage points; duration in seconds), `related_to` for activities and tasks, then `created_at`, `updated_at`, `version`, and `archived_at` with `--include-archived`. Lists (multi-select values, many-to-many relations, `related_to`) are joined with `;`.
- The output file is created readable by its owner only, since exports usually hold personal data. It is written to a new file beside it and renamed into place once the export is complete, so a failed export leaves an existing file as it was. The CLI never writes through a symbolic link (a dangling one included): it refuses (exit 2), `--yes` or not. An existing file is replaced only after a yes at the prompt or with `--yes`; with `--no-input` it is never asked (exit 6). Every export is recorded in the audit log as `<object>.exported`, with the row count and format.

**Formula injection.** A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` (or a tab or carriage return) as a formula. In CSV exports, every text cell that starts with one of those gets a leading apostrophe (`'=HYPERLINK(…)`), which spreadsheets show as text, and so does a cell that starts with apostrophes followed by one of them (`'+44` becomes `''+44`). Numbers are not changed. `crm data import` removes exactly one apostrophe from such a cell, so every exported value imports back exactly as it was. Pass `--keep-formula-quotes` to keep it. NDJSON is not changed.

### Import

```sh
crm data import contact people.csv --map "E-mail=email" --map "Company=account.domain" --key email
crm data import contact people.csv --map "E-mail=email" --map "Company=account.domain" --key email --apply
```

- **Dry run by default.** Without `--apply` nothing is written. The CLI prints how many rows would be created, updated, left unchanged or rejected, and writes every rejected row with its reason to `<file>.errors.csv` (or `--report <file>`). The report follows the export's file rules: owner-only, never through a symbolic link (refused before anything is sent). A report from an earlier run (a file whose first line is the report's own header, `row,line,action,id,reason,details`, read without following links) is simply replaced, so a dry run followed by `--apply` needs no `--yes`. Any other existing file there is replaced only after a yes or with `--yes`; with `--no-input` and no `--yes` it is kept, the errors are still printed (and listed in `--json` output, with `report_not_written`), and the exit code is 1.
- **Mapping.** A column whose header is a field name maps to that field. `--map "Column=field"` maps any other column, and `--map "Column="` ignores one. Columns that match nothing are listed as ignored, as are columns that the system sets (`created_at`, `version`, …) and read-only fields.
- **Upsert key.** With `--key <field>`, a row whose key matches an existing record updates it, and any other row creates a record. The key is `id` or a field whose values are unique: a custom field created with `unique: true`, a contact's `email`, or an account's `domain`. Key values are compared after the field's normal formatting (emails in lower case, domains without scheme or `www.`). When the file has an `id` column and no `--key` is given, `id` is the key. A row that would change nothing is skipped and its record's version doesn't move.
- **Values.** Address fields are imported from part columns (`hq.city`, `hq.country`, …; a single `hq` column is refused): the parts in a row make the whole new address, and a row whose part cells are all empty leaves it alone. Json cells hold JSON text. Percent takes `12.5` or `12.5%`, duration seconds or an ISO 8601 duration (`PT1H30M`). Empty cells leave a field as it is (and unset when creating). Values go through the same validation as the API. Booleans accept true/false, yes/no, y/n and 1/0. Multi-select values and many-to-many relations are separated by `;`. Dates are `YYYY-MM-DD`, date-times ISO 8601, numbers and currency plain numbers.
- **Relations** take record IDs, or are looked up by a unique field of the target with `--map "Company=account.domain"` (or `account.id`). An owner can be looked up by member email: `--map "Owner=owner.email"`. Lookups compare values as the field does: emails and domains ignoring case, other fields exactly (`ABC` and `abc` are different codes). A lookup that finds no record, or more than one, rejects the row.
- **Limits.** One request counts against the key's rate limit (20 requests a second, bursts of 200) as one request per 100 lines of CSV, dry runs included, like the batch route's 100 records a request. A request that runs longer than 20 seconds gives up with 503 `work_budget_exceeded` and writes nothing; split the file. A dry run takes no locks that would make real writes wait. Text with NUL characters (`\u0000`), which the database can't store, is refused with 422 here as in every request.
- **All or nothing.** Each request (at most 500 rows and under 1 MB) is applied in one transaction: if any row fails, none of that request is written. Larger files are split into several requests. Before writing anything, the CLI dry-runs every part, and it writes nothing if any row in any part fails. If a part still fails while applying (because the data changed in between), the earlier parts stay applied, and the CLI says which.
- **CSV format.** RFC 4180: comma separated; fields with commas, quotes or line breaks in double quotes; quotes doubled inside them; CRLF or LF line endings; a UTF-8 byte order mark is ignored; blank lines are skipped. A row with a different number of fields than the header is rejected.
- **Record access.** Imports need write on the object (and read on it with `--key`). Before reading anything, the server checks every mapped column and refuses the whole request (403, exit 3) naming each column it can't use: a field the key can't write (`map those columns to "" to leave them out`), an upsert key it can't read, a relation to an object it can't read, or a lookup by a field it can't read (`account.domain` needs read on accounts and on `account.domain`), since which rows match would reveal values. An upsert key the key can read but not write still matches: rows update the records they find and can't create new ones. Owner lookups by email need only write on `owner`, like `assign_owner`. Row errors, in a dry run or a real one, quote only the file's own values and field names.
- **Restricted fields.** A cell holding `[restricted]` (what an export without `restricted:read` shows) in a restricted field is left as it is, so a redacted export imports back without overwriting the values. A key without `restricted:read` can still write restricted fields, but a row with a value for one always counts as a change: comparing it with the stored value would tell the key whether its guess was right.
- Imports need `records:write`. Each record created or updated is audited and emits events like any other write, and the import as a whole is audited as `<object>.imported` with its counts.

API: `POST /v1/objects/:object/import` with JSON `{csv, mapping?, key?, dry_run? (default true), unescape_formulas? (default true)}`. The response lists each row with `row`, `line`, `action` (create, update, skip or error), the record `id` and the `reason` for errors. A failed real run is a 422 `import_failed` whose `errors` hold the failed rows.

### Bulk update and archive

```sh
crm data update contact --where source=webinar --set lifecycle_stage=lead --set job_title=Buyer
crm data update deal --id deal_01JD… --id deal_01JE… --set amount=12000
crm data archive contact --where 'created_at[lt]=2024-01-01' --where source=import
crm data archive lead --where '{"or":[{"field":"status","op":"eq","value":"disqualified"},{"field":"score","op":"lt","value":5}]}'
```

- **Preview, then confirm.** Every run starts with a dry run on the server: the CLI prints how many records would change, a sample, and every record that would fail. Nothing is applied if one would fail (exit 1). Otherwise it asks; `--yes` answers yes, and under `--no-input` without `--yes` it stops there (exit 6). With `--json` the output is `{preview, result}`.
- **By filter.** `--where` takes `field=value`, `field[op]=value` (`in` and `not_in` take a comma list) or a JSON filter as in `POST /v1/query`; several are combined with AND. The dry run returns a token bound to the filter, the values and the exact records it previewed. The real run evaluates the filter again among those records only: one that no longer matches is left alone and listed, and one that matches now but wasn't previewed is counted and not changed. A run never touches more than it showed.
- **By IDs.** `--id`, repeatable. `--expect-version id=version` fails a record that changed since you read it. The server needs the dry run's token for a run of more than 25 records; the CLI always passes it.
- **One token, one run.** The token is single-use and valid for 15 minutes: re-sending it (to archive a record again after someone restored it, say) is refused with 409 `confirm_token_used` (exit 4). Run the command again for a new preview.
- **Values.** `--set field=value`; the value is read as JSON when it parses (numbers, `true`, `false`, `null`, `["a","b"]`) and as text otherwise (quote a JSON string to keep it text: `--set 'code="007"'`).
- At most 500 records per run, all or nothing, each through the normal update or archive (validation, field access, status transitions, hooks, events and audit as for one record). A real run of N records counts as N/3 requests against the key's rate limit (500 records: 167 of the burst of 200), its dry run as one per 10 records (it does every record's work, then rolls it back). At most 2 such requests run at once per key; a third is refused with 429 and `Retry-After`. A request over 20 seconds gives up with 503 `work_budget_exceeded` and changes nothing.

API: `POST /v1/objects/:object/records/bulk_update` with `{ids | where, values, expected_versions?, dry_run? (default true), confirm_token? (from the dry run; required by filter and above 25 ids)}`, and `POST /v1/objects/:object/records/bulk_archive` (the same without `values`; needs `records:archive`). The response has `count`, `counts`, one row per record (`id`, `action`, and `version` or `reason`), a `sample` and the `confirm_token` on dry runs, and `no_longer_matching` and `new_matches_not_changed` on runs by filter. A failed real run is a 422 `bulk_failed` whose `errors` hold the failed rows. `POST /v1/objects/:object/records/batch` takes `dry_run: true` too: it reports per record what would be created, or its errors, and writes nothing.

### Duplicates, merge and restore

```sh
crm data duplicates contact                         # by email, and by name and account
crm data duplicates account --fuzzy                 # also similar company names
crm data duplicates property --rule address --rule owner_name,postcode
crm data merge con_01JD… con_01JE… con_01JF…         # survivor first; shows the changes, then asks
crm data merge con_01JD… con_01JE… --field email=con_01JE…
crm data list contact --archived --filter email=ana@example.com
crm data restore con_01JE…
crm data erase contact con_01JD…                     # for good: shows what goes, then asks. Needs an admin key
```

- `duplicates` lists groups with the reason each was grouped (the fields, and `exact`, `normalized` or `similar`). Rules use only fields the key can read; a default rule on a field it can't read is skipped with a note. Only the 10,000 newest records are examined (1,000 for `--fuzzy`, comparing the first 48 characters of each name; if that takes over 1.5 s it is refused with a hint to raise `--min-similarity`). Names are printed on one line: a newline in a name is shown as a space.
- `merge` keeps the survivor's values, fills its empty fields from the duplicates in the order given, and takes a field from a chosen record with `--field name=id`. Every reference to the duplicates moves to the survivor, and the duplicates are archived with a pointer to it (`crm data get` on a merged ID shows `merged_into`). It prints the field changes, the references it would move and any field it can't fill (with why), then asks (`--yes` to skip), and applies with the preview's token: if one of the records changed in between, the server refuses (409, exit 4) and nothing is merged. A merge moves at most 1,000 references; above that it is refused before anything changes (merge fewer duplicates at a time). On a merged ID, `crm data get` shows `merged_into` (the final survivor, through later merges) and `merge_chain`. There is no unmerge.
- `restore` un-archives a record. It is refused when another record now has one of its unique values (an email, a domain), when it was merged, or when it was erased.
- `erase` removes a person's values for good: a contact (with its leads), a lead, or a record of a custom object. The row stays, blank and archived. It prints the records it would blank, counts of what goes with them (activities, tasks, files, copies), and other records that seem to mention the person, which it does not change; then it asks (`--yes` to skip) and applies with the preview's token, so anything added in between is refused (409, exit 4). It needs a key with the `admin` scope whose member holds `schema:manage`. `--keep-emailable` leaves a contact's address off the list automations never email. See [`docs/data-model.md`](data-model.md#erasing-a-persons-records).

See [`docs/data-model.md`](data-model.md#merge-restore-and-duplicates) for the rules.

## Administration

```sh
crm keys list
crm keys create --name ci --scopes ops:read > ci-key.txt     # the secret alone goes to stdout
crm keys rotate key_01JD… --overlap-hours 24
crm keys revoke key_01JD…

crm members list
crm members add --email ana@example.com --name "Ana" --role member
crm members add --service-account --name "Import bot" --role member
crm members update usr_01JD… --role read_only
crm members add --email li@example.com --name "Li" --role member --permission-sets deal_desk
crm members update usr_01JD… --permission-sets deal_desk,forecasting   # the whole list; "none" takes them all away
crm members update svc_01JD… --disable
crm sessions list usr_01JD…                  # a member's browser sessions (members:manage)
crm sessions revoke ses_01JD…                 # end one
crm sessions revoke --member usr_01JD… --all  # sign a member out everywhere (their keys keep working)
crm apps list                                # apps your key's member connected over OAuth
crm apps list --member usr_01JD…             # a member's connected apps (members:manage)
crm apps revoke ogr_01JD…                    # disconnect one

crm files list deal_01JD…                    # the files attached to a record
crm files attach deal_01JD… ./contract.pdf   # --name to keep it under another name
crm files download file_01JD…                # to the file's name here, or --output path
crm files remove file_01JD…                  # deletes its bytes; asks first

crm roles list
crm roles get member                 # permissions, object and field rules, and the record access they give
crm roles create --key assistant --name Assistant --permissions records:read,records:write --object deal:read=deny --object deal:write=deny --field contact.phone=read
crm roles create --file roles/assistant.yaml     # the API's shape, in YAML or JSON
crm roles update assistant --field contact.phone=inherit --field contact.notes=none
crm roles access assistant           # what the role's holders can do, per object
crm roles archive assistant

crm permission-sets list
crm permission-sets create --key deal_desk --name "Deal desk" --permissions views:manage --object deal:read=allow --object deal:write=allow --field deal.margin=read
crm permission-sets get deal_desk     # its two areas (record and feature permissions) and the record access it gives by itself
crm permission-sets update deal_desk --field deal.margin=inherit
crm permission-sets archive deal_desk

crm webhooks list
crm webhooks get whk_01JD…
crm webhooks deliveries whk_01JD… --status dead
crm webhooks test whk_01JD…
crm webhooks secret whk_01JD… > secret.txt     # the secret alone goes to stdout

crm automations list
crm automations get auto_01JD…
crm automations create --file automations/welcome.yaml        # shows the dry run, then asks (--yes to skip the question)
crm automations update auto_01JD… --file patch.yaml --dry-run # only the dry run
crm automations pause auto_01JD… --reason "fixing the endpoint"
crm automations resume auto_01JD…
crm automations run auto_01JD… --record con_01JD… --record con_01JE…   # dry run, then asks; queued for the worker
crm automations runs auto_01JD… --status failed --steps    # "skipped (cap)" and "failed (data)" mark cap skips and record-data failures

crm audit log --action schema. --limit 20
crm audit verify
crm audit review --json > access-review.json   # every member, role, rule and key
crm events list --status dead                   # events whose automations and webhooks never ran
```

- A new key's secret is printed once. In normal output it is the only thing on stdout (the rest goes to stderr), so it can be redirected to a file or a secret store. With `--json` it is in the JSON. It is never written to the config file or logged. If you lose it, rotate the key.
- `revoke`, `rotate`, `members update --disable`, `sessions revoke` and `apps revoke` ask for confirmation (or need `--yes`).
- The CLI uses API keys only; it has no browser sign-in and no OAuth sign-in. Connected apps are described in [`mcp/oauth.md`](mcp/oauth.md). People's sign-in is described in [`sign-in.md`](sign-in.md).
- `roles get` shows the role's object and field rules and, from `GET /v1/roles/{id}/access`, what they add up to per object; `--json` returns both (`data`, `access`).
- `roles create` and `roles update` take flags, a file (`--file`, YAML or JSON with `key`, `name`, `description`, `permissions`, `copy_from`, `objects` and `fields` as in `POST /v1/roles`), or both (flags win). `--object object:read|write|archive=allow|deny|inherit` and `--field object.field=none|read|inherit` are repeatable; `inherit` clears a rule. `update` changes only what it names, and `--permissions` replaces the list. `archive` asks first.
- `files` needs read on the record's object to list and download, and write to attach and remove. `download` never replaces an existing file without asking, and never writes through a symbolic link. See [`data-model.md`](data-model.md#files-and-notes).
- `permission-sets` takes the same flags and file as `roles` (`POST /v1/permission-sets`). A permission set adds to a member's role; see [`permissions.md`](permissions.md#permission-sets). `members update --permission-sets` sends the whole list.
- `automations create` and `update` read the API's shape (`name`, `trigger`, `condition`, `actions`, `hourly_cap`, `run_roles`; see [`automations.md`](automations.md)) from a YAML or JSON file. They send it as a dry run first and print the summary (every URL and email recipient as written), warnings and, for a schedule, the next runs on stderr; then they ask. Under `--no-input`, `--yes` is required, as for every confirmation. A `dry_run` key in the file is refused. Secret header values in the file are sent once and never printed back; `get` shows them as `null`, and `null` in an update keeps the stored value.
- `automations run` shows the dry run (each step: the exact HTTP request, the email recipient, records it would change) and asks before queueing the run. A member who may run an automation through its `run_roles` but can't manage it gets no dry run; the CLI says so and still asks. `resume` asks too, since it starts sends again.
- `webhooks secret` prints the signing secret alone on stdout (the explanation goes to stderr) after a confirmation (or `--yes`), and never stores it. Secrets are not available through MCP.
- `audit review` prints `GET /v1/access-review` (needs `audit:read`); `--json` has every permission, object and field rule, and key.
- `audit verify` exits 1 when the hash chain or an anchor fails verification. Rows the worker hasn't sealed yet are counted, not failed.
- Prompts (`auth login` without `--with-token`, confirmations) are read from the terminal, written to stderr, and answered no at the end of input.

## Schema packs

`crm pack init | validate | export | plan | install | list | uninstall` share and install a workspace setup (objects, fields, pipelines, roles and shared views) as a folder. The format, how upgrades and uninstalls behave, and safety notes for installing packs from others are in [`packs.md`](packs.md). `pack plan` exits 0 (nothing to change), 5 (changes) or 1 (the workspace can't take something); `pack install` and `pack uninstall` need `--yes` under `--no-input`; `pack uninstall` needs `--confirm-records` when the pack's objects or fields hold data, and lists the automations and alert rules that use the pack and exits 4 (`pack_in_use`) while any does. Packs are installed with an API key; a connected app (OAuth) can't install or uninstall them.

`pack install` applies exactly the plan it showed: it sends the plan's `plan_token`, and the server refuses (`plan_changed`, exit 4) if the workspace or the pack changed in between; run it again to see the new plan. Re-applying or upgrading keeps what was changed in the workspace since the pack wrote it (a tightened role, an edited view, field or object) and lists it as kept. `--overwrite-changes` (on `plan` and `install`) replaces those items: the plan prints each one before and after, a role's permissions and rules one by one, and marks anything that gives more access; asking (or `--yes`) confirms the data and access changes it showed. `--allow-downgrade` takes a version older than the one last installed, also after an uninstall. Pack files are read without following symbolic links and must be UTF-8. `pack export` keeps a view's filter only when it compares whole option keys, booleans or ratings (or tests for empty values).

## Not built yet

- Sandbox workspaces and promoting a schema from one workspace to another as a reviewed step (see [`ROADMAP.md`](../ROADMAP.md)). For now, `pull` from one workspace and `apply` the file to another.
- Archiving or renaming objects, removing pipelines and stages, and changing status transitions through schema apply.
- Publishing the package to npm.
