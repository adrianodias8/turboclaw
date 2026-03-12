import type { Store } from "./store";
import type { Task, Pipeline } from "./types";
import { logger } from "../logger";

export interface StageDefinition {
  name: string;
  description?: string;
  agentRole?: string;
}

export function parseStages(pipeline: Pipeline): StageDefinition[] {
  try {
    return JSON.parse(pipeline.stages) as StageDefinition[];
  } catch {
    return [];
  }
}

export function getNextStage(pipeline: Pipeline, currentStage: string): string | null {
  const stages = parseStages(pipeline);
  const idx = stages.findIndex((s) => s.name === currentStage);
  if (idx === -1 || idx >= stages.length - 1) return null;
  return stages[idx + 1]!.name;
}

/**
 * Attempt to advance a task to the next pipeline stage.
 * Returns the updated task if advanced, null if blocked by a gate or at the end.
 */
export function advanceTask(store: Store, taskId: string): Task | null {
  const task = store.getTask(taskId);
  if (!task || !task.pipeline_id || !task.stage) return null;

  const pipeline = store.getPipeline(task.pipeline_id);
  if (!pipeline) return null;

  const nextStage = getNextStage(pipeline, task.stage);
  if (!nextStage) {
    logger.info(`Task ${taskId} completed final stage: ${task.stage}`);
    return store.updateTaskStatus(taskId, "done");
  }

  // Check if there's a gate blocking this transition
  const gate = store.getGate(task.pipeline_id, task.stage, nextStage);
  if (gate && gate.approved === 0) {
    logger.info(`Task ${taskId} blocked by gate ${gate.id}: ${task.stage} → ${nextStage}`);
    return null;
  }

  // Advance to next stage and requeue
  logger.info(`Advancing task ${taskId}: ${task.stage} → ${nextStage}`);
  store.setTaskStage(taskId, nextStage);
  return store.updateTaskStatus(taskId, "queued");
}
