import { describe, it, expect } from "bun:test";
import { validateSelfImproveTask, buildSelfImproveEnv, selfImprovePreamble } from "../src/container/self-improve";
import type { TurboClawConfig } from "../src/config";
import type { Task } from "../src/tracker/types";

function makeConfig(selfImproveEnabled: boolean): TurboClawConfig {
  return {
    home: "/tmp/test",
    dbPath: "/tmp/test/db",
    gateway: { port: 7800, host: "0.0.0.0" },
    orchestrator: { pollIntervalMs: 2000, maxConcurrency: 2, leaseDurationSec: 600, schedulingStrategy: "priority" },
    selfImprove: { enabled: selfImproveEnabled },
    provider: null,
    whatsapp: { enabled: false, allowedNumbers: [], notifyOnComplete: false, notifyOnFail: false },
  };
}

function makeTask(role: string): Task {
  return {
    id: "task-123",
    pipeline_id: null,
    stage: null,
    title: "Improve error handling",
    description: null,
    agent_role: role as Task["agent_role"],
    priority: 0,
    status: "running",
    max_retries: 3,
    retry_count: 0,
    reply_jid: null,
    created_at: 0,
    updated_at: 0,
  };
}

describe("validateSelfImproveTask", () => {
  it("rejects when self-improve is disabled", () => {
    const result = validateSelfImproveTask(makeConfig(false), makeTask("self-improve"));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("disabled");
  });

  it("rejects non-self-improve role", () => {
    const result = validateSelfImproveTask(makeConfig(true), makeTask("coder"));
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("self-improve");
  });

  it("accepts valid self-improve task", () => {
    const result = validateSelfImproveTask(makeConfig(true), makeTask("self-improve"));
    expect(result.valid).toBe(true);
  });
});

describe("buildSelfImproveEnv", () => {
  it("returns correct env vars", () => {
    const env = buildSelfImproveEnv(makeConfig(true), "task-123");
    expect(env.TURBOCLAW_SELF_IMPROVE).toBe("true");
    expect(env.TURBOCLAW_BRANCH).toBe("turboclaw/improve/task-123");
    expect(env.TURBOCLAW_PROTECTED_FILES).toContain(".env");
    expect(env.TURBOCLAW_PROTECTED_FILES).toContain("turboclaw.db");
  });
});

describe("selfImprovePreamble", () => {
  it("includes branch name and protected files", () => {
    const preamble = selfImprovePreamble("task-456");
    expect(preamble).toContain("turboclaw/improve/task-456");
    expect(preamble).toContain(".env");
    expect(preamble).toContain("never commit to main");
  });
});
