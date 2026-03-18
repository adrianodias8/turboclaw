/**
 * Tests for orchestrator shutdown and restart behavior.
 * Verifies graceful draining of active containers and restart callback invocation.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { startOrchestrator, type OrchestratorHandle } from "../src/orchestrator/loop";
import type { ContainerManager } from "../src/container/manager";
import type { TurboClawConfig } from "../src/config";
import type { SpawnOptions, ContainerInfo } from "../src/container/types";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Wait for a condition with timeout. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function testConfig(home: string): TurboClawConfig {
  return {
    home,
    dbPath: ":memory:",
    gateway: { port: 0, host: "127.0.0.1" },
    orchestrator: {
      pollIntervalMs: 50,
      maxConcurrency: 2,
      leaseDurationSec: 30,
      schedulingStrategy: "priority",
    },
    selfImprove: { enabled: false },
    provider: null,
    whatsapp: { enabled: false, allowedNumbers: [], allowedGroups: [], notifyOnComplete: false, notifyOnFail: false },
    memory: { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 },
    skills: { autoDiscover: false, maxPerTask: 5, registries: [] as any },
    autoresearch: { enabled: false, timeBudgetMs: 0, maxExperiments: 0, programPath: "" },
  } as TurboClawConfig;
}

function createMockContainerManager() {
  const logCallbacks = new Map<string, (kind: "stdout" | "stderr", line: string) => void>();
  const logResolvers = new Map<string, (exitCode: number) => void>();
  let idCounter = 0;
  let killCount = 0;
  let cancelAllCount = 0;

  const manager: ContainerManager = {
    async spawn(opts: SpawnOptions): Promise<ContainerInfo> {
      const containerId = `mock-${++idCounter}`;
      return { containerId, taskId: opts.taskId, runId: opts.runId, status: "running", exitCode: null };
    },
    async kill() { killCount++; },
    async inspect() { return null; },
    async streamLogs(containerId, onData) {
      logCallbacks.set(containerId, onData);
      return new Promise<number>((resolve) => {
        logResolvers.set(containerId, resolve);
      });
    },
    cancelStreamLogs() {},
    cancelAllStreamLogs() { cancelAllCount++; },
    async cleanup() {},
    async ensureNetwork() {},
    async checkDockerAvailable() {},
  };

  return {
    manager,
    get killCount() { return killCount; },
    get cancelAllCount() { return cancelAllCount; },
    finish(index: number, exitCode: number) {
      const containerId = `mock-${index + 1}`;
      const resolver = logResolvers.get(containerId);
      if (resolver) resolver(exitCode);
    },
    hasStreamLogs(index: number) {
      return logResolvers.has(`mock-${index + 1}`);
    },
  };
}

describe("orchestrator shutdown", () => {
  let db: Database;
  let store: Store;
  let orchestrator: OrchestratorHandle;
  let mock: ReturnType<typeof createMockContainerManager>;
  let testHome: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    testHome = join(tmpdir(), `turboclaw-orch-test-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(join(testHome, "memory"), { recursive: true });
    db = new Database(":memory:");
    store = createStore(db);
    mock = createMockContainerManager();
    config = testConfig(testHome);
  });

  afterEach(() => {
    if (orchestrator) orchestrator.stop();
    db.close();
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
  });

  it("stop() cancels all stream logs", () => {
    orchestrator = startOrchestrator(store, mock.manager, config);
    orchestrator.stop();
    expect(mock.cancelAllCount).toBe(1);
    expect(orchestrator.isRunning()).toBe(false);
  });

  it("requestRestart fires immediately when no active containers", async () => {
    orchestrator = startOrchestrator(store, mock.manager, config);
    let restarted = false;
    orchestrator.requestRestart(() => { restarted = true; });
    // Should fire immediately since nothing is running
    await waitFor(() => restarted, 2000);
    expect(restarted).toBe(true);
  });

  it("requestRestart waits for active containers to drain", async () => {
    orchestrator = startOrchestrator(store, mock.manager, config);

    // Create and queue a task
    const task = store.createTask({ title: "drain-test" });
    store.updateTaskStatus(task.id, "queued");

    // Wait for it to be claimed
    await waitFor(() => mock.hasStreamLogs(0), 3000);

    let restarted = false;
    orchestrator.requestRestart(() => { restarted = true; });

    // Should NOT have restarted yet
    await new Promise((r) => setTimeout(r, 300));
    expect(restarted).toBe(false);

    // Finish the container
    mock.finish(0, 0);

    // Now it should restart
    await waitFor(() => restarted, 5000);
    expect(restarted).toBe(true);
  });

  it("stop prevents claiming new tasks", async () => {
    orchestrator = startOrchestrator(store, mock.manager, config);
    orchestrator.stop();

    // Create a queued task after stop
    const task = store.createTask({ title: "should-not-run" });
    store.updateTaskStatus(task.id, "queued");

    await new Promise((r) => setTimeout(r, 300));
    // Task should still be queued
    const t = store.getTask(task.id);
    expect(t?.status).toBe("queued");
  });
});
