import { describe, it, expect } from "bun:test";
import { DEFAULT_CONTAINER_CONFIG } from "../src/container/types";
import type { SpawnOptions } from "../src/container/types";

describe("container types", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_CONTAINER_CONFIG.image).toBe("turboclaw-worker:latest");
    expect(DEFAULT_CONTAINER_CONFIG.openCodeImage).toBe("turboclaw-opencode:latest");
    expect(DEFAULT_CONTAINER_CONFIG.network).toBe("turboclaw-net");
    expect(DEFAULT_CONTAINER_CONFIG.memoryLimit).toBe("2g");
    expect(DEFAULT_CONTAINER_CONFIG.cpuLimit).toBe("2");
  });

  it("default agentCommand contains {model} and {prompt} placeholders", () => {
    expect(DEFAULT_CONTAINER_CONFIG.agentCommand).toContain("{model}");
    expect(DEFAULT_CONTAINER_CONFIG.agentCommand).toContain("{prompt}");
  });

  it("SpawnOptions shape is valid", () => {
    const opts: SpawnOptions = {
      taskId: "abc-123",
      runId: "run-456",
      workspacePath: "/tmp/workspace",
      agentRole: "coder",
      prompt: "Fix the login bug",
      envVars: { ANTHROPIC_API_KEY: "sk-test" },
    };
    expect(opts.taskId).toBe("abc-123");
    expect(opts.mountProjectSource).toBeUndefined();
    expect(opts.memoryVaultPath).toBeUndefined();
    expect(opts.agentType).toBeUndefined();
  });

  it("SpawnOptions supports self-improve mount", () => {
    const opts: SpawnOptions = {
      taskId: "abc-123",
      runId: "run-456",
      workspacePath: "/tmp/workspace",
      agentRole: "self-improve",
      prompt: "Improve error handling",
      envVars: {},
      mountProjectSource: "/home/user/turboclaw",
      memoryVaultPath: "/home/user/.turboclaw/memory",
    };
    expect(opts.mountProjectSource).toBe("/home/user/turboclaw");
    expect(opts.memoryVaultPath).toBe("/home/user/.turboclaw/memory");
  });

  it("SpawnOptions supports agentType field", () => {
    const opts: SpawnOptions = {
      taskId: "abc-123",
      runId: "run-456",
      workspacePath: "/tmp/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentType: "opencode",
    };
    expect(opts.agentType).toBe("opencode");

    const opts2: SpawnOptions = {
      ...opts,
      agentType: "claude-code",
    };
    expect(opts2.agentType).toBe("claude-code");
  });
});
