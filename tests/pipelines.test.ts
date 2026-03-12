import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { parseStages, getNextStage, advanceTask } from "../src/tracker/pipelines";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("parseStages", () => {
  it("parses stages from pipeline JSON", () => {
    const p = store.createPipeline({
      name: "deploy",
      stages: [
        { name: "code", description: "Write code" },
        { name: "review", description: "Review changes" },
        { name: "deploy", description: "Deploy" },
      ],
    });
    const stages = parseStages(p);
    expect(stages).toHaveLength(3);
    expect(stages[0]!.name).toBe("code");
    expect(stages[2]!.name).toBe("deploy");
  });
});

describe("getNextStage", () => {
  it("returns next stage", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    expect(getNextStage(p, "a")).toBe("b");
    expect(getNextStage(p, "b")).toBe("c");
  });

  it("returns null at last stage", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "a" }, { name: "b" }],
    });
    expect(getNextStage(p, "b")).toBeNull();
  });

  it("returns null for unknown stage", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "a" }],
    });
    expect(getNextStage(p, "z")).toBeNull();
  });
});

describe("advanceTask", () => {
  it("advances a task to the next stage and requeues", () => {
    const p = store.createPipeline({
      name: "deploy",
      stages: [{ name: "code" }, { name: "review" }, { name: "deploy" }],
    });
    const t = store.createTask({
      pipelineId: p.id,
      stage: "code",
      title: "Fix bug",
    });
    store.updateTaskStatus(t.id, "done"); // simulate completion

    const advanced = advanceTask(store, t.id);
    expect(advanced).not.toBeNull();
    expect(advanced!.status).toBe("queued");

    // Verify stage was updated
    const refreshed = store.getTask(t.id);
    expect(refreshed!.stage).toBe("review");
  });

  it("marks task done at final stage", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "only-stage" }],
    });
    const t = store.createTask({
      pipelineId: p.id,
      stage: "only-stage",
      title: "Test",
    });

    const result = advanceTask(store, t.id);
    expect(result!.status).toBe("done");
  });

  it("blocks on unapproved gate", () => {
    const p = store.createPipeline({
      name: "gated",
      stages: [{ name: "code" }, { name: "deploy" }],
    });
    store.createGate(p.id, "code", "deploy"); // unapproved gate

    const t = store.createTask({
      pipelineId: p.id,
      stage: "code",
      title: "Deploy task",
    });

    const result = advanceTask(store, t.id);
    expect(result).toBeNull(); // blocked by gate
  });

  it("advances through approved gate", () => {
    const p = store.createPipeline({
      name: "gated",
      stages: [{ name: "code" }, { name: "deploy" }],
    });
    const gate = store.createGate(p.id, "code", "deploy");
    store.approveGate(gate.id);

    const t = store.createTask({
      pipelineId: p.id,
      stage: "code",
      title: "Deploy task",
    });

    const result = advanceTask(store, t.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("queued");
  });

  it("returns null for task without pipeline", () => {
    const t = store.createTask({ title: "Standalone" });
    expect(advanceTask(store, t.id)).toBeNull();
  });
});

describe("store gate operations", () => {
  it("lists gates for a pipeline", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    store.createGate(p.id, "a", "b");
    store.createGate(p.id, "b", "c");

    const gates = store.listGates(p.id);
    expect(gates).toHaveLength(2);
  });

  it("gets a specific gate", () => {
    const p = store.createPipeline({
      name: "test",
      stages: [{ name: "a" }, { name: "b" }],
    });
    store.createGate(p.id, "a", "b");

    const gate = store.getGate(p.id, "a", "b");
    expect(gate).not.toBeNull();
    expect(gate!.from_stage).toBe("a");
    expect(gate!.to_stage).toBe("b");

    expect(store.getGate(p.id, "x", "y")).toBeNull();
  });

  it("sets task stage", () => {
    const t = store.createTask({ title: "test" });
    const updated = store.setTaskStage(t.id, "review");
    expect(updated!.stage).toBe("review");
  });
});
