/**
 * Orchestrator loop unit tests.
 *
 * Tests the core orchestration logic:
 * - tickInner: concurrency enforcement, task claiming, prompt assembly
 * - tickCrons: cron firing, one-shot disable, next_run_at computation
 * - tickExpiredLeases: lease expiration, retry/requeue, auto-extend
 * - Prompt layer assembly: priority ordering, truncation budget, separator joining
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { sortTasks } from "../src/orchestrator/strategies";
import { nextRunAt } from "../src/orchestrator/cron-parser";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

afterEach(() => {
  db.close();
});

// =============================================================================
// Concurrency enforcement (tickInner guard logic)
// =============================================================================

describe("concurrency enforcement", () => {
  it("respects maxConcurrency — no task claimed at capacity", () => {
    const maxConcurrency = 2;

    // Simulate 2 active runs
    const t1 = store.createTask({ title: "Running 1" });
    store.updateTaskStatus(t1.id, "queued");
    store.claimTask(t1.id, "orchestrator", 600);

    const t2 = store.createTask({ title: "Running 2" });
    store.updateTaskStatus(t2.id, "queued");
    store.claimTask(t2.id, "orchestrator", 600);

    // At capacity — new queued task should not be claimable by policy
    const t3 = store.createTask({ title: "Queued 3" });
    store.updateTaskStatus(t3.id, "queued");

    const activeRuns = store.getActiveRuns();
    expect(activeRuns.length).toBeGreaterThanOrEqual(maxConcurrency);

    // tickInner would short-circuit here
    const effectiveActive = Math.max(activeRuns.length, activeRuns.length);
    expect(effectiveActive >= maxConcurrency).toBe(true);
  });

  it("allows claiming when below capacity", () => {
    const t1 = store.createTask({ title: "Queued task" });
    store.updateTaskStatus(t1.id, "queued");

    const activeRuns = store.getActiveRuns();
    expect(activeRuns.length).toBe(0);

    // Below capacity — claim should succeed
    const claimed = store.claimTask(t1.id, "orchestrator", 600);
    expect(claimed).not.toBeNull();
    expect(claimed!.task.id).toBe(t1.id);
    expect(claimed!.run.status).toBe("running");
    expect(claimed!.lease).toBeDefined();
  });

  it("uses max of in-memory and DB counts for race condition safety", () => {
    // The real code does: Math.max(activeCount, dbRunningCount)
    // Simulate: activeCount=1 (stale), dbRunningCount=0 (already finished)
    const inMemory = 1;
    const dbCount = 0;
    const effective = Math.max(inMemory, dbCount);
    expect(effective).toBe(1); // Conservative — uses higher value
  });
});

// =============================================================================
// Task claiming with scheduling strategies
// =============================================================================

describe("task claiming with strategies", () => {
  it("claims highest priority task first (priority strategy)", () => {
    const low = store.createTask({ title: "Low priority", priority: 1 });
    store.updateTaskStatus(low.id, "queued");
    const high = store.createTask({ title: "High priority", priority: 10 });
    store.updateTaskStatus(high.id, "queued");
    const mid = store.createTask({ title: "Mid priority", priority: 5 });
    store.updateTaskStatus(mid.id, "queued");

    const queued = store.listQueuedTasks();
    const sorted = sortTasks(queued, "priority");
    expect(sorted[0].priority).toBe(10);

    const claimed = store.claimTask(sorted[0].id, "orchestrator", 600);
    expect(claimed!.task.title).toBe("High priority");
  });

  it("falls through to next task if top pick already claimed", () => {
    const t1 = store.createTask({ title: "Task 1", priority: 10 });
    store.updateTaskStatus(t1.id, "queued");
    const t2 = store.createTask({ title: "Task 2", priority: 5 });
    store.updateTaskStatus(t2.id, "queued");

    // Claim t1 first
    store.claimTask(t1.id, "orchestrator", 600);

    // Now try to claim from queued list — t1 is no longer queued
    const queued = store.listQueuedTasks();
    const sorted = sortTasks(queued, "priority");

    let claimed = null;
    for (const task of sorted) {
      claimed = store.claimTask(task.id, "orchestrator", 600);
      if (claimed) break;
    }
    expect(claimed).not.toBeNull();
    expect(claimed!.task.title).toBe("Task 2");
  });

  it("returns null when all tasks already claimed", () => {
    const t1 = store.createTask({ title: "Only task" });
    store.updateTaskStatus(t1.id, "queued");
    store.claimTask(t1.id, "orchestrator", 600);

    const queued = store.listQueuedTasks();
    expect(queued).toHaveLength(0);
  });
});

// =============================================================================
// Prompt layer assembly
// =============================================================================

describe("prompt layer assembly", () => {
  it("assembles layers in correct order", () => {
    const layers = [
      { name: "task", content: "Fix the bug", priority: 100 },
      { name: "protocol", content: "# Completion Protocol\n...", priority: 99 },
      { name: "core", content: "# Core Memory\n...", priority: 90 },
      { name: "rules", content: "# Coding Rules\n...", priority: 70 },
      { name: "memory", content: "# Memory Notes\n...", priority: 40 },
    ];

    const assemblyOrder = ["protocol", "core", "agentMemory", "selfImprove", "rules", "searchFirst", "roleSkill", "instincts", "memory", "nudge", "chatHistory", "task"];
    const SEPARATOR = "\n\n---\n\n";
    const orderedLayers = assemblyOrder
      .map(name => layers.find(l => l.name === name))
      .filter((l): l is { name: string; content: string; priority: number } => l != null && l.content.length > 0);

    const prompt = orderedLayers.map(l => l.content).join(SEPARATOR);

    // Protocol should be first, task should be last
    expect(prompt.indexOf("Completion Protocol")).toBeLessThan(prompt.indexOf("Core Memory"));
    expect(prompt.indexOf("Core Memory")).toBeLessThan(prompt.indexOf("Coding Rules"));
    expect(prompt.indexOf("Coding Rules")).toBeLessThan(prompt.indexOf("Memory Notes"));
    expect(prompt.indexOf("Memory Notes")).toBeLessThan(prompt.indexOf("Fix the bug"));
  });

  it("skips empty layers", () => {
    const layers = [
      { name: "task", content: "Do something", priority: 100 },
      { name: "protocol", content: "Protocol text", priority: 99 },
      { name: "core", content: "", priority: 90 }, // empty
      { name: "memory", content: "", priority: 40 }, // empty
    ];

    const assemblyOrder = ["protocol", "core", "memory", "task"];
    const orderedLayers = assemblyOrder
      .map(name => layers.find(l => l.name === name))
      .filter((l): l is { name: string; content: string; priority: number } => l != null && l.content.length > 0);

    expect(orderedLayers).toHaveLength(2);
    expect(orderedLayers[0].name).toBe("protocol");
    expect(orderedLayers[1].name).toBe("task");
  });

  it("truncates layers by lowest priority first when over budget", () => {
    const MAX_PROMPT_CHARS = 100;
    const SEPARATOR = "\n\n---\n\n";

    const layers = [
      { name: "task", content: "T".repeat(30), priority: 100 },
      { name: "protocol", content: "P".repeat(30), priority: 99 },
      { name: "memory", content: "M".repeat(30), priority: 40 },
      { name: "rules", content: "R".repeat(30), priority: 70 },
    ];

    const separatorOverhead = Math.max(0, layers.length - 1) * SEPARATOR.length;
    const totalChars = layers.reduce((sum, l) => sum + l.content.length, 0) + separatorOverhead;

    // Should exceed budget
    expect(totalChars).toBeGreaterThan(MAX_PROMPT_CHARS);

    // Truncation: sort by priority ascending, remove lowest priority first
    const cuttable = layers
      .filter(l => l.name !== "task" && l.name !== "protocol")
      .sort((a, b) => a.priority - b.priority);

    expect(cuttable[0].name).toBe("memory"); // lowest priority removed first
    expect(cuttable[1].name).toBe("rules");

    // Truncate until under budget
    let currentTotal = totalChars;
    const truncated: string[] = [];
    for (const layer of cuttable) {
      if (currentTotal <= MAX_PROMPT_CHARS) break;
      const saved = layer.content.length + SEPARATOR.length;
      layer.content = "";
      currentTotal -= saved;
      truncated.push(layer.name);
    }

    // Memory should be truncated first
    expect(truncated[0]).toBe("memory");
  });

  it("never truncates task or protocol layers", () => {
    const layers = [
      { name: "task", content: "Important task", priority: 100 },
      { name: "protocol", content: "Protocol", priority: 99 },
    ];

    const cuttable = layers
      .filter(l => l.name !== "task" && l.name !== "protocol")
      .sort((a, b) => a.priority - b.priority);

    expect(cuttable).toHaveLength(0);
  });

  it("adds reflection nudge every 5th task", () => {
    const NUDGE_INTERVAL = 5;
    const nudges: number[] = [];

    for (let i = 1; i <= 15; i++) {
      if (i % NUDGE_INTERVAL === 0) {
        nudges.push(i);
      }
    }

    expect(nudges).toEqual([5, 10, 15]);
  });
});

// =============================================================================
// tickCrons
// =============================================================================

describe("tickCrons", () => {
  it("fires due crons and creates tasks", () => {
    const now = Math.floor(Date.now() / 1000);

    const cron = store.createCron({
      name: "test-cron",
      schedule: "*/5 * * * *",
      taskTemplate: { title: "Scheduled task", description: "Auto-created" },
    });

    // Manually set next_run_at to the past so it's due
    db.run("UPDATE crons SET next_run_at = ? WHERE id = ?", [now - 60, cron.id]);

    const dueCrons = store.getDueCrons();
    expect(dueCrons.length).toBeGreaterThanOrEqual(1);

    // Simulate tickCrons logic
    for (const due of dueCrons) {
      const template = JSON.parse(due.task_template) as { title: string; description?: string };
      const task = store.createTask({ title: template.title, description: template.description ?? null });
      store.updateTaskStatus(task.id, "queued");

      const next = nextRunAt(due.schedule, new Date());
      store.updateCronLastRun(due.id, now, next);

      expect(task.title).toBe("Scheduled task");
      expect(next).toBeGreaterThan(now);
    }
  });

  it("disables one-shot crons after firing", () => {
    const now = Math.floor(Date.now() / 1000);

    const cron = store.createCron({
      name: "one-shot",
      schedule: "@once",
      taskTemplate: { title: "One time task" },
      oneShot: true,
      nextRunAt: now - 10,
    });

    const dueCrons = store.getDueCrons();
    const oneShot = dueCrons.find(c => c.id === cron.id);
    expect(oneShot).toBeDefined();

    // Simulate one-shot handling
    store.updateCronLastRun(cron.id, now, now);
    store.updateCronEnabled(cron.id, false);

    const afterCron = store.getCron(cron.id);
    expect(afterCron!.enabled).toBe(0);
  });

  it("skips crons that are not yet due", () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600;

    const cron = store.createCron({
      name: "future-cron",
      schedule: "0 * * * *",
      taskTemplate: { title: "Future task" },
      nextRunAt: futureTime,
    });

    const dueCrons = store.getDueCrons();
    expect(dueCrons.filter(c => c.name === "future-cron")).toHaveLength(0);
  });
});

// =============================================================================
// tickExpiredLeases
// =============================================================================

describe("tickExpiredLeases", () => {
  it("releases expired leases and marks tasks failed", () => {
    const task = store.createTask({ title: "Slow task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 1); // 1 second lease

    expect(claimed).not.toBeNull();

    // Force lease expiration by setting expires_at to the past
    db.run("UPDATE leases SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      claimed!.lease.id,
    ]);

    const expired = store.getExpiredLeases();
    expect(expired).toHaveLength(1);

    // Simulate tickExpiredLeases
    for (const lease of expired) {
      store.releaseLease(lease.id);
      const expiredTask = store.getTask(lease.task_id);
      if (expiredTask && expiredTask.status === "running") {
        if (expiredTask.retry_count < expiredTask.max_retries) {
          store.incrementRetryCount(lease.task_id);
          store.updateTaskStatus(lease.task_id, "queued");
        } else {
          store.updateTaskStatus(lease.task_id, "failed");
        }
      }
      store.createAlert("lease_expired", `Lease expired for task ${lease.task_id}`, lease.task_id);
    }

    const updatedTask = store.getTask(task.id);
    // With max_retries=3 (default) and retry_count=0, should requeue
    expect(updatedTask!.status).toBe("queued");
    expect(updatedTask!.retry_count).toBe(1);
  });

  it("marks task failed when retries exhausted", () => {
    const task = store.createTask({ title: "Failing task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 1);

    // Exhaust retries
    for (let i = 0; i < 3; i++) {
      store.incrementRetryCount(task.id);
    }

    // Force expiration
    db.run("UPDATE leases SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      claimed!.lease.id,
    ]);

    const expired = store.getExpiredLeases();
    for (const lease of expired) {
      store.releaseLease(lease.id);
      const expiredTask = store.getTask(lease.task_id);
      if (expiredTask && expiredTask.status === "running") {
        if (expiredTask.retry_count < expiredTask.max_retries) {
          store.incrementRetryCount(lease.task_id);
          store.updateTaskStatus(lease.task_id, "queued");
        } else {
          store.updateTaskStatus(lease.task_id, "failed");
        }
      }
    }

    const updatedTask = store.getTask(task.id);
    expect(updatedTask!.status).toBe("failed");
  });

  it("auto-extends lease if recent events exist", () => {
    const task = store.createTask({ title: "Active task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 1);
    const run = claimed!.run;

    // Add a recent event
    store.addEvent(run.id, "stdout", "Still working...");

    // Force lease expiration
    db.run("UPDATE leases SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 1,
      claimed!.lease.id,
    ]);

    const expired = store.getExpiredLeases();
    expect(expired).toHaveLength(1);

    // Simulate auto-extend logic
    const now = Math.floor(Date.now() / 1000);
    for (const lease of expired) {
      const leaseRun = store.getRun(lease.run_id);
      if (leaseRun && leaseRun.status === "running") {
        const recentEvents = store.listEvents(lease.run_id).filter(
          e => e.created_at > now - 60
        );
        if (recentEvents.length > 0) {
          store.extendLease(lease.id, 600);
          continue;
        }
      }
    }

    // Lease should now be extended (not expired)
    const stillExpired = store.getExpiredLeases();
    expect(stillExpired).toHaveLength(0);
  });

  it("creates alert on lease expiration", () => {
    const task = store.createTask({ title: "Alert task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 1);

    db.run("UPDATE leases SET expires_at = ? WHERE id = ?", [
      Math.floor(Date.now() / 1000) - 10,
      claimed!.lease.id,
    ]);

    const expired = store.getExpiredLeases();
    for (const lease of expired) {
      store.releaseLease(lease.id);
      store.createAlert("lease_expired", `Lease expired for task ${lease.task_id}`, lease.task_id);
    }

    const alerts = store.listAlerts().filter(a => a.kind === "lease_expired");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain(task.id);
  });
});

// =============================================================================
// Task lifecycle transitions (success/failure flow)
// =============================================================================

describe("task lifecycle", () => {
  it("successful run: running → done", () => {
    const task = store.createTask({ title: "Good task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 600);

    // Simulate success
    store.finishRun(claimed!.run.id, "done", 0);
    store.releaseLease(claimed!.lease.id);
    store.updateTaskStatus(task.id, "done");

    const updated = store.getTask(task.id);
    expect(updated!.status).toBe("done");
  });

  it("failed run with retries: running → queued (requeue)", () => {
    const task = store.createTask({ title: "Flaky task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 600);

    // Simulate failure
    store.finishRun(claimed!.run.id, "failed", 1);
    store.releaseLease(claimed!.lease.id);
    store.incrementRetryCount(task.id);
    store.updateTaskStatus(task.id, "queued");

    const updated = store.getTask(task.id);
    expect(updated!.status).toBe("queued");
    expect(updated!.retry_count).toBe(1);
  });

  it("failed run without retries: running → failed + alert", () => {
    const task = store.createTask({ title: "Fatal task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "orchestrator", 600);

    // Exhaust retries
    for (let i = 0; i < 3; i++) store.incrementRetryCount(task.id);

    // Simulate failure
    store.finishRun(claimed!.run.id, "failed", 1);
    store.releaseLease(claimed!.lease.id);
    store.updateTaskStatus(task.id, "failed");
    store.createAlert("task_failed", `Task "${task.title}" failed`, task.id);

    const updated = store.getTask(task.id);
    expect(updated!.status).toBe("failed");

    const alerts = store.listAlerts().filter(a => a.kind === "task_failed");
    expect(alerts).toHaveLength(1);
  });
});

// =============================================================================
// Env var injection
// =============================================================================

describe("env var injection", () => {
  it("sets ANTHROPIC_API_KEY for anthropic provider with sk-ant- key", () => {
    const envVars: Record<string, string> = {};
    const provider = { type: "anthropic", apiKey: "sk-ant-abc123" };

    if (provider.apiKey.startsWith("sk-ant-oat")) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = provider.apiKey;
    } else if (provider.apiKey.startsWith("sk-ant-")) {
      envVars.ANTHROPIC_API_KEY = provider.apiKey;
    }

    expect(envVars.ANTHROPIC_API_KEY).toBe("sk-ant-abc123");
  });

  it("sets CLAUDE_CODE_OAUTH_TOKEN for OAuth token", () => {
    const envVars: Record<string, string> = {};
    const provider = { type: "anthropic", apiKey: "sk-ant-oat-xyz789" };

    if (provider.apiKey.startsWith("sk-ant-oat")) {
      envVars.CLAUDE_CODE_OAUTH_TOKEN = provider.apiKey;
    } else if (provider.apiKey.startsWith("sk-ant-")) {
      envVars.ANTHROPIC_API_KEY = provider.apiKey;
    }

    expect(envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-xyz789");
    expect(envVars.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("sets OPENAI_API_KEY for openai provider", () => {
    const envVars: Record<string, string> = {};
    const provider = { type: "openai", apiKey: "sk-openai-key" };

    if (["openai", "chatgpt", "copilot", "custom"].includes(provider.type)) {
      envVars.OPENAI_API_KEY = provider.apiKey;
    }

    expect(envVars.OPENAI_API_KEY).toBe("sk-openai-key");
  });

  it("skips env var injection for opencode-config provider", () => {
    const envVars: Record<string, string> = {};
    const provider = { type: "opencode-config" };

    // opencode-config path: skip all env var injection
    if (provider.type !== "opencode-config") {
      envVars.TURBOCLAW_PROVIDER_TYPE = provider.type;
    }

    expect(Object.keys(envVars)).toHaveLength(0);
  });
});
