import type { Tx } from "../../db/pool.js";

/**
 * The SQL of erasing a person's records (core/erasure.ts; ADR 0020, ADR 0012). The code that calls
 * these keeps its checks, errors, audits and the order of statements in its transaction. Every
 * statement runs inside a workspace's transaction, so row-level security keeps it to that workspace.
 */

/** What an erased text value reads as where a column can't be empty. */
export const ERASED = "[erased]";

// --- What an erasure covers --------------------------------------------------------------------------

/** Records that were merged into any of these (their archived duplicates), one hop. */
export async function mergedIntoAny(tx: Tx, ids: string[]): Promise<string[]> {
  return (await tx<{ id: string }[]>`SELECT DISTINCT unnest(merged_ids) AS id FROM merges WHERE survivor_id = ANY (${ids}::uuid[])`).map((r) => r.id);
}

/** Every lead of these contacts, archived ones included, locked. */
export async function leadsOfContacts(tx: Tx, contactIds: string[]): Promise<string[]> {
  return (await tx<{ id: string }[]>`SELECT id FROM leads WHERE contact_id = ANY (${contactIds}::uuid[]) ORDER BY id FOR UPDATE`).map((r) => r.id);
}

/** The rows that link these contacts to accounts or to deals. */
export async function contactLinkRows(tx: Tx, table: "account_contacts" | "deal_contacts", contactIds: string[]): Promise<string[]> {
  const rows = table === "account_contacts"
    ? await tx<{ id: string }[]>`SELECT id FROM account_contacts WHERE contact_id = ANY (${contactIds}::uuid[]) ORDER BY id FOR UPDATE`
    : await tx<{ id: string }[]>`SELECT id FROM deal_contacts WHERE contact_id = ANY (${contactIds}::uuid[]) ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** Activities about any of these records, or done by one of these contacts. */
export async function activitiesAbout(tx: Tx, recordIds: string[], contactIds: string[]): Promise<string[]> {
  return (await tx<{ id: string }[]>`
    SELECT id FROM activities WHERE actor_contact_id = ANY (${contactIds}::uuid[])
    UNION SELECT activity_id FROM activity_associations WHERE record_id = ANY (${recordIds}::uuid[])
    ORDER BY 1`).map((r) => r.id);
}

/** Tasks about any of these records. */
export async function tasksAbout(tx: Tx, recordIds: string[]): Promise<string[]> {
  return (await tx<{ id: string }[]>`SELECT DISTINCT task_id AS id FROM task_associations WHERE record_id = ANY (${recordIds}::uuid[]) ORDER BY 1`).map((r) => r.id);
}

/** The email addresses and names these contacts hold now, before they go: for the suppression list and for finding copies. */
export async function contactIdentities(tx: Tx, contactIds: string[]): Promise<{ email: string | null; first_name: string | null; last_name: string | null }[]> {
  return tx<{ email: string | null; first_name: string | null; last_name: string | null }[]>`
    SELECT primary_email::text AS email, first_name, last_name FROM contacts WHERE id = ANY (${contactIds}::uuid[])`;
}

export interface CopyCounts { files: number; events: number; webhook_deliveries: number; automation_runs: number; notifications: number; merges: number; relation_values: number }

/** How many copies and attachments of these records exist: what an erasure will remove or blank. */
export async function copyCounts(tx: Tx, mainIds: string[], allIds: string[]): Promise<CopyCounts> {
  const [row] = await tx<CopyCounts[]>`
    SELECT (SELECT count(*) FROM files WHERE record_id = ANY (${allIds}::uuid[]) AND deleted_at IS NULL)::int AS files,
           (SELECT count(*) FROM outbox_events WHERE record_id = ANY (${allIds}::uuid[]))::int AS events,
           (SELECT count(*) FROM webhook_deliveries d WHERE d.event_id IN (SELECT id FROM outbox_events WHERE record_id = ANY (${allIds}::uuid[])))::int AS webhook_deliveries,
           (SELECT count(*) FROM automation_runs r WHERE r.record_id = ANY (${allIds}::uuid[])
              OR r.event_id IN (SELECT id FROM outbox_events WHERE record_id = ANY (${allIds}::uuid[])))::int AS automation_runs,
           (SELECT count(*) FROM notifications WHERE record_id = ANY (${allIds}::uuid[]))::int AS notifications,
           (SELECT count(*) FROM merges WHERE survivor_before IS NOT NULL AND (survivor_id = ANY (${mainIds}::uuid[]) OR merged_ids && ${mainIds}::uuid[]))::int AS merges,
           (SELECT count(*) FROM record_links WHERE from_id = ANY (${allIds}::uuid[]))::int AS relation_values`;
  return row!;
}

/**
 * Other records whose searchable text holds one of these strings (an email address, a full name): values
 * someone may have copied by hand, which an erasure can't know about. At most `limit`, for a person to look at.
 */
export async function recordsMentioning(tx: Tx, needles: string[], exceptIds: string[], limit: number): Promise<{ id: string; object_id: string }[]> {
  if (needles.length === 0) return [];
  const likes = needles.map((n) => `%${n.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return tx<{ id: string; object_id: string }[]>`
    SELECT s.id, g.object_id FROM (
      SELECT id, search_text FROM contacts UNION ALL SELECT id, search_text FROM accounts UNION ALL SELECT id, search_text FROM leads
      UNION ALL SELECT id, search_text FROM deals UNION ALL SELECT id, search_text FROM activities UNION ALL SELECT id, search_text FROM tasks
      UNION ALL SELECT id, search_text FROM records
    ) s JOIN record_registry g ON g.id = s.id
    WHERE s.search_text LIKE ANY (${likes}::text[]) AND NOT s.id = ANY (${exceptIds}::uuid[])
    ORDER BY s.id LIMIT ${limit}`;
}

// --- Blanking the records ----------------------------------------------------------------------------

/** Blanks contacts: who they are goes; their lifecycle stage, account, owner and dates stay, so counts and history still add up. */
export async function eraseContacts(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE contacts SET first_name = NULL, last_name = ${ERASED}, primary_email = NULL, primary_phone = NULL, job_title = NULL, source = NULL,
             external_ids = '{}', custom = '{}', custom_encrypted = '{}', search_text = '', anonymized_at = now(), archived_at = coalesce(archived_at, now()),
             version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[]) AND anonymized_at IS NULL`;
}

/** Blanks leads: what the person asked about and why they were turned down go; status, owner, the deal it became and dates stay. */
export async function eraseLeads(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE leads SET interest_campaign = NULL, interest_text = NULL, source = NULL, channel = NULL, disqualification_reason = NULL,
             external_ids = '{}', custom = '{}', custom_encrypted = '{}', search_text = '', anonymized_at = now(), archived_at = coalesce(archived_at, now()),
             version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[]) AND anonymized_at IS NULL`;
}

/** Blanks records of a custom object: every value goes. */
export async function eraseCustomRecords(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE records SET data = '{}', encrypted = '{}', external_ids = '{}', search_text = '', anonymized_at = now(), archived_at = coalesce(archived_at, now()),
             version = version + 1, updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[]) AND anonymized_at IS NULL`;
}

/** A contact's place at an account: the role and custom values go and the link is archived. */
export async function eraseAccountContacts(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE account_contacts SET role = NULL, external_ids = '{}', custom = '{}', custom_encrypted = '{}', search_text = '',
             archived_at = coalesce(archived_at, now()), version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[])`;
}

/** A contact's part in a deal: custom values go; the link and its buying role stay, so the deal still shows someone held it. */
export async function eraseDealContacts(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE deal_contacts SET external_ids = '{}', custom = '{}', custom_encrypted = '{}', search_text = '', version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[])`;
}

/** Blanks activities: what was said goes; that something happened, of which type, when and about which records stays. */
export async function eraseActivities(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE activities SET subject = ${ERASED}, body = NULL, payload = '{}', source = NULL, external_id = NULL, external_ids = '{}', custom = '{}',
             custom_encrypted = '{}', search_text = '', version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[])`;
}

/** Blanks tasks: the title and description go; assignee, due date and status stay. */
export async function eraseTasks(tx: Tx, ids: string[], actorId: string | null): Promise<void> {
  await tx`UPDATE tasks SET title = ${ERASED}, description = NULL, external_ids = '{}', custom = '{}', custom_encrypted = '{}', search_text = '',
             version = version + 1, updated_at = now(), updated_by = ${actorId}
           WHERE id = ANY (${ids}::uuid[])`;
}

/** Removes the values of these records' custom relation fields. Links other records hold to them stay. */
export async function deleteLinksFrom(tx: Tx, ids: string[]): Promise<void> {
  await tx`DELETE FROM record_links WHERE from_id = ANY (${ids}::uuid[])`;
}

// --- Copies ------------------------------------------------------------------------------------------

/**
 * Marks these records' files removed and blanks their names and hashes (a name and a hash can identify
 * a person's document). Returns each file's store, so its bytes can be deleted.
 */
export async function eraseFilesOf(tx: Tx, recordIds: string[], actorId: string | null): Promise<{ id: string; store: "postgres" | "s3" }[]> {
  return tx<{ id: string; store: "postgres" | "s3" }[]>`
    UPDATE files SET name = ${ERASED}, sha256 = repeat('0', 64), deleted_at = coalesce(deleted_at, now()), deleted_by = coalesce(deleted_by, ${actorId})
    WHERE record_id = ANY (${recordIds}::uuid[]) AND name <> ${ERASED} RETURNING id, store`;
}

/**
 * Blanks what the event feed, webhook deliveries, automation runs and notifications kept about these
 * records. Events and deliveries keep their type and time. A delivery not yet sent is never sent, and a
 * run not yet finished is skipped: neither may carry the values out now.
 */
export async function eraseCopies(tx: Tx, recordIds: string[]): Promise<void> {
  await tx`UPDATE webhook_deliveries d SET payload = '{"erased": true}', restricted_values = NULL,
             status = CASE WHEN d.status IN ('pending', 'sending') THEN 'dead' ELSE d.status END,
             last_error = CASE WHEN d.status IN ('pending', 'sending') THEN 'The record was erased' ELSE d.last_error END,
             locked_until = NULL, lease_token = NULL
           WHERE d.event_id IN (SELECT id FROM outbox_events WHERE record_id = ANY (${recordIds}::uuid[]))`;
  await tx`UPDATE automation_runs r SET results = '[]', input = NULL, progress = NULL,
             status = CASE WHEN r.status IN ('queued', 'running') THEN 'skipped' ELSE r.status END,
             reason = CASE WHEN r.status IN ('queued', 'running') THEN 'The record was erased' ELSE NULL END,
             finished_at = coalesce(r.finished_at, now()), locked_until = NULL, lease_token = NULL
           WHERE r.record_id = ANY (${recordIds}::uuid[]) OR r.event_id IN (SELECT id FROM outbox_events WHERE record_id = ANY (${recordIds}::uuid[]))`;
  await tx`UPDATE outbox_events SET data = '{}', last_error = NULL WHERE record_id = ANY (${recordIds}::uuid[])`;
  await tx`UPDATE notification_deliveries SET status = 'skipped', last_error = NULL
           WHERE status = 'pending' AND notification_id IN (SELECT id FROM notifications WHERE record_id = ANY (${recordIds}::uuid[]))`;
  await tx`UPDATE notifications SET title = ${ERASED}, body = NULL, state = 'resolved', resolved_at = coalesce(resolved_at, now()), snoozed_until = NULL
           WHERE record_id = ANY (${recordIds}::uuid[])`;
  await tx`DELETE FROM rule_deadlines WHERE record_id = ANY (${recordIds}::uuid[])`;
}

/** Drops the survivor's previous values that merges of these records kept (app.erase_merge_values, migration 027). */
export async function eraseMergeValues(tx: Tx, recordIds: string[]): Promise<void> {
  await tx`SELECT app.erase_merge_values(${recordIds}::uuid[])`;
}
