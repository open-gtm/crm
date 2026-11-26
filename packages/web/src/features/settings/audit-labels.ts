/**
 * Audit entries as a person reads them: what happened in words (the action code stays alongside, for
 * searching and for a report), and who did it by name rather than by member ID.
 */

const KNOWN: Record<string, string> = {
  "auth.signed_in": "Signed in",
  "auth.sessions_revoked": "Signed out sessions",
  "auth.sign_in_link_created": "Created a sign-in link",
  "auth.sso_linked": "Linked single sign-on",
  "auth.sso_unlinked": "Unlinked single sign-on",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "api_key.rotated": "Rotated an API key",
  "member.added": "Added a member",
  "service_account.created": "Created a service account",
  "role.created": "Created a role",
  "role.updated": "Changed a role",
  "role.archived": "Archived a role",
  "view.created": "Saved a view",
  "view.updated": "Changed a view",
  "view.deleted": "Deleted a view",
  "webhook.created": "Added a webhook",
  "webhook.updated": "Changed a webhook",
  "webhook.archived": "Removed a webhook",
  "webhook.secret_revealed": "Revealed a webhook's secret",
  "webhook.secret_rotated": "Rotated a webhook's secret",
  "webhook.delivery_replayed": "Replayed a webhook delivery",
  "connection.created": "Added a connection",
  "connection.updated": "Changed a connection",
  "connection.secret_set": "Entered a connection's secret",
  "connection.tested": "Tested a connection",
  "connection.archived": "Archived a connection",
  "workspace.created": "Created the workspace",
  "workspace.sign_in_changed": "Changed how members sign in",
  "schema.applied": "Changed the schema",
  "pipeline.created": "Created a pipeline",
  "deal.stage_changed": "Moved a deal to another stage",
  "lead.converted": "Converted a lead",
  "contact.lifecycle_changed": "Changed a contact's lifecycle stage",
  "alert.created": "Created an alert",
  "alert.updated": "Changed an alert",
  "alert.archived": "Archived an alert",
  "automation.created": "Created an automation",
  "automation.updated": "Changed an automation",
  "automation.archived": "Archived an automation",
};

const VERBS: Record<string, string> = {
  create: "Created", created: "Created", update: "Changed", updated: "Changed", archive: "Archived", archived: "Archived",
  restore: "Restored", restored: "Restored", delete: "Deleted", deleted: "Deleted", merge: "Merged", merged: "Merged",
  create_record: "Created", update_record: "Changed", export: "Exported", import: "Imported", reveal: "Revealed",
};

const words = (s: string) => s.replace(/[._]+/g, " ").trim();

/** "deal.stage_changed" → "Moved a deal to another stage"; "update" on a contact → "Changed a contact"; anything else in plain words. */
export function actionLabel(code: string, object?: string | null): string {
  if (Object.hasOwn(KNOWN, code)) return KNOWN[code]!;
  const [head, verb] = code.includes(".") ? [code.slice(0, code.indexOf(".")), code.slice(code.indexOf(".") + 1)] : [null, code];
  if (Object.hasOwn(VERBS, verb)) {
    const what = head ?? object;
    return what ? `${VERBS[verb]} ${/^[aeiou]/.test(what) ? "an" : "a"} ${words(what)}` : VERBS[verb]!;
  }
  const text = words(code);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Who did it: a member's or service account's name when known, else a plain word (the ID shown beside it). */
export function actorLabel(actor: string, names: Map<string, string>, me: { id: string; name: string }): { name: string; known: boolean } {
  if (actor === me.id) return { name: `${me.name} (you)`, known: true };
  const n = names.get(actor);
  if (n) return { name: n, known: true };
  if (actor.startsWith("sa_") || actor.startsWith("svc_")) return { name: "A service account", known: false };
  if (actor === "system" || actor === "" ) return { name: "The system", known: true };
  return { name: "A member", known: false };
}
