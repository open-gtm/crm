# 0017: Record page layouts that agents and people edit together

Status: accepted (2026-11-25). Extends [ADR 0015](0015-record-ui-layouts.md).

## Context

ADR 0015 gave each object one record page layout: named sections of fields, set through `PUT /v1/objects/{object}/layout` or the web editor. Three things were missing.

- **Only fields could be arranged.** Notes, files, related records and the timeline sat where the page put them, and a deal's page couldn't put its quotes or open tasks where a team wants them.
- **An agent couldn't do it.** The project's premise is that agents work the CRM over MCP, and a person looks at what they did. There was no layout tool on the admin MCP server, and layouts weren't in the schema document, so the web editor was the only comfortable way to change one.
- **A change went straight to everyone, and left no trace.** Saving replaced the layout for the whole workspace at once. Nothing said who had changed it, through what, or what it had looked like before.

## Decision

**A layout arranges components, not only fields.** It has key facts for the header, an optional band across the top, and three columns (`left`, `main`, `right`) of components in order:

| Type | What it shows | Settings |
|---|---|---|
| `fields` | A section of fields | `name`, `columns` (1 or 2), `collapsed`, `fields` |
| `related` | Records of another object that point at this one | `object`, `field` (which relation, when there are several), `rows` |
| `related_lists` | Every related list not placed on its own | |
| `timeline`, `notes`, `files` | As on every record page | |
| `tasks`, `quotes` | Open tasks linked to the record; its quotes | `rows` |
| `stage_path` | A deal's pipeline stages, or the values of a status field | `field` |
| `agent_changes` | What was changed on this record through API keys, MCP and the CLI | `days` |

`timeline`, `notes`, `files`, `tasks`, `quotes`, `stage_path`, `agent_changes` and `related_lists` appear at most once, a field in at most one section, and a related list once. Only a `stage_path` goes across the top. Every component has an `id`, given by the server when the caller sends none, so that a later change reads as "moved Commercial above Details" and not as a removal and an addition.

**What a layout leaves out.** A field in no section is still shown, under "Other fields", as ADR 0015 decided: adding a field never needs a layout changed. `related_lists` does the same for related records. Any other component left out is off the page: that is the point of arranging it.

**A layout arranges; it never grants access.** Nothing here reads a record. A field a member's role can't read stays hidden wherever it is placed, a related list shows what the member may read of that object, and the web page asks for each component's data with the member's own access. Saving a layout warns when a placed field is restricted or hidden, because the person arranging the page usually sees more than its readers.

**One shared draft per object.** People in the web editor and agents over MCP change the same draft. Record pages keep showing the published layout until someone publishes.

- A write sends the whole layout and the draft `revision` it read. A draft that changed since is not overwritten: the write is refused (409) and names who changed it and through what. A write that sends no revision while a draft exists is refused too (428).
- Every change to the draft is recorded with its source: the member, the surface (`web`, `admin-mcp`, `cli`, `api`), the connected app or API key by name, an optional note (what the person asked the agent for), and what it changed in sentences.
- The newest change can be undone. An earlier one can't, because later changes were made on top of it; the draft can be edited or discarded instead. A person can mark an agent's change as reviewed.

**Every change is shown before it is made.** Each write takes `dry_run`: the answer is the list of changes in sentences ("“Details”: added Probability", "Moved the Quotes list from the main column to the right column") and the warnings, and nothing is saved. The admin MCP tools default to a dry run, like the schema tools. The web editor shows the same diff before publishing.

**Publishing makes a version, and versions are kept.** `POST …/layout/publish` makes the draft the object's next version. A version records who published it and through what, what changed, and who contributed to its draft. The newest 50 are kept. Restoring a version puts it into the draft, to be looked at and published like any other change. Resetting to the default page is a version too.

If the published layout changed after a draft was started (someone applied a schema document), the draft is stale: publishing it is refused until the caller says `overwrite`, so one path never silently undoes another.

**The same on every surface.**

| | Read | Change the draft | Publish | History | Restore |
|---|---|---|---|---|---|
| REST | `GET …/layout`, `GET …/layout/draft` | `PUT …/layout/draft`, `DELETE`, `…/draft/undo`, `…/draft/review` | `POST …/layout/publish` | `GET …/layout/versions[/n]` | `POST …/layout/restore` |
| Admin MCP | `get_page_layout` | `set_page_layout`, `discard_page_layout_draft` | `publish_page_layout` | `list_page_layout_versions` | `restore_page_layout` |
| Schema-as-code | `crm schema pull` | | `crm schema plan`, `apply` | | |

Everything but reading the published layout needs `schema:manage`.

**Schema-as-code publishes directly.** An object's `layout` is part of the schema document. `plan` shows what it would change; `apply` publishes it as the next version, with `cli` as its source. It doesn't go through the draft: a schema file has its own review, in a pull request. A document without the key leaves the layout alone, and `layout: null` is the default page. `PUT …/layout` does the same for scripts, and still accepts ADR 0015's `sections`, which replace the page's field sections and keep the rest.

**With no layout published, the page is a default one** in the same form: every field under Details (and Custom fields), then the timeline, notes and files, then related lists and open tasks, with a stage path on deals. An agent that reads it gets something it can change.

## Not chosen

- **A layout per member** ("Just me"). ADR 0015 made the record page the team's: where it agrees what matters. A personal arrangement on top raises questions that aren't answered yet (does a field the team adds appear? what does an agent edit?). Left as an open question.
- **Merging two people's changes.** A draft is small and changes rarely; refusing the second write and showing who got there first is easier to trust than a merge of two layouts.
- **Undoing any earlier change.** It needs the inverse of a change applied to a draft that has moved on, which is a merge by another name.
- **Recording layout changes in `schema_changes`.** That table versions the schema, and its version is quoted in `If-Match` and cache keys; a page arrangement isn't schema. The cost: a layout another path published since a document was pulled is not reported as drift by `crm schema plan`. The plan still shows what applying would change.

## Consequences

- Migration 024 adds `page_layout_versions`, `page_layout_drafts` and `page_layout_changes`. Layouts from before it are read as they were (their sections take the left column of the default page) and become each object's first recorded version, with an unknown source.
- A draft's changes are removed when it is published or discarded; the version keeps a summary of them. At most 100 are kept per draft.
- A source's `via` is the name the connected app or key had at the time. It is a label for people, not an identity: the audit log has the grant and key IDs.
- Layouts in schema packs are not applied yet; a pack that carries one gets a note.
- The `agent_changes` component only says that the page shows such a list. What it lists comes from the record's events, with the reader's access, and events carry the surface but not the key or app: the list can say "through MCP", not which client.
- The web editor, the "Customize page" entry on a record, "Preview as" a role and the record page that draws components are the next change. Until it lands, the web shows a layout's field sections as before.
