import { describe, it, expect } from "bun:test";
import { remapHomePath, rewriteLocalhostUrls } from "../src/container/utils";

describe("remapHomePath", () => {
  it("remaps host HOME path to container HOME", () => {
    expect(remapHomePath("/Users/foo/.config/opencode", "/Users/foo"))
      .toBe("/home/agent/.config/opencode");
  });

  it("remaps nested path under HOME", () => {
    expect(remapHomePath("/Users/foo/.local/share/opencode/db.sqlite", "/Users/foo"))
      .toBe("/home/agent/.local/share/opencode/db.sqlite");
  });

  it("passes through non-matching paths unchanged", () => {
    expect(remapHomePath("/etc/ssl/certs", "/Users/foo"))
      .toBe("/etc/ssl/certs");
  });

  it("supports custom container home", () => {
    expect(remapHomePath("/home/dev/.config/app", "/home/dev", "/root"))
      .toBe("/root/.config/app");
  });

  it("handles exact HOME path (no trailing component)", () => {
    expect(remapHomePath("/Users/foo", "/Users/foo"))
      .toBe("/home/agent");
  });
});

describe("rewriteLocalhostUrls", () => {
  it("rewrites 127.0.0.1 URLs", () => {
    expect(rewriteLocalhostUrls("http://127.0.0.1:11434/api"))
      .toBe("http://host.docker.internal:11434/api");
  });

  it("rewrites localhost URLs", () => {
    expect(rewriteLocalhostUrls("http://localhost:3000/health"))
      .toBe("http://host.docker.internal:3000/health");
  });

  it("rewrites multiple occurrences", () => {
    const input = '{"ollama": "http://127.0.0.1:11434", "api": "http://localhost:8080"}';
    const result = rewriteLocalhostUrls(input);
    expect(result).toContain("http://host.docker.internal:11434");
    expect(result).toContain("http://host.docker.internal:8080");
    expect(result).not.toContain("127.0.0.1");
    expect(result).not.toContain("localhost");
  });

  it("passes through non-matching text unchanged", () => {
    const input = "https://api.anthropic.com/v1/messages";
    expect(rewriteLocalhostUrls(input)).toBe(input);
  });

  it("does not rewrite https URLs", () => {
    const input = "https://localhost:443/secure";
    expect(rewriteLocalhostUrls(input)).toBe(input);
  });
});
