import type { Tx } from "../db/pool.js";
import { claimRecords } from "./limits.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { encodeId, uuidv7 } from "../lib/ids.js";
import { assertObject, assertWritable, canObject, fieldAccess } from "./access.js";
import { audit } from "./audit.js";
import { can, type Ctx } from "./context.js";
import { COMMERCE_DEFAULTS, documentNumber, getCommerceSettings, type CommerceSettings } from "./commerce-hooks.js";
import { emit } from "./events.js";
import { moveDealStage, type OpResult } from "./ops.js";
import {
  acceptedQuoteOfDeal, customerNames, dealForQuote, groupVersions, insertOrderFromQuote, insertOrderLine, insertQuoteLine, insertQuoteRevision,
  mergeLifecycleOptions, nextDocumentNumber, openQuotesOfDeal, quoteLineCount, quoteLines, quoteRow, recomputeQuoteAmounts, replaceableVersions,
  setQuoteStatus, wonStageOf, type QuoteRow,
} from "./queries/commerce.js";
import { createRecord, getRecord, requireRecord, type RecordOut } from "./records.js";
import { getObject, loadSchema, type ObjectMeta, type Schema } from "./schema.js";

/**
 * Quotes and orders: the named operations (docs/data-model.md §7, ADR 0014). A quote is a draft while
 * its lines are worked on, then it is sent (it can't change any more), then accepted, which makes the
 * order. Every operation runs in the caller's transaction, checks what it writes before it looks
 * anything up, and takes `dry_run`.
 */

export { getCommerceSettings, type CommerceSettings };

/** Changes how quotes behave in this workspace. Needs schema:manage, like the other lifecycle settings. */
export async function updateCommerceSettings(tx: Tx, ctx: Ctx, patch: Partial<Record<keyof CommerceSettings, unknown>>): Promise<CommerceSettings> {
  if (!can(ctx, "schema:manage")) throw forbidden("Changing the commerce settings needs the schema:manage permission");
  const keys = Object.keys(COMMERCE_DEFAULTS) as (keyof CommerceSettings)[];
  const unknown = Object.keys(patch).filter((k) => !(keys as string[]).includes(k));
  if (unknown.length) throw unprocessable(`Unknown setting: ${unknown.join(", ")}. Settings: ${keys.join(", ")}`);
  const changes: Record<string, boolean> = {};
  for (const k of keys) {
    if (patch[k] === undefined) continue;
    if (typeof patch[k] !== "boolean") throw unprocessable(`${k} must be true or false`);
    changes[k] = patch[k];
  }
  if (Object.keys(changes).length === 0) throw unprocessable(`Send at least one of: ${keys.join(", ")}`);
  await mergeLifecycleOptions(tx, changes);
  await audit(tx, ctx, { action: "workspace.commerce_settings_changed", details: changes });
  return getCommerceSettings(tx);
}

/** The key of the status value in a category (a workspace may relabel values, never their categories). */
const statusKey = (obj: ObjectMeta, category: string): string =>
  (obj.byName.get("status")?.options.values ?? []).find((v) => v.category === category)?.key ?? category;

interface Loaded { schema: Schema; quoteObj: ObjectMeta; id: string; quote: QuoteRow }

/** A quote for an operation that changes its status: write on quote.status checked first, then the quote found and locked. */
async function quoteForStatusChange(tx: Tx, ctx: Ctx, publicId: string): Promise<Loaded> {
  const schema = await loadSchema(tx);
  const quoteObj = getObject(schema, "quote");
  assertWritable(ctx, quoteObj, ["status"]);
  const id = await requireRecord(tx, schema, "quote", publicId, "quote");
  const quote = await quoteRow(tx, id, true);
  if (!quote) throw notFound(`Quote ${publicId}`);
  if (quote.archived_at) throw conflict(`Quote ${quote.number} is archived`);
  return { schema, quoteObj, id, quote };
}

export interface QuoteLineInput { description: string; quantity?: number; unit_price: number; discount?: number; tax?: number }
export interface CreateQuoteInput {
  deal?: string; account?: string; contact?: string; name?: string; valid_until?: string; terms?: string; lines?: QuoteLineInput[];
}

/** A quote and its lines in one step. The quote and each line go through the normal record creation, so every rule of those applies. */
export async function createQuote(tx: Tx, ctx: Ctx, input: CreateQuoteInput, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  assertObject(ctx, getObject(schema, "quote"), "write");
  const lines = input.lines ?? [];
  if (!Array.isArray(lines) || lines.length > 100) throw unprocessable("lines must be a list of at most 100 lines");
  if (lines.length) assertObject(ctx, getObject(schema, "quote_line_item"), "write");
  const values = Object.fromEntries((["deal", "account", "contact", "name", "valid_until", "terms"] as const).filter((k) => input[k] !== undefined).map((k) => [k, input[k]]));
  if (dryRun) {
    return { dry_run: true, result: null, would: [`create a draft quote${input.deal ? ` for ${input.deal}` : ""}`, ...(lines.length ? [`add ${lines.length} line(s)`] : [])] };
  }
  const quote = await createRecord(tx, ctx, "quote", values);
  const made: RecordOut[] = [];
  for (const [i, line] of lines.entries()) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) throw unprocessable(`lines[${i}] must be an object`);
    made.push(await createRecord(tx, ctx, "quote_line_item", { ...line, quote: quote.id }));
  }
  return { dry_run: false, result: { quote: await getRecord(tx, ctx, "quote", quote.id), lines: made } };
}

/**
 * Sends a draft quote: from here on it says what it says. Keeps who it was issued to (a snapshot of the
 * customer's names), and replaces earlier versions of the same quote that were sent and not accepted.
 */
export async function sendQuote(tx: Tx, ctx: Ctx, input: { quote: string }, dryRun: boolean): Promise<OpResult> {
  const { quoteObj, id, quote } = await quoteForStatusChange(tx, ctx, input.quote);
  if (quote.status_category !== "draft") throw conflict(`Quote ${quote.number} was already sent (status: ${quote.status})`);
  if ((await quoteLineCount(tx, id)) === 0) throw unprocessable(`Quote ${quote.number} has no lines; add at least one before sending it`);
  const earlier = await replaceableVersions(tx, quote.quote_group_id, id);
  if (dryRun) {
    return { dry_run: true, result: null, would: [`send quote ${quote.number} (it can't be changed afterwards)`,
      ...(earlier.length ? [`mark ${earlier.length} earlier version(s) superseded`] : [])] };
  }
  // The amounts are set from the lines once more under the lock, so what is sent is what the lines add up to.
  await recomputeQuoteAmounts(tx, id, ctx.actor.id);
  const names = await customerNames(tx, quote.account_id, quote.contact_id);
  const snapshot = {
    account: quote.account_id ? { id: encodeId("acct", quote.account_id), name: names.account } : null,
    contact: quote.contact_id ? { id: encodeId("con", quote.contact_id), name: names.contact, email: names.contact_email } : null,
  };
  await setQuoteStatus(tx, { id, status: statusKey(quoteObj, "sent"), category: "sent", sentAt: true, snapshot, actorId: ctx.actor.id });
  for (const v of earlier) await supersede(tx, ctx, quoteObj, v.id, id);
  await audit(tx, ctx, { action: "quote.sent", objectType: "quote", recordId: id, details: { number: quote.number, superseded: earlier.length } });
  await emit(tx, ctx, { type: "quote.sent", objectType: "quote", recordId: id, data: { number: quote.number } });
  return { dry_run: false, result: await getRecord(tx, ctx, "quote", input.quote) };
}

async function supersede(tx: Tx, ctx: Ctx, quoteObj: ObjectMeta, id: string, by: string): Promise<void> {
  await setQuoteStatus(tx, { id, status: statusKey(quoteObj, "superseded"), category: "superseded", actorId: ctx.actor.id });
  await audit(tx, ctx, { action: "quote.superseded", objectType: "quote", recordId: id, details: { by: encodeId("quote", by) } });
  await emit(tx, ctx, { type: "quote.updated", objectType: "quote", recordId: id, data: { after: { status: statusKey(quoteObj, "superseded") } } });
}

/**
 * Accepts a sent quote and makes its order: the quote's amounts, terms, customer and lines, copied. The
 * deal's other open quotes are superseded, and the deal moves to its pipeline's first won stage when the
 * workspace says so and the caller may move it.
 */
export async function acceptQuote(tx: Tx, ctx: Ctx, input: { quote: string }, dryRun: boolean): Promise<OpResult> {
  const { schema, quoteObj, id, quote } = await quoteForStatusChange(tx, ctx, input.quote);
  const orderObj = getObject(schema, "order");
  // The order is the caller's write too: someone who can't write orders can't make one by accepting.
  assertObject(ctx, orderObj, "write");
  if (quote.status_category === "accepted") throw conflict(`Quote ${quote.number} was already accepted`);
  if (quote.status_category !== "sent") throw conflict(`Only a sent quote can be accepted; quote ${quote.number} is ${quote.status}${quote.status_category === "draft" ? " (send it first)" : ""}`);
  if (quote.expired) throw conflict(`Quote ${quote.number} was valid until ${quote.valid_until}; revise it to offer it again`);
  const settings = await getCommerceSettings(tx);
  const deal = quote.deal_id ? await dealForQuote(tx, quote.deal_id) : undefined;
  if (deal) {
    const other = await acceptedQuoteOfDeal(tx, deal.id);
    if (other) throw conflict(`This deal already has an accepted quote (${other.number})`);
  }
  const others = deal ? await openQuotesOfDeal(tx, deal.id, id) : [];
  const dealObj = getObject(schema, "deal");
  const stageField = dealObj.byName.get("stage");
  const won = deal && settings.accept_quote_marks_deal_won && deal.status_category === "open" ? await wonStageOf(tx, deal.pipeline_id) : undefined;
  const mayMoveDeal = Boolean(won && canObject(ctx, dealObj, "write") && stageField && fieldAccess(ctx, dealObj, stageField) === "write");
  if (dryRun) {
    return { dry_run: true, result: null, would: [`accept quote ${quote.number}`, "make an order from it",
      ...(others.length ? [`mark ${others.length} other open quote(s) of the deal superseded`] : []),
      ...(won ? [mayMoveDeal ? `move the deal to "${won.name}"` : `leave the deal's stage as it is (this key can't change deal.stage)`] : [])] };
  }
  await setQuoteStatus(tx, { id, status: statusKey(quoteObj, "accepted"), category: "accepted", acceptedAt: true, actorId: ctx.actor.id });
  for (const o of others) await supersede(tx, ctx, quoteObj, o.id, id);

  const orderId = uuidv7();
  const lines = await quoteLines(tx, id);
  // The order and each of its lines is a record (ADR 0019).
  await claimRecords(tx, ctx.tenantId, 1 + lines.length);
  const number = documentNumber("O", await nextDocumentNumber(tx, ctx.tenantId, "order"));
  await insertOrderFromQuote(tx, { tenantId: ctx.tenantId, id: orderId, quoteId: id, number, pendingKey: statusKey(orderObj, "pending"), actorId: ctx.actor.id });
  for (const line of lines) await insertOrderLine(tx, { tenantId: ctx.tenantId, id: uuidv7(), orderId, line, actorId: ctx.actor.id });
  const orderPublicId = encodeId("ord", orderId);

  await audit(tx, ctx, { action: "quote.accepted", objectType: "quote", recordId: id, details: { number: quote.number, order: orderPublicId, superseded: others.length } });
  await emit(tx, ctx, { type: "quote.accepted", objectType: "quote", recordId: id, data: { number: quote.number, order: orderPublicId } });
  await audit(tx, ctx, { action: "order.created", objectType: "order", recordId: orderId, details: { number, quote: encodeId("quote", id), lines: lines.length } });
  await emit(tx, ctx, { type: "order.created", objectType: "order", recordId: orderId, data: { after: { number, quote: encodeId("quote", id) } } });

  let dealNote: string | undefined;
  if (won && mayMoveDeal) await moveDealStage(tx, ctx, { deal: encodeId("deal", deal!.id), stage: encodeId("stg", won.id) }, false);
  else if (won) dealNote = "The deal's stage was left as it is: this key can't change deal.stage";
  return { dry_run: false, result: {
    quote: await getRecord(tx, ctx, "quote", input.quote),
    order: await getRecord(tx, ctx, "order", orderPublicId),
    ...(deal && canObject(ctx, dealObj, "read") ? { deal: await getRecord(tx, ctx, "deal", encodeId("deal", deal.id)) } : {}),
    ...(dealNote ? { note: dealNote } : {}),
  } };
}

/**
 * Makes the next version of a quote that was sent: a new draft with the same deal, customer, terms and
 * lines, numbered after the first (Q-0007 becomes Q-0007-2). The version it was made from stays as it is
 * until the new one is sent, which supersedes it.
 */
export async function reviseQuote(tx: Tx, ctx: Ctx, input: { quote: string }, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  const quoteObj = getObject(schema, "quote");
  assertObject(ctx, quoteObj, "write");
  assertObject(ctx, getObject(schema, "quote_line_item"), "write");
  const id = await requireRecord(tx, schema, "quote", input.quote, "quote");
  const quote = await quoteRow(tx, id, true);
  if (!quote) throw notFound(`Quote ${input.quote}`);
  if (quote.status_category === "draft") throw conflict(`Quote ${quote.number} is still a draft: change it directly`);
  if (quote.status_category === "accepted") throw conflict(`Quote ${quote.number} was accepted and has an order; it can't be revised`);
  const group = await groupVersions(tx, quote.quote_group_id);
  if (group.draft) throw conflict(`This quote already has a draft version (${group.draft}); change that one`);
  const version = group.latest + 1;
  const number = `${group.base_number}-${version}`;
  if (dryRun) return { dry_run: true, result: null, would: [`make draft ${number}, version ${version} of quote ${group.base_number}, with the same lines`] };
  const newId = uuidv7();
  const copied = await quoteLines(tx, id);
  await claimRecords(tx, ctx.tenantId, 1 + copied.length);
  await insertQuoteRevision(tx, { tenantId: ctx.tenantId, id: newId, from: id, number, version, actorId: ctx.actor.id });
  for (const line of copied) await insertQuoteLine(tx, { tenantId: ctx.tenantId, id: uuidv7(), quoteId: newId, line, actorId: ctx.actor.id });
  await recomputeQuoteAmounts(tx, newId, ctx.actor.id);
  const publicId = encodeId("quote", newId);
  await audit(tx, ctx, { action: "quote.revised", objectType: "quote", recordId: newId, details: { number, from: encodeId("quote", id), version } });
  await emit(tx, ctx, { type: "quote.created", objectType: "quote", recordId: newId, data: { after: { number, revision: version } } });
  return { dry_run: false, result: await getRecord(tx, ctx, "quote", publicId) };
}
