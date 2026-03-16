# TypeScript Patterns (TurboClaw)

## Runtime
- Bun only — never use Node.js APIs when Bun equivalents exist
- Use `bun:sqlite` for database, `bun:test` for testing
- Use `Bun.serve()` for HTTP — no Express, Hono, or frameworks

## Type Safety
- No `any` — use `unknown` with type narrowing
- No type assertions (`as`) unless provably safe
- Prefer discriminated unions over optional fields
- Validate JSON from TEXT columns on read

## Architecture
- No classes — use plain functions and objects
- No barrel exports — import from specific files
- No deep module nesting — max 2 directory levels

## Database
- All queries via `db.prepare()` with bound parameters
- Primary keys: `TEXT` with `crypto.randomUUID()`
- Timestamps: `INTEGER` (unix epoch seconds)
- JSON stored in `TEXT` columns, validated on read
- Always include `created_at INTEGER DEFAULT (unixepoch('now'))`

## Patterns
- Prefer `const` and immutable data
- Use early returns to reduce nesting
- Destructure function parameters for clarity
- Export named functions, not default exports
- Logger (`src/logger.ts`) instead of console.log
