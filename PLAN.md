# Plan: Port Hermes Agent Self-Learning Features to TurboClaw

## What Hermes Agent Has vs What TurboClaw Already Has

| Feature | Hermes Agent | TurboClaw Status |
|---------|-------------|------------------|
| Dual memory (MEMORY.md + USER.md) | Agent-writable + user profile | **Partial** — core memory is user-managed only; agents can't write to it |
| Memory nudges | Periodic prompts to reflect & persist knowledge | **Missing** |
| Skill creation from experience | Agent creates SKILL.md after complex tasks | **Missing** — skills are pre-baked or registry-fetched, never agent-created |
| Skill self-improvement | Agent patches SKILL.md during use | **Missing** |
| Session search (FTS5 cross-session recall) | Search past conversations, LLM-summarize matches | **Partial** — memory search exists but no session transcript search |
| Context compression | Summarize middle turns when approaching limit | **Missing** — TurboClaw truncates by priority, no summarization |
| Smart model routing | Route simple queries to cheap model | **Missing** |
| Checkpoint/rollback | Shadow git snapshots before file mutations | **Missing** |
| Subagent delegation | Spawn isolated child agents for parallel work | **Missing** — orchestrator handles task queue, but agents can't self-delegate |
| Prompt injection detection | Scan memory/skills/context for injection attacks | **Missing** |
| Insights/analytics | Usage reports (cost, tokens, tools, patterns) | **Missing** |
| Procedural skill lifecycle | create → use → patch → version | **Missing** |

## Features Worth Porting (Ranked by Value)

### 1. Agent-Writable Memory + Memory Nudges
**Why:** This is the core self-learning loop. Currently agents produce output and TurboClaw extracts instincts via regex — but the agent itself never decides what to remember. Hermes lets the agent explicitly save/replace/remove memories, and periodically nudges it to reflect.

**What to build:**
- Add `memory_add`, `memory_replace`, `memory_remove` actions to the completion protocol
- Agent writes to a new `agent/` subdirectory in the vault (separate from user's `core/`)
- Agent memory is injected alongside core memory but at lower priority
- Add memory nudge: every Nth task, append "Reflect on what you learned. Use memory_add to save durable insights." to the prompt
- Frozen snapshot pattern: memory loaded at task start, writes go to disk, next task sees updates

**Files to modify:**
- `src/memory/vault.ts` — add `agent` note type, list/read/write
- `src/memory/writer.ts` — add `createAgentMemory()`, `replaceAgentMemory()`, `removeAgentMemory()`
- `src/memory/context.ts` — `buildAgentMemoryContext()` injected at priority 85
- `src/memory/types.ts` — add `"agent"` to NoteType
- `src/container/completion.ts` — add memory tool instructions to preamble
- `src/orchestrator/loop.ts` — inject agent memory context, implement nudge counter
- `src/gateway/routes.ts` — add `POST /memory` endpoint for agent to call from inside container

**New files:**
- `src/memory/agent-memory.ts` — parse agent memory commands from task output OR REST calls

### 2. Skill Creation & Self-Improvement from Experience
**Why:** When an agent solves a novel problem, that knowledge dies with the container. Hermes agents create reusable SKILL.md files. TurboClaw already has a skills directory structure — we just need agents to write to it.

**What to build:**
- Add `skill_create` and `skill_patch` to the completion protocol
- Agent can create `~/.turboclaw/skills/{category}/{name}/SKILL.md` after complex tasks
- Agent can patch existing skills when it finds improvements
- Skills created by agents get a `source: agent` frontmatter tag
- Validate: name format, frontmatter, no prompt injection
- Agent-created skills are auto-mounted in subsequent containers

**Files to modify:**
- `src/container/completion.ts` — add skill management instructions
- `src/skills/discovery.ts` — scan local agent-created skills alongside registry
- `src/gateway/routes.ts` — add `POST /skills` and `PATCH /skills/:name` endpoints

**New files:**
- `src/skills/manager.ts` — create, patch, delete, validate skills (port from Hermes `skill_manager_tool.py`)
- `src/skills/guard.ts` — prompt injection scanning for skill content

### 3. Checkpoint & Rollback System
**Why:** Agents modify files in workspaces. When they make mistakes, there's no undo. Hermes uses shadow git repos for transparent snapshots.

**What to build:**
- Shadow git repo at `~/.turboclaw/checkpoints/{hash(workspace)}/`
- Auto-snapshot before each task run starts
- Store metadata: timestamp, task ID, file stats
- Expose rollback via API: `POST /tasks/:id/rollback`
- TUI: show checkpoint list in task detail, allow rollback
- Cap at 50 checkpoints per workspace, prune oldest

**Files to modify:**
- `src/orchestrator/loop.ts` — call checkpoint before container spawn
- `src/gateway/routes.ts` — add rollback endpoints
- `src/tui/screens/task-detail.tsx` — show checkpoints, rollback action

**New files:**
- `src/container/checkpoint.ts` — shadow git init, snapshot, restore, prune, diff

### 4. Session Search (Cross-Task Recall)
**Why:** TurboClaw stores task events in SQLite but agents can't search past task transcripts. Hermes uses FTS5 to let agents find relevant past work.

**What to build:**
- Add FTS5 virtual table on events table (stdout/stderr content)
- Search tool exposed via REST: `GET /search/sessions?q=...`
- Return matched task summaries with context snippets
- Agent can call this from inside container via `TURBOCLAW_API`
- Add to completion protocol: "Search past tasks if the user references prior work"

**Files to modify:**
- `src/tracker/schema.ts` — add FTS5 virtual table on events
- `src/tracker/store.ts` — add `searchEvents(query)` with FTS5
- `src/gateway/routes.ts` — add search endpoint
- `src/container/completion.ts` — mention session search capability

**New files:**
- None needed — fits in existing store + routes

### 5. Smart Model Routing
**Why:** Not every task needs the strongest model. Simple tasks (file renames, small fixes) can use a cheaper/faster model, saving cost and time.

**What to build:**
- Add `routing` config: `{ enabled: false, cheapModel: "ollama/qwen3-coder", strongModel: "anthropic/claude-sonnet-4", maxChars: 160, maxWords: 28 }`
- Complexity detector: check task title/description length, presence of code keywords, multi-step indicators
- Route simple tasks to cheap model, complex to strong
- Log routing decisions as events
- TUI: show which model was used per task

**Files to modify:**
- `src/config.ts` — add `routing` config section
- `src/orchestrator/loop.ts` — evaluate complexity before model resolution
- `src/tui/screens/task-detail.tsx` — display model used

**New files:**
- `src/orchestrator/routing.ts` — complexity evaluation + model selection

### 6. Prompt Injection Detection
**Why:** Agent-created memories and skills could contain injection attacks. Core memory is user-managed but agent memory won't be.

**What to build:**
- Scan all injected content (agent memory, skills, context files) for injection patterns
- Patterns: "ignore previous instructions", "you are now", "do not tell the user", suspicious shell commands
- Block and alert on detection
- Strip invisible unicode characters

**Files to modify:**
- `src/memory/context.ts` — scan before injection
- `src/skills/discovery.ts` — scan loaded skills

**New files:**
- `src/security/injection-scanner.ts` — pattern matching, unicode stripping, alert creation

### 7. Usage Insights & Analytics
**Why:** No visibility into cost, token usage, model performance across tasks. Hermes generates rich reports.

**What to build:**
- Track tokens and estimated cost per task run (from agent output parsing)
- Aggregate by model, day, task type
- TUI dashboard: add cost/token summary widgets
- API: `GET /insights?days=7`

**Files to modify:**
- `src/tracker/store.ts` — add token/cost columns to runs table, aggregation queries
- `src/tracker/schema.ts` — schema migration for token tracking
- `src/tui/screens/dashboard.tsx` — add cost/token widgets
- `src/gateway/routes.ts` — insights endpoint

**New files:**
- `src/tracker/insights.ts` — aggregation logic, cost estimation

## Implementation Order

```
Phase 1 — Self-Learning Core (highest value)
  1. Agent-writable memory + nudges
  2. Skill creation from experience
  3. Prompt injection detection (required by 1 & 2)

Phase 2 — Safety & Recall
  4. Checkpoint & rollback
  5. Session search (FTS5)

Phase 3 — Optimization & Visibility
  6. Smart model routing
  7. Usage insights & analytics
```

## Features NOT Worth Porting

| Hermes Feature | Why Skip |
|---------------|----------|
| Subagent delegation | TurboClaw's task queue already handles parallelism — agents create follow-up tasks via the completion protocol. Adding in-container delegation adds complexity without clear benefit for the Docker-per-task model. |
| Context compression (mid-conversation) | TurboClaw agents run single-shot tasks, not multi-turn conversations. Priority-based truncation is sufficient. If we ever add multi-turn, revisit. |
| Multi-platform gateway (Telegram, Discord, Slack, Signal) | TurboClaw already has WhatsApp + REST API. Adding more gateways is feature creep — users asked for learning, not more chat platforms. |
| Honcho user modeling | Single-user system. Core memory already captures user preferences. |
| Batch trajectory generation / RL training | Research infrastructure, not agent improvement. Out of scope. |

## Database Migrations Needed

```sql
-- Phase 1: Agent memory (no schema change — filesystem vault)

-- Phase 4: Session search
CREATE VIRTUAL TABLE events_fts USING fts5(data, content=events, content_rowid=id);
-- Triggers to keep FTS in sync with events table

-- Phase 7: Usage tracking
ALTER TABLE runs ADD COLUMN tokens_in INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN tokens_out INTEGER DEFAULT 0;
ALTER TABLE runs ADD COLUMN estimated_cost_usd REAL DEFAULT 0;
```

## Config Additions

```typescript
// Added to TurboClawConfig
agentMemory: {
  enabled: true,
  maxChars: 2200,       // per Hermes default
  nudgeEveryNTasks: 5,  // inject reflection nudge
};
routing: {
  enabled: false,
  cheapModel: "ollama/qwen3-coder",
  strongModel: null,     // null = use provider default
  maxChars: 160,
  maxWords: 28,
  complexityKeywords: ["debug", "implement", "refactor", "architect", "migrate"],
};
```

## Test Plan

Each phase adds tests:
- Phase 1: agent memory CRUD, nudge injection, skill create/patch/validate, injection scanner
- Phase 2: checkpoint snapshot/restore/prune, FTS5 search queries
- Phase 3: routing complexity detection, insights aggregation
