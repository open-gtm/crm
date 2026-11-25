# 0015: Boards, calendars, grouped lists and record page layouts in the web UI

Status: accepted (2026-11-24)

## Context

The web UI showed every object as a table and every record as two fixed sections of fields (Details, Custom fields). The one board was the deals board, built for pipeline stages. People who run a support desk or a hiring pipeline on custom objects had no board, nobody could see records on a calendar, a table couldn't be grouped, and nobody could decide what a record page puts first.

## Decision

**Three more ways to show a list, all read from metadata.** A custom object gets them with no change.

- **Board:** one column per value of any select or status field, plus one for records without a value. A card moves by dragging its handle (mouse, or keyboard: Space, arrows, Space) or from its Move menu. Moving sets the field with an ordinary update, with the record's version, so every rule of an update applies: a status that may not move is refused by the server and the card stays. Each column shows its 30 most recently changed records and its count; a column with more says so. The deals board stays its own page: a deal's stage is a pipeline's stage, moved by `move_deal_stage`.
- **Calendar:** a month of records on the day of any date or date-time field, or of when they were created. One request per month, at most 500 records, and it says when a month holds more. A date-time falls on the reader's local day.
- **Grouped table:** rows grouped by a select, status, yes/no, rating or to-one relation field, with each group's count and the totals of the number columns shown, from the aggregate endpoint. A group loads its records when it is opened.

**They need no new API.** `POST /v1/query` and `POST /v1/aggregate` already filter, sort, count and total with the caller's access. A layout asks for slices of the list the member is looking at: the filter in the address, else the saved view's. A field the member can't read is never offered as a board, date or grouping field.

**The layout is the member's, not the view's.** It lives in the list's address (`layout`, `by`, `group`, `month`), so a link opens the same thing, and is remembered per object in the member's preferences. A saved view still holds a filter, a sort and columns; changing view keeps how the list is shown.

**Record pages get one layout per object, set by someone who manages the schema.** A layout is named sections, each an ordered list of fields (`GET`, `PUT` and `DELETE /v1/objects/{object}/layout`; table `page_layouts`, migration 022). It is the workspace's, not each member's: a record page is where a team agrees what matters.

- **A layout arranges; it grants nothing.** A field a member can't read stays hidden wherever the layout puts it. A field the layout leaves out is still shown, after the sections, under "Other fields": adding a field to an object never needs the layout changed for it to be seen.
- **Fields are kept by ID,** so a renamed field keeps its place, and an archived one drops out.
- **Key facts stay in the header** (a status, money, the owner), as before.
- **The editor moves things with buttons,** not dragging, so it works from the keyboard and on a phone.

## Consequences

- Boards and calendars ask for a bounded number of records and say when there are more; they are for looking at a filtered slice, not for paging through everything.
- A board column's cards are ordered by most recently changed, not by hand: there is no stored card order.
- Grouping is one level deep. Counts and totals follow the aggregate endpoint's limits (the 100,000 most recently changed matching records) and the page says when they are capped.
- Page layouts are not in the schema document (`crm schema pull`, `apply`) or in schema packs yet, and the CLI has no command for them: the REST routes and the web editor are the ways to set one.
- Notes, files, related records and the timeline keep their places on a record page; a layout arranges fields only.
- Translations of the UI were not part of this.
