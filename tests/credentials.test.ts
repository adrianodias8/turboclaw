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

  it("returns empty for api-key providers", () => {
    expect(resolveCredentialPaths("anthropic")).toEqual([]);
    expect(resolveCredentialPaths("openai")).toEqual([]);
  });

  it("returns empty for ollama", () => {
    expect(resolveCredentialPaths("ollama")).toEqual([]);
  });

  it("returns empty for unknown provider", () => {
    expect(resolveCredentialPaths("unknown")).toEqual([]);
  });
});
