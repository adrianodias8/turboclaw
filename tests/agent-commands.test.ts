import { describe, it, expect } from "bun:test";
import {
  buildAgentCommand,
  getAgentEnvVars,
  resolveOpenCodeModel,
} from "../src/container/agent-commands";

describe("buildAgentCommand", () => {
  it("returns opencode command with {model} and {prompt} placeholders", () => {
    const cmd = buildAgentCommand("opencode");
    expect(cmd).toContain("{model}");
    expect(cmd).toContain("{prompt}");
    expect(cmd[0]).toBe("opencode");
  });

  it("returns claude command with {prompt} placeholder", () => {
    const cmd = buildAgentCommand("claude-code");
    expect(cmd).toContain("{prompt}");
    expect(cmd[0]).toBe("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("{model}");
  });

  it("returns codex command with {prompt} placeholder", () => {
    const cmd = buildAgentCommand("codex");
    expect(cmd).toContain("{prompt}");
    expect(cmd[0]).toBe("codex");
    expect(cmd).not.toContain("{model}");
  });
});

describe("getAgentEnvVars", () => {
  it("sets OPENCODE_BROWSER_BACKEND for opencode", () => {
    const vars = getAgentEnvVars("opencode");
    expect(vars.OPENCODE_BROWSER_BACKEND).toBe("agent");
  });

  it("sets CLAUDE_CODE_DISABLE_NONINTERACTIVE_CHECK for claude-code", () => {
    const vars = getAgentEnvVars("claude-code");
    expect(vars.CLAUDE_CODE_DISABLE_NONINTERACTIVE_CHECK).toBe("1");
    expect(vars.OPENCODE_BROWSER_BACKEND).toBeUndefined();
  });

  it("returns empty object for codex", () => {
    const vars = getAgentEnvVars("codex");
    expect(Object.keys(vars)).toHaveLength(0);
  });
});

describe("resolveOpenCodeModel", () => {
  it("resolves anthropic provider to anthropic/ prefix", () => {
    expect(resolveOpenCodeModel({ type: "anthropic" }))
      .toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("resolves anthropic with custom model", () => {
    expect(resolveOpenCodeModel({ type: "anthropic", model: "claude-opus-4-20250514" }))
      .toBe("anthropic/claude-opus-4-20250514");
  });

  it("passes through model with existing slash", () => {
    expect(resolveOpenCodeModel({ type: "anthropic", model: "anthropic/claude-opus-4-20250514" }))
      .toBe("anthropic/claude-opus-4-20250514");
  });

  it("resolves openai provider", () => {
    expect(resolveOpenCodeModel({ type: "openai" })).toBe("openai/gpt-4o");
  });

  it("resolves chatgpt as openai", () => {
    expect(resolveOpenCodeModel({ type: "chatgpt" })).toBe("openai/gpt-4o");
  });

  it("resolves ollama provider", () => {
    expect(resolveOpenCodeModel({ type: "ollama" })).toBe("ollama/qwen3-coder");
  });

  it("resolves ollama with custom model", () => {
    expect(resolveOpenCodeModel({ type: "ollama", model: "llama3" }))
      .toBe("ollama/llama3");
  });

  it("resolves copilot provider", () => {
    expect(resolveOpenCodeModel({ type: "copilot" })).toBe("copilot/gpt-4o");
  });

  it("resolves claude-code provider as anthropic", () => {
    expect(resolveOpenCodeModel({ type: "claude-code" }))
      .toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("resolves claude-sub provider as anthropic", () => {
    expect(resolveOpenCodeModel({ type: "claude-sub" }))
      .toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("resolves codex provider as openai", () => {
    expect(resolveOpenCodeModel({ type: "codex" })).toBe("openai/gpt-4o");
  });

  it("resolves custom provider", () => {
    expect(resolveOpenCodeModel({ type: "custom" })).toBe("custom/default");
    expect(resolveOpenCodeModel({ type: "custom", model: "my-model" }))
      .toBe("custom/my-model");
  });

  it("uses fallback for unknown provider", () => {
    expect(resolveOpenCodeModel({ type: "unknown" }))
      .toBe("anthropic/claude-sonnet-4-20250514");
    expect(resolveOpenCodeModel({ type: "unknown", model: "foo/bar" }))
      .toBe("foo/bar");
  });
});
