import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  listInstincts,
  saveInstinct,
  matchInstincts,
  updateConfidence,
  extractInstincts,
  decayInstincts,
  buildInstinctContext,
  type Instinct,
} from "../src/memory/instincts";

const TEST_VAULT = join(import.meta.dir, ".test-instincts-vault");

function makeInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: `test-${crypto.randomUUID().slice(0, 8)}`,
    trigger: "when writing tests",
    action: "Always use descriptive test names",
    confidence: 0.7,
    domain: "testing",
    scope: "project",
    evidence: ["Task abc: Write tests"],
    source: "task-1",
    created: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  mkdirSync(TEST_VAULT, { recursive: true });
});

describe("saveInstinct + listInstincts", () => {
  it("saves and reads back an instinct", () => {
    const instinct = makeInstinct({ id: "test-save" });
    saveInstinct(TEST_VAULT, instinct);

    const all = listInstincts(TEST_VAULT);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("test-save");
    expect(all[0].action).toBe(instinct.action);
    expect(all[0].confidence).toBe(0.7);
    expect(all[0].domain).toBe("testing");
  });

  it("returns empty array when no instincts exist", () => {
    expect(listInstincts(TEST_VAULT)).toEqual([]);
  });

  it("returns empty array when instincts dir does not exist", () => {
    const nonexistent = join(TEST_VAULT, "nope");
    expect(listInstincts(nonexistent)).toEqual([]);
  });

  it("saves multiple instincts", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "a" }));
    saveInstinct(TEST_VAULT, makeInstinct({ id: "b" }));
    saveInstinct(TEST_VAULT, makeInstinct({ id: "c" }));

    expect(listInstincts(TEST_VAULT)).toHaveLength(3);
  });

  it("overwrites existing instinct on save", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "upd", confidence: 0.5 }));
    saveInstinct(TEST_VAULT, makeInstinct({ id: "upd", confidence: 0.9 }));

    const all = listInstincts(TEST_VAULT);
    expect(all).toHaveLength(1);
    expect(all[0].confidence).toBe(0.9);
  });

  it("preserves evidence array", () => {
    const instinct = makeInstinct({
      id: "ev",
      evidence: ["Task 1: Fix bug", "Task 2: Refactor"],
    });
    saveInstinct(TEST_VAULT, instinct);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].evidence).toEqual(["Task 1: Fix bug", "Task 2: Refactor"]);
  });

  it("skips malformed files", () => {
    const dir = join(TEST_VAULT, "instincts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.md"), "not valid frontmatter");
    saveInstinct(TEST_VAULT, makeInstinct({ id: "good" }));

    const all = listInstincts(TEST_VAULT);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("good");
  });
});

describe("matchInstincts", () => {
  it("matches instincts by trigger keywords", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "m1", trigger: "when writing database queries", confidence: 0.8 }));
    saveInstinct(TEST_VAULT, makeInstinct({ id: "m2", trigger: "when designing APIs", confidence: 0.6 }));

    const matched = matchInstincts(TEST_VAULT, "fix the database query performance");
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe("m1");
  });

  it("returns empty for no matches", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "x", trigger: "when cooking pasta" }));
    const matched = matchInstincts(TEST_VAULT, "deploy to production");
    expect(matched).toEqual([]);
  });

  it("ranks by relevance * confidence", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "low", trigger: "when writing tests", confidence: 0.3 }));
    saveInstinct(TEST_VAULT, makeInstinct({ id: "high", trigger: "when writing tests", confidence: 0.9 }));

    const matched = matchInstincts(TEST_VAULT, "writing unit tests");
    expect(matched[0].id).toBe("high");
  });

  it("respects maxInstincts limit", () => {
    for (let i = 0; i < 10; i++) {
      saveInstinct(TEST_VAULT, makeInstinct({ id: `i${i}`, trigger: `when deploying code ${i}`, confidence: 0.7 }));
    }

    const matched = matchInstincts(TEST_VAULT, "deploying code to production");
    expect(matched.length).toBeLessThanOrEqual(5); // default limit
  });

  it("matches on domain keywords too", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "d1", trigger: "general trigger", domain: "docker", confidence: 0.8 }));
    const matched = matchInstincts(TEST_VAULT, "build a docker image");
    expect(matched).toHaveLength(1);
  });
});

describe("updateConfidence", () => {
  it("increases confidence", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "up", confidence: 0.5 }));
    updateConfidence(TEST_VAULT, "up", 0.2);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBe(0.7);
  });

  it("decreases confidence", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "down", confidence: 0.5 }));
    updateConfidence(TEST_VAULT, "down", -0.2);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBe(0.3);
  });

  it("clamps to minimum 0.1", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "min", confidence: 0.15 }));
    updateConfidence(TEST_VAULT, "min", -0.5);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBe(0.1);
  });

  it("clamps to maximum 0.95", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "max", confidence: 0.9 }));
    updateConfidence(TEST_VAULT, "max", 0.5);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBe(0.95);
  });

  it("does nothing for nonexistent instinct", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "exists", confidence: 0.5 }));
    updateConfidence(TEST_VAULT, "nonexistent", 0.3);

    const all = listInstincts(TEST_VAULT);
    expect(all).toHaveLength(1);
    expect(all[0].confidence).toBe(0.5);
  });
});

describe("extractInstincts", () => {
  it("extracts switch/preference patterns", () => {
    const output = "We switched from npm to bun for faster installs.";
    const instincts = extractInstincts("Setup project", output, "task-1");

    expect(instincts.length).toBeGreaterThanOrEqual(1);
    const found = instincts.find(i => i.action.includes("bun") && i.action.includes("npm"));
    expect(found).toBeTruthy();
    expect(found!.domain).toBe("tooling");
    expect(found!.confidence).toBe(0.5);
  });

  it("extracts fix patterns", () => {
    const output = "The issue was fixed by adding the missing index on the users table.";
    const instincts = extractInstincts("Fix slow queries", output, "task-2");

    expect(instincts.length).toBeGreaterThanOrEqual(1);
    const found = instincts.find(i => i.id.startsWith("fix-"));
    expect(found).toBeTruthy();
    expect(found!.domain).toBe("debugging");
  });

  it("extracts rule patterns", () => {
    const output = "You should always validate user input before processing.";
    const instincts = extractInstincts("Security review", output, "task-3");

    expect(instincts.length).toBeGreaterThanOrEqual(1);
    const found = instincts.find(i => i.id.startsWith("rule-"));
    expect(found).toBeTruthy();
    expect(found!.domain).toBe("best-practice");
  });

  it("returns empty for unmatched output", () => {
    const instincts = extractInstincts("Simple task", "Done.", "task-4");
    expect(instincts).toEqual([]);
  });

  it("includes task reference in evidence", () => {
    const output = "We switched from Express to Hono for better performance.";
    const instincts = extractInstincts("Migrate server", output, "task-5");
    expect(instincts[0].evidence[0]).toContain("task-5");
    expect(instincts[0].source).toBe("task-5");
  });
});

describe("decayInstincts", () => {
  it("decays stale instincts (file older than 7 days)", () => {
    const instinct = makeInstinct({ id: "stale", confidence: 0.7 });
    saveInstinct(TEST_VAULT, instinct);

    // Touch file to make it appear old (set mtime 8 days ago)
    const filePath = join(TEST_VAULT, "instincts", "stale.md");
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { utimesSync } = require("fs");
    utimesSync(filePath, oldTime, oldTime);

    const result = decayInstincts(TEST_VAULT);
    expect(result.decayed).toBe(1);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBeCloseTo(0.65, 2);
  });

  it("prunes instincts below 0.1 confidence", () => {
    const instinct = makeInstinct({ id: "dying", confidence: 0.12 });
    saveInstinct(TEST_VAULT, instinct);

    // Make it old enough to decay
    const filePath = join(TEST_VAULT, "instincts", "dying.md");
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const { utimesSync } = require("fs");
    utimesSync(filePath, oldTime, oldTime);

    const result = decayInstincts(TEST_VAULT);
    expect(result.pruned).toBe(1);

    const all = listInstincts(TEST_VAULT);
    expect(all).toHaveLength(0);
  });

  it("caps evidence at 20 entries", () => {
    const evidence = Array.from({ length: 25 }, (_, i) => `Evidence ${i}`);
    const instinct = makeInstinct({ id: "big-evidence", evidence });
    saveInstinct(TEST_VAULT, instinct);

    decayInstincts(TEST_VAULT);

    const all = listInstincts(TEST_VAULT);
    expect(all[0].evidence.length).toBeLessThanOrEqual(20);
  });

  it("returns zeros when no instincts exist", () => {
    const result = decayInstincts(TEST_VAULT);
    expect(result).toEqual({ decayed: 0, pruned: 0 });
  });

  it("does not decay recent instincts", () => {
    const instinct = makeInstinct({ id: "fresh", confidence: 0.7 });
    saveInstinct(TEST_VAULT, instinct);

    // File was just written, so it's recent
    const result = decayInstincts(TEST_VAULT);
    // Fresh files should not be decayed
    const all = listInstincts(TEST_VAULT);
    expect(all[0].confidence).toBe(0.7);
  });
});

describe("buildInstinctContext", () => {
  it("builds markdown context from matched instincts", () => {
    saveInstinct(TEST_VAULT, makeInstinct({
      id: "ctx1",
      trigger: "when writing database queries",
      action: "Use prepared statements",
      confidence: 0.8,
      domain: "security",
    }));

    const context = buildInstinctContext(TEST_VAULT, "write a database query");
    expect(context).toContain("# Learned Instincts");
    expect(context).toContain("Use prepared statements");
    expect(context).toContain("security");
    expect(context).toContain("0.8");
  });

  it("returns empty string when no matches", () => {
    saveInstinct(TEST_VAULT, makeInstinct({ id: "nope", trigger: "when cooking" }));
    const context = buildInstinctContext(TEST_VAULT, "deploy to kubernetes");
    expect(context).toBe("");
  });

  it("respects maxInstincts parameter", () => {
    for (let i = 0; i < 10; i++) {
      saveInstinct(TEST_VAULT, makeInstinct({
        id: `ctx${i}`,
        trigger: `when deploying application ${i}`,
        confidence: 0.7,
      }));
    }

    const context = buildInstinctContext(TEST_VAULT, "deploying application", 2);
    const lines = context.split("\n").filter(l => l.startsWith("- **"));
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});
