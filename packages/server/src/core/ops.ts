import type { Tx } from "../db/pool.js";
import { claimRecords } from "./limits.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { assertObject, assertWritable, canObject, canReadField, fieldAccess, hasHiddenFields } from "./access.js";
import { audit } from "./audit.js";
import type { Ctx } from "./context.js";
import { emit } from "./events.js";
import { Compiler, escapeLike, targetFor } from "./query.js";
import { createRecord, getRecord, requireRecord, serialize, type RecordOut } from "./records.js";
import { ADDRESS_PART_NAMES } from "./fieldtypes.js";
import { getObject, isModuleOn, loadSchema, quoteIdent, SEARCH_TEXT_TYPES, type ObjectMeta, type Schema } from "./schema.js";
import {
  activeMemberByEmail, activeMemberById, activitiesAbout, associateActivity, dealForStageMove, insertLeadConvertedActivity, insertStageHistory,
  leadForConversion, liveAccountByDomain, liveContactByEmail, liveStageById, liveStageByName, liveStageNames, markLeadConverted, moveDealToStage,
  setDealSourceLead, setFormSubmission, setRecordOwner, stageChangesOf, tasksAbout, tasksAssignedTo,
} from "./queries/ops.js";
import { bumpLifecycle, normalizeDomain } from "./standard.js";

/**
 * Lifecycle operations. Each runs inside the caller's transaction, so it completes
 * fully or changes nothing, and writes audit entries and events for what it touches.
 * Each checks, before it looks anything up, that the caller may read every object it returns and
 * write every object and field it sets. Platform bookkeeping that follows a change (a contact's
 * lifecycle stage, history activities, stage history, last_activity_at) is not the caller's write.
 *
 * Copies: when an operation copies a value from one record into another (a contact's account into a
 * lead, a lead's account into a deal, names into a default deal name), it copies only what the caller
 * can read on the source. Otherwise the copy, which the caller (and other members) can read, would
 * carry a hidden value out. History activities get generic subjects for the same reason; they link
 * to the records they are about, and readers see those as their own role allows.
 */

/** Drops keys whose value wasn't given, so only fields the caller actually sets are checked and written. */
const given = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export interface OpResult<T = unknown> { dry_run: boolean; result: T; would?: string[] }

const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com", "zoho.com"]);

export interface CaptureInterestInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  domain?: string;
  interest?: string;
  campaign?: string;
  source?: string;
  channel?: string;
  form_fields?: Record<string, unknown>;
}

/** Matches or creates the contact (and account, by domain), then creates a lead and a form_submitted activity. */
export async function captureInterest(tx: Tx, ctx: Ctx, input: CaptureInterestInput, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  const objects = { lead: getObject(schema, "lead"), contact: getObject(schema, "contact"), account: getObject(schema, "account"), activity: getObject(schema, "activity") };
  if (typeof input.email !== "string") throw unprocessable("email is required");
  const email = input.email.trim().toLowerCase();
  const emailDomain = email.split("@")[1] ?? "";
  const domain = input.domain ? normalizeDomain(input.domain) : FREE_MAIL.has(emailDomain) ? null : emailDomain;
  const contactValues = given({ email, first_name: input.first_name, last_name: input.last_name, source: input.source });
  const leadValues = given({ interest: input.interest, campaign: input.campaign, source: input.source, channel: input.channel });
  // Before any lookup: whether a contact with this email exists is itself contact data.
  for (const o of [objects.contact, objects.lead]) assertObject(ctx, o, "read");
  assertWritable(ctx, objects.contact, [...Object.keys(contactValues), ...(domain ? ["account"] : [])]);
  assertWritable(ctx, objects.lead, ["contact", ...Object.keys(leadValues), ...(domain ? ["account"] : [])]);
  assertWritable(ctx, objects.activity, ["type", "subject", "actor_contact", "source"]);
  if (domain) {
    assertObject(ctx, objects.account, "read");
    assertWritable(ctx, objects.account, ["name", "domain"]);
  }
  const would: string[] = [];
  const existingContact = await liveContactByEmail(tx, email);
  const existingAccount = domain ? await liveAccountByDomain(tx, domain) : undefined;
  if (!existingAccount && domain) would.push(`create account for ${domain}`);
  would.push(existingContact ? "use existing contact" : `create contact ${email}`, "create lead", "log form_submitted activity");
  if (dryRun) return { dry_run: true, result: null, would };

  // The existing contact's account is reused only for a caller who can read contact.account: it ends
  // up in the lead, the activity and this response. Without a domain, the lead's own hook makes the copy
  // (by the same rule), so a caller who can't write lead.account isn't refused halfway through.
  const contactAccount = canReadField(ctx, objects.contact, "account") ? existingContact?.primary_account_id ?? null : null;
  let accountId = existingAccount?.id ?? contactAccount;
  if (!accountId && domain) {
    const acct = await createRecord(tx, ctx, "account", { name: input.company ?? domain, domain });
    accountId = decodeId(acct.id)!.uuid;
  }
  const contact = existingContact
    ? await getRecord(tx, ctx, "contact", encodeId("con", existingContact.id))
    : await createRecord(tx, ctx, "contact", { ...contactValues, ...(accountId ? { account: encodeId("acct", accountId) } : {}) });
  const lead = await createRecord(tx, ctx, "lead", {
    contact: contact.id, ...leadValues, ...(domain && accountId ? { account: encodeId("acct", accountId) } : {}),
  });
  // A generic subject: the interest is the lead's (lead.interest), and readers see it there only if their role can.
  const activity = await createRecord(tx, ctx, "activity", {
    type: "form_submitted", subject: "Form submitted", actor_contact: contact.id, source: input.source ?? "api",
    related_to: [lead.id, ...(accountId && canObject(ctx, objects.account, "read") ? [encodeId("acct", accountId)] : [])],
  });
  if (input.form_fields) {
    await setFormSubmission(tx, decodeId(activity.id)!.uuid, input.form_fields);
  }
  return { dry_run: false, result: { contact, lead, account_id: accountId ? encodeId("acct", accountId) : null } };
}

export interface ConvertLeadInput { lead: string; deal_name?: string; pipeline?: string; stage?: string; amount?: number; expected_close_date?: string }

/** Creates a deal from a qualified lead, and marks the lead converted. */
export async function convertLead(tx: Tx, ctx: Ctx, input: ConvertLeadInput, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  const leadObj = getObject(schema, "lead");
  const dealObj = getObject(schema, "deal");
  assertWritable(ctx, leadObj, ["status"]);
  assertObject(ctx, getObject(schema, "contact"), "read");
  // The deal's primary contact is copied from the lead, so the caller must be able to read it there.
  if (!canReadField(ctx, leadObj, "contact")) throw forbidden("This key can't read lead.contact, so it can't convert leads");
  assertWritable(ctx, dealObj, ["name", "primary_contact",
    ...(["pipeline", "stage", "amount", "expected_close_date"] as const).filter((k) => input[k] !== undefined)]);
  const leadId = await requireRecord(tx, schema, "lead", input.lead, "lead");
  const lead = await leadForConversion(tx, leadId);
  if (!lead) throw notFound(`Lead ${input.lead}`);
  // The lead's account is copied into the deal only when the caller can read it on the lead.
  const accountId = lead.account_id && canReadField(ctx, leadObj, "account") ? lead.account_id : null;
  if (accountId) {
    assertObject(ctx, getObject(schema, "account"), "read");
    assertWritable(ctx, dealObj, ["account"]);
  }
  if (lead.status_category === "converted") throw conflict("This lead is already converted");
  if (lead.status_category !== "qualified") {
    throw unprocessable(`Only qualified leads can be converted; this lead's status category is "${lead.status_category}". Update its status to qualified first.`);
  }
  // The default deal name is built from what the caller can see of the contact and the lead, so it can't carry a hidden value into the deal.
  const contact = await getRecord(tx, ctx, "contact", encodeId("con", lead.contact_id));
  const leadRec = await getRecord(tx, ctx, "lead", input.lead);
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  const name = input.deal_name ?? `${[text(contact.first_name), text(contact.last_name)].filter(Boolean).join(" ") || text(contact.email) || "New"} — ${text(leadRec.interest) ?? "deal"}`;
  if (dryRun) return { dry_run: true, result: null, would: [`create deal "${name}"`, "mark lead converted", "move contact to opportunity"] };

  const deal = await createRecord(tx, ctx, "deal", {
    name, primary_contact: encodeId("con", lead.contact_id),
    ...(accountId ? { account: encodeId("acct", accountId) } : {}),
    ...(input.pipeline ? { pipeline: input.pipeline } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.expected_close_date ? { expected_close_date: input.expected_close_date } : {}),
  });
  const dealId = decodeId(deal.id)!.uuid;
  await setDealSourceLead(tx, dealId, leadId);
  const convertedKey = (getObject(schema, "lead").byName.get("status")?.options.values ?? []).find((v) => v.category === "converted")?.key ?? "converted";
  await markLeadConverted(tx, leadId, convertedKey, dealId, ctx.actor.id);
  await bumpLifecycle(tx, ctx, lead.contact_id, "opportunity");
  const activityId = uuidv7();
  await claimRecords(tx, ctx.tenantId);
  await insertLeadConvertedActivity(tx, { tenantId: ctx.tenantId, id: activityId, actorType: ctx.actor.type === "user" ? "user" : "system",
    actorUserId: ctx.actor.type === "user" ? ctx.actor.id : null, actorId: ctx.actor.id });
  for (const rid of [leadId, dealId, lead.contact_id]) {
    await associateActivity(tx, ctx.tenantId, activityId, rid);
  }
  await audit(tx, ctx, { action: "lead.converted", objectType: "lead", recordId: leadId, details: { deal_id: dealId } });
  await emit(tx, ctx, { type: "lead.converted", objectType: "lead", recordId: leadId, data: { deal_id: deal.id } });
  return { dry_run: false, result: { deal: await getRecord(tx, ctx, "deal", deal.id), lead: await getRecord(tx, ctx, "lead", input.lead) } };
}

export interface MoveDealStageInput { deal: string; stage: string; lost_reason?: string }

/** Moves a deal to another stage of its pipeline, recording stage history. */
export async function moveDealStage(tx: Tx, ctx: Ctx, input: MoveDealStageInput, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  const dealObj = getObject(schema, "deal");
  assertWritable(ctx, dealObj, ["stage", ...(input.lost_reason !== undefined ? ["lost_reason"] : [])]);
  const dealId = await requireRecord(tx, schema, "deal", input.deal, "deal");
  const deal = await dealForStageMove(tx, dealId);
  if (!deal) throw notFound(`Deal ${input.deal}`);
  const decoded = decodeId(input.stage);
  const stage = decoded && decoded.prefix === "stg"
    ? await liveStageById(tx, decoded.uuid, deal.pipeline_id)
    : await liveStageByName(tx, input.stage, deal.pipeline_id);
  if (!stage) {
    const names = await liveStageNames(tx, deal.pipeline_id);
    throw unprocessable(`"${input.stage}" is not a stage of this deal's pipeline. Stages: ${names.map((n) => n.name).join(", ")}`);
  }
  if (stage.id === deal.stage_id) return { dry_run: dryRun, result: await getRecord(tx, ctx, "deal", input.deal), would: ["no change: already in that stage"] };
  if (dryRun) return { dry_run: true, result: null, would: [`move deal to "${stage.name}" (${stage.category})`] };

  // probability follows the stage: bookkeeping, set even for a caller who holds it read-only.
  // lost_reason is user data: it is set or cleared only for a caller who can write it, and left alone otherwise.
  const lostField = dealObj.byName.get("lost_reason");
  const setLostReason = Boolean(lostField && fieldAccess(ctx, dealObj, lostField) === "write");
  await moveDealToStage(tx, { dealId, stageId: stage.id, category: stage.category, probability: stage.default_probability,
    setLostReason, lostReason: stage.category === "lost" ? input.lost_reason ?? null : null, actorId: ctx.actor.id });
  await insertStageHistory(tx, { tenantId: ctx.tenantId, id: uuidv7(), dealId, fromStageId: deal.stage_id, toStageId: stage.id,
    changedBy: ctx.actor.id, enteredAt: deal.stage_entered_at });
  if (stage.category === "won") await bumpLifecycle(tx, ctx, deal.primary_contact_id, "customer");
  await audit(tx, ctx, { action: "deal.stage_changed", objectType: "deal", recordId: dealId, details: { to_stage: stage.name, category: stage.category } });
  await emit(tx, ctx, { type: "deal.stage_changed", objectType: "deal", recordId: dealId,
    data: { from_status: deal.status_category, to_stage: stage.name, to_status: stage.category } });
  return { dry_run: false, result: await getRecord(tx, ctx, "deal", input.deal) };
}

/** Sets the owner of any owned record. `owner` is a user ID or email. */
export async function assignOwner(tx: Tx, ctx: Ctx, input: { record: string; owner: string }, dryRun: boolean): Promise<OpResult> {
  const schema = await loadSchema(tx);
  const d = decodeId(input.record);
  const obj = d ? schema.byPrefix.get(d.prefix) : undefined;
  if (!d || !obj) throw notFound(`Record ${input.record}`);
  if (!isModuleOn(schema, obj)) throw notFound(`Record ${input.record}`);
  if (!obj.owned) throw unprocessable(`${obj.plural_label} do not have owners`);
  assertWritable(ctx, obj, obj.byName.has("owner") ? ["owner"] : []);
  const u = decodeId(input.owner);
  const user = u && u.prefix === "usr"
    ? await activeMemberById(tx, u.uuid)
    : await activeMemberByEmail(tx, input.owner);
  if (!user) throw unprocessable(`No active member matches "${input.owner}"`);
  await requireRecord(tx, schema, obj.api_name, input.record, "record");
  if (dryRun) return { dry_run: true, result: null, would: [`assign ${obj.label.toLowerCase()} to ${user.name}`] };
  await setRecordOwner(tx, obj.table_name ?? "records", user.id, ctx.actor.id, d.uuid);
  await audit(tx, ctx, { action: `${obj.api_name}.owner_assigned`, objectType: obj.api_name, recordId: d.uuid, details: { owner_id: user.id } });
  await emit(tx, ctx, { type: `${obj.api_name}.updated`, objectType: obj.api_name, recordId: d.uuid, data: { after: { owner: encodeId("usr", user.id) } } });
  return { dry_run: false, result: await getRecord(tx, ctx, obj.api_name, input.record) };
}

/** Everything that happened on a record: activities, tasks, and (for deals) stage changes. Newest first. */
export async function timeline(tx: Tx, ctx: Ctx, publicId: string, limit = 50): Promise<{ record: RecordOut; items: unknown[] }> {
  const schema = await loadSchema(tx);
  const d = decodeId(publicId);
  const obj = d ? schema.byPrefix.get(d.prefix) : undefined;
  if (!d || !obj || !isModuleOn(schema, obj)) throw notFound(`Record ${publicId}`);
  const record = await getRecord(tx, ctx, obj.api_name, publicId);
  const n = Math.min(Math.max(limit, 1), 200);
  // Activities and tasks are objects of their own: they appear only for a caller who can read them.
  const activityObj = getObject(schema, "activity");
  const actRows = canObject(ctx, activityObj, "read") ? await activitiesAbout(tx, d.uuid, n) : [];
  const activities = await serialize(tx, ctx, schema, activityObj, actRows);
  const taskObj = getObject(schema, "task");
  const taskRows = canObject(ctx, taskObj, "read") ? await tasksAbout(tx, d.uuid, n) : [];
  const tasks = await serialize(tx, ctx, schema, taskObj, taskRows);
  const items: { kind: string; at: string; item: unknown }[] = [
    ...activities.map((a) => ({ kind: "activity", at: String(a.occurred_at), item: a })),
    ...tasks.map((t) => ({ kind: "task", at: String(t.created_at), item: t })),
  ];
  if (obj.api_name === "deal" && obj.byName.has("stage") && fieldAccess(ctx, obj, obj.byName.get("stage")!) !== "none") {
    const hist = await stageChangesOf(tx, d.uuid, n);
    items.push(...hist.map((h) => ({ kind: "stage_change", at: h.changed_at.toISOString(), item: { from: h.from_name, to: h.to_name, status: h.category } })));
  }
  items.sort((x, y) => (x.at < y.at ? 1 : -1));
  return { record, items: items.slice(0, n) };
}

const SEARCHED_TYPES = SEARCH_TEXT_TYPES;

/** How many rows a search examines on an object with hidden fields (see searchVisible). */
export const VISIBLE_SEARCH_SCAN = 10_000;

/**
 * Search for a caller with hidden fields on `obj`. search_text holds every searchable field, so
 * matching on it would let a hidden field decide what is found. This matches only the fields the
 * caller can read instead, which no index covers, so it examines a bounded window: the newest
 * VISIBLE_SEARCH_SCAN records (by ID, which is time-ordered; custom objects by updated_at, which
 * their index covers). Which rows are examined depends on no field value, so the bound reveals nothing.
 */
async function searchVisible(tx: Tx, ctx: Ctx, schema: Schema, obj: ObjectMeta, like: string, term: string, per: number) {
  const t = targetFor(schema, obj.api_name);
  const c = new Compiler(schema);
  const parts = obj.fields.filter((f) => f.sensitivity !== "restricted" && SEARCHED_TYPES.includes(f.type) && fieldAccess(ctx, obj, f) !== "none")
    // An address is searched by its parts, as search_text holds them.
    .flatMap((f) => (f.type === "address" ? ADDRESS_PART_NAMES.map((p) => `${f.api_name}.${p}`) : [f.api_name]))
    .map((name) => c.expr("r", t.fields.get(name)!));
  if (parts.length === 0) return [];
  const doc = `lower(concat_ws(' ', ${parts.join(", ")}))`;
  const window = obj.is_system
    ? `SELECT * FROM ${quoteIdent(obj.table_name!)} WHERE archived_at IS NULL ORDER BY id DESC LIMIT ${VISIBLE_SEARCH_SCAN}`
    : `SELECT * FROM records WHERE archived_at IS NULL AND object_id = $3 ORDER BY updated_at DESC LIMIT ${VISIBLE_SEARCH_SCAN}`;
  // Reviewed: `window` is built from a quoted table name and a constant, `doc` from the query compiler's
  // column expressions, and `per` is an integer clamped to 1–25 by the caller. Every value is a bound parameter.
  // nosemgrep: hlcrm-no-interpolated-sql-in-unsafe
  return tx.unsafe<{ id: string }[]>( // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
    `SELECT r.* FROM (${window}) r WHERE ${doc} ILIKE $1 ORDER BY similarity(${doc}, $2) DESC, r.id LIMIT ${per}`,
    obj.is_system ? [like, term] : [like, term, obj.id]);
}

/** Fuzzy search across every searchable object that is turned on and that the caller can read. */
export async function search(tx: Tx, ctx: Ctx, q: string, objects?: string[], limitPerObject = 10): Promise<RecordOut[]> {
  const term = q.trim().toLowerCase();
  if (term.length < 2) throw unprocessable("Search needs at least 2 characters");
  if (term.length > 200) throw unprocessable("Search text is too long");
  if (objects && objects.length > 50) throw unprocessable("Search at most 50 objects at a time");
  const schema = await loadSchema(tx);
  const named = [...schema.objects.values()].filter((o) => isModuleOn(schema, o) && !o.hidden &&
    (objects ? objects.includes(o.api_name) : ["contact", "account", "lead", "deal"].includes(o.api_name) || !o.is_system));
  // Asked for by name, an unreadable object is an error; by default it is simply not searched.
  const unreadable = named.filter((o) => !canObject(ctx, o, "read"));
  if (objects && unreadable.length) throw forbidden(`This key can't read ${unreadable.map((o) => o.api_name).join(", ")} records`);
  const candidates = named.filter((o) => canObject(ctx, o, "read"));
  const per = Math.min(Math.max(Number.isInteger(limitPerObject) ? limitPerObject : 10, 1), 25);
  const like = `%${escapeLike(term)}%`;
  const out: RecordOut[] = [];
  // Standard objects have their own tables (a handful of queries); custom objects share `records`, so
  // they are searched in one query, however many there are.
  for (const obj of candidates.filter((o) => o.is_system)) {
    if (hasHiddenFields(ctx, obj)) {
      out.push(...(await serialize(tx, ctx, schema, obj, await searchVisible(tx, ctx, schema, obj, like, term, per))));
      continue;
    }
    const rows = await tx.unsafe<{ id: string }[]>( // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
      `SELECT * FROM ${quoteIdent(obj.table_name!)} WHERE archived_at IS NULL AND search_text ILIKE $1
       ORDER BY similarity(search_text, $2) DESC, id LIMIT ${per}`, [like, term]);
    out.push(...(await serialize(tx, ctx, schema, obj, rows)));
  }
  const custom = candidates.filter((o) => !o.is_system && !hasHiddenFields(ctx, o));
  if (custom.length) {
    const rows = await tx.unsafe<{ id: string; object_id: string }[]>( // eslint-disable-line no-restricted-syntax -- SQL built at run time, kept beside its builder (ADR 0012)
      `SELECT * FROM (
         SELECT r.*, row_number() OVER (PARTITION BY r.object_id ORDER BY similarity(r.search_text, $2) DESC, r.id) AS __rank
         FROM records r WHERE r.archived_at IS NULL AND r.search_text ILIKE $1 AND r.object_id = ANY($3::uuid[])
       ) x WHERE __rank <= ${per}`, [like, term, custom.map((o) => o.id)]);
    for (const obj of custom) {
      const mine = rows.filter((r) => r.object_id === obj.id);
      if (mine.length) out.push(...(await serialize(tx, ctx, schema, obj, mine)));
    }
  }
  for (const obj of candidates.filter((o) => !o.is_system && hasHiddenFields(ctx, o))) {
    out.push(...(await serialize(tx, ctx, schema, obj, await searchVisible(tx, ctx, schema, obj, like, term, per))));
  }
  return out;
}

/**
 * Open tasks assigned to the calling user, soonest due first. The list filters and sorts on fields, and
 * which tasks appear (or their order) would reveal them, so it uses only what the caller can read: it
 * needs task.assignee; with task.status hidden it lists all of the caller's tasks, not only open ones;
 * with task.status or task.due_at hidden it sorts newest first.
 */
export async function myOpenTasks(tx: Tx, ctx: Ctx): Promise<RecordOut[]> {
  if (ctx.actor.type !== "user") throw unprocessable("my_open_tasks needs a key that belongs to a user");
  const schema = await loadSchema(tx);
  const obj = getObject(schema, "task");
  assertObject(ctx, obj, "read");
  if (!canReadField(ctx, obj, "assignee")) throw forbidden("This key can't read task.assignee, so it can't list the tasks assigned to you");
  const status = canReadField(ctx, obj, "status");
  const due = canReadField(ctx, obj, "due_at");
  const rows = await tasksAssignedTo(tx, ctx.actor.id, status, status && due);
  return serialize(tx, ctx, schema, obj, rows);
}
