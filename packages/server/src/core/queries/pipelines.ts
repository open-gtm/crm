import type { Tx } from "../../db/pool.js";

/**
 * The SQL of pipelines and their stages (core/pipelines.ts, and the default pipeline a new workspace starts
 * with; ADR 0012). The code that calls these keeps its checks, errors, schema changes and the order of
 * statements in its transaction.
 */

export interface PipelineRow { id: string; name: string; is_default: boolean }
export interface StageRow { id: string; pipeline_id: string; name: string; category: string; default_probability: string | null; position: number }

// --- Reading ----------------------------------------------------------------------------------------

/** The live pipelines, in their order. */
export async function livePipelines(tx: Tx): Promise<PipelineRow[]> {
  return tx<PipelineRow[]>`
    SELECT id, name, is_default FROM pipelines WHERE archived_at IS NULL ORDER BY position, name`;
}

/** Every live stage of every pipeline, in stage order. */
export async function allLiveStages(tx: Tx): Promise<Omit<StageRow, "position">[]> {
  return tx<Omit<StageRow, "position">[]>`
    SELECT id, pipeline_id, name, category, default_probability FROM stages WHERE archived_at IS NULL ORDER BY position`;
}

export async function livePipeline(tx: Tx, id: string): Promise<PipelineRow | undefined> {
  const [p] = await tx<PipelineRow[]>`SELECT id, name, is_default FROM pipelines WHERE id = ${id} AND archived_at IS NULL`;
  return p;
}

/** One pipeline's live stages, in order. */
export async function liveStagesOf(tx: Tx, pipelineId: string): Promise<StageRow[]> {
  return tx<StageRow[]>`SELECT id, pipeline_id, name, category, default_probability, position FROM stages
                        WHERE pipeline_id = ${pipelineId} AND archived_at IS NULL ORDER BY position`;
}

export async function liveStage(tx: Tx, id: string): Promise<StageRow | undefined> {
  const [s] = await tx<StageRow[]>`
    SELECT id, pipeline_id, name, category, default_probability, position FROM stages WHERE id = ${id} AND archived_at IS NULL`;
  return s;
}

/** True when a live pipeline has this name. */
export async function pipelineNameTaken(tx: Tx, name: string): Promise<boolean> {
  const [dup] = await tx`SELECT 1 FROM pipelines WHERE name = ${name} AND archived_at IS NULL`;
  return Boolean(dup);
}

/** True when a live pipeline other than `exceptId` has this name. */
export async function pipelineNameTakenByAnother(tx: Tx, name: string, exceptId: string): Promise<boolean> {
  const [dup] = await tx`SELECT 1 FROM pipelines WHERE name = ${name} AND archived_at IS NULL AND id <> ${exceptId}`;
  return Boolean(dup);
}

/** True when another live stage of the pipeline has this name, ignoring case. */
export async function stageNameTaken(tx: Tx, pipelineId: string, name: string, exceptId: string): Promise<boolean> {
  const [dup] = await tx`SELECT 1 FROM stages WHERE pipeline_id = ${pipelineId} AND lower(name) = lower(${name}) AND id <> ${exceptId} AND archived_at IS NULL`;
  return Boolean(dup);
}

// --- Writing ----------------------------------------------------------------------------------------

/** The new workspace's first pipeline, which is its default. */
export async function insertDefaultPipeline(tx: Tx, tenantId: string, id: string, name: string): Promise<void> {
  await tx`INSERT INTO pipelines (tenant_id, id, name, is_default) VALUES (${tenantId}, ${id}, ${name}, true)`;
}

export async function insertPipeline(tx: Tx, p: { tenantId: string; id: string; name: string; isDefault: boolean }): Promise<void> {
  await tx`INSERT INTO pipelines (tenant_id, id, name, is_default) VALUES (${p.tenantId}, ${p.id}, ${p.name}, ${p.isDefault})`;
}

/** Makes no pipeline the default, before another one becomes it. */
export async function clearDefaultPipeline(tx: Tx): Promise<void> {
  await tx`UPDATE pipelines SET is_default = false WHERE is_default`;
}

export async function updatePipelineRow(tx: Tx, id: string, name: string, isDefault: boolean): Promise<void> {
  await tx`UPDATE pipelines SET name = ${name}, is_default = ${isDefault},
           updated_at = now() WHERE id = ${id}`;
}

export async function insertStage(tx: Tx, s: { tenantId: string; id: string; pipelineId: string; name: string; position: number; category: string;
  probability: number | null }): Promise<void> {
  await tx`INSERT INTO stages (tenant_id, id, pipeline_id, name, position, category, default_probability)
             VALUES (${s.tenantId}, ${s.id}, ${s.pipelineId}, ${s.name}, ${s.position}, ${s.category}, ${s.probability})`;
}

export async function updateStageRow(tx: Tx, id: string, name: string, probability: number | string | null): Promise<void> {
  await tx`UPDATE stages SET name = ${name},
           default_probability = ${probability} WHERE id = ${id}`;
}

export async function setStagePosition(tx: Tx, id: string, position: number): Promise<void> {
  await tx`UPDATE stages SET position = ${position} WHERE id = ${id}`;
}
