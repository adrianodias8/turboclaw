import { describe, it, expect } from "bun:test";
import { resolveCredentialPaths } from "../src/container/credentials";

describe("resolveCredentialPaths", () => {
  it("returns paths for copilot provider", () => {
    const paths = resolveCredentialPaths("copilot");
    // May or may not find files depending on host; should not throw
    expect(Array.isArray(paths)).toBe(true);
  });

  it("returns paths for chatgpt provider", () => {
    const paths = resolveCredentialPaths("chatgpt");
    expect(Array.isArray(paths)).toBe(true);
  });

  it("returns paths for claude-sub provider", () => {
    const paths = resolveCredentialPaths("claude-sub");
    expect(Array.isArray(paths)).toBe(true);
  });

  it("returns no provider-specific paths for api-key providers", () => {
    // May include ~/.config/opencode as a common path if it exists on the host
    const anthropicPaths = resolveCredentialPaths("anthropic");
    expect(anthropicPaths.every(p => p.includes("opencode"))).toBe(true);
    const openaiPaths = resolveCredentialPaths("openai");
    expect(openaiPaths.every(p => p.includes("opencode"))).toBe(true);
  });

  it("returns no provider-specific paths for ollama", () => {
    const paths = resolveCredentialPaths("ollama");
    expect(paths.every(p => p.includes("opencode"))).toBe(true);
  });

  it("returns no provider-specific paths for unknown provider", () => {
    const paths = resolveCredentialPaths("unknown");
    expect(paths.every(p => p.includes("opencode"))).toBe(true);
  });
});
