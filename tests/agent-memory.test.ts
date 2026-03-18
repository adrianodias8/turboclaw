import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { initVault } from "../src/memory/vault";
import {
  listAgentMemories,
  addAgentMemory,
  replaceAgentMemory,
  removeAgentMemory,
  getAgentMemoryBudget,
} from "../src/memory/agent-memory";
import { buildAgentMemoryContext } from "../src/memory/context";
import { parseFrontmatter } from "../src/memory/vault";

let testVault: string;

beforeEach(() => {
  testVault = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
  initVault({ vaultPath: testVault });
});

afterEach(() => {
  if (existsSync(testVault)) {
    rmSync(testVault, { recursive: true });
  }
});

describe("listAgentMemories", () => {
  it("returns empty array for empty vault", () => {
    const memories = listAgentMemories(testVault);
    expect(memories).toEqual([]);
  });
});

describe("addAgentMemory", () => {
  it("creates a file with correct frontmatter", () => {
    const result = addAgentMemory(testVault, "Docker Quirk", "Always use --network host", "task-123");
    expect(result.ok).toBe(true);

    const memories = listAgentMemories(testVault);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.frontmatter.title).toBe("Docker Quirk");
    expect(memories[0]!.frontmatter.type).toBe("agent");
    expect(memories[0]!.frontmatter.source).toBe("task-123");
    expect(memories[0]!.content).toContain("Always use --network host");
  });

  it("rejects when budget exceeded", () => {
    // Add a memory that uses up most of the budget (default 4000 chars)
    const bigContent = "x".repeat(3900);
    const result1 = addAgentMemory(testVault, "Big Note", bigContent, null);
    expect(result1.ok).toBe(true);

    // Try to add another that would exceed the budget
    const result2 = addAgentMemory(testVault, "Another Note", "x".repeat(200), null);
    expect(result2.ok).toBe(false);
    expect(result2.error).toContain("Budget exceeded");
  });

  it("rejects duplicate titles", () => {
    addAgentMemory(testVault, "My Insight", "first version", null);
    const result = addAgentMemory(testVault, "My Insight", "second version", null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("rejects duplicate titles case-insensitively", () => {
    addAgentMemory(testVault, "Docker Quirk", "content", null);
    const result = addAgentMemory(testVault, "docker quirk", "other content", null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });
});

describe("replaceAgentMemory", () => {
  it("updates content", () => {
    addAgentMemory(testVault, "Config Detail", "old content", null);
    const result = replaceAgentMemory(testVault, "Config Detail", "new content");
    expect(result.ok).toBe(true);

    const memories = listAgentMemories(testVault);
    expect(memories).toHaveLength(1);
    expect(memories[0]!.content).toContain("new content");
    expect(memories[0]!.content).not.toContain("old content");
  });

  it("matches title case-insensitively", () => {
    addAgentMemory(testVault, "Config Detail", "old content", null);
    const result = replaceAgentMemory(testVault, "config detail", "new content");
    expect(result.ok).toBe(true);
  });

  it("returns error for missing title", () => {
    const result = replaceAgentMemory(testVault, "Nonexistent", "content");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No memory found");
  });
});

describe("removeAgentMemory", () => {
  it("deletes the file", () => {
    addAgentMemory(testVault, "To Delete", "some content", null);
    expect(listAgentMemories(testVault)).toHaveLength(1);

    const result = removeAgentMemory(testVault, "To Delete");
    expect(result.ok).toBe(true);
    expect(listAgentMemories(testVault)).toHaveLength(0);
  });

  it("matches title case-insensitively", () => {
    addAgentMemory(testVault, "To Delete", "some content", null);
    const result = removeAgentMemory(testVault, "to delete");
    expect(result.ok).toBe(true);
    expect(listAgentMemories(testVault)).toHaveLength(0);
  });

  it("returns error for missing title", () => {
    const result = removeAgentMemory(testVault, "Nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No memory found");
  });
});

describe("getAgentMemoryBudget", () => {
  it("returns correct values for empty vault", () => {
    const budget = getAgentMemoryBudget(testVault);
    expect(budget.used).toBe(0);
    expect(budget.remaining).toBe(4000);
    expect(budget.max).toBe(4000);
  });

  it("returns correct values after adding memories", () => {
    addAgentMemory(testVault, "Note 1", "hello", null);
    const budget = getAgentMemoryBudget(testVault);
    // Content includes the "# Note 1\n\nhello" rendered by the template
    expect(budget.used).toBeGreaterThan(0);
    expect(budget.remaining).toBe(budget.max - budget.used);
    expect(budget.max).toBe(4000);
  });

  it("respects custom max chars", () => {
    const budget = getAgentMemoryBudget(testVault, 1000);
    expect(budget.max).toBe(1000);
    expect(budget.remaining).toBe(1000);
  });
});

describe("buildAgentMemoryContext", () => {
  it("returns empty string for empty vault", () => {
    const context = buildAgentMemoryContext(testVault);
    expect(context).toBe("");
  });

  it("returns formatted string with memories", () => {
    addAgentMemory(testVault, "Docker Quirk", "Always use --network host", null);
    addAgentMemory(testVault, "Test Pattern", "Use bun:test, not jest", null);

    const context = buildAgentMemoryContext(testVault);
    expect(context).toContain("# Agent Memory");
    expect(context).toContain("## Docker Quirk");
    expect(context).toContain("Always use --network host");
    expect(context).toContain("## Test Pattern");
    expect(context).toContain("Use bun:test, not jest");
  });

  it("truncates when over budget", () => {
    // The context builder has its own MAX_AGENT_MEMORY_CHARS (4000) limit.
    // note.content = "# Title\n\n{raw content}" (~12 + raw length).
    // Budget (addAgentMemory) counts note.content. Context builder wraps each
    // in "## Title\n\n{note.content}" adding ~13 chars per note, plus the
    // "# Agent Memory\n\n" header. So context is always larger than budget used.
    // We max out the budget then verify the context gets truncated.
    addAgentMemory(testVault, "A", "a".repeat(1985), null);
    addAgentMemory(testVault, "B", "b".repeat(1985), null);
    // Budget is now ~3980+ used (content includes "# A\n\n" prefix = ~5 extra per note)

    const memories = listAgentMemories(testVault);
    const totalContent = memories.reduce((sum, n) => sum + n.content.length, 0);
    // Ensure we actually have enough content for the context to exceed 4000
    expect(totalContent).toBeGreaterThan(3800);

    const context = buildAgentMemoryContext(testVault);
    // The context adds "# Agent Memory\n\n" + "## A\n\n" + content + "## B\n\n" + content
    // which pushes it over 4000
    expect(context).toContain("# Agent Memory");
    expect(context.length).toBeLessThanOrEqual(4200);
    expect(context).toContain("[Agent memory truncated]");
  });
});
