/**
 * Memory context assembly tests.
 *
 * Tests buildCoreContext, buildAgentMemoryContext, buildContext, buildRulesContext,
 * buildRoleSkillContext, and detectLanguages.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { initVault, writeNote, invalidateNoteCache } from "../src/memory/vault";
import {
  buildCoreContext,
  buildAgentMemoryContext,
  buildContext,
  buildRulesContext,
  buildRoleSkillContext,
  detectLanguages,
} from "../src/memory/context";

const TEST_VAULT = join(import.meta.dir, ".test-vault-context");
const TEST_RULES = join(import.meta.dir, ".test-rules-context");
const TEST_SKILLS = join(import.meta.dir, ".test-skills-context");
const TEST_WORKSPACE = join(import.meta.dir, ".test-workspace-context");

function makeNote(id: string, title: string, type: string, tags: string[] = []): string {
  const ts = Math.floor(Date.now() / 1000);
  const tagStr = tags.length > 0 ? `\ntags:\n${tags.map(t => `  - ${t}`).join("\n")}` : "";
  return `---\nid: ${id}\ntitle: ${title}\ntype: ${type}\ncreated: ${ts}${tagStr}\n---\n\nContent for ${title}`;
}

beforeEach(() => {
  for (const dir of [TEST_VAULT, TEST_RULES, TEST_SKILLS, TEST_WORKSPACE]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
  initVault({ vaultPath: TEST_VAULT });
  mkdirSync(TEST_RULES, { recursive: true });
  mkdirSync(TEST_SKILLS, { recursive: true });
  mkdirSync(TEST_WORKSPACE, { recursive: true });
});

afterEach(() => {
  for (const dir of [TEST_VAULT, TEST_RULES, TEST_SKILLS, TEST_WORKSPACE]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  }
});

// =============================================================================
// buildCoreContext
// =============================================================================

describe("buildCoreContext", () => {
  it("returns empty string when no core notes exist", () => {
    const result = buildCoreContext(TEST_VAULT);
    expect(result).toBe("");
  });

  it("assembles core notes with titles", () => {
    writeNote(join(TEST_VAULT, "core", "identity.md"), makeNote("id1", "Identity", "core"));
    writeNote(join(TEST_VAULT, "core", "preferences.md"), makeNote("id2", "Preferences", "core"));
    invalidateNoteCache();

    const result = buildCoreContext(TEST_VAULT);
    expect(result).toContain("# Core Memory");
    expect(result).toContain("## Identity");
    expect(result).toContain("## Preferences");
  });

  it("truncates when exceeding 20KB limit", () => {
    // Create large core notes
    for (let i = 0; i < 10; i++) {
      const content = `---\nid: large-${i}\ntitle: Large Note ${i}\ntype: core\ncreated: 0\n---\n\n${"x".repeat(3000)}`;
      writeNote(join(TEST_VAULT, "core", `large-${i}.md`), content);
    }
    invalidateNoteCache();

    const result = buildCoreContext(TEST_VAULT);
    expect(result.length).toBeLessThanOrEqual(20000 + 100); // some slack for truncation message
    expect(result).toContain("[Core memory truncated");
  });
});

// =============================================================================
// buildAgentMemoryContext
// =============================================================================

describe("buildAgentMemoryContext", () => {
  it("returns empty string when no agent notes exist", () => {
    const result = buildAgentMemoryContext(TEST_VAULT);
    expect(result).toBe("");
  });

  it("assembles agent notes", () => {
    writeNote(join(TEST_VAULT, "agents", "insight1.md"), makeNote("a1", "Debug Insight", "agent"));
    invalidateNoteCache();

    const result = buildAgentMemoryContext(TEST_VAULT);
    expect(result).toContain("# Agent Memory");
    expect(result).toContain("## Debug Insight");
  });

  it("truncates agent memory at 4KB", () => {
    for (let i = 0; i < 5; i++) {
      const content = `---\nid: agent-${i}\ntitle: Agent Note ${i}\ntype: agent\ncreated: 0\n---\n\n${"y".repeat(1500)}`;
      writeNote(join(TEST_VAULT, "agents", `agent-${i}.md`), content);
    }
    invalidateNoteCache();

    const result = buildAgentMemoryContext(TEST_VAULT);
    expect(result.length).toBeLessThanOrEqual(4000 + 100);
    expect(result).toContain("[Agent memory truncated]");
  });

  it("skips non-agent notes in agents dir", () => {
    writeNote(join(TEST_VAULT, "agents", "not-agent.md"), makeNote("n1", "Not Agent", "fleeting"));
    invalidateNoteCache();

    const result = buildAgentMemoryContext(TEST_VAULT);
    expect(result).toBe("");
  });
});

// =============================================================================
// buildContext (search-based)
// =============================================================================

describe("buildContext", () => {
  it("returns empty string when no matching notes", () => {
    const result = buildContext(TEST_VAULT, "nonexistent query");
    expect(result).toBe("");
  });

  it("finds notes matching query keywords", () => {
    writeNote(join(TEST_VAULT, "tasks", "login-fix.md"),
      makeNote("t1", "Login Bug Fix", "fleeting", ["daily-2026-03-18"]));
    invalidateNoteCache();

    const result = buildContext(TEST_VAULT, "login bug");
    expect(result).toContain("# Relevant Memory Notes");
    expect(result).toContain("Login Bug Fix");
  });

  it("excludes core notes from search results", () => {
    writeNote(join(TEST_VAULT, "core", "identity.md"), makeNote("c1", "Login Identity", "core"));
    writeNote(join(TEST_VAULT, "tasks", "login-task.md"), makeNote("t1", "Login Task", "fleeting"));
    invalidateNoteCache();

    const result = buildContext(TEST_VAULT, "login");
    expect(result).toContain("Login Task");
    expect(result).not.toContain("Login Identity");
  });

  it("excludes agent notes from search results", () => {
    writeNote(join(TEST_VAULT, "agents", "login-insight.md"), makeNote("a1", "Login Insight", "agent"));
    invalidateNoteCache();

    const result = buildContext(TEST_VAULT, "login");
    expect(result).not.toContain("Login Insight");
  });

  it("limits results to maxNotes", () => {
    for (let i = 0; i < 10; i++) {
      writeNote(join(TEST_VAULT, "tasks", `task-${i}.md`),
        makeNote(`t${i}`, `Docker Task ${i}`, "fleeting"));
    }
    invalidateNoteCache();

    const result = buildContext(TEST_VAULT, "docker task", [], 3);
    const matches = (result.match(/## Docker Task/g) ?? []).length;
    expect(matches).toBeLessThanOrEqual(3);
  });

  it("deduplicates results from multiple search methods", () => {
    writeNote(join(TEST_VAULT, "tasks", "tagged.md"),
      makeNote("t1", "Tagged Note about docker", "fleeting", ["docker"]));
    invalidateNoteCache();

    // Search by both text and tag — should appear only once
    const result = buildContext(TEST_VAULT, "docker", ["docker"], 5);
    const matches = (result.match(/## Tagged Note/g) ?? []).length;
    expect(matches).toBe(1);
  });
});

// =============================================================================
// buildRulesContext
// =============================================================================

describe("buildRulesContext", () => {
  it("returns empty string when rules dir doesn't exist", () => {
    const result = buildRulesContext("/nonexistent/path");
    expect(result).toBe("");
  });

  it("returns empty when no rule files exist", () => {
    const result = buildRulesContext(TEST_RULES);
    expect(result).toBe("");
  });

  it("loads common rules", () => {
    mkdirSync(join(TEST_RULES, "common"), { recursive: true });
    writeFileSync(join(TEST_RULES, "common", "01-style.md"), "Use 2-space indentation.");

    const result = buildRulesContext(TEST_RULES);
    expect(result).toContain("# Coding Rules");
    expect(result).toContain("2-space indentation");
  });

  it("includes language-specific rules", () => {
    mkdirSync(join(TEST_RULES, "common"), { recursive: true });
    mkdirSync(join(TEST_RULES, "typescript"), { recursive: true });
    writeFileSync(join(TEST_RULES, "common", "01-general.md"), "General rule");
    writeFileSync(join(TEST_RULES, "typescript", "01-ts.md"), "Use strict mode");

    const result = buildRulesContext(TEST_RULES, ["typescript"]);
    expect(result).toContain("General rule");
    expect(result).toContain("strict mode");
  });

  it("ignores non-md files", () => {
    mkdirSync(join(TEST_RULES, "common"), { recursive: true });
    writeFileSync(join(TEST_RULES, "common", "notes.txt"), "Not a rule");
    writeFileSync(join(TEST_RULES, "common", "01-rule.md"), "Real rule");

    const result = buildRulesContext(TEST_RULES);
    expect(result).toContain("Real rule");
    expect(result).not.toContain("Not a rule");
  });
});

// =============================================================================
// buildRoleSkillContext
// =============================================================================

describe("buildRoleSkillContext", () => {
  it("returns empty string for missing role", () => {
    const result = buildRoleSkillContext(TEST_SKILLS, "nonexistent");
    expect(result).toBe("");
  });

  it("loads SKILL.md for role", () => {
    mkdirSync(join(TEST_SKILLS, "coder"), { recursive: true });
    writeFileSync(join(TEST_SKILLS, "coder", "SKILL.md"), "# Coder Skill\n\nWrite clean code.");

    const result = buildRoleSkillContext(TEST_SKILLS, "coder");
    expect(result).toContain("# Agent Role: coder");
    expect(result).toContain("Write clean code");
  });

  it("strips YAML frontmatter from skill", () => {
    mkdirSync(join(TEST_SKILLS, "reviewer"), { recursive: true });
    writeFileSync(join(TEST_SKILLS, "reviewer", "SKILL.md"),
      "---\nname: reviewer\ndescription: Code reviewer\n---\n\n# Review Steps\n\n1. Check style");

    const result = buildRoleSkillContext(TEST_SKILLS, "reviewer");
    expect(result).not.toContain("name: reviewer");
    expect(result).toContain("Review Steps");
    expect(result).toContain("Check style");
  });
});

// =============================================================================
// detectLanguages
// =============================================================================

describe("detectLanguages", () => {
  it("detects typescript from tsconfig.json", () => {
    writeFileSync(join(TEST_WORKSPACE, "tsconfig.json"), "{}");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("typescript");
  });

  it("detects typescript from package.json", () => {
    writeFileSync(join(TEST_WORKSPACE, "package.json"), "{}");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("typescript");
  });

  it("detects python from pyproject.toml", () => {
    writeFileSync(join(TEST_WORKSPACE, "pyproject.toml"), "[project]");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("python");
  });

  it("detects golang from go.mod", () => {
    writeFileSync(join(TEST_WORKSPACE, "go.mod"), "module example.com/app");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("golang");
  });

  it("detects rust from Cargo.toml", () => {
    writeFileSync(join(TEST_WORKSPACE, "Cargo.toml"), "[package]");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("rust");
  });

  it("deduplicates typescript from tsconfig + package.json", () => {
    writeFileSync(join(TEST_WORKSPACE, "tsconfig.json"), "{}");
    writeFileSync(join(TEST_WORKSPACE, "package.json"), "{}");
    const langs = detectLanguages(TEST_WORKSPACE);
    const tsCount = langs.filter(l => l === "typescript").length;
    expect(tsCount).toBe(1);
  });

  it("detects multiple languages", () => {
    writeFileSync(join(TEST_WORKSPACE, "package.json"), "{}");
    writeFileSync(join(TEST_WORKSPACE, "go.mod"), "module app");
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toContain("typescript");
    expect(langs).toContain("golang");
  });

  it("returns empty array for bare workspace", () => {
    const langs = detectLanguages(TEST_WORKSPACE);
    expect(langs).toEqual([]);
  });
});
