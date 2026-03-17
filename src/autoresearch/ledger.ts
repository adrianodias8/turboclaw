import type { Store } from "../tracker/store";
import type { ExperimentStatus, Experiment } from "../tracker/types";
import type { TestMetrics } from "./types";

export interface ExperimentRecord {
  sessionId: string;
  commitHash: string;
  parentHash: string | null;
  metrics: TestMetrics;
  experimentDurationMs: number;
  status: ExperimentStatus;
  description: string;
  diffStat: string | null;
  taskId: string | null;
}

export function recordExperiment(store: Store, record: ExperimentRecord): Experiment {
  return store.recordExperiment({
    sessionId: record.sessionId,
    commitHash: record.commitHash,
    parentHash: record.parentHash,
    testsPassed: record.metrics.passed,
    testsFailed: record.metrics.failed,
    testsTotal: record.metrics.total,
    testDurationMs: record.metrics.durationMs,
    experimentDurationMs: record.experimentDurationMs,
    status: record.status,
    description: record.description,
    diffStat: record.diffStat,
    taskId: record.taskId,
  });
}

export function getSessionSummary(store: Store, sessionId: string): {
  total: number;
  kept: number;
  discarded: number;
  crashed: number;
  regressions: number;
  bestTests: number;
} {
  const experiments = store.listExperiments(sessionId);
  return {
    total: experiments.length,
    kept: experiments.filter(e => e.status === "keep").length,
    discarded: experiments.filter(e => e.status === "discard").length,
    crashed: experiments.filter(e => e.status === "crash").length,
    regressions: experiments.filter(e => e.status === "regression").length,
    bestTests: Math.max(0, ...experiments.map(e => e.tests_total)),
  };
}
