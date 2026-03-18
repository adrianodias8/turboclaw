import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import type { ExperimentStatus } from "../tracker/types";
import { newId } from "../ids";
import { runTests } from "./metrics";
import { loadProgram } from "./program";
import { recordExperiment, getSessionSummary } from "./ledger";
import type { TestMetrics } from "./types";

/**
 * Evaluate an experiment result and decide what to do.
 * Pure function — no side effects, no git, no I/O.
 */
export function evaluateExperiment(input: {
  taskResult: "done" | "failed" | "timeout";
  experimentNum: number;
  parentHash: string;
  currentHash: string | null; // null for timeout/failed (agent didn't produce a commit)
  testMetrics: TestMetrics | null; // null for timeout/failed/no-changes
  baseline: TestMetrics;
  description: string;
}): {
  status: ExperimentStatus;
  metrics: TestMetrics;
  shouldRevert: boolean;
  commitHash: string;
} {
  const { taskResult, experimentNum, parentHash, currentHash, testMetrics, baseline, description } = input;

  if (taskResult === "timeout") {
    return {
      status: "crash",
      metrics: { passed: 0, failed: -1, total: 0, durationMs: 0, raw: "TIMEOUT" },
      shouldRevert: true,
      commitHash: parentHash,
    };
  }

  if (taskResult === "failed") {
    return {
      status: "crash",
      metrics: { passed: 0, failed: -1, total: 0, durationMs: 0, raw: "AGENT_FAILED" },
      shouldRevert: true,
      commitHash: parentHash,
    };
  }

  // Agent succeeded
  if (!currentHash || currentHash === parentHash) {
    // No changes committed
    return {
      status: "discard",
      metrics: baseline,
      shouldRevert: false,
      commitHash: parentHash,
    };
  }

  // Agent made changes — evaluate test results
  if (!testMetrics || testMetrics.failed < 0) {
    // Tests crashed
    return {
      status: "crash",
      metrics: testMetrics ?? { passed: 0, failed: -1, total: 0, durationMs: 0, raw: "CRASH" },
      shouldRevert: true,
      commitHash: parentHash,
    };
  }

  if (testMetrics.failed > baseline.failed) {
    // Regression
    return {
      status: "regression",
      metrics: testMetrics,
      shouldRevert: true,
      commitHash: parentHash,
    };
  }

  // Improvement or neutral — keep
  return {
    status: "keep",
    metrics: testMetrics,
    shouldRevert: false,
    commitHash: currentHash,
  };
}

export interface AutoresearchHandle {
  stop(): void;
  isRunning(): boolean;
  sessionId(): string;
}

export function startAutoresearch(
  store: Store,
  config: TurboClawConfig,
): AutoresearchHandle {
  let running = true;
  const sessionId = newId().slice(0, 12);
  const projectDir = process.cwd();
  const branch = `autoresearch/${sessionId}`;

  logger.info(`Autoresearch session ${sessionId} starting on branch ${branch}`);

  const loopPromise = runLoop().catch(err => {
    logger.error(`Autoresearch session ${sessionId} crashed:`, err);
    running = false;
  });

  async function git(...args: string[]): Promise<{ stdout: string; exitCode: number }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), exitCode };
  }

  async function getHead(): Promise<string> {
    const { stdout } = await git("rev-parse", "--short=7", "HEAD");
    return stdout;
  }

  async function getDiffStat(): Promise<string | null> {
    const { stdout } = await git("diff", "--stat", "HEAD~1");
    return stdout || null;
  }

  async function waitForTask(taskId: string, timeoutMs: number): Promise<"done" | "failed" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && running) {
      const task = store.getTask(taskId);
      if (!task) return "failed";
      if (task.status === "done") return "done";
      if (task.status === "failed" || task.status === "cancelled") return "failed";
      await new Promise(r => setTimeout(r, 3000));
    }
    return "timeout";
  }

  function extractDescription(taskId: string): string {
    // Try to find EXPERIMENT: line from task run output
    const task = store.getTask(taskId);
    if (!task) return "unknown experiment";
    const run = store.getLatestRun(task.id);
    if (!run) return task.title;
    const events = store.listEvents(run.id);
    for (const event of events) {
      const match = event.payload.match(/EXPERIMENT:\s*(.+)/);
      if (match) return match[1]!.trim();
    }
    return task.title;
  }

  async function runLoop() {
    // Create the autoresearch branch
    await git("checkout", "-b", branch);

    // Load the research program
    const program = loadProgram(config.autoresearch.programPath, projectDir);

    // Capture baseline metrics
    logger.info(`Autoresearch: running baseline tests...`);
    const baseline = await runTests(projectDir);
    logger.info(`Autoresearch baseline: ${baseline.passed} pass, ${baseline.failed} fail, ${baseline.total} total`);

    if (baseline.failed < 0) {
      logger.error("Autoresearch: baseline tests crashed — aborting");
      running = false;
      return;
    }

    recordExperiment(store, {
      sessionId,
      commitHash: await getHead(),
      parentHash: null,
      metrics: baseline,
      experimentDurationMs: 0,
      status: "keep",
      description: "Baseline",
      diffStat: null,
      taskId: null,
    });

    let currentBaseline = baseline;
    let experimentNum = 0;

    while (running) {
      experimentNum++;
      const maxExperiments = config.autoresearch.maxExperiments;
      if (maxExperiments > 0 && experimentNum > maxExperiments) {
        logger.info(`Autoresearch: reached max experiments (${maxExperiments}) — stopping`);
        break;
      }

      const parentHash = await getHead();
      const experimentStart = Date.now();

      logger.info(`Autoresearch experiment #${experimentNum} starting (parent: ${parentHash})`);

      // Build the prompt with program context and current metrics
      const prompt = [
        program.content,
        "",
        "---",
        "",
        `# Current Status`,
        `- Experiment #${experimentNum} of session ${sessionId}`,
        `- Tests: ${currentBaseline.passed} passing, ${currentBaseline.failed} failing, ${currentBaseline.total} total`,
        `- Your goal: make ONE improvement, commit it, and exit.`,
        `- The evaluation harness will run tests after you exit.`,
        "",
        "IMPORTANT: Make exactly ONE focused change. Commit it. Then exit.",
      ].join("\n");

      // Create a self-improve task
      const task = store.createTask({
        title: `Autoresearch #${experimentNum}`,
        description: prompt,
        agentRole: "self-improve",
        priority: 10,
      });
      store.updateTaskStatus(task.id, "queued");

      // Wait for task completion
      const result = await waitForTask(task.id, config.autoresearch.timeBudgetMs);
      const experimentDurationMs = Date.now() - experimentStart;

      if (!running) break;

      let status: ExperimentStatus;
      let metrics: TestMetrics;
      let description: string;
      let commitHash: string;
      let diffStat: string | null = null;

      if (result === "timeout") {
        // Kill the task and revert
        store.cancelTask(task.id);
        await git("reset", "--hard", parentHash);
        await git("clean", "-fd");
        status = "crash";
        metrics = { passed: 0, failed: -1, total: 0, durationMs: 0, raw: "TIMEOUT" };
        description = `Experiment #${experimentNum}: timed out`;
        commitHash = parentHash;
        logger.warn(`Autoresearch #${experimentNum}: timed out — reverted`);
      } else if (result === "failed") {
        // Agent failed — revert
        await git("reset", "--hard", parentHash);
        await git("clean", "-fd");
        status = "crash";
        metrics = { passed: 0, failed: -1, total: 0, durationMs: 0, raw: "AGENT_FAILED" };
        description = extractDescription(task.id);
        commitHash = parentHash;
        logger.warn(`Autoresearch #${experimentNum}: agent failed — reverted`);
      } else {
        // Agent succeeded — run the evaluation harness
        commitHash = await getHead();
        description = extractDescription(task.id);

        if (commitHash === parentHash) {
          // Agent didn't commit anything
          status = "discard";
          metrics = currentBaseline;
          logger.info(`Autoresearch #${experimentNum}: no changes made — discarded`);
        } else {
          // Run tests (the fixed evaluation harness)
          metrics = await runTests(projectDir);
          diffStat = await getDiffStat();

          if (metrics.failed < 0) {
            // Tests crashed
            await git("reset", "--hard", parentHash);
            await git("clean", "-fd");
            status = "crash";
            commitHash = parentHash;
            logger.warn(`Autoresearch #${experimentNum}: tests crashed — reverted`);
          } else if (metrics.failed > currentBaseline.failed) {
            // Regression — revert
            await git("reset", "--hard", parentHash);
            await git("clean", "-fd");
            status = "regression";
            commitHash = parentHash;
            logger.warn(`Autoresearch #${experimentNum}: regression (${currentBaseline.failed} → ${metrics.failed} failures) — reverted`);
          } else {
            // Improvement or neutral — keep
            status = "keep";
            currentBaseline = metrics;
            logger.info(`Autoresearch #${experimentNum}: KEEP (${metrics.passed}/${metrics.total} pass) — ${description}`);
          }
        }
      }

      recordExperiment(store, {
        sessionId,
        commitHash,
        parentHash,
        metrics,
        experimentDurationMs,
        status,
        description,
        diffStat,
        taskId: task.id,
      });

      const summary = getSessionSummary(store, sessionId);
      logger.info(`Autoresearch session ${sessionId}: ${summary.kept} kept, ${summary.discarded} discarded, ${summary.crashed} crashed, ${summary.regressions} regressions out of ${summary.total} experiments`);
    }

    logger.info(`Autoresearch session ${sessionId} stopped after ${experimentNum} experiments`);
    running = false;
  }

  return {
    stop() {
      logger.info(`Autoresearch session ${sessionId} stop requested`);
      running = false;
    },
    isRunning() {
      return running;
    },
    sessionId() {
      return sessionId;
    },
  };
}
