import type { ApiClient } from "@/lib/api/client";
import type { ObjectMeta, Page } from "@/lib/api/types";
import { compileWhere, type Group } from "@/lib/filters";
import { canFilter, partFields } from "@/meta/fields";
import type { DuplicatesAnswer } from "./types";

/**
 * The checks on the Data health page. There is no engine behind them and nothing is stored: each one is
 * a request made when someone presses Run, and its answer lives on the page until it is left.
 */

/** Objects the checks look at, which must be described before the page can say which checks apply. */
export const CHECK_OBJECTS = ["contact", "account", "deal", "lead"] as const;
export type CheckObject = (typeof CHECK_OBJECTS)[number];

/** One count: how many records of an object match a filter, and the same filter as the list shows it. */
export interface CountSpec { object: string; label: string; filter: Group }
export type CountLine =
  | { object: string; label: string; filter: Group; count: number; capped: boolean }
  | { object: string; label: string; filter: Group; error: unknown };

export type CheckSpec =
  | { key: string; kind: "duplicates"; title: string; object: string; objectLabel: string; help: string }
  | { key: string; kind: "counts"; title: string; help: string; lines: CountSpec[] };

export type CheckResult =
  | { kind: "duplicates"; at: Date; answer: DuplicatesAnswer }
  | { kind: "counts"; at: Date; lines: CountLine[] };

const cond = (name: string, op: "eq" | "empty", value?: string): Group["children"][number] => ({ kind: "cond", path: [name], op, ...(value !== undefined ? { value } : {}) });
const all = (...children: Group["children"]): Group => ({ kind: "group", conj: "and", children });

/**
 * The checks that apply to this member and workspace: an object they can't read, or a field they can't
 * filter on (or that doesn't exist), drops its check instead of showing one that would fail.
 */
export function availableChecks(metas: Partial<Record<CheckObject, ObjectMeta>>): CheckSpec[] {
  const readable = (o: CheckObject) => (metas[o]?.access.read ? metas[o] : undefined);
  const has = (m: ObjectMeta | undefined, name: string) => Boolean(m?.fields.some((f) => f.name === name && canFilter(f)));
  const out: CheckSpec[] = [];
  const contact = readable("contact");
  const account = readable("account");
  if (contact) out.push({ key: "duplicates:contact", kind: "duplicates", title: "Possible duplicate contacts", object: "contact", objectLabel: contact.plural_label.toLowerCase(),
    help: "Contacts that share an email, or a name and an account." });
  if (account) out.push({ key: "duplicates:account", kind: "duplicates", title: "Possible duplicate accounts", object: "account", objectLabel: account.plural_label.toLowerCase(),
    help: "Accounts that share a domain or a company name." });
  const deal = readable("deal");
  if (has(deal, "status") && has(deal, "expected_close_date")) {
    out.push({ key: "deals-no-close-date", kind: "counts", title: "Open deals without an expected close date", help: "Open deals saved without a close date.",
      lines: [{ object: "deal", label: deal!.plural_label, filter: all(cond("status", "eq", "open"), cond("expected_close_date", "empty")) }] });
  }
  const owned = CHECK_OBJECTS.map(readable).filter((m): m is ObjectMeta => Boolean(m?.owned) && has(m, "owner"));
  if (owned.length) {
    out.push({ key: "no-owner", kind: "counts", title: "Records without an owner", help: "Records nobody owns, by object.",
      lines: owned.map((m) => ({ object: m.name, label: m.plural_label, filter: all(cond("owner", "empty")) })) });
  }
  if (has(contact, "email")) {
    out.push({ key: "contacts-no-email", kind: "counts", title: "Contacts without an email", help: "Contacts with no email address.",
      lines: [{ object: "contact", label: contact!.plural_label, filter: all(cond("email", "empty")) }] });
  }
  return out;
}

/** The POST /v1/objects/{object}/duplicates request: the object's default rules, the server's default limit. */
export async function runDuplicates(api: ApiClient, object: string, signal?: AbortSignal): Promise<CheckResult> {
  const answer = await api.request<DuplicatesAnswer>("POST", `/v1/objects/${encodeURIComponent(object)}/duplicates`, { body: {}, signal });
  return { kind: "duplicates", at: new Date(), answer };
}

/** One count through POST /v1/query: a page of one record, counted (capped by the server at 10,000). */
async function countOne(api: ApiClient, spec: CountSpec, meta: ObjectMeta | undefined, signal?: AbortSignal): Promise<CountLine> {
  try {
    const where = compileWhere(spec.filter, meta ? partFields(meta) : undefined);
    const page = await api.request<Page>("POST", "/v1/query", { body: { object: spec.object, ...(where ? { where } : {}), limit: 1, count: true, fields: ["display_name"] }, signal });
    return { ...spec, count: page.total ?? 0, capped: Boolean(page.total_capped) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...spec, error };
  }
}

export async function runCounts(api: ApiClient, lines: CountSpec[], metas: Partial<Record<string, ObjectMeta>>, signal?: AbortSignal): Promise<CheckResult> {
  // One after another: counting is heavy work, and a few lines are not worth a burst of it.
  const out: CountLine[] = [];
  for (const spec of lines) out.push(await countOne(api, spec, metas[spec.object], signal));
  return { kind: "counts", at: new Date(), lines: out };
}
