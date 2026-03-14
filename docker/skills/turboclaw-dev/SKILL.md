---
name: turboclaw-dev
description: Complete guide to developing and operating TurboClaw — architecture, DB schema, API, CLI commands, and codebase conventions
---

# TurboClaw Development Guide

You are working inside a TurboClaw worker container. TurboClaw is a Dockerized AI agent runner with three strict layers: **tracker** (source of truth, SQLite), **orchestrator** (policy engine), and **agent** (you, running in Docker). It's controlled via TUI, REST API, or WhatsApp.

## Architecture — Three Layers

```
tracker (src/tracker/)       → owns ALL durable state in SQLite
orchestrator (src/orchestrator/) → polling loop: claims tasks, enforces policy, dispatches containers
agent (Docker container)     → you, executing tasks
```

**Hard boundaries:**
- Tracker owns state. Never put scheduling logic in the tracker.
- Orchestrator is stateless — reads from tracker, makes decisions.
- Agents just execute prompts and produce output.

## Tech Stack

- **Runtime:** Bun (NOT Node.js) — use `bun:sqlite`, `bun:test`, `Bun.serve()`, `Bun.spawn()`
- **Language:** TypeScript strict mode, TSX for TUI (Ink)
- **Database:** `bun:sqlite` (built-in, no external DB)
- **HTTP:** `Bun.serve()` — no Express, no Hono
- **TUI:** Ink (React for CLIs) + `@inkjs/ui`
- **Package manager:** Bun (no npm/yarn)

## Database Schema

The SQLite database is at `~/.turboclaw/turboclaw.db`. All queries use prepared statements via `src/tracker/store.ts`.

### Core Tables

**tasks** — the work queue:
```sql
id TEXT PRIMARY KEY,           -- UUID
pipeline_id TEXT,              -- optional, links to pipelines
stage TEXT,                    -- current pipeline stage
title TEXT NOT NULL,
description TEXT,
agent_role TEXT DEFAULT 'coder', -- coder|reviewer|planner|self-improve|librarian
priority INTEGER DEFAULT 0,    -- higher = picked first
status TEXT DEFAULT 'pending', -- pending|queued|running|done|failed|cancelled
max_retries INTEGER DEFAULT 3,
retry_count INTEGER DEFAULT 0,
reply_jid TEXT,                -- WhatsApp JID for reply routing
created_at INTEGER,            -- unix epoch seconds
updated_at INTEGER
```

**runs** — one per task execution attempt:
```sql
id TEXT PRIMARY KEY, task_id TEXT, status TEXT DEFAULT 'running',
container_id TEXT, started_at INTEGER, finished_at INTEGER, exit_code INTEGER
```

**events** — stdout/stderr log lines from container:
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT, payload TEXT, created_at INTEGER
```

**leases** — prevents double-claiming:
```sql
id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, worker TEXT, expires_at INTEGER, released INTEGER DEFAULT 0
```

**crons** — recurring tasks:
```sql
id TEXT PRIMARY KEY, name TEXT, schedule TEXT, task_template TEXT (JSON),
enabled INTEGER DEFAULT 1, one_shot INTEGER DEFAULT 0, last_run_at INTEGER, next_run_at INTEGER
```

**alerts** — system notifications:
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, message TEXT, task_id TEXT, acknowledged INTEGER DEFAULT 0
```

**chat_messages** — WhatsApp conversation history:
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT, role TEXT, content TEXT, task_id TEXT
```

**pipelines** — multi-stage workflows:
```sql
id TEXT PRIMARY KEY, name TEXT, stages TEXT (JSON array)
```

**gates** — approval gates between pipeline stages:
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT, pipeline_id TEXT, from_stage TEXT, to_stage TEXT, approved INTEGER DEFAULT 0
```

**artifacts** — files produced by runs:
```sql
id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, name TEXT, path TEXT, mime_type TEXT, size_bytes INTEGER
```

### Useful Queries

```sql
-- List recent tasks
SELECT id, title, status, priority, agent_role, created_at FROM tasks ORDER BY created_at DESC LIMIT 20;

-- See what's running now
SELECT t.title, r.id as run_id, r.started_at FROM tasks t JOIN runs r ON r.task_id = t.id WHERE r.status = 'running';

-- Get logs for a run
SELECT kind, payload, created_at FROM events WHERE run_id = ? ORDER BY id ASC;

-- Check queue depth
SELECT status, COUNT(*) as count FROM tasks GROUP BY status;

-- List crons
SELECT name, schedule, enabled, next_run_at FROM crons ORDER BY created_at DESC;

-- Recent alerts
SELECT kind, message, acknowledged, created_at FROM alerts ORDER BY created_at DESC LIMIT 10;

-- Failed tasks with exit codes
SELECT t.title, r.exit_code, r.finished_at FROM tasks t JOIN runs r ON r.task_id = t.id WHERE t.status = 'failed' ORDER BY r.finished_at DESC LIMIT 10;
```

### Important DB Rules
- All IDs are UUIDs (`crypto.randomUUID()`), except events/gates/alerts which auto-increment
- All timestamps are unix epoch seconds (INTEGER), not milliseconds
- JSON is stored in TEXT columns (stages, task_template) — always validate on read
- Always use `db.prepare()`, never string interpolation
- `PRAGMA foreign_keys = ON` is enforced

## REST API

The gateway runs on port 7800 (configurable). All responses are JSON.

```bash
# Health check
curl http://localhost:7800/health

# Queue status
curl http://localhost:7800/status

# Create a task
curl -X POST http://localhost:7800/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title": "Fix login bug", "description": "The OAuth flow fails on redirect", "agentRole": "coder", "priority": 5}'

# List tasks (with filters)
curl 'http://localhost:7800/tasks?status=queued&limit=10'

# Get task detail (includes latest run)
curl http://localhost:7800/tasks/<task-id>

# Cancel a task
curl -X POST http://localhost:7800/tasks/<task-id>/cancel

# Stream run events (SSE)
curl http://localhost:7800/runs/<run-id>/events

# List artifacts
curl 'http://localhost:7800/artifacts?taskId=<task-id>'

# Create a pipeline
curl -X POST http://localhost:7800/pipelines \
  -H 'Content-Type: application/json' \
  -d '{"name": "deploy", "stages": ["code", "review", "deploy"]}'
```

## CLI Commands

```bash
bun run src/index.ts                    # Launch TUI
bun run src/index.ts --headless         # API + orchestrator, no TUI
bun run src/index.ts setup              # Onboarding wizard
bun run src/index.ts task create --title "Fix bug" --role coder
bun test                                 # Run all tests
bun test tests/tracker.test.ts           # Run specific test
bun run scripts/build-worker.ts          # Build Docker worker image
```

## File Organization

```
src/
  index.ts              — entry point (routes to TUI or headless)
  config.ts             — config loader, TurboClawConfig type
  logger.ts             — leveled logger with file redirect for TUI
  ids.ts                — UUID generation

  tracker/
    schema.ts           — DDL string, applied on boot
    store.ts            — ALL SQLite queries (prepared statements)
    types.ts            — Task, Run, Event, Pipeline, Cron, Alert, etc.
    pipelines.ts        — pipeline stage advancement

  orchestrator/
    loop.ts             — main tick loop (claims tasks, spawns containers)
    cron-parser.ts      — 5-field cron expression parser
    strategies.ts       — fifo, priority, round-robin scheduling

  container/
    manager.ts          — docker run/kill/logs/cleanup
    agent-commands.ts   — resolves agent type → CLI command
    credentials.ts      — credential path resolution
    self-improve.ts     — self-improve mode validation

  gateway/
    server.ts           — Bun.serve() setup
    routes.ts           — route handlers (functions, not classes)

  memory/
    vault.ts            — filesystem-based memory (Obsidian-compatible)
    context.ts          — builds core + search-based context for prompts
    auto-memory.ts      — auto-captures task output as daily notes

  skills/
    discovery.ts        — auto-discover skills from registries
    registry.ts         — ClawhHub + n-skills registry clients
    cache.ts            — local filesystem skill cache

  whatsapp/
    bridge.ts           — WhatsApp Web via Baileys
    parser.ts           — command parser (/task, /status, /list, etc.)

  tui/
    app.tsx             — root Ink component, screen router
    screens/            — Dashboard, Tasks, Crons, Alerts, Logs, Settings, Memory
```

## Code Conventions

- **No classes** — use plain functions and objects
- **No `any`** — use `unknown` + narrowing
- **No barrel exports** — import from specific files
- **Files:** `kebab-case.ts`, **Functions:** `camelCase`, **Types:** `PascalCase`, **DB columns:** `snake_case`
- **Errors:** return `null` for not-found, throw for invariant violations
- **No console.log** — use `logger.info/warn/error` from `src/logger.ts`
- **UUIDs for all IDs** — `crypto.randomUUID()`
- **Unix timestamps** — `unixepoch('now')` in SQL, `Math.floor(Date.now() / 1000)` in TS

## Configuration

Single file: `~/.turboclaw/config.json`

```typescript
{
  gateway: { port: 7800, host: "0.0.0.0" },
  orchestrator: { pollIntervalMs: 2000, maxConcurrency: 2, leaseDurationSec: 600, schedulingStrategy: "priority" },
  selfImprove: { enabled: false },
  provider: { type: "anthropic", apiKey: "...", model: "..." } | null,
  agent: "opencode" | "claude-code" | "codex",
  workspaceRoot: "/path/to/project",
  whatsapp: { enabled: false, allowedNumbers: [], allowedGroups: [] },
  memory: { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 },
  skills: { autoDiscover: true, maxPerTask: 5, registries: ["clawhub", "n-skills"] }
}
```

Env var overrides: `TURBOCLAW_GATEWAY_PORT`, `TURBOCLAW_MAX_CONCURRENCY`, `TURBOCLAW_WORKSPACE_ROOT`, etc.

## Memory System (Three-Tier Zettelkasten)

Vault at `~/.turboclaw/memory/`, Obsidian-compatible markdown files.

| Tier | Dir | Injected | Lifecycle |
|------|-----|----------|-----------|
| Core | `core/` | Always (every prompt) | Permanent, user-managed |
| Daily | `tasks/` | Search-based | Auto-captured on task completion |
| Weekly | `weekly/` | Search-based | Auto-compiled from daily notes |

## Container Networking

- Host services (Ollama, APIs) are reachable via `host.docker.internal`
- `localhost`/`127.0.0.1` URLs in OpenCode config are auto-rewritten to `host.docker.internal`
- Workspace is mounted at `/workspace`, memory at `/workspace/.turboclaw/memory`

## Testing

```bash
bun test                              # all tests
bun test tests/tracker.test.ts        # tracker CRUD
bun test tests/crons.test.ts          # cron CRUD + scheduling
bun test tests/cron-parser.test.ts    # cron expression parsing
bun test tests/pipelines.test.ts      # pipeline stage advancement
bun test tests/memory.test.ts         # memory vault operations
bun test tests/orchestrator.test.ts   # scheduling strategies
bun test tests/gateway.test.ts        # API routes
bun test tests/container.test.ts      # container manager
bun test tests/skills.test.ts         # skill discovery + cache
```

## Common Development Tasks

### Adding a new API endpoint
1. Add route handler in `src/gateway/routes.ts` (pattern-match on pathname)
2. Use the `store` parameter for all DB operations
3. Return `json(data)` or `error(msg, status)`

### Adding a new store method
1. Add to the `Store` interface in `src/tracker/store.ts`
2. Add prepared statement in the `stmts` object
3. Implement the method in the returned object
4. Add tests in `tests/tracker.test.ts`

### Adding a new TUI screen
1. Create `src/tui/screens/my-screen.tsx` as a React functional component
2. Use Ink's `<Box>`, `<Text>`, `useInput()` for layout and keyboard handling
3. Add to the screen router in `src/tui/app.tsx`
4. Add nav entry in `src/tui/components/nav.tsx`

### Adding a new setting
1. Add field to `TurboClawConfig` in `src/config.ts`
2. Add default in `DEFAULT_CONFIG`
3. Add merge in `loadConfig()`
4. Add TUI toggle in `src/tui/screens/settings.tsx`

### Creating a cron
```typescript
store.createCron({
  name: "daily-report",
  schedule: "0 9 * * *",     // 9 AM daily
  taskTemplate: { title: "Generate daily report", agentRole: "coder", priority: 3 },
  oneShot: false,
});
```

### Working with self-improve mode
When `agent_role === "self-improve"`, the container gets TurboClaw's own source at `/project`. Always create a feature branch, never touch main.

## Task Self-Creation (Splitting Complex Tasks)

You can create new tasks from inside a container by calling the TurboClaw API. The API URL is available in the `$TURBOCLAW_API` environment variable.

**When to split tasks:**
- The task is too complex to complete in a single run
- Different parts need different agent roles (coding vs reviewing vs research)
- Work can be parallelized (independent subtasks)
- A multi-step workflow needs checkpoints

**How to create subtasks from inside a container:**

```bash
# Read the API URL from environment
API="${TURBOCLAW_API}"

# Create a subtask
curl -s -X POST "${API}/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Implement database migration",
    "description": "Add new users table with email and created_at columns",
    "agentRole": "coder",
    "priority": 5
  }'

# Create a review subtask (lower priority so it runs after coding)
curl -s -X POST "${API}/tasks" \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Review database migration changes",
    "description": "Check the migration for correctness, index coverage, and rollback safety",
    "agentRole": "reviewer",
    "priority": 3
  }'

# Check status of all tasks
curl -s "${API}/tasks?status=queued"

# Check your own task status
curl -s "${API}/tasks/${TURBOCLAW_TASK_ID}"
```

**Task fields you can set:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `title` | string | required | Short task description |
| `description` | string | null | Detailed prompt for the agent |
| `agentRole` | string | "coder" | coder, reviewer, planner, self-improve |
| `priority` | number | 0 | Higher = picked first (use 1-10) |

**Strategies for complex tasks:**

1. **Sequential** — create subtasks with decreasing priority so they run in order
2. **Parallel** — create subtasks with equal priority; the orchestrator runs up to `maxConcurrency` at once
3. **Pipeline** — create a pipeline with stages, then create a task assigned to it. The orchestrator advances through stages automatically, with optional approval gates between stages.

**Always tell the user what you did.** When you split a task, report back in your output which subtasks you created and why, so the user can track them in the TUI or via the API.

## Autonomous Continuation (Completion Protocol)

Every task prompt includes a **Completion Protocol** that you must follow before exiting. The protocol requires you to:

1. **Self-assess** — re-read the original request and verify your work addresses every part of it
2. **If complete** — report what you did and exit
3. **If incomplete** — create a follow-up task via the API with:
   - What was already done (so the next agent doesn't repeat work)
   - What specifically remains
   - Any context or gotchas for the next agent

This creates an autonomous loop: complex tasks keep spawning follow-ups until the work is fully done, without human intervention. The orchestrator picks up follow-up tasks automatically.

**Anti-patterns to avoid:**
- Don't create follow-ups for trivial cleanup
- Don't create circular follow-ups — if an approach failed, explain why so the next agent tries differently
- Don't create more than 2-3 follow-ups from a single task — if the work is that complex, create a pipeline instead
