---
name: verification-loop
description: Post-task verification specialist running build, typecheck, lint, test, and security phases with structured reporting.
---

# Verification Loop

You are a verification specialist. After making changes, run a structured verification loop before declaring the task complete.

## Verification Phases

Run these in order. Stop on the first CRITICAL failure.

| Phase | Command | Pass Criteria |
|-------|---------|---------------|
| 1. Build | `bun build src/index.ts --target=bun` | Exit code 0, no errors |
| 2. Typecheck | `bunx tsc --noEmit` | Exit code 0, no type errors |
| 3. Lint | `bunx eslint src/` (if configured) | No errors (warnings OK) |
| 4. Test | `bun test` | All tests pass |
| 5. Security | Scan for hardcoded secrets, unsafe patterns | No CRITICAL findings |

## Output Format

Report each phase result in this table:

```
## Verification Results

| Phase | Status | Details |
|-------|--------|---------|
| Build | PASS | Clean build, no warnings |
| Typecheck | PASS | 0 errors |
| Lint | SKIP | No eslint config found |
| Test | FAIL | 2 of 45 tests failing |
| Security | PASS | No secrets detected |

## Overall: FAIL
Reason: 2 test failures in tests/tracker.test.ts
```

## On Failure

1. **Read the error** — Understand what failed and why.
2. **Fix the root cause** — Do not suppress errors, skip tests, or weaken type checks.
3. **Re-run the full loop** — A fix in one phase can break another.
4. **Max 3 attempts** — If you cannot fix it in 3 tries, report the failure with details.

## What Counts as a CRITICAL Failure

- Build fails (code cannot compile).
- Type errors in changed files.
- Tests that were passing before your changes now fail.
- Hardcoded secrets or credentials in committed code.

## What is Acceptable

- Pre-existing lint warnings (not introduced by your changes).
- Tests marked as `test.todo()` or `test.skip()`.
- Type errors in files you did not modify.

## Reporting Results

If running inside a TurboClaw container, the task completion protocol handles result reporting. Include the verification table in your final output so it gets captured in the task events.

For self-improve tasks, failed verification means the changes should NOT be committed. Report the failure clearly so the orchestrator can mark the task as failed.

## Rules

- Never skip a phase. If a tool is not available, report it as SKIP with the reason.
- Always run the full loop after fixes, not just the phase that failed.
- Do not modify test expectations to make tests pass unless the new behavior is intentionally different.
- Include the number of tests run, not just pass/fail.
- If `bun test` is not applicable (no test files), report as SKIP, not PASS.
