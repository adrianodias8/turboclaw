# TurboClaw — Full Project Specification

## 1. Project Identity

**Name:** TurboClaw
**Tagline:** Dockerized AI agent runner powered by OpenCode, with nullclaw-style orchestration
**Author:** Adriano
**License:** MIT
**Runtime:** Bun (latest)
**Database:** Bun built-in SQLite (`bun:sqlite`)
**Container runtime:** Docker (required)
**Agent runtime:** OpenCode (https://opencode.ai)
**Browser automation:** opencode-browser plugin (https://github.com/different-ai/opencode-browser)

---

## 2. Design Philosophy

### From NanoClaw: what we take
- Small enough to understand — one process, few files
- Secure by isolation — agents run in Docker containers
- Built for one user — fork and customize
- AI-native — no dashboards, ask the agent

### From NanoClaw: what we DON'T take
- No "skills over features" contribution model (NanoClaw's pattern where contributors submit skill files like `/add-telegram` instead of code PRs — we accept normal code contributions)
- No Apple Container dependency
- No Claude Code / Anthropic Agents SDK dependency

### From NullClaw: strict separation of concerns
```
tracker = source of truth         (nulltickets-inspired)
orchestrator = policy engine      (nullboiler-inspired)
agent = executor                  (OpenCode in Docker)
```

### Our additions
- OpenCode as the agent runtime (not Claude Code)
- opencode-browser plugin pre-installed in containers
- **Runtime skill discovery** — agents inside Docker can search and install skills from popular marketplaces on-the-fly while executing tasks
- Custom project-level and global skills are fully supported via OpenCode's native skill system
- Bun-native everything (no Node.js, no npm at the host level)

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    TurboClaw Host                       │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Tracker     │  │ Orchestrator │  │   Gateway     │  │
│  │ (Bun SQLite)  │◄─┤ (Policy)     │  │  (HTTP API)   │  │
│  │               │  │              │  │              │  │
│  │ tasks, states │  │ scheduling   │  │ REST + WS    │  │
│  │ runs, leases  │  │ routing      │  │ webhooks     │  │
│  │ events, gates │  │ concurrency  │  │              │  │
│  └──────────────┘  │ retries      │  └──────────────┘  │
│                     └──────┬───────┘                     │
│                            │ dispatch                    │
│                     ┌──────▼───────┐                     │
│                     │  Container    │                     │
│                     │  Manager      │                     │
│                     └──────┬───────┘                     │
│                            │ docker run                  │
├────────────────────────────┼────────────────────────────┤
│  Docker containers         │                             │
│  ┌─────────────────────────▼──────────────────────────┐ │
│  │  turboclaw-worker:latest                          │ │
│  │                                                     │ │
│  │  ├── OpenCode (CLI)                                │ │
│  │  ├── opencode-browser (agent-browser backend)      │ │
│  │  ├── openskills + skills CLI (runtime discovery)   │ │
│  │  ├── Seed skills (base set from manifest)          │ │
│  │  ├── Bun runtime                                   │ │
│  │  └── /workspace (mounted from host per-task)       │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 4. Components

### 4.1 Tracker (`src/tracker/`)

Re-implementation of nulltickets concepts in Bun SQLite. This is the source of truth.

**Entities:**
- `pipelines` — define stage sequences (e.g., `plan → code → review → done`)
- `tasks` — units of work with metadata, priority, ownership
- `runs` — execution attempts of a task (a task can have multiple runs)
- `leases` — time-bounded claim on a task by a worker
- `events` — append-only log per run (stdout, progress, errors)
- `gates` — quality checks that must pass before stage transition
- `artifacts` — files/outputs attached to a run

**Schema (Bun SQLite):**

```sql
-- pipelines
CREATE TABLE pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  stages TEXT NOT NULL,  -- JSON array of stage definitions
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

-- tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, active, completed, failed
  priority INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  metadata TEXT,  -- JSON
  agent_role TEXT,  -- which role should handle this
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

-- runs
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  lease_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running, completed, failed
  started_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
  finished_at INTEGER
);

-- leases
CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  released INTEGER NOT NULL DEFAULT 0
);

-- events
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,  -- stdout, stderr, progress, metric, note
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

-- gates
CREATE TABLE gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  passed INTEGER NOT NULL,  -- 0 or 1
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

-- artifacts
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT REFERENCES runs(id),
  name TEXT NOT NULL,
  mime_type TEXT,
  path TEXT NOT NULL,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);
```

**Tracker API (internal, called by orchestrator):**

```typescript
interface Tracker {
  // Pipelines
  createPipeline(name: string, stages: StageDefinition[]): Pipeline;
  getPipeline(id: string): Pipeline | null;
  listPipelines(): Pipeline[];

  // Tasks
  createTask(opts: CreateTaskOpts): Task;
  getTask(id: string): Task | null;
  listTasks(filter?: TaskFilter): Task[];

  // Lease-based claiming
  claimTask(agentId: string, agentRole: string, leaseTtlMs?: number): ClaimResult | null;
  heartbeat(leaseId: string, token: string): boolean;

  // Run lifecycle
  appendEvent(runId: string, kind: string, data: string, token: string): void;
  addGate(runId: string, name: string, passed: boolean, detail?: string, token: string): void;
  transition(runId: string, token: string): Task;  // move to next stage
  fail(runId: string, token: string, reason?: string): Task;

  // Artifacts
  addArtifact(opts: AddArtifactOpts): Artifact;
  listArtifacts(filter?: ArtifactFilter): Artifact[];
}
```

### 4.2 Orchestrator (`src/orchestrator/`)

Policy engine. Pulls work from tracker, decides what runs when and where.

**Responsibilities:**
- Poll tracker for pending tasks
- Apply scheduling strategy (FIFO, priority, round-robin)
- Enforce concurrency limits (max N containers)
- Retry with backoff on failure
- Route tasks to appropriate agent roles
- Dispatch work to container manager

**Configuration:**

```typescript
interface OrchestratorConfig {
  pollIntervalMs: number;       // default: 2000
  maxConcurrency: number;       // default: 3
  defaultLeaseTtlMs: number;    // default: 300_000 (5 min)
  retryMaxAttempts: number;     // default: 3
  retryBackoffMs: number;       // default: 10_000
  strategies: {
    scheduling: 'fifo' | 'priority' | 'round-robin';
    routing: Record<string, string>;  // role → container image tag
  };
}
```

**Orchestrator loop (pseudocode):**

```
while running:
  sleep(pollIntervalMs)
  if activeWorkers < maxConcurrency:
    claim = tracker.claimTask(agentId, role, leaseTtlMs)
    if claim:
      container = containerManager.spawn(claim, config)
      activeWorkers.track(container)
  for each activeWorker:
    if expired or exited:
      handle result (transition or fail)
      activeWorkers.remove(worker)
```

### 4.3 Container Manager (`src/container/`)

Manages Docker lifecycle for agent workers.

**Worker container image:** `turboclaw-worker:latest`

**Container spawn flow:**
1. Create workspace directory: `~/.turboclaw/workspaces/{task_id}/`
2. Mount workspace + task context into container
3. Run OpenCode in non-interactive/headless mode with the task prompt
4. Stream stdout/stderr back as events to tracker
5. Collect artifacts from workspace on completion

**Docker run equivalent:**

```bash
docker run --rm \
  --name turboclaw-worker-{task_id} \
  -e OPENCODE_PROVIDER=... \
  -e OPENCODE_MODEL=... \
  -e ANTHROPIC_API_KEY=... \
  -e OPENAI_API_KEY=... \
  -v ~/.turboclaw/workspaces/{task_id}:/workspace \
  -v ~/.turboclaw/skills:/home/turboclaw/.turboclaw-host-skills:ro \
  --network=turboclaw-net \
  turboclaw-worker:latest \
  opencode --yes --message "{task_prompt}"
```

Note: Host skills are mounted read-only as a reference layer. The agent can install additional skills at runtime into the container's own `~/.config/opencode/skills/` (ephemeral, lost when container exits). To persist discovered skills, the agent can copy them to `/workspace/.opencode/skills/`.

### 4.4 Worker Docker Image (`docker/`)

**Dockerfile:**

```dockerfile
FROM oven/bun:latest

# System deps
RUN apt-get update && apt-get install -y \
  curl git chromium \
  && rm -rf /var/lib/apt/lists/*

# Install OpenCode
RUN curl -fsSL https://opencode.ai/install | bash

# Create turboclaw user
RUN useradd -m -s /bin/bash turboclaw
USER turboclaw
WORKDIR /home/turboclaw

# Install opencode-browser (agent-browser backend for headless)
RUN bun install -g @different-ai/opencode-browser agent-browser
RUN agent-browser install || true

# Install skill discovery CLIs (available at runtime for on-the-fly fetching)
RUN bun install -g openskills skills opencode-skillful

# Seed skills from manifest (base set baked into image)
COPY --chown=turboclaw config/skills-manifest.json /tmp/skills-manifest.json
COPY --chown=turboclaw scripts/fetch-skills.ts /tmp/fetch-skills.ts
RUN bun run /tmp/fetch-skills.ts

# OpenCode config with browser plugin + skillful plugin
COPY --chown=turboclaw config/opencode.json /home/turboclaw/.config/opencode/opencode.json

# Set browser backend to agent (headless Playwright)
ENV OPENCODE_BROWSER_BACKEND=agent
ENV HOME=/home/turboclaw

WORKDIR /workspace
ENTRYPOINT ["opencode"]
```

**opencode.json for worker:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@different-ai/opencode-browser",
    "opencode-skillful"
  ],
  "permission": {
    "skill": {
      "*": "allow"
    }
  }
}
```

### 4.5 Skills System

Skills work in two tiers: a **seed set** baked into the Docker image, and **runtime discovery** where the agent can search and install skills on-the-fly from marketplaces during task execution.

#### Tier 1: Seed Skills (Docker build time)

A base set of commonly-needed skills is pre-installed into the worker image via `scripts/fetch-skills.ts`. This ensures agents have useful skills available immediately without network latency on every task.

**Manifest file (`config/skills-manifest.json`):**

```json
{
  "openskills": [
    "anthropics/skills",
    "numman-ali/n-skills"
  ],
  "github": [
    "anthropics/skills",
    "vercel-labs/agent-skills"
  ],
  "npm": [
    "opencode-skillful"
  ],
  "custom": []
}
```

The fetcher script:
1. Reads the manifest
2. For each openskills source: runs `bunx openskills install <source> --global -y`
3. For each GitHub repo: clones sparse, copies `skills/*/SKILL.md` to `~/.config/opencode/skills/`
4. For each npm package: installs globally
5. Deduplicates by skill name (last write wins)

#### Tier 2: Runtime Skill Discovery (during task execution)

The worker container includes the CLIs needed for agents to discover and install skills at runtime:

- **`openskills`** — `bunx openskills install <repo>`, `bunx openskills search <query>`
- **`skills`** (Vercel) — `bunx skills add <repo>`
- **OpenCode native skill tool** — discovers skills already in `~/.config/opencode/skills/` and `.opencode/skills/`
- **`opencode-skillful`** plugin — lazy-load skill discovery with search across configured base paths
- **Web fetch** — OpenCode's built-in `webfetch` tool can pull SKILL.md files directly from LobeHub, GitHub, or any URL

**How it works in practice:** When an agent encounters a task that requires a capability it doesn't have (e.g., "generate a PDF report"), it can:
1. Use OpenCode's native skill tool to check if a relevant skill is already installed
2. If not found, use shell access to run `bunx openskills install <repo>` or `bunx skills add <repo>` to fetch it from a marketplace
3. Load the newly installed skill and proceed with the task

The container has network access (`turboclaw-net`) specifically so agents can reach out to GitHub, npm, and marketplace APIs for skill discovery.

**Marketplace sources the agent can discover from:**
1. **OpenSkills repos** — any GitHub repo with `skills/*/SKILL.md` structure
2. **n-skills** — curated marketplace at `numman-ali/n-skills`
3. **LobeHub Skills** — `curl https://lobehub.com/skills/<name>/skill.md`
4. **awesome-opencode** — community index of plugins and skills
5. **npm** — any npm package that exports OpenCode-compatible skills
6. **Direct GitHub URLs** — any repo with SKILL.md files

#### Custom Project Skills

You can also add custom skills specific to your project or workflow:
- **Project-level:** `.opencode/skills/*/SKILL.md` in the workspace
- **Global (host-mounted):** `~/.turboclaw/skills/` mounted read-only into containers at `~/.config/opencode/skills/`
- **Per-task:** include skill files in the task's workspace directory

### 4.6 Gateway (`src/gateway/`)

HTTP API for external interaction. Minimal REST surface.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service health |
| POST | `/tasks` | Create a task |
| GET | `/tasks` | List tasks (with filters) |
| GET | `/tasks/:id` | Get task details |
| POST | `/tasks/:id/cancel` | Cancel a task |
| GET | `/runs/:id/events` | Stream events (SSE) |
| GET | `/runs/:id/artifacts` | List artifacts |
| GET | `/artifacts/:id/download` | Download artifact |
| GET | `/status` | Orchestrator status (active workers, queue depth) |
| POST | `/pipelines` | Create pipeline |
| GET | `/pipelines` | List pipelines |

**Server:** Bun's built-in `Bun.serve()` — no Express, no Hono, just native Bun HTTP.

### 4.7 TUI (`src/tui/`)

Interactive terminal interface built with **Ink** (React for CLIs) + **@inkjs/ui** components. The TUI is the primary way to interact with TurboClaw.

**Framework choice:** Ink — React renderer for the terminal. Flexbox layout via Yoga, component-based, works with Bun. Mature ecosystem with `@inkjs/ui` (spinners, select inputs, text inputs, progress bars).

**Dependencies:**
- `ink` — core React renderer for terminal
- `@inkjs/ui` — pre-built components (TextInput, Select, Spinner, ProgressBar, etc.)
- `ink-big-text` + `ink-gradient` — header styling
- `ink-markdown` — render markdown in terminal (for task descriptions, events)

**Entry modes:**

```bash
# Interactive TUI (default)
turboclaw

# Headless mode (no TUI, just API + orchestrator)
turboclaw --headless

# Single command (create task and exit)
turboclaw task create --title "Fix login" --role coder

# Run onboarding wizard explicitly
turboclaw setup
```

**Screens:**

| Screen | Key | Description |
|--------|-----|-------------|
| Dashboard | `d` | Overview: queue depth, active workers, recent tasks, system health |
| Tasks | `t` | Task list with status indicators, create new task inline |
| Task Detail | `Enter` on task | Run events stream, artifacts, retry/cancel actions |
| Pipelines | `p` | View/create/edit pipeline stage definitions |
| Settings | `s` | Edit config: provider keys, model selection, concurrency, scheduling strategy |
| Logs | `l` | Live log viewer — streams events from all active runs |
| Onboarding | auto on first run | Step-by-step wizard: check Docker, set provider keys, build worker image, create first pipeline |

**Navigation:**
- Tab-based top navigation (Dashboard, Tasks, Pipelines, Settings, Logs)
- Bottom status bar: worker count, queue depth, uptime
- `q` or `Ctrl+C` to quit
- `/` for command palette (quick actions)
- `?` for help overlay

**Onboarding wizard flow:**

The onboarding must be dead simple — 3 choices max to get running.

**Step 1: Check Docker** (automatic, 2 seconds)
- Verify Docker daemon is running
- If not: show install instructions for the platform and exit

**Step 2: Choose your AI provider** (single select)

```
 How do you want to power your agents?

 ❯ GitHub Copilot    — use your existing Copilot subscription (Pro/Pro+/Business)
   ChatGPT Plus/Pro  — use your existing OpenAI subscription
   Claude Pro/Max    — use your existing Anthropic subscription
   Anthropic API     — pay-per-token with API key
   OpenAI API        — pay-per-token with API key
   Ollama (local)    — free, runs on your machine, no API key needed
   Other             — any OpenAI-compatible endpoint
```

**Per-provider flow:**

| Provider | What happens |
|----------|-------------|
| **GitHub Copilot** | Opens browser for GitHub OAuth device flow. User enters code at github.com/login/device. No API key needed. OpenCode handles auth via `opencode auth login`. |
| **ChatGPT Plus/Pro** | Opens browser for OpenAI OAuth (PKCE flow). No API key needed. Uses your existing subscription. |
| **Claude Pro/Max** | Opens browser for Anthropic OAuth. No API key needed. Uses your existing subscription. |
| **Anthropic API** | Prompts for `ANTHROPIC_API_KEY`. Validates with a test call. |
| **OpenAI API** | Prompts for `OPENAI_API_KEY`. Validates with a test call. |
| **Ollama (local)** | Checks if Ollama is running at `localhost:11434`. If not, shows install instructions. Lists available models. If none pulled, suggests `qwen3-coder` (best for coding agents with tool use). Warns about context window — auto-configures `num_ctx: 32768`. |
| **Other** | Prompts for base URL, optional API key. Tests connection. |

**Step 3: Build worker image** (automatic with progress bar)
- Builds `turboclaw-worker:latest` Docker image
- Shows progress: pulling base image → installing OpenCode → installing browser → fetching seed skills
- Takes 2-5 minutes on first run

**Step 4: Done!**
- Creates a default pipeline (`plan → code → review → done`)
- Offers to create a first test task ("Want to try it? I'll create a quick test task")
- Saves config to `~/.turboclaw/config.json`
- Drops into the Dashboard screen

**Key onboarding principles:**
- Never ask for information you can detect automatically
- OAuth flows over API keys whenever possible (subscriptions are easier than tokens)
- For Ollama: auto-detect running instance, auto-detect pulled models, auto-configure context window
- The entire flow should take under 2 minutes (excluding Docker image build)
- If the user quits mid-wizard, save partial config and resume where they left off

**Generated OpenCode config for workers:**

For subscription-based providers, TurboClaw generates the `opencode.json` that goes into the worker image and passes auth tokens via environment variables. For Ollama, it generates the provider config pointing to the host network:

```json
// Ollama example — generated into docker/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://host.docker.internal:11434/v1"
      },
      "models": {
        "qwen3-coder": {
          "name": "qwen3-coder",
          "tools": true
        }
      }
    }
  },
  "plugin": [
    "@different-ai/opencode-browser",
    "opencode-skillful"
  ],
  "permission": {
    "skill": { "*": "allow" }
  }
}
```

For Copilot/ChatGPT/Claude subscriptions, TurboClaw runs `opencode auth login` inside the container at startup to pass through the cached credentials.

**Settings screen:**
- Provider configuration (switch provider, re-authenticate, add additional providers)
- Orchestrator tuning (concurrency, poll interval, retry settings)
- Scheduling strategy (FIFO / priority / round-robin)
- Container settings (image tag, network, workspace dir)
- Skills manifest (edit seed skill sources)
- Self-improvement toggle (mount own source into workers)

### 4.8 Self-Improvement Mode (`self-improve`)

TurboClaw can mount its own source code into worker containers, allowing agents to improve the project itself.

**How it works:**
When self-improvement mode is enabled, the container manager mounts the TurboClaw project directory into the worker container as the workspace. The agent can then read, modify, and test TurboClaw's own code.

**Docker run with self-improvement:**

```bash
docker run --rm \
  --name turboclaw-worker-{task_id} \
  -e OPENCODE_PROVIDER=... \
  -e OPENCODE_MODEL=... \
  -e ANTHROPIC_API_KEY=... \
  -v /path/to/turboclaw:/workspace \
  -v /path/to/turboclaw:/workspace:rw \
  --network=turboclaw-net \
  turboclaw-worker:latest \
  opencode --yes --message "{task_prompt}"
```

**Configuration:**

```json
{
  "selfImprove": {
    "enabled": false,
    "projectDir": "/path/to/turboclaw",
    "branch": "auto",
    "createPR": true
  }
}
```

**Safety guardrails:**
- Disabled by default — must be explicitly enabled in config or via TUI settings
- Agent works on a git branch (auto-created: `turboclaw/improve/{task_id}`)
- Changes are never committed to `main` directly
- If `createPR` is true, the agent creates a local branch with descriptive commits; you review and merge
- The running TurboClaw process is NOT the one being modified — the agent edits the source on disk, and you restart to pick up changes
- Container still has network access for skill discovery and web search
- CLAUDE.md / AGENTS.md in the project root guides the agent on architecture and conventions

**Use cases:**
- "Add a new scheduling strategy based on task deadline"
- "Write tests for the container manager"
- "Refactor the gateway to support pagination cursors"
- "Add a new TUI screen for viewing artifacts"
- "Fix the bug where lease heartbeats don't extend properly"

**TUI integration:**
The Settings screen has a "Self-Improvement" toggle. When enabled, a new option appears in the Tasks screen: "Improve TurboClaw" which creates a task with `agentRole: "self-improve"` and the project directory mounted as workspace.

### 4.9 Memory System — Obsidian Zettelkasten (`src/memory/`)

TurboClaw uses an Obsidian vault as its long-term memory, structured as a Zettelkasten. Every piece of knowledge the agents accumulate — task learnings, codebase insights, error patterns, decision rationale — flows into interconnected atomic notes.

**Why Obsidian:**
- Vaults are just folders of markdown files — no proprietary format, no server needed
- Agents read/write via filesystem (mounted into containers) — zero API overhead
- You can browse and edit the knowledge base in Obsidian's UI alongside the agents
- Graph view gives visual overview of the agent's knowledge topology
- Fully portable — git-versionable, syncs anywhere

**Vault location:** `~/.turboclaw/memory/` (an Obsidian vault)

**Zettelkasten structure:**

```
~/.turboclaw/memory/
├── .obsidian/                   # Obsidian config (auto-created)
├── inbox/                       # Fleeting notes — raw agent observations
│   └── 20260312-143022.md       # Timestamped, unprocessed
├── notes/                       # Permanent notes — atomic, one idea each
│   ├── error-docker-build-cache-invalidation.md
│   ├── pattern-retry-with-exponential-backoff.md
│   ├── decision-bun-over-node.md
│   └── insight-ollama-context-window-4k-default.md
├── projects/                    # Project-scoped MOCs (Maps of Content)
│   ├── turboclaw.md             # Links to all TurboClaw-related notes
│   └── openclaw-acea.md         # Links to OpenClaw/ACEA notes
├── tasks/                       # Task execution logs (one per completed task)
│   ├── task-abc123.md           # What was done, what was learned, links to notes
│   └── task-def456.md
├── agents/                      # Per-agent-role knowledge
│   ├── coder.md                 # Patterns the coder agent has learned
│   ├── reviewer.md              # Review heuristics
│   └── self-improve.md          # Meta-learnings about improving TurboClaw
└── templates/                   # Note templates
    ├── fleeting.md
    ├── permanent.md
    ├── task-log.md
    └── project-moc.md
```

**Note format (permanent note example):**

```markdown
---
id: 20260312-143022
type: permanent
tags: [docker, caching, build-optimization]
created: 2026-03-12T14:30:22Z
source: task-abc123
---

# Docker build cache invalidation on COPY

When a `COPY` instruction's source files change, Docker invalidates
the cache for that layer and all subsequent layers.

**Implication:** Place frequently-changing files (like `skills-manifest.json`)
after rarely-changing layers (like `apt-get install`).

## Links
- [[pattern-multi-stage-docker-builds]]
- [[decision-bun-over-node]]
- Related task: [[task-abc123]]
```

**How agents use memory:**

1. **Before a task:** The orchestrator injects relevant memory context into the task prompt. It searches the vault for notes matching the task's tags/keywords and includes them as context.

2. **During a task:** The agent has the vault mounted read-write at `/memory` inside the container. It can:
   - Search existing notes for relevant knowledge
   - Create fleeting notes in `inbox/` for raw observations
   - Create permanent notes in `notes/` for distilled insights
   - Update project MOCs with new links
   - Read the agent-role knowledge file for accumulated patterns

3. **After a task:** The container manager runs a post-task hook that:
   - Creates a task log note in `tasks/` summarizing what happened
   - Processes `inbox/` fleeting notes (agent distills them into permanent notes on next run, or a dedicated `librarian` agent role does this periodically)

**Docker mount:**

```bash
docker run --rm \
  --name turboclaw-worker-{task_id} \
  -v ~/.turboclaw/memory:/memory:rw \
  -v ~/.turboclaw/workspaces/{task_id}:/workspace \
  ...
```

**Memory search (used by orchestrator to build context):**

```typescript
interface MemorySearch {
  // Full-text search across vault markdown files
  search(query: string, limit?: number): MemoryNote[];

  // Find notes by tags
  findByTags(tags: string[]): MemoryNote[];

  // Find notes linked from a specific note (follow the graph)
  getLinked(noteId: string, depth?: number): MemoryNote[];

  // Get the project MOC for context injection
  getProjectContext(projectName: string): string;

  // Get the agent role knowledge file
  getAgentKnowledge(role: string): string;
}
```

The search implementation reads markdown files directly from the filesystem, parses YAML frontmatter for tags/metadata, and follows `[[wikilinks]]` for graph traversal. No Obsidian app or plugin required — it's pure filesystem access.

**Optional: MCP server for richer integration**

If Obsidian is running on the host with the Local REST API plugin enabled, TurboClaw can optionally use the `@mauricio.wolff/mcp-obsidian` MCP server for enhanced features like global search, frontmatter management, and active note targeting. This is configured in the worker's OpenCode config:

```json
{
  "mcp": {
    "obsidian": {
      "type": "local",
      "command": ["npx", "@mauricio.wolff/mcp-obsidian@latest", "/path/to/vault"],
      "enabled": true
    }
  }
}
```

This is optional — the filesystem approach works without Obsidian running.

**Configuration:**

```json
{
  "memory": {
    "enabled": true,
    "vaultPath": "~/.turboclaw/memory",
    "mcpEnabled": false,
    "contextNotesLimit": 5,
    "autoProcessInbox": true,
    "librarianInterval": "daily"
  }
}
```

---

## 5. Project Structure

```
turboclaw/
├── CLAUDE.md                    # Claude Code / OpenCode instructions
├── AGENTS.md                    # Universal agent discovery
├── package.json                 # Bun project
├── bunfig.toml
├── tsconfig.json
│
├── src/
│   ├── index.ts                 # Entry point: routes to TUI or headless mode
│   ├── config.ts                # Configuration loader
│   ├── ids.ts                   # UUID / token generation
│   │
│   ├── tui/
│   │   ├── app.tsx              # Root Ink app component
│   │   ├── cli.tsx              # CLI entry: parses args, renders <App/>
│   │   ├── screens/
│   │   │   ├── dashboard.tsx    # Overview: queue depth, active workers, recent tasks
│   │   │   ├── onboarding.tsx   # First-run wizard: provider keys, Docker check, build image
│   │   │   ├── settings.tsx     # Edit config: providers, concurrency, scheduling
│   │   │   ├── tasks.tsx        # Task list with status, create new task
│   │   │   ├── task-detail.tsx  # Single task: run events stream, artifacts
│   │   │   ├── pipelines.tsx    # Pipeline list, create/edit pipeline stages
│   │   │   └── logs.tsx         # Live log viewer (SSE from runs)
│   │   ├── components/
│   │   │   ├── nav.tsx          # Tab-based navigation bar
│   │   │   ├── status-bar.tsx   # Bottom bar: worker count, queue, uptime
│   │   │   ├── task-row.tsx     # Single task row in list
│   │   │   ├── event-stream.tsx # Scrollable event log
│   │   │   └── spinner.tsx      # Loading indicator
│   │   └── hooks/
│   │       ├── use-tracker.ts   # Hook wrapping tracker store queries
│   │       ├── use-orchestrator.ts # Hook for orchestrator status
│   │       └── use-config.ts    # Hook for reading/writing config
│   │
│   ├── tracker/
│   │   ├── schema.sql           # SQLite DDL (embedded)
│   │   ├── store.ts             # All DB operations
│   │   └── types.ts             # TypeScript types for tracker
│   │
│   ├── orchestrator/
│   │   ├── loop.ts              # Main orchestration loop
│   │   ├── strategies.ts        # Scheduling strategies
│   │   └── types.ts
│   │
│   ├── container/
│   │   ├── manager.ts           # Docker container lifecycle
│   │   ├── builder.ts           # Build worker image
│   │   └── types.ts
│   │
│   ├── memory/
│   │   ├── vault.ts             # Obsidian vault filesystem operations
│   │   ├── search.ts            # Full-text search + tag search + link traversal
│   │   ├── writer.ts            # Create/update notes (fleeting, permanent, task-log)
│   │   ├── context.ts           # Build memory context for task prompts
│   │   ├── librarian.ts         # Process inbox, distill fleeting → permanent
│   │   ├── templates.ts         # Note templates (frontmatter + body)
│   │   └── types.ts
│   │
│   └── gateway/
│       ├── server.ts            # Bun.serve() HTTP server
│       ├── routes.ts            # Route handlers
│       └── types.ts
│
├── docker/
│   ├── Dockerfile.worker        # Worker container image
│   └── opencode.json            # OpenCode config for workers
│
├── config/
│   ├── default.json             # Default configuration
│   └── skills-manifest.json     # Skills to pre-fetch
│
├── scripts/
│   ├── fetch-skills.ts          # Skills auto-fetcher
│   ├── build-worker.ts          # Build Docker image
│   └── seed.ts                  # Seed example pipeline + tasks
│
└── tests/
    ├── tracker.test.ts
    ├── orchestrator.test.ts
    ├── tui.test.ts
    └── e2e.test.ts
```

---

## 6. Configuration

Single config file: `~/.turboclaw/config.json`

Override with `TURBOCLAW_HOME` env var or `--config` flag.

```json
{
  "db": "turboclaw.db",
  "gateway": {
    "port": 7800,
    "host": "0.0.0.0"
  },
  "orchestrator": {
    "pollIntervalMs": 2000,
    "maxConcurrency": 3,
    "defaultLeaseTtlMs": 300000,
    "retryMaxAttempts": 3,
    "retryBackoffMs": 10000,
    "scheduling": "priority"
  },
  "container": {
    "image": "turboclaw-worker:latest",
    "network": "turboclaw-net",
    "workspacesDir": "~/.turboclaw/workspaces"
  },
  "provider": {
    "type": "copilot",
    "auth": "oauth"
  },
  "skills": {
    "autoFetch": true,
    "manifest": "config/skills-manifest.json"
  },
  "selfImprove": {
    "enabled": false,
    "projectDir": "",
    "branch": "auto",
    "createPR": true
  },
  "memory": {
    "enabled": true,
    "vaultPath": "~/.turboclaw/memory",
    "mcpEnabled": false,
    "contextNotesLimit": 5,
    "autoProcessInbox": true,
    "librarianInterval": "daily"
  }
}
```

---

## 7. Iteration Plan

### Phase 1: Foundation (start here)
- [ ] Project scaffolding with Bun + Ink
- [ ] Tracker with SQLite schema + store.ts
- [ ] Basic gateway (create task, list tasks)
- [ ] `bun test` for tracker operations

### Phase 2: TUI — Onboarding & Dashboard
- [ ] Ink setup with `@inkjs/ui`, screen routing, navigation
- [ ] Onboarding wizard (Docker check, provider selection, build image, first pipeline)
- [ ] Dashboard screen (queue depth, active workers, recent tasks)
- [ ] Settings screen (edit config, provider management)
- [ ] Task list screen (view tasks, create inline)

### Phase 3: Containers
- [ ] Worker Dockerfile with OpenCode + opencode-browser + skill discovery CLIs
- [ ] Container manager: spawn, stream output, collect artifacts
- [ ] Seed skills fetcher script (build-time manifest)
- [ ] Verify runtime skill discovery works inside container (openskills install, skills add)
- [ ] Build script for worker image

### Phase 4: Orchestration
- [ ] Orchestrator loop with FIFO scheduling
- [ ] Lease claiming + heartbeat
- [ ] Retry with backoff
- [ ] Concurrency control

### Phase 5: Memory — Obsidian Zettelkasten
- [ ] Initialize vault structure on first run (`~/.turboclaw/memory/`)
- [ ] Note templates (fleeting, permanent, task-log, project-moc)
- [ ] Memory search (full-text, tags, wikilink graph traversal)
- [ ] Context injection (orchestrator reads vault, injects relevant notes into task prompt)
- [ ] Task post-hook (create task log note after completion)
- [ ] Mount vault into worker containers (`/memory:rw`)
- [ ] TUI Memory screen (browse vault, view graph stats, search)

### Phase 6: Pipeline Support
- [ ] Pipeline definitions (multi-stage)
- [ ] Stage transitions with gates
- [ ] Event streaming (SSE)
- [ ] Logs screen in TUI (live event stream from runs)

### Phase 7: Librarian Agent
- [ ] `librarian` agent role that processes inbox → permanent notes
- [ ] Scheduled job: run librarian daily/weekly
- [ ] Link discovery (find unlinked notes that should reference each other)
- [ ] Prune stale/orphaned notes

### Phase 8: Self-Improvement
- [ ] Self-improvement config + TUI toggle in Settings
- [ ] Mount project source into worker containers
- [ ] Auto-branch creation (`turboclaw/improve/{task_id}`)
- [ ] "Improve TurboClaw" action in Tasks screen

### Phase 9: Polish
- [ ] Priority scheduling strategy
- [ ] Command palette (`/` key) for quick actions
- [ ] Docker Compose for full stack
- [ ] Health checks + graceful shutdown
- [ ] Headless mode (`--headless` flag)
- [ ] Optional Obsidian MCP server integration

---

## 8. Key Decisions & Trade-offs

| Decision | Rationale |
|----------|-----------|
| Bun over Node | Native SQLite, faster startup, TypeScript-first, Bun.serve() |
| Bun SQLite over external DB | Zero dependencies, embedded, perfect for single-user |
| OpenCode over Claude Code | Open source, multi-provider, plugin ecosystem |
| Docker over Apple Container | Cross-platform, Hetzner-friendly, industry standard |
| REST API over WebSocket | Simpler, SSE for streaming, easier to debug |
| No "skills over features" contribution model | NanoClaw's PR-as-skills pattern is excluded; we accept normal code contributions and custom skills |
| Runtime skill discovery | Agents can search and install skills from marketplaces during execution, not just at build time |
| Two-tier skills (seed + runtime) | Seed set avoids cold-start latency; runtime discovery handles the long tail |
| Separate tracker/orchestrator/agent | nullclaw pattern — modular, replaceable components |
| Headless browser via agent-browser | No Chrome needed in container, Playwright-based |
| Ink for TUI | React-based, Flexbox layout, Bun-compatible, mature ecosystem (@inkjs/ui) |
| TUI as primary interface | Fits the AI-native philosophy — interactive, no web UI needed |
| Self-improvement via mount | Project dir mounted as workspace; agent edits source on a branch, never main |
| Obsidian vault for memory | Plain markdown files, no server needed, human-browsable, git-versionable |
| Zettelkasten over flat notes | Atomic notes + wikilinks create a knowledge graph; agents build on prior learnings |
| Filesystem over Obsidian API | Direct file access in containers; MCP server optional for richer Obsidian integration |
