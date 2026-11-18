import type { Tx } from "../db/pool.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { canObject, fieldAccess } from "./access.js";
import type { Ctx } from "./context.js";
import {
  activeUsersPage, deletePreference, lockPreferences, preferencesOf, preferencesTotalBytes, preferenceValueSizes, upsertPreference,
} from "./queries/directory.js";
import { escapeLike, UUID } from "./query.js";
import { isModuleOn, loadSchema } from "./schema.js";

// ----------------------------------------------------------------------------------------------
// Member directory

export const DIRECTORY_LIMITS = { defaultPage: 100, maxPage: 500 } as const;

/**
 * Active users for owner and assignee pickers: ID, name and email, the same as describe_object lists
 * under `users`. Roles, sign-in facts, service accounts and disabled users are never listed. A user is
 * what an owner-like field holds, so the directory is for callers who can read at least one field that
 * refers to users (owner, assignee, …); a role that hides all of them gets 403.
 */
export async function listUsers(tx: Tx, ctx: Ctx, opts: { q?: string; limit?: number; cursor?: string } = {}) {
  const schema = await loadSchema(tx);
  const readsUsers = [...schema.objects.values()].some((o) => isModuleOn(schema, o) && canObject(ctx, o, "read")
    && o.fields.some((f) => f.type === "relation" && f.options.to === "user" && fieldAccess(ctx, o, f) !== "none"));
  if (!readsUsers) throw forbidden("This key can't read any field that refers to users (such as owner), so it can't list them");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw unprocessable("limit must be a positive whole number");
  const limit = Math.min(opts.limit ?? DIRECTORY_LIMITS.defaultPage, DIRECTORY_LIMITS.maxPage);
  const q = opts.q?.trim().toLowerCase() ?? "";
  if (q.length > 200) throw unprocessable("q is too long");
  let after: { n: string; id: string } | null = null;
  if (opts.cursor !== undefined) {
    try {
      after = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")) as { n: string; id: string };
    } catch {
      after = null;
    }
    if (!after || typeof after.n !== "string" || after.n.length > 1000 || typeof after.id !== "string" || !UUID.test(after.id)) {
      throw unprocessable("Invalid cursor; start again without one");
    }
  }
  const like = `${escapeLike(q)}%`;
  const rows = await activeUsersPage(tx, { q, like, wordLike: `% ${escapeLike(q)}%`, after, take: limit + 1 });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((u) => ({ id: encodeId("usr", u.id), name: u.name, email: u.email })),
    next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ n: last.name, id: last.id })).toString("base64url") : null,
  };
}

// ----------------------------------------------------------------------------------------------
// Preferences

export const PREFERENCE_LIMITS = { keys: 100, valueBytes: 8_192, totalBytes: 65_536 } as const;
const KEY = /^[a-z][a-z0-9_.:-]{0,63}$/;
const API_KEY = /hlcrm_(live|test)_/;

const member = (ctx: Ctx) => {
  if ((ctx.actor.type !== "user" && ctx.actor.type !== "service_account") || !ctx.actor.id) throw unprocessable("Preferences need a key that belongs to a member");
  return { type: ctx.actor.type, id: ctx.actor.id };
};

/** The caller's own preferences: UI state such as column widths or the last view opened. Never for secrets. */
export async function getPreferences(tx: Tx, ctx: Ctx): Promise<Record<string, unknown>> {
  const m = member(ctx);
  const rows = await preferencesOf(tx, m.type, m.id);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Sets the keys given (null removes one) and returns them all. Keys, sizes and the key count are capped. */
export async function setPreferences(tx: Tx, ctx: Ctx, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const m = member(ctx);
  const entries = Object.entries(input);
  if (entries.length > PREFERENCE_LIMITS.keys) throw unprocessable(`At most ${PREFERENCE_LIMITS.keys} preferences`);
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw unprocessable(`"${k.slice(0, 80)}" is not a valid preference key: lowercase letters, digits and _ . : -, starting with a letter, at most 64 characters`);
    if (v !== null && API_KEY.test(JSON.stringify(v))) throw unprocessable(`Preference "${k}" looks like it holds an API key; preferences are not for secrets`);
  }
  // Sizes as the database CHECK measures them (each value's jsonb text, longer than JSON.stringify), so too big is a 422, not a 500.
  const set = entries.filter(([, v]) => v !== null);
  const sizes = set.length === 0 ? [] : await preferenceValueSizes(tx, set.map(([, v]) => v));
  sizes.forEach((r, i) => {
    if (r.n > PREFERENCE_LIMITS.valueBytes) throw unprocessable(`Preference "${set[i]![0]}" is larger than ${PREFERENCE_LIMITS.valueBytes} bytes`);
  });
  // Serialises this member's writes, so the caps hold under concurrent requests.
  await lockPreferences(tx, ctx.tenantId, m.type, m.id);
  for (const [k, v] of entries) {
    if (v === null) await deletePreference(tx, m.type, m.id, k);
    else await upsertPreference(tx, { tenantId: ctx.tenantId, type: m.type, id: m.id, key: k, value: v });
  }
  const all = await getPreferences(tx, ctx);
  if (Object.keys(all).length > PREFERENCE_LIMITS.keys) throw unprocessable(`At most ${PREFERENCE_LIMITS.keys} preferences; remove some (set them to null) first`);
  if ((await preferencesTotalBytes(tx, m.type, m.id)) > PREFERENCE_LIMITS.totalBytes) throw unprocessable(`Preferences can hold at most ${PREFERENCE_LIMITS.totalBytes} bytes in all`);
  return all;
}
