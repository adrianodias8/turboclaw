export type SchedulingStrategy = "fifo" | "priority" | "round-robin";

export interface OrchestratorConfig {
  pollIntervalMs: number;
  maxConcurrency: number;
  leaseDurationSec: number;
  schedulingStrategy: SchedulingStrategy;
}
