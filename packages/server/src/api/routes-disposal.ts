import { z } from "zod";
import { cancelWorkspaceDeletion, requestWorkspaceDeletion } from "../core/disposal.js";
import { eraseRecord } from "../core/erasure.js";
import { route } from "./registry.js";
import { data, list, nullable, object, plain, S } from "./responses.js";

// --- Data disposal (ADR 0020): deleting the workspace, erasing a person's records --------------

const Deletion = object({ requested_at: S.time, requested_by: S.str, scheduled_for: S.time });

route({
  method: "POST", path: "/v1/workspace/deletion", scope: "admin", permission: "members:manage", tag: "admin",
  summary: "Owner only: ask for this workspace to be deleted, with everything in it. confirm_name must be the workspace's name. It is deleted after the "
    + "server's grace period (WORKSPACE_DELETION_GRACE_DAYS, 7 days unless changed); until then it works as before and an owner can withdraw the request. "
    + "Never through an MCP server or a connected app",
  response: data(Deletion, 202),
  body: z.object({ confirm_name: z.string().max(200).describe("The workspace's name, exactly as GET /v1/workspace shows it") }).strict(),
  handler: async ({ tx, ctx, body }) => ({ status: 202, body: { data: await requestWorkspaceDeletion(tx, ctx, body) } }),
});

route({
  method: "DELETE", path: "/v1/workspace/deletion", scope: "admin", permission: "members:manage", tag: "admin",
  summary: "Owner only: withdraw the request to delete this workspace, any time before it is due",
  response: data(object({ cancelled: S.bool })),
  handler: async ({ tx, ctx }) => ({ body: { data: await cancelWorkspaceDeletion(tx, ctx) } }),
});

const EraseBody = {
  dry_run: z.boolean().optional().describe("Defaults to true: report what would be erased, change nothing"),
  confirm_token: z.string().max(2_000).optional().describe("From the dry run of the same erasure; required to apply it. Single-use"),
  suppress_email: z.boolean().optional().describe("Defaults to true: add an erased contact's email address to the list automations never write to (kept as a keyed hash)"),
};
const ERASE_SUMMARY = "Erase a person's record for good: a contact, a lead, or a record of a custom object. The row stays, blank and archived, so references to it hold; "
  + "its values go, with records merged into it, a contact's leads and links, the text of every activity and task about them, their files, and what events, "
  + "webhook deliveries, automation runs, notifications and merges kept. dry_run defaults to true and returns a confirm_token; a real run needs it. Can't be undone";
const EraseResult = plain(object({
  dry_run: S.bool,
  result: object({
    id: S.str, object: S.str, erased: { ...list(S.str), description: "The records blanked: the record, records merged into it, and for a contact its leads" },
    counts: { type: "object", additionalProperties: { type: "integer" }, description: "Rows per kind: records, links, activities, tasks, files and the copies blanked" },
    possible_copies: { ...nullable(list(S.str)), description: "Other records whose searchable text holds the contact's email address or full name (up to 50). "
      + "Not changed: look at them. null when the search could not finish" },
    not_erased: { ...list(S.str), description: "What an erasure does not reach" },
    emails_suppressed: { type: "integer", description: "After a real run: addresses added to the suppression list" },
  }, ["id", "object", "erased", "counts", "possible_copies", "not_erased"]),
  confirm_token: { type: "string", description: "From a dry run: pass it back to apply exactly this erasure. Valid 15 minutes, single-use" },
}, ["dry_run", "result"]));

route({
  method: "POST", path: "/v1/objects/:object/records/:id/erase", scope: "admin", permission: "schema:manage", tag: "records",
  summary: ERASE_SUMMARY,
  idParams: { id: "record" },
  cost: () => 10,
  response: EraseResult,
  body: z.object(EraseBody).strict(),
  handler: async ({ tx, ctx, params, body }) => {
    const { after, ...out } = await eraseRecord(tx, ctx, params.object!, params.id!, body) as Awaited<ReturnType<typeof eraseRecord>> & { after?: () => Promise<void> };
    return { body: out, ...(after ? { after } : {}) };
  },
});

route({
  method: "POST", path: "/v1/ops/erase_contact", scope: "admin", permission: "schema:manage", tag: "operations",
  summary: `The same erasure, named as an operation for a contact. ${ERASE_SUMMARY}`,
  cost: () => 10,
  response: EraseResult,
  body: z.object({ contact: z.string().describe("The contact's ID (con_…)"), ...EraseBody }).strict(),
  handler: async ({ tx, ctx, body }) => {
    const { contact, ...input } = body;
    const { after, ...out } = await eraseRecord(tx, ctx, "contact", contact, input) as Awaited<ReturnType<typeof eraseRecord>> & { after?: () => Promise<void> };
    return { body: out, ...(after ? { after } : {}) };
  },
});
