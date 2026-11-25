import type { Tx } from "../../db/pool.js";

/**
 * The SQL of quotes and orders (core/commerce.ts, core/commerce-hooks.ts; docs/data-model.md §5.4, ADR 0012).
 * The code that calls these keeps its checks, errors, audits and the order of statements in its transaction.
 */

// --- Settings and numbers ---------------------------------------------------------------------------

/** The workspace's lifecycle options (tenants.lifecycle_options), where the commerce settings are kept. */
export async function lifecycleOptions(tx: Tx): Promise<Record<string, unknown>> {
  const [row] = await tx<{ lifecycle_options: Record<string, unknown> }[]>`SELECT lifecycle_options FROM tenants`;
  return row?.lifecycle_options ?? {};
}

/** Sets the lifecycle options named in `patch`, leaving the others as they are. */
export async function mergeLifecycleOptions(tx: Tx, patch: Record<string, unknown>): Promise<void> {
  await tx`UPDATE tenants SET lifecycle_options = lifecycle_options || ${tx.json(patch as never)}`;
}

/** The next number of a document type in this workspace. Taken in the caller's transaction, so no two documents share one. */
export async function nextDocumentNumber(tx: Tx, tenantId: string, docType: "quote" | "order"): Promise<number> {
  const [row] = await tx<{ n: string }[]>`
    INSERT INTO number_sequences (tenant_id, doc_type, next_value) VALUES (${tenantId}, ${docType}, 2)
    ON CONFLICT (tenant_id, doc_type) DO UPDATE SET next_value = number_sequences.next_value + 1
    RETURNING (next_value - 1)::text AS n`;
  return Number(row!.n);
}

// --- Deals, as quotes need them ---------------------------------------------------------------------

export interface DealForQuote { id: string; name: string; account_id: string | null; primary_contact_id: string; pipeline_id: string; status_category: string;
  archived_at: Date | null }

export async function dealForQuote(tx: Tx, dealId: string): Promise<DealForQuote | undefined> {
  const [row] = await tx<DealForQuote[]>`
    SELECT id, name, account_id, primary_contact_id, pipeline_id, status_category, archived_at FROM deals WHERE id = ${dealId}`;
  return row;
}

/** The first won stage of a pipeline: where accepting a quote moves its deal. */
export async function wonStageOf(tx: Tx, pipelineId: string): Promise<{ id: string; name: string } | undefined> {
  const [row] = await tx<{ id: string; name: string }[]>`
    SELECT id, name FROM stages WHERE pipeline_id = ${pipelineId} AND category = 'won' AND archived_at IS NULL ORDER BY position LIMIT 1`;
  return row;
}

// --- Quotes -----------------------------------------------------------------------------------------

export interface QuoteRow {
  id: string; name: string; number: string; deal_id: string | null; account_id: string | null; contact_id: string | null; quote_group_id: string;
  quote_version: number; status: string; status_category: string; currency: string; subtotal_minor: string; discount_minor: string; tax_minor: string;
  total_minor: string; valid_until: string | null; terms: string | null; owner_id: string | null; archived_at: Date | null; expired: boolean;
}

/** A quote, locked for the rest of the transaction when `lock` is set. `expired`: its valid_until date has passed. */
export async function quoteRow(tx: Tx, id: string, lock = false): Promise<QuoteRow | undefined> {
  const [row] = await tx<QuoteRow[]>`
    SELECT id, name, number, deal_id, account_id, contact_id, quote_group_id, quote_version, status, status_category, currency,
           subtotal_minor::text, discount_minor::text, tax_minor::text, total_minor::text, valid_until::text, terms, owner_id, archived_at,
           (valid_until IS NOT NULL AND valid_until < CURRENT_DATE) AS expired
    FROM quotes WHERE id = ${id} ${lock ? tx`FOR UPDATE` : tx``}`;
  return row;
}

export interface LineRow { id: string; position: number; product_id: string | null; description: string; quantity: string; unit_amount_minor: string;
  discount_minor: string; tax_minor: string; line_total_minor: string }

/** A quote's lines that aren't archived, in order. */
export async function quoteLines(tx: Tx, quoteId: string): Promise<LineRow[]> {
  return tx<LineRow[]>`
    SELECT id, position, product_id, description, quantity::text, unit_amount_minor::text, discount_minor::text, tax_minor::text, line_total_minor::text
    FROM quote_line_items WHERE quote_id = ${quoteId} AND archived_at IS NULL ORDER BY position, id`;
}

/** The position a new line takes: after the quote's last. */
export async function nextLinePosition(tx: Tx, quoteId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`SELECT coalesce(max(position), 0)::int + 1 AS n FROM quote_line_items WHERE quote_id = ${quoteId} AND archived_at IS NULL`;
  return row!.n;
}

export async function quoteLineCount(tx: Tx, quoteId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM quote_line_items WHERE quote_id = ${quoteId} AND archived_at IS NULL`;
  return row!.n;
}

/**
 * Sets a draft quote's amounts from its lines: subtotal is quantity times unit price, rounded per line;
 * total is subtotal less the lines' discounts plus their tax. Returns the new amounts, in minor units.
 */
export async function recomputeQuoteAmounts(tx: Tx, quoteId: string, actorId: string | null):
  Promise<{ subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string } | undefined> {
  const [row] = await tx<{ subtotal_minor: string; discount_minor: string; tax_minor: string; total_minor: string }[]>`
    UPDATE quotes q SET subtotal_minor = s.subtotal, discount_minor = s.discount, tax_minor = s.tax, total_minor = s.subtotal - s.discount + s.tax,
           version = q.version + 1, updated_by = ${actorId}
    FROM (SELECT coalesce(sum(round(quantity * unit_amount_minor)), 0)::bigint AS subtotal, coalesce(sum(discount_minor), 0)::bigint AS discount,
                 coalesce(sum(tax_minor), 0)::bigint AS tax
          FROM quote_line_items WHERE quote_id = ${quoteId} AND archived_at IS NULL) s
    WHERE q.id = ${quoteId}
    RETURNING q.subtotal_minor::text, q.discount_minor::text, q.tax_minor::text, q.total_minor::text`;
  return row;
}

/** Names for a quote's snapshot: who it was issued to, as written when it was sent. */
export async function customerNames(tx: Tx, accountId: string | null, contactId: string | null):
  Promise<{ account: string | null; contact: string | null; contact_email: string | null }> {
  const [row] = await tx<{ account: string | null; contact: string | null; contact_email: string | null }[]>`
    SELECT (SELECT name FROM accounts WHERE id = ${accountId}) AS account,
           (SELECT nullif(trim(concat_ws(' ', first_name, last_name)), '') FROM contacts WHERE id = ${contactId}) AS contact,
           (SELECT primary_email::text FROM contacts WHERE id = ${contactId}) AS contact_email`;
  return row!;
}

/** Moves a quote to a status (its key and category), with what that status records. */
export async function setQuoteStatus(tx: Tx, q: { id: string; status: string; category: string; sentAt?: boolean; acceptedAt?: boolean; snapshot?: unknown;
  actorId: string | null }): Promise<void> {
  await tx`UPDATE quotes SET status = ${q.status}, status_category = ${q.category},
             sent_at = CASE WHEN ${q.sentAt ?? false} THEN now() ELSE sent_at END,
             accepted_at = CASE WHEN ${q.acceptedAt ?? false} THEN now() ELSE accepted_at END,
             snapshot = coalesce(${q.snapshot === undefined ? null : tx.json(q.snapshot as never)}::jsonb, snapshot),
             version = version + 1, updated_by = ${q.actorId}
           WHERE id = ${q.id}`;
}

/** Other versions of a quote that were sent and are still open or closed without acceptance: a newer version replaces them. */
export async function replaceableVersions(tx: Tx, groupId: string, exceptId: string): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT id FROM quotes WHERE quote_group_id = ${groupId} AND id <> ${exceptId} AND status_category IN ('sent', 'rejected', 'expired') FOR UPDATE`;
}

/** A deal's other quotes that are still open (draft or sent): accepting one closes them. */
export async function openQuotesOfDeal(tx: Tx, dealId: string, exceptId: string): Promise<{ id: string }[]> {
  return tx<{ id: string }[]>`
    SELECT id FROM quotes WHERE deal_id = ${dealId} AND id <> ${exceptId} AND status_category IN ('draft', 'sent') AND archived_at IS NULL FOR UPDATE`;
}

/** The accepted quote of a deal, if it has one. */
export async function acceptedQuoteOfDeal(tx: Tx, dealId: string): Promise<{ id: string; number: string } | undefined> {
  const [row] = await tx<{ id: string; number: string }[]>`SELECT id, number FROM quotes WHERE deal_id = ${dealId} AND status_category = 'accepted' LIMIT 1`;
  return row;
}

/** The versions of a quote: the highest version number, and whether one is still a draft. */
export async function groupVersions(tx: Tx, groupId: string): Promise<{ latest: number; draft: string | null; base_number: string }> {
  const [row] = await tx<{ latest: number; draft: string | null; base_number: string }[]>`
    SELECT max(quote_version)::int AS latest,
           (SELECT number FROM quotes WHERE quote_group_id = ${groupId} AND status_category = 'draft' AND archived_at IS NULL LIMIT 1) AS draft,
           (SELECT number FROM quotes WHERE quote_group_id = ${groupId} ORDER BY quote_version LIMIT 1) AS base_number
    FROM quotes WHERE quote_group_id = ${groupId}`;
  return row!;
}

/** A new draft version of a quote, with the same deal, customer, terms and owner. Its lines are copied by insertQuoteLine. */
export async function insertQuoteRevision(tx: Tx, q: { tenantId: string; id: string; from: string; number: string; version: number; actorId: string | null }): Promise<void> {
  await tx`
    INSERT INTO quotes (tenant_id, id, name, number, deal_id, account_id, contact_id, quote_group_id, quote_version, status, status_category, currency,
                        terms, owner_id, search_text, created_by, updated_by)
    SELECT tenant_id, ${q.id}, name, ${q.number}, deal_id, account_id, contact_id, quote_group_id, ${q.version}, 'draft', 'draft', currency,
           terms, owner_id, search_text, ${q.actorId}, ${q.actorId}
    FROM quotes WHERE id = ${q.from}`;
}

export async function insertQuoteLine(tx: Tx, l: { tenantId: string; id: string; quoteId: string; line: LineRow; actorId: string | null }): Promise<void> {
  await tx`
    INSERT INTO quote_line_items (tenant_id, id, quote_id, position, product_id, description, quantity, unit_amount_minor, discount_minor, tax_minor,
                                  line_total_minor, search_text, created_by, updated_by)
    VALUES (${l.tenantId}, ${l.id}, ${l.quoteId}, ${l.line.position}, ${l.line.product_id}, ${l.line.description}, ${l.line.quantity}, ${l.line.unit_amount_minor},
            ${l.line.discount_minor}, ${l.line.tax_minor}, ${l.line.line_total_minor}, ${l.line.description.toLowerCase()}, ${l.actorId}, ${l.actorId})`;
}

// --- Orders -----------------------------------------------------------------------------------------

/** The order made from an accepted quote: its amounts, terms, customer and snapshot, as the quote had them. */
export async function insertOrderFromQuote(tx: Tx, o: { tenantId: string; id: string; quoteId: string; number: string; pendingKey: string; actorId: string | null }): Promise<void> {
  await tx`
    INSERT INTO orders (tenant_id, id, name, number, quote_id, deal_id, account_id, contact_id, order_type, status, status_category, currency,
                        subtotal_minor, discount_minor, tax_minor, total_minor, terms, snapshot, owner_id, search_text, created_by, updated_by)
    SELECT tenant_id, ${o.id}, name, ${o.number}, id, deal_id, account_id, contact_id, 'new', ${o.pendingKey}, 'pending', currency,
           subtotal_minor, discount_minor, tax_minor, total_minor, terms, snapshot, owner_id, lower(name || ' ' || ${o.number}), ${o.actorId}, ${o.actorId}
    FROM quotes WHERE id = ${o.quoteId}`;
}

export async function insertOrderLine(tx: Tx, l: { tenantId: string; id: string; orderId: string; line: LineRow; actorId: string | null }): Promise<void> {
  await tx`
    INSERT INTO order_line_items (tenant_id, id, order_id, position, product_id, description, quantity, unit_amount_minor, discount_minor, tax_minor,
                                  line_total_minor, quote_line_item_id, search_text, created_by, updated_by)
    VALUES (${l.tenantId}, ${l.id}, ${l.orderId}, ${l.line.position}, ${l.line.product_id}, ${l.line.description}, ${l.line.quantity}, ${l.line.unit_amount_minor},
            ${l.line.discount_minor}, ${l.line.tax_minor}, ${l.line.line_total_minor}, ${l.line.id}, ${l.line.description.toLowerCase()}, ${l.actorId}, ${l.actorId})`;
}
