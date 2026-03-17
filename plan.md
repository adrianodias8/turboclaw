# Plan: Autoresearch-Style Autonomous Self-Improvement Loop for TurboClaw

## Concept

Adapt Karpathy's autoresearch pattern to TurboClaw: instead of optimizing `val_bpb` on a training run, the agent autonomously improves TurboClaw itself in a loop, using **test pass rate** and **test count** as the primary metrics (analogous to validation loss).

### Autoresearch Mapping

| Autoresearch | TurboClaw Equivalent |
|---|---|
| `train.py` (single modifiable file) | TurboClaw `src/` (entire source tree, mounted at `/project`) |
| `prepare.py` (fixed evaluation) | `bun test` (fixed test suite = evaluation harness) |
| `program.md` (agent instructions) | `docker/skills/self-improve/PROGRAM.md` (research program) |
| `val_bpb` (metric, lower=better) | Test failures (lower=better) + test count (higher=better) |
| `results.tsv` (experiment log) | `experiments` SQLite table (experiment log) |
| 5-minute training budget | Configurable time budget per experiment (default: 10 min) |
| Keep/discard based on metric | Keep if tests pass && metric doesn't regress; discard (git reset) otherwise |

---

## Architecture

### New Files

```
src/
  autoresearch/
    loop.ts          — the autonomous experiment loop (core)
    program.ts       — loads and parses PROGRAM.md
    metrics.ts       — runs `bun test`, extracts pass/fail/count
    ledger.ts        — experiment result recording (SQLite)
    types.ts         — Experiment, ExperimentResult, ProgramConfig

docker/
  skills/self-improve/
    PROGRAM.md       — the research program (human-authored, agent reads)
```

### Modified Files

```
src/tracker/schema.ts    — add `experiments` table
src/tracker/store.ts     — add experiment CRUD
src/tracker/types.ts     — add Experiment type
src/orchestrator/loop.ts — integrate autoresearch loop trigger
src/config.ts            — add autoresearch config section
src/tui/screens/         — add experiments screen or dashboard section
src/gateway/routes.ts    — add /experiments API endpoints
```

---

## Step-by-Step Implementation

### Step 1: Schema — `experiments` table

Add to `src/tracker/schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,          -- groups experiments in one autoresearch run
  commit_hash TEXT NOT NULL,         -- 7-char git commit
  parent_hash TEXT,                  -- commit before this experiment
  tests_passed INTEGER NOT NULL,
  tests_failed INTEGER NOT NULL,
  tests_total INTEGER NOT NULL,
  test_duration_ms INTEGER,          -- how long `bun test` took
  experiment_duration_ms INTEGER,    -- total wall clock for this experiment
  status TEXT NOT NULL,              -- 'keep' | 'discard' | 'crash' | 'regression'
  description TEXT NOT NULL,         -- agent's 1-line summary of the change
  diff_stat TEXT,                    -- output of git diff --stat (lines changed)
  task_id TEXT,                      -- link to the self-improve task
  created_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiments_session ON experiments(session_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status);
```

### Step 2: Metrics extraction — `src/autoresearch/metrics.ts`

```typescript
export interface TestMetrics {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  raw: string;        // full test output
}

export async function runTests(projectDir: string): Promise<TestMetrics>
```

- Runs `bun test` in `projectDir` with a timeout
- Parses the summary line: `N pass M fail` from bun test output
- Returns structured metrics
- On timeout or crash, returns `{ passed: 0, failed: -1, total: 0 }` as sentinel

### Step 3: Experiment ledger — `src/autoresearch/ledger.ts`

```typescript
export interface ExperimentRecord {
  sessionId: string;
  commitHash: string;
  parentHash: string | null;
  metrics: TestMetrics;
  experimentDurationMs: number;
  status: "keep" | "discard" | "crash" | "regression";
  description: string;
  diffStat: string | null;
  taskId: string | null;
}

export function recordExperiment(store: Store, record: ExperimentRecord): void
export function getSessionHistory(store: Store, sessionId: string): ExperimentRecord[]
export function getBestExperiment(store: Store, sessionId: string): ExperimentRecord | null
```

### Step 4: PROGRAM.md — `docker/skills/self-improve/PROGRAM.md`

This is the human-authored research program the agent reads. Analogous to autoresearch's `program.md`. Example:

```markdown
# TurboClaw Self-Improvement Program

## Your Role
You are an autonomous research agent improving TurboClaw.
You will run in a loop. Each iteration you:
1. Study the codebase and identify ONE concrete improvement
2. Implement it (modify code under /project/src/)
3. The harness will run tests and keep/discard your change automatically

## Metrics (lower failures = better, higher test count = better)
- Primary: test failures (must stay at 0 to keep a change)
- Secondary: test count (adding tests that pass is valued)
- Tertiary: code quality (removing dead code, fixing bugs, reducing complexity)

## What to Improve (in priority order)
1. Fix any failing tests
2. Add missing test coverage for untested code paths
3. Fix bugs you discover while reading the code
4. Performance improvements (reduce unnecessary work)
5. Code quality (reduce duplication, simplify complex logic)

## Constraints
- Do NOT modify: .env, config.json, turboclaw.db, prepare/evaluation files
- Do NOT install new dependencies
- Do NOT change the test framework or test runner
- Keep changes small and focused — ONE thing per experiment
- NEVER skip or delete existing tests to make metrics look better

## How to Describe Your Change
After making changes, output a single line starting with `EXPERIMENT:` describing what you did:
```
EXPERIMENT: Add test for edge case in cron parser when step > range
```

## NEVER STOP
Continue experimenting indefinitely. Do not ask for permission.
The human may be asleep. Keep going until manually stopped.
```

### Step 5: The experiment loop — `src/autoresearch/loop.ts`

This is the core. It does NOT use Docker containers — it runs directly on the host (like autoresearch runs locally). The loop:

```
startAutoresearchLoop(config, store):
  sessionId = newId()
  branch = `autoresearch/${sessionId.slice(0,8)}`
  git checkout -b {branch}

  // Capture baseline metrics
  baseline = runTests(projectDir)
  record baseline as first experiment

  while (!stopped):
    // 1. Snapshot current state
    parentHash = git rev-parse HEAD

    // 2. Create a self-improve task with PROGRAM.md context
    task = store.createTask({
      title: `Autoresearch experiment #${n}`,
      description: program + codebase context,
      agentRole: "self-improve",
      priority: 10,
    })
    store.updateTaskStatus(task.id, "queued")

    // 3. Wait for task completion (poll with timeout)
    result = await waitForTaskCompletion(store, task.id, timeBudgetMs)

    if (result === "timeout" || result === "failed"):
      // Crash — revert and log
      git reset --hard {parentHash}
      recordExperiment(store, { status: "crash", ... })
      continue

    // 4. Run tests (the evaluation harness)
    metrics = await runTests(projectDir)
    currentHash = git rev-parse HEAD

    // 5. Decision: keep or discard
    if (metrics.failed > baseline.failed):
      // Regression — revert
      git reset --hard {parentHash}
      recordExperiment(store, { status: "regression", ... })
    else if (metrics.failed === 0 && currentHash !== parentHash):
      // Improvement or neutral — keep
      baseline = metrics
      recordExperiment(store, { status: "keep", ... })
    else:
      // No changes made — discard
      recordExperiment(store, { status: "discard", ... })

    // 6. Log progress
    logger.info(`Experiment #${n}: ${status} (${metrics.passed}/${metrics.total} pass)`)
    n++
```

Key design decisions:
- **Each experiment = one self-improve task** dispatched through the existing orchestrator
- **Tests run on the host** after the container finishes (not inside the container) — this is the "fixed evaluation harness" that the agent can't tamper with
- **Git reset on failure** — automatic revert, just like autoresearch discards bad commits
- **No restart between experiments** — unlike normal self-improve which restarts TurboClaw, the autoresearch loop runs continuously. Restart only happens when the user stops the loop.

### Step 6: Config — add to `src/config.ts`

```typescript
autoresearch: {
  enabled: false,
  timeBudgetMs: 600000,        // 10 min per experiment (analogous to 5-min train budget)
  maxExperiments: 0,           // 0 = unlimited (run until stopped)
  programPath: "docker/skills/self-improve/PROGRAM.md",
}
```

### Step 7: Integration points

**Orchestrator** (`src/orchestrator/loop.ts`):
- When `config.autoresearch.enabled`, start the autoresearch loop alongside the normal orchestrator
- The autoresearch loop creates self-improve tasks that flow through the normal orchestrator pipeline
- Disable auto-restart for autoresearch experiments (the loop handles revert/keep itself)

**Gateway** (`src/gateway/routes.ts`):
- `GET /experiments?session=` — list experiments for a session
- `GET /experiments/sessions` — list all sessions with summary stats
- `POST /autoresearch/start` — start a new autoresearch session
- `POST /autoresearch/stop` — stop the current session

**TUI** (`src/tui/screens/`):
- Add experiment results to dashboard or new screen
- Show: session progress, keep/discard ratio, current test metrics, experiment history

### Step 8: Tests

```
tests/autoresearch.test.ts:
  - metrics.ts: parse bun test output correctly
  - ledger.ts: record and query experiments
  - loop.ts: keep/discard logic (mock git + tests)
```

---

## Execution Order

1. Schema + types + store CRUD for experiments table
2. `metrics.ts` — test runner and output parser
3. `ledger.ts` — experiment recording
4. `program.ts` — PROGRAM.md loader
5. `loop.ts` — the core experiment loop
6. Config additions
7. Orchestrator integration (disable auto-restart for autoresearch tasks)
8. `PROGRAM.md` — write the initial research program
9. API endpoints
10. TUI integration
11. Tests for all new code

---

## Key Differences from Autoresearch

| Aspect | Autoresearch | TurboClaw Autoresearch |
|---|---|---|
| What's modified | Single file (`train.py`) | Entire `src/` tree |
| Evaluation | `uv run train.py` (5 min) | `bun test` (seconds) |
| Metric | `val_bpb` (continuous) | Test pass/fail (binary) + count |
| Agent runtime | Claude Code directly on host | Agent in Docker container via orchestrator |
| Git workflow | Single branch, linear | Feature branch per session |
| Revert mechanism | `git reset` on metric regression | `git reset` on test failure |
| Loop driver | Claude Code's agentic loop | TurboClaw orchestrator dispatching tasks |
| Results format | `results.tsv` flat file | SQLite `experiments` table |
| Human interface | Terminal output + TSV | TUI + API + WhatsApp notifications |
