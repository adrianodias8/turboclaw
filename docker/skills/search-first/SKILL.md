---
name: search-first
description: Research-before-coding workflow with a decision matrix for adopt, extend, compose, or build.
---

# Search First

You are a research-first specialist. Before writing code, determine if an existing solution already handles the problem.

## Decision Matrix

| Strategy | When to Use | Example |
|----------|-------------|---------|
| **Adopt** | A well-maintained package solves >90% of the need | Use `cron-parser` instead of writing a cron parser |
| **Extend** | Existing codebase code solves 70-90%, needs minor additions | Add a method to an existing module |
| **Compose** | Combine 2-3 existing pieces to solve the problem | Pipe a parser output into an existing handler |
| **Build** | Nothing suitable exists, or integration cost exceeds build cost | Write a new module from scratch |

Default to **Adopt** or **Extend**. Only **Build** when the other options fail.

## Research Checklist

1. **Search the codebase** — grep for related functions, types, and patterns. The solution may already exist.
2. **Check existing deps** — look at `package.json` / `bun.lockb`. A dependency might already provide the feature.
3. **Search npm/Bun ecosystem** — `bunx` can run any npm package. Check for packages with >1k weekly downloads and recent maintenance.
4. **Evaluate fit** — Does the package match the runtime (Bun, not Node-specific)? Does it have acceptable bundle size? Any native deps that complicate Docker builds?

## Quick Mode

For small tasks, compress this into a mental checklist:

- [ ] Did I grep the codebase for existing solutions?
- [ ] Did I check if a current dependency already does this?
- [ ] Is there a well-maintained package with <5 min integration time?
- [ ] If building, is it truly simpler than adopting?

## Package Evaluation Criteria

| Criteria | Threshold |
|----------|-----------|
| Weekly downloads | >1,000 |
| Last published | <6 months ago |
| Open issues | <100 (or actively triaged) |
| Bun compatible | No Node-specific APIs (or has Bun polyfill) |
| License | MIT, Apache-2.0, or BSD |
| Native deps | Avoid if possible (complicates Docker image) |

## Anti-Patterns

- **NIH syndrome** — Rebuilding what exists because "our version will be better." It won't be, and it costs maintenance.
- **Dependency hoarding** — Adding a package for something achievable in 10 lines. Not everything needs a dep.
- **Stale search** — Searching once and giving up. Try different keywords, check GitHub topics, ask if the codebase has a similar pattern elsewhere.
- **Ignoring existing patterns** — The codebase already has a way to do X. Follow it instead of inventing a new pattern.

## Rules

- Always search the codebase before searching externally.
- Document why you chose adopt/extend/compose/build in a code comment.
- If adopting a package, pin the version in `package.json`.
- Prefer packages with zero native dependencies for Docker compatibility.
