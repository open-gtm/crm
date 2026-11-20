import { config, publicOrigin } from "../config.js";
import { audit } from "../core/audit.js";
import type { SignInMethod } from "../core/context.js";
import { db, type Tx } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { safeEqual } from "../lib/crypto.js";
import { ApiError, ConfigError, unprocessable } from "../lib/errors.js";
import { decodeId, uuidv7 } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { getMailer } from "../providers/mailer.js";
import { webUi } from "../web/static.js";
import { activeMemberships, lookupIdentity, type Candidate, type Membership } from "./identity.js";
import { LIMITS, emailKey, hit } from "./limits.js";
import { dummyVerify, hashPassword, verifyPassword } from "./passwords.js";
import {
  allowFlowPrune, clearPasswordFailures, consumeChoiceFlow, consumeEmailFlows, consumeEmailFlowsOfBrowser, consumeServerLinkFlow, countPasswordAttempt,
  deleteExpiredFlows, emailFlowByLinkForUpdate, emailFlowsForUpdate, insertSignInFlow, latestChoiceFlow, narrowToFlows, recordWrongCode,
  replacePasswordHash, setFlowCandidates, type FlowRow,
} from "./queries.js";
import { createSession, webCtx, type ClientMeta } from "./sessions.js";
import { CODE_PATTERN, codeHash, isToken, newCode, newToken, tokenHash } from "./tokens.js";

/**
 * Sign-in flows (ADR 0009). Every method ends in completeSignIn: one matching membership starts a
 * session; several start a short workspace-choice step bound to the browser; none fails the same
 * way whatever the reason. Responses never say whether an email belongs to anyone.
 *
 * Flows live in `sign_in_flows`, found only by the hash of the pre-session cookie (browser-bound
 * flows) or of a link token (server-printed links). Each is single-use: completing one marks it
 * consumed in the same statement that checks it isn't.
 */

export const FLOW_MINUTES = { email: 10, oidc: 10, choose: 5, server_link: 15 } as const;
export const CODE_ATTEMPTS = 5;
/** At most this many differently spelled stored addresses get a sign-in email for one request (each its own code and link). */
export const MAX_SPELLINGS = 3;
export const DEFAULT_RETURN_TO = "/auth/signed-in";
/** Long enough for an OAuth authorization request (client ID URL, redirect URI, state, PKCE challenge, resource) to come back after sign-in. */
export const MAX_RETURN_TO = 2048;
/** Where a sign-in with no (or no usable) return_to lands: the web UI when this process serves it, else the built-in signed-in page. */
const defaultReturnTo = () => (webUi() ? "/" : DEFAULT_RETURN_TO);

export type SignInResult =
  | { status: "signed_in"; workspace: { id: string; name: string }; returnTo: string;
      session: { id: string; token: string; expiresAt: Date; idleExpiresAt: Date; csrfToken: string } }
  | { status: "choose_workspace"; browserToken: string; workspaces: { id: string; name: string }[]; returnTo: string; more: boolean };

const SIGN_IN_FAILED = "Those details didn't match an account that can sign in here";
export const failed = (message = SIGN_IN_FAILED) => new ApiError(401, "sign_in_failed", message);
export const expired = () => new ApiError(400, "expired", "This sign-in step has expired or was already used; start again");
export const unavailable = (what: string) => new ApiError(404, "unavailable", `${what} is not available on this server`);
export const rateLimited = (seconds: number) => new ApiError(429, "rate_limited", "Too many sign-in attempts; wait and retry", { retry_after: seconds });

function limit(l: Parameters<typeof hit>[0], key: string): void {
  const wait = hit(l, key);
  if (wait !== null) throw rateLimited(wait);
}
export const limitAddress = (meta: ClientMeta) => limit(LIMITS.address, meta.address ?? "unknown");

// --- Background work -------------------------------------------------------------------------------

const pending = new Set<Promise<void>>();
/**
 * Runs `fn` after the response: finding the email's memberships and sending mail happen here, so an
 * email that belongs to someone takes as long to answer as one that doesn't.
 */
function background(what: string, fn: () => Promise<void>): void {
  const p: Promise<void> = fn().catch((e: Error) => logger.error({ job: what, err: e.message }, "sign-in background task failed"))
    .finally(() => pending.delete(p));
  pending.add(p);
}
/** For tests and shutdown: waits for sign-in emails being prepared or sent. */
export async function settleSignInTasks(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

// --- Flows -----------------------------------------------------------------------------------------

/** A transaction that can see only the flows of this browser cookie and/or link token (the flow_lookup policy). */
export function withFlows<T>(keys: { browser?: string | null; link?: string | null }, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const hex = (t?: string | null) => (t && isToken(t) ? tokenHash(t).toString("hex") : "");
  return db().begin(async (tx) => {
    await narrowToFlows(tx, hex(keys.browser), hex(keys.link));
    return fn(tx);
  }) as Promise<T>;
}

const live = (f: FlowRow | undefined): f is FlowRow => Boolean(f && !f.consumed_at && f.expires_at.getTime() > Date.now());

async function insertFlow(tx: Tx, f: { purpose: FlowRow["purpose"]; browser?: string | null; link?: string | null; codeHash?: Buffer | null;
  candidates?: Candidate[]; method?: SignInMethod | null; returnTo?: string | null; more?: boolean; minutes: number; id?: string }): Promise<string> {
  const id = f.id ?? uuidv7();
  await insertSignInFlow(tx, { id, browserHash: f.browser ? tokenHash(f.browser) : null, linkHash: f.link ? tokenHash(f.link) : null, purpose: f.purpose,
    codeHash: f.codeHash ?? null, candidates: f.candidates ?? [], method: f.method ?? null, returnTo: f.returnTo ?? null, more: f.more ?? false, minutes: f.minutes });
  return id;
}

const controlChar = (p: string) => [...p].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
/** A path on this origin: one leading slash, no `//` in the path, no backslash, no control character. */
const localPath = (p: string) => p.startsWith("/") && !p.split(/[?#]/, 1)[0]!.includes("//") && !p.includes("\\") && !controlChar(p);
/** A path segment that resolves to "." or "..", spelled out or percent-encoded (`/.//host` would otherwise normalise to `//host`). */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Where to go after signing in: a path on this origin only. The value is checked before and after
 * the URL parser normalises it, and dot segments are refused outright, so nothing that becomes
 * `//host` or another origin gets through; anything doubtful falls back to the signed-in page.
 */
export function safeReturnTo(raw: unknown): string {
  const pub = publicOrigin();
  if (typeof raw !== "string" || !pub || raw.length > MAX_RETURN_TO || !localPath(raw) || raw.split(/[?#]/, 1)[0]!.split("/").some((s) => DOT_SEGMENT.test(s))) {
    return defaultReturnTo();
  }
  try {
    const u = new URL(raw, pub.origin);
    const out = `${u.pathname}${u.search}${u.hash}`;
    return u.origin === pub.origin && localPath(out) && new URL(out, pub.origin).origin === pub.origin ? out : defaultReturnTo();
  } catch {
    return defaultReturnTo();
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
/** The email as typed, trimmed. Lookups match its canonical form (identity.ts); a message goes to each matching address as stored. */
function typedEmail(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 254 || !EMAIL.test(raw.trim())) throw unprocessable("Enter a valid email address");
  return raw.trim();
}

/** The workspace a person named (`ws_…`) to look in only that one, or null. About the input, not any account, so a bad value is a plain 422. */
export function namedWorkspace(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const d = typeof raw === "string" ? decodeId(raw.trim()) : null;
  if (d?.prefix !== "ws") throw unprocessable("workspace must be a workspace ID (ws_…)");
  return d.uuid;
}

/** Writes an auth event into a member's workspace. Failures are recorded by the system against the member, never as the member. */
async function auditMember(m: { tenantId: string; userId: string }, action: string, details: Record<string, unknown>, meta: ClientMeta): Promise<void> {
  await withTenant(m.tenantId, (tx) => audit(tx, webCtx(m.tenantId, null, "system", meta), { action, objectType: "user", recordId: m.userId, details }));
}

// --- Completing a sign-in --------------------------------------------------------------------------

/**
 * Ends every method: re-reads which candidates may still sign in, then starts a session (one) or a
 * workspace choice bound to a new pre-session cookie (several). The choice lists workspace names only.
 * `more` (the identity matched more memberships than are looked up) always shows the choice, which
 * then says how to name the workspace, rather than signing in to one of those found without a word.
 */
export async function completeSignIn(candidates: Candidate[] | Membership[], method: SignInMethod, returnTo: string | null, meta: ClientMeta,
  more = false): Promise<SignInResult> {
  const members = await activeMemberships(candidates.map((c) => ("tenantId" in c ? { t: c.tenantId, u: c.userId } : c)));
  const to = safeReturnTo(returnTo);
  if (members.length === 0 && !more) throw failed();
  if (members.length === 1 && !more) {
    const m = members[0]!;
    const session = await withTenant(m.tenantId, (tx) => createSession(tx, m, method, meta));
    return { status: "signed_in", workspace: m.workspace, returnTo: to, session };
  }
  const browserToken = newToken();
  await withFlows({ browser: browserToken }, (tx) => insertFlow(tx, { purpose: "choose", browser: browserToken, method, returnTo: to, more,
    candidates: members.map((m) => ({ t: m.tenantId, u: m.userId })), minutes: FLOW_MINUTES.choose }));
  return { status: "choose_workspace", browserToken, returnTo: to, workspaces: members.map((m) => m.workspace), more };
}

/** The workspaces a pending choice offers (names only), or null when there is no live choice for this browser. */
export async function pendingChoice(browserToken: string | null): Promise<{ workspaces: { id: string; name: string }[]; more: boolean } | null> {
  if (!isToken(browserToken)) return null;
  const f = await withFlows({ browser: browserToken }, latestChoiceFlow);
  if (!live(f)) return null;
  return { workspaces: (await activeMemberships(f.candidates)).map((m) => m.workspace), more: f.more_workspaces };
}

/** Finishes a workspace choice. Single-use; the chosen workspace must be one the choice offered and the member still active there. */
export async function chooseWorkspace(browserToken: string | null, workspace: unknown, meta: ClientMeta): Promise<SignInResult> {
  limitAddress(meta);
  if (!isToken(browserToken)) throw expired();
  const d = typeof workspace === "string" ? decodeId(workspace) : null;
  const f = await withFlows({ browser: browserToken }, consumeChoiceFlow);
  if (!f) throw expired();
  const pick = d?.prefix === "ws" ? f.candidates.filter((c) => c.t === d.uuid) : [];
  if (pick.length !== 1) throw failed("Pick one of the workspaces offered");
  return completeSignIn(pick, f.method ?? "email_code", f.return_to, meta);
}

// --- Email code and link ---------------------------------------------------------------------------

/**
 * Starts an email sign-in. Always answers the same way: a new pre-session cookie and "if this email
 * belongs to a member, a code is on its way". The membership lookup and the email happen afterwards.
 * `workspace` (optional, `ws_…`) looks in that workspace only.
 */
export async function startEmailSignIn(rawEmail: unknown, returnTo: unknown, meta: ClientMeta, rawWorkspace?: unknown): Promise<{ browserToken: string }> {
  if (!getMailer().enabled) throw unavailable("Email sign-in");
  const email = typedEmail(rawEmail);
  const tenant = namedWorkspace(rawWorkspace);
  limitAddress(meta);
  limit(LIMITS.emailBurst, `${emailKey(email)}:${meta.address ?? "unknown"}`);
  limit(LIMITS.emailDay, emailKey(email));
  const browserToken = newToken();
  const first = { id: uuidv7(), code: newCode(), link: newToken() };
  const to = safeReturnTo(returnTo);
  await withFlows({ browser: browserToken }, (tx) => insertFlow(tx, { id: first.id, purpose: "email", browser: browserToken, link: first.link,
    codeHash: codeHash(first.id, first.code), returnTo: to, minutes: FLOW_MINUTES.email }));
  background("sign-in email", () => deliverEmailCodes(browserToken, first, email, tenant, to, meta));
  return { browserToken };
}

/**
 * Sends the sign-in emails for one request. A code or link proves control of the address it was sent
 * to and nothing else, so there is one message per address exactly as stored (the typed spelling
 * first, at most MAX_SPELLINGS), each with its own flow, code and link, and each signs in only the
 * memberships stored with exactly that address. A workspace whose member was sent nothing sees nothing.
 */
async function deliverEmailCodes(browserToken: string, first: { id: string; code: string; link: string }, typed: string, tenant: string | null,
  returnTo: string, meta: ClientMeta): Promise<void> {
  const found = await lookupIdentity("email", typed, tenant);
  const members = await activeMemberships(found.candidates);
  const byAddress = new Map<string, Membership[]>();
  for (const m of [...members].sort((a, b) => Number(b.email === typed) - Number(a.email === typed))) byAddress.set(m.email, [...(byAddress.get(m.email) ?? []), m]);
  if (byAddress.size > MAX_SPELLINGS) {
    logger.warn({ event: "sign_in_email_spellings", addresses: byAddress.size }, `sign-in email sent to the first ${MAX_SPELLINGS} differently spelled addresses only`);
  }
  let used = false;
  for (const [address, group] of [...byAddress].slice(0, MAX_SPELLINGS)) {
    // A message that isn't sent gets no flow either: nothing can sign in through it, and nobody is audited for it.
    if (!signInMailBudget(group)) continue;
    const flow = used ? { id: uuidv7(), code: newCode(), link: newToken() } : first;
    const candidates = group.map((m) => ({ t: m.tenantId, u: m.userId }));
    await withFlows({ browser: browserToken }, async (tx) => {
      if (flow === first) await setFlowCandidates(tx, first.id, candidates, found.more);
      else await insertFlow(tx, { id: flow.id, purpose: "email", browser: browserToken, link: flow.link, codeHash: codeHash(flow.id, flow.code), candidates,
        returnTo, more: found.more, minutes: FLOW_MINUTES.email });
    });
    used = true;
    await getMailer().send({ to: address, subject: "Your sign-in code", text: codeEmail(flow.code, flow.link) });
    for (const m of group) await auditMember(m, "auth.code_sent", { method: "email_code" }, meta);
  }
}

function codeEmail(code: string, link: string): string {
  return [
    `Your sign-in code is ${code.slice(0, 4)} ${code.slice(4)}`,
    "",
    "Type it on the sign-in page, or open this link in the same browser:",
    `${publicOrigin()!.origin}/auth/email-link?token=${link}`,
    "",
    `The code and the link work once, for ${FLOW_MINUTES.email} minutes.`,
    "If you didn't ask to sign in, ignore this email: nobody can use the code without the browser that asked for it.",
  ].join("\n");
}

/**
 * Whether a sign-in email may go out: room in the budget of at least one workspace it is for, then in
 * the server-wide ceiling, which is far above any one workspace's share. Either way, a skipped send is
 * logged and never reported to the requester.
 */
function signInMailBudget(group: Membership[]): boolean {
  if (![...new Set(group.map((m) => m.tenantId))].some((t) => hit(LIMITS.workspaceEmail, t) === null)) {
    logger.warn({ event: "sign_in_email_limited", scope: "workspace" }, "sign-in email skipped: its workspace's sending limit was reached");
    return false;
  }
  if (hit(LIMITS.globalEmail, "all") !== null) {
    logger.error({ event: "sign_in_email_limited", scope: "server" }, "sign-in email skipped: the server-wide sending limit was reached, far above normal use; look for abuse");
    return false;
  }
  return true;
}

/**
 * Checks a typed code against this browser's email flows (one per address a message went to). Five
 * wrong codes void them all; the right one signs in only the memberships of the address it was sent to.
 */
export async function verifyEmailCode(browserToken: string | null, rawCode: unknown, meta: ClientMeta): Promise<SignInResult> {
  limitAddress(meta);
  if (!isToken(browserToken)) throw expired();
  const code = typeof rawCode === "string" ? rawCode.replace(/[\s-]/g, "") : "";
  const r = await withFlows({ browser: browserToken }, async (tx) => {
    const flows = (await emailFlowsForUpdate(tx)).filter((f) => live(f) && f.attempts < CODE_ATTEMPTS);
    if (flows.length === 0) return { kind: "expired" as const };
    const f = CODE_PATTERN.test(code) ? flows.find((x) => x.code_hash && safeEqual(codeHash(x.id, code), x.code_hash)) : undefined;
    if (!f) {
      const attempts = Math.max(...flows.map((x) => x.attempts)) + 1;
      await recordWrongCode(tx, attempts, attempts >= CODE_ATTEMPTS ? new Date() : null);
      return { kind: "wrong" as const, left: CODE_ATTEMPTS - attempts, candidates: flows.flatMap((x) => x.candidates) };
    }
    // This browser's sign-in step is used up, for every message it asked for.
    await consumeEmailFlows(tx);
    return { kind: "ok" as const, f };
  });
  if (r.kind === "expired") throw expired();
  if (r.kind === "wrong") {
    // After the response, so a wrong code for a member takes as long as one for nobody.
    background("sign-in audit", async () => {
      for (const c of r.candidates) await auditMember({ tenantId: c.t, userId: c.u }, "auth.sign_in_failed", { method: "email_code", reason: "wrong_code" }, meta);
    });
    throw new ApiError(400, "invalid_code", r.left > 0 ? `That code is not right. ${r.left} attempt${r.left === 1 ? "" : "s"} left` : "That code is not right. Start again for a new one",
      { attempts_left: r.left });
  }
  return completeSignIn(r.f.candidates, "email_code", r.f.return_to, meta, r.f.more_workspaces);
}

/**
 * Uses the link from a sign-in email. It must be opened in the browser that asked for it (the
 * pre-session cookie): a link forwarded, intercepted or opened elsewhere does nothing. Typing the
 * code is the way to finish on a phone when the email is read on another device.
 */
export async function useEmailLink(browserToken: string | null, linkToken: unknown, meta: ClientMeta): Promise<SignInResult> {
  limitAddress(meta);
  if (!isToken(linkToken)) throw expired();
  const r = await withFlows({ browser: browserToken, link: linkToken }, async (tx) => {
    const f = await emailFlowByLinkForUpdate(tx, tokenHash(linkToken));
    if (!live(f) || f.attempts >= CODE_ATTEMPTS) return { kind: "expired" as const };
    if (!isToken(browserToken) || !f.browser_hash || !safeEqual(f.browser_hash, tokenHash(browserToken))) return { kind: "other_browser" as const, f };
    await consumeEmailFlowsOfBrowser(tx, f.browser_hash);
    return { kind: "ok" as const, f };
  });
  if (r.kind === "expired") throw expired();
  if (r.kind === "other_browser") {
    const candidates = r.f.candidates;
    background("sign-in audit", async () => {
      for (const c of candidates) await auditMember({ tenantId: c.t, userId: c.u }, "auth.sign_in_failed", { method: "email_link", reason: "other_browser" }, meta);
    });
    throw new ApiError(400, "other_browser", "Open the link in the browser where you asked for it, or type the code from the email there");
  }
  return completeSignIn(r.f.candidates, "email_link", r.f.return_to, meta, r.f.more_workspaces);
}

// --- Server-printed link ---------------------------------------------------------------------------

/**
 * A one-time sign-in link for an operator to hand to someone (the first owner, before email works).
 * Not bound to a browser, since it is delivered out of band, so it lives only FLOW_MINUTES.server_link.
 * The caller (the server CLI) prints only the link. `returnTo` is where the link lands once used: a
 * path on this origin under the same rule as every sign-in's return_to (safeReturnTo); one the rule
 * would change is refused rather than silently replaced, so a typo is noticed. With none, it lands in
 * the app (or the built-in signed-in page). Problems are ConfigErrors: the CLI prints them as one line.
 */
export async function createServerLink(rawEmail: string, workspace: string | undefined, requestId: string, returnTo?: string): Promise<{ url: string; expiresAt: Date; workspace: { id: string; name: string } }> {
  const pub = publicOrigin();
  if (!pub) throw new ConfigError("Set PUBLIC_URL first (the address people open the app at, e.g. https://crm.example.com): the link is built from it");
  let email: string;
  try {
    email = typedEmail(rawEmail);
  } catch {
    throw new ConfigError(`"${rawEmail}" is not an email address`);
  }
  const ws = workspace ? decodeId(workspace) : null;
  if (workspace && ws?.prefix !== "ws") throw new ConfigError("--workspace must be a workspace ID (ws_…)");
  if (returnTo !== undefined && safeReturnTo(returnTo) !== returnTo) {
    throw new ConfigError("--return-to must be a path on this server, starting with one / (for example /settings/api-keys)");
  }
  const found = await lookupIdentity("email", email, ws?.uuid);
  const members = await activeMemberships(found.candidates);
  if (members.length === 0) throw new ConfigError(`No active member with that email${ws ? " in that workspace" : ""}`);
  if (members.length > 1 || found.more) {
    throw new ConfigError(`That email is a member of several workspaces; pass --workspace with one of: ${members.map((m) => m.workspace.id).join(", ")}${found.more ? ", …" : ""}`);
  }
  const m = members[0]!;
  const link = newToken();
  await withFlows({ link }, (tx) => insertFlow(tx, { purpose: "server_link", link, candidates: [{ t: m.tenantId, u: m.userId }], method: "server_link",
    returnTo: returnTo ?? null, minutes: FLOW_MINUTES.server_link }));
  await withTenant(m.tenantId, (tx) => audit(tx, { ...webCtx(m.tenantId, null, "system", { requestId }), surface: "cli" },
    { action: "auth.sign_in_link_created", objectType: "user", recordId: m.userId, details: { expires_in_minutes: FLOW_MINUTES.server_link } }));
  return { url: `${pub.origin}/auth/link?token=${link}`, expiresAt: new Date(Date.now() + FLOW_MINUTES.server_link * 60_000), workspace: m.workspace };
}

/**
 * Uses a server-printed link. It works in a browser that is already signed in too (an operator's fresh
 * link is how someone without a password or email confirms it's them): the new session's cookie
 * replaces the old one, and the browser lands on the link's return_to, if it has one.
 */
export async function useServerLink(linkToken: unknown, meta: ClientMeta): Promise<SignInResult> {
  limitAddress(meta);
  if (!isToken(linkToken)) throw expired();
  const f = await withFlows({ link: linkToken }, (tx) => consumeServerLinkFlow(tx, tokenHash(linkToken)));
  if (!f) throw expired();
  return completeSignIn(f.candidates, "server_link", f.return_to, meta);
}

// --- Password --------------------------------------------------------------------------------------

/** Consecutive failures before password sign-in locks for that member; each further failure doubles the lock, up to an hour. */
export const LOCK_AFTER = 5;
const lockMinutes = (failures: number) => Math.min(2 ** (failures - LOCK_AFTER), 60);

/**
 * Password sign-in. The answer for a wrong password, an unknown or disabled email, a member without
 * a password, a workspace that turned passwords off and a locked account is the same, and costs at
 * least one hash. The lockout stops only password sign-in: the email code still works, so an
 * attacker can't keep a real member out. A password proves one membership: only those it matches sign in.
 */
export async function passwordSignIn(rawEmail: unknown, password: unknown, returnTo: unknown, meta: ClientMeta, rawWorkspace?: unknown): Promise<SignInResult> {
  if (!config().PASSWORD_SIGN_IN) throw unavailable("Password sign-in");
  const email = typedEmail(rawEmail);
  const tenant = namedWorkspace(rawWorkspace);
  limitAddress(meta);
  limit(LIMITS.password, `${emailKey(email)}:${meta.address ?? "unknown"}`);
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) throw failed();
  const found = await lookupIdentity("email", email, tenant);
  const eligible = (await activeMemberships(found.candidates)).filter((m) => m.passwordAllowed && m.passwordHash);
  if (eligible.length === 0) {
    await dummyVerify(password);
    throw failed();
  }
  const matched: Membership[] = [];
  for (const m of eligible) if ((await checkPassword(m, password, meta)) === "ok") matched.push(m);
  if (matched.length === 0) throw failed();
  return completeSignIn(matched, "password", safeReturnTo(returnTo), meta, found.more);
}

/**
 * Checks a member's password under the lockout, for sign-in and for "current password" on a change.
 * The attempt is counted before the hash is checked, and the one that reaches LOCK_AFTER locks at
 * once, so parallel guesses can't all land before the lock; the right password clears the count. A
 * locked member still costs one hash. Audits are written after the response, so a failure for a member
 * takes no longer than one for nobody. `rehash` stores a hash made with outdated parameters again.
 */
export async function checkPassword(m: { tenantId: string; userId: string }, password: string, meta: ClientMeta,
  opts: { reason?: string; rehash?: boolean } = {}): Promise<"ok" | "wrong" | "locked"> {
  const reason = opts.reason ?? "wrong_password";
  const slot = await withTenant(m.tenantId, (tx) => countPasswordAttempt(tx, m.userId, LOCK_AFTER));
  if (!slot) {
    await dummyVerify(password);
    background("password failure", () => auditMember(m, "auth.sign_in_failed", { method: "password", reason: "locked" }, meta));
    return "locked";
  }
  const v = password.length <= 1024 ? await verifyPassword(password, slot.hash) : { ok: false, rehash: false };
  if (v.ok) {
    await withTenant(m.tenantId, (tx) => clearPasswordFailures(tx, m.userId));
    if (v.rehash && opts.rehash !== false) await rehash(m, slot.hash, password);
    return "ok";
  }
  background("password failure", async () => {
    await auditMember(m, "auth.sign_in_failed", { method: "password", reason }, meta);
    if (slot.failures >= LOCK_AFTER) await auditMember(m, "auth.password_locked", { failures: slot.failures, minutes: lockMinutes(slot.failures) }, meta);
  });
  return "wrong";
}

async function rehash(m: { tenantId: string; userId: string }, previous: string, password: string): Promise<void> {
  const next = await hashPassword(password);
  // Only if nobody changed the password meanwhile.
  await withTenant(m.tenantId, (tx) => replacePasswordHash(tx, m.userId, next, previous));
}

// --- Invitations -----------------------------------------------------------------------------------

/** Why an invitation can't be sent from this server, or null. Checked before the member is added. */
export function invitationUnavailable(): string | null {
  if (!publicOrigin()) return "Invitations need PUBLIC_URL (the sign-in page's address)";
  if (!getMailer().enabled) return "Invitations need email (set SMTP_URL)";
  return null;
}

/**
 * Counts one invitation against its workspace's, its sender's and the server's invitation budgets,
 * which are separate from sign-in email, so invitations can never hold up anyone's sign-in code.
 * Past any of them, 429 (and the member isn't added: the caller's transaction rolls back).
 */
export function reserveInvitation(tenantId: string, senderId: string | null): void {
  // The sender's own allowance first, so someone past theirs doesn't use up the workspace's.
  for (const [l, key] of [[LIMITS.inviteMember, `${tenantId}:${senderId ?? "system"}`], [LIMITS.inviteWorkspace, tenantId], [LIMITS.inviteGlobal, "all"]] as const) {
    const wait = hit(l, key);
    if (wait !== null) {
      throw new ApiError(429, "rate_limited", "Too many invitations for now; wait, or add the member without send_invite", { retry_after: wait });
    }
  }
}

/**
 * A name someone else chose, made safe to put in an email: plain text with no control or format
 * characters, no link a mail program would make clickable (schemes are dropped, a dot inside a word
 * is shown as "[.]"), and at most `max` characters.
 */
export function plainName(raw: string, max = 80): string {
  const text = raw.normalize("NFKC").replace(/\p{C}+/gu, " ").replace(/[a-z][a-z0-9+.-]*:\/\//gi, "")
    .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, "[.]").replace(/\s+/g, " ").trim();
  return [...text].slice(0, max).join("");
}

/**
 * Tells a new member where to sign in. The email carries no credential: they ask for a code on the
 * sign-in page like everyone else, so a forwarded or intercepted invitation gives nobody access. The
 * workspace's and inviter's names are someone else's text, so they go in as plainName.
 */
export async function sendInvitation(to: string, workspaceName: string, invitedBy: string | null): Promise<void> {
  const origin = publicOrigin()!.origin;
  const workspace = plainName(workspaceName) || "a workspace";
  const by = invitedBy ? plainName(invitedBy, 60) : "";
  await getMailer().send({
    to,
    subject: `You've been added to ${workspace}`,
    text: [
      `${by ? `${by} added you` : "You were added"} to the workspace "${workspace}".`,
      "",
      "Sign in with this email address here (you'll get a one-time code):",
      `${origin}/auth/sign-in`,
      "",
      "If you didn't expect this, you can ignore it.",
    ].join("\n"),
  });
}

/** Deletes sign-in steps that have expired. The flow_lookup policy lets this see expired rows only. */
export async function pruneSignInFlows(): Promise<number> {
  return db().begin(async (tx) => {
    await allowFlowPrune(tx);
    return deleteExpiredFlows(tx);
  }) as Promise<number>;
}
