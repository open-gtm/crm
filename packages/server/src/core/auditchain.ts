import { withTenant } from "../db/tx.js";
import type { Sql, Tx } from "../db/pool.js";
import { canonicalJson, sha256 } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { blobStore } from "../providers/blobs.js";
import {
  anchorExists, anchorRows, chainCounts, chainEnd, chainHead, chainRowsAfter, insertAnchor, lockAnchors, sealRow, tenantDirectory, trySealLock,
  tryLockAnchors, unsealedRows, type AuditRow,
} from "./queries/audit.js";

/**
 * The audit log is hash-chained per tenant: hash(n) = sha256(hash(n-1) || canonical(row n)).
 * Rows are inserted unsealed (so writers never wait on a chain lock) and sealed here.
 *
 * The chain has its own order, chain_pos, assigned at seal time by the audit_log guard trigger
 * (1, 2, 3, … per tenant). It is not seq order: seq is taken at INSERT, but a slow transaction
 * can commit a lower seq after a higher one was sealed, and that row then joins the chain at the
 * end. Each row's hash covers its seq and content and the previous row's hash, so reordering,
 * changing or removing a sealed row breaks the walk. Chain heads are anchored to write-once
 * storage, so a rewrite of the database (including dropping its tail) is detectable.
 */

const GENESIS = Buffer.alloc(32);

/** Unchanged from the first release, so rows sealed before chain_pos existed still verify. */
function rowHash(prev: Buffer, r: AuditRow): Buffer {
  const body = canonicalJson({
    seq: r.seq, id: r.id, occurred_us: r.occurred_us, actor_type: r.actor_type, actor_id: r.actor_id, key_id: r.key_id,
    surface: r.surface, action: r.action, object_type: r.object_type, record_id: r.record_id, request_id: r.request_id,
    details: r.details,
  });
  return sha256(Buffer.concat([prev, Buffer.from(body)]));
}

/** Seals unsealed rows for one tenant, appending them to the chain. Returns how many were sealed. */
export async function sealTenant(tenantId: string, batch = 500): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    // One sealer per tenant at a time.
    if (!(await trySealLock(tx, tenantId))) return 0;
    const last = await chainEnd(tx);
    const rows = await unsealedRows(tx, batch);
    let prev: Buffer = last?.hash ?? GENESIS;
    let pos = BigInt(last?.chain_pos ?? 0);
    for (const r of rows) {
      const h = rowHash(prev, r);
      // The guard trigger assigns chain_pos; check it is the position this hash was chained at.
      const chainPos = await sealRow(tx, r.seq, prev, h);
      if (BigInt(chainPos) !== ++pos) throw new Error(`audit chain position mismatch at seq ${r.seq}`);
      prev = h;
    }
    return rows.length;
  });
}

export interface VerifyResult {
  ok: boolean;
  rows_checked: number;
  unsealed: number;
  /** Anchors listed in the database, each checked against the chain and against write-once storage. */
  anchors_checked: number;
  /** Anchors found in write-once storage, each checked to have a matching database anchor. */
  stored_anchors_checked: number;
  /** The checks that ran to completion. A failure stops at the first problem found. */
  checks: string[];
  problem?: string;
}

/** Recomputes the whole chain and checks it against every anchor, in the database and in storage. Waits for a running anchor or verify (CLI). */
export async function verifyTenant(tenantId: string): Promise<VerifyResult> {
  return withTenant(tenantId, async (tx) => verifyInTx(tx, tenantId, { wait: true }));
}

/**
 * Verifies inside `tx`. With `wait: false` (the HTTP path) it refuses with 409 instead of queueing
 * when a verify or an anchor already holds the tenant's lock: a verify walks the whole chain, and
 * callers waiting on the lock would each hold a pooled connection that every tenant shares.
 */
export async function verifyInTx(tx: Tx, tenantId: string, opts: { wait: boolean }): Promise<VerifyResult> {
  if (opts.wait) await lockAnchors(tx, tenantId);
  else if (!(await tryLockAnchors(tx, tenantId))) {
    throw new ApiError(409, "retry", "An audit verification or anchor is already running for this workspace; retry in a minute");
  }
  const checks: string[] = [];
  let checked = 0;
  let unsealed = 0;
  let anchorsChecked = 0;
  const fail = (problem: string): VerifyResult =>
    ({ ok: false, rows_checked: checked, unsealed, anchors_checked: anchorsChecked, stored_anchors_checked: 0, checks, problem });

  // Only the anchored positions are remembered during the walk (not every row's hash), with what the chain holds there.
  const anchors = await anchorRows(tx);
  const atAnchor = new Map<string, { seq: string; hash: Buffer } | null>(anchors.filter((a) => a.chain_pos).map((a) => [a.chain_pos!, null]));
  let prev: Buffer = GENESIS;
  let pos = 0n;
  for (;;) {
    const rows = await chainRowsAfter(tx, pos.toString());
    if (rows.length === 0) break;
    for (const r of rows) {
      if (BigInt(r.chain_pos!) !== pos + 1n) return fail(`chain position ${pos + 1n} is missing (next is ${r.chain_pos}, seq ${r.seq})`);
      if (!r.prev_hash || !r.prev_hash.equals(prev)) return fail(`chain broken at position ${r.chain_pos} (seq ${r.seq})`);
      const h = rowHash(prev, r);
      if (!r.hash || !r.hash.equals(h)) return fail(`row at position ${r.chain_pos} (seq ${r.seq}) does not match its hash`);
      if (atAnchor.has(r.chain_pos!)) atAnchor.set(r.chain_pos!, { seq: r.seq, hash: h });
      prev = h;
      pos++;
      checked++;
    }
  }
  const counts = await chainCounts(tx);
  unsealed = counts?.unsealed ?? 0;
  if (counts?.stray) return fail(`${counts.stray} row(s) are sealed without a chain position, or the reverse`);
  checks.push("chain_links", "row_hashes", "chain_positions_contiguous");

  const store = blobStore();
  const anchoredSeqs = new Set<string>();
  for (const a of anchors) {
    const at = a.chain_pos ? atAnchor.get(a.chain_pos) : undefined;
    if (!at || at.seq !== a.seq || !at.hash.equals(a.hash)) return fail(`anchor at seq ${a.seq} does not match the chain`);
    const stored = await store.get(anchorKey(tenantId, a.seq));
    if (!stored) return fail(`anchor at seq ${a.seq} is missing from write-once storage (${store.name})`);
    const parsed = parseAnchor(stored);
    if (parsed?.hash !== a.hash.toString("hex") || parsed.seq !== a.seq) return fail(`anchor at seq ${a.seq} differs from write-once storage`);
    anchoredSeqs.add(a.seq);
    anchorsChecked++;
  }
  checks.push("anchors_match_chain", "anchors_in_storage");

  // Storage is write-once; the anchors table is not. An anchor that only storage still holds
  // means a database anchor was removed, which is how a rewritten chain would hide.
  const keys = await store.list(anchorPrefix(tenantId));
  for (const key of keys) {
    const parsed = parseAnchor((await store.get(key)) ?? "");
    if (!parsed) return fail(`write-once storage holds an unreadable anchor (${key})`);
    if (!anchoredSeqs.has(parsed.seq)) return fail(`write-once storage holds an anchor at seq ${parsed.seq} that the database does not`);
  }
  checks.push("storage_anchors_in_database");
  return { ok: true, rows_checked: checked, unsealed, anchors_checked: anchorsChecked, stored_anchors_checked: keys.length, checks };
}

const anchorPrefix = (tenantId: string) => `audit-anchors/${tenantId}/`;
const anchorKey = (tenantId: string, seq: string) => `${anchorPrefix(tenantId)}${seq.padStart(20, "0")}.json`;

function parseAnchor(text: string): { seq: string; hash: string } | null {
  try {
    const a = JSON.parse(text) as { seq?: unknown; hash?: unknown };
    return typeof a.seq === "string" && typeof a.hash === "string" ? { seq: a.seq, hash: a.hash } : null;
  } catch {
    return null;
  }
}

/** Writes the tenant's chain head (highest chain_pos) to write-once storage. */
export async function anchorTenant(tenantId: string): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    await lockAnchors(tx, tenantId);
    const head = await chainHead(tx);
    if (!head) return false;
    if (await anchorExists(tx, head.seq)) return false;
    // Row first, blob second: if the blob write fails the row rolls back with it. (The app role
    // cannot update anchors, so the location is the store-relative key, known up front.)
    const key = anchorKey(tenantId, head.seq);
    await insertAnchor(tx, { tenantId, seq: head.seq, chainPos: head.chain_pos, hash: head.hash, location: `${blobStore().name}:${key}` });
    await blobStore().putOnce(key, JSON.stringify({
      tenant_id: tenantId, seq: head.seq, chain_pos: head.chain_pos, hash: head.hash.toString("hex"), anchored_at: new Date().toISOString(),
    }));
    return true;
  });
}

export async function tenantIds(tx: Tx | Sql): Promise<string[]> {
  const rows = await tenantDirectory(tx);
  return rows.map((r) => r.tenant_id);
}
