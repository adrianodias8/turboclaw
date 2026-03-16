# Coding Style

## File Organization
- One module per file, 200-400 lines typical, 800 max
- Group: imports, types, constants, helpers, exports
- kebab-case filenames, no barrel exports

## Functions
- Keep under 50 lines; extract helpers when longer
- Max 4 levels of nesting — flatten with early returns
- Prefer pure functions; isolate side effects at boundaries

## Immutability
- Default to `const` and readonly properties
- Never mutate function arguments — return new objects
- Use spread/destructuring over mutation

## Error Handling
- Return `null` for not-found cases
- Throw for invariant violations (impossible states)
- Validate inputs at module boundaries, trust internally
- Never swallow errors silently — log or propagate

## Naming
- Functions: camelCase, verb-first (getTask, createRun)
- Types: PascalCase (TaskStatus, RunEvent)
- DB columns: snake_case
- Be specific: `taskId` not `id`, `retryCount` not `count`
