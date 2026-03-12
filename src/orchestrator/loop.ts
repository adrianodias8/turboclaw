import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { ContainerManager } from "../container/manager";
import type { TurboClawConfig } from "../config";
import { validateSelfImproveTask, buildSelfImproveEnv, selfImprovePreamble } from "../container/self-improve";
import { resolveCredentialPaths } from "../container/credentials";
import { buildAgentCommand, getAgentEnvVars, getAgentCredentialPaths } from "../container/agent-commands";
import type { AgentType } from "../container/agent-commands";
import { buildContext } from "../memory/context";
import { advanceTask } from "../tracker/pipelines";
import { sortTasks } from "./strategies";
import { nextRunAt } from "./cron-parser";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

export interface OrchestratorHandle {
  stop(): void;
  isRunning(): boolean;
}

export function startOrchestrator(
  store: Store,
  containerManager: ContainerManager,
  config: TurboClawConfig
): OrchestratorHandle {
  let running = true;
  let activeCount = 0;
  const activeContainers = new Map<string, string>(); // runId -> containerId

  async function tick() {
    if (!running) return;

    if (activeCount >= config.orchestrator.maxConcurrency) {
      return;
    }

    // Use configured scheduling strategy to pick next task
    const queued = store.listQueuedTasks();
    if (queued.length === 0) return;

    const sorted = sortTasks(queued, config.orchestrator.schedulingStrategy);
    const nextTask = sorted[0];
    if (!nextTask) return;

    // Claim the specific task chosen by the strategy
    const claimed = store.claimTask(nextTask.id, "orchestrator", config.orchestrator.leaseDurationSec);
    if (!claimed) {
      // Race condition: another worker claimed it. Try the default fallback.
      return;
    }

    const { task, run, lease } = claimed;
    activeCount++;

    logger.info(`Claimed task: ${task.title} (${task.id}) → run ${run.id} [strategy=${config.orchestrator.schedulingStrategy}]`);

    // Prepare workspace
    const workspacePath = join(config.home, "workspaces", task.id);
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    // Build environment variables from provider config
    const envVars: Record<string, string> = {};
    if (config.provider) {
      envVars.TURBOCLAW_PROVIDER_TYPE = config.provider.type;

      if (config.provider.apiKey) {
        if (config.provider.type === "anthropic" || config.provider.type === "claude-code") {
          // Claude Code CLI respects ANTHROPIC_API_KEY for regular API keys
          // and CLAUDE_CODE_OAUTH_TOKEN for OAuth tokens (sk-ant-oat* prefix)
          const key = config.provider.apiKey;
          if (key.startsWith("sk-ant-oat")) {
            // OAuth-derived token from `claude setup-token`
            envVars.CLAUDE_CODE_OAUTH_TOKEN = key;
          } else if (key.startsWith("sk-ant-")) {
            envVars.ANTHROPIC_API_KEY = key;
          } else {
            envVars.CLAUDE_CODE_OAUTH_TOKEN = key;
          }
        } else if (config.provider.type === "openai") {
          envVars.OPENAI_API_KEY = config.provider.apiKey;
        } else if (config.provider.type === "custom") {
          envVars.OPENAI_API_KEY = config.provider.apiKey;
        }
      }

      if (config.provider.baseUrl) {
        envVars.OPENAI_BASE_URL = config.provider.baseUrl; // OpenCode uses OpenAI-compatible env vars
      }
      if (config.provider.model) {
        envVars.OPENCODE_MODEL = config.provider.model;
      }
    }

    // Self-improve mode
    let mountProjectSource: string | undefined;
    if (task.agent_role === "self-improve") {
      const validation = validateSelfImproveTask(config, task);
      if (!validation.valid) {
        logger.warn(`Self-improve task ${task.id} rejected: ${validation.reason}`);
        store.finishRun(run.id, "failed", -1);
        store.updateTaskStatus(task.id, "failed");
        store.addEvent(run.id, "error", `Self-improve rejected: ${validation.reason}`);
        store.releaseLease(lease.id);
        activeCount--;
        return;
      }
      mountProjectSource = process.cwd();
      Object.assign(envVars, buildSelfImproveEnv(config, task.id));
    }

    const memoryVaultPath = join(config.home, "memory");

    // Build prompt with memory context
    let prompt = task.description ?? task.title;
    const memoryContext = buildContext(memoryVaultPath, prompt, [], 3);
    if (memoryContext) {
      prompt = `${memoryContext}\n\n---\n\n${prompt}`;
    }
    if (task.agent_role === "self-improve") {
      prompt = `${selfImprovePreamble(task.id)}\n\n${prompt}`;
    }

    // Resolve agent CLI command based on configured agent type
    const agentType: AgentType = config.agent ?? "opencode";
    const agentCommand = buildAgentCommand(agentType);

    // Merge agent-specific env vars
    const agentEnv = getAgentEnvVars(agentType);
    Object.assign(envVars, agentEnv);

    // Resolve credential paths for OAuth providers
    const credentialPaths = config.provider?.type
      ? resolveCredentialPaths(config.provider.type)
      : [];

    // Also include agent-specific credential paths
    const agentCredPaths = getAgentCredentialPaths(agentType);
    credentialPaths.push(...agentCredPaths);

    try {
      const container = await containerManager.spawn({
        taskId: task.id,
        runId: run.id,
        workspacePath,
        agentRole: task.agent_role,
        prompt,
        envVars,
        mountProjectSource,
        memoryVaultPath,
        providerType: config.provider?.type,
        credentialPaths,
        agentCommand,
      });

      activeContainers.set(run.id, container.containerId);
      store.addEvent(run.id, "info", `Container started: ${container.containerId}`);

      // Stream logs in background
      containerManager
        .streamLogs(container.containerId, (kind, line) => {
          store.addEvent(run.id, kind, line);
        })
        .then(async (exitCode) => {
          store.finishRun(run.id, exitCode === 0 ? "done" : "failed", exitCode);
          store.releaseLease(lease.id);

          if (exitCode === 0) {
            // On success: advance pipeline stage if applicable, otherwise mark done
            if (task.pipeline_id && task.stage) {
              // advanceTask will set status to "queued" for next stage,
              // or "done" if this was the final stage
              advanceTask(store, task.id);
            } else {
              store.updateTaskStatus(task.id, "done");
            }
          } else {
            // On failure: retry if allowed, otherwise mark failed
            const currentTask = store.getTask(task.id);
            if (currentTask && currentTask.retry_count < currentTask.max_retries) {
              store.incrementRetryCount(task.id);
              logger.info(`Task ${task.id} failed (exit ${exitCode}), requeueing (retry ${currentTask.retry_count + 1}/${currentTask.max_retries})`);
              store.updateTaskStatus(task.id, "queued");
            } else {
              store.updateTaskStatus(task.id, "failed");
              store.createAlert("task_failed", `Task "${task.title}" failed after all retries exhausted (exit ${exitCode})`, task.id);
            }
          }

          // Cleanup container
          await containerManager.cleanup(container.containerId);
          activeContainers.delete(run.id);
          activeCount--;

          logger.info(`Run ${run.id} finished: exit ${exitCode}`);
        })
        .catch((err) => {
          logger.error(`Error streaming logs for run ${run.id}:`, err);
          store.finishRun(run.id, "failed", -1);
          store.updateTaskStatus(task.id, "failed");
          store.releaseLease(lease.id);
          activeContainers.delete(run.id);
          activeCount--;
        });
    } catch (err) {
      logger.error(`Failed to spawn container for task ${task.id}:`, err);
      store.finishRun(run.id, "failed", -1);
      store.updateTaskStatus(task.id, "failed");
      store.releaseLease(lease.id);
      activeCount--;
    }
  }

  function tickCrons() {
    if (!running) return;

    try {
      const dueCrons = store.getDueCrons();
      for (const cron of dueCrons) {
        const template = JSON.parse(cron.task_template) as {
          title: string;
          description?: string;
          agentRole?: string;
          priority?: number;
        };

        const task = store.createTask({
          title: template.title,
          description: template.description ?? null,
          agentRole: (template.agentRole as "coder" | "reviewer" | "planner" | "self-improve" | "librarian") ?? "coder",
          priority: template.priority ?? 0,
        });

        const now = Math.floor(Date.now() / 1000);
        const next = nextRunAt(cron.schedule, new Date());
        store.updateCronLastRun(cron.id, now, next);

        logger.info(`Cron "${cron.name}" fired → created task "${task.title}" (${task.id}), next run at ${next}`);
      }
    } catch (err) {
      logger.error("Error processing crons:", err);
    }
  }

  function tickExpiredLeases() {
    if (!running) return;

    try {
      const expired = store.getExpiredLeases();
      for (const lease of expired) {
        store.releaseLease(lease.id);
        store.createAlert("lease_expired", `Lease expired for task ${lease.task_id} (worker: ${lease.worker})`, lease.task_id);
        logger.warn(`Lease ${lease.id} expired for task ${lease.task_id}`);
      }
    } catch (err) {
      logger.error("Error processing expired leases:", err);
    }
  }

  // Start polling loop
  const interval = setInterval(() => {
    tick();
    tickCrons();
    tickExpiredLeases();
  }, config.orchestrator.pollIntervalMs);
  logger.info(
    `Orchestrator started: poll=${config.orchestrator.pollIntervalMs}ms, concurrency=${config.orchestrator.maxConcurrency}, strategy=${config.orchestrator.schedulingStrategy}`
  );

  return {
    stop() {
      running = false;
      clearInterval(interval);
      for (const [, containerId] of activeContainers) {
        containerManager.kill(containerId).catch(() => {});
      }
      logger.info("Orchestrator stopped");
    },
    isRunning() {
      return running;
    },
  };
}
