import * as nodeCrypto from "node:crypto";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as zxcvbnCommon from "@zxcvbn-ts/language-common";
import * as zxcvbnEn from "@zxcvbn-ts/language-en";
import { config } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { safeRequest } from "../lib/outbound.js";

/**
 * Password storage (ADR 0009). argon2id from Node's own crypto (Node 24.7.0 or later, built with
 * OpenSSL 3.2 or later), at OWASP's minimum: 19 MiB, 2 passes, 1 lane. Where argon2 is missing at
 * runtime, scrypt with OWASP's parameters (N=2^17, r=8, p=1). Stored self-describing, so the
 * parameters can be raised later: a sign-in with an outdated hash rehashes it.
 *
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>     (base64, no padding)
 *   $scrypt$ln=17,r=8,p=1$<salt>$<hash>
 */

export interface Argon2Params { m: number; t: number; p: number }
const DEFAULT_ARGON2: Argon2Params = { m: 19_456, t: 2, p: 1 };
let argon2Params = DEFAULT_ARGON2;
const SCRYPT = { ln: 17, r: 8, p: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 32;

/** For tests: hash new passwords with other argon2 parameters (to exercise rehash-on-sign-in). Call with no argument to restore. */
export function setArgon2Params(p: Argon2Params = DEFAULT_ARGON2): void {
  argon2Params = p;
}

type Argon2Fn = (algorithm: "argon2id", params: { message: string | Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  cb: (err: Error | null, key: Buffer) => void) => void;
const argon2Fn = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;

const argon2 = (pw: string, salt: Buffer, p: Argon2Params, length: number) => new Promise<Buffer>((resolve, reject) =>
  argon2Fn!("argon2id", { message: pw, nonce: salt, parallelism: p.p, tagLength: length, memory: p.m, passes: p.t }, (e, k) => (e ? reject(e) : resolve(k))));

const scrypt = (pw: string, salt: Buffer, ln: number, r: number, p: number, length: number) => new Promise<Buffer>((resolve, reject) =>
  nodeCrypto.scrypt(pw, salt, length, { N: 2 ** ln, r, p, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

let argon2Works: boolean | undefined;
/** True when this Node and its OpenSSL can run argon2id. Checked once with tiny parameters. */
export async function argon2Supported(): Promise<boolean> {
  if (argon2Works === undefined) {
    try {
      argon2Works = typeof argon2Fn === "function" && (await argon2("probe", randomBytes(SALT_BYTES), { m: 64, t: 2, p: 1 }, 16)).length === 16;
    } catch {
      argon2Works = false;
    }
    if (!argon2Works) logger.warn("argon2id is not available in this Node build; passwords are hashed with scrypt");
  }
  return argon2Works;
}

/**
 * Hashing takes memory (19 MiB each for argon2id, 128 MiB for scrypt) and CPU on libuv's thread
 * pool, so at most HASH_CONCURRENCY run at once and at most HASH_QUEUE wait; past that a sign-in
 * gets 503 instead of the server running out of memory.
 */
const HASH_CONCURRENCY = 4;
const HASH_QUEUE = 64;
let running = 0;
const waiting: (() => void)[] = [];

async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= HASH_CONCURRENCY) {
    if (waiting.length >= HASH_QUEUE) throw new ApiError(503, "busy", "Too many sign-ins are being checked at once; retry in a moment");
    await new Promise<void>((r) => waiting.push(r));
  } else running++;
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  if (await argon2Supported()) {
    const p = argon2Params;
    const hash = await bounded(() => argon2(pw, salt, p, HASH_BYTES));
    return `$argon2id$v=19$m=${p.m},t=${p.t},p=${p.p}$${b64(salt)}$${b64(hash)}`;
  }
  const hash = await bounded(() => scrypt(pw, salt, SCRYPT.ln, SCRYPT.r, SCRYPT.p, HASH_BYTES));
  return `$scrypt$ln=${SCRYPT.ln},r=${SCRYPT.r},p=${SCRYPT.p}$${b64(salt)}$${b64(hash)}`;
}

const ARGON2_FORMAT = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{16,128})$/;
const SCRYPT_FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{16,128})$/;

/**
 * Checks a password against a stored hash in constant time. `rehash` is true when the hash was made
 * with other parameters (or scrypt where argon2 now works), so the caller should store a new one.
 * A malformed hash never verifies. Parameters are capped, so a tampered row can't make a check expensive.
 */
export async function verifyPassword(pw: string, stored: string): Promise<{ ok: boolean; rehash: boolean }> {
  const a = ARGON2_FORMAT.exec(stored);
  if (a) {
    const p = { m: Number(a[1]), t: Number(a[2]), p: Number(a[3]) };
    if (!argon2Fn || p.m > 262_144 || p.t > 10 || p.p > 8 || p.m < 8 * p.p) return { ok: false, rehash: false };
    const want = Buffer.from(a[5]!, "base64");
    const got = await bounded(() => argon2(pw, Buffer.from(a[4]!, "base64"), p, want.length));
    const ok = got.length === want.length && timingSafeEqual(got, want);
    const cur = argon2Params;
    return { ok, rehash: ok && (p.m !== cur.m || p.t !== cur.t || p.p !== cur.p) };
  }
  const s = SCRYPT_FORMAT.exec(stored);
  if (s) {
    const [ln, r, p] = [Number(s[1]), Number(s[2]), Number(s[3])];
    if (ln > 20 || r > 16 || p > 4) return { ok: false, rehash: false };
    const want = Buffer.from(s[5]!, "base64");
    const got = await bounded(() => scrypt(pw, Buffer.from(s[4]!, "base64"), ln, r, p, want.length));
    const ok = got.length === want.length && timingSafeEqual(got, want);
    return { ok, rehash: ok && ((await argon2Supported()) || ln !== SCRYPT.ln || r !== SCRYPT.r || p !== SCRYPT.p) };
  }
  return { ok: false, rehash: false };
}

let dummy: Promise<string> | undefined;
/** Spends what checking a real password costs, for an email with no password, so timing doesn't tell them apart. */
export async function dummyVerify(pw: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(pw, await dummy);
  return false;
}

// --- Rules for new passwords ---------------------------------------------------------------------

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/**
 * Strength is estimated by zxcvbn-ts with its common and English dictionaries, bundled in the
 * package, so it works offline. Built on first use (about 70 ms), then reused. Only the first
 * ESTIMATE_MAX UTF-16 code units are estimated, which keeps a check to a few milliseconds.
 */
const ESTIMATE_MAX = 256;
let estimator: ZxcvbnFactory | undefined;
const strength = (pw: string, userInputs: string[]) => {
  estimator ??= new ZxcvbnFactory({
    translations: zxcvbnEn.translations,
    graphs: zxcvbnCommon.adjacencyGraphs,
    dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
    maxLength: ESTIMATE_MAX,
  });
  return estimator.check(pw, userInputs).score;
};

/**
 * Why a new password is refused, or null. No composition rules: length, then not easy to guess
 * (with the email and workspace name as words an attacker would try), and not containing either.
 */
export function passwordProblem(pw: string, context: { email?: string | null; workspaceName?: string | null } = {}): string | null {
  const length = [...pw].length;
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters`;
  const lower = pw.toLowerCase();
  // The estimator can rate a long run of two characters as strong (it sees no pattern in it).
  if (new Set(lower).size <= 2) return "This password repeats too few characters";
  // A long password can rate as strong while containing these, so they are checked as well.
  const local = context.email?.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 3 && lower.includes(local)) return "Don't include your email address in your password";
  const ws = context.workspaceName?.toLowerCase().replace(/\s+/g, "") ?? "";
  if (ws.length >= 3 && lower.replace(/\s+/g, "").includes(ws)) return "Don't include the workspace name in your password";
  const userInputs = [local, context.email ?? "", context.workspaceName ?? "", ws].filter((s) => s.length >= 3);
  const required = config().PASSWORD_MIN_STRENGTH; // of 0 to 4; 0 turns the estimate off
  if (required > 0 && strength(pw, userInputs) < required) return "This password is too easy to guess";
  return null;
}

/** Looks up how many breaches a SHA-1 hex prefix's suffixes appear in; replaceable in tests. Returns the response text of the range API. */
type RangeLookup = (prefix: string) => Promise<string>;
const pwnedRange: RangeLookup = async (prefix) => {
  const r = await safeRequest(`https://api.pwnedpasswords.com/range/${prefix}`, { method: "GET", headers: { "add-padding": "true", accept: "text/plain" },
    maxBytes: 512 * 1024, timeoutMs: 5000 }, { allowInsecure: false });
  if (r.status !== 200) throw new Error(`range API answered ${r.status}`);
  return r.body;
};
let rangeLookup: RangeLookup = pwnedRange;
export const setBreachRangeLookup = (fn?: RangeLookup) => {
  rangeLookup = fn ?? pwnedRange;
};

/**
 * True when the password appears in a known breach, by the Have I Been Pwned range API: only the
 * first 5 hex characters of its SHA-1 leave the server (k-anonymity). Off unless PASSWORD_BREACH_CHECK
 * is on. When the service can't be reached the password is accepted (and a warning logged).
 */
export async function isBreached(pw: string): Promise<boolean> {
  if (!config().PASSWORD_BREACH_CHECK) return false;
  const sha1 = createHash("sha1").update(pw).digest("hex").toUpperCase();
  try {
    const body = await rangeLookup(sha1.slice(0, 5));
    return body.split("\n").some((line) => {
      const [suffix, count] = line.trim().split(":");
      return suffix === sha1.slice(5) && Number(count) > 0;
    });
  } catch (e) {
    logger.warn({ event: "breach_check_failed", err: (e as Error).message }, "breached-password check unavailable; password accepted");
    return false;
  }
}
