import type { Tx } from "../db/pool.js";
import { conflict, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { audit } from "./audit.js";
import type { Ctx } from "./context.js";
import {
  allLiveStages, clearDefaultPipeline, insertPipeline, insertStage, livePipeline, livePipelines, liveStage, liveStagesOf, pipelineNameTaken,
  pipelineNameTakenByAnother, setStagePosition, stageNameTaken, updatePipelineRow, updateStageRow, type PipelineRow, type StageRow,
} from "./queries/pipelines.js";
import { lockSchema, recordChange, type Change } from "./schema.js";

export interface StageInput { name: string; category?: "open" | "won" | "lost"; probability?: number }

export async function listPipelines(tx: Tx) {
  const pipes = await livePipelines(tx);
  const stages = await allLiveStages(tx);
  return pipes.map((p) => ({
    id: encodeId("pipe", p.id), name: p.name, is_default: p.is_default,
    stages: stages.filter((s) => s.pipeline_id === p.id).map((s) => ({
      id: encodeId("stg", s.id), name: s.name, category: s.category,
      default_probability: s.default_probability === null ? null : Number(s.default_probability),
    })),
  }));
}

export async function createPipeline(tx: Tx, ctx: Ctx, input: { name: string; is_default?: boolean; stages: StageInput[] }, dryRun: boolean) {
  if (!input.name?.trim()) throw unprocessable("name is required");
  if (input.name.length > 200 || input.stages?.some?.((s) => typeof s?.name === "string" && s.name.length > 200)) {
    throw unprocessable("Pipeline and stage names can be at most 200 characters");
  }
  if (!Array.isArray(input.stages) || input.stages.length < 2 || input.stages.length > 30) throw unprocessable("A pipeline needs 2 to 30 stages");
  const names = new Set<string>();
  for (const s of input.stages) {
    if (!s.name?.trim()) throw unprocessable("Every stage needs a name");
    if (names.has(s.name.toLowerCase())) throw unprocessable(`Stage "${s.name}" is repeated`);
    names.add(s.name.toLowerCase());
    if (s.category && !["open", "won", "lost"].includes(s.category)) throw unprocessable(`Stage category must be open, won or lost`);
    if (s.probability !== undefined && (s.probability < 0 || s.probability > 100)) throw unprocessable("probability must be 0 to 100");
  }
  if (!input.stages.some((s) => s.category === "won")) throw unprocessable("A pipeline needs at least one won stage");
  if (!input.stages.some((s) => s.category === "lost")) throw unprocessable("A pipeline needs at least one lost stage");
  if (!dryRun) await lockSchema(tx);
  if (await pipelineNameTaken(tx, input.name)) throw conflict(`A pipeline named "${input.name}" already exists`);
  if (dryRun) return { dry_run: true, changes: [{ change: "pipeline_created", name: input.name, stages: input.stages }] };
  const id = uuidv7();
  if (input.is_default) await clearDefaultPipeline(tx);
  await insertPipeline(tx, { tenantId: ctx.tenantId, id, name: input.name, isDefault: input.is_default ?? false });
  let position = 0;
  for (const s of input.stages) {
    await insertStage(tx, { tenantId: ctx.tenantId, id: uuidv7(), pipelineId: id, name: s.name, position: position++, category: s.category ?? "open",
      probability: s.probability ?? null });
  }
  await audit(tx, ctx, { action: "pipeline.created", objectType: "pipeline", recordId: id, details: { name: input.name } });
  // Pipelines are part of the schema document, so creating one moves the schema version like any other schema change.
  await recordChange(tx, ctx, { change: "pipeline_created", object: "pipeline", after: { pipeline: encodeId("pipe", id), name: input.name } });
  return { dry_run: false, pipeline: (await listPipelines(tx)).find((p) => p.id === encodeId("pipe", id)) };
}

// Changes to existing pipelines and stages, used by schema-as-code. Each is a versioned schema change,
// and like every schema writer takes the schema lock (lockSchema) before it reads what it changes.
// Stage categories never change and nothing is removed here: deals already in a stage depend on both.

async function pipelineRow(tx: Tx, publicId: string): Promise<PipelineRow> {
  const d = decodeId(publicId);
  const p = d?.prefix === "pipe" ? await livePipeline(tx, d.uuid) : undefined;
  if (!p) throw notFound(`Pipeline ${publicId}`);
  return p;
}

async function stageRows(tx: Tx, pipelineId: string): Promise<StageRow[]> {
  return liveStagesOf(tx, pipelineId);
}

function checkName(name: string, what: string): void {
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw unprocessable(`${what} names must be 1 to 200 characters`);
}

/** Renames a pipeline or makes it the default. */
export async function updatePipeline(tx: Tx, ctx: Ctx, publicId: string, patch: { name?: string; is_default?: boolean }): Promise<Change[]> {
  await lockSchema(tx);
  const p = await pipelineRow(tx, publicId);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = { pipeline: publicId };
  if (patch.name !== undefined && patch.name !== p.name) {
    checkName(patch.name, "Pipeline");
    if (await pipelineNameTakenByAnother(tx, patch.name, p.id)) throw conflict(`A pipeline named "${patch.name}" already exists`);
    before.name = p.name;
    after.name = patch.name;
  }
  if (patch.is_default === false && p.is_default) throw unprocessable(`To change the default pipeline, set is_default on another one instead of unsetting it on ${p.name}`);
  if (patch.is_default === true && !p.is_default) {
    before.is_default = false;
    after.is_default = true;
  }
  if (Object.keys(before).length === 0) return [];
  if (after.is_default) await clearDefaultPipeline(tx);
  await updatePipelineRow(tx, p.id, (after.name as string) ?? p.name, (after.is_default as boolean) ?? p.is_default);
  const change: Change = { change: "pipeline_updated", object: "pipeline", before, after };
  await recordChange(tx, ctx, change);
  return [change];
}

/** Adds a stage at the end of a pipeline; reorderStages moves it. */
export async function addStage(tx: Tx, ctx: Ctx, pipelinePublicId: string, stage: StageInput): Promise<Change[]> {
  await lockSchema(tx);
  const p = await pipelineRow(tx, pipelinePublicId);
  checkName(stage.name, "Stage");
  if (stage.category && !["open", "won", "lost"].includes(stage.category)) throw unprocessable("Stage category must be open, won or lost");
  if (stage.probability != null && (stage.probability < 0 || stage.probability > 100)) throw unprocessable("probability must be 0 to 100");
  const stages = await stageRows(tx, p.id);
  if (stages.length >= 30) throw unprocessable("A pipeline can have at most 30 stages");
  if (stages.some((s) => s.name.toLowerCase() === stage.name.toLowerCase())) throw conflict(`Stage "${stage.name}" already exists in ${p.name}`);
  const id = uuidv7();
  await insertStage(tx, { tenantId: ctx.tenantId, id, pipelineId: p.id, name: stage.name, position: Math.max(-1, ...stages.map((s) => s.position)) + 1,
    category: stage.category ?? "open", probability: stage.probability ?? null });
  const change: Change = { change: "stage_added", object: "pipeline",
    after: { pipeline: pipelinePublicId, stage: encodeId("stg", id), name: stage.name, category: stage.category ?? "open", probability: stage.probability ?? null } };
  await recordChange(tx, ctx, change);
  return [change];
}

/** Renames a stage or changes its default probability. */
export async function updateStage(tx: Tx, ctx: Ctx, stagePublicId: string, patch: { name?: string; probability?: number | null }): Promise<Change[]> {
  await lockSchema(tx);
  const d = decodeId(stagePublicId);
  const s = d?.prefix === "stg" ? await liveStage(tx, d.uuid) : undefined;
  if (!s) throw notFound(`Stage ${stagePublicId}`);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = { pipeline: encodeId("pipe", s.pipeline_id), stage: stagePublicId };
  if (patch.name !== undefined && patch.name !== s.name) {
    checkName(patch.name, "Stage");
    if (await stageNameTaken(tx, s.pipeline_id, patch.name, s.id)) throw conflict(`Stage "${patch.name}" already exists in this pipeline`);
    before.name = s.name;
    after.name = patch.name;
  }
  const current = s.default_probability === null ? null : Number(s.default_probability);
  if (patch.probability !== undefined && patch.probability !== current) {
    if (patch.probability !== null && (patch.probability < 0 || patch.probability > 100)) throw unprocessable("probability must be 0 to 100");
    before.probability = current;
    after.probability = patch.probability;
  }
  if (Object.keys(before).length === 0) return [];
  await updateStageRow(tx, s.id, (after.name as string) ?? s.name, "probability" in after ? (after.probability as number | null) : s.default_probability);
  const change: Change = { change: "stage_updated", object: "pipeline", before, after };
  await recordChange(tx, ctx, change);
  return [change];
}

/** Puts a pipeline's stages in the given order. The list must name every stage exactly once. */
export async function reorderStages(tx: Tx, ctx: Ctx, pipelinePublicId: string, stagePublicIds: string[]): Promise<Change[]> {
  await lockSchema(tx);
  const p = await pipelineRow(tx, pipelinePublicId);
  const current = (await stageRows(tx, p.id)).map((s) => encodeId("stg", s.id));
  if (current.join() === stagePublicIds.join()) return [];
  if (stagePublicIds.length !== current.length || new Set(stagePublicIds).size !== current.length || stagePublicIds.some((x) => !current.includes(x))) {
    throw unprocessable(`The new order must list each of ${p.name}'s ${current.length} stages exactly once`);
  }
  for (const [i, sid] of stagePublicIds.entries()) await setStagePosition(tx, decodeId(sid)!.uuid, i);
  const change: Change = { change: "stages_reordered", object: "pipeline",
    before: { pipeline: pipelinePublicId, stages: current }, after: { pipeline: pipelinePublicId, stages: stagePublicIds } };
  await recordChange(tx, ctx, change);
  return [change];
}
