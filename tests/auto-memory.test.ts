import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { maybeCreateTaskMemory } from "../src/memory/auto-memory";
import { initVault } from "../src/memory/vault";
import type { Task } from "../src/tracker/types";

let vaultPath: string;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-task-id-1234",
    pipeline_id: null,
    stage: null,
    title: "Check the weather in Brussels",
    description: "What is the weather in Brussels?",
    agent_role: "coder",
    priority: 0,
    status: "done",
    max_retries: 3,
    retry_count: 0,
    reply_jid: null,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "turboclaw-auto-memory-"));
  initVault({ vaultPath });
});

afterEach(() => {
  rmSync(vaultPath, { recursive: true, force: true });
});

describe("maybeCreateTaskMemory", () => {
  it("creates a task log note for sufficient output", () => {
    const task = makeTask();
    const output = "The weather in Brussels is 12°C and cloudy with a chance of rain in the afternoon.";
    const result = maybeCreateTaskMemory(vaultPath, task, output);

    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);

    const tasksDir = join(vaultPath, "tasks");
    const files = readdirSync(tasksDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("test-tas");
  });

  it("skips when output is too short", () => {
    const task = makeTask();
    const result = maybeCreateTaskMemory(vaultPath, task, "ok");
    expect(result).toBeNull();
  });

  it("skips when title is too short", () => {
    const task = makeTask({ title: "hi" });
    const output = "A".repeat(100);
    const result = maybeCreateTaskMemory(vaultPath, task, output);
    expect(result).toBeNull();
  });

  it("truncates long output", () => {
    const task = makeTask();
    const output = "A".repeat(1000);
    const result = maybeCreateTaskMemory(vaultPath, task, output);

    expect(result).not.toBeNull();
    const { readFileSync } = require("fs");
    const content = readFileSync(result!, "utf-8");
    expect(content).toContain("...");
  });

  it("generates auto-prefixed tags from title", () => {
    const task = makeTask({ title: "Check the weather in Brussels" });
    const output = "The weather in Brussels is 12°C and cloudy with a chance of rain.";
    const result = maybeCreateTaskMemory(vaultPath, task, output);

    expect(result).not.toBeNull();
    const { readFileSync } = require("fs");
    const content = readFileSync(result!, "utf-8");
    expect(content).toContain("auto-memory");
    expect(content).toContain("auto-check");
    expect(content).toContain("auto-weather");
    expect(content).toContain("auto-brussels");
  });
});
