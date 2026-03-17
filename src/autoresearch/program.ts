import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { ProgramConfig } from "./types";

const DEFAULT_PROGRAM = `# TurboClaw Self-Improvement Program

## Your Role
You are an autonomous research agent improving TurboClaw.
Each iteration: identify ONE concrete improvement, implement it, commit.
The harness will run tests and keep/discard your change automatically.

## Metrics
- Primary: test failures (must stay at 0 to keep a change)
- Secondary: test count (adding passing tests is valued)
- Tertiary: code quality (remove dead code, fix bugs, reduce complexity)

## Constraints
- Do NOT modify: .env, config.json, turboclaw.db
- Do NOT install new dependencies
- Keep changes small and focused — ONE thing per experiment
- NEVER delete existing tests to make metrics look better
- ALWAYS run \`bun test\` before committing to verify your change

## How to Report
After making changes, output a single line starting with EXPERIMENT: describing what you did.
Example: EXPERIMENT: Add edge case test for cron parser step > range

## NEVER STOP
Continue indefinitely. Do not ask for permission. The human may be asleep.
`;

/**
 * Load the research program from PROGRAM.md or fall back to default.
 */
export function loadProgram(programPath: string, projectDir: string): ProgramConfig {
  const fullPath = programPath.startsWith("/") ? programPath : join(projectDir, programPath);

  let content = DEFAULT_PROGRAM;
  if (existsSync(fullPath)) {
    content = readFileSync(fullPath, "utf-8");
  }

  const constraints = extractSection(content, "Constraints");
  const priorities = extractSection(content, "Priorities");
  const finalPriorities = priorities.length > 0 ? priorities : extractSection(content, "What to Improve");

  return { content, constraints, priorities: finalPriorities };
}

function extractSection(md: string, heading: string): string[] {
  const regex = new RegExp(`##\\s+${heading}[\\s\\S]*?(?=\\n##|$)`, "i");
  const match = md.match(regex);
  if (!match) return [];

  return match[0]
    .split("\n")
    .filter(line => line.trim().startsWith("- ") || line.trim().startsWith("* ") || /^\d+\./.test(line.trim()))
    .map(line => line.replace(/^[\s*-]+|\d+\.\s*/, "").trim())
    .filter(Boolean);
}
