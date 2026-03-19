/**
 * Tests for the completionProtocol() function.
 */
import { describe, it, expect } from "bun:test";
import { completionProtocol } from "../src/container/completion";

describe("completionProtocol", () => {
  it("includes the task ID in follow-up task template", () => {
    const result = completionProtocol("task-123", "http://localhost:7800");
    expect(result).toContain("task-123");
  });

  it("includes the API URL for curl commands", () => {
    const result = completionProtocol("task-abc", "http://host.docker.internal:7800");
    expect(result).toContain("http://host.docker.internal:7800");
  });

  it("contains self-assessment instructions", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result).toContain("self-assessment");
    expect(result).toContain("Re-read the original request");
    expect(result).toContain("Check your work");
  });

  it("contains follow-up task creation instructions", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result).toContain("POST");
    expect(result).toContain("/tasks");
    expect(result).toContain("follow-up");
  });

  it("contains memory system API instructions", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result).toContain("/memory");
    expect(result).toContain("add");
    expect(result).toContain("replace");
    expect(result).toContain("remove");
  });

  it("contains skill creation instructions", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result).toContain("/skills");
    expect(result).toContain("SKILL.md");
  });

  it("contains session search instructions", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result).toContain("/search");
  });

  it("starts with # Completion Protocol header", () => {
    const result = completionProtocol("t1", "http://localhost:7800");
    expect(result.startsWith("# Completion Protocol")).toBe(true);
  });

  it("uses correct port in all curl commands", () => {
    const result = completionProtocol("t1", "http://host.docker.internal:9000");
    // All occurrences of the API URL should use port 9000
    const matches = result.match(/http:\/\/host\.docker\.internal:9000/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5); // tasks, memory (multiple), skills, search
  });
});
