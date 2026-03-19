/**
 * Skills discovery integration tests.
 *
 * Tests extractKeywords and discoverSkills with mocked registries.
 */
import { describe, it, expect } from "bun:test";
import { extractKeywords } from "../src/skills/discovery";

describe("extractKeywords", () => {
  it("extracts meaningful keywords from a prompt", () => {
    const keywords = extractKeywords("Fix the login page authentication bug in React");
    expect(keywords).toContain("login");
    expect(keywords).toContain("authentication");
    expect(keywords).toContain("react");
    // Stop words should be filtered
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("in");
    expect(keywords).not.toContain("fix");
  });

  it("filters common action words", () => {
    const keywords = extractKeywords("Please create a new file for the project");
    expect(keywords).not.toContain("please");
    expect(keywords).not.toContain("create");
    expect(keywords).not.toContain("file");
    expect(keywords).not.toContain("project");
  });

  it("deduplicates keywords", () => {
    const keywords = extractKeywords("docker docker docker setup");
    const dockerCount = keywords.filter(k => k === "docker").length;
    expect(dockerCount).toBe(1);
  });

  it("limits to maxKeywords", () => {
    const keywords = extractKeywords(
      "kubernetes helm terraform ansible docker prometheus grafana alertmanager nginx redis postgresql",
      5
    );
    expect(keywords.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array for stop-word-only prompts", () => {
    const keywords = extractKeywords("please fix the code in this file");
    expect(keywords).toEqual([]);
  });

  it("filters short words (<=2 chars)", () => {
    const keywords = extractKeywords("go to db and do it");
    // "go", "to", "db", "do", "it" are all <=2 chars or stop words
    expect(keywords).toEqual([]);
  });

  it("handles special characters in prompt", () => {
    const keywords = extractKeywords("Fix bug in auth.ts (critical!) @urgent #hotfix");
    // Should strip punctuation and extract meaningful words
    expect(keywords).toContain("auth");
    expect(keywords).toContain("critical");
    expect(keywords).toContain("urgent");
    expect(keywords).toContain("hotfix");
  });

  it("lowercases all keywords", () => {
    const keywords = extractKeywords("Configure PostgreSQL Replication");
    for (const kw of keywords) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("handles empty prompt", () => {
    const keywords = extractKeywords("");
    expect(keywords).toEqual([]);
  });
});
