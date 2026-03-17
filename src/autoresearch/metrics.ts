import type { TestMetrics } from "./types";

/**
 * Run `bun test` in the given project directory and parse results.
 * Returns structured test metrics.
 */
export async function runTests(projectDir: string, timeoutMs: number = 120000): Promise<TestMetrics> {
  const start = Date.now();

  try {
    const proc = Bun.spawn(["bun", "test"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = setTimeout(() => {
      proc.kill();
    }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    clearTimeout(timeout);
    const exitCode = await proc.exited;
    const durationMs = Date.now() - start;
    const raw = `${stdout}\n${stderr}`.trim();

    if (exitCode === null || exitCode === 143 || exitCode === 137) {
      // Killed by timeout
      return { passed: 0, failed: -1, total: 0, durationMs, raw: `TIMEOUT after ${timeoutMs}ms\n${raw}` };
    }

    return parseTestOutput(raw, durationMs);
  } catch (err) {
    const durationMs = Date.now() - start;
    return { passed: 0, failed: -1, total: 0, durationMs, raw: `CRASH: ${err}` };
  }
}

/**
 * Parse bun test output to extract pass/fail counts.
 * Bun test outputs a line like: " 200 pass\n 0 fail"
 */
export function parseTestOutput(raw: string, durationMs: number): TestMetrics {
  let passed = 0;
  let failed = 0;

  // Match " N pass" pattern from bun test
  const passMatch = raw.match(/(\d+)\s+pass/);
  if (passMatch) passed = parseInt(passMatch[1]!, 10);

  // Match " N fail" pattern from bun test
  const failMatch = raw.match(/(\d+)\s+fail/);
  if (failMatch) failed = parseInt(failMatch[1]!, 10);

  const total = passed + failed;

  return { passed, failed, total, durationMs, raw };
}
