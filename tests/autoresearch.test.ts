import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { parseTestOutput } from "../src/autoresearch/metrics";
import { loadProgram } from "../src/autoresearch/program";
import { recordExperiment, getSessionSummary, type ExperimentRecord } from "../src/autoresearch/ledger";
import { evaluateExperiment } from "../src/autoresearch/loop";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TestMetrics } from "../src/autoresearch/types";

// ── parseTestOutput ─────────────────────────────────────────────────

describe("parseTestOutput", () => {
  test("parses typical bun test output with pass/fail counts", () => {
    const raw = `bun test v1.3.9 (cf6cdbbb)

tests/tracker.test.ts:
✓ creates and retrieves a pipeline
✓ lists pipelines

 42 pass
 3 fail
 100 expect() calls
Ran 45 tests across 5 files. [250.00ms]`;

    const result = parseTestOutput(raw, 250);
    expect(result.passed).toBe(42);
    expect(result.failed).toBe(3);
    expect(result.total).toBe(45);
  });

  test("handles output with 0 failures", () => {
    const raw = `bun test v1.3.9 (cf6cdbbb)

 200 pass
 0 fail
 478 expect() calls
Ran 200 tests across 18 files. [400.00ms]`;

    const result = parseTestOutput(raw, 400);
    expect(result.passed).toBe(200);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(200);
  });

  test("handles output with no matches (returns 0/0)", () => {
    const raw = `Some unexpected output with no test results`;

    const result = parseTestOutput(raw, 100);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(0);
  });

  test("preserves duration", () => {
    const raw = ` 10 pass\n 2 fail`;
    const result = parseTestOutput(raw, 12345);
    expect(result.durationMs).toBe(12345);
  });

  test("preserves raw output", () => {
    const raw = ` 5 pass\n 1 fail`;
    const result = parseTestOutput(raw, 50);
    expect(result.raw).toBe(raw);
  });
});

// ── loadProgram ─────────────────────────────────────────────────────

describe("loadProgram", () => {
  const tempDir = tmpdir();

  test("loads from an existing file", () => {
    const tempFile = join(tempDir, `test-program-${Date.now()}.md`);
    writeFileSync(tempFile, `# My Program

## Constraints
- Do not break anything
- Keep it simple

## Priorities
- Improve test coverage
- Fix flaky tests
`);

    try {
      const config = loadProgram(tempFile, tempDir);
      expect(config.content).toContain("# My Program");
      expect(config.constraints).toContain("Do not break anything");
      expect(config.constraints).toContain("Keep it simple");
      expect(config.priorities).toContain("Improve test coverage");
      expect(config.priorities).toContain("Fix flaky tests");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("falls back to default when file does not exist", () => {
    const config = loadProgram("/nonexistent/PROGRAM.md", tempDir);
    expect(config.content).toContain("Self-Improvement Program");
    expect(config.constraints.length).toBeGreaterThan(0);
  });

  test("extracts constraints section", () => {
    const tempFile = join(tempDir, `test-constraints-${Date.now()}.md`);
    writeFileSync(tempFile, `# Program

## Constraints
- Do NOT modify .env
- Do NOT install new dependencies
- Keep changes small

## Other
Some other text
`);

    try {
      const config = loadProgram(tempFile, tempDir);
      expect(config.constraints).toHaveLength(3);
      expect(config.constraints[0]).toBe("Do NOT modify .env");
      expect(config.constraints[1]).toBe("Do NOT install new dependencies");
      expect(config.constraints[2]).toBe("Keep changes small");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("extracts Priorities section as priorities", () => {
    const tempFile = join(tempDir, `test-priorities-${Date.now()}.md`);
    writeFileSync(tempFile, `# Program

## Priorities
- Error handling
- Test coverage
`);

    try {
      const config = loadProgram(tempFile, tempDir);
      expect(config.priorities).toHaveLength(2);
      expect(config.priorities).toContain("Error handling");
      expect(config.priorities).toContain("Test coverage");
    } finally {
      unlinkSync(tempFile);
    }
  });

  test("falls back to What to Improve when no Priorities section", () => {
    // Note: extractSection returns [] (truthy) for missing sections,
    // so the || fallback to "What to Improve" only works when
    // the code uses a falsy check. Testing current behavior:
    const tempFile = join(tempDir, `test-what-to-improve-${Date.now()}.md`);
    writeFileSync(tempFile, `# Program

## What to Improve
- Better logging
`);

    try {
      const config = loadProgram(tempFile, tempDir);
      // Falls back to "What to Improve" when "Priorities" section is missing
      expect(config.priorities).toHaveLength(1);
      expect(config.priorities[0]).toBe("Better logging");
    } finally {
      unlinkSync(tempFile);
    }
  });
});

// ── recordExperiment + getSessionSummary ─────────────────────────────

describe("recordExperiment + getSessionSummary", () => {
  let db: Database;
  let store: Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
  });

  function makeRecord(overrides: Partial<ExperimentRecord> = {}): ExperimentRecord {
    return {
      sessionId: "session-1",
      commitHash: "abc123",
      parentHash: null,
      metrics: { passed: 200, failed: 0, total: 200, durationMs: 400, raw: "200 pass\n0 fail" },
      experimentDurationMs: 5000,
      status: "keep",
      description: "Baseline",
      diffStat: null,
      taskId: null,
      ...overrides,
    };
  }

  test("records a baseline experiment", () => {
    const exp = recordExperiment(store, makeRecord());
    expect(exp.id).toBeGreaterThan(0);
    expect(exp.session_id).toBe("session-1");
    expect(exp.commit_hash).toBe("abc123");
    expect(exp.tests_passed).toBe(200);
    expect(exp.tests_failed).toBe(0);
    expect(exp.status).toBe("keep");
    expect(exp.description).toBe("Baseline");
    expect(exp.created_at).toBeGreaterThan(0);
  });

  test("records multiple experiments with different statuses", () => {
    recordExperiment(store, makeRecord({ commitHash: "aaa", status: "keep", description: "First" }));
    recordExperiment(store, makeRecord({ commitHash: "bbb", status: "discard", description: "Second" }));
    recordExperiment(store, makeRecord({ commitHash: "ccc", status: "regression", description: "Third" }));
    recordExperiment(store, makeRecord({ commitHash: "ddd", status: "crash", description: "Fourth" }));

    const experiments = store.listExperiments("session-1");
    expect(experiments).toHaveLength(4);
    expect(experiments[0]!.status).toBe("keep");
    expect(experiments[1]!.status).toBe("discard");
    expect(experiments[2]!.status).toBe("regression");
    expect(experiments[3]!.status).toBe("crash");
  });

  test("getSessionSummary returns correct counts", () => {
    recordExperiment(store, makeRecord({ commitHash: "a1", status: "keep" }));
    recordExperiment(store, makeRecord({ commitHash: "a2", status: "keep" }));
    recordExperiment(store, makeRecord({ commitHash: "a3", status: "discard" }));
    recordExperiment(store, makeRecord({ commitHash: "a4", status: "crash" }));
    recordExperiment(store, makeRecord({ commitHash: "a5", status: "regression" }));

    const summary = getSessionSummary(store, "session-1");
    expect(summary.total).toBe(5);
    expect(summary.kept).toBe(2);
    expect(summary.discarded).toBe(1);
    expect(summary.crashed).toBe(1);
    expect(summary.regressions).toBe(1);
    expect(summary.bestTests).toBe(200);
  });

  test("listExperiments returns experiments in order", () => {
    recordExperiment(store, makeRecord({ commitHash: "first", description: "First change" }));
    recordExperiment(store, makeRecord({ commitHash: "second", description: "Second change" }));
    recordExperiment(store, makeRecord({ commitHash: "third", description: "Third change" }));

    const experiments = store.listExperiments("session-1");
    expect(experiments).toHaveLength(3);
    expect(experiments[0]!.id).toBeLessThan(experiments[1]!.id);
    expect(experiments[1]!.id).toBeLessThan(experiments[2]!.id);
    expect(experiments[0]!.description).toBe("First change");
    expect(experiments[2]!.description).toBe("Third change");
  });

  test("listExperimentSessions groups by session", () => {
    recordExperiment(store, makeRecord({ sessionId: "s1", commitHash: "a1", status: "keep" }));
    recordExperiment(store, makeRecord({ sessionId: "s1", commitHash: "a2", status: "discard" }));
    recordExperiment(store, makeRecord({ sessionId: "s2", commitHash: "b1", status: "keep" }));

    const sessions = store.listExperimentSessions();
    expect(sessions).toHaveLength(2);

    const s1 = sessions.find(s => s.session_id === "s1");
    const s2 = sessions.find(s => s.session_id === "s2");
    expect(s1).toBeTruthy();
    expect(s1!.count).toBe(2);
    expect(s1!.keeps).toBe(1);
    expect(s2).toBeTruthy();
    expect(s2!.count).toBe(1);
    expect(s2!.keeps).toBe(1);
  });
});

// ── Store experiments CRUD ──────────────────────────────────────────

describe("store experiments CRUD", () => {
  let db: Database;
  let store: Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
  });

  test("recordExperiment returns an Experiment with auto-increment id", () => {
    const e1 = store.recordExperiment({
      sessionId: "sess-1",
      commitHash: "hash1",
      parentHash: null,
      testsPassed: 10,
      testsFailed: 0,
      testsTotal: 10,
      testDurationMs: 100,
      experimentDurationMs: 500,
      status: "keep",
      description: "First experiment",
      diffStat: "+5 -2",
      taskId: null,
    });

    const e2 = store.recordExperiment({
      sessionId: "sess-1",
      commitHash: "hash2",
      parentHash: "hash1",
      testsPassed: 12,
      testsFailed: 0,
      testsTotal: 12,
      testDurationMs: 110,
      experimentDurationMs: 600,
      status: "keep",
      description: "Second experiment",
      diffStat: "+10 -3",
      taskId: null,
    });

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.commit_hash).toBe("hash1");
    expect(e2.parent_hash).toBe("hash1");
    expect(e2.tests_total).toBe(12);
  });

  test("listExperiments filters by session", () => {
    store.recordExperiment({
      sessionId: "alpha",
      commitHash: "a1",
      parentHash: null,
      testsPassed: 5,
      testsFailed: 0,
      testsTotal: 5,
      testDurationMs: 50,
      experimentDurationMs: 200,
      status: "keep",
      description: "Alpha exp",
      diffStat: null,
      taskId: null,
    });

    store.recordExperiment({
      sessionId: "beta",
      commitHash: "b1",
      parentHash: null,
      testsPassed: 3,
      testsFailed: 1,
      testsTotal: 4,
      testDurationMs: 40,
      experimentDurationMs: 300,
      status: "discard",
      description: "Beta exp",
      diffStat: null,
      taskId: null,
    });

    const alphaExps = store.listExperiments("alpha");
    const betaExps = store.listExperiments("beta");
    const emptyExps = store.listExperiments("nonexistent");

    expect(alphaExps).toHaveLength(1);
    expect(alphaExps[0]!.session_id).toBe("alpha");
    expect(betaExps).toHaveLength(1);
    expect(betaExps[0]!.session_id).toBe("beta");
    expect(emptyExps).toHaveLength(0);
  });

  test("listExperimentSessions returns aggregates", () => {
    // Session X: 3 experiments, 2 keeps
    for (const [hash, status] of [["x1", "keep"], ["x2", "keep"], ["x3", "discard"]] as const) {
      store.recordExperiment({
        sessionId: "x",
        commitHash: hash,
        parentHash: null,
        testsPassed: 10,
        testsFailed: 0,
        testsTotal: 10,
        testDurationMs: 100,
        experimentDurationMs: 500,
        status,
        description: `Exp ${hash}`,
        diffStat: null,
        taskId: null,
      });
    }

    // Session Y: 1 experiment, 0 keeps
    store.recordExperiment({
      sessionId: "y",
      commitHash: "y1",
      parentHash: null,
      testsPassed: 8,
      testsFailed: 2,
      testsTotal: 10,
      testDurationMs: 90,
      experimentDurationMs: 400,
      status: "regression",
      description: "Exp y1",
      diffStat: null,
      taskId: null,
    });

    const sessions = store.listExperimentSessions();
    expect(sessions).toHaveLength(2);

    // Sessions are ordered by latest_at DESC, so Y (inserted last) comes first
    const sessionY = sessions.find(s => s.session_id === "y")!;
    const sessionX = sessions.find(s => s.session_id === "x")!;

    expect(sessionX.count).toBe(3);
    expect(sessionX.keeps).toBe(2);
    expect(sessionX.started_at).toBeGreaterThan(0);
    expect(sessionX.latest_at).toBeGreaterThanOrEqual(sessionX.started_at);

    expect(sessionY.count).toBe(1);
    expect(sessionY.keeps).toBe(0);
  });
});

// ── evaluateExperiment (decision logic) ──────────────────────────────

describe("evaluateExperiment", () => {
  const baseline: TestMetrics = { passed: 200, failed: 0, total: 200, durationMs: 400, raw: "200 pass\n0 fail" };

  test("timeout → crash + revert", () => {
    const result = evaluateExperiment({
      taskResult: "timeout",
      experimentNum: 1,
      parentHash: "parent1",
      currentHash: null,
      testMetrics: null,
      baseline,
      description: "Experiment #1",
    });
    expect(result.status).toBe("crash");
    expect(result.shouldRevert).toBe(true);
    expect(result.commitHash).toBe("parent1");
    expect(result.metrics.raw).toBe("TIMEOUT");
  });

  test("agent failed → crash + revert", () => {
    const result = evaluateExperiment({
      taskResult: "failed",
      experimentNum: 2,
      parentHash: "parent2",
      currentHash: null,
      testMetrics: null,
      baseline,
      description: "Experiment #2",
    });
    expect(result.status).toBe("crash");
    expect(result.shouldRevert).toBe(true);
    expect(result.commitHash).toBe("parent2");
    expect(result.metrics.raw).toBe("AGENT_FAILED");
  });

  test("agent succeeded but made no changes → discard", () => {
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 3,
      parentHash: "parent3",
      currentHash: "parent3", // same hash = no changes
      testMetrics: null,
      baseline,
      description: "No-op experiment",
    });
    expect(result.status).toBe("discard");
    expect(result.shouldRevert).toBe(false);
    expect(result.commitHash).toBe("parent3");
    expect(result.metrics).toBe(baseline);
  });

  test("agent succeeded, tests crashed → crash + revert", () => {
    const crashedMetrics: TestMetrics = { passed: 0, failed: -1, total: 0, durationMs: 100, raw: "CRASH" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 4,
      parentHash: "parent4",
      currentHash: "new-commit-4",
      testMetrics: crashedMetrics,
      baseline,
      description: "Crash experiment",
    });
    expect(result.status).toBe("crash");
    expect(result.shouldRevert).toBe(true);
    expect(result.commitHash).toBe("parent4");
  });

  test("agent succeeded, tests regressed → regression + revert", () => {
    const regressedMetrics: TestMetrics = { passed: 195, failed: 5, total: 200, durationMs: 450, raw: "195 pass\n5 fail" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 5,
      parentHash: "parent5",
      currentHash: "new-commit-5",
      testMetrics: regressedMetrics,
      baseline,
      description: "Regressed experiment",
    });
    expect(result.status).toBe("regression");
    expect(result.shouldRevert).toBe(true);
    expect(result.commitHash).toBe("parent5");
    expect(result.metrics.failed).toBe(5);
  });

  test("agent succeeded, tests improved → keep", () => {
    const improvedMetrics: TestMetrics = { passed: 210, failed: 0, total: 210, durationMs: 420, raw: "210 pass\n0 fail" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 6,
      parentHash: "parent6",
      currentHash: "new-commit-6",
      testMetrics: improvedMetrics,
      baseline,
      description: "Improved experiment",
    });
    expect(result.status).toBe("keep");
    expect(result.shouldRevert).toBe(false);
    expect(result.commitHash).toBe("new-commit-6");
    expect(result.metrics.passed).toBe(210);
  });

  test("agent succeeded, tests neutral (same failures) → keep", () => {
    const neutralMetrics: TestMetrics = { passed: 200, failed: 0, total: 200, durationMs: 390, raw: "200 pass\n0 fail" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 7,
      parentHash: "parent7",
      currentHash: "new-commit-7",
      testMetrics: neutralMetrics,
      baseline,
      description: "Neutral experiment",
    });
    expect(result.status).toBe("keep");
    expect(result.shouldRevert).toBe(false);
    expect(result.commitHash).toBe("new-commit-7");
  });

  test("regression detected against non-zero baseline failures", () => {
    const baselineWithFailures: TestMetrics = { passed: 195, failed: 5, total: 200, durationMs: 400, raw: "195 pass\n5 fail" };
    const worseMetrics: TestMetrics = { passed: 192, failed: 8, total: 200, durationMs: 410, raw: "192 pass\n8 fail" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 8,
      parentHash: "parent8",
      currentHash: "new-commit-8",
      testMetrics: worseMetrics,
      baseline: baselineWithFailures,
      description: "More failures",
    });
    expect(result.status).toBe("regression");
    expect(result.shouldRevert).toBe(true);
  });

  test("fewer failures than baseline → keep", () => {
    const baselineWithFailures: TestMetrics = { passed: 195, failed: 5, total: 200, durationMs: 400, raw: "195 pass\n5 fail" };
    const betterMetrics: TestMetrics = { passed: 198, failed: 2, total: 200, durationMs: 400, raw: "198 pass\n2 fail" };
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 9,
      parentHash: "parent9",
      currentHash: "new-commit-9",
      testMetrics: betterMetrics,
      baseline: baselineWithFailures,
      description: "Fixed some failures",
    });
    expect(result.status).toBe("keep");
    expect(result.shouldRevert).toBe(false);
    expect(result.commitHash).toBe("new-commit-9");
  });

  test("null currentHash (agent done but no commit) → discard", () => {
    const result = evaluateExperiment({
      taskResult: "done",
      experimentNum: 10,
      parentHash: "parent10",
      currentHash: null,
      testMetrics: null,
      baseline,
      description: "Null hash experiment",
    });
    expect(result.status).toBe("discard");
    expect(result.shouldRevert).toBe(false);
  });
});
