import type { TurboClawConfig } from "../config";
import type { Task } from "../tracker/types";
import { logger } from "../logger";

const PROTECTED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "config.json",
  "turboclaw.db",
  "turboclaw.db-wal",
  "turboclaw.db-shm",
]);

export function validateSelfImproveTask(config: TurboClawConfig, task: Task): { valid: boolean; reason?: string } {
  if (!config.selfImprove.enabled) {
    return { valid: false, reason: "Self-improve mode is disabled" };
  }

  if (task.agent_role !== "self-improve") {
    return { valid: false, reason: "Task agent_role must be 'self-improve'" };
  }

  return { valid: true };
}

export function buildSelfImproveEnv(config: TurboClawConfig, taskId: string): Record<string, string> {
  return {
    TURBOCLAW_SELF_IMPROVE: "true",
    TURBOCLAW_BRANCH: `turboclaw/improve/${taskId}`,
    TURBOCLAW_PROTECTED_FILES: [...PROTECTED_FILES].join(","),
  };
}

/**
 * Generate the git branch setup commands that the agent should run
 * before making any changes.
 */
export function selfImprovePreamble(taskId: string): string {
  const branch = `turboclaw/improve/${taskId}`;
  return [
    `# TurboClaw Self-Improve Mode`,
    `# The TurboClaw source is mounted at /project. Work there.`,
    `cd /project`,
    `# Always work on a feature branch — never commit to main.`,
    `git checkout -b ${branch}`,
    `# Protected files (do not modify): ${[...PROTECTED_FILES].join(", ")}`,
  ].join("\n");
}
