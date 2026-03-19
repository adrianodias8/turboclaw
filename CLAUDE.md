# CLAUDE.md — TurboClaw

## Project Overview

TurboClaw is a Dockerized AI agent runner that supports multiple agent backends (OpenCode, Claude Code). It uses nullclaw-style separation of concerns: tracker (source of truth), orchestrator (policy engine), agent (executor in Docker). Controllable via TUI, REST API, or WhatsApp. Built entirely on Bun with Bun's built-in SQLite.

## Tech Stack

- **Runtime:** Bun (latest) — NOT Node.js
- **Database:** `bun:sqlite` (built-in SQLite, no external DB)
- **Language:** TypeScript (strict mode), TSX for TUI components
- **TUI:** Ink (React for CLIs) + `@inkjs/ui` components
- **Container:** Docker (worker containers run agents)
- **Agents:** OpenCode (default), Claude Code (`claude -p`) — configurable per instance
- **Browser:** opencode-browser plugin with agent-browser backend (headless Playwright)
- **HTTP:** `Bun.serve()` — no Express, no Hono, no frameworks
- **WhatsApp:** `@whiskeysockets/baileys` for WhatsApp Web bridge
- **Testing:** `bun:test`
- **Package manager:** Bun (no npm, no yarn)

## Architecture — Three Strict Layers

```
tracker = source of truth    → src/tracker/
orchestrator = policy engine → src/orchestrator/
agent = executor             → Docker container running OpenCode/Claude Code
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
Interactive terminal interface built with **Ink** (React for CLIs) + `@inkjs/ui`. Nine screens: Dashboard, Tasks, Crons, Memory, Alerts, Logs, Settings, Experiments, Pipelines.

**Key rules for TUI code:**
- All screens are React functional components using Ink's `<Box>` and `<Text>` primitives
- Layout via Flexbox (same as web React, but `<Box>` instead of `<div>`)
- Use `@inkjs/ui` components (TextInput, Select, Spinner, ProgressBar) — don't reinvent them
- Screen state lives in React hooks; persistent state goes through tracker store or config
- Navigation between screens uses a simple state machine in `app.tsx`
- The TUI must work in both full terminal and narrow (80-col) modes

### WhatsApp Bridge (`src/whatsapp/`)
Sidecar process using Baileys for WhatsApp Web. Parses commands (`/task`, `/status`, `/list`, `/cancel`, `/restart`, `/help`), executes against the store, sends notifications on task completion/failure. Decoupled from orchestrator — if it crashes, TurboClaw keeps running.

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
      experiments.tsx — autoresearch experiment sessions and results
    components/
      nav.tsx       — tab navigation: [1] Dashboard [2] Tasks [3] Crons [4] Memory [5] Alerts [6] Logs [7] Settings [8] Experiments [9] Pipelines
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
    schema.ts       — DDL as a string constant, applied on boot; FTS5 virtual table for event search
    store.ts        — all SQLite queries (prepared statements); searchEvents(), getInsights()
    types.ts        — Pipeline, Task, Run, Lease, Event, Gate, Artifact, Cron, Alert, EventSearchResult, InsightsResult
    pipelines.ts    — pipeline stage advancement logic
    insights.ts     — token usage parsing from agent output, cost estimation per model

  orchestrator/
    loop.ts         — main poll loop (tick, tickCrons, tickExpiredLeases); prompt assembly, checkpoint, token tracking
    cron-parser.ts  — 5-field cron expression parser, nextRunAt computation
    strategies.ts   — scheduling: fifo, priority, round-robin
    routing.ts      — smart model routing (complexity evaluation, cheap vs strong model selection)
    types.ts        — OrchestratorConfig, SchedulingStrategy

  container/
    manager.ts      — docker run, docker kill, stream logs
    builder.ts      — docker build for worker image
    agent-commands.ts — resolves agent type to CLI command, env vars, credential paths
    credentials.ts  — OAuth/subscription credential path resolution
    self-improve.ts — self-improve mode validation, env setup, preamble
    completion.ts   — completion protocol preamble (memory, skills, search instructions)
    checkpoint.ts   — shadow git snapshots for workspace rollback
    utils.ts        — pure utility functions (remapHomePath, rewriteLocalhostUrls)
    types.ts        — ContainerConfig, SpawnOptions

  gateway/
    server.ts       — Bun.serve() setup, accepts restart callback + vaultPath, skillsDir, checkpointsBase
    routes.ts       — route handlers (functions, not classes); memory, skills, checkpoint, search, insights endpoints
    types.ts        — request/response shapes

  security/
    injection-scanner.ts — prompt injection detection (5 threat categories + invisible unicode)

  skills/
    discovery.ts    — auto-discover skills from registries based on task prompt
    registry.ts     — ClawhHub + n-skills registry clients
    cache.ts        — local filesystem skill cache
    manager.ts      — agent-created skill CRUD (create, patch, delete, list, find)
    guard.ts        — security scanning for skill content (injection detection + unicode stripping)
    types.ts        — SkillManifest, RegistryConfig, DiscoveryResult

  memory/
    vault.ts        — open vault, list notes, read/write markdown files (dirs: inbox, notes, projects, tasks, agents, templates, core, weekly)
    search.ts       — full-text search, tag lookup, wikilink graph traversal (excludes core + agent notes)
    writer.ts       — create notes from templates (fleeting, permanent, task-log, core) + updateNoteContent()
    context.ts      — buildCoreContext() + buildAgentMemoryContext() + buildContext() (search-based)
    agent-memory.ts — agent-writable memory CRUD via REST API (add, replace, remove, budget)
    auto-memory.ts  — auto-capture task output with daily + date tags
    librarian.ts    — inbox processing, link discovery, orphan detection, weekly compilation, expired memory pruning
    scheduler.ts    — periodic librarian runner with retention config (dailyRetentionDays, weeklyRetentionWeeks)
    instincts.ts    — pattern learning system (trigger/action pairs with confidence decay + evidence tracking)
    templates.ts    — note template strings with frontmatter (fleeting, permanent, task-log, moc, core, weekly, agent)
    types.ts        — MemoryNote, VaultConfig, SearchResult; NoteType includes "core" | "weekly-summary" | "agent"

  autoresearch/
    loop.ts         — autonomous research loop (time-budgeted experiment runner)
    program.ts      — parses PROGRAM.md into structured constraints + priorities
    ledger.ts       — experiment session + result tracking (persisted to tracker store)
    metrics.ts      — test runner metrics extraction (pass/fail/duration)
    types.ts        — TestMetrics, ProgramConfig

  whatsapp/
    bridge.ts       — main WhatsApp bridge (Baileys + reconnect + QR callback + group support)
    parser.ts       — message → command parser (/task, /status, /list, /cancel, /restart, /help)
    notifier.ts     — polls for completed/failed tasks, sends WhatsApp messages, retries on reconnect
    time-parser.ts  — parses time references ("in 5 minutes", "at 14:30") for scheduled tasks
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

TurboClaw supports two agent backends, configured via `config.agent`:

| Agent | Command | Auth | Credential Path |
|-------|---------|------|-----------------|
| `opencode` (default) | `opencode run --model {model} "{prompt}"` | Mounts host config | `~/.config/opencode/`, `~/.local/share/opencode/` |
| `claude-code` | `claude -p "{prompt}" --dangerously-skip-permissions` | API key or OAuth token | `~/.claude/` |

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
- `prompt_truncated` — when prompt exceeds 180K char budget and layers are dropped
- `security_warning` — when task prompt may contain secrets

Alerts surface in the TUI Alerts screen (color-coded by kind) and can be acknowledged individually or in bulk. On WhatsApp reconnection, previous `whatsapp_disconnect` alerts are automatically acknowledged.

## Skills System

Three-tier approach: **seed skills** baked into the Docker image + **auto-discovery** at task dispatch time + **agent-created skills** from experience.

### Tier 1: Seed Skills (Docker build time)
A base set from `docker/skills-manifest.json` is baked into the worker image. Includes `turboclaw-dev`, `git-workflow`, `task-completion`, `web-research`. Avoids cold-start latency.

### Tier 2: Auto-Discovery (at task dispatch)
The orchestrator runs `src/skills/discovery.ts` before spawning a container. It extracts keywords from the task prompt, queries ClawhHub and n-skills registries, caches results locally, and mounts matching skills into the container. Controlled via `config.skills` (`autoDiscover`, `maxPerTask`, `registries`).

### Tier 3: Agent-Created Skills (self-learning)
Agents can create and patch reusable SKILL.md files via the REST API (`POST /skills`, `PATCH /skills/:name`). Skills are stored at `.turboclaw/skills/` and automatically mounted into subsequent containers. All agent-written skill content is scanned for prompt injection before acceptance (`src/skills/guard.ts`).

### What NOT to do with skills
- **Do NOT create a custom skills framework.** Use OpenCode's native skill system.
- **Do NOT adopt NanoClaw's "skills over features" contribution model.** We accept normal code PRs.

## Self-Improvement Mode

TurboClaw can mount its own source code into worker containers so agents can improve the project itself. Enabled via config or TUI toggle. Always creates a feature branch, never touches main.

### Auto-Restart

After a self-improve task completes, the orchestrator compares the current `git HEAD` against what it was at boot time. If HEAD changed (new commits on any branch), TurboClaw automatically restarts with exit code 75. The wrapper script `scripts/run.sh` detects exit 75 and re-execs bun, picking up the new code.

Restart can also be triggered manually:
- **WhatsApp:** send `/restart`
- **API:** `POST /restart`
- **TUI:** Ctrl+C and relaunch via `scripts/run.sh`

## Memory System — Four-Tier Zettelkasten (`src/memory/`)

TurboClaw's long-term memory is an Obsidian-compatible vault at `.turboclaw/memory/`, organized in four tiers. Pure filesystem — no Obsidian app dependency.

### Four Memory Tiers

| Tier | Dir | Injected | Lifecycle | Editable |
|------|-----|----------|-----------|----------|
| **Core** | `core/` | Always (priority 90) | Permanent, user-managed | Full CRUD via TUI |
| **Agent** | `agents/` | Always (priority 85) | Agent-managed via REST API, 4KB budget | Agents add/replace/remove via API |
| **Daily** | `tasks/` | Search-based (priority 40) | Auto-captured on task completion, pruned after N days | View/delete via TUI |
| **Weekly** | `weekly/` | Search-based (priority 40) | Auto-compiled from daily, pruned after N weeks | View/delete/regen via TUI |

### Prompt Injection Order
```
# Completion Protocol      ← self-assessment + API instructions (priority 99)
# Core Memory              ← always injected (from core/, priority 90)
# Agent Memory             ← agent-managed insights (from agents/, priority 85)
# Self-Improve Preamble    ← if self-improve task (priority 80)
# Coding Rules             ← common + language-specific (priority 70)
# Role Skill               ← agent role-specific skill (priority 60)
# Learned Instincts        ← pattern matches (priority 50)
# Relevant Memory Notes    ← search-based (from tasks/ + weekly/, priority 40)
# Reflection Nudge         ← every 5th task (priority 35)
# Recent Conversation      ← chat history, WhatsApp only (priority 30)
---
<actual task prompt>        ← (priority 100, always kept)
```

### Memory Lifecycle
- **Core notes** are created during onboarding (name, role, context, preferences + 4 base agent behavior notes) or via TUI Memory screen `[4]`. Core notes are always injected and excluded from search-based context to prevent duplication.
- **Agent notes** are created by agents via `POST /memory` from inside containers. Bounded by a 4KB budget. Agents save durable insights — environment quirks, effective patterns, project conventions. Agent notes are excluded from search to prevent duplicate injection.
- **Daily notes** are auto-generated when tasks complete, tagged with `daily-YYYY-MM-DD`. Unhelpful responses (refusals, "done", "I don't know") are filtered out and not saved.
- **Weekly summaries** are compiled by the librarian from the previous week's daily notes
- **Pruning** runs on the librarian interval: daily notes older than `dailyRetentionDays`, weekly notes older than `weeklyRetentionWeeks * 7` days
- **Reflection nudge** injected every 5th task to encourage agents to persist useful knowledge

## Configuration

Single JSON file: `.turboclaw/config.json` in the project root (or `$TURBOCLAW_HOME/config.json`).

Env var overrides follow pattern: `TURBOCLAW_GATEWAY_PORT=7800` → `config.gateway.port`.

### Config Shape

```typescript
{
  gateway: { port: 7800, host: "0.0.0.0" },
  orchestrator: { pollIntervalMs: 2000, maxConcurrency: 2, leaseDurationSec: 600, schedulingStrategy: "priority" },
  selfImprove: { enabled: false },
  provider: { type: "anthropic", apiKey?: "...", baseUrl?: "...", model?: "..." } | null,
  agent: "opencode" | "claude-code",  // optional, defaults to "opencode"
  workspaceRoot: "/path/to/project",  // optional, defaults to cwd
  whatsapp: { enabled: false, allowedNumbers: [], allowedGroups: [], notifyOnComplete: false, notifyOnFail: false },
  memory: { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 },
  skills: { autoDiscover: true, maxPerTask: 5, registries: ["clawhub", "n-skills"] },
  autoresearch: { enabled: false, timeBudgetMs: 600000, maxExperiments: 0, programPath: "docker/skills/self-improve/PROGRAM.md" },
  routing: { enabled: false, cheapModel: "ollama/qwen3-coder", maxChars: 160, maxWords: 28, complexityKeywords: [...] },
}
```

Env var overrides: `TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS`, `TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS`, `TURBOCLAW_WORKSPACE_ROOT`.

### Provider Types

**Onboarding offers two options:**

| Type | Auth method | What TurboClaw does |
|------|------------|-------------------|
| `claude-code` | API key or OAuth token | Stores in config, sets agent to `claude-code` |
| `opencode-config` | None (mounts host config) | Mounts `~/.config/opencode/` and `~/.local/share/opencode/`, sets agent to `opencode` |

The `opencode-config` option supports any provider the user has configured in their host OpenCode installation (Copilot, ChatGPT, Ollama, etc.) — no additional auth needed in TurboClaw.

## Build & Run Commands

```bash
bun install                              # Install dependencies
bun run src/index.ts                     # Launch TUI (default)
bun run src/index.ts setup              # Onboarding wizard
bun run src/index.ts --headless         # Headless mode (API + orchestrator)
./scripts/run.sh                         # Launch with auto-restart on self-improve
./scripts/run.sh --headless             # Headless with auto-restart
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
| POST | /restart | — | Gracefully restart TurboClaw (exit 75) |
| GET | /experiments/sessions | — | List autoresearch sessions |
| GET | /experiments/:sessionId | — | List experiments in a session |
| POST | /memory | `{ action, title, content?, source? }` | Agent memory: add/replace/remove |
| GET | /memory | — | List agent memories + budget |
| POST | /skills | `{ name, content, category? }` | Create agent skill (with injection scan) |
| PATCH | /skills/:name | `{ oldText, newText }` | Patch existing skill |
| DELETE | /skills/:name | — | Delete skill |
| GET | /skills | — | List local agent-created skills |
| GET | /search?q=&limit= | — | FTS5 search across past task events |
| GET | /insights?days= | — | Usage analytics (tokens, cost, model breakdown) |
| GET | /checkpoints?workspace= | — | List workspace checkpoints |
| POST | /checkpoints/restore | `{ workspace, hash }` | Restore workspace to checkpoint |
| GET | /checkpoints/diff?workspace=&hash= | — | Diff checkpoint vs current |

## Autoresearch System (`src/autoresearch/`)

Autonomous experiment runner for self-improvement. The orchestrator spawns a time-budgeted loop that iterates: read the PROGRAM.md, pick an experiment, run it in a container, measure test results, record to the ledger.

- **PROGRAM.md** — defines constraints and priorities for experiments (what to try, what's off-limits)
- **Ledger** — tracks experiment sessions and results via tracker store (`listExperimentSessions()`, `listExperiments()`)
- **Metrics** — extracts pass/fail/duration from `bun test` output
- **Config** — `autoresearch: { enabled, timeBudgetMs, maxExperiments, programPath }`
- **TUI** — Experiments screen shows session history and results
- **API** — `GET /experiments/sessions`, `GET /experiments/:sessionId`

## Instincts System (`src/memory/instincts.ts`)

Pattern learning layer on top of the memory vault. Instincts are trigger/action pairs with confidence scores that decay over time (-0.05/week), encouraging fresh evidence.

- Stored as markdown files in `.turboclaw/memory/instincts/`
- Each instinct has: `trigger`, `action`, `confidence` (0.3–0.9), `domain`, `scope`, `evidence[]` (capped at 20)
- Built into prompt context via `buildInstinctContext()` alongside core memory
- Created/updated automatically from task outcomes

## Checkpoint System (`src/container/checkpoint.ts`)

Shadow git snapshots of workspaces before each task run. Enables rollback when agents make mistakes.

- Stored at `.turboclaw/checkpoints/{sha256(workspace)[:16]}/`
- Uses `GIT_DIR` + `GIT_WORK_TREE` env vars — no `.git` in the user's workspace
- Auto-snapshot before every container spawn
- `restore()` takes a safety snapshot first, then `git checkout <hash> -- .`
- `prune()` caps at 50 checkpoints, uses `--soft` reset to avoid workspace modification
- Excludes `.git`, `node_modules`, `.env`, `__pycache__`, `venv`, `.turboclaw`, `bun.lockb`
- Max 50,000 files guard before snapshotting

## Smart Model Routing (`src/orchestrator/routing.ts`)

Routes simple tasks to cheaper models, reserves strong models for complex work. Conservative by design.

- Disabled by default — opt-in via `config.routing.enabled`
- Only applies to OpenCode agents (Claude Code uses fixed model)
- Complexity checks: text length, word count, keyword presence, code blocks, URLs, multi-line
- Keywords like "debug", "implement", "refactor", "docker" always use strong model
- Sets `OPENCODE_MODEL` env var before agent command resolution

## Session Search (`src/tracker/store.ts` + FTS5)

FTS5 full-text search across all past task event payloads. Agents can search from inside containers.

- Virtual table `events_fts` with auto-sync triggers on insert/update/delete
- `searchEvents(query)` joins through runs to tasks, groups results with snippets
- FTS index rebuilt on startup to cover pre-existing events
- Exposed via `GET /search?q=keywords`

## Usage Insights (`src/tracker/insights.ts`)

Token tracking and cost estimation per task run.

- Parses token counts from agent stdout (Input/Output/Total tokens patterns)
- Estimates cost using per-model pricing (Anthropic, OpenAI, Ollama at $0)
- Stored on runs table: `tokens_in`, `tokens_out`, `estimated_cost_usd`, `model_used`
- Aggregated via `store.getInsights(days)`: totals, by-model, by-day, by-status, avg duration
- Exposed via `GET /insights?days=7`

## Prompt Injection Detection (`src/security/injection-scanner.ts`)

Scans agent-written content (memories, skills) for injection attacks before persistence.

- 5 threat categories: prompt injection, role hijacking, exfiltration, deception, destructive ops
- Invisible Unicode detection and stripping (zero-width chars, direction marks)
- Used by `src/skills/guard.ts` to gate skill creation
- Used by memory endpoints to validate agent-written content

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

CI runs via GitHub Actions on every push/PR to main (`.github/workflows/test.yml`).

```bash
bun test                                     # all tests (758 passing across 46 files)
bun test tests/tracker.test.ts               # tracker CRUD
bun test tests/crons.test.ts                 # cron CRUD
bun test tests/alerts.test.ts                # alert CRUD
bun test tests/cron-parser.test.ts           # cron expression parsing
bun test tests/pipelines.test.ts             # pipeline stage advancement
bun test tests/memory.test.ts                # memory vault operations
bun test tests/memory-tiers.test.ts          # core/daily/weekly memory tiers
bun test tests/memory-context.test.ts        # context assembly (core, agent, search, rules, languages)
bun test tests/credentials.test.ts           # credential path resolution
bun test tests/self-improve.test.ts          # self-improve validation
bun test tests/orchestrator.test.ts          # scheduling strategies
bun test tests/orchestrator-loop.test.ts     # orchestrator loop (tick, tickCrons, leases, prompt assembly)
bun test tests/orchestrator-shutdown.test.ts # orchestrator graceful shutdown + restart
bun test tests/gateway.test.ts               # API routes (core CRUD, SSE, rate limiting)
bun test tests/gateway-routes.test.ts        # API routes (restart, memory, skills, search, insights, experiments)
bun test tests/container.test.ts             # container types
bun test tests/container-manager.test.ts     # container docker args, mounts, env vars, credential validation
bun test tests/container-utils.test.ts       # container utility functions
bun test tests/container-security.test.ts    # container path traversal + secrets
bun test tests/completion-protocol.test.ts   # completion protocol preamble validation
bun test tests/agent-commands.test.ts        # agent command resolution
bun test tests/auto-memory.test.ts           # auto-capture task output
bun test tests/chat-history.test.ts          # WhatsApp chat history
bun test tests/whatsapp-reconnect.test.ts    # WhatsApp reconnection (515/428/timeout/heartbeat)
bun test tests/skills.test.ts                # skill discovery + cache
bun test tests/skills-manager.test.ts        # skill create/patch/delete + guard
bun test tests/skills-discovery.test.ts      # keyword extraction for skill search
bun test tests/time-parser.test.ts           # time reference parsing
bun test tests/autoresearch.test.ts          # autoresearch loop + ledger
bun test tests/injection-scanner.test.ts     # prompt injection detection
bun test tests/agent-memory.test.ts          # agent-writable memory CRUD + budget
bun test tests/checkpoint.test.ts            # workspace snapshot/restore/prune
bun test tests/session-search.test.ts        # FTS5 cross-task search
bun test tests/routing.test.ts               # smart model routing
bun test tests/insights.test.ts              # token tracking + cost estimation
bun test tests/config-validation.test.ts     # config env var validation + NaN rejection
bun test tests/sse-disconnect.test.ts        # SSE stream cancel/disconnect cleanup
bun test tests/vault-stress.test.ts          # concurrent vault read/write/delete stress
bun test tests/tui-components.test.tsx        # TUI component rendering (Nav, StatusBar, navigation)
bun test tests/e2e.test.ts                   # end-to-end: API → store → orchestrator → mock container
bun test tests/notifier.test.ts              # WhatsApp notifier polling
bun test tests/registry.test.ts              # skill registry clients
bun test tests/instincts.test.ts             # instinct pattern learning
bun test tests/logger.test.ts                # logger rotation
bun test tests/scheduler.test.ts             # librarian scheduler
bun test tests/backup.test.ts                # backup create/restore
```

## Known Issues & Recent Fixes

### Fixed (2026-03-18)

| Issue | Location | Fix |
|-------|----------|-----|
| `parseInt()` without NaN validation on env vars — config silently breaks | `config.ts`, `gateway/routes.ts` | Added `Number.isNaN()` + range checks; introduced `safeParseInt()` helper in gateway |
| SSE stream poll loop continues after client disconnects (memory leak) | `gateway/routes.ts` | Added `cancel()` handler on ReadableStream + `cancelled` flag to stop polling |
| Credential path traversal — mounting arbitrary host files into containers | `container/manager.ts` | Added path traversal detection (`..`), resolved path comparison, and home-directory scoping |
| Concurrency race condition — `activeCount` could exceed `maxConcurrency` | `orchestrator/loop.ts` | Cross-check in-memory `activeCount` with DB `getActiveRuns()` count before claiming |
| FTS5 index rebuild errors swallowed silently | `tracker/store.ts` | Now logs warning via logger instead of empty catch |
| Docker worker image uses `@latest` tags (non-reproducible builds) | `docker/Dockerfile.opencode` | Pinned `opencode-ai` and `opencode-browser` to specific versions |

### Also Fixed (2026-03-18, batch 2)

| Issue | Location | Fix |
|-------|----------|-----|
| `streamLogs` 24-hour hardcoded wall-clock timeout | `container/manager.ts` | Activity-based timeout: resets on each log line, 30min inactivity limit + 24h absolute max |
| Memory vault `listNotes()` walks entire directory synchronously | `memory/vault.ts` | Added 30-second in-memory cache with TTL, auto-invalidated on write/delete |
| No graceful DB close on TUI exit | `tui/cli.tsx` | Added `SIGINT` handler that calls `db.close()` before exit |
| No log rotation in headless/Docker mode | `logger.ts` | Added 10MB rotation with 3 rotated files; checks every 100 lines to minimize stat() overhead |
| WhatsApp bridge lacks heartbeat/keep-alive | `whatsapp/bridge.ts` | 60-second presence ping; triggers reconnect on heartbeat failure |

### Observability — Comprehensive Logging

Extensive logging was added across all layers. Use `setLogLevel("debug")` to see the full trace.

**What is now logged at each layer:**

| Layer | Level | What |
|-------|-------|------|
| **Config** | info | Config file load/fallback, env var overrides applied, resolved config summary |
| **Gateway** | debug/warn/error | Every HTTP request: `METHOD /path → STATUS (Xms)` |
| **Orchestrator** | info | Task claimed (with priority, role, strategy), prompt layer breakdown with sizes, final prompt size, agent/model resolution, dispatch timing, run duration, token usage + cost |
| **Orchestrator** | debug | Tick decisions (capacity, queue depth), credential paths, truncation details |
| **Container** | info | Spawn details (image, mount count, env keys, agent type, spawn timing), streamLogs duration |
| **Container** | debug | Full command line |
| **Memory** | info | Context search results (query, matched notes with scores), core memory truncation |
| **Memory** | debug | Core/agent note counts, rules/language detection, vault cache refreshes |
| **Instincts** | debug | Match results (query, scores, confidence), total instinct count |
| **WhatsApp** | info | Heartbeat lifecycle (start, failure, reconnect trigger), bridge stop |
| **Logger** | — | 10MB log rotation with 3 backups |

**Example log trace for a task lifecycle:**
```
[INFO] Config loaded from .turboclaw/config.json
[INFO] Config resolved: provider=anthropic, agent=opencode, port=7800, concurrency=2
[INFO] Claimed task: Fix login bug (abc123) → run def456 [strategy=priority, priority=5, role=coder]
[INFO] Task abc123 prompt layers: [protocol(2100ch,p99), core(800ch,p90), rules(1200ch,p70), memory(600ch,p40), task(50ch,p100)]
[INFO] Task abc123 final prompt: 4750 chars, 5 layers (protocol → core → rules → memory → task)
[INFO] Task abc123 agent resolution: agent=opencode, model=anthropic/claude-sonnet-4-20250514, provider=anthropic
[INFO] Task abc123 dispatch prepared in 45ms (workspace=/project, skills=2)
[INFO] Spawning container: turboclaw-abc12345-def45678 (image=turboclaw-opencode, mounts=3, envVars=[ANTHROPIC_API_KEY,...], agent=opencode)
[INFO] Container started: a1b2c3d4e5f6 (spawn took 1200ms)
[INFO] Task abc123 token usage: model=anthropic/claude-sonnet-4-20250514, in=2500, out=800, cost=$0.0132
[INFO] Run def456 finished: exit 0, total duration 45s, task="Fix login bug"
```

### Known Remaining Issues

No critical issues. Rate limiting is implemented and tested (`gateway/rate-limit.ts`).

### Test Coverage Gaps (Future Work)

- Memory vault I/O errors and corrupted frontmatter handling
- TUI screen rendering tests (dashboard, tasks, settings — beyond Nav/StatusBar)
- Container manager integration tests with real Docker (spawn/kill/cleanup)
- WhatsApp bridge full integration test (Baileys mock socket)

## Deployment Target

Self-hosted on Hetzner. Single Docker Compose stack:
- TurboClaw host process (Bun)
- Docker socket mounted for container management
- Persistent volume for SQLite DB + workspaces
- Network bridge for worker containers
