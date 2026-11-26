# Roles and permissions

Every request to the API is allowed or refused by two questions: does this key hold the permission the route needs, and, for record data, may it do that with this object and these fields? This page explains where permissions and record access come from and how they can be changed.

## The pieces

- **Permission:** one thing that can be done, such as `records:write` or `roles:manage`. The list is fixed in the code. `GET /v1/permissions` returns it.
- **Role:** a named set of permissions, kept per workspace. Every workspace has four system roles and can add custom roles. A custom role can also have object and field rules (see [Object and field access](#object-and-field-access)).
- **Permission set:** extra access on top of a role, built like a custom role (permissions, object rules, field rules). A member can hold several. See [Permission sets](#permission-sets).
- **Member:** a user or a service account. Each member has exactly one role, and any number of permission sets (up to 20).
- **API key:** belongs to one member. It has scopes (`admin`, `ops:write`, `ops:read`, `restricted:read`).

A member's access is their role and their permission sets together. Wherever this page says "the member's role" about what a member can do, read it as that combined access.

A key's effective permissions are the member's permissions (role and sets) **intersected with** what the key's scopes unlock. Scopes only narrow a key. A scope can never give a key something its member's role does not have. The role is read on every request, so changing a role (its permissions or its rules) or disabling a member takes effect on the next call, with the same key.

## Permissions

Permissions are in two areas. **Objects and fields** (`records:read`, `records:write`, `records:archive`, `restricted:read`): what may be done with records, refined per object and per field. **Features**: everything else, one per feature of the CRM. `GET /v1/permissions` gives each permission its `category` (`records` or `features`), and a role or set returns `record_permissions` and `feature_permissions` beside `permissions`.

| Permission | Allows |
|---|---|
| `records:read` | Read records, the schema, pipelines and events (the default for every object; see object rules) |
| `records:write` | Create and update records and run sales operations (default for every object) |
| `records:archive` | Archive and restore records, merge duplicates, bulk archive (default for every object) |
| `restricted:read` | See the values of restricted fields |
| `schema:manage` | Change objects, fields, pipelines and modules. Also erase a person's records for good ([data-model.md](data-model.md#erasing-a-persons-records)): there is no separate permission for that yet |
| `members:manage` | Add, change and disable members and service accounts; list and end their browser sessions and unlink their single sign-on (an owner's only by an owner) |
| `roles:manage` | Create and change roles and permission sets |
| `keys:manage` | Create, rotate and revoke API keys for other members, and list all keys |
| `webhooks:manage` | Manage webhook endpoints and their deliveries |
| `automations:manage` | Manage automations |
| `alerts:manage` | Manage workspace alert rules |
| `audit:read` | Read the audit log, schema history and access review |
| `views:manage` | Create, change and delete views shared with the workspace (personal views need only read access to their object) |

Anyone can manage their own keys without `keys:manage`, within the limits below.

### Permissions that reach record data

Three management permissions act on records themselves, so a role that holds one must also hold the record permissions it reaches:

| Permission | Requires | Why |
|---|---|---|
| `automations:manage` | `records:read`, `records:write`, `records:archive` | Automations run with those permissions: a saved automation can update, create and archive records, find records and send them out (HTTP requests, email), and `POST /v1/automations/test` shows record contents. |
| `webhooks:manage` | `records:read` | Webhook payloads carry the record (`GET /v1/webhook-deliveries/{id}` shows it), and an endpoint can be pointed anywhere. |
| `alerts:manage` | `records:read` | Backtests return sample records, and alerts can send records to webhooks. |

Creating or changing a role that breaks this is refused with 422, naming the missing permissions; the database refuses it too. `GET /v1/permissions` lists each permission's `requires`, so a role editor can add them automatically. The system roles already satisfy it.

These rules are about roles, because roles are the boundary between people. Key scopes are not: they narrow what one member's key can do, not what that member can arrange. A key that carries only the `admin` scope has no `records:*` permissions of its own, yet if its member's role holds `automations:manage`, `webhooks:manage` or `alerts:manage`, that key can still set up automations, webhooks and alerts that read, send or change records. Treat an `admin`-scoped key as having its member's record access.

## Scopes: a narrowing cap

| Scope | Unlocks |
|---|---|
| `ops:read` | `records:read` |
| `ops:write` | `records:read`, `records:write`, `records:archive`, `views:manage` |
| `restricted:read` | `restricted:read` |
| `admin` | `schema:manage`, `members:manage`, `roles:manage`, `keys:manage`, `webhooks:manage`, `automations:manage`, `alerts:manage`, `audit:read`, `views:manage` |

Example: a member with the `member` role and a key with scopes `["ops:read"]` can read records but not write them. The same member with an `admin`-scoped key still cannot change the schema, because the role lacks `schema:manage`.

A key can only carry scopes its member's role can use. Creating a key for a read-only member with the `admin` scope is refused.

## System roles

Each workspace starts with these four. They are locked: they cannot be edited or archived. To change one, create a custom role with `copy_from`.

| Role | Permissions |
|---|---|
| `owner` | All thirteen. Only an owner can grant, change or remove the owner role. Not available to service accounts. |
| `admin` | All thirteen |
| `member` | `records:read`, `records:write`, `records:archive`, `restricted:read` |
| `read_only` | `records:read`, `restricted:read` |

`owner` and `admin` have the same permissions. The difference is the owner-only rules below.

## Custom roles

A custom role is a key (2 to 40 lowercase letters, digits or underscores, starting with a letter), a name and a list of permissions. It needs `roles:manage`.

```sh
ADMIN_KEY=hlcrm_live_…

# A role that can work with records and manage webhooks, but not see restricted values
curl -s -X POST localhost:8787/v1/roles -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "integrator", "name": "Integrator",
  "description": "Records and webhooks, no restricted values",
  "permissions": ["records:read", "records:write", "webhooks:manage"]
}'

# Or start from an existing role
curl -s -X POST localhost:8787/v1/roles -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"key": "analyst", "name": "Analyst", "copy_from": "read_only"}'

# Give a service account that role (service accounts are for integrations and agents)
curl -s -X POST localhost:8787/v1/service-accounts -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Billing sync", "role": "integrator"}'

# Change an existing member's role
curl -s -X PATCH localhost:8787/v1/members/usr_… -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"role": "integrator"}'
```

Roles can be referred to by key (`integrator`) or by ID (`role_…`).

Other role endpoints: `GET /v1/roles` and `GET /v1/roles/{id}` (any authenticated key with at least one permission, so every member can read every role's definition and member count), `PATCH /v1/roles/{id}` to change a custom role's name, description or permissions, and `DELETE /v1/roles/{id}` to archive one. A role cannot be archived while an active member holds it. `PATCH /v1/members/{id}` and `PATCH /v1/service-accounts/{id}` take `role` and/or `active`.

## Permission sets

A permission set gives a member something their role doesn't, without a new role for every combination. It has the same shape as a custom role, in the two areas above:

```sh
# Deal desk: read and change deals, with the margin field read-only, and manage shared views
curl -s -X POST localhost:8787/v1/permission-sets -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "deal_desk", "name": "Deal desk",
  "permissions": ["views:manage"],
  "objects": { "deal": { "read": true, "write": true } },
  "fields": { "deal": { "margin": "read" } }
}'

# Give it to a member (the list is the whole list: sets left out are taken away)
curl -s -X PATCH localhost:8787/v1/members/usr_… -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"permission_sets": ["deal_desk"]}'

# Or when adding a member or a service account
curl -s -X POST localhost:8787/v1/service-accounts -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name": "Quote bot", "role": "read_only", "permission_sets": ["deal_desk"]}'
```

- **The most permissive wins.** A member can do something when their role or any of their sets allows it, and a field gets the widest access any of them gives. A deny, or a hidden or read-only field, shapes only the role or set it is written in: it never takes away what another gives. To keep a field from someone, no role or set they hold may show it.
- **Permissions that aren't per object are a plain union.** A member who holds `restricted:read` through one set sees restricted values on every object they can read.
- **Routes.** `GET /v1/permission-sets` and `GET /v1/permission-sets/{id}` (any member), `POST`, `PATCH` and `DELETE` (`roles:manage`), and `GET /v1/permission-sets/{id}/access` for what a set gives by itself. A set is referred to by key or by ID (`pset_…`). Roles and sets are named separately: a set may share a role's key, and neither is found through the other's routes.
- **The same rules as roles.** A set that holds `automations:manage`, `webhooks:manage` or `alerts:manage` must hold the record permissions they reach, and a set that manages those or the schema can't have denying rules or field rules. On an object with a rule, write needs read and archive needs write.
- **Escalation.** Creating or changing a set needs every permission and all record access it gives. Giving a set to a member needs `members:manage` and the same. Nobody changes their own sets, or changes or archives a set they hold. A set can't be archived while an active member holds it.
- **Where it shows.** `GET /v1/me` and `GET /v1/auth/session` list the caller's `permission_sets`; `GET /v1/me/access` is the combined result; `GET /v1/members` lists each member's sets; the access review lists each set with its permissions and rules, and `effective_permissions`.
- **Audited** as `permission_set.created`, `permission_set.updated`, `permission_set.archived`, and `member.permission_sets_changed` or `service_account.permission_sets_changed` with the sets added and removed.

In the web UI: Settings → Permission sets to define them, and Settings → Members to assign them. With the CLI: `crm permission-sets` and `crm members update --permission-sets` ([cli.md](cli.md)). The MCP servers have no tools for them, as for roles. Schema packs carry roles, not permission sets. See [ADR 0013](decisions/0013-permission-sets.md).

## Object and field access

`records:read`, `records:write` and `records:archive` are a role's defaults for every object. A custom role can change them per object, and limit single fields. System roles have no rules.

### Object rules

For one object (standard or custom), each of `read`, `write` and `archive` is `true` (allow), `false` (deny) or `null` (inherit the role's `records:*` permission). Rules work in both directions:

- A role with no `records:read` can be given read on `contact` only.
- A role with `records:read` can be denied `deal`.

On every object with a rule, write needs read and archive needs write. A role that breaks this is refused with 422.

### Field rules

For one field, `"none"` means the field is not visible (left out of every response, and it can't be written), and `"read"` means it can be read but not written. A field's definition is not data: `describe_object` (and `GET /v1/objects/{object}`) lists every field, with `access: "none"` for a hidden one, including a select's values, a json field's `shape` and an address's `parts`, the same for all of them. With no rule a field follows its object. Field rules only take away: they never give more than the object allows. Restricted fields still need `restricted:read` on top, hidden fields still need `include_hidden=true`, and archived fields stay hidden and unwritable.

Rules are stored by object and field ID, so renaming a field or relabelling an object keeps them. Rules on an archived field, or on an object whose module is off, are kept but do nothing.

### Setting rules

Rules are set with the roles API, by object and field name. `null` clears a rule. A `PATCH` changes only the objects and fields it names.

```sh
# Sales assistants: read and update contacts and accounts, never see deals, see phone numbers
# without changing them, and never see the internal notes field.
curl -s -X POST localhost:8787/v1/roles -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "sales_assistant", "name": "Sales assistant",
  "permissions": ["records:read", "records:write"],
  "objects": { "deal": { "read": false, "write": false } },
  "fields": { "contact": { "phone": "read", "internal_notes": "none" } }
}'

# A support bot that may only read contacts, with no records:read at all
curl -s -X POST localhost:8787/v1/roles -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" -d '{
  "key": "support_bot", "name": "Support bot", "permissions": [],
  "objects": { "contact": { "read": true } }
}'

# Later: let assistants see deals again, and clear the phone rule
curl -s -X PATCH localhost:8787/v1/roles/sales_assistant -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"objects": {"deal": null}, "fields": {"contact": {"phone": null}}}'
```

`GET /v1/roles/{id}` returns `objects` and `fields` in the same shape. `copy_from` copies a role's rules along with its permissions; rules in the same request apply on top.

To check the result, `GET /v1/roles/{id}/access` lists, for every object, what the role's holders can do (`read`, `write`, `archive`), the rule behind it, the limited fields, and the restricted fields with whether their values are visible. `GET /v1/me/access` shows the same for the calling key, after its scopes. `GET /v1/objects` and `GET /v1/objects/{object}` give each object and field an `access` value for the caller, and `GET /v1/schema` gives `records: null` for objects the caller can't read.

```sh
curl -s localhost:8787/v1/roles/sales_assistant/access -H "Authorization: Bearer $ADMIN_KEY"
curl -s localhost:8787/v1/me/access -H "Authorization: Bearer $OPS_KEY"
```

### What is enforced, and how

Route checks admit a key that has the needed access on at least one object; the record layer then decides per object and per field.

- **Reading.** Getting a record (by object or by ID), listing, `POST /v1/query`, search, timelines and `GET /v1/me/tasks` refuse an object the key can't read with 403, before looking the record up. Fields the key can't read are left out of every record, including the bodies of creates and updates, and `display_name` is built from the fields that remain.
- **Related records.** A relation to a record on an object the key can't read shows only its ID. Setting a relation, or `related_to` on an activity or task, needs read on the target object (otherwise a write could test whether an ID exists). Activities and tasks also list `related`: each related record's ID, object and `display_name` as the reader's role sees it (`null` for an object the reader can't read, and built only from fields they can read).
- **History activities.** Activities the platform writes have generic subjects: `Form submitted`, `Lead converted to a deal` and `Task completed`. They link to the records they are about (the lead and account; the lead, deal and contact; the task and its related records), so a reader who can see those records sees their names under `related`, and a reader who can't sees nothing more than the ID.
- **Filters and sorting.** Filtering or sorting on a field the key can't read, or following a relation path into an object or field it can't read, is refused with 403. Otherwise its values could be inferred from which records match.
- **Parts and paths.** An address's parts (`hq.city`) and a path into a json value (`meta.a.b`) are their field's: filtering, sorting or grouping by one needs read on the field (403 otherwise), and a restricted field's parts and paths are never filtered, sorted or grouped (422). A `filter[hq.city]` query parameter, a view's filter or sort, a bulk change by filter and an import's part columns (`hq.city`) go through the same checks. Export writes part columns only for an address the key can read. Search text holds an address's parts, so for an object with a hidden field, search matches only the parts of addresses the key can read (see Search).
- **Counts.** `count` on a list or query counts under the same filter, so it goes through the same check; it adds nothing a page of the same records wouldn't show, and stops at 10,000.
- **Aggregates.** `POST /v1/aggregate` refuses an object the key can't read, and grouping by or measuring (count of, sum, avg, min, max) a field it can't read, with 403; restricted fields can never be grouped or measured (422). The filter goes through the same check as listing. A group is data like any list, however small. A group key that is a relation shows the related record's ID, with a `display_name` built only from fields the key can read, and null on an object it can't read; keys of other relations are ordered by ID, never by a name. A group key that is a disabled user still shows their name. Totals of deal amounts show their currency, so they need read on `deal.currency`. An aggregate looks at the 100,000 most recently updated matching records at most and says so (`rows_capped`) when more matched; it takes rate-limit tokens by its shape (2, plus one per grouping and measure), and a count takes 2 on a list as on `POST /v1/query`.
- **Fields and include.** Asking for a field the key can't read in `fields` or `include`, or including a relation field it can't read, is refused with 403. An included record on an object the key can't read is its ID only; its `display_name` and fields follow the key's access to that object. An included user who has been disabled shows their name, which records still refer to, but `email: null`, as the member directory no longer lists them.
- **Saved views.** A view is not a grant: it runs with the reader's access, never its author's. Saving one checks the saver's access (a filter, sort, grouping or column on a field they can't read is refused). For each reader, a view whose filter, sort or grouping uses a field or relation path they can't read is listed with `status: "unavailable"` and without its `where`, `sort`, `columns` and `group_by`, because a filter value typed by its author may come from a field the reader can't see; running it (on a list, query, aggregate or export) is refused with 403, the answer the reader's own filter would get. The definition is shown only to a reader it runs for, under their access now: having written a view shows nothing more, because anyone with `views:manage` can change a shared view to use what its author can't read. A view that no longer fits the schema (`status: "broken"`) shows no definition either; its `problem` names the fields that no longer exist only to a reader who can read every other field it uses, and never quotes a filter value. Whether a view is available depends only on its definition and the reader's access, never on which records exist, so it reveals nothing about values. Columns the reader can't read are left out. Views of objects the reader can't read are neither listed nor found (404), also while the object's module is turned off; a view whose object no longer exists is seen only by its owner (a personal view) and by `schema:manage` holders. Personal views are seen only by their owner. Creating, changing or deleting a shared view, or sharing or unsharing one, needs `views:manage`; these changes are audited as `view.created`, `view.updated` and `view.deleted`, with the view's ID and name, never its filter. The view keeps who created it and who last changed it (`created_by`, `updated_by`).
- **Member directory.** `GET /v1/users` (and the `users` list in `GET /v1/objects/{object}`) gives active users' ID, name and email. A user is what an owner-like field holds, so the directory needs read on at least one field that refers to users (owner, assignee, …) on an object the key can read; a role that hides all of them gets 403, and `GET /v1/objects/{object}` lists `users` only when the key can read such a field of that object. No roles, sign-in details, service accounts or disabled users are listed.
- **Search.** Objects the key can't read are not searched (naming one in `objects` is a 403). For an object with a hidden field (`none`), search matches only the text fields the key can read instead of the precomputed search text, which holds every field. No index covers that, so it looks only at the object's 10,000 newest records (custom objects: most recently updated), which keeps it fast on a large table. A `read` rule doesn't change search.
- **Lists the server builds.** `GET /v1/me/tasks` filters on the assignee and status and sorts by due date, so it uses only what the key can read: it needs `task.assignee` (403 otherwise); with `task.status` hidden it lists all of the caller's tasks, done ones included; with `task.status` or `task.due_at` hidden it sorts newest first. `GET /v1/me/attention` gives `overdue_tasks: null` and an `overdue_tasks_note` when any of `task.assignee`, `task.status` or `task.due_at` is hidden.
- **Writing.** Creating or updating needs write on the object and on every field sent; a field the key can't write is refused with 403 naming it. A required field the key can't write blocks creating the record unless the field has a default value. Archiving needs archive on the object.
- **Operations.** Each operation checks, before looking anything up, every object it returns and every object and field it sets, and fails with 403 before doing any work:
  - `capture_interest`: read on contact and lead; write on contact, lead and activity (and the fields it sets); with a company domain, read and write on account. Without a domain, an existing contact's account is reused (on the lead, the activity and in `account_id`) only when the key can read `contact.account`.
  - `convert_lead`: write on the lead's `status`; read on contact and on `lead.contact`; write on deal and the fields it sets. The lead's account is copied to the deal only when the key can read `lead.account` (and then needs read on account). The default deal name is built from what the key can read of the contact and lead.
  - `move_deal_stage`: write on `deal.stage` (and `lost_reason` when sent). Leaving a lost stage clears `lost_reason` only for a key that can write it; otherwise it is left as it was.
  - `assign_owner`: write on the record's `owner` field.
  - `create_quote`: write on quote (and on quote_line_item when lines are given); the quote and each line then go through the normal create. A quote takes its deal's account, primary contact and name only where the key can read them on the deal.
  - `send_quote`: write on `quote.status`.
  - `accept_quote`: write on `quote.status` and on order. The deal is moved to its won stage only for a key that can write `deal.stage`; otherwise it is left as it is and the result says so.
  - `revise_quote`: write on quote and on quote_line_item.
  - `log_activity`: write on activity, read on every record in `related_to`.
  Bookkeeping the platform does after a change is not checked as the caller's write: a contact's lifecycle stage moving forward, history activities (`lead_converted`, `task_completed`), deal stage history, `last_activity_at`, account-contact links and a deal's probability from its stage.
- **Copies.** When the platform copies a value from one record into another on a caller's behalf (a contact's account into a new lead, a lead's account into a deal, names into a default deal name), it copies only what the caller can read on the source; otherwise the copy is left empty. Platform-written activity subjects carry no record values (see History activities).
- **Events.** `GET /v1/events` returns record events only for objects the key can read (filtered in SQL, so paging stays exact). Fields the key can't read are removed from `before` and `after`, a `deal.stage_changed` event loses its stage details when `deal.stage` is hidden, and an `alert.fired` event loses its title. Schema events (no record) are metadata and stay.
- **Schema.** Objects and fields are listed to anyone who can use the schema, with the caller's access: names are not data. Record counts in `GET /v1/schema` are given only for readable objects. The schema document (`GET /v1/schema/export`, `crm schema pull`) lists every object and field too, and adds `access` (as in `GET /v1/me/access`) when the key can't read, write and archive everything; plan and apply ignore it. Plan and apply need `schema:manage`, so they always run with unrestricted record access. Objects of a module that is turned off are left out of the document, as from `GET /v1/objects`.
- **Export.** `GET /v1/objects/{object}/export` (CSV or NDJSON) refuses an object the key can't read with 403 before doing anything (no audit entry is written for a refusal). A field the key can't read has no column, rather than an empty one, and its values are in no row. Filters, sorts and relation paths go through the same check as listing. Relations to records on an object the key can't read are IDs only, and `related` names in NDJSON follow the reader's access. Every export that returns rows is audited as `<object>.exported`.
- **Import.** `POST /v1/objects/{object}/import` checks everything before it reads a record, and refuses the whole request with 403, naming every column at once: write on the object (and read with an upsert key); write on every mapped field, so a column the key can't write must be mapped to `""`; read on the upsert key (matching on a field you can't read would show which values exist; a key you can read but not write still matches, and such rows can only update); read on a relation's target object, and on the field a relation is looked up by (`account.domain`). Owner lookups by member email need write on `owner`, like `assign_owner`. A lookup compares values as the field does (emails and domains ignore case, other unique fields are exact). Rows then go through the normal create and update, so every rule above applies to them, and their errors quote only the file's values. A cell holding `[restricted]` in a restricted field is left alone, so a redacted export imports back without overwriting values. For a key without `restricted:read`, a value in a restricted field always counts as a change (comparing it would confirm or refute a guess), so a dry run says "update" whatever the stored value is.
- **Record page layouts.** `GET /v1/objects/{object}/layout` needs read on the object; setting or removing a layout needs `schema:manage`. A layout names fields, never values, and changes no one's access: a field a role can't read is hidden on the page wherever the layout places it.
- **Files.** A file follows the record it is attached to: listing and downloading need read on that record's object, attaching and removing need write (`records:write`, or the object's rule). Field rules don't apply (a file is not in a field), so a role that can read an object can read every file on its records. A file's ID alone gives nothing: each call finds the record first, and refuses as it would refuse the record.
- **Restore.** `POST /v1/objects/{object}/records/{id}/restore` needs archive on the object (`records:archive`). When another record now holds one of the record's unique values, the refusal names the field only if the key can read it, and never the value. Warnings about relations to archived records cover only fields and target objects the key can read. A merged record can't be restored.
- **Duplicates.** `POST /v1/objects/{object}/duplicates` needs read on the object. Grouping on a field shows which records share its value, so a rule naming a field the key can't read is refused with 403; a default rule that would use one is skipped and listed in `skipped_rules`; restricted fields are never matched on (422). Groups are serialized as the key sees records.
- **Merge.** `POST /v1/ops/merge_records` needs write and archive on the object, checked before anything is looked up. The survivor's blank fields are filled from the duplicates only where the key can read and write the field (restricted values only with `restricted:read`); other fields are left as they are and named in `not_filled` when the key can read them. Choosing a field the key can't write, or a restricted value without `restricted:read`, is refused with 403. Field changes go through the normal update, so its checks and its events (filtered per reader) apply. A relation whose target object the key can't read is not filled (listed in `not_filled`), rather than failing the merge. Moving references is bookkeeping and happens on every object, including ones the key can't read or write (a reference left pointing at an archived duplicate would be corrupt data); the result lists moved references only for objects and fields the key can read, and each moved record's `reference_move` event is filtered per reader like any update. A real merge needs its dry run's `confirm_token`, which only the same credential can use (see [Confirm tokens and sessions](#sessions-and-keys)). A hierarchy cycle is named only to a key that can read `account.parent_account`.
- **Bulk changes.** `POST /v1/objects/{object}/records/bulk_update` needs write on the object and every field in `values`, and read on any relation target, checked before any record is looked up; `bulk_archive` needs archive. By filter, the key also needs read on the object, and the filter goes through the same guard as `POST /v1/query`. Each record then goes through the normal update or archive. Samples and row errors show records as the key sees them and quote only the request's values. A dry run's `confirm_token` works only for the same credential (the key, or the signed-in member), object, operation, filter or IDs, values and expected versions, once; the run changes only records it previewed. It is needed by filter, and by IDs above 25 records.
- **Batch create dry run.** `dry_run: true` on `POST /v1/objects/{object}/records/batch` runs every create, as the key, in a transaction that is rolled back; each record's outcome is shown as the key would see the created record.
- **Notifications.** Recipients see records as their role sees them. A notification goes only to members whose role can read the record's object, checked when it is created and again before its email is sent. Because an alert or automation notifies only when its rule matches, getting one would also tell the recipient what the rule looked at, so each recipient's role must also be able to read everything the rule depends on: the fields in its condition (and relation paths), its `changed_fields`, the field an event is about (`deal.stage` for `deal.stage_changed`, `lead.status` for `lead.converted`), a `field_passed` field, and for an `inactive` trigger, activities and `activity.occurred_at`. A recipient whose role can't is skipped each time the rule fires (record owners included). Saving a workspace alert or an automation `notify` or `send_email` step that names such a member succeeds with a warning naming them, since their role may change later; a personal alert like that is refused with 403, and checked again each time it fires. For automations, "everything the rule depends on" is the whole run: see the automation rule below. Alert titles and email record lines name the record as the recipient's role sees it; an automation's `notify` placeholders are filled from the record as each recipient's role sees it. A notification whose object the member can no longer read shows only the rule's name.
- **Idempotency.** A stored response is replayed only while the key's permissions and its role's rules are unchanged.
- **Rule changes.** Any change to a role's rules moves the role to a new `access_version` (database triggers on the rule tables do it, so a change made in SQL counts too), and every process reloads the rules on its next request.

- **Schema packs.** Every pack route (plan, apply, list, uninstall) first needs one of `schema:manage`, `roles:manage` or `views:manage`, checked at the gate (the route's `permission` lists them) before the body is read, a lock taken, a row read, a heavy-request slot used or any cost charged; a caller without them gets the same 403 for a pack that exists and one that doesn't. Then `POST /v1/packs/plan` and `/apply` need `schema:manage` for a schema part, `roles:manage` for roles and `views:manage` for views, all of them for the parts present (403 naming what is missing), and for the parts an earlier version of the pack already owns. `POST /v1/packs/{name}/uninstall` needs the permissions for what the pack owns. Routes can't admit "any permission" through `permission`; only the identity and catalogue routes (`/v1/me`, `/v1/roles`, …), whose scope is `any`, do. A re-apply or upgrade never overwrites a role someone changed since the pack wrote it unless asked (`overwrite_changes`), and any pack change that widens a role's access (a permission added, a deny or field limit removed) needs `confirm_access_changes`. A pack's roles are created through role creation, so the escalation rules below hold: the installer must hold every permission and all record access the role grants. Pack roles may only hold `records:read`, `records:write`, `records:archive`, `restricted:read` and `views:manage` (422 otherwise). A pack's views are created through view creation, so a view on a field the installer can't read is refused (403). Apply and uninstall are for keys and browser sessions only, never a connected app (OAuth) or a request through MCP (the credential table below). A pack's `plan_token` and an uninstall's `confirm_token` are bound to the credential that asked (`credential(ctx)`), like the bulk and merge tokens. An uninstall's dry run lists, under `in_use`, the automations and alert rules that use what it would archive (one of the pack's objects, a field it added (an address part or json path counts as its field), or one of its roles in an automation's `run_roles`); the real run is refused (409 `pack_in_use`) while any is listed. A personal alert rule is listed without its name. See [`packs.md`](packs.md).

### Roles that manage automations, webhooks, alerts or the schema

Automations, webhook payloads and alert backtests run with full record access, and schema management shows how many records hold a value in a field (archiving a field) and whether an object has data (turning a module off). A role that holds `automations:manage`, `webhooks:manage`, `alerts:manage` or `schema:manage` must therefore have unrestricted record access: no object rule that denies and no field rule. Saving such a role is refused with 422, and the database refuses it too (a deferred constraint trigger). Object rules that grant are allowed.

## Rules that stop escalation

- **You cannot grant what you do not hold.** Creating a role, editing a role, assigning a role, and creating a key for someone else each need the caller to hold every permission involved, and record access at least as wide as the role's, per object and per field. You cannot grant read on `deal`, or on a field, that you cannot read yourself. Editing a role checks its access before and after the change.
- **You cannot change a role you hold,** or archive it.
- **You cannot change your own role or disable yourself.**
- **You cannot act on a member who holds more than you do:** change, disable or mint keys for someone whose role or permission sets have a permission or record access you lack.
- **Owner-only rules:** only an owner can assign the `owner` role, change or disable an owner, or create, rotate or revoke an owner's keys.
- **The last active owner is protected.** It cannot be demoted or disabled, including when two owners try to demote each other at the same moment.
- **Key scopes stay within the caller's.** A key cannot create a key with a scope it does not itself have, and the new key's scopes must be usable by its member's role.
- **Keys cannot be created or rotated through MCP.** The API refuses those calls when they arrive on an MCP surface.
- **A rotated key keeps the old key's expiry.** Rotation never extends how long a key was meant to live.

### `keys:manage` acts as other members

A member with `keys:manage` who holds every permission of another member's role can create a key for that member. Requests made with that key act as that member: the audit log attributes them to that member, not to whoever created the key. Only the key's `api_key.created` entry (its actor, and `owner` in the details) shows who made it and for whom; the database also keeps it as the key's `created_by`. So `keys:manage` lets its holder act as anyone whose role it covers. Grant it sparingly, and check `api_key.created` entries where the actor and the owner differ.

## Sessions and keys

People can also sign in from a browser and get a session ([`docs/sign-in.md`](sign-in.md)). A session and a key are separate credentials for the same member:

| | API key | Browser session | OAuth connection (a connected app) |
|---|---|---|---|
| For | Scripts, integrations, agents, the CLI | A person in a browser | An MCP client a person approved ([`docs/mcp/oauth.md`](mcp/oauth.md)) |
| Identified by (`credential`) | The key: `key:<key ID>` | The signed-in member: `user:<workspace>:<member>`, shared by all their sessions | The grant (one approved connection of one member, one app, one MCP server): `oauth:<grant ID>`, shared by its refreshed tokens |
| Effective permissions | Role ∩ what the key's scopes unlock | The whole role (every scope the role can use) | Role ∩ what the granted scopes unlock, within the scopes the workspace allows apps now |
| Object and field rules | The role's, limited to what the scopes unlock | The role's | The role's, limited to what the scopes unlock |
| Read on every request | Yes | Yes | Yes (the token, the grant, the member, the role and the workspace setting) |
| Works on | Everything | Everything (writes need CSRF) | One MCP server only (ops or admin, fixed when approved); `/v1` takes it only from the MCP process with `MCP_SERVICE_SECRET` |
| Sent as | `Authorization: Bearer hlcrm_…` | The `__Host-hlcrm_session` cookie, only when there is no `Authorization` header | `Authorization: Bearer hlcrm_oat_…` to the MCP endpoint |
| Writes also need | Nothing more | `X-CSRF-Token` and a same-origin `Origin` | Nothing more |
| Audit surface | Whatever the client claims (`api`, `cli`, an MCP surface) | `web`, with the session ID in `details.session` | `ops-mcp` or `admin-mcp` from the token (never the caller), with `details.oauth_grant` and `details.oauth_client` |
| Rate limit and costs | Per key: bursts of 200, 20 a second | Per member, shared by all their sessions: the same budget | Per connection: the same budget |
| Heavy requests at once | 2 per key | 2 per member, across all their sessions | 2 per connection, and 4 per member across all their connected apps |
| Idempotency keys | Per key | Per session | Per connection |
| Confirm tokens (bulk, merge) | Work only with the same key | Work in any of the member's sessions | Work only through the same connection (the dry run and the run are both tool calls through it) |
| Lifetime | Until revoked or its expiry | 12 hours idle, 7 days at most | 60-minute access tokens, refreshed; the connection at most 180 days |
| Ended by | Revoking it, disabling the member | Signing out, revoking, a password change, disabling | Disconnecting it, "sign out everywhere", disabling, the workspace turning apps off |
| Can never | Use session-only routes; create or rotate keys through MCP | Act as a service account | Reach `/v1` except through the MCP process; use session-only routes (sessions, password, SSO, `/v1/auth/*`); create or rotate keys; change the workspace's sign-in or OAuth settings; turn on or replay restricted webhook payloads (an MCP surface) |
| Automations (manage, test, settings, suppression list) | With `automations:manage` (`admin` scope); `external_email` on and suppressions removed only off MCP surfaces (a key that sends an MCP surface header is refused too) | With `automations:manage`; everything, including `external_email` and removing suppressions | Admin connections only (`admin` scope, admin MCP server): create, change, pause, resume, test, run, suppress; never `external_email` on or a suppression removed (the token fixes the MCP surface) |
| Run on request (`POST /v1/automations/{id}/run`) | `automations:manage`, or a role in `run_roles` with `records:write` (needs `ops:write`) | The same (the whole role) | The same, through the connection's scopes: an `ops:read` connection never runs one (no `records:write`), even when its member's role is in `run_roles`. Only the admin MCP server has `run_automation` |
| Run attribution | `requested_by` the member; `requested_via` `{kind: key, key}` | `requested_by` the member; `requested_via` `{kind: session, session}` | `requested_by` the member; `requested_via` `{kind: oauth, grant, client}`, as in the audit entry |
| Schema packs (`/v1/packs`) | Plan, list, apply and uninstall with the pack permissions (`admin` scope); apply and uninstall are refused (403) for a key whose client sends an MCP surface header | Everything (writes need CSRF); a `plan_token` or uninstall `confirm_token` works in any of the member's sessions | Plan and list only (they write nothing; the plan's `plan_token` is bound to the connection, which can't apply it). Apply and uninstall, dry run included, are refused (403): a pack creates roles and changes the schema in one step, and there is no MCP tool for packs |
| Service accounts | Yes | No: only users sign in | No: only users approve apps |

A confirm token from one credential is refused (400) by every other: another key, another member, and across kinds even for the same member (a key, a session and each connected app are separate credentials, often with different scopes). Personal views and preferences (`/v1/me/*`) belong to the member, not the credential: a connected app acts as its member, so it sees and changes the same personal views and preferences as the member's sessions and keys, within its scopes.

A session is never narrowed by scopes, because scopes exist to make a credential smaller than its owner, and a person signed in is the owner. When a session creates a key, the key's scopes must be ones the member's role can use (a key can still only create keys within its own scopes). A few routes act only on the caller's own sign-in and are for sessions only: `GET /v1/auth/session`, `POST /v1/auth/sign-out`, `GET /v1/auth/sessions`, `POST /v1/auth/sessions/revoke-others`, setting or removing a password, and unlinking your single sign-on (`DELETE /v1/auth/sso`, after a sign-in in the last 10 minutes). They need no permission, so a member whose role holds none can still sign out. `DELETE /v1/sessions/{id}` ends one of your own sessions only from a session; with a key, or for anyone else's, it needs `members:manage`. Seeing or ending another member's sessions, or unlinking their SSO (`DELETE /v1/members/{id}/sso`), needs `members:manage`, under the same rules as changing that member (an owner's only by an owner, never someone holding permissions you don't), for listing as for revoking; a session you may not act on answers `404` like an unknown one.

Everything else works the same from a session as with a key, the read features included: counts, aggregates and saved views apply the role's object and field rules, and `views:manage` comes from the role alone (no scope narrows it). Requests that cost more than one rate-limit token (a count, an aggregate, an import) take them from the member's budget, so a browser pays for them as a key does. The same goes for the heavy-request gate (see [Limits](#limits)): two heavy requests at once per member, whichever of their sessions sends them.

**Confirm tokens and sessions.** The bulk and merge dry runs return a `confirm_token` bound to the credential that asked: an API key, a connected app's connection (`oauth:<grant>`), or for a browser session the signed-in member (`user:<workspace>:<member>`, the same identity the rate limit uses). So a token minted in one of a member's sessions applies in another of their sessions (a second tab, or after signing in again), and is refused with 400 for another member's session (whatever their role) and for an API key, even one the same member owns: a key is a separate credential, often with narrower scopes, so a preview made in the browser can't be applied by a script, or the other way round. A token minted through a connected app works only through that same connection: not through another app the member connected, not with their key, not in their session, and not after the app is disconnected and connected again (that is a new connection). The MCP tools run the dry run and the real run through the same connection, so the flow works end to end. A token is single-use and expires after 15 minutes either way. Personal views and preferences (`/v1/me/preferences`) belong to the member, not the credential: a member's sessions, keys and connected apps see the same ones (a connected app acts as its member), and a service account has its own. `POST /v1/query` and `POST /v1/aggregate` change nothing but are not `GET`, so from a session they need the CSRF checks like any write.

Creating or rotating an API key from a session needs a sign-in in the last 10 minutes. A key outlives the session that made it: signing out, revoking sessions and changing the password leave it working, so revoke keys separately (the access review lists them).

Changing how a workspace's members sign in (`PATCH /v1/workspace/sign-in`: the password switch, the single sign-on switch and SSO's allowed email domains, and whether and with which scopes apps may connect over OAuth) is for owners only, even though the route needs `members:manage`.

A connected app holds the scopes the member approved, which can only be scopes their role can use (`ops:write` falls back to `ops:read` for a role that only reads), and `admin` needs a sign-in in the last 10 minutes to approve. Listing and disconnecting another member's apps (`GET /v1/apps?member=…`, `DELETE /v1/apps/{id}`) needs `members:manage` under the same rules as their sessions; your own are `GET /v1/apps` or, from a session, `/v1/auth/apps`. A connected app itself can't list or disconnect apps (403), can't change the workspace's sign-in or OAuth settings (403), can't create or rotate keys (MCP), and is refused every session-only route like a key is.

## Disabling a member

`PATCH /v1/members/{id}` with `{"active": false}` (or the same on a service account) turns the member off, revokes every key they hold, ends all their browser sessions and disconnects every app they connected over OAuth, in the same transaction. The response says how many keys, sessions and apps were revoked. Re-enabling a member does not bring the keys back; create new ones. If the member's role was archived while they were disabled, re-enable them with a new role.

## Access review

`GET /v1/access-review` (needs `audit:read`) lists every user and service account with their role, effective role permissions, the role's object and field rules (`record_rules`), status, each key (scopes, environment, created, last used, expiry, revoked, and whether it is still usable) and, for users, `sign_in` facts: whether a password is set, whether single sign-on is linked, the last sign-in and how many browser sessions are live, and `apps`: the apps they connected over OAuth (client, where it sends the browser, scopes, MCP server, when connected and last used). It is a read-only snapshot you can export for a periodic review. It does not schedule or record reviews. Keep the output yourself if you need evidence that a review happened.

```sh
curl -s localhost:8787/v1/access-review -H "Authorization: Bearer $ADMIN_KEY"
```

## What is audited

Each of these writes an audit-log entry with the actor, key and surface: `role.created`, `role.updated` (with permissions added and removed, and the object and field rules that changed, by name: `object_rules` and `field_rules`; never record values), `role.archived`, `member.added`, `member.role_changed`, `member.disabled` (with the number of keys and sessions revoked), `member.enabled`, the same actions for `service_account`, and `api_key.created`, `api_key.revoked` and `api_key.rotated`. Sign-in and session events (`auth.*`) are listed in [`docs/sign-in.md`](sign-in.md#what-is-audited), and connected-app events (`oauth.*`) in [`docs/mcp/oauth.md`](mcp/oauth.md) and ADR 0010. Read them with `GET /v1/audit-log?action=role.` (the filter matches a prefix), and check the log's integrity with `GET /v1/audit/verify`.

## Limits

- **Heavy requests are gated.** Requests that can hold a database connection for seconds (the duplicate finder, merges, bulk update and archive, dry runs included, a batch create's dry run, import, export, and schema plan and apply, aggregates, and lists and queries with `count`) run at most 2 at once per credential (the API key; for a browser session, the signed-in member across all their sessions; for a connected app, its connection, with at most 4 at once across all of one member's connected apps) and at most half the connection pool (5) at once in a server process, so ordinary requests always find a connection. One over either limit is refused at once with 429 `too_many_heavy_requests` and `Retry-After: 1`, never queued. The rate limit and a route's extra cost are charged to the same credential. Previews are charged by their work: a bulk or batch-create dry run one token per 10 records (by filter, once the count is known), a merge 5 per duplicate. The gate and the buckets are in memory per process, like the rate limit.
- **Warnings about recipients name roles.** Saving an alert or automation warns about roles whose members can't read what it depends on. A member of such a role who can read it through a permission set still gets the notification.
- **`run_roles` names roles.** A permission set can't be listed to let its holders run an automation.
- **Record rules are per object and per field, not per record.** There is no record-level sharing (for example, "only records I own").
- **Some things a hidden field still changes are visible.** A record's `version` and `updated_at` change when a hidden field changes, and so do `*.updated` events (with the hidden field removed) and personal alerts on `*.updated` without `changed_fields`. A caller can tell that something changed, not what.
- **Search on objects with hidden fields is limited.** It doesn't use the search index and looks only at the object's 10,000 newest records (custom objects: most recently updated), so an older record can't be found by search for that role. Filter with `POST /v1/query` on a readable field instead.
- **Automation `notify` titles are rendered when they fire.** A title or body built from placeholders reflects the recipient's access at that time. Alert titles are rebuilt for a member with hidden fields on the object; automation titles are not.
- **A copy is the target's data.** A value the platform copied for a caller who could read it (a lead's account taken from its contact, a default deal name) belongs to the record it was copied into and follows that record's rules from then on, like a value the caller typed.
- **Activities written before this change keep their old subjects.** History activities used to carry the deal name (`Lead converted to deal "…"`), the task title (`Completed: …`) or the interest (`Interest: …`) in their subject. Those rows are history and are not rewritten; a role that can read activities can read those subjects.
- **Events still show that an operation happened.** A `lead.converted` event is listed to a role that can read leads even when `lead.status` is hidden; a `deal.stage_changed` event loses its stage details when `deal.stage` is hidden, but is still listed.
- **A merge or restore that fails on a unique value tells the key a value matches.** The field is not named and the value not shown when the key can't read it, but the failure itself is one bit of information about a hidden field.
- **A merge leaves hidden fields as the survivor had them.** A duplicate's value in a field the merging key can't read or write is not moved; it stays on the archived duplicate.
- **A confirm token proves the change was previewed, not that a person looked.** A client (or a model) can run the dry run and the real run back to back. The token stops a run from applying something other than what was previewed (other records, values or field choices, or records that changed since); per-call approval in the client is what stops an agent that was told to do it.
- **Bulk changes and events.** A bulk change emits one event per record, as single changes do. A real run of N records counts as N/3 requests against the key's rate limit, so a key can change about 60 records a second this way against 20 by single updates; automations keep their hourly cap and loop guards (see [`docs/data-model.md`](data-model.md#merge-restore-and-duplicates)).
- **Exports and imports see what the key sees.** An export by a limited role has fewer columns than one by an unrestricted role, so re-importing it elsewhere does not clear the missing fields (empty cells and missing columns leave values as they are). A key without `restricted:read` can still overwrite a restricted value it can't see, through import as through `PATCH`.
- **A view's name and its author are shown to everyone who can read its object** (for a shared view), even when its definition is withheld. Don't put a value in a shared view's name that some readers shouldn't see.
- **`views:manage` comes with the `ops:write` scope and with the `admin` scope.** Shared views are workspace configuration, but they are not a grant, so a key for record work and a key for configuration can each change them. Managing a view still needs read on its object, so an `admin`-only key (no `records:read`) can't use it, and a role whose only configuration permission is `views:manage` can't be given an `admin` key for it. The system `owner` and `admin` roles hold it; `member` and `read_only` don't (add it to a custom role). Existing `ops:write` and `admin` keys of members whose role holds it can manage shared views without being reissued.
- **The audit log is not filtered by record rules.** Its entries hold field names, not values, but some carry stage names, lifecycle stages and owner IDs. Give `audit:read` only to roles you would let see that.
- **Key scopes still decide what an `admin`-only key can arrange** (see above): a role that manages automations, webhooks or alerts has unrestricted record access by design.
- **The MCP servers and the SDK have no role-management tools or methods.** Manage roles and members through the REST API.
- **`hlcrm_test_` keys are not sandboxed.** The prefix is a label. A test key reaches the same live data as a live key.
- **The `X-Hlcrm-Surface` header is a convention, not a boundary.** The MCP servers set it so the API can refuse admin routes on the ops surface, but the client chooses it. Authorization comes from the permissions above. See [`docs/mcp/README.md`](mcp/README.md#prompt-injection-what-protects-you-and-what-does-not).
- **Automations** run with the permissions of the `ops:read` and `ops:write` scopes (records read, write and archive, no restricted values), whatever the role of the member who created them. Only members with `automations:manage` can create, change, pause, test or see the runs of them, and only they can turn on email to addresses that are not members (`PATCH /v1/automation-settings`, never through MCP).
- **Running an automation on request** (`POST /v1/automations/{id}/run`) needs `automations:manage`, or a role named in that automation's `run_roles` together with `records:write`. The run acts with the automation's access, not the caller's, which is why the list is empty until an admin fills it. A grant lets a member start what an admin designed, not reach past their own record access: the request is refused (403, without naming the field) when the automation depends on anything the caller's role can't read (the set below), and when it writes an object or field the caller's role can't write. Such a member must also be able to read each record they pass, gets run IDs back but no step output, and can't dry run it or read its history. An automation can still send data out (HTTP, email) that the caller could not send themselves; that is the admin's design.
- **Automation emails and notifications** follow the notification rule above for members: the recipient's role must be able to read the record and **everything the run depends on**, worked out from the definition the same way at save and at run: the trigger's object and fields, the condition, every `if` filter on any step (a `stop` with an `if` included), every `find_records` and `for_each` filter and sort (inside `for_each` too), and every field any placeholder names, through step outputs to the fields of the records they carry (a whole found record counts as all its fields). After a step whose gate or text uses another step's output (read with the automation's access), a member whose role has object or field rules gets nothing. Email to anyone who is not a member is off unless the workspace turns it on; the run log and audit name such recipients by a keyed hash, never the address.
- **External email reaches whoever controls the address.** It carries the fields its template names, and what the run depends on, to the holder of the recipient address, whatever their role. When the address comes from a record field and the run was started by a member's change to that field (or by a member asking for a run on a record they chose) and that member's role can't read everything the run depends on, the email is skipped. Other ways to change the address (an import, another automation, a change long before a scheduled run) are not covered; saving warns which roles can't read what such an automation sends.
- **The email suppression list** needs `automations:manage` to add to (`POST /v1/email-suppressions`) and to remove from: with `records:write` alone, a key could stop the workspace's email to anyone. `POST /v1/email-suppressions/check` needs `records:read` and shows the free-text reason only with `automations:manage` Removing an address is refused through MCP (keyed on the request's surface, so for keys that say they are MCP and for connected apps alike): letting automations email someone who asked not to be is a person's decision, like turning external email on.
- **Credentials and automations.** The hourly caps, the run queue's limits and the workspace caps count runs and sends, whoever asked; the rate-limit cost of a run request (2, plus 2 per record) and the heavy-request slot of a dry run or a test go to the credential that asked (`credential(ctx)`: the key, the member's sessions together, or the connection). The checks for `run_roles` use the caller's record access as the credential narrows it: a connected app's scopes, like a key's, can take away `records:write` and so the right to run at all. What a run does is the automation's, never the credential's: it runs with the automation's own access whatever credential asked.

See [ADR 0007](decisions/0007-roles-and-permissions.md), [ADR 0008](decisions/0008-object-and-field-permissions.md) and [ADR 0013](decisions/0013-permission-sets.md) for why it is built this way.
