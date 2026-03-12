# TurboClaw Roadmap

Future vision and things to work on. Items roughly ordered by priority within each section.

---

## Near-Term: Make It Actually Run End-to-End

These are the gaps between "code exists" and "you can actually use it":

- [ ] **Build and test the Docker worker image** — `docker build` the Dockerfile.worker, verify OpenCode/Claude Code/Codex CLIs are actually installed and callable, fix any install script failures
- [ ] **End-to-end task execution** — create a task via TUI, watch the orchestrator claim it, spawn a Docker container, stream logs back, see it complete in the dashboard
- [ ] **WhatsApp bridge real-world test** — connect a real phone, verify QR scanning works in the TUI, send `/task` and `/status`, confirm notifications come back
- [ ] **Docker Compose file** — single `docker compose up` that starts TurboClaw host + mounts Docker socket + creates network + persistent volume for DB and workspaces
- [ ] **Health check endpoint improvements** — `/health` should report orchestrator status, WhatsApp connection, worker image availability, DB health
- [ ] **API routes for crons and alerts** — expose CRUD for crons and alerts via the gateway (currently only accessible via TUI/store)
- [ ] **Error recovery** — what happens when Docker daemon restarts? When a container is killed externally? When the DB is locked? Add graceful handling.

## Agent Experience

- [ ] **Agent-specific prompt templates** — Claude Code and Codex have different strengths; tailor the prompt wrapper per agent type (e.g., Claude Code gets more detailed tool permissions, Codex gets different context framing)
- [ ] **Output parsing per agent** — Claude Code emits `stream-json`, Codex has its own output format, OpenCode has another. Normalize events from all three into the same tracker event stream.
- [ ] **Agent benchmarking mode** — run the same task with different agents, compare results (cost, time, quality). Store results as artifacts for comparison.
- [ ] **Warm containers** — keep a pool of pre-warmed containers to reduce cold-start latency. Especially useful for Ollama where model loading is slow.
- [ ] **Agent selection per task** — let individual tasks specify which agent to use, overriding the global default. Useful for "use Claude Code for this complex refactor but Codex for this quick script".

## Scheduling & Orchestration

- [ ] **Backoff strategy** — exponential backoff on retries instead of immediate requeue. Configurable per task or globally.
- [ ] **Priority decay** — tasks that have been waiting too long get a priority boost to prevent starvation
- [ ] **Concurrency per role** — separate concurrency limits for `coder` vs `reviewer` vs `self-improve` roles
- [ ] **Task dependencies** — "run task B only after task A succeeds". DAG-style execution within pipelines.
- [ ] **Task timeout** — kill container if a task exceeds a configurable wall-clock limit (separate from lease duration)
- [ ] **Deadlock detection** — if all workers are stuck on tasks that will never complete, alert and offer to cancel

## TUI Enhancements

- [ ] **Command palette** — fuzzy search for actions (create task, toggle setting, acknowledge alerts) without navigating screens. Think VS Code Ctrl+P.
- [ ] **Task creation from dashboard** — quick [n] shortcut on dashboard to create a task without switching to the Tasks screen
- [ ] **Log search/filter** — filter event stream by run ID, event kind, or text content
- [ ] **Cron preview** — when creating a cron, show "next 5 run times" before confirming
- [ ] **Dashboard sparklines** — tiny graphs showing task throughput over time
- [ ] **Resize handling** — gracefully reflow layout when terminal is resized
- [ ] **Theme support** — light/dark theme toggle, or auto-detect from terminal

## WhatsApp Bridge

- [ ] **Rich messages** — use WhatsApp formatting (bold, lists) for status and task list responses
- [ ] **Task detail command** — `/detail <id>` to get full task info including latest run events
- [ ] **Inline task creation with options** — `/task -p 10 -r reviewer Fix the auth bug` to set priority and role from WhatsApp
- [ ] **Conversation context** — if someone sends multiple messages, treat them as a single task description (with a timeout)
- [ ] **Group chat support** — allow TurboClaw to operate in a WhatsApp group (with mention-based activation)
- [ ] **QR code re-scan notification** — if WhatsApp session expires, proactively alert the user to re-scan

## Memory System

- [ ] **Post-task hooks** — after a task completes, automatically create a task-log note in the vault summarizing what the agent did and learned
- [ ] **Memory relevance scoring** — better algorithm for selecting which notes to inject as context (currently just keyword/tag match)
- [ ] **Memory size limits** — prune old fleeting notes, cap vault size, summarize long notes
- [ ] **Cross-project memory** — share learnings across different project workspaces
- [ ] **Memory search in TUI** — dedicated screen or command palette integration to browse the Zettelkasten vault
- [ ] **Librarian auto-scheduling** — run the librarian as a cron job rather than a fixed-interval timer

## Infrastructure & Operations

- [ ] **Metrics export** — Prometheus endpoint for task throughput, failure rates, container spawn times, queue depth over time
- [ ] **Log aggregation** — structured JSON logs that can be piped to a log system
- [ ] **Backup/restore** — export/import the SQLite DB and memory vault
- [ ] **Multi-workspace** — manage multiple project workspaces from a single TurboClaw instance
- [ ] **Remote API auth** — token-based auth for the REST API (currently no auth, single-user assumption)
- [ ] **Container resource monitoring** — track CPU/memory usage per container, surface in dashboard
- [ ] **Automatic image rebuilds** — detect when Dockerfile.worker changes and trigger a rebuild

## Stretch / Exploration

- [ ] **Web dashboard** — optional web UI alongside the TUI for when you want a browser view (read-only mirror of TUI state)
- [ ] **Telegram bridge** — same concept as WhatsApp but for Telegram (simpler API, no QR needed)
- [ ] **Slack bridge** — post task updates to a Slack channel, create tasks from Slack commands
- [ ] **GitHub integration** — auto-create tasks from GitHub issues, post results as PR comments
- [ ] **Cost tracking** — estimate and track API costs per task (tokens used, model pricing)
- [ ] **Agent marketplace** — browse and install agent skill packs from within the TUI
- [ ] **Multi-node** — distribute containers across multiple Docker hosts (swarm or k8s)
- [ ] **Voice control** — Whisper-based voice input for task creation (pipe phone audio → transcription → task)

---

## Completed

- [x] Tracker (schema + store + tests) + gateway
- [x] TUI (onboarding, dashboard, tasks, task-detail, pipelines, settings, logs)
- [x] Docker worker image (OpenCode + browser + skill CLIs)
- [x] Container manager (spawn, kill, logs, cleanup)
- [x] Orchestrator loop (scheduling strategies, concurrency, retry)
- [x] Memory system (Obsidian vault, search, context injection, librarian)
- [x] Pipelines (multi-stage + gates + transitions)
- [x] Self-improvement mode
- [x] Multi-provider agents (OpenCode, Claude Code, Codex)
- [x] Cron engine (parser, scheduler, TUI screen)
- [x] Alert system (auto-emit, TUI screen, acknowledge)
- [x] WhatsApp bridge (Baileys, commands, notifications, QR in TUI)
- [x] TUI overhaul (6-screen nav, two-column dashboard, health hooks, status bar with alerts/provider/WA)
