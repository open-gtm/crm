import type { Tx } from "../db/pool.js";
import { canonicalJson, sha256 } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { storeNamed } from "../providers/files.js";
import { audit } from "./audit.js";
import { mailboxHash, validAddress } from "./automation-runner.js";
import { issueConfirm, readConfirm, spendConfirm } from "./confirm.js";
import { can, type Ctx } from "./context.js";
import { emit } from "./events.js";
import { insertSuppression } from "./queries/automations.js";
import {
  activitiesAbout, contactIdentities, contactLinkRows, copyCounts, deleteLinksFrom, eraseAccountContacts, eraseActivities, eraseContacts, eraseCopies,
  eraseCustomRecords, eraseDealContacts, eraseFilesOf, eraseLeads, eraseMergeValues, eraseTasks, leadsOfContacts, mergedIntoAny, recordsMentioning, tasksAbout,
} from "./queries/erasure.js";
import { fetchRows, mergeChains } from "./records.js";
import { getObject, loadSchema, type ObjectMeta, type Schema } from "./schema.js";

/**
 * Erasing a person's records for good (ADR 0020): a contact, a lead, or a record of a custom object.
 * Archiving hides a record and keeps every value; this removes the values, wherever the server kept a
 * copy, and can't be undone.
 *
 * The record's row stays, blank, archived and marked erased, so a deal or an order that refers to it
 * still does. What goes with it:
 *   - records merged into it (their archived duplicates still held the person's values);
 *   - for a contact: every lead of that contact, and the contact's links to accounts and deals;
 *   - every activity and task about any of those records (subject, body and payload; that it happened stays);
 *   - their files (bytes, names and hashes), the values of their custom relation fields, and what the
 *     event feed, webhook deliveries, automation runs, notifications and merges kept about them.
 * A contact's email address joins the suppression list (as a keyed hash), so automations never write to
 * it again.
 *
 * What it can't reach is said in docs/data-model.md: values copied by hand into other records
 * (`possible_copies` lists likely ones), sent quotes and orders (kept as issued), the audit log (which
 * holds field names, never values), backups, and whatever a webhook already delivered elsewhere.
 *
 * It needs schema:manage, the permission whose holders already have unrestricted record access: an
 * erasure removes values whatever the caller's role could read. A dry run comes first and returns the
 * confirm_token a real run needs, bound to exactly the records the dry run listed.
 */

/** Most records one erasure may blank, activities and tasks included: bounds one transaction's work. */
export const ERASE_MAX_RECORDS = 5_000;
const POSSIBLE_COPIES_LIMIT = 50;
const REDO = "run the erasure with dry_run: true again and pass back its confirm_token";

export interface EraseInput { dry_run?: boolean; confirm_token?: string; suppress_email?: boolean }
interface EraseToken { h: string }

interface Plan {
  obj: ObjectMeta;
  id: string;
  /** Per table: the rows to blank. `main` are the record itself and records merged into it. */
  contacts: string[]; leads: string[]; custom: string[]; accountContacts: string[]; dealContacts: string[]; activities: string[]; tasks: string[];
  main: string[];
  all: string[];
}

const ERASABLE_STANDARD = new Set(["contact", "lead"]);

/** The record and everything merged into it, through earlier merges too. */
async function withMerged(tx: Tx, ids: string[]): Promise<string[]> {
  const seen = new Set(ids);
  let frontier = ids;
  for (let hop = 0; hop < 10 && frontier.length; hop++) {
    frontier = (await mergedIntoAny(tx, frontier)).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return [...seen].sort();
}

async function plan(tx: Tx, schema: Schema, objectName: string, publicId: string): Promise<Plan> {
  const obj = getObject(schema, objectName);
  if (obj.is_system && !ERASABLE_STANDARD.has(obj.api_name)) {
    throw unprocessable(`Erasure covers people: contacts, leads and records of custom objects. A ${obj.api_name} can be archived, not erased`
      + (obj.api_name === "account" ? "; erase the contacts at the account instead" : ""));
  }
  const d = decodeId(publicId);
  if (!d || d.prefix !== obj.id_prefix) throw notFound(`${obj.label} ${publicId}`);
  const [row] = await fetchRows(tx, obj, [d.uuid], true);
  if (!row) throw notFound(`${obj.label} ${publicId}`);
  if (row.anonymized_at) throw conflict(`${obj.label} ${publicId} was already erased`);
  const chain = (await mergeChains(tx, [d.uuid])).get(d.uuid);
  if (chain) {
    const into = encodeId(obj.id_prefix, chain[chain.length - 1]!);
    throw conflict(`${obj.label} ${publicId} was merged into ${into}; erase that record, which erases this one with it`, { merged_into: into });
  }
  const main = await withMerged(tx, [d.uuid]);
  const p: Plan = { obj, id: d.uuid, main, contacts: [], leads: [], custom: [], accountContacts: [], dealContacts: [], activities: [], tasks: [], all: [] };
  if (obj.api_name === "contact") {
    p.contacts = main;
    p.leads = await withMerged(tx, await leadsOfContacts(tx, main));
    p.accountContacts = await contactLinkRows(tx, "account_contacts", main);
    p.dealContacts = await contactLinkRows(tx, "deal_contacts", main);
  } else if (obj.api_name === "lead") {
    p.leads = main;
  } else {
    p.custom = main;
  }
  // Lock the rest of the main rows too (the record itself is locked above), in ID order.
  if (main.length > 1) await fetchRows(tx, obj, main, true);
  const about = [...p.contacts, ...p.leads, ...p.custom];
  p.activities = await activitiesAbout(tx, about, p.contacts);
  p.tasks = await tasksAbout(tx, about);
  p.all = [...about, ...p.accountContacts, ...p.dealContacts, ...p.activities, ...p.tasks];
  if (p.all.length > ERASE_MAX_RECORDS) {
    throw unprocessable(`This erasure would blank ${p.all.length} records, activities and tasks; one erasure takes at most ${ERASE_MAX_RECORDS}. Ask whoever runs the server`);
  }
  return p;
}

/**
 * Other records that seem to mention the person, or null when the search could not finish in time (a
 * very large workspace): the erasure itself never depends on it.
 */
async function possibleCopies(tx: Tx, needles: string[], except: string[], prefixOf: (objectId: string) => string): Promise<string[] | null> {
  try {
    const rows = await tx.savepoint((sp) => recordsMentioning(sp, needles, except, POSSIBLE_COPIES_LIMIT));
    return rows.map((r) => encodeId(prefixOf(r.object_id), r.id));
  } catch {
    return null;
  }
}

const fingerprint = (p: Plan) => sha256(canonicalJson({ object: p.obj.api_name, id: p.id, all: [...p.all].sort() })).toString("hex");

export async function eraseRecord(tx: Tx, ctx: Ctx, objectName: string, publicId: string, input: EraseInput = {}) {
  if (!can(ctx, "schema:manage")) throw forbidden("Erasing records needs the schema:manage permission");
  if (ctx.surface === "automation") throw forbidden("Automations can't erase records");
  const dryRun = input.dry_run ?? true;
  if (dryRun && input.confirm_token !== undefined) throw unprocessable("A dry run issues a confirm_token; it doesn't take one");
  const schema = await loadSchema(tx);
  const p = await plan(tx, schema, objectName, publicId);
  const print = fingerprint(p);

  const prefixOf = (objectId: string) => schema.byId.get(objectId)?.id_prefix ?? "rec";
  const erased = [
    ...p.contacts.map((id) => encodeId("con", id)), ...p.leads.map((id) => encodeId("lead", id)), ...p.custom.map((id) => encodeId(p.obj.id_prefix, id)),
  ];
  const identities = p.contacts.length ? await contactIdentities(tx, p.contacts) : [];
  const needles = [...new Set(identities.flatMap((c) => [c.email, c.first_name && c.last_name ? `${c.first_name} ${c.last_name}` : null])
    .filter((s): s is string => typeof s === "string" && s.trim().length >= 5))];
  const copies = await copyCounts(tx, p.main.concat(p.leads), p.all);
  const summary = {
    id: encodeId(p.obj.id_prefix, p.id), object: p.obj.api_name,
    erased,
    counts: { contacts: p.contacts.length, leads: p.leads.length, custom_records: p.custom.length, account_links: p.accountContacts.length,
      deal_links: p.dealContacts.length, activities: p.activities.length, tasks: p.tasks.length, ...copies },
    /** Other records whose searchable text holds the contact's email address or full name: look at them, an erasure doesn't change them. null: not searched. */
    possible_copies: await possibleCopies(tx, needles, p.all, prefixOf),
    not_erased: ["values copied by hand into other records (see possible_copies)", "sent quotes and orders, kept as issued",
      "the audit log, which holds field names and IDs, never values", "backups, until they age out", "what webhooks already delivered to other systems"],
  };
  if (dryRun) return { dry_run: true as const, result: summary, confirm_token: issueConfirm(ctx, "erase", { h: print } satisfies EraseToken) };

  if (!input.confirm_token) throw badRequest("An erasure needs confirmation: run it with dry_run: true first and pass back its confirm_token");
  const token = readConfirm<EraseToken>(ctx, "erase", input.confirm_token, REDO);
  if (token.body.h !== print) {
    throw conflict(`What this erasure covers has changed since its dry run (a record, activity or task was added or removed); ${REDO}`);
  }
  await spendConfirm(tx, ctx, input.confirm_token, token.exp);

  const actor = ctx.actor.id;
  // Copies first, so the event this erasure emits below is not one of them.
  await eraseCopies(tx, p.all);
  await eraseMergeValues(tx, p.main.concat(p.leads));
  const files = await eraseFilesOf(tx, p.all, actor);
  const external = files.filter((f) => storeNamed(f.store).external);
  for (const f of files) if (!storeNamed(f.store).external) await storeNamed(f.store).delete(tx, ctx.tenantId, f.id);
  await deleteLinksFrom(tx, p.all);
  if (p.activities.length) await eraseActivities(tx, p.activities, actor);
  if (p.tasks.length) await eraseTasks(tx, p.tasks, actor);
  if (p.accountContacts.length) await eraseAccountContacts(tx, p.accountContacts, actor);
  if (p.dealContacts.length) await eraseDealContacts(tx, p.dealContacts, actor);
  if (p.leads.length) await eraseLeads(tx, p.leads, actor);
  if (p.contacts.length) await eraseContacts(tx, p.contacts, actor);
  if (p.custom.length) await eraseCustomRecords(tx, p.custom, actor);

  let suppressed = 0;
  if (input.suppress_email ?? true) {
    for (const c of identities) {
      if (!c.email || !validAddress(c.email)) continue;
      await insertSuppression(tx, ctx.tenantId, mailboxHash(ctx.tenantId, c.email), "erased", "erasure");
      suppressed++;
    }
  }

  // One audit entry and one event per erased record, so each record's own history says what happened to it. IDs and counts only.
  const entries: { object: string; id: string }[] = [
    ...p.contacts.map((id) => ({ object: "contact", id })), ...p.leads.map((id) => ({ object: "lead", id })), ...p.custom.map((id) => ({ object: p.obj.api_name, id })),
  ];
  for (const e of entries) {
    const primary = e.id === p.id;
    await audit(tx, ctx, { action: `${e.object}.erased`, objectType: e.object, recordId: e.id,
      details: primary ? { counts: summary.counts, files: files.length, emails_suppressed: suppressed } : { with: summary.id } });
    await emit(tx, ctx, { type: `${e.object}.erased`, objectType: e.object, recordId: e.id, data: primary ? {} : { with: summary.id } });
  }
  const tenantId = ctx.tenantId;
  return {
    dry_run: false as const,
    result: { ...summary, emails_suppressed: suppressed },
    // Bytes kept outside the database go once the erasure has committed.
    ...(external.length ? { after: async () => { for (const f of external) await storeNamed(f.store).delete(tx, tenantId, f.id); } } : {}),
  };
}
