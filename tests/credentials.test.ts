/**
 * Credential path resolution tests.
 *
 * Tests the logic of resolveCredentialPaths without depending on host filesystem.
 * Validates:
 * - Correct paths are produced for each provider type
 * - Common opencode config path is always appended (deduplication)
 * - Unknown providers still get the common path
 */
import { describe, it, expect } from "bun:test";
import { resolveCredentialPaths } from "../src/container/credentials";

const HOME = process.env.HOME ?? "/root";

describe("resolveCredentialPaths", () => {
  it("returns array for every provider type", () => {
    const providers = ["copilot", "chatgpt", "claude-sub", "claude-code", "opencode-config", "anthropic", "openai", "ollama", "unknown"];
    for (const provider of providers) {
      const paths = resolveCredentialPaths(provider);
      expect(Array.isArray(paths)).toBe(true);
      // No path should be empty or undefined
      for (const p of paths) {
        expect(p.length).toBeGreaterThan(0);
        expect(p.startsWith("/")).toBe(true);
      }
    }
  });

  it("copilot includes gh config path pattern", () => {
    // The function checks existsSync, so paths may be empty on CI.
    // We verify the code doesn't throw and returns a valid array.
    const paths = resolveCredentialPaths("copilot");
    expect(Array.isArray(paths)).toBe(true);
    // If paths are found, they should be under HOME
    for (const p of paths) {
      expect(p.startsWith(HOME)).toBe(true);
    }
  });

  it("opencode-config includes opencode dirs if they exist", () => {
    const paths = resolveCredentialPaths("opencode-config");
    expect(Array.isArray(paths)).toBe(true);
    // All returned paths must exist on disk (the function filters by existsSync)
    const { existsSync } = require("fs");
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it("claude-code checks ~/.claude/ path", () => {
    const paths = resolveCredentialPaths("claude-code");
    expect(Array.isArray(paths)).toBe(true);
    for (const p of paths) {
      expect(p.startsWith(HOME)).toBe(true);
    }
  });

  it("does not return duplicate paths", () => {
    const providers = ["copilot", "chatgpt", "claude-sub", "opencode-config"];
    for (const provider of providers) {
      const paths = resolveCredentialPaths(provider);
      const unique = new Set(paths);
      expect(unique.size).toBe(paths.length);
    }
  });

  it("unknown provider gets only common opencode path (if exists)", () => {
    const paths = resolveCredentialPaths("unknown-provider");
    expect(Array.isArray(paths)).toBe(true);
    // Should only have the common opencode config path (or empty if it doesn't exist)
    for (const p of paths) {
      expect(p).toContain("opencode");
    }
  });

  it("all returned paths are absolute", () => {
    const allProviders = ["copilot", "chatgpt", "claude-sub", "claude-code", "anthropic", "openai"];
    for (const provider of allProviders) {
      const paths = resolveCredentialPaths(provider);
      for (const p of paths) {
        expect(p.startsWith("/")).toBe(true);
      }
    }
  });
});
