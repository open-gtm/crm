import { masterKey } from "../config.js";
import type { Tx } from "../db/pool.js";
import { hmac, safeEqual, sha256 } from "../lib/crypto.js";
import { ApiError, badRequest } from "../lib/errors.js";
import { credential, type Ctx } from "./context.js";
import { spendConfirmToken } from "./queries/confirm.js";

/**
 * Confirm tokens for changes previewed first (bulk changes, merges). A dry run issues one, signed with
 * the master key and bound to the workspace, the credential (`credential` in context.ts: the API key, or
 * for a browser session the signed-in member, so any of their sessions may use it and no one else, not
 * even their own API key), the kind of change and a fingerprint of
 * exactly what was previewed. A real run checks it and spends it: its hash is stored (confirm_tokens)
 * until it expires, so the same token never applies twice. If the run fails, its transaction rolls back
 * and the token can be used again.
 *
 * What a token proves is that this change is the one that was previewed. It does not prove that a person
 * looked at the preview: a client (or a model) can run the dry run and the real run back to back.
 */

export const CONFIRM_TTL_MS = 15 * 60_000;

interface Envelope { v: 1; kind: string; k: string; exp: number; body: unknown }

const sign = (ctx: Ctx, kind: string, encoded: string) => hmac(masterKey(), `${kind}|${ctx.tenantId}|${encoded}`);

export function issueConfirm(ctx: Ctx, kind: string, body: unknown): string {
  const env: Envelope = { v: 1, kind, k: credential(ctx), exp: Date.now() + CONFIRM_TTL_MS, body };
  const encoded = Buffer.from(JSON.stringify(env)).toString("base64url");
  return `${encoded}.${sign(ctx, kind, encoded)}`;
}

/** The body a token was issued with, once its signature, kind, credential and expiry check out. `redo` says how to get a new one. */
export function readConfirm<T>(ctx: Ctx, kind: string, token: string | undefined, redo: string): { body: T; exp: number } {
  const bad = (why: string) => badRequest(`confirm_token ${why}; ${redo}`);
  const [encoded, sig] = (token ?? "").split(".");
  if (!encoded || !sig || !safeEqual(Buffer.from(sig), Buffer.from(sign(ctx, kind, encoded)))) throw bad("is not valid");
  let env: Envelope;
  try {
    env = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Envelope;
  } catch {
    throw bad("is not valid");
  }
  if (env.v !== 1 || env.kind !== kind || env.k !== credential(ctx)) throw bad("was issued for another request or credential (an API key, or another signed-in member)");
  if (env.exp < Date.now()) throw bad("has expired");
  return { body: env.body as T, exp: env.exp };
}

/** The body a token claims, unchecked: for sizing a request's rate-limit charge before it is checked. */
export function peekConfirm(token: string | undefined): unknown {
  try {
    return (JSON.parse(Buffer.from((token ?? "").split(".")[0]!, "base64url").toString("utf8")) as Envelope).body;
  } catch {
    return undefined;
  }
}

/** Spends a checked token in the caller's transaction. A token already spent is refused (409); a concurrent spend waits for the first and then is refused. */
export async function spendConfirm(tx: Tx, ctx: Ctx, token: string, exp: number): Promise<void> {
  if (!(await spendConfirmToken(tx, ctx.tenantId, sha256(token), new Date(exp)))) {
    throw new ApiError(409, "confirm_token_used", "This confirm_token was already used: a token applies once. Run the dry run again for a new one");
  }
}
