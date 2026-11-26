import { AsyncLocalStorage } from "node:async_hooks";
import { db, type Tx } from "./pool.js";
import { setTenant } from "./queries.js";

/**
 * What code inside a withTenant transaction needs to know about that transaction (savepoints
 * included, which run on a different Tx object).
 *   - ownSchemas: schema tokens this transaction wrote (uncommitted), with the schema built at each.
 *     loadSchema keeps those here instead of in its per-process cache: they vanish if it rolls back.
 *   - preview: a dry run its caller rolls back. Locks that only serialise real writes are skipped.
 *   - scratch: what a module keeps for the length of the transaction (core/limits.ts: the workspace's
 *     limits, read once). One Map for the transaction, shared with its previews.
 *   - beforeCommit: checks to run once `fn` has returned, just before the transaction commits, keyed so
 *     each is registered once. One that throws rolls the transaction back. A check that must see every
 *     other committed transaction takes its lock here, so the lock is held for the commit alone and not
 *     for the work before it (core/limits.ts: the record limit).
 */
export interface TxState { ownSchemas: Map<string, unknown>; preview: boolean; scratch: Map<string, unknown>; beforeCommit: Map<string, (tx: Tx) => Promise<void>> }
const state = new AsyncLocalStorage<TxState>();

export const txState = (): TxState | undefined => state.getStore();

/**
 * Runs `fn` in a transaction scoped to one tenant. The tenant is set with SET LOCAL
 * semantics, so it cannot leak to the next user of a pooled connection.
 */
export async function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const s: TxState = { ownSchemas: new Map(), preview: false, scratch: new Map(), beforeCommit: new Map() };
  return state.run(s, () => db().begin(async (tx) => {
    await setTenant(tx, tenantId);
    const out = await fn(tx);
    for (const check of s.beforeCommit.values()) await check(tx);
    return out;
  }) as Promise<T>);
}

/** Runs `fn` as a preview: a dry run that the caller rolls back, so it needs no locks held to commit. */
export async function asPreview<T>(fn: () => Promise<T>): Promise<T> {
  const s = state.getStore();
  return s ? state.run({ ...s, preview: true }, fn) : fn();
}
