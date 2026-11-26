import { z } from "zod";
import { acceptQuote, createQuote, getCommerceSettings, reviseQuote, sendQuote, updateCommerceSettings } from "../core/commerce.js";
import { route } from "./registry.js";
import { data, object, R } from "./responses.js";

// --- Quotes and orders (core/commerce.ts; docs/data-model.md §5.4 and §7) ----------------------
// Quotes, quote lines and orders are records like any other (/v1/objects/quote/records, …). These are
// the operations that move a quote through its life, and the workspace's settings for them.

const DryRun = z.object({ dry_run: z.boolean().optional() });
const Line = z.object({
  description: z.string().min(1).max(2000), quantity: z.number().positive().optional(), unit_price: z.number().min(0),
  discount: z.number().min(0).optional(), tax: z.number().min(0).optional(),
}).strict();

route({
  method: "POST", path: "/v1/ops/create_quote", scope: "ops:write", tag: "operations",
  summary: "Create a draft quote and its lines in one step. Made for a deal (its account, primary contact and name are taken over) unless the workspace allows quotes without one",
  response: R.op,
  body: DryRun.extend({ deal: z.string().optional(), account: z.string().optional(), contact: z.string().optional(), name: z.string().max(500).optional(),
    valid_until: z.string().optional(), terms: z.string().max(20_000).optional(), lines: z.array(Line).max(100).optional() }),
  cost: (b) => 1 + Math.ceil((b.lines?.length ?? 0) / 10),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await createQuote(tx, ctx, input, dry_run ?? false) };
  },
});

route({
  method: "POST", path: "/v1/ops/send_quote", scope: "ops:write", tag: "operations",
  summary: "Send a draft quote: it can't be changed afterwards (revise_quote makes the next version). Supersedes earlier sent versions of the same quote",
  response: R.op,
  body: DryRun.extend({ quote: z.string() }),
  handler: async ({ tx, ctx, body }) => ({ body: await sendQuote(tx, ctx, { quote: body.quote }, body.dry_run ?? false) }),
});

route({
  method: "POST", path: "/v1/ops/accept_quote", scope: "ops:write", tag: "operations",
  summary: "Accept a sent quote and make its order, with a copy of its lines. Supersedes the deal's other open quotes and, when the workspace says so, marks the deal won",
  response: R.op,
  body: DryRun.extend({ quote: z.string() }),
  handler: async ({ tx, ctx, body }) => ({ body: await acceptQuote(tx, ctx, { quote: body.quote }, body.dry_run ?? false) }),
});

route({
  method: "POST", path: "/v1/ops/revise_quote", scope: "ops:write", tag: "operations",
  summary: "Make the next version of a sent quote: a new draft with the same deal, customer, terms and lines. The version it came from is superseded when the new one is sent",
  response: R.op,
  body: DryRun.extend({ quote: z.string() }),
  handler: async ({ tx, ctx, body }) => ({ body: await reviseQuote(tx, ctx, { quote: body.quote }, body.dry_run ?? false) }),
});

const Settings = object({
  quote_requires_deal: { type: "boolean", description: "A quote must be made for a deal (default true). false: a quote can stand alone, for an account or a contact" },
  accept_quote_marks_deal_won: { type: "boolean", description: "Accepting a quote moves its deal to the pipeline's first won stage (default true)" },
});

route({
  method: "GET", path: "/v1/commerce-settings", scope: "ops:read", tag: "operations", summary: "How quotes behave in this workspace",
  response: data(Settings),
  handler: async ({ tx }) => ({ body: { data: await getCommerceSettings(tx) } }),
});

route({
  method: "PATCH", path: "/v1/commerce-settings", scope: "admin", permission: "schema:manage", tag: "schema",
  summary: "Change how quotes behave: whether a quote needs a deal, and whether accepting one marks its deal won",
  response: data(Settings),
  body: z.object({ quote_requires_deal: z.boolean().optional(), accept_quote_marks_deal_won: z.boolean().optional() }).strict(),
  handler: async ({ tx, ctx, body }) => ({ body: { data: await updateCommerceSettings(tx, ctx, body) } }),
});
