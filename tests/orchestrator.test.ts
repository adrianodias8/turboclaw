import { describe, it, expect } from "bun:test";
import { sortTasks } from "../src/orchestrator/strategies";
import type { Task } from "../src/tracker/types";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: crypto.randomUUID(),
    pipeline_id: null,
    stage: null,
    title: "test",
    description: null,
    agent_role: "coder",
    priority: 0,
    status: "queued",
    max_retries: 3,
    retry_count: 0,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("scheduling strategies", () => {
  it("fifo sorts by created_at ascending", () => {
    const tasks = [
      makeTask({ title: "third", created_at: 3 }),
      makeTask({ title: "first", created_at: 1 }),
      makeTask({ title: "second", created_at: 2 }),
    ];
    const sorted = sortTasks(tasks, "fifo");
    expect(sorted.map((t) => t.title)).toEqual(["first", "second", "third"]);
  });

  it("priority sorts by priority descending, then created_at", () => {
    const tasks = [
      makeTask({ title: "low", priority: 1, created_at: 1 }),
      makeTask({ title: "high", priority: 10, created_at: 2 }),
      makeTask({ title: "high-old", priority: 10, created_at: 1 }),
      makeTask({ title: "mid", priority: 5, created_at: 3 }),
    ];
    const sorted = sortTasks(tasks, "priority");
    expect(sorted.map((t) => t.title)).toEqual(["high-old", "high", "mid", "low"]);
  });

  it("round-robin interleaves by agent role", () => {
    const tasks = [
      makeTask({ title: "coder-1", agent_role: "coder" }),
      makeTask({ title: "coder-2", agent_role: "coder" }),
      makeTask({ title: "reviewer-1", agent_role: "reviewer" }),
      makeTask({ title: "planner-1", agent_role: "planner" }),
    ];
    const sorted = sortTasks(tasks, "round-robin");
    // Should interleave: one from each role, then remaining
    expect(sorted).toHaveLength(4);
    // First 3 should be different roles
    const firstThreeRoles = new Set(sorted.slice(0, 3).map((t) => t.agent_role));
    expect(firstThreeRoles.size).toBe(3);
  });

  it("handles empty task list", () => {
    expect(sortTasks([], "fifo")).toEqual([]);
    expect(sortTasks([], "priority")).toEqual([]);
    expect(sortTasks([], "round-robin")).toEqual([]);
  });
});
