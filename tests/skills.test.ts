import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { extractKeywords } from "../src/skills/discovery";
import { createSkillCache } from "../src/skills/cache";
import type { SkillContent } from "../src/skills/types";

const TEST_DIR = join(import.meta.dir, ".test-skills-" + process.pid);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

describe("extractKeywords", () => {
  it("extracts meaningful words from a prompt", () => {
    const keywords = extractKeywords("Fix the login authentication bug in the API endpoint");
    expect(keywords).toContain("login");
    expect(keywords).toContain("authentication");
    expect(keywords).toContain("bug");
    expect(keywords).toContain("api");
    expect(keywords).toContain("endpoint");
  });

  it("filters out stop words", () => {
    const keywords = extractKeywords("I want to create a new file for the project");
    expect(keywords).not.toContain("want");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("create");
    expect(keywords).not.toContain("file");
    expect(keywords).not.toContain("project");
  });

  it("deduplicates keywords", () => {
    const keywords = extractKeywords("docker docker docker container container");
    expect(keywords.filter((k) => k === "docker")).toHaveLength(1);
    expect(keywords.filter((k) => k === "container")).toHaveLength(1);
  });

  it("limits keyword count", () => {
    const keywords = extractKeywords(
      "kubernetes helm chart deployment service ingress configmap secret volume persistentvolumeclaim statefulset daemonset",
      4,
    );
    expect(keywords.length).toBeLessThanOrEqual(4);
  });

  it("filters short words", () => {
    const keywords = extractKeywords("go to db and do it");
    expect(keywords).not.toContain("go");
    expect(keywords).not.toContain("to");
    expect(keywords).not.toContain("db");
    expect(keywords).not.toContain("do");
    expect(keywords).not.toContain("it");
  });

  it("returns empty for purely stop-word prompts", () => {
    const keywords = extractKeywords("please just do it for me");
    expect(keywords).toHaveLength(0);
  });
});

describe("SkillCache", () => {
  it("starts empty", () => {
    const cache = createSkillCache(TEST_DIR);
    expect(cache.list()).toHaveLength(0);
    expect(cache.has("nonexistent")).toBe(false);
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("stores and retrieves a skill", () => {
    const cache = createSkillCache(TEST_DIR);
    const skill: SkillContent = {
      name: "test-skill",
      content: "---\nname: test-skill\ndescription: A test skill\n---\n\n# Test Skill\n\nDo things.",
      source: "n-skills",
    };
    cache.put(skill);

    expect(cache.has("test-skill")).toBe(true);
    expect(cache.get("test-skill")).toBe(skill.content);
    expect(cache.list()).toEqual(["test-skill"]);
  });

  it("stores multiple skills", () => {
    const cache = createSkillCache(TEST_DIR);
    cache.put({ name: "alpha", content: "# Alpha", source: "clawhub" });
    cache.put({ name: "beta", content: "# Beta", source: "n-skills" });

    expect(cache.list()).toHaveLength(2);
    expect(cache.has("alpha")).toBe(true);
    expect(cache.has("beta")).toBe(true);
  });

  it("overwrites existing skill", () => {
    const cache = createSkillCache(TEST_DIR);
    cache.put({ name: "updatable", content: "v1", source: "clawhub" });
    expect(cache.get("updatable")).toBe("v1");

    cache.put({ name: "updatable", content: "v2", source: "clawhub" });
    expect(cache.get("updatable")).toBe("v2");
  });

  it("returns correct directory paths", () => {
    const cache = createSkillCache(TEST_DIR);
    expect(cache.dir()).toBe(join(TEST_DIR, "skills"));
    expect(cache.skillDir("my-skill")).toBe(join(TEST_DIR, "skills", "my-skill"));
  });

  it("stores skills in the project root skills/ directory", () => {
    const cache = createSkillCache(TEST_DIR);
    cache.put({ name: "cached-skill", content: "# Content", source: "n-skills" });

    // Verify the file is at <projectRoot>/skills/<name>/SKILL.md
    const expectedPath = join(TEST_DIR, "skills", "cached-skill", "SKILL.md");
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toBe("# Content");
  });
});
