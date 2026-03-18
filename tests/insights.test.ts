import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { parseTokenUsage, estimateCost } from "../src/tracker/insights";

describe("parseTokenUsage", () => {
  it("extracts input and output tokens", () => {
    const output = "Input tokens: 1234\nOutput tokens: 567";
    const result = parseTokenUsage(output);
    expect(result.tokensIn).toBe(1234);
    expect(result.tokensOut).toBe(567);
  });

  it("extracts tokens with underscore format", () => {
    const output = "input_tokens: 500\noutput_tokens: 200";
    const result = parseTokenUsage(output);
    expect(result.tokensIn).toBe(500);
    expect(result.tokensOut).toBe(200);
  });

  it("handles missing data (returns 0s)", () => {
    const output = "No token info here, just regular output";
    const result = parseTokenUsage(output);
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.model).toBeNull();
  });

  it("uses total tokens with 70/30 split when input/output not available", () => {
    const output = "Total tokens: 1000";
    const result = parseTokenUsage(output);
    expect(result.tokensIn).toBe(700);
    expect(result.tokensOut).toBe(300);
  });

  it("extracts model name", () => {
    const output = "Model: anthropic/claude-sonnet-4-20250514\nInput tokens: 100\nOutput tokens: 50";
    const result = parseTokenUsage(output);
    expect(result.model).toBe("anthropic/claude-sonnet-4-20250514");
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(50);
  });

  it("handles empty string", () => {
    const result = parseTokenUsage("");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.model).toBeNull();
  });

  it("prefers input/output over total tokens", () => {
    const output = "Input tokens: 800\nOutput tokens: 200\nTotal tokens: 1000";
    const result = parseTokenUsage(output);
    expect(result.tokensIn).toBe(800);
    expect(result.tokensOut).toBe(200);
  });
});

describe("estimateCost", () => {
  it("returns correct estimate for claude-sonnet", () => {
    // 1M input tokens at $3, 1M output tokens at $15
    const cost = estimateCost("anthropic/claude-sonnet-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18, 1);
  });

  it("returns correct estimate for claude-opus", () => {
    const cost = estimateCost("anthropic/claude-opus-4-20250514", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(90, 1);
  });

  it("returns correct estimate for claude-haiku", () => {
    const cost = estimateCost("anthropic/claude-haiku-3-5-20241022", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(1.5, 1);
  });

  it("returns 0 for ollama models", () => {
    const cost = estimateCost("ollama/llama3", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("handles unknown models with default rate", () => {
    const cost = estimateCost("some-unknown-model", 1_000_000, 1_000_000);
    // Default: $3 input + $15 output = $18 per million
    expect(cost).toBeCloseTo(18, 1);
  });

  it("handles zero tokens", () => {
    const cost = estimateCost("anthropic/claude-sonnet-4", 0, 0);
    expect(cost).toBe(0);
  });

  it("handles small token counts", () => {
    // 1000 input tokens of claude-sonnet = $0.003
    const cost = estimateCost("anthropic/claude-sonnet-4", 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 4);
  });
});

describe("store.updateRunMetrics", () => {
  let db: Database;
  let store: Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
  });

  it("updates run with token metrics", () => {
    const task = store.createTask({ title: "Test task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "worker", 600);
    expect(claimed).not.toBeNull();

    store.updateRunMetrics(claimed!.run.id, {
      tokensIn: 1000,
      tokensOut: 500,
      estimatedCostUsd: 0.01,
      modelUsed: "anthropic/claude-sonnet-4",
    });

    const run = store.getRun(claimed!.run.id);
    expect(run).not.toBeNull();
    expect(run!.tokens_in).toBe(1000);
    expect(run!.tokens_out).toBe(500);
    expect(run!.estimated_cost_usd).toBeCloseTo(0.01, 4);
    expect(run!.model_used).toBe("anthropic/claude-sonnet-4");
  });

  it("updates only specified fields", () => {
    const task = store.createTask({ title: "Test task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "worker", 600);

    store.updateRunMetrics(claimed!.run.id, { tokensIn: 500 });

    const run = store.getRun(claimed!.run.id);
    expect(run!.tokens_in).toBe(500);
    expect(run!.tokens_out).toBe(0);
    expect(run!.model_used).toBeNull();
  });

  it("no-ops when no fields provided", () => {
    const task = store.createTask({ title: "Test task" });
    store.updateTaskStatus(task.id, "queued");
    const claimed = store.claimTask(task.id, "worker", 600);

    // Should not throw
    store.updateRunMetrics(claimed!.run.id, {});

    const run = store.getRun(claimed!.run.id);
    expect(run!.tokens_in).toBe(0);
  });
});

describe("store.getInsights", () => {
  let db: Database;
  let store: Store;

  beforeEach(() => {
    db = new Database(":memory:");
    store = createStore(db);
  });

  it("returns aggregated data for runs in the time window", () => {
    // Create two tasks with runs
    const task1 = store.createTask({ title: "Task 1" });
    store.updateTaskStatus(task1.id, "queued");
    const claim1 = store.claimTask(task1.id, "worker", 600)!;
    store.updateRunMetrics(claim1.run.id, {
      tokensIn: 1000,
      tokensOut: 500,
      estimatedCostUsd: 0.01,
      modelUsed: "anthropic/claude-sonnet-4",
    });
    store.finishRun(claim1.run.id, "done", 0);
    store.updateTaskStatus(task1.id, "done");

    const task2 = store.createTask({ title: "Task 2" });
    store.updateTaskStatus(task2.id, "queued");
    const claim2 = store.claimTask(task2.id, "worker", 600)!;
    store.updateRunMetrics(claim2.run.id, {
      tokensIn: 2000,
      tokensOut: 1000,
      estimatedCostUsd: 0.02,
      modelUsed: "anthropic/claude-sonnet-4",
    });
    store.finishRun(claim2.run.id, "done", 0);
    store.updateTaskStatus(task2.id, "done");

    const insights = store.getInsights(7);

    expect(insights.totalRuns).toBe(2);
    expect(insights.totalTasks).toBe(2);
    expect(insights.totalTokensIn).toBe(3000);
    expect(insights.totalTokensOut).toBe(1500);
    expect(insights.totalCostUsd).toBeCloseTo(0.03, 4);
    expect(insights.byModel).toHaveLength(1);
    expect(insights.byModel[0]!.model).toBe("anthropic/claude-sonnet-4");
    expect(insights.byModel[0]!.runs).toBe(2);
    expect(insights.byDay.length).toBeGreaterThanOrEqual(1);
    expect(insights.byStatus.length).toBeGreaterThanOrEqual(1);
  });

  it("returns zeros when no runs exist", () => {
    const insights = store.getInsights(7);
    expect(insights.totalRuns).toBe(0);
    expect(insights.totalTasks).toBe(0);
    expect(insights.totalTokensIn).toBe(0);
    expect(insights.totalTokensOut).toBe(0);
    expect(insights.totalCostUsd).toBe(0);
    expect(insights.byModel).toHaveLength(0);
    expect(insights.byDay).toHaveLength(0);
    expect(insights.avgDurationSec).toBe(0);
  });

  it("groups by model correctly", () => {
    const task1 = store.createTask({ title: "Task 1" });
    store.updateTaskStatus(task1.id, "queued");
    const claim1 = store.claimTask(task1.id, "worker", 600)!;
    store.updateRunMetrics(claim1.run.id, { modelUsed: "anthropic/claude-sonnet-4", tokensIn: 100 });
    store.finishRun(claim1.run.id, "done", 0);

    const task2 = store.createTask({ title: "Task 2" });
    store.updateTaskStatus(task2.id, "queued");
    const claim2 = store.claimTask(task2.id, "worker", 600)!;
    store.updateRunMetrics(claim2.run.id, { modelUsed: "openai/gpt-4o", tokensIn: 200 });
    store.finishRun(claim2.run.id, "done", 0);

    const insights = store.getInsights(7);
    expect(insights.byModel).toHaveLength(2);
    const models = insights.byModel.map(m => m.model).sort();
    expect(models).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
  });
});
