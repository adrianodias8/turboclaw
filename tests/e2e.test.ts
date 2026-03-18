/**
 * End-to-end tests for TurboClaw.
 *
 * Tests the full flow: HTTP API → Store → Orchestrator → Mock Container → Events → Final State.
 * Uses a real in-memory SQLite store, real gateway (Bun.serve), and real orchestrator loop,
 * with a mock ContainerManager that simulates container execution without Docker.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { startGateway } from "../src/gateway/server";
import { startOrchestrator, type OrchestratorHandle } from "../src/orchestrator/loop";
import type { ContainerManager } from "../src/container/manager";
import type { TurboClawConfig } from "../src/config";
import type { SpawnOptions, ContainerInfo } from "../src/container/types";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait up to `timeoutMs` for `predicate` to return true, polling every `intervalMs`. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Build a minimal TurboClawConfig suitable for tests. */
function testConfig(overrides: Partial<TurboClawConfig> = {}): TurboClawConfig {
  const home = join(tmpdir(), `turboclaw-e2e-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, "memory"), { recursive: true });
  return {
    home,
    dbPath: ":memory:",
    gateway: { port: 0, host: "127.0.0.1" }, // port 0 = random
    orchestrator: {
      pollIntervalMs: 100, // fast polling for tests
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
    ...overrides,
  } as TurboClawConfig;
}

interface MockContainerCall {
  opts: SpawnOptions;
  resolve: (exitCode: number) => void;
}

/**
 * Creates a mock ContainerManager that records spawn calls and lets tests
 * control when containers "finish" and what output they produce.
 */
function createMockContainerManager(): {
  manager: ContainerManager;
  /** All spawn calls that have been made, in order. */
  calls: MockContainerCall[];
  /** Resolve the Nth spawn (0-indexed) with an exit code. Waits for streamLogs to register. */
  finish: (index: number, exitCode: number, stdoutLines?: string[]) => Promise<void>;
} {
  const calls: MockContainerCall[] = [];
  let idCounter = 0;

  // Per-container log callback so we can push lines from finish()
  const logCallbacks = new Map<string, (kind: "stdout" | "stderr", line: string) => void>();
  const logResolvers = new Map<string, (exitCode: number) => void>();

  const manager: ContainerManager = {
    async spawn(opts: SpawnOptions): Promise<ContainerInfo> {
      const containerId = `mock-${++idCounter}`;
      const call: MockContainerCall = {
        opts,
        resolve: () => {},
      };
      calls.push(call);
      return { containerId, taskId: opts.taskId, runId: opts.runId, status: "running", exitCode: null };
    },
    async kill() {},
    async inspect() { return null; },
    async streamLogs(containerId, onData) {
      logCallbacks.set(containerId, onData);
      return new Promise<number>((resolve) => {
        logResolvers.set(containerId, resolve);
      });
    },
    cancelStreamLogs() {},
    cancelAllStreamLogs() {},
    async cleanup() {},
    async ensureNetwork() {},
    async checkDockerAvailable() {},
  };

  /** Wait for streamLogs to be registered for a container, then emit lines and resolve. */
  async function finish(index: number, exitCode: number, stdoutLines: string[] = []) {
    const containerId = `mock-${index + 1}`;
    // Wait for streamLogs to register the callback (race between spawn and streamLogs)
    const deadline = Date.now() + 5000;
    while (!logResolvers.has(containerId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!logResolvers.has(containerId)) {
      throw new Error(`finish(${index}): streamLogs never registered for ${containerId}. Active resolvers: [${[...logResolvers.keys()].join(", ")}]`);
    }
    const cb = logCallbacks.get(containerId);
    if (cb) {
      for (const line of stdoutLines) {
        cb("stdout", line);
      }
    }
    const resolver = logResolvers.get(containerId);
    if (resolver) {
      resolver(exitCode);
    }
  }

  return { manager, calls, finish };
}

/** Make an HTTP request to the test server. */
async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("e2e: full task lifecycle", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let orchestrator: OrchestratorHandle;
  let mock: ReturnType<typeof createMockContainerManager>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    mock = createMockContainerManager();
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
    orchestrator = startOrchestrator(store, mock.manager, config);
  });

  afterEach(() => {
    orchestrator.stop();
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("health endpoint works", async () => {
    const { status, data } = await api(baseUrl, "GET", "/health");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("creates a task, orchestrator claims and runs it, task reaches done", async () => {
    // 1. Create task via API
    const { status, data: task } = await api(baseUrl, "POST", "/tasks", {
      title: "Fix the login bug",
      description: "Users cannot log in with email",
      priority: 5,
    });
    expect(status).toBe(201);
    expect(task.status).toBe("pending");

    // 2. Queue the task (normally the store creates as pending, user must queue)
    store.updateTaskStatus(task.id, "queued");

    // 3. Wait for orchestrator to claim it (spawns a mock container)
    await waitFor(() => mock.calls.length >= 1);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].opts.taskId).toBe(task.id);
    // The prompt contains the task description (or title if no description) plus protocol layers
    expect(mock.calls[0].opts.prompt).toContain("Users cannot log in with email");

    // 4. Task should now be running
    const { data: running } = await api(baseUrl, "GET", `/tasks/${task.id}`);
    expect(running.status).toBe("running");
    expect(running.latestRun).toBeDefined();
    expect(running.latestRun.status).toBe("running");

    // 5. Simulate container finishing successfully
    await mock.finish(0, 0, ["Login bug fixed. Changed auth.ts to handle email normalization."]);

    // 6. Wait for task to reach "done"
    await waitFor(() => {
      const t = store.getTask(task.id);
      return t?.status === "done";
    });

    // 7. Verify via API
    const { data: done } = await api(baseUrl, "GET", `/tasks/${task.id}`);
    expect(done.status).toBe("done");
    expect(done.latestRun.status).toBe("done");
    expect(done.latestRun.exit_code).toBe(0);

    // 8. Verify events were recorded
    const events = store.listEvents(done.latestRun.id);
    const stdoutEvents = events.filter((e) => e.kind === "stdout");
    expect(stdoutEvents.length).toBeGreaterThanOrEqual(1);
    expect(stdoutEvents.some((e) => e.payload.includes("Login bug fixed"))).toBe(true);
  });

  it("handles task failure and creates alert", async () => {
    const { data: task } = await api(baseUrl, "POST", "/tasks", {
      title: "Broken task",
      maxRetries: 0,
    });
    store.updateTaskStatus(task.id, "queued");

    await waitFor(() => mock.calls.length >= 1);

    // Simulate container crash
    await mock.finish(0, 1, []);

    await waitFor(() => {
      const t = store.getTask(task.id);
      return t?.status === "failed";
    });

    const { data: failed } = await api(baseUrl, "GET", `/tasks/${task.id}`);
    expect(failed.status).toBe("failed");

    // Alert should have been created
    const { data: alerts } = await api(baseUrl, "GET", "/alerts?acknowledged=false");
    const taskAlert = alerts.find((a: any) => a.kind === "task_failed" && a.task_id === task.id);
    expect(taskAlert).toBeDefined();
  });

  it(
    "retries failed task before marking as failed",
    async () => {
      const { data: task } = await api(baseUrl, "POST", "/tasks", {
        title: "Flaky task",
        maxRetries: 1,
      });
      store.updateTaskStatus(task.id, "queued");

      // First attempt — orchestrator claims it
      await waitFor(() => mock.calls.length >= 1);
      await mock.finish(0, 1); // fail first attempt

      // Wait for retry: the task gets re-queued and immediately claimed again.
      // Check retry_count instead of status since the orchestrator claims so fast.
      await waitFor(() => {
        const t = store.getTask(task.id);
        return t != null && t.retry_count === 1;
      });

      // Second attempt — orchestrator claims it again
      await waitFor(() => mock.calls.length >= 2);
      await mock.finish(1, 0, ["Success on retry"]);

      // Should reach done
      await waitFor(() => {
        const t = store.getTask(task.id);
        return t?.status === "done";
      });

      const { data: done } = await api(baseUrl, "GET", `/tasks/${task.id}`);
      expect(done.status).toBe("done");
    },
    15000,
  );

  it(
    "respects maxConcurrency",
    async () => {
      // Config allows maxConcurrency=2
      const { data: t1 } = await api(baseUrl, "POST", "/tasks", { title: "Task 1" });
      const { data: t2 } = await api(baseUrl, "POST", "/tasks", { title: "Task 2" });
      const { data: t3 } = await api(baseUrl, "POST", "/tasks", { title: "Task 3" });

      store.updateTaskStatus(t1.id, "queued");
      store.updateTaskStatus(t2.id, "queued");
      store.updateTaskStatus(t3.id, "queued");

      // Wait for 2 tasks to be claimed
      await waitFor(() => mock.calls.length >= 2);

      // Give the orchestrator a couple more ticks — it should NOT claim the 3rd
      await new Promise((r) => setTimeout(r, 400));
      expect(mock.calls).toHaveLength(2);

      // Finish one task to free a slot
      await mock.finish(0, 0);

      // Now the 3rd should get claimed
      await waitFor(() => mock.calls.length >= 3);
      expect(mock.calls).toHaveLength(3);

      // Finish remaining
      await mock.finish(1, 0);
      await mock.finish(2, 0);

      await waitFor(() => {
        return [t1.id, t2.id, t3.id].every((id) => store.getTask(id)?.status === "done");
      });
    },
    15000,
  );

  it("priority scheduling picks highest priority first", async () => {
    const { data: low } = await api(baseUrl, "POST", "/tasks", { title: "Low prio", priority: 1 });
    const { data: high } = await api(baseUrl, "POST", "/tasks", { title: "High prio", priority: 10 });

    store.updateTaskStatus(low.id, "queued");
    store.updateTaskStatus(high.id, "queued");

    await waitFor(() => mock.calls.length >= 1);

    // First claimed should be high priority
    expect(mock.calls[0].opts.taskId).toBe(high.id);
  });

  it("cancel prevents orchestrator from running the task", async () => {
    const { data: task } = await api(baseUrl, "POST", "/tasks", { title: "Cancel me" });
    store.updateTaskStatus(task.id, "queued");

    // Cancel before orchestrator can claim it
    await api(baseUrl, "POST", `/tasks/${task.id}/cancel`);

    // Wait a bit — orchestrator should NOT claim cancelled task
    await new Promise((r) => setTimeout(r, 500));
    expect(mock.calls).toHaveLength(0);

    const { data: cancelled } = await api(baseUrl, "GET", `/tasks/${task.id}`);
    expect(cancelled.status).toBe("cancelled");
  });
});

describe("e2e: cron scheduling", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let orchestrator: OrchestratorHandle;
  let mock: ReturnType<typeof createMockContainerManager>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    mock = createMockContainerManager();
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
    orchestrator = startOrchestrator(store, mock.manager, config);
  });

  afterEach(() => {
    orchestrator.stop();
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("cron fires and creates a queued task", async () => {
    // Create a cron that's already past due (next_run_at in the past)
    const { status, data: cron } = await api(baseUrl, "POST", "/crons", {
      name: "every-minute",
      schedule: "* * * * *",
      taskTemplate: { title: "Cron task", agentRole: "coder" },
    });
    expect(status).toBe(201);

    // The cron's next_run_at should be set. Force it to the past so it fires.
    const now = Math.floor(Date.now() / 1000);
    store.updateCronLastRun(cron.id, now - 120, now - 60);

    // Wait for the orchestrator's tickCrons to fire it
    await waitFor(() => {
      const tasks = store.listTasks({ status: "queued" });
      return tasks.some((t) => t.title === "Cron task");
    });

    const tasks = store.listTasks({ status: "queued" });
    expect(tasks.some((t) => t.title === "Cron task")).toBe(true);
  });
});

describe("e2e: pipeline stage advancement", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let orchestrator: OrchestratorHandle;
  let mock: ReturnType<typeof createMockContainerManager>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    mock = createMockContainerManager();
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
    orchestrator = startOrchestrator(store, mock.manager, config);
  });

  afterEach(() => {
    orchestrator.stop();
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it(
    "task advances through pipeline stages",
    async () => {
      // Create pipeline with 2 stages (stages must be objects with `name`)
      const { data: pipeline } = await api(baseUrl, "POST", "/pipelines", {
        name: "build-deploy",
        stages: [{ name: "build" }, { name: "deploy" }],
      });

      // Create task in first stage
      const { data: task } = await api(baseUrl, "POST", "/tasks", {
        title: "Pipeline task",
        pipelineId: pipeline.id,
        stage: "build",
      });
      store.updateTaskStatus(task.id, "queued");

      // Wait for first stage to be claimed
      await waitFor(() => mock.calls.length >= 1);
      await mock.finish(0, 0, ["Build complete"]);

      // Wait for task to advance to next stage (it may already be claimed for "deploy")
      await waitFor(() => {
        const t = store.getTask(task.id);
        return t?.stage === "deploy";
      });

      // Second stage gets claimed
      await waitFor(() => mock.calls.length >= 2);
      await mock.finish(1, 0, ["Deploy complete"]);

      // Task should be done after final stage
      await waitFor(() => {
        const t = store.getTask(task.id);
        return t?.status === "done";
      });
    },
    15000,
  );
});

describe("e2e: SSE event streaming via HTTP", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let orchestrator: OrchestratorHandle;
  let mock: ReturnType<typeof createMockContainerManager>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    mock = createMockContainerManager();
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
    orchestrator = startOrchestrator(store, mock.manager, config);
  });

  afterEach(() => {
    orchestrator.stop();
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("streams run events via SSE", async () => {
    const { data: task } = await api(baseUrl, "POST", "/tasks", { title: "SSE test" });
    store.updateTaskStatus(task.id, "queued");

    await waitFor(() => mock.calls.length >= 1);

    // Get the run ID
    const { data: detail } = await api(baseUrl, "GET", `/tasks/${task.id}`);
    const runId = detail.latestRun.id;

    // Finish with output
    await mock.finish(0, 0, ["Line 1", "Line 2"]);

    await waitFor(() => {
      const t = store.getTask(task.id);
      return t?.status === "done";
    });

    // Now fetch SSE stream — run is already done so it should close quickly
    const res = await fetch(`${baseUrl}/runs/${runId}/events`);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await res.text();
    expect(text).toContain("Line 1");
    expect(text).toContain("Line 2");
    expect(text).toContain('"kind":"done"');
  });
});

describe("e2e: status and queue depth", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("reflects queue depth accurately", async () => {
    const { data: s0 } = await api(baseUrl, "GET", "/status");
    expect(s0.queueDepth).toBe(0);

    const { data: t1 } = await api(baseUrl, "POST", "/tasks", { title: "A" });
    const { data: t2 } = await api(baseUrl, "POST", "/tasks", { title: "B" });
    store.updateTaskStatus(t1.id, "queued");
    store.updateTaskStatus(t2.id, "queued");

    const { data: s1 } = await api(baseUrl, "GET", "/status");
    expect(s1.queueDepth).toBe(2);
  });
});

describe("e2e: alerts and acknowledgement", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("full alert lifecycle: create, list, acknowledge", async () => {
    store.createAlert("task_failed", "Something went wrong", null);
    store.createAlert("lease_expired", "Worker timed out", null);

    const { data: all } = await api(baseUrl, "GET", "/alerts");
    expect(all).toHaveLength(2);

    // Acknowledge first alert
    await api(baseUrl, "POST", `/alerts/${all[0].id}/acknowledge`);

    const { data: unack } = await api(baseUrl, "GET", "/alerts?acknowledged=false");
    expect(unack).toHaveLength(1);
    expect(unack[0].message).toBe("Worker timed out");
  });
});

describe("e2e: search across task events", () => {
  let db: Database;
  let store: Store;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let config: TurboClawConfig;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
    config = testConfig();
    server = startGateway(store, config);
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    db.close();
    try { rmSync(config.home, { recursive: true, force: true }); } catch {}
  });

  it("FTS5 search finds events by keyword", async () => {
    const task = store.createTask({ title: "Search test" });
    const run = store.createRun(task.id);
    store.addEvent(run.id, "stdout", "Refactored the authentication module successfully");
    store.addEvent(run.id, "stdout", "Fixed database connection pooling");

    const { data: results } = await api(baseUrl, "GET", "/search?q=authentication");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].taskTitle).toBe("Search test");
    expect(results[0].snippets.some((s: string) => s.includes("authentication"))).toBe(true);
  });
});
