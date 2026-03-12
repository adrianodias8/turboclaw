import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("pipelines", () => {
  it("creates and retrieves a pipeline", () => {
    const p = store.createPipeline({ name: "test-pipeline", stages: ["build", "deploy"] });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("test-pipeline");
    expect(JSON.parse(p.stages)).toEqual(["build", "deploy"]);

    const fetched = store.getPipeline(p.id);
    expect(fetched).toEqual(p);
  });

  it("lists pipelines", () => {
    store.createPipeline({ name: "a", stages: [] });
    store.createPipeline({ name: "b", stages: [] });
    expect(store.listPipelines()).toHaveLength(2);
  });
});

describe("tasks", () => {
  it("creates a task with defaults", () => {
    const t = store.createTask({ title: "Fix login bug" });
    expect(t.id).toBeTruthy();
    expect(t.title).toBe("Fix login bug");
    expect(t.status).toBe("pending");
    expect(t.agent_role).toBe("coder");
    expect(t.priority).toBe(0);
    expect(t.max_retries).toBe(3);
    expect(t.retry_count).toBe(0);
  });

  it("creates a task with all fields", () => {
    const p = store.createPipeline({ name: "p", stages: ["s1"] });
    const t = store.createTask({
      pipelineId: p.id,
      stage: "s1",
      title: "Deploy",
      description: "Deploy to staging",
      agentRole: "reviewer",
      priority: 10,
      maxRetries: 5,
    });
    expect(t.pipeline_id).toBe(p.id);
    expect(t.stage).toBe("s1");
    expect(t.description).toBe("Deploy to staging");
    expect(t.agent_role).toBe("reviewer");
    expect(t.priority).toBe(10);
    expect(t.max_retries).toBe(5);
  });

  it("gets a task by id", () => {
    const t = store.createTask({ title: "test" });
    expect(store.getTask(t.id)).toEqual(t);
    expect(store.getTask("nonexistent")).toBeNull();
  });

  it("lists tasks with filters", () => {
    store.createTask({ title: "a", priority: 5 });
    store.createTask({ title: "b", priority: 10 });
    store.createTask({ title: "c", priority: 1 });

    const all = store.listTasks();
    expect(all).toHaveLength(3);
    // Ordered by priority DESC
    expect(all[0]!.title).toBe("b");
    expect(all[1]!.title).toBe("a");

    // With limit
    expect(store.listTasks({ limit: 2 })).toHaveLength(2);
  });

  it("updates task status", () => {
    const t = store.createTask({ title: "test" });
    const updated = store.updateTaskStatus(t.id, "queued");
    expect(updated!.status).toBe("queued");
  });

  it("cancels a task", () => {
    const t = store.createTask({ title: "test" });
    const cancelled = store.cancelTask(t.id);
    expect(cancelled!.status).toBe("cancelled");

    // Cancel a non-existent task
    expect(store.cancelTask("nope")).toBeNull();
  });

  it("does not re-cancel a done task", () => {
    const t = store.createTask({ title: "test" });
    store.updateTaskStatus(t.id, "done");
    const result = store.cancelTask(t.id);
    expect(result!.status).toBe("done");
  });
});

describe("claim", () => {
  it("claims the highest priority queued task", () => {
    const t1 = store.createTask({ title: "low", priority: 1 });
    const t2 = store.createTask({ title: "high", priority: 10 });
    store.updateTaskStatus(t1.id, "queued");
    store.updateTaskStatus(t2.id, "queued");

    const claimed = store.claimNextTask("worker-1", 300);
    expect(claimed).toBeTruthy();
    expect(claimed!.task.title).toBe("high");
    expect(claimed!.task.status).toBe("running");
    expect(claimed!.run.task_id).toBe(t2.id);
    expect(claimed!.lease.worker).toBe("worker-1");
  });

  it("returns null when no tasks are queued", () => {
    expect(store.claimNextTask("worker-1", 300)).toBeNull();
  });

  it("claims a specific task by ID", () => {
    const t1 = store.createTask({ title: "a", priority: 1 });
    const t2 = store.createTask({ title: "b", priority: 10 });
    store.updateTaskStatus(t1.id, "queued");
    store.updateTaskStatus(t2.id, "queued");

    // Claim the lower-priority one specifically
    const claimed = store.claimTask(t1.id, "worker-1", 300);
    expect(claimed).toBeTruthy();
    expect(claimed!.task.id).toBe(t1.id);
    expect(claimed!.task.status).toBe("running");
  });

  it("returns null when claiming a non-queued task", () => {
    const t = store.createTask({ title: "pending" });
    expect(store.claimTask(t.id, "worker-1", 300)).toBeNull();
  });

  it("lists queued tasks", () => {
    const t1 = store.createTask({ title: "a" });
    const t2 = store.createTask({ title: "b" });
    store.updateTaskStatus(t1.id, "queued");
    // t2 stays pending

    const queued = store.listQueuedTasks();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBe(t1.id);
  });
});

describe("retry count", () => {
  it("increments retry count", () => {
    const t = store.createTask({ title: "test" });
    expect(t.retry_count).toBe(0);

    store.incrementRetryCount(t.id);
    const after1 = store.getTask(t.id);
    expect(after1!.retry_count).toBe(1);

    store.incrementRetryCount(t.id);
    const after2 = store.getTask(t.id);
    expect(after2!.retry_count).toBe(2);
  });
});

describe("runs", () => {
  it("creates and finishes a run", () => {
    const t = store.createTask({ title: "test" });
    const run = store.createRun(t.id);
    expect(run.task_id).toBe(t.id);
    expect(run.status).toBe("running");

    const finished = store.finishRun(run.id, "done", 0);
    expect(finished!.status).toBe("done");
    expect(finished!.exit_code).toBe(0);
    expect(finished!.finished_at).toBeTruthy();
  });

  it("gets latest run for a task", () => {
    const t = store.createTask({ title: "test" });
    store.createRun(t.id);
    const run2 = store.createRun(t.id);
    const latest = store.getLatestRun(t.id);
    expect(latest!.id).toBe(run2.id);
  });
});

describe("events", () => {
  it("adds and lists events", () => {
    const t = store.createTask({ title: "test" });
    const run = store.createRun(t.id);

    store.addEvent(run.id, "stdout", "Building...");
    store.addEvent(run.id, "stdout", "Done!");
    store.addEvent(run.id, "status", "completed");

    const events = store.listEvents(run.id);
    expect(events).toHaveLength(3);
    expect(events[0]!.payload).toBe("Building...");
    expect(events[2]!.kind).toBe("status");

    // After ID filter
    const after = store.listEvents(run.id, events[0]!.id);
    expect(after).toHaveLength(2);
  });
});

describe("artifacts", () => {
  it("creates and lists artifacts", () => {
    const t = store.createTask({ title: "test" });
    const run = store.createRun(t.id);

    const a = store.createArtifact({
      taskId: t.id,
      runId: run.id,
      name: "output.json",
      path: "/workspace/output.json",
      mimeType: "application/json",
      sizeBytes: 1024,
    });
    expect(a.name).toBe("output.json");

    const byTask = store.listArtifacts({ taskId: t.id });
    expect(byTask).toHaveLength(1);

    const byRun = store.listArtifacts({ runId: run.id });
    expect(byRun).toHaveLength(1);
  });
});

describe("gates", () => {
  it("creates and approves a gate", () => {
    const p = store.createPipeline({ name: "p", stages: ["a", "b"] });
    const gate = store.createGate(p.id, "a", "b");
    expect(gate.approved).toBe(0);

    const approved = store.approveGate(gate.id);
    expect(approved!.approved).toBe(1);
    expect(approved!.approved_at).toBeTruthy();
  });
});

describe("status", () => {
  it("reports queue depth and active workers", () => {
    expect(store.getQueueDepth()).toBe(0);
    expect(store.getActiveWorkerCount()).toBe(0);

    store.createTask({ title: "a" });
    store.createTask({ title: "b" });
    // pending tasks count toward queue
    expect(store.getQueueDepth()).toBe(2);
  });
});
