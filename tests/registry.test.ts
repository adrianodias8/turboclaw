import { describe, it, expect, afterEach } from "bun:test";
import { createClawHubRegistry, createNSkillsRegistry } from "../src/skills/registry";
import type { SkillEntry } from "../src/skills/types";

/**
 * Tests for skills/registry.ts
 *
 * These tests use mocked fetch to avoid hitting real external APIs.
 * We intercept globalThis.fetch to return controlled responses.
 */

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, opts?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

describe("ClawhHub registry", () => {
  afterEach(() => restoreFetch());

  it("search returns skills from API response", async () => {
    mockFetch(async (url) => {
      if (url.includes("/v1/skills/search")) {
        return new Response(JSON.stringify({
          skills: [
            { name: "git-workflow", description: "Git best practices", slug: "git-workflow" },
            { name: "docker-deploy", description: "Docker deployment", slug: "docker-deploy" },
          ],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const results = await registry.search("git docker", 5);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe("git-workflow");
    expect(results[0].source).toBe("clawhub");
    expect(results[1].slug).toBe("docker-deploy");
  });

  it("search falls back to site API on primary failure", async () => {
    let apiCalled = false;
    let siteCalled = false;

    mockFetch(async (url) => {
      if (url.includes("/v1/skills/search")) {
        apiCalled = true;
        return new Response("Server error", { status: 500 });
      }
      if (url.includes("/api/search")) {
        siteCalled = true;
        return new Response(JSON.stringify({
          skills: [{ name: "fallback-skill", description: "Fallback", slug: "fallback" }],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const results = await registry.search("test", 5);

    expect(apiCalled).toBe(true);
    expect(siteCalled).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("fallback-skill");
  });

  it("search returns empty on both API failures", async () => {
    mockFetch(async () => new Response("Error", { status: 500 }));

    const registry = createClawHubRegistry();
    const results = await registry.search("test", 5);

    expect(results).toEqual([]);
  });

  it("search returns empty on network error", async () => {
    mockFetch(async () => {
      throw new Error("Network unreachable");
    });

    const registry = createClawHubRegistry();
    const results = await registry.search("test", 5);

    expect(results).toEqual([]);
  });

  it("search handles missing skills field gracefully", async () => {
    mockFetch(async (url) => {
      if (url.includes("/v1/skills/search")) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const results = await registry.search("test", 5);

    expect(results).toEqual([]);
  });

  it("fetch returns skill content from JSON response", async () => {
    mockFetch(async (url) => {
      if (url.includes("/content")) {
        return new Response(JSON.stringify({
          content: "---\nname: test\n---\n\n# Test Skill",
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const entry: SkillEntry = { name: "test", description: "Test", slug: "test", source: "clawhub" };
    const result = await registry.fetch(entry);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("test");
    expect(result!.content).toContain("# Test Skill");
    expect(result!.source).toBe("clawhub");
  });

  it("fetch returns skill content from raw markdown response", async () => {
    mockFetch(async (url) => {
      if (url.includes("/content")) {
        return new Response("---\nname: raw-skill\n---\n\n# Raw Skill\n\nDo things.", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const entry: SkillEntry = { name: "raw-skill", description: "Raw", slug: "raw-skill", source: "clawhub" };
    const result = await registry.fetch(entry);

    expect(result).not.toBeNull();
    expect(result!.content).toContain("# Raw Skill");
  });

  it("fetch falls back to second URL on first failure", async () => {
    let firstCalled = false;

    mockFetch(async (url) => {
      if (url.includes("/content")) {
        firstCalled = true;
        return new Response("Not found", { status: 404 });
      }
      if (url.includes("/raw")) {
        return new Response("---\nname: fallback\n---\n\n# Fallback", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createClawHubRegistry();
    const entry: SkillEntry = { name: "fb", description: "Fallback", slug: "fb", source: "clawhub" };
    const result = await registry.fetch(entry);

    expect(firstCalled).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.content).toContain("# Fallback");
  });

  it("fetch returns null when both URLs fail", async () => {
    mockFetch(async () => new Response("Not found", { status: 404 }));

    const registry = createClawHubRegistry();
    const entry: SkillEntry = { name: "missing", description: "Missing", slug: "missing", source: "clawhub" };
    const result = await registry.fetch(entry);

    expect(result).toBeNull();
  });

  it("fetch returns null on network error", async () => {
    mockFetch(async () => {
      throw new Error("Connection refused");
    });

    const registry = createClawHubRegistry();
    const entry: SkillEntry = { name: "err", description: "Error", slug: "err", source: "clawhub" };
    const result = await registry.fetch(entry);

    expect(result).toBeNull();
  });
});

describe("n-skills registry", () => {
  afterEach(() => restoreFetch());

  it("search loads index and filters by keywords", async () => {
    mockFetch(async (url) => {
      if (url.includes("skills-manifest.json")) {
        return new Response(JSON.stringify({
          skills: [
            { name: "docker-compose", description: "Docker compose workflows", path: "skills/docker-compose/SKILL.md" },
            { name: "git-rebase", description: "Git rebase strategies", path: "skills/git-rebase/SKILL.md" },
            { name: "typescript-config", description: "TypeScript configuration", path: "skills/typescript-config/SKILL.md" },
          ],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    const results = await registry.search("docker compose", 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("docker-compose");
    expect(results[0].source).toBe("n-skills");
  });

  it("search falls back to GitHub API directory listing", async () => {
    mockFetch(async (url) => {
      if (url.includes("skills-manifest.json")) {
        return new Response("Not found", { status: 404 });
      }
      if (url.includes("/contents/skills")) {
        return new Response(JSON.stringify([
          { name: "react-hooks", type: "dir" },
          { name: "vue-components", type: "dir" },
          { name: "README.md", type: "file" }, // should be filtered out
        ]), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    const results = await registry.search("react hooks", 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe("react-hooks");
  });

  it("search returns empty when index is unavailable", async () => {
    mockFetch(async () => new Response("Error", { status: 500 }));

    const registry = createNSkillsRegistry();
    const results = await registry.search("anything", 5);

    expect(results).toEqual([]);
  });

  it("search caches index across calls", async () => {
    let fetchCount = 0;
    mockFetch(async (url) => {
      if (url.includes("skills-manifest.json")) {
        fetchCount++;
        return new Response(JSON.stringify({
          skills: [{ name: "cached", description: "Cached skill", path: "skills/cached/SKILL.md" }],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    await registry.search("cached", 5);
    await registry.search("cached", 5);
    await registry.search("cached", 5);

    expect(fetchCount).toBe(1); // Index should only be fetched once
  });

  it("search respects limit", async () => {
    mockFetch(async (url) => {
      if (url.includes("skills-manifest.json")) {
        return new Response(JSON.stringify({
          skills: Array.from({ length: 20 }, (_, i) => ({
            name: `skill-${i}`,
            description: `Skill ${i} with docker`,
            path: `skills/skill-${i}/SKILL.md`,
          })),
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    const results = await registry.search("docker", 3);

    expect(results).toHaveLength(3);
  });

  it("search scores by keyword match count", async () => {
    mockFetch(async (url) => {
      if (url.includes("skills-manifest.json")) {
        return new Response(JSON.stringify({
          skills: [
            { name: "single-match", description: "docker stuff", path: "skills/single/SKILL.md" },
            { name: "docker-multi", description: "docker compose deploy", path: "skills/multi/SKILL.md" },
          ],
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    const results = await registry.search("docker compose deploy", 5);

    // Multi-match should rank higher
    expect(results[0].name).toBe("docker-multi");
  });

  it("fetch retrieves raw SKILL.md content", async () => {
    mockFetch(async (url) => {
      if (url.includes("skills/test-skill/SKILL.md")) {
        return new Response("---\nname: test-skill\n---\n\n# Test Skill Content", { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });

    const registry = createNSkillsRegistry();
    const entry: SkillEntry = {
      name: "test-skill",
      description: "Test",
      slug: "skills/test-skill/SKILL.md",
      source: "n-skills",
    };
    const result = await registry.fetch(entry);

    expect(result).not.toBeNull();
    expect(result!.name).toBe("test-skill");
    expect(result!.content).toContain("# Test Skill Content");
    expect(result!.source).toBe("n-skills");
  });

  it("fetch returns null on 404", async () => {
    mockFetch(async () => new Response("Not found", { status: 404 }));

    const registry = createNSkillsRegistry();
    const entry: SkillEntry = { name: "missing", description: "", slug: "skills/missing/SKILL.md", source: "n-skills" };
    const result = await registry.fetch(entry);

    expect(result).toBeNull();
  });

  it("fetch returns null on network error", async () => {
    mockFetch(async () => {
      throw new Error("Timeout");
    });

    const registry = createNSkillsRegistry();
    const entry: SkillEntry = { name: "err", description: "", slug: "skills/err/SKILL.md", source: "n-skills" };
    const result = await registry.fetch(entry);

    expect(result).toBeNull();
  });
});
