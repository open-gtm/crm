import type { Tx } from "../db/pool.js";
import { conflict, forbidden, unprocessable } from "../lib/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { assertObject, canReadField } from "./access.js";
import type { Ctx } from "./context.js";
import { emit } from "./events.js";
import { dealForQuote, lifecycleOptions, nextDocumentNumber, nextLinePosition, quoteRow, recomputeQuoteAmounts } from "./queries/commerce.js";
import { getObject, type ObjectMeta, type Schema } from "./schema.js";

/**
 * Quotes and orders, as the record engine sees them (docs/data-model.md §5.4, ADR 0014): what creating
 * and changing a quote, a quote line and an order does and refuses. The named operations (send, accept,
 * revise) are in core/commerce.ts. Kept apart from it so the record engine doesn't import its own callers.
 */

/** How a workspace has set quotes up. Kept in the workspace's lifecycle options; these are the defaults. */
export interface CommerceSettings {
  /** A quote must be made for a deal. Off: a quote can stand alone, for an account or a contact. */
  quote_requires_deal: boolean;
  /** Accepting a quote moves its deal to the pipeline's first won stage. */
  accept_quote_marks_deal_won: boolean;
}
export const COMMERCE_DEFAULTS: CommerceSettings = { quote_requires_deal: true, accept_quote_marks_deal_won: true };

export async function getCommerceSettings(tx: Tx): Promise<CommerceSettings> {
  const stored = await lifecycleOptions(tx);
  const flag = (k: keyof CommerceSettings) => (typeof stored[k] === "boolean" ? (stored[k] as boolean) : COMMERCE_DEFAULTS[k]);
  return { quote_requires_deal: flag("quote_requires_deal"), accept_quote_marks_deal_won: flag("accept_quote_marks_deal_won") };
}

/** Q-0001, O-0001: at least four digits, more when the count needs them. */
export const documentNumber = (prefix: "Q" | "O", n: number) => `${prefix}-${String(n).padStart(4, "0")}`;

/** The part of a draft the hooks need: the record engine's Draft (core/standard.ts), without importing it. */
interface DraftLike {
  id: string;
  obj: ObjectMeta;
  schema: Schema;
  prepared: { columns: Map<string, unknown>; values: Record<string, unknown> };
  extra: Map<string, unknown>;
  current?: Record<string, unknown> & { id: string };
}

/** What can still change on a quote after it was sent: its status (through the status rules), its owner and custom fields. */
const QUOTE_FROZEN = ["name", "account", "contact", "valid_until", "terms"];

/**
 * A new quote. Made for a deal unless the workspace allows otherwise: the deal's account and primary
 * contact become the quote's, and its name the quote's name, each only when the caller can read it on
 * the deal (a copy follows its source, ADR 0008). It gets the next quote number and starts its own group of versions.
 */
export async function quoteBeforeCreate(tx: Tx, ctx: Ctx, d: DraftLike): Promise<void> {
  const cols = d.prepared.columns;
  const settings = await getCommerceSettings(tx);
  const dealId = cols.get("deal_id") as string | undefined;
  if (!dealId && settings.quote_requires_deal) {
    throw unprocessable("A quote is made for a deal: pass deal. (Someone who manages the schema can allow quotes without a deal: commerce settings, quote_requires_deal.)");
  }
  let dealName: string | null = null;
  if (dealId) {
    const deal = await dealForQuote(tx, dealId);
    if (!deal) throw unprocessable("deal: that deal was not found");
    if (deal.archived_at) throw conflict("That deal is archived; restore it to quote for it");
    const dealObj = getObject(d.schema, "deal");
    if (!cols.get("account_id") && deal.account_id && canReadField(ctx, dealObj, "account")) cols.set("account_id", deal.account_id);
    if (!cols.get("contact_id") && canReadField(ctx, dealObj, "primary_contact")) cols.set("contact_id", deal.primary_contact_id);
    if (canReadField(ctx, dealObj, "name")) dealName = deal.name;
  }
  if (!cols.get("account_id") && !cols.get("contact_id")) throw unprocessable("A quote needs an account or a contact: pass account or contact");
  if (!cols.get("name")) cols.set("name", dealName ?? "Quote");
  d.extra.set("number", documentNumber("Q", await nextDocumentNumber(tx, ctx.tenantId, "quote")));
  d.extra.set("quote_group_id", uuidv7());
  d.extra.set("currency", d.schema.currency);
}

/** A sent quote says what it said: only its status, owner and custom fields change. A draft changes freely. */
export function quoteBeforeUpdate(d: DraftLike): void {
  if (d.current!.status_category === "draft") return;
  const frozen = QUOTE_FROZEN.filter((f) => Object.hasOwn(d.prepared.values, f));
  if (frozen.length) {
    throw conflict(`This quote has been sent, so ${frozen.join(", ")} can't be changed. Use revise_quote to make a new version`);
  }
}

/** Refuses any change to the lines of a quote that isn't a draft, and to a quote the caller can't write. */
async function draftQuoteFor(tx: Tx, ctx: Ctx, schema: Schema, quoteId: string) {
  assertObject(ctx, getObject(schema, "quote"), "write");
  const quote = await quoteRow(tx, quoteId, true);
  if (!quote) throw unprocessable("quote: that quote was not found");
  if (quote.archived_at) throw conflict("That quote is archived");
  if (quote.status_category !== "draft") throw conflict(`Quote ${quote.number} has been sent, so its lines can't be changed. Use revise_quote to make a new version`);
  return quote;
}

/** Quantity times unit price (rounded to the minor unit), less the line's discount, plus its tax. Amounts are in minor units. */
function lineAmounts(quantity: unknown, unit: unknown, discount: unknown, tax: unknown) {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0 || q > 1e9) throw unprocessable("quantity must be more than 0");
  if (Math.abs(q * 10_000 - Math.round(q * 10_000)) > 1e-6) throw unprocessable("quantity takes at most 4 decimal places");
  const [u, off, taxed] = [Number(unit), Number(discount ?? 0), Number(tax ?? 0)];
  if (!Number.isFinite(u) || u < 0) throw unprocessable("unit_price can't be negative");
  if (!Number.isFinite(off) || off < 0) throw unprocessable("discount can't be negative");
  if (!Number.isFinite(taxed) || taxed < 0) throw unprocessable("tax can't be negative");
  const gross = Math.round(q * u);
  if (off > gross) throw unprocessable("discount can't be more than quantity times unit_price");
  if (gross > Number.MAX_SAFE_INTEGER / 4) throw unprocessable("The line's amount is too large");
  return { total: gross - off + taxed };
}

export async function quoteLineBeforeCreate(tx: Tx, ctx: Ctx, d: DraftLike): Promise<void> {
  const cols = d.prepared.columns;
  const quote = await draftQuoteFor(tx, ctx, d.schema, cols.get("quote_id") as string);
  if (!cols.has("quantity")) cols.set("quantity", 1);
  if (!cols.has("discount_minor")) cols.set("discount_minor", 0);
  if (!cols.has("tax_minor")) cols.set("tax_minor", 0);
  d.extra.set("line_total_minor", lineAmounts(cols.get("quantity"), cols.get("unit_amount_minor"), cols.get("discount_minor"), cols.get("tax_minor")).total);
  if (!cols.has("position")) cols.set("position", await nextLinePosition(tx, quote.id));
}

export async function quoteLineBeforeUpdate(tx: Tx, ctx: Ctx, d: DraftLike): Promise<void> {
  const cols = d.prepared.columns;
  await draftQuoteFor(tx, ctx, d.schema, d.current!.quote_id as string);
  const now = (col: string) => (cols.has(col) ? cols.get(col) : d.current![col]);
  // Cleared amounts mean none.
  for (const col of ["discount_minor", "tax_minor"]) if (cols.has(col) && cols.get(col) === null) cols.set(col, 0);
  if (cols.has("quantity") && cols.get("quantity") === null) throw unprocessable("quantity can't be empty");
  d.extra.set("line_total_minor", lineAmounts(now("quantity"), now("unit_amount_minor"), now("discount_minor"), now("tax_minor")).total);
}

/** After a line was added, changed, archived or restored: the quote's amounts follow, and it gets its `updated` event. */
export async function quoteLineChanged(tx: Tx, ctx: Ctx, quoteId: string): Promise<void> {
  const amounts = await recomputeQuoteAmounts(tx, quoteId, ctx.actor.id);
  if (!amounts) return;
  const major = (minor: string) => Number(minor) / 100;
  await emit(tx, ctx, { type: "quote.updated", objectType: "quote", recordId: quoteId, data: { after: {
    subtotal: major(amounts.subtotal_minor), discount: major(amounts.discount_minor), tax: major(amounts.tax_minor), total: major(amounts.total_minor) } } });
}

/** Archiving or restoring a line needs its quote to be a draft, as changing one does. */
export async function quoteLineBeforeArchive(tx: Tx, ctx: Ctx, schema: Schema, line: Record<string, unknown>): Promise<void> {
  await draftQuoteFor(tx, ctx, schema, line.quote_id as string);
}

/** Orders and their lines are made by accepting a quote, never written directly. */
export function refuseOrderWrite(objectName: string): never {
  throw forbidden(objectName === "order" ? "Orders are made by accepting a quote: use accept_quote" : "An order's lines are copied from its quote and can't be changed");
}
