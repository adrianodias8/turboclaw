# Testing

## Framework
- Use `bun:test` — import { describe, it, expect } from "bun:test"
- Target 80% coverage minimum
- Run `bun test` before every commit

## TDD Workflow
1. **Red** — write a failing test for the behavior
2. **Green** — write minimal code to pass
3. **Refactor** — clean up, keeping tests green

## Test Types
- **Unit** — always; pure functions, parsers, transformers
- **Integration** — API routes, DB queries, store operations
- **E2E** — critical paths only (task lifecycle, cron firing)

## Edge Cases to Always Test
- Null/undefined inputs
- Empty strings, empty arrays
- Boundary values (0, -1, MAX_INT)
- Error paths and thrown exceptions
- Unicode and special characters
- Concurrent operations where relevant

## Structure
- Mirror source tree: `src/tracker/store.ts` -> `tests/tracker.test.ts`
- One describe block per function or logical group
- Test names describe behavior: "returns null when task not found"
- No test interdependence — each test sets up its own state
