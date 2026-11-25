# 0014: Quotes and orders, the first part of the Commerce module

Status: accepted (2026-11-24)

## Context

The data model has described a Commerce module since the start (`docs/data-model.md` §5.4): products, prices, price books, quotes and orders. None of it was built, so a deal could be won with nothing saying what was sold, at what price, or what the customer agreed to. Quotes and orders are the part people ask for first, and they stand without the catalogue: a line can say what is sold in words.

## Decision

**Build quotes, quote lines, orders and order lines now; products and prices later.** They are standard objects in a new `commerce` module (on for new workspaces, turned on for existing ones), in typed tables like deals. A line has a description, a quantity, a unit price, a discount and a tax amount; its `product_id` column is a plain `uuid` that gets its foreign key when the catalogue is built, as `leads.interest_product_id` waits for the same.

**A quote is made for a deal, by default.** It takes the deal's account, primary contact and name, each only when the caller can read it on the deal (a copy follows its source, ADR 0008). `quote_requires_deal` is a workspace setting: turned off, a quote can stand alone, for an account or a contact. A quote always has a customer of record: an account, a contact or both.

**Quotes and their lines are records; their life is operations.** Creating a quote, adding and changing its lines, and reading everything go through the ordinary record routes, so lists, filters, saved views, permissions, the web UI, the CLI and the generic MCP tools work with no special case. Three steps are named operations, because each does more than one write and two can't be undone:

- `send_quote`: a draft becomes sent. From then on its name, lines, amounts, terms and validity are fixed. It needs at least one line. A snapshot keeps the customer's names as they were. Earlier versions of the same quote that were sent and not accepted are superseded.
- `accept_quote`: a sent quote becomes accepted, and an **order** is made from it: the quote's amounts, terms, customer and a copy of each line. The deal's other open quotes are superseded, and the deal moves to its pipeline's first won stage when `accept_quote_marks_deal_won` is on (the default). A quote past its `valid_until` date isn't accepted. A deal has at most one accepted quote.
- `revise_quote`: makes the next version of a sent, rejected or expired quote, as a new draft with the same lines, numbered after the first (`Q-0007-2`). The earlier version stays until the new one is sent.
- `create_quote` is a convenience: a quote and its lines in one call, each through the normal record creation.

Sent, accepted and superseded can only be reached through these (the status field's `operation_only_categories`); rejected and expired are set by hand. Orders move pending → active → fulfilled, or to cancelled, by a normal update.

**Amounts come from the lines.** A line's total is quantity times unit price, rounded to the minor unit, less its discount, plus its tax. A quote's subtotal, discount, tax and total are the sums, set by the server whenever a line is added, changed, archived or restored, and once more when the quote is sent. Nobody writes them. Tax is an amount entered per line: nothing is calculated. Money is in minor units and the workspace's one currency, like deals.

**Immutability is in the database too.** Triggers refuse changing what a sent quote said, changing its lines, changing an order's commercial columns and changing or deleting an order's lines. The service layer refuses first, with a message that says what to do instead. Two things stay changeable on purpose: the status, and the customer references (`account_id`, `contact_id`), so a merge of two accounts or contacts can move quotes and orders to the survivor. What the document said is in its snapshot.

**Numbers** (`Q-0001`, `O-0001`) come from `number_sequences`, one counter per workspace and document type, taken inside the creating transaction. A quote gets its number when it is created, not when it is sent as the design had it: a draft that people discuss needs a name. Drafts that are archived leave gaps.

**Orders are written only by accepting.** Creating an order or an order line directly is refused. The design's orders without a quote (renewals, cancellations) come with contracts.

**Existing workspaces get the new objects from the catalog, not from SQL.** After the migrations, the migrator adds any standard object a workspace lacks from `CATALOG`, logging each as a schema change. The catalog stays the one definition of the standard objects; a migration never repeats it. A workspace that already has a custom object by a standard object's name keeps its own, and it is logged.

**Automations and alerts** can trigger on `quote.sent` and `quote.accepted`, beside the usual `quote.created`, `order.created` and so on.

## Consequences

- An operation checks what it writes before it looks anything up: `send_quote` needs write on `quote.status`; `accept_quote` also needs write on orders. Marking the deal won is done only for a caller who may change `deal.stage`; otherwise the deal is left alone and the result says so.
- Accepting a quote on a deal doesn't change the deal's amount. The design's "amount = total of the primary quote" is not built.
- Sending a quote records that it was sent. It does not email it or produce a document.
- No products, prices or price books, no tax calculation, no multi-currency, no quote expiry job (a quote past `valid_until` is refused when accepted, and can be set to expired by hand), no contracts or invoices. `activate_order` in the design becomes a plain status change until contracts exist.
- The `commerce` module needs `sales`: turning sales off while commerce is on is refused.
- Migration 021 adds the four tables, `number_sequences` and the triggers, and turns the module on for existing workspaces.
