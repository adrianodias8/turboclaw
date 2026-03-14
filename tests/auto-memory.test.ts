import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { initVault } from "../src/memory/vault";
import { maybeCreateTaskMemory } from "../src/memory/auto-memory";
import type { Task } from "../src/tracker/types";

const TEST_VAULT = join(import.meta.dir, ".test-auto-memory-vault");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-test-001",
    pipeline_id: null,
    stage: null,
    title: "Fix the login bug in auth service",
    description: null,
    status: "done",
    agent_role: "coder",
    priority: 0,
    retry_count: 0,
    max_retries: 3,
    reply_jid: null,
    created_at: Math.floor(Date.now() / 1000),
  };
}

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  initVault({ vaultPath: TEST_VAULT });
});

afterEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
});

describe("UNHELPFUL_PATTERNS filtering", () => {
  const task = makeTask();

  it("rejects output starting with 'done'", () => {
    const output = "done. I've completed the task as requested. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).toBeNull();
  });

  it("rejects output starting with 'Done'", () => {
    const output = "Done with the changes you asked for. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).toBeNull();
  });

  it("rejects refusal patterns like 'I can't help with'", () => {
    const output = "I can't help with that request because it is outside my capabilities. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).toBeNull();
  });

  it("rejects 'I don't know' patterns", () => {
    const output = "I don't know how to solve this particular problem. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).toBeNull();
  });

  it("rejects 'outside the scope' patterns", () => {
    const output = "This is outside my scope and I cannot assist. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).toBeNull();
  });

  it("accepts substantive output", () => {
    const output = "I fixed the authentication middleware by adding a session expiry check before the redirect. The issue was that expired sessions were being redirected in a loop. " + "x".repeat(100);
    const result = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
  });

  it("rejects output that is too short regardless of content", () => {
    const result = maybeCreateTaskMemory(TEST_VAULT, task, "Fixed it.");
    expect(result).toBeNull();
  });
});
