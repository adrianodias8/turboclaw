# TurboClaw

Dockerized AI agent runner with multi-provider support. Control it via TUI, REST API, or WhatsApp.

TurboClaw spawns ephemeral Docker containers to run AI coding agents (OpenCode, Claude Code, or Codex) against your tasks. It handles scheduling, retries, concurrency, cron jobs, and long-term memory — so you can queue up work and let agents grind through it.

## Quick Start

```bash
# Install dependencies
bun install

# First-time setup (checks Docker, picks AI provider)
bun run src/index.ts setup

# Launch the TUI
bun run src/index.ts
```

## What It Does

- **Queue tasks** — create coding tasks via TUI, API, or WhatsApp message
- **Multi-agent** — run tasks with OpenCode, Claude Code (`claude -p`), or Codex (`codex exec`)
- **Docker isolation** — each task runs in its own container with a mounted workspace
- **Scheduling** — FIFO, priority, or round-robin strategies with configurable concurrency
- **Retries** — automatic retry on failure with configurable limits
- **Cron jobs** — recurring tasks on standard cron schedules (`*/30 * * * *`)
- **Alerts** — automatic alerts on task failure, lease expiry, WhatsApp disconnect
- **Memory** — Obsidian Zettelkasten vault for cross-task knowledge accumulation
- **Pipelines** — multi-stage workflows with gates between stages
- **Self-improvement** — mount TurboClaw's own source into a container and let agents improve it
- **WhatsApp** — send `/task Fix the login bug` from your phone, get notified when it's done

## Architecture

```
                    +-----------+
                    |    TUI    |  ← Ink (React for CLIs)
                    +-----+-----+
                          |
  WhatsApp ──→ Store ←── Gateway (REST API, port 7800)
                 ↑
           +-----+------+
           | Orchestrator |  ← polls store, enforces policy
           +-----+------+
                 |
           +-----+------+
           |  Container  |  ← docker run per task
           |  Manager    |
           +-------------+
                 |
        Docker containers running
        OpenCode / Claude Code / Codex
```

**Three strict layers:**
- **Tracker** — source of truth (SQLite). Owns tasks, runs, events, crons, alerts.
- **Orchestrator** — policy engine. Claims tasks, enforces concurrency, ticks crons, emits alerts.
- **Agent** — executor. Ephemeral Docker container, one per task run.

## Supported Agents

| Agent | Command | Auth |
|-------|---------|------|
| OpenCode (default) | `opencode run --prompt "..."` | API key or OAuth |
| Claude Code | `claude -p "..." --allowedTools ...` | Subscription (`~/.claude/`) |
| Codex | `codex exec --full-auto "..."` | Subscription (`~/.codex/`) |

Set the agent in `~/.turboclaw/config.json`:
```json
{ "agent": "claude-code" }
```

Or toggle it in the TUI Settings screen.

## TUI Screens

| Key | Screen | What it shows |
|-----|--------|---------------|
| `1` | Dashboard | Health metrics, active runs, recent completions, upcoming crons |
| `2` | Tasks | Task list with create, filter, navigate to detail |
| `3` | Crons | Cron schedules — create, toggle, delete, run now |
| `4` | Alerts | Unacknowledged alerts — acknowledge individually or all |
| `5` | Logs | Live event stream from all recent runs |
| `6` | Settings | Concurrency, strategy, agent type, WhatsApp, self-improve |

## Headless Mode

Run without the TUI — just the API server and orchestrator:

```bash
bun run src/index.ts --headless
```

Tasks can be created via API:
```bash
curl -X POST http://localhost:7800/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "Fix the login bug", "agentRole": "coder", "priority": 5}'
```

## WhatsApp Control

Enable in config:
```json
{
  "whatsapp": {
    "enabled": true,
    "allowedNumbers": ["1234567890"],
    "notifyOnComplete": true,
    "notifyOnFail": true
  }
}
```

Scan the QR code in the TUI, then send commands from your phone:

- `/task Fix the login bug` — create and queue a task
- `/status` — system health
- `/list` — recent tasks
- `/cancel abc123` — cancel a task by ID prefix
- `/help` — command reference
- Any text without `/` — creates a task with that text as the title

## Cron Jobs

Create recurring tasks in the Crons screen (`[3]`) or programmatically:

```typescript
store.createCron({
  name: "Nightly code review",
  schedule: "0 2 * * *",        // 2am daily
  taskTemplate: {
    title: "Review recent commits",
    agentRole: "reviewer",
    priority: 3,
  },
});
```

Standard 5-field cron expressions: `minute hour day-of-month month day-of-week`.

## Configuration

Config lives at `~/.turboclaw/config.json`. Key settings:

```json
{
  "gateway": { "port": 7800 },
  "orchestrator": {
    "maxConcurrency": 2,
    "schedulingStrategy": "priority",
    "pollIntervalMs": 2000
  },
  "provider": { "type": "anthropic", "apiKey": "sk-..." },
  "agent": "opencode",
  "selfImprove": { "enabled": false },
  "whatsapp": { "enabled": false }
}
```

Environment variable overrides: `TURBOCLAW_GATEWAY_PORT=8080`, `TURBOCLAW_MAX_CONCURRENCY=4`.

## Testing

```bash
bun test                    # 108 tests across 11 files
```

## Tech Stack

- **Runtime:** Bun
- **Database:** bun:sqlite
- **TUI:** Ink + @inkjs/ui
- **Containers:** Docker
- **WhatsApp:** @whiskeysockets/baileys
- **Memory:** Obsidian-compatible Zettelkasten vault (pure filesystem)

## Project Structure

```
src/
  tracker/       — SQLite schema, store, types (source of truth)
  orchestrator/  — polling loop, cron parser, scheduling strategies
  container/     — Docker management, agent command resolution, credentials
  gateway/       — REST API (Bun.serve)
  tui/           — Ink screens, components, hooks
  memory/        — Obsidian vault, search, librarian
  whatsapp/      — Baileys bridge, message parser, notifier
docker/          — Worker Dockerfile
tests/           — bun:test suites
```
