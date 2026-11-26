# 0020: Data disposal: deleting a workspace and erasing a person's records

Status: accepted (2026-11-26)

## Context

Nothing was ever deleted. Records are archived, the audit log is append-only, and there was no way to remove a workspace or a person's data. The docs described erasure and tenant deletion as if they existed (security review H3). A hosted service can't hold customers' data without a way to delete it, and anyone who stores people's details needs a way to honour a request to be forgotten.

Two operations are built: deleting a whole workspace, and erasing one person's records inside a workspace.

## Decision: deleting a workspace

**Everything the workspace has goes, in one transaction.** Every row in every tenant table, the bytes of its files in an outside store, its sessions, keys, OAuth grants and tokens, its audit log, its data key, and its row in the tenant directory. Deleting the data key makes anything encrypted with it unreadable wherever a copy remains (a bucket object that was missed, a backup): restricted field values, webhook and automation secrets, files in S3, idempotent replay copies.

**The tables are read from the catalog, not listed by hand.** Every tenant table has a foreign key from its `tenant_id` to `tenant_directory`; the purge deletes from every table that has one. Tests fail when a table has a `tenant_id` column without that foreign key, and when a table without `tenant_id` is not on a short list of tables decided to hold nothing of a workspace (`oauth_clients`, `oauth_assertions`, `sign_in_flows`, `schema_migrations`, `deleted_workspaces`). So a new table can't be left out by forgetting it.

**One statement.** The deletes run as one statement with a data-modifying CTE per table, so foreign keys between tenant tables are checked once against the end state. No order has to be worked out, and tables that refer to each other (deals and leads) are no special case.

**It runs as a `SECURITY DEFINER` function, `app.purge_tenant`.** The app role may not delete audit rows, roles, schema history or merges, and that must stay true: an append-only audit log the application could empty would prove nothing. The function is owned by the migrator role and is the one path. It takes a whole workspace or nothing, refuses a workspace whose audit log has unsealed rows, and always writes a tombstone the app role cannot write or change. Triggers that fire before a row is deleted (the audit guard, order lines, a sent quote's lines, the record registry) stand aside only inside it: the test is who is running (`app.purging()`: the function's owner, entered from another session role, with the function's own flag set), which nothing the app role can `SET` makes true. A test fails for a new `BEFORE DELETE` trigger that doesn't check it.

What this changes about the app role: it could already delete most of a workspace's rows by setting its tenant, and it can now call the purge for any workspace ID. A leaked app credential could therefore delete a workspace including its audit log, where before the audit log would have survived. The tombstone is what remains: it can't be suppressed, and a copy goes to write-once storage. This is accepted; the alternative (a separate privileged connection for deletion only) adds a second database credential to every deployment for little gain while the app role can already destroy the data itself.

**The tombstone** (`deleted_workspaces`, and `deleted-workspaces/<id>.json` in blob storage) holds the workspace's ID, when it was created and deleted, who asked (an owner's user ID, or the operator), how many rows each table held, and where its audit chain ended (row count, last position, last hash). The deletion is the chain's last entry (`workspace.deleted`), sealed in the same transaction. No name, member or record. Anchors already written to write-once storage stay: they hold a workspace ID and hashes, and with the tombstone they let someone holding an earlier export of the audit log check it against where the chain ended.

**Two ways in.**

- *An owner*, through `POST /v1/workspace/deletion` with `confirm_name` set to the workspace's name. Owners only, as a person: with their own API key or a browser session, never an app connected over OAuth and never through an MCP server (an agent should not be able to delete the workspace it works in, whoever's key it holds). The deletion waits out a grace period, `WORKSPACE_DELETION_GRACE_DAYS` (7 by default; 0 deletes on the worker's next pass, within a minute). Until then the workspace works as before, `GET /v1/workspace` shows `deletion` to every member, and any owner can withdraw it with `DELETE /v1/workspace/deletion`. The worker carries it out, re-reading the request inside the workspace first. A deletion that fails is logged and tried again on the next pass.
- *The operator*, with `hl-crm-db-server delete-workspace --workspace ws_… --confirm ws_…`. At once, no grace period. The ID twice is the confirmation.

When a deletion is due is kept in `tenant_directory.delete_after`, which extends ADR 0002: the directory now holds an ID and two timestamps, still nothing of the customer's. It is there so the worker finds due workspaces in one query without entering every workspace.

**Files in an outside store** are deleted object by object before the rows, inside the transaction that holds the workspace locked. If the store fails, nothing is deleted from the database and the deletion is retried; objects already removed stay removed.

## Decision: erasing a person's records

**What can be erased:** a contact, a lead, or a record of a custom object (a candidate, a patient). Accounts are organisations and are refused, with a pointer to erase the contacts at the account; deals, tasks, activities, quotes and orders are refused too.

**The row stays.** It is blanked, archived and marked (`anonymized_at`, shown as `erased_at`), so a deal, a quote or an order that refers to it still does. A contact keeps its lifecycle stage, account, owner and dates; its names, email, phone, job title, source, external IDs and every custom value go (`last_name` becomes `[erased]`, since a contact must have a name or an email). The design cleared only fields classed confidential or restricted; this clears every custom value, because free text in a field nobody classified is exactly where personal details end up.

**What goes with it:**

- Records merged into it. A merge archives the duplicates with their values intact, so they are the same person's data. A merged duplicate can't be erased on its own: the request is refused naming the survivor.
- For a contact: every lead of that contact, and the contact's links to accounts (role cleared, archived) and deals (custom values cleared; the buying role stays).
- Every activity and task about any of those records, or done by the contact: subject or title becomes `[erased]`, body, description, payload and custom values go. That something happened, of which type, when, and about which records stays, so a deal's timeline keeps its shape. This is deliberately broad: a note attached to a deal and to the contact is blanked too.
- Their files: bytes deleted, name and hash blanked.
- The values of their custom relation fields. Links other records hold to them stay.
- Copies the server made: the data of events about them, webhook delivery payloads built from those events (one not yet sent is never sent), automation run results (a run not yet finished is skipped), notifications about them (blanked and resolved), alert deadlines, and the survivor's earlier values that a merge kept.
- A contact's email address is added to the suppression list as a keyed hash (`suppress_email: false` leaves it off), so automations don't write to the person again. This is the design's "consent tombstone"; consents and contact points themselves are not built.

**What it does not reach,** said in the result (`not_erased`) and in the docs:

- Values someone copied into another record: a deal named after the person, a note on an account. The result lists up to 50 other records whose searchable text holds the contact's email address or full name (`possible_copies`), for a person to look at.
- Sent quotes and orders, which keep the customer's name as issued. Financial documents are kept as they were agreed.
- The audit log. It holds field names, IDs and counts, not values, and can't be changed.
- Saved views whose filter someone typed the person's email into.
- Idempotent replay copies: sealed with the workspace key and deleted after 24 hours.
- Backups, until they age out, and whatever a webhook already delivered to another system. A `<object>.erased` event tells subscribers to do the same.

**Permission.** Erasure needs `schema:manage`, under the `admin` scope, so it is refused on the ops MCP server. It removes values whatever the caller's role could read, and `schema:manage` is the permission whose holders must already have unrestricted record access. No permission was added: the permission list is being kept as it is for now, and a `records:erase` permission can be split out when `schema:manage` is.

**A dry run first.** `dry_run` defaults to true and returns counts, the IDs to be blanked and a `confirm_token`. A real run needs the token, which is bound to the credential and to exactly the set of records, activities and tasks the dry run listed: if something was added since, it is refused. One erasure blanks at most 5,000 rows.

**Database guards stay, with narrow openings.** A converted lead is read-only except for the one change that marks it erased. An activity is immutable except that it may be blanked to exactly the erased shape. A merge row is append-only except that `app.erase_merge_values` (owner-run, like the purge) may null the kept values.

**Surfaces:** `POST /v1/objects/{object}/records/{id}/erase`, `POST /v1/ops/erase_contact` (the same, under the design's name), `erase_record` on the admin MCP server, and `crm data erase`.

## Consequences

- A workspace can be removed on request, and a person's data can be erased, with a record of each that holds no personal data.
- Unmerge, when it is built, can't restore a survivor that was erased.
- The tenant key cache in other processes holds a deleted workspace's key for up to five minutes. Nothing can use it: the keys, sessions and rows are gone.
- `sign_in_flows` may hold a deleted workspace's ID for the minutes until a sign-in step expires.

## Not built

- A screen in the web UI for either operation, and a `crm` command for deleting a workspace.
- Email to owners when a deletion is scheduled or carried out.
- Erasing an account, for sole traders kept as accounts.
- Consents, contact points, and a retention schedule that erases on its own.
- An object-lock store for the tombstone copy (blob storage is a local directory; see the threat model).
