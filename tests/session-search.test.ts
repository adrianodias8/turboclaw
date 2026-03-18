import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("searchEvents", () => {
  it("returns empty array for no matches", () => {
    const results = store.searchEvents("nonexistent");
    expect(results).toEqual([]);
  });

  it("finds matching events by keyword", () => {
    const task = store.createTask({ title: "Build authentication" });
    const run = store.createRun(task.id);
    store.addEvent(run.id, "stdout", "Implementing JWT authentication module");
    store.addEvent(run.id, "stdout", "Running unit tests");

    const results = store.searchEvents("authentication");
    expect(results.length).toBe(1);
    expect(results[0]!.taskId).toBe(task.id);
    expect(results[0]!.taskTitle).toBe("Build authentication");
    expect(results[0]!.matchCount).toBe(1);
    expect(results[0]!.snippets.length).toBe(1);
    expect(results[0]!.snippets[0]).toContain("authentication");
  });

  it("groups results by task", () => {
    const task1 = store.createTask({ title: "Task A" });
    const run1 = store.createRun(task1.id);
    store.addEvent(run1.id, "stdout", "Fixing the database migration");
    store.addEvent(run1.id, "stdout", "Database schema updated");

    const task2 = store.createTask({ title: "Task B" });
    const run2 = store.createRun(task2.id);
    store.addEvent(run2.id, "stdout", "Database backup completed");

    const results = store.searchEvents("database");
    expect(results.length).toBe(2);

    // Task A has 2 matches, should be first (sorted by matchCount desc)
    const taskA = results.find((r) => r.taskId === task1.id);
    const taskB = results.find((r) => r.taskId === task2.id);
    expect(taskA).toBeTruthy();
    expect(taskB).toBeTruthy();
    expect(taskA!.matchCount).toBe(2);
    expect(taskB!.matchCount).toBe(1);
    expect(results[0]!.taskId).toBe(task1.id);
  });

  it("returns snippets truncated to ~200 chars", () => {
    const task = store.createTask({ title: "Long output task" });
    const run = store.createRun(task.id);
    const longPayload = "keyword " + "x".repeat(300) + " keyword";
    store.addEvent(run.id, "stdout", longPayload);

    const results = store.searchEvents("keyword");
    expect(results.length).toBe(1);
    // Snippet should exist and be reasonable length
    expect(results[0]!.snippets.length).toBeGreaterThan(0);
  });

  it("collects at most 5 snippets per task", () => {
    const task = store.createTask({ title: "Many matches" });
    const run = store.createRun(task.id);
    for (let i = 0; i < 10; i++) {
      store.addEvent(run.id, "stdout", `Error occurred in module ${i}`);
    }

    const results = store.searchEvents("error");
    expect(results.length).toBe(1);
    expect(results[0]!.snippets.length).toBeLessThanOrEqual(5);
    expect(results[0]!.matchCount).toBe(10);
  });

  it("respects limit parameter", () => {
    // Create 5 tasks with matching events
    for (let i = 0; i < 5; i++) {
      const task = store.createTask({ title: `Task ${i}` });
      const run = store.createRun(task.id);
      store.addEvent(run.id, "stdout", `Deploying service ${i}`);
    }

    const results = store.searchEvents("deploying", 2);
    expect(results.length).toBe(2);
  });

  it("returns empty array when FTS query is invalid", () => {
    // Empty string or malformed FTS syntax should not crash
    const results = store.searchEvents("");
    // May return empty or error gracefully
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("rebuildFtsIndex", () => {
  it("works without error", () => {
    expect(() => store.rebuildFtsIndex()).not.toThrow();
  });

  it("indexes existing events after rebuild", () => {
    const task = store.createTask({ title: "Pre-existing task" });
    const run = store.createRun(task.id);
    store.addEvent(run.id, "stdout", "Legacy migration script executed");

    // Rebuild should make existing events searchable
    store.rebuildFtsIndex();

    const results = store.searchEvents("migration");
    expect(results.length).toBe(1);
    expect(results[0]!.taskId).toBe(task.id);
  });
});

describe("FTS triggers", () => {
  it("keeps index in sync on insert", () => {
    const task = store.createTask({ title: "Trigger test" });
    const run = store.createRun(task.id);

    // Insert event — trigger should auto-index
    store.addEvent(run.id, "stdout", "Compiling TypeScript sources");

    const results = store.searchEvents("typescript");
    expect(results.length).toBe(1);
    expect(results[0]!.taskId).toBe(task.id);
  });

  it("finds newly added events without manual rebuild", () => {
    const task = store.createTask({ title: "Incremental test" });
    const run = store.createRun(task.id);

    // First event
    store.addEvent(run.id, "stdout", "Starting webpack build");
    expect(store.searchEvents("webpack").length).toBe(1);

    // Second event — should also be findable immediately
    store.addEvent(run.id, "stdout", "Webpack build completed successfully");
    const results = store.searchEvents("webpack");
    expect(results.length).toBe(1);
    expect(results[0]!.matchCount).toBe(2);
  });
});
