# CLAUDE.md — TurboClaw

## Project Overview

TurboClaw is a Dockerized AI agent runner that supports multiple agent backends (OpenCode, Claude Code, Codex). It uses nullclaw-style separation of concerns: tracker (source of truth), orchestrator (policy engine), agent (executor in Docker). Controllable via TUI, REST API, or WhatsApp. Built entirely on Bun with Bun's built-in SQLite.

## Tech Stack

- **Runtime:** Bun (latest) — NOT Node.js
- **Database:** `bun:sqlite` (built-in SQLite, no external DB)
- **Language:** TypeScript (strict mode), TSX for TUI components
- **TUI:** Ink (React for CLIs) + `@inkjs/ui` components
- **Container:** Docker (worker containers run agents)
- **Agents:** OpenCode (default), Claude Code (`claude -p`), Codex (`codex exec`) — configurable per instance
- **Browser:** opencode-browser plugin with agent-browser backend (headless Playwright)
- **HTTP:** `Bun.serve()` — no Express, no Hono, no frameworks
- **WhatsApp:** `@whiskeysockets/baileys` for WhatsApp Web bridge
- **Testing:** `bun:test`
- **Package manager:** Bun (no npm, no yarn)

## Architecture — Three Strict Layers

```
tracker = source of truth    → src/tracker/
orchestrator = policy engine → src/orchestrator/
agent = executor             → Docker container running OpenCode/Claude Code/Codex
```

These boundaries are HARD. Never:
- Put scheduling logic in the tracker
- Put task state in the orchestrator
- Put orchestration policy in the agent container

### Tracker (`src/tracker/`)
Owns ALL durable state: tasks, runs, leases, events, gates, artifacts, pipelines, crons, alerts.
Uses Bun's built-in SQLite. All queries go through `store.ts`.

### Orchestrator (`src/orchestrator/`)
A polling loop that: claims tasks from tracker, enforces concurrency limits, applies retry/backoff, dispatches to container manager, ticks crons, checks expired leases, emits alerts. Configuration-driven, stateless (reads state from tracker).

### Container Manager (`src/container/`)
Spawns Docker containers running the configured agent CLI. Each task gets its own container with a mounted workspace. Streams stdout/stderr back as tracker events. Agent command is resolved via `agent-commands.ts`.

### Gateway (`src/gateway/`)
REST API via `Bun.serve()`. Thin layer over tracker operations. SSE for event streaming.

### TUI (`src/tui/`)
Interactive terminal interface built with **Ink** (React for CLIs) + `@inkjs/ui`. Seven screens: Dashboard, Tasks, Crons, Alerts, Logs, Settings, Memory.

**Key rules for TUI code:**
- All screens are React functional components using Ink's `<Box>` and `<Text>` primitives
- Layout via Flexbox (same as web React, but `<Box>` instead of `<div>`)
- Use `@inkjs/ui` components (TextInput, Select, Spinner, ProgressBar) — don't reinvent them
- Screen state lives in React hooks; persistent state goes through tracker store or config
- Navigation between screens uses a simple state machine in `app.tsx`
- The TUI must work in both full terminal and narrow (80-col) modes

### WhatsApp Bridge (`src/whatsapp/`)
Sidecar process using Baileys for WhatsApp Web. Parses commands (`/task`, `/status`, `/list`, `/cancel`, `/help`), executes against the store, sends notifications on task completion/failure. Decoupled from orchestrator — if it crashes, TurboClaw keeps running.

**Entry point routing in `index.ts`:**
```typescript
if (args.includes("--headless")) {
  // Start gateway + orchestrator + optional WhatsApp bridge, no TUI
  bootHeadless(config);
} else if (args.includes("setup")) {
  // Run onboarding wizard
  renderOnboarding(config);
} else {
  // Default: full TUI with embedded gateway + orchestrator + WhatsApp
  renderApp(config);
}
```

## Code Conventions

### File Organization
```
src/
  index.ts          — entry point, routes to TUI or headless
  config.ts         — config loader (JSON file + env vars)
  ids.ts            — crypto.randomUUID() wrappers, token generation
  logger.ts         — leveled logger (info, warn, error), file redirect via setLogFile() for TUI mode

  tui/
    app.tsx         — root Ink component, screen router, navigation state
    cli.tsx         — CLI arg parsing, calls render(<App/>)
    screens/
      dashboard.tsx — two-column: health metrics, active runs, completions, crons
      onboarding.tsx — first-run wizard (Docker check, provider pick, cred verify, core memory setup)
      settings.tsx  — config editor (providers, concurrency, agent type, WhatsApp toggle)
      tasks.tsx     — task list, create inline
      task-detail.tsx — single task: events, artifacts, retry/cancel
      crons.tsx     — cron CRUD ([n] create, [Enter] toggle, [d] delete, [r] run now)
      alerts.tsx    — alert list, color-coded, acknowledge actions
      pipelines.tsx — pipeline CRUD (accessible from settings)
      logs.tsx      — live event stream viewer
      memory.tsx    — three-tier memory management (core/daily/weekly sub-tabs)
    components/
      nav.tsx       — tab navigation: [1] Dashboard [2] Tasks [3] Crons [4] Alerts [5] Logs [6] Settings [7] Memory
      status-bar.tsx — bottom bar: queue, workers, uptime, alert badge, provider, WA status
      task-row.tsx  — single row in task list
      event-stream.tsx — scrollable log
      qr-display.tsx — WhatsApp QR code renderer
    hooks/
      use-tracker.ts — wraps tracker store queries (tasks, pipelines, status)
      use-health.ts — health status, active runs, alert count, cron list, alert list
      use-orchestrator.ts — orchestrator status polling
      use-config.ts — read/write config
      use-memory.ts — polls memory vault notes by tier (core/daily/weekly)

  tracker/
    schema.ts       — DDL as a string constant, applied on boot
    store.ts        — all SQLite queries (prepared statements)
    types.ts        — Pipeline, Task, Run, Lease, Event, Gate, Artifact, Cron, Alert
    pipelines.ts    — pipeline stage advancement logic

  orchestrator/
    loop.ts         — main poll loop (tick, tickCrons, tickExpiredLeases)
    cron-parser.ts  — 5-field cron expression parser, nextRunAt computation
    strategies.ts   — scheduling: fifo, priority, round-robin
    types.ts        — OrchestratorConfig, SchedulingStrategy

  container/
    manager.ts      — docker run, docker kill, stream logs
    builder.ts      — docker build for worker image
    agent-commands.ts — resolves agent type to CLI command, env vars, credential paths
    credentials.ts  — OAuth/subscription credential path resolution
    self-improve.ts — self-improve mode validation and setup
    types.ts        — ContainerConfig, SpawnOptions

  gateway/
    server.ts       — Bun.serve() setup
    routes.ts       — route handlers (functions, not classes)
    types.ts        — request/response shapes

  memory/
    vault.ts        — open vault, list notes, read/write markdown files (dirs: inbox, notes, projects, tasks, agents, templates, core, weekly)
    search.ts       — full-text search, tag lookup, wikilink graph traversal
    writer.ts       — create notes from templates (fleeting, permanent, task-log, core) + updateNoteContent()
    context.ts      — buildCoreContext() (always injected) + buildContext() (search-based)
    auto-memory.ts  — auto-capture task output with daily + date tags
    librarian.ts    — inbox processing, link discovery, orphan detection, weekly compilation, expired memory pruning
    scheduler.ts    — periodic librarian runner with retention config (dailyRetentionDays, weeklyRetentionWeeks)
    templates.ts    — note template strings with frontmatter (fleeting, permanent, task-log, moc, core, weekly)
    types.ts        — MemoryNote, VaultConfig, SearchResult; NoteType includes "core" | "weekly-summary"

  whatsapp/
    bridge.ts       — main WhatsApp bridge (Baileys + reconnect + QR callback + group support)
    parser.ts       — message → command parser (/task, /status, /list, /cancel, /help)
    notifier.ts     — polls for completed/failed tasks, sends WhatsApp messages
    types.ts        — WhatsAppConfig (includes allowedGroups), ParsedCommand
```

### Style Rules

- **No classes** except where Bun APIs require them. Use plain functions and objects.
- **No `any`** — use `unknown` + type narrowing if unsure.
- **No barrel exports** — import from specific files.
- **Prepared statements** — all SQL queries must use `db.prepare()`, never string interpolation.
- **UUIDs everywhere** — `crypto.randomUUID()` for all IDs. No auto-increment for primary keys (except events, gates, alerts which are append-only).
- **Unix timestamps** — all dates stored as `INTEGER` (seconds since epoch) using `unixepoch('now')`.
- **JSON in TEXT columns** — for flexible metadata, stages definitions, cron task templates. Always validate on read.
- **Error handling** — return `null` for not-found, throw for invariant violations.
- **No console.log in library code** — use a simple logger: `src/logger.ts` with levels.

### Naming

- Files: `kebab-case.ts`
- Functions: `camelCase`
- Types/Interfaces: `PascalCase`
- Database columns: `snake_case`
- Config keys: `camelCase`
- Environment variables: `TURBOCLAW_*` prefix

### SQL Schema Rules

- All tables have `created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))`
- Primary keys are `TEXT` (UUIDs) except append-only tables (events, gates, alerts)
- Foreign keys are enforced: `PRAGMA foreign_keys = ON;`
- Indexes on all columns used in WHERE clauses and JOINs

## Multi-Agent Support

TurboClaw supports three agent backends, configured via `config.agent`:

| Agent | Command | Auth | Credential Path |
|-------|---------|------|-----------------|
| `opencode` (default) | `opencode run --model {model} "{prompt}"` | Mounts host config | `~/.config/opencode/`, `~/.local/share/opencode/` |
| `claude-code` | `claude -p "{prompt}" --dangerously-skip-permissions` | API key or OAuth token | `~/.claude/` |
| `codex` | `codex exec --full-auto "{prompt}"` | Subscription | `~/.codex/` |

Agent resolution happens in `src/container/agent-commands.ts`. The orchestrator calls `buildAgentCommand()` to get the CLI args, then passes them as `agentCommand` in spawn options. The container manager uses `opts.agentCommand` if present, falling back to the default.

For `opencode-config` provider, the `--model` flag is stripped — opencode uses its own config entirely.

### Container Network & Credential Handling

- Host `$HOME` paths are remapped to `/home/agent` inside the container
- `--add-host host.docker.internal:host-gateway` enables containers to reach host services (Ollama, etc.)
- `localhost`/`127.0.0.1` URLs in opencode's config are rewritten to `host.docker.internal` at spawn time
- Data dirs (`~/.local/share/`) are mounted read-write; config dirs (`~/.config/`) are mounted read-only
- `OLLAMA_HOST` env var is set to `http://host.docker.internal:11434` for OpenCode containers

## Docker Worker Image

The OpenCode worker image (`docker/Dockerfile.opencode`) contains:
- Bun runtime
- OpenCode CLI
- opencode-browser (with agent-browser backend for headless Chrome)
- Chromium (for agent-browser)
- Pre-created `/home/agent/.local/state` and `.local/share` directories

Workers are ephemeral — one container per task run, destroyed after completion. No fixed entrypoint; the container manager passes the full command.

## Cron System

Recurring tasks are defined in the `crons` table with standard 5-field cron expressions. The orchestrator's `tickCrons()` function runs alongside the main task `tick()`:

1. Queries `store.getDueCrons()` for enabled crons where `next_run_at <= now`
2. Parses `task_template` JSON, creates a task, queues it
3. Updates `last_run_at` and computes `next_run_at` via `cron-parser.ts`

Cron parser (`src/orchestrator/cron-parser.ts`) handles: `*`, ranges (`1-5`), steps (`*/5`), lists (`1,3,5`).

## Alert System

Alerts are emitted automatically by the orchestrator:
- `task_failed` — when a task fails after all retries exhausted
- `lease_expired` — when a lease expires without being released
- `whatsapp_disconnect` — when the WhatsApp bridge disconnects

Alerts surface in the TUI Alerts screen (color-coded by kind) and can be acknowledged individually or in bulk. On WhatsApp reconnection, previous `whatsapp_disconnect` alerts are automatically acknowledged.

## Skills System

Two-tier approach: **seed skills** baked into the Docker image + **runtime discovery** where agents fetch skills on-the-fly during task execution.

### Tier 1: Seed Skills (Docker build time)
A base set from `config/skills-manifest.json` is pre-installed via `scripts/fetch-skills.ts`. Avoids cold-start latency.

### Tier 2: Runtime Discovery (during task execution)
The container includes `openskills` and `opencode-skillful` CLIs. Agents can search/install from marketplaces at runtime.

### What NOT to do with skills
- **Do NOT create a custom skills framework.** Use OpenCode's native skill system.
- **Do NOT adopt NanoClaw's "skills over features" contribution model.** We accept normal code PRs.

## Self-Improvement Mode

TurboClaw can mount its own source code into worker containers so agents can improve the project itself. Enabled via config or TUI toggle. Always creates a feature branch, never touches main.

## Memory System — Three-Tier Zettelkasten (`src/memory/`)

TurboClaw's long-term memory is an Obsidian-compatible vault at `~/.turboclaw/memory/`, organized in three tiers. Pure filesystem — no Obsidian app dependency.

### Three Memory Tiers

| Tier | Dir | Injected | Lifecycle | Editable |
|------|-----|----------|-----------|----------|
| **Core** | `core/` | Always (every prompt) | Permanent, user-managed | Full CRUD via TUI |
| **Daily** | `tasks/` | Search-based | Auto-captured on task completion, pruned after N days | View/delete via TUI |
| **Weekly** | `weekly/` | Search-based | Auto-compiled from daily, pruned after N weeks | View/delete/regen via TUI |

### Prompt Injection Order
```
# Core Memory              ← always injected (from core/)
---
# Relevant Memory Notes    ← search-based (from tasks/ + weekly/)
---
# Recent Conversation      ← chat history (WhatsApp tasks only)
---
<actual task prompt>
```

### Memory Lifecycle
- **Core notes** are created during onboarding (name, role, context, preferences + 4 base agent behavior notes) or via TUI Memory screen `[7]`. Core notes are always injected and excluded from search-based context to prevent duplication.
- **Daily notes** are auto-generated when tasks complete, tagged with `daily-YYYY-MM-DD`. Unhelpful responses (refusals, "done", "I don't know") are filtered out and not saved.
- **Weekly summaries** are compiled by the librarian from the previous week's daily notes
- **Pruning** runs on the librarian interval: daily notes older than `dailyRetentionDays`, weekly notes older than `weeklyRetentionWeeks * 7` days

## Configuration

Single JSON file: `~/.turboclaw/config.json` (or `$TURBOCLAW_HOME/config.json`).

Env var overrides follow pattern: `TURBOCLAW_GATEWAY_PORT=7800` → `config.gateway.port`.

### Config Shape

```typescript
{
  gateway: { port: 7800, host: "0.0.0.0" },
  orchestrator: { pollIntervalMs: 2000, maxConcurrency: 2, leaseDurationSec: 600, schedulingStrategy: "priority" },
  selfImprove: { enabled: false },
  provider: { type: "anthropic", apiKey?: "...", baseUrl?: "...", model?: "..." } | null,
  agent: "opencode" | "claude-code" | "codex",  // optional, defaults to "opencode"
  whatsapp: { enabled: false, allowedNumbers: [], allowedGroups: [], notifyOnComplete: false, notifyOnFail: false },
  memory: { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 },
}
```

Env var overrides for memory: `TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS`, `TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS`.

### Provider Types

**Onboarding offers two options:**

| Type | Auth method | What TurboClaw does |
|------|------------|-------------------|
| `claude-code` | API key or OAuth token | Stores in config, sets agent to `claude-code` |
| `opencode-config` | None (mounts host config) | Mounts `~/.config/opencode/` and `~/.local/share/opencode/`, sets agent to `opencode` |

The `opencode-config` option supports any provider the user has configured in their host OpenCode installation (Copilot, ChatGPT, Ollama, Codex, etc.) — no additional auth needed in TurboClaw.

## Build & Run Commands

```bash
bun install                              # Install dependencies
bun run src/index.ts                     # Launch TUI (default)
bun run src/index.ts setup              # Onboarding wizard
bun run src/index.ts --headless         # Headless mode (API + orchestrator)
bun test                                 # Run all tests
bun run scripts/build-worker.ts         # Build worker Docker image
bun run src/index.ts task create --title "Fix the login bug" --role coder
curl http://localhost:7800/status       # Check status via API
```

## API Contract

All responses are JSON. Errors return `{ "error": "message" }` with appropriate HTTP status.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | /health | — | `{ "ok": true }` |
| POST | /pipelines | `{ name, stages[] }` | Create pipeline |
| GET | /pipelines | — | List all |
| POST | /tasks | `{ pipelineId, title, description?, agentRole?, priority? }` | Create task |
| GET | /tasks?stage=&status=&limit=&cursor= | — | List tasks |
| GET | /tasks/:id | — | Task detail with latest run |
| POST | /tasks/:id/cancel | — | Cancel task |
| GET | /runs/:id/events | — | SSE stream of run events |
| GET | /artifacts?taskId=&runId= | — | List artifacts |
| GET | /status | — | Queue depth, active workers |

## What NOT to Build

- No web UI (TUI is the primary interface; API for programmatic access)
- No WebSocket server (SSE is sufficient)
- No custom skills framework (use OpenCode native skills + marketplace CLIs)
- No multi-user auth (single user, single instance)
- No message queue (SQLite + polling is the queue)
- No microservices (single Bun process)
- No ORM (raw SQL with prepared statements)
- No custom TUI framework (use Ink)
- No vector database for memory (Obsidian vault + full-text search + wikilink graph)

## Testing Strategy

```bash
bun test                              # all tests (152 passing across 15 files)
bun test tests/tracker.test.ts        # tracker CRUD
bun test tests/crons.test.ts          # cron CRUD
bun test tests/alerts.test.ts         # alert CRUD
bun test tests/cron-parser.test.ts    # cron expression parsing
bun test tests/pipelines.test.ts      # pipeline stage advancement
bun test tests/memory.test.ts         # memory vault operations
bun test tests/memory-tiers.test.ts   # core/daily/weekly memory tiers
bun test tests/credentials.test.ts    # credential path resolution
bun test tests/self-improve.test.ts   # self-improve validation
bun test tests/orchestrator.test.ts   # scheduling strategies
bun test tests/gateway.test.ts        # API routes
bun test tests/container.test.ts      # container manager
```

## Deployment Target

Self-hosted on Hetzner. Single Docker Compose stack:
- TurboClaw host process (Bun)
- Docker socket mounted for container management
- Persistent volume for SQLite DB + workspaces
- Network bridge for worker containers
