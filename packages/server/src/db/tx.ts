import { AsyncLocalStorage } from "node:async_hooks";
import { db, type Tx } from "./pool.js";
import { setTenant } from "./queries.js";

/**
 * What code inside a withTenant transaction needs to know about that transaction (savepoints
 * included, which run on a different Tx object).
 *   - ownSchemas: schema tokens this transaction wrote (uncommitted), with the schema built at each.
 *     loadSchema keeps those here instead of in its per-process cache: they vanish if it rolls back.
 *   - preview: a dry run its caller rolls back. Locks that only serialise real writes are skipped.
 */
export interface TxState { ownSchemas: Map<string, unknown>; preview: boolean }
const state = new AsyncLocalStorage<TxState>();

export const txState = (): TxState | undefined => state.getStore();

/**
 * Runs `fn` in a transaction scoped to one tenant. The tenant is set with SET LOCAL
 * semantics, so it cannot leak to the next user of a pooled connection.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return state.run({ ownSchemas: new Map(), preview: false }, () => db().begin(async (tx) => {
    await setTenant(tx, tenantId);
    return fn(tx);
  }) as Promise<T>);
}

/** Runs `fn` as a preview: a dry run that the caller rolls back, so it needs no locks held to commit. */
export async function asPreview<T>(fn: () => Promise<T>): Promise<T> {
  const s = state.getStore();
  return s ? state.run({ ...s, preview: true }, fn) : fn();
}
