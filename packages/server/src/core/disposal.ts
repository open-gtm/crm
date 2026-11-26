import { config } from "../config.js";
import { db, type Tx } from "../db/pool.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { blobStore } from "../providers/blobs.js";
import { storeNamed } from "../providers/files.js";
import { audit } from "./audit.js";
import { sealAllInTx } from "./auditchain.js";
import { OWNER_ROLE, systemCtx, type Ctx } from "./context.js";
import { forgetTenantKey } from "./encryption.js";
import {
  clearDeletion, deletionState, deletionStateForUpdate, dueDeletions, externalFiles, lockWorkspaceForPurge, purgeTenant, scheduleDeletion, tenantExists,
  tombstone, type DeletionState,
} from "./queries/disposal.js";
import { enterWorkspace } from "./queries/workspace.js";

/**
 * Deleting a workspace (ADR 0020). Two ways in:
 *   - an owner asks through the API, typing the workspace's name back. The deletion waits out a grace
 *     period (WORKSPACE_DELETION_GRACE_DAYS), during which the workspace works as before and an owner
 *     can withdraw it; then the worker deletes it.
 *   - whoever runs the server deletes it at once with the `delete-workspace` command.
 * Either way the end is `deleteWorkspaceNow`: every row of the workspace in every table, its files'
 * bytes in an outside store, and its data key, which makes anything encrypted with it unreadable
 * wherever a copy remains (a backup, a bucket). A tombstone stays, with no customer content.
 */

const publicDeletion = (s: DeletionState) => (s.requested_at && s.delete_after
  ? { requested_at: s.requested_at.toISOString(), requested_by: encodeId("usr", s.requested_by!), scheduled_for: s.delete_after.toISOString() }
  : null);
export type PendingDeletion = ReturnType<typeof publicDeletion>;

/** The workspace's pending deletion, or null. Part of GET /v1/workspace, so every member can see it coming. */
export async function pendingDeletion(tx: Tx): Promise<PendingDeletion> {
  const s = await deletionState(tx);
  return s ? publicDeletion(s) : null;
}

/** Owners only, in person or with their own API key: never an app connected over OAuth, never through an MCP server. */
function assertOwnerInPerson(ctx: Ctx, what: string): string {
  if (ctx.oauth) throw forbidden(`Connected apps can't ${what}`);
  if (ctx.surface === "admin-mcp" || ctx.surface === "ops-mcp") throw forbidden(`An MCP server can't ${what}: an owner does it through the API or from a browser session`);
  if (ctx.actor.type !== "user" || !ctx.actor.id || ctx.actor.role !== OWNER_ROLE) throw forbidden(`Only an owner can ${what}`);
  return ctx.actor.id;
}

/**
 * Asks for the workspace to be deleted. The name must be typed back exactly. With a grace period of 0
 * days it is due at once, and the worker deletes it on its next pass (within a minute).
 */
export async function requestWorkspaceDeletion(tx: Tx, ctx: Ctx, input: { confirm_name: string }) {
  const userId = assertOwnerInPerson(ctx, "delete the workspace");
  const state = await deletionStateForUpdate(tx);
  if (!state) throw new Error("workspace missing");
  if (typeof input.confirm_name !== "string" || input.confirm_name !== state.name) {
    throw unprocessable("confirm_name must be the workspace's name, exactly as GET /v1/workspace shows it");
  }
  if (state.delete_after) throw conflict("This workspace is already scheduled for deletion", { deletion: publicDeletion(state) });
  const graceDays = config().WORKSPACE_DELETION_GRACE_DAYS;
  const due = await scheduleDeletion(tx, ctx.tenantId, userId, graceDays);
  await audit(tx, ctx, { action: "workspace.deletion_scheduled", details: { scheduled_for: due.toISOString(), grace_days: graceDays } });
  return publicDeletion((await deletionState(tx))!)!;
}

/** Withdraws a pending deletion. Any owner may, not only the one who asked. */
export async function cancelWorkspaceDeletion(tx: Tx, ctx: Ctx) {
  assertOwnerInPerson(ctx, "cancel the workspace's deletion");
  const state = await deletionStateForUpdate(tx);
  if (!state?.delete_after) throw conflict("This workspace is not scheduled for deletion");
  await clearDeletion(tx, ctx.tenantId);
  await audit(tx, ctx, { action: "workspace.deletion_cancelled", details: { was_scheduled_for: state.delete_after.toISOString() } });
  return { cancelled: true as const };
}

export interface DeletedWorkspace { id: string; deleted_at: string; requested_by_type: "owner" | "operator"; audit_rows: number;
  audit_chain_pos: number | null; audit_head_hash: string | null; rows_deleted: Record<string, number> }

/** What is left of a deleted workspace, or null when there is no such tombstone. */
export async function deletedWorkspace(tenantId: string): Promise<DeletedWorkspace | null> {
  const t = await tombstone(db(), tenantId);
  return t ? { id: encodeId("ws", t.workspace_id), deleted_at: t.deleted_at.toISOString(), requested_by_type: t.requested_by_type, audit_rows: Number(t.audit_rows),
    audit_chain_pos: t.audit_chain_pos === null ? null : Number(t.audit_chain_pos), audit_head_hash: t.audit_head_hash?.toString("hex") ?? null,
    rows_deleted: t.rows_deleted } : null;
}

/** A workspace ID as typed (`ws_…`) to its UUID. */
export function parseWorkspaceId(publicId: string): string {
  const d = decodeId(publicId);
  if (d?.prefix !== "ws") throw unprocessable("A workspace ID looks like ws_…");
  return d.uuid;
}

/**
 * Deletes a workspace now, for good. `by` says who decided: the operator's command, or the owner whose
 * request came due (the worker). One transaction: it locks the workspace so nothing new is written,
 * deletes the bytes of files kept outside the database, writes the last audit entry and seals the
 * chain, then removes every row and leaves the tombstone. If anything fails, nothing is deleted from
 * the database (bytes already removed from an outside store stay removed: the deletion is retried).
 * Afterwards the end of the audit chain is also written to write-once storage.
 */
export async function deleteWorkspaceNow(tenantId: string, by: { type: "operator" } | { type: "owner"; userId: string; requestedAt: Date }): Promise<DeletedWorkspace> {
  if (!(await tenantExists(db(), tenantId))) throw notFound(`Workspace ${encodeId("ws", tenantId)}`);
  await db().begin(async (tx) => {
    await enterWorkspace(tx, tenantId);
    if (!(await lockWorkspaceForPurge(tx, tenantId))) throw notFound(`Workspace ${encodeId("ws", tenantId)}`);
    // Outside stores know nothing of workspaces, so their objects go one by one. Their bytes are sealed
    // with the workspace's key, which goes with the rows below: an object missed here can't be read again.
    for (const f of await externalFiles(tx)) await storeNamed(f.store).delete(tx, tenantId, f.id);
    const ctx: Ctx = { ...systemCtx(tenantId, by.type === "operator" ? "delete-workspace" : "scheduled-deletion"), surface: by.type === "operator" ? "cli" : "system" };
    await audit(tx, ctx, { action: "workspace.deleted", details: { requested_by_type: by.type, ...(by.type === "owner" ? { requested_by: encodeId("usr", by.userId) } : {}) } });
    await sealAllInTx(tx, tenantId);
    await purgeTenant(tx, { tenantId, byType: by.type, by: by.type === "owner" ? by.userId : null, requestedAt: by.type === "owner" ? by.requestedAt : new Date() });
  });
  forgetTenantKey(tenantId);
  const gone = (await deletedWorkspace(tenantId))!;
  // A copy of the tombstone where the database can't rewrite it. A failure here doesn't undo the deletion.
  await blobStore().putOnce(`deleted-workspaces/${tenantId}.json`, JSON.stringify({ workspace_id: tenantId, deleted_at: gone.deleted_at,
    requested_by_type: gone.requested_by_type, audit_rows: gone.audit_rows, audit_chain_pos: gone.audit_chain_pos, audit_head_hash: gone.audit_head_hash }))
    .catch((e: Error) => logger.error({ tenantId, err: e.message }, "could not write the deleted workspace's tombstone to blob storage"));
  logger.info({ tenantId, requestedByType: by.type, auditRows: gone.audit_rows }, "workspace deleted");
  return gone;
}

/** The worker's pass: deletes workspaces whose grace period has run out. One that fails is logged and tried again next pass. */
export async function purgeDueWorkspaces(): Promise<number> {
  let n = 0;
  for (const tenantId of await dueDeletions(db())) {
    try {
      // Read again inside the workspace: an owner may have withdrawn the request since the directory was read.
      const state = await db().begin(async (tx) => {
        await enterWorkspace(tx, tenantId);
        return deletionState(tx);
      });
      if (!state?.delete_after || state.delete_after.getTime() > Date.now() || !state.requested_at || !state.requested_by) continue;
      await deleteWorkspaceNow(tenantId, { type: "owner", userId: state.requested_by, requestedAt: state.requested_at });
      n++;
    } catch (e) {
      logger.error({ job: "workspace-deletion", tenantId, err: (e as Error).message }, "deleting a workspace failed; it will be tried again");
    }
  }
  return n;
}
