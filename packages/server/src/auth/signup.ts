import { publicOrigin, signUpSettings } from "../config.js";
import { OWNER_ROLE } from "../core/context.js";
import { createWorkspaceIn } from "../core/workspace.js";
import { hmac, safeEqual } from "../lib/crypto.js";
import { ApiError, unprocessable } from "../lib/errors.js";
import { uuidv7 } from "../lib/ids.js";
import { TEXT_MAX } from "../lib/limits.js";
import { logger } from "../lib/logger.js";
import { getMailer } from "../providers/mailer.js";
import { activeMemberships, canonicalEmail, lookupIdentity, memberEmailProblem } from "./identity.js";
import { LIMITS, emailKey, hit } from "./limits.js";
import {
  consumeSignUpFlows, countSignUpsAlone, insertSignUpFlow, insertWorkspaceSignUp, recordWrongSignUpCode, signUpCounts, signUpFlowsForUpdate, verifiedSignUpFlow,
} from "./queries.js";
import { createSession, type ClientMeta } from "./sessions.js";
import { CODE_ATTEMPTS, addressOf, background, expired, limit, limitAddress, live, safeReturnTo, unavailable, withFlows, type SignInResult } from "./signin.js";
import { CODE_PATTERN, codeHash, isToken, newCode, newToken, serverKey, tokenHash } from "./tokens.js";

/**
 * Self sign-up (ADR 0018): a person proves an email address with an emailed code, names a workspace,
 * and is signed in as its owner. Off unless the operator set SIGN_UP=true. It is the one path where
 * someone unknown to the server creates lasting state and has mail sent to an address nobody vouched
 * for, so every step is limited, and nothing is created before the address is proven.
 *
 *   1. startSignUp        a code goes to the address. The answer, and the email, are the same whether
 *                         or not the address already belongs to a member anywhere.
 *   2. verifySignUpCode   the code, in the browser that asked. The proven address gets a new
 *                         pre-session cookie and a few minutes to name its workspace.
 *   3. createFromSignUp   the caps are counted and the workspace, its owner and their session are
 *                         created in one transaction, or nothing is.
 *
 * `return_to` rides along from the first step to the last, so someone who arrived from an app's
 * connection request (OAuth for MCP) lands back on its consent page as the new workspace's owner.
 */

export const SIGN_UP_MINUTES = { code: 10, workspace: 30 } as const;

const HOUR = 60 * 60_000;

/** The settings when sign-up can run on this server now (turned on, and email works), else null. */
export function signUpOpen(): NonNullable<ReturnType<typeof signUpSettings>> | null {
  const s = signUpSettings();
  return s && getMailer().enabled ? s : null;
}

function settings() {
  const s = signUpOpen();
  if (!s) throw unavailable("Creating a workspace");
  return s;
}

/** HMACs of the email and of the client address, under a server key: what the caps are counted by, so the table never holds either. */
const keyOf = (what: "email" | "address", value: string): Buffer => Buffer.from(hmac(serverKey("sign_up"), `${what}:${value}`), "base64url");

/**
 * The address a workspace would be created for: it becomes the owner's, so it must be one a member can
 * hold (printable ASCII), and at a domain this server lets sign up. Both are about what was typed, never
 * about any account, so they are answered plainly.
 */
function signUpEmail(raw: unknown, domains: string[]): string {
  const email = typeof raw === "string" ? raw.trim() : raw;
  const problem = memberEmailProblem(email);
  if (problem) throw unprocessable("Enter a valid email address");
  const domain = canonicalEmail(email as string).split("@").pop()!;
  if (domains.length && !domains.includes(domain)) {
    throw new ApiError(403, "sign_up_domain", "This server only lets addresses at its own domains create a workspace");
  }
  return email as string;
}

let emailAlarmUntil = 0;
let ceilingAlarmUntil = 0;

/**
 * Starts a sign-up. Always answers the same way: a new pre-session cookie, and a code on its way to
 * the address. Nothing is looked up, so the answer can't depend on whether the address belongs to
 * anyone; the email is sent after the response, like sign-in's.
 */
export async function startSignUp(rawEmail: unknown, returnTo: unknown, meta: ClientMeta): Promise<{ browserToken: string }> {
  const s = settings();
  const email = signUpEmail(rawEmail, s.domains);
  limitAddress(meta);
  limit(LIMITS.signUpAddress, addressOf(meta));
  // The same per-email allowances as a sign-in code: an inbox gets no more mail for having two forms that send to it.
  limit(LIMITS.emailBurst, `${emailKey(email)}:${addressOf(meta)}`);
  limit(LIMITS.emailDay, emailKey(email));
  const browserToken = newToken();
  const id = uuidv7();
  const code = newCode();
  await withFlows({ browser: browserToken }, (tx) => insertSignUpFlow(tx, { id, browserHash: tokenHash(browserToken), purpose: "sign_up", codeHash: codeHash(id, code),
    email, returnTo: typeof returnTo === "string" && returnTo ? safeReturnTo(returnTo) : null, minutes: SIGN_UP_MINUTES.code }));
  background("sign-up email", async () => {
    if (hit({ name: "sumail", max: s.emailsPerHour, windowMs: HOUR }, "all") !== null) {
      if (Date.now() > emailAlarmUntil) {
        emailAlarmUntil = Date.now() + HOUR;
        logger.error({ event: "sign_up_email_limited" }, "sign-up email skipped: the server-wide limit (SIGN_UP_EMAILS_PER_HOUR) was reached; look for abuse");
      }
      return;
    }
    await getMailer().send({ to: email, subject: "Your code to create a workspace", text: signUpEmailText(code) });
  });
  return { browserToken };
}

function signUpEmailText(code: string): string {
  return [
    `Your code is ${code.slice(0, 4)} ${code.slice(4)}`,
    "",
    "Type it on the page where you asked to create a workspace. It works once, for "
      + `${SIGN_UP_MINUTES.code} minutes, in the browser that asked for it.`,
    "",
    "Already have an account? You don't need this code: sign in here instead.",
    `${publicOrigin()!.origin}/auth/sign-in`,
    "",
    "If you didn't ask for this, ignore this email: nobody can use the code without the browser that asked for it, and nothing was created.",
  ].join("\n");
}

/**
 * Checks a typed code against this browser's sign-up codes. Five wrong codes void them. The right one
 * uses them up and starts the next step under a new pre-session cookie: the address is proven, and has
 * SIGN_UP_MINUTES.workspace to name its workspace. Nothing is created yet.
 */
export async function verifySignUpCode(browserToken: string | null, rawCode: unknown, meta: ClientMeta): Promise<{ browserToken: string }> {
  settings();
  limitAddress(meta);
  if (!isToken(browserToken)) throw expired();
  const code = typeof rawCode === "string" ? rawCode.replace(/[\s-]/g, "") : "";
  const r = await withFlows({ browser: browserToken }, async (tx) => {
    const flows = (await signUpFlowsForUpdate(tx)).filter((f) => live(f) && f.attempts < CODE_ATTEMPTS);
    if (flows.length === 0) return { kind: "expired" as const };
    const f = CODE_PATTERN.test(code) ? flows.find((x) => x.code_hash && safeEqual(codeHash(x.id, code), x.code_hash)) : undefined;
    if (!f) {
      const attempts = Math.max(...flows.map((x) => x.attempts)) + 1;
      await recordWrongSignUpCode(tx, attempts, attempts >= CODE_ATTEMPTS ? new Date() : null);
      return { kind: "wrong" as const, left: CODE_ATTEMPTS - attempts };
    }
    await consumeSignUpFlows(tx, "sign_up");
    return { kind: "ok" as const, f };
  });
  if (r.kind === "expired") throw expired();
  if (r.kind === "wrong") {
    throw new ApiError(400, "invalid_code", r.left > 0 ? `That code is not right. ${r.left} attempt${r.left === 1 ? "" : "s"} left` : "That code is not right. Start again for a new one",
      { attempts_left: r.left });
  }
  const next = newToken();
  await withFlows({ browser: next }, (tx) => insertSignUpFlow(tx, { id: uuidv7(), browserHash: tokenHash(next), purpose: "sign_up_verified", codeHash: null,
    email: r.f.email!, returnTo: r.f.return_to, minutes: SIGN_UP_MINUTES.workspace }));
  return { browserToken: next };
}

/**
 * What the page that names the workspace shows: the proven address, and the names of the workspaces it
 * already belongs to (it proved the address, so it may see them, as the workspace choice does), in case
 * the person meant to sign in. Null when this browser has no live proven step.
 */
export async function pendingSignUp(browserToken: string | null): Promise<{ email: string; returnTo: string | null; workspaces: string[] } | null> {
  if (!signUpOpen() || !isToken(browserToken)) return null;
  const f = await withFlows({ browser: browserToken }, (tx) => verifiedSignUpFlow(tx));
  if (!live(f) || !f.email) return null;
  const found = await lookupIdentity("email", f.email);
  return { email: f.email, returnTo: f.return_to, workspaces: (await activeMemberships(found.candidates)).map((m) => m.workspace.name) };
}

export interface NewWorkspaceInput { workspace_name?: unknown; name?: unknown; currency?: unknown }

/** A name a person typed: trimmed, one line, with something in it and no control characters. */
function typedName(raw: unknown, what: string, max: number, fallback?: string): string {
  const v = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!v && fallback !== undefined) return fallback;
  if (!v) throw unprocessable(`${what} is required`);
  if ([...v].length > max) throw unprocessable(`${what} can be at most ${max} characters`);
  if (/\p{Cc}/u.test(v)) throw unprocessable(`${what} can't contain control characters`);
  return v;
}

const limitedNow = () => new ApiError(429, "sign_up_limited", "A workspace can't be created right now; try again later", { retry_after: 3600 });

/**
 * Creates the workspace for a proven address and signs its owner in, in one transaction: the caps are
 * counted while no other sign-up can run, then the step is used up, the workspace made (with no API
 * keys: there is nowhere safe to show one here), the sign-up recorded and the session started. A
 * refusal leaves the step as it was, so a name that isn't valid, or a busy hour, costs the person
 * nothing but another try.
 */
export async function createFromSignUp(browserToken: string | null, input: NewWorkspaceInput, meta: ClientMeta): Promise<SignInResult> {
  const s = settings();
  limitAddress(meta);
  if (!isToken(browserToken)) throw expired();
  const workspaceName = typedName(input.workspace_name, "The workspace's name", TEXT_MAX.name);
  const currency = typeof input.currency === "string" && input.currency.trim() ? input.currency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw unprocessable("The currency must be a three-letter code, such as USD or EUR");
  // With no client address to go by (no socket: a test, or a server run without one), there is no per-address cap to count.
  const address = meta.address && meta.address !== "unknown" ? keyOf("address", addressOf(meta)) : null;
  const r = await withFlows({ browser: browserToken }, async (tx) => {
    const f = await verifiedSignUpFlow(tx, true);
    if (!live(f) || !f.email) return { kind: "expired" as const };
    const ownerName = typedName(input.name, "Your name", TEXT_MAX.name, f.email);
    const email = keyOf("email", canonicalEmail(f.email));
    await countSignUpsAlone(tx);
    const n = await signUpCounts(tx, email, address);
    if (n.by_email >= s.perEmail) return { kind: "email_cap" as const };
    if (n.by_address >= s.perAddressDay) return { kind: "limited" as const, scope: "address" };
    if (n.hour >= s.perHour || n.day >= s.perDay) return { kind: "limited" as const, scope: "server" };
    await consumeSignUpFlows(tx, "sign_up_verified");
    const ws = await createWorkspaceIn(tx, { name: workspaceName, ownerEmail: f.email, ownerName, currency }, { via: "sign_up", requestId: meta.requestId });
    await insertWorkspaceSignUp(tx, { tenantId: ws.tenantId, emailKey: email, addressKey: address });
    const session = await createSession(tx, { tenantId: ws.tenantId, userId: ws.ownerId, role: OWNER_ROLE }, "email_code", meta);
    return { kind: "ok" as const, workspace: { id: ws.workspace.id, name: ws.workspace.name }, session, returnTo: f.return_to };
  });
  if (r.kind === "expired") throw expired();
  if (r.kind === "email_cap") {
    throw new ApiError(409, "sign_up_cap", `This address has already created ${s.perEmail} workspace${s.perEmail === 1 ? "" : "s"}, the most one address may here. Sign in to one of them instead`);
  }
  if (r.kind === "limited") {
    if (r.scope === "server" && Date.now() > ceilingAlarmUntil) {
      ceilingAlarmUntil = Date.now() + HOUR;
      logger.error({ event: "sign_up_ceiling" }, "sign-up refused: the server-wide limit on workspaces created (SIGN_UP_WORKSPACES_PER_HOUR or _PER_DAY) was reached; look for abuse, or raise it");
    } else if (r.scope === "address") {
      logger.warn({ event: "sign_up_address_limited", requestId: meta.requestId }, "sign-up refused: this client address created its daily share of workspaces");
    }
    throw limitedNow();
  }
  return { status: "signed_in", workspace: r.workspace, returnTo: safeReturnTo(r.returnTo), session: r.session };
}

/** For tests: forget that the server-wide alarms were raised. */
export function resetSignUpAlarms(): void {
  emailAlarmUntil = 0;
  ceilingAlarmUntil = 0;
}
