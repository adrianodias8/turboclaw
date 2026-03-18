import { Database } from "bun:sqlite";
import { SCHEMA, MIGRATIONS } from "./schema";
import { newId } from "../ids";
import { logger } from "../logger";
import type {
  Task,
  Run,
  Event,
  Pipeline,
  Artifact,
  Lease,
  Gate,
  Cron,
  Alert,
  ChatMessage,
  CreateTaskInput,
  CreatePipelineInput,
  CreateCronInput,
  TaskStatus,
  RunStatus,
  EventKind,
  AlertKind,
  ExperimentStatus,
  Experiment,
  EventSearchResult,
  InsightsResult,
} from "./types";

export interface Store {
  // Pipelines
  createPipeline(input: CreatePipelineInput): Pipeline;
  getPipeline(id: string): Pipeline | null;
  listPipelines(): Pipeline[];

  // Tasks
  createTask(input: CreateTaskInput): Task;
  getTask(id: string): Task | null;
  listTasks(opts?: {
    status?: TaskStatus;
    stage?: string;
    limit?: number;
    cursor?: string;
  }): Task[];
  updateTaskStatus(id: string, status: TaskStatus): Task | null;
  incrementRetryCount(id: string): void;
  claimNextTask(worker: string, leaseDurationSec: number): { task: Task; run: Run; lease: Lease } | null;
  claimTask(taskId: string, worker: string, leaseDurationSec: number): { task: Task; run: Run; lease: Lease } | null;
  listQueuedTasks(): Task[];
  cancelTask(id: string): Task | null;

  // Runs
  createRun(taskId: string): Run;
  getRun(id: string): Run | null;
  getLatestRun(taskId: string): Run | null;
  finishRun(id: string, status: RunStatus, exitCode: number | null): Run | null;

  // Events
  addEvent(runId: string, kind: EventKind, payload: string): Event;
  listEvents(runId: string, afterId?: number): Event[];

  // Leases
  releaseLease(leaseId: string): void;
  getActiveLease(taskId: string): Lease | null;
  extendLease(leaseId: string, additionalSec: number): void;

  // Gates
  createGate(pipelineId: string, fromStage: string, toStage: string): Gate;
  approveGate(gateId: number): Gate | null;
  listGates(pipelineId: string): Gate[];
  getGate(pipelineId: string, fromStage: string, toStage: string): Gate | null;

  // Tasks — stage management
  setTaskStage(taskId: string, stage: string): Task | null;

  // Artifacts
  createArtifact(input: {
    taskId: string;
    runId: string;
    name: string;
    path: string;
    mimeType?: string | null;
    sizeBytes: number;
  }): Artifact;
  listArtifacts(opts?: { taskId?: string; runId?: string }): Artifact[];

  // Status
  getQueueDepth(): number;
  getActiveWorkerCount(): number;

  // Monitoring
  getFailedTasks(limit?: number): Task[];
  getRecentlyDoneTasks(sinceTs: number, limit?: number): Task[];
  getRecentlyFailedTasks(sinceTs: number, limit?: number): Task[];
  getExpiredLeases(): Lease[];
  getActiveRuns(): Run[];
  getHealthStatus(): { queueDepth: number; activeWorkers: number; failedCount: number; runningCount: number };

  // Crons
  createCron(input: CreateCronInput): Cron;
  getCron(id: string): Cron | null;
  listCrons(): Cron[];
  getDueCrons(): Cron[];
  updateCronLastRun(id: string, lastRunAt: number, nextRunAt: number): void;
  updateCronEnabled(id: string, enabled: boolean): void;
  toggleCron(id: string): Cron | null;
  deleteCron(id: string): void;

  // Alerts
  createAlert(kind: AlertKind, message: string, taskId?: string | null): Alert;
  listAlerts(opts?: { acknowledged?: boolean; limit?: number }): Alert[];
  acknowledgeAlert(id: number): void;
  acknowledgeAllAlerts(): void;
  acknowledgeAlertsByKind(kind: AlertKind): void;
  getUnacknowledgedAlertCount(): number;

  // Chat messages
  addChatMessage(jid: string, role: "user" | "assistant", content: string, taskId?: string | null): ChatMessage;
  getRecentChatMessages(jid: string, limit?: number): ChatMessage[];
  getChatMessageForTask(taskId: string): ChatMessage | null;

  // Experiments (autoresearch)
  recordExperiment(input: {
    sessionId: string;
    commitHash: string;
    parentHash: string | null;
    testsPassed: number;
    testsFailed: number;
    testsTotal: number;
    testDurationMs: number | null;
    experimentDurationMs: number | null;
    status: ExperimentStatus;
    description: string;
    diffStat: string | null;
    taskId: string | null;
  }): Experiment;
  listExperiments(sessionId: string): Experiment[];
  listExperimentSessions(): Array<{ session_id: string; count: number; keeps: number; started_at: number; latest_at: number }>;

  // Session search (FTS5)
  searchEvents(query: string, limit?: number): EventSearchResult[];
  rebuildFtsIndex(): void;

  // Usage insights
  updateRunMetrics(runId: string, metrics: { tokensIn?: number; tokensOut?: number; estimatedCostUsd?: number; modelUsed?: string }): void;
  getInsights(days?: number): InsightsResult;
}

export function createStore(db: Database): Store {
  db.exec(SCHEMA);

  // Apply migrations (safe to re-run — ignores "duplicate column" errors)
  for (const migration of MIGRATIONS) {
    try {
      db.exec(migration);
    } catch {
      // Column already exists — expected on subsequent runs
    }
  }

  // Rebuild FTS index to ensure existing events are indexed
  try {
    db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
  } catch (err) {
    // FTS table may not exist yet on very old DBs — log for diagnostics
    logger.warn("FTS5 index rebuild failed (search may return stale results):", err);
  }

  // Prepared statements
  const stmts = {
    insertPipeline: db.prepare<Pipeline, [string, string, string]>(
      "INSERT INTO pipelines (id, name, stages) VALUES (?, ?, ?) RETURNING *"
    ),
    getPipeline: db.prepare<Pipeline, [string]>(
      "SELECT * FROM pipelines WHERE id = ?"
    ),
    listPipelines: db.prepare<Pipeline, []>(
      "SELECT * FROM pipelines ORDER BY created_at DESC"
    ),

    insertTask: db.prepare<Task, [string, string | null, string | null, string, string | null, string, number, number, string | null, string | null, string | null]>(
      `INSERT INTO tasks (id, pipeline_id, stage, title, description, agent_role, priority, max_retries, reply_jid, agent_override, model_override)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ),
    getTask: db.prepare<Task, [string]>(
      "SELECT * FROM tasks WHERE id = ?"
    ),
    updateTaskStatus: db.prepare<Task, [string, string]>(
      `UPDATE tasks SET status = ?, updated_at = unixepoch('now') WHERE id = ? RETURNING *`
    ),
    incrementRetry: db.prepare<unknown, [string]>(
      `UPDATE tasks SET retry_count = retry_count + 1, updated_at = unixepoch('now') WHERE id = ?`
    ),
    claimNextTask: db.prepare<Task, []>(
      `UPDATE tasks SET status = 'running', updated_at = unixepoch('now')
       WHERE id = (
         SELECT id FROM tasks WHERE status = 'queued'
         ORDER BY priority DESC, created_at ASC LIMIT 1
       ) RETURNING *`
    ),
    claimTaskById: db.prepare<Task, [string]>(
      `UPDATE tasks SET status = 'running', updated_at = unixepoch('now') WHERE id = ? AND status = 'queued' RETURNING *`
    ),
    listQueuedTasks: db.prepare<Task, []>(
      "SELECT * FROM tasks WHERE status = 'queued'"
    ),

    insertRun: db.prepare<Run, [string, string]>(
      "INSERT INTO runs (id, task_id) VALUES (?, ?) RETURNING *"
    ),
    getRun: db.prepare<Run, [string]>(
      "SELECT * FROM runs WHERE id = ?"
    ),
    getLatestRun: db.prepare<Run, [string]>(
      "SELECT * FROM runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 1"
    ),
    finishRun: db.prepare<Run, [string, number | null, string]>(
      `UPDATE runs SET status = ?, exit_code = ?, finished_at = unixepoch('now') WHERE id = ? RETURNING *`
    ),

    insertEvent: db.prepare<Event, [string, string, string]>(
      "INSERT INTO events (run_id, kind, payload) VALUES (?, ?, ?) RETURNING *"
    ),
    listEvents: db.prepare<Event, [string]>(
      "SELECT * FROM events WHERE run_id = ? ORDER BY id ASC"
    ),
    listEventsAfter: db.prepare<Event, [string, number]>(
      "SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id ASC"
    ),

    insertLease: db.prepare<Lease, [string, string, string, string, number]>(
      "INSERT INTO leases (id, task_id, run_id, worker, expires_at) VALUES (?, ?, ?, ?, ?) RETURNING *"
    ),
    releaseLease: db.prepare<unknown, [string]>(
      "UPDATE leases SET released = 1 WHERE id = ?"
    ),
    getActiveLease: db.prepare<Lease, [string]>(
      "SELECT * FROM leases WHERE task_id = ? AND released = 0 ORDER BY expires_at DESC LIMIT 1"
    ),
    extendLease: db.prepare<unknown, [number, string]>(
      "UPDATE leases SET expires_at = expires_at + ? WHERE id = ? AND released = 0"
    ),

    insertGate: db.prepare<Gate, [string, string, string]>(
      "INSERT INTO gates (pipeline_id, from_stage, to_stage) VALUES (?, ?, ?) RETURNING *"
    ),
    approveGate: db.prepare<Gate, [number]>(
      `UPDATE gates SET approved = 1, approved_at = unixepoch('now') WHERE id = ? RETURNING *`
    ),
    listGates: db.prepare<Gate, [string]>(
      "SELECT * FROM gates WHERE pipeline_id = ? ORDER BY id ASC"
    ),
    getGate: db.prepare<Gate, [string, string, string]>(
      "SELECT * FROM gates WHERE pipeline_id = ? AND from_stage = ? AND to_stage = ? LIMIT 1"
    ),
    setTaskStage: db.prepare<Task, [string, string]>(
      `UPDATE tasks SET stage = ?, updated_at = unixepoch('now') WHERE id = ? RETURNING *`
    ),

    insertArtifact: db.prepare<Artifact, [string, string, string, string, string, string | null, number]>(
      `INSERT INTO artifacts (id, task_id, run_id, name, path, mime_type, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ),

    queueDepth: db.prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'queued')"
    ),
    activeWorkers: db.prepare<{ count: number }, []>(
      "SELECT COUNT(DISTINCT worker) as count FROM leases WHERE released = 0 AND expires_at > unixepoch('now')"
    ),

    // Monitoring
    failedTasks: db.prepare<Task, [number]>(
      "SELECT * FROM tasks WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?"
    ),
    recentlyDoneTasks: db.prepare<Task, [number, number]>(
      "SELECT * FROM tasks WHERE status = 'done' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?"
    ),
    recentlyFailedTasks: db.prepare<Task, [number, number]>(
      "SELECT * FROM tasks WHERE status = 'failed' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ?"
    ),
    expiredLeases: db.prepare<Lease, []>(
      "SELECT * FROM leases WHERE released = 0 AND expires_at < unixepoch('now')"
    ),
    activeRuns: db.prepare<Run, []>(
      "SELECT * FROM runs WHERE status = 'running' ORDER BY started_at ASC"
    ),
    failedCount: db.prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'failed'"
    ),
    runningCount: db.prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'running'"
    ),

    // Crons
    insertCron: db.prepare<Cron, [string, string, string, string, number, number | null]>(
      "INSERT INTO crons (id, name, schedule, task_template, one_shot, next_run_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *"
    ),
    getCron: db.prepare<Cron, [string]>(
      "SELECT * FROM crons WHERE id = ?"
    ),
    listCrons: db.prepare<Cron, []>(
      "SELECT * FROM crons ORDER BY created_at DESC"
    ),
    dueCrons: db.prepare<Cron, []>(
      "SELECT * FROM crons WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= unixepoch('now'))"
    ),
    updateCronLastRun: db.prepare<unknown, [number, number, string]>(
      "UPDATE crons SET last_run_at = ?, next_run_at = ? WHERE id = ?"
    ),
    updateCronEnabled: db.prepare<unknown, [number, string]>(
      "UPDATE crons SET enabled = ? WHERE id = ?"
    ),
    deleteCron: db.prepare<unknown, [string]>(
      "DELETE FROM crons WHERE id = ?"
    ),

    // Alerts
    insertAlert: db.prepare<Alert, [string, string, string | null]>(
      "INSERT INTO alerts (kind, message, task_id) VALUES (?, ?, ?) RETURNING *"
    ),
    listAlertsAll: db.prepare<Alert, [number]>(
      "SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?"
    ),
    listAlertsUnack: db.prepare<Alert, [number]>(
      "SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT ?"
    ),
    acknowledgeAlert: db.prepare<unknown, [number]>(
      "UPDATE alerts SET acknowledged = 1 WHERE id = ?"
    ),
    acknowledgeAllAlerts: db.prepare<unknown, []>(
      "UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0"
    ),
    acknowledgeAlertsByKind: db.prepare<unknown, [string]>(
      "UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0 AND kind = ?"
    ),
    unackAlertCount: db.prepare<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM alerts WHERE acknowledged = 0"
    ),

    // Chat messages
    insertChatMessage: db.prepare<ChatMessage, [string, string, string, string | null]>(
      "INSERT INTO chat_messages (jid, role, content, task_id) VALUES (?, ?, ?, ?) RETURNING *"
    ),
    recentChatMessages: db.prepare<ChatMessage, [string, number]>(
      `SELECT * FROM (
        SELECT * FROM chat_messages WHERE jid = ? ORDER BY id DESC LIMIT ?
      ) sub ORDER BY id ASC`
    ),
    chatMessageForTask: db.prepare<ChatMessage, [string]>(
      "SELECT * FROM chat_messages WHERE task_id = ? AND role = 'user' LIMIT 1"
    ),

    // Experiments
    insertExperiment: db.prepare<Experiment, [string, string, string | null, number, number, number, number | null, number | null, string, string, string | null, string | null]>(
      `INSERT INTO experiments (session_id, commit_hash, parent_hash, tests_passed, tests_failed, tests_total, test_duration_ms, experiment_duration_ms, status, description, diff_stat, task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ),
    listExperiments: db.prepare<Experiment, [string]>(
      "SELECT * FROM experiments WHERE session_id = ? ORDER BY id ASC"
    ),
    listExperimentSessions: db.prepare<{ session_id: string; count: number; keeps: number; started_at: number; latest_at: number }, []>(
      `SELECT session_id, COUNT(*) as count, SUM(CASE WHEN status = 'keep' THEN 1 ELSE 0 END) as keeps, MIN(created_at) as started_at, MAX(created_at) as latest_at FROM experiments GROUP BY session_id ORDER BY latest_at DESC`
    ),

    // Usage insights
    insightsTotals: db.prepare<
      { total_runs: number; total_tokens_in: number; total_tokens_out: number; total_cost_usd: number; avg_duration_sec: number },
      [number]
    >(
      `SELECT
        COUNT(*) as total_runs,
        COALESCE(SUM(tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(tokens_out), 0) as total_tokens_out,
        COALESCE(SUM(estimated_cost_usd), 0.0) as total_cost_usd,
        COALESCE(AVG(CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL THEN finished_at - started_at END), 0) as avg_duration_sec
      FROM runs WHERE started_at >= ?`
    ),
    insightsTotalTasks: db.prepare<{ total_tasks: number }, [number]>(
      `SELECT COUNT(DISTINCT task_id) as total_tasks FROM runs WHERE started_at >= ?`
    ),
    insightsByModel: db.prepare<
      { model: string; runs: number; tokens_in: number; tokens_out: number; cost_usd: number },
      [number]
    >(
      `SELECT
        COALESCE(model_used, 'unknown') as model,
        COUNT(*) as runs,
        COALESCE(SUM(tokens_in), 0) as tokens_in,
        COALESCE(SUM(tokens_out), 0) as tokens_out,
        COALESCE(SUM(estimated_cost_usd), 0.0) as cost_usd
      FROM runs WHERE started_at >= ?
      GROUP BY model_used
      ORDER BY runs DESC`
    ),
    insightsByDay: db.prepare<
      { date: string; tasks: number; runs: number; tokens_in: number; tokens_out: number; cost_usd: number },
      [number]
    >(
      `SELECT
        date(started_at, 'unixepoch') as date,
        COUNT(DISTINCT task_id) as tasks,
        COUNT(*) as runs,
        COALESCE(SUM(tokens_in), 0) as tokens_in,
        COALESCE(SUM(tokens_out), 0) as tokens_out,
        COALESCE(SUM(estimated_cost_usd), 0.0) as cost_usd
      FROM runs WHERE started_at >= ?
      GROUP BY date(started_at, 'unixepoch')
      ORDER BY date DESC`
    ),
    insightsByStatus: db.prepare<{ status: string; count: number }, [number]>(
      `SELECT t.status, COUNT(*) as count
      FROM tasks t
      JOIN runs r ON r.task_id = t.id
      WHERE r.started_at >= ?
      GROUP BY t.status`
    ),
  };

  return {
    createPipeline(input) {
      const id = newId();
      return stmts.insertPipeline.get(id, input.name, JSON.stringify(input.stages))!;
    },

    getPipeline(id) {
      return stmts.getPipeline.get(id) ?? null;
    },

    listPipelines() {
      return stmts.listPipelines.all();
    },

    createTask(input) {
      const id = newId();
      return stmts.insertTask.get(
        id,
        input.pipelineId ?? null,
        input.stage ?? null,
        input.title,
        input.description ?? null,
        input.agentRole ?? "coder",
        input.priority ?? 0,
        input.maxRetries ?? 3,
        input.replyJid ?? null,
        input.agentOverride ?? null,
        input.modelOverride ?? null
      )!;
    },

    getTask(id) {
      return stmts.getTask.get(id) ?? null;
    },

    listTasks(opts = {}) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts.status) {
        conditions.push("status = ?");
        params.push(opts.status);
      }
      if (opts.stage) {
        conditions.push("stage = ?");
        params.push(opts.stage);
      }
      if (opts.cursor) {
        conditions.push("created_at < (SELECT created_at FROM tasks WHERE id = ?)");
        params.push(opts.cursor);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = opts.limit ?? 50;

      const query = db.prepare<Task, (string | number)[]>(
        `SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at DESC LIMIT ?`
      );
      return query.all(...params, limit);
    },

    updateTaskStatus(id, status) {
      return stmts.updateTaskStatus.get(status, id) ?? null;
    },

    incrementRetryCount(id) {
      stmts.incrementRetry.run(id);
    },

    listQueuedTasks() {
      return stmts.listQueuedTasks.all();
    },

    claimNextTask(worker, leaseDurationSec) {
      const txn = db.transaction(() => {
        const task = stmts.claimNextTask.get();
        if (!task) return null;

        const runId = newId();
        const run = stmts.insertRun.get(runId, task.id)!;

        const leaseId = newId();
        const expiresAt = Math.floor(Date.now() / 1000) + leaseDurationSec;
        const lease = stmts.insertLease.get(leaseId, task.id, run.id, worker, expiresAt)!;

        return { task, run, lease };
      });
      return txn();
    },

    claimTask(taskId, worker, leaseDurationSec) {
      const txn = db.transaction(() => {
        const task = stmts.claimTaskById.get(taskId);
        if (!task) return null;

        const runId = newId();
        const run = stmts.insertRun.get(runId, task.id)!;

        const leaseId = newId();
        const expiresAt = Math.floor(Date.now() / 1000) + leaseDurationSec;
        const lease = stmts.insertLease.get(leaseId, task.id, run.id, worker, expiresAt)!;

        return { task, run, lease };
      });
      return txn();
    },

    cancelTask(id) {
      const task = stmts.getTask.get(id);
      if (!task) return null;
      if (task.status === "done" || task.status === "cancelled") return task;
      return stmts.updateTaskStatus.get("cancelled", id) ?? null;
    },

    createRun(taskId) {
      const id = newId();
      return stmts.insertRun.get(id, taskId)!;
    },

    getRun(id) {
      return stmts.getRun.get(id) ?? null;
    },

    getLatestRun(taskId) {
      return stmts.getLatestRun.get(taskId) ?? null;
    },

    finishRun(id, status, exitCode) {
      return stmts.finishRun.get(status, exitCode, id) ?? null;
    },

    addEvent(runId, kind, payload) {
      return stmts.insertEvent.get(runId, kind, payload)!;
    },

    listEvents(runId, afterId) {
      if (afterId !== undefined) {
        return stmts.listEventsAfter.all(runId, afterId);
      }
      return stmts.listEvents.all(runId);
    },

    releaseLease(leaseId) {
      stmts.releaseLease.run(leaseId);
    },

    getActiveLease(taskId) {
      return stmts.getActiveLease.get(taskId) ?? null;
    },

    extendLease(leaseId, additionalSec) {
      stmts.extendLease.run(additionalSec, leaseId);
    },

    createGate(pipelineId, fromStage, toStage) {
      return stmts.insertGate.get(pipelineId, fromStage, toStage)!;
    },

    approveGate(gateId) {
      return stmts.approveGate.get(gateId) ?? null;
    },

    listGates(pipelineId) {
      return stmts.listGates.all(pipelineId);
    },

    getGate(pipelineId, fromStage, toStage) {
      return stmts.getGate.get(pipelineId, fromStage, toStage) ?? null;
    },

    setTaskStage(taskId, stage) {
      return stmts.setTaskStage.get(stage, taskId) ?? null;
    },

    createArtifact(input) {
      const id = newId();
      return stmts.insertArtifact.get(
        id, input.taskId, input.runId, input.name, input.path,
        input.mimeType ?? null, input.sizeBytes
      )!;
    },

    listArtifacts(opts = {}) {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (opts.taskId) {
        conditions.push("task_id = ?");
        params.push(opts.taskId);
      }
      if (opts.runId) {
        conditions.push("run_id = ?");
        params.push(opts.runId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const query = db.prepare<Artifact, (string | number)[]>(
        `SELECT * FROM artifacts ${where} ORDER BY created_at DESC`
      );
      return query.all(...params);
    },

    getQueueDepth() {
      return stmts.queueDepth.get()!.count;
    },

    getActiveWorkerCount() {
      return stmts.activeWorkers.get()!.count;
    },

    // Monitoring
    getFailedTasks(limit = 50) {
      return stmts.failedTasks.all(limit);
    },

    getRecentlyDoneTasks(sinceTs, limit = 50) {
      return stmts.recentlyDoneTasks.all(sinceTs, limit);
    },

    getRecentlyFailedTasks(sinceTs, limit = 50) {
      return stmts.recentlyFailedTasks.all(sinceTs, limit);
    },

    getExpiredLeases() {
      return stmts.expiredLeases.all();
    },

    getActiveRuns() {
      return stmts.activeRuns.all();
    },

    getHealthStatus() {
      return {
        queueDepth: stmts.queueDepth.get()!.count,
        activeWorkers: stmts.activeWorkers.get()!.count,
        failedCount: stmts.failedCount.get()!.count,
        runningCount: stmts.runningCount.get()!.count,
      };
    },

    // Crons
    createCron(input) {
      const id = newId();
      return stmts.insertCron.get(
        id,
        input.name,
        input.schedule,
        JSON.stringify(input.taskTemplate),
        input.oneShot ? 1 : 0,
        input.nextRunAt ?? null
      )!;
    },

    getCron(id) {
      return stmts.getCron.get(id) ?? null;
    },

    listCrons() {
      return stmts.listCrons.all();
    },

    getDueCrons() {
      return stmts.dueCrons.all();
    },

    updateCronLastRun(id, lastRunAt, nextRunAt) {
      stmts.updateCronLastRun.run(lastRunAt, nextRunAt, id);
    },

    updateCronEnabled(id, enabled) {
      stmts.updateCronEnabled.run(enabled ? 1 : 0, id);
    },

    toggleCron(id) {
      const cron = stmts.getCron.get(id);
      if (!cron) return null;
      const newEnabled = cron.enabled ? 0 : 1;
      stmts.updateCronEnabled.run(newEnabled, id);
      return stmts.getCron.get(id) ?? null;
    },

    deleteCron(id) {
      stmts.deleteCron.run(id);
    },

    // Alerts
    createAlert(kind, message, taskId) {
      return stmts.insertAlert.get(kind, message, taskId ?? null)!;
    },

    listAlerts(opts = {}) {
      const limit = opts.limit ?? 100;
      if (opts.acknowledged === false) {
        return stmts.listAlertsUnack.all(limit);
      }
      return stmts.listAlertsAll.all(limit);
    },

    acknowledgeAlert(id) {
      stmts.acknowledgeAlert.run(id);
    },

    acknowledgeAllAlerts() {
      stmts.acknowledgeAllAlerts.run();
    },

    acknowledgeAlertsByKind(kind) {
      stmts.acknowledgeAlertsByKind.run(kind);
    },

    getUnacknowledgedAlertCount() {
      return stmts.unackAlertCount.get()!.count;
    },

    // Chat messages
    addChatMessage(jid, role, content, taskId) {
      return stmts.insertChatMessage.get(jid, role, content, taskId ?? null)!;
    },

    getRecentChatMessages(jid, limit = 20) {
      return stmts.recentChatMessages.all(jid, limit);
    },

    getChatMessageForTask(taskId) {
      return stmts.chatMessageForTask.get(taskId) ?? null;
    },

    // Experiments (autoresearch)
    recordExperiment(input) {
      return stmts.insertExperiment.get(
        input.sessionId, input.commitHash, input.parentHash,
        input.testsPassed, input.testsFailed, input.testsTotal,
        input.testDurationMs, input.experimentDurationMs,
        input.status, input.description, input.diffStat, input.taskId
      )!;
    },

    listExperiments(sessionId) {
      return stmts.listExperiments.all(sessionId);
    },

    listExperimentSessions() {
      return stmts.listExperimentSessions.all();
    },

    // Session search (FTS5)
    searchEvents(query: string, limit = 20): EventSearchResult[] {
      try {
        const rows = db.prepare<
          { run_id: string; payload: string; snip: string; task_id: string; task_title: string; task_created_at: number },
          [string, number]
        >(
          `SELECT e.run_id, e.payload, snippet(events_fts, 0, '>>>', '<<<', '...', 32) as snip,
                  r.task_id, t.title as task_title, t.created_at as task_created_at
           FROM events_fts
           JOIN events e ON events_fts.rowid = e.id
           JOIN runs r ON e.run_id = r.id
           JOIN tasks t ON r.task_id = t.id
           WHERE events_fts MATCH ?
           ORDER BY rank
           LIMIT ?`
        ).all(query, limit * 5);

        // Group by task
        const grouped = new Map<string, {
          taskId: string;
          taskTitle: string;
          runId: string;
          matchCount: number;
          snippets: string[];
          taskCreatedAt: number;
        }>();

        for (const row of rows) {
          const existing = grouped.get(row.task_id);
          if (existing) {
            existing.matchCount++;
            if (existing.snippets.length < 5) {
              const truncated = row.snip.length > 200 ? row.snip.slice(0, 200) + "..." : row.snip;
              existing.snippets.push(truncated);
            }
          } else {
            const truncated = row.snip.length > 200 ? row.snip.slice(0, 200) + "..." : row.snip;
            grouped.set(row.task_id, {
              taskId: row.task_id,
              taskTitle: row.task_title,
              runId: row.run_id,
              matchCount: 1,
              snippets: [truncated],
              taskCreatedAt: row.task_created_at,
            });
          }
        }

        // Sort by match count descending, take up to limit
        return Array.from(grouped.values())
          .sort((a, b) => b.matchCount - a.matchCount)
          .slice(0, limit);
      } catch {
        // FTS table doesn't exist yet — return empty
        return [];
      }
    },

    rebuildFtsIndex(): void {
      try {
        db.exec("INSERT INTO events_fts(events_fts) VALUES('rebuild')");
      } catch {
        // FTS table doesn't exist — safe to ignore
      }
    },

    // Usage insights
    updateRunMetrics(runId, metrics) {
      const setClauses: string[] = [];
      const params: (string | number)[] = [];

      if (metrics.tokensIn !== undefined) {
        setClauses.push("tokens_in = ?");
        params.push(metrics.tokensIn);
      }
      if (metrics.tokensOut !== undefined) {
        setClauses.push("tokens_out = ?");
        params.push(metrics.tokensOut);
      }
      if (metrics.estimatedCostUsd !== undefined) {
        setClauses.push("estimated_cost_usd = ?");
        params.push(metrics.estimatedCostUsd);
      }
      if (metrics.modelUsed !== undefined) {
        setClauses.push("model_used = ?");
        params.push(metrics.modelUsed);
      }

      if (setClauses.length === 0) return;

      params.push(runId);
      const sql = `UPDATE runs SET ${setClauses.join(", ")} WHERE id = ?`;
      db.prepare(sql).run(...params);
    },

    getInsights(days = 7) {
      const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;

      const totals = stmts.insightsTotals.get(sinceTs)!;
      const totalTasks = stmts.insightsTotalTasks.get(sinceTs)!;
      const byModel = stmts.insightsByModel.all(sinceTs).map(r => ({
        model: r.model,
        runs: r.runs,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        costUsd: r.cost_usd,
      }));
      const byDay = stmts.insightsByDay.all(sinceTs).map(r => ({
        date: r.date,
        tasks: r.tasks,
        runs: r.runs,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        costUsd: r.cost_usd,
      }));
      const byStatus = stmts.insightsByStatus.all(sinceTs);

      return {
        totalTasks: totalTasks.total_tasks,
        totalRuns: totals.total_runs,
        totalTokensIn: totals.total_tokens_in,
        totalTokensOut: totals.total_tokens_out,
        totalCostUsd: totals.total_cost_usd,
        byModel,
        byDay,
        byStatus,
        avgDurationSec: totals.avg_duration_sec,
      };
    },
  };
}
