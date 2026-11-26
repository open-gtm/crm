import type { Tx } from "../db/pool.js";
import { uuidv7 } from "../lib/ids.js";
import type { Ctx } from "./context.js";
import { insertEvent } from "./queries/events.js";
import { viaOf } from "./source.js";

/** Writes an outbox event in the caller's transaction (transactional outbox). Workers deliver it later. */
export async function emit(
  tx: Tx,
  ctx: Ctx,
  event: { type: string; objectType?: string; recordId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await insertEvent(tx, {
    tenantId: ctx.tenantId, id: uuidv7(), type: event.type, objectType: event.objectType ?? null, recordId: event.recordId ?? null,
    actorType: ctx.actor.type, actorId: ctx.actor.id, surface: ctx.surface, via: await viaOf(tx, ctx), data: event.data ?? {},
    causationDepth: ctx.causationDepth ?? 0, automationId: ctx.automationId ?? null,
  });
}
