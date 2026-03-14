import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { ContainerManager } from "../container/manager";
import type { TurboClawConfig } from "../config";
import { validateSelfImproveTask, buildSelfImproveEnv, selfImprovePreamble } from "../container/self-improve";
import { completionProtocol } from "../container/completion";
import { resolveCredentialPaths } from "../container/credentials";
import { buildAgentCommand, getAgentEnvVars, getAgentCredentialPaths, resolveOpenCodeModel } from "../container/agent-commands";
import type { AgentType } from "../container/agent-commands";
import { buildContext, buildCoreContext } from "../memory/context";
import { maybeCreateTaskMemory } from "../memory/auto-memory";
import { advanceTask } from "../tracker/pipelines";
import { sortTasks } from "./strategies";
import { nextRunAt } from "./cron-parser";
import { discoverSkills } from "../skills/discovery";
import { createSkillCache } from "../skills/cache";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

export interface OrchestratorHandle {
  stop(): void;
  isRunning(): boolean;
  requestRestart(callback: () => void): void;
}

export function startOrchestrator(
  store: Store,
  containerManager: ContainerManager,
  config: TurboClawConfig,
  restartToken?: string
): OrchestratorHandle {
  let running = true;
  let activeCount = 0;
  let restartRequested = false;
  let restartCallback: (() => void) | null = null;
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

    // Workspace: mount the host project root so the agent can work on real files.
    // Falls back to a per-task directory if no workspaceRoot is configured.
    const workspacePath = config.workspaceRoot ?? process.cwd();
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    // Per-task artifact directory for logs/outputs (not the container workspace)
    const artifactDir = join(config.home, "tasks", task.id);
    if (!existsSync(artifactDir)) {
      mkdirSync(artifactDir, { recursive: true });
    }

    // Build environment variables from provider config
    const envVars: Record<string, string> = {};
    const agentType: AgentType = config.agent ?? "opencode";

    // For opencode-config, skip all env var injection — opencode uses its own mounted config
    if (config.provider && config.provider.type !== "opencode-config") {
      envVars.TURBOCLAW_PROVIDER_TYPE = config.provider.type;

      if (config.provider.apiKey) {
        const key = config.provider.apiKey;
        const provType = config.provider.type;

        // Set the canonical env var based on provider type
        if (provType === "anthropic" || provType === "claude-code" || provType === "claude-sub") {
          if (key.startsWith("sk-ant-oat")) {
            envVars.CLAUDE_CODE_OAUTH_TOKEN = key;
          } else if (key.startsWith("sk-ant-")) {
            envVars.ANTHROPIC_API_KEY = key;
          } else {
            envVars.CLAUDE_CODE_OAUTH_TOKEN = key;
          }
          // OpenCode and Codex also need ANTHROPIC_API_KEY if using Anthropic provider
          if (agentType !== "claude-code" && key.startsWith("sk-ant-") && !key.startsWith("sk-ant-oat")) {
            envVars.ANTHROPIC_API_KEY = key;
          }
        } else if (provType === "openai" || provType === "chatgpt" || provType === "copilot") {
          envVars.OPENAI_API_KEY = key;
        } else if (provType === "codex") {
          envVars.OPENAI_API_KEY = key;
        } else if (provType === "custom") {
          envVars.OPENAI_API_KEY = key;
        }

        // Cross-agent compatibility: ensure the agent's expected env var is set
        if (agentType === "claude-code" && !envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
          // Claude Code needs ANTHROPIC_API_KEY — set it from whatever key we have
          envVars.ANTHROPIC_API_KEY = key;
        } else if (agentType === "codex" && !envVars.OPENAI_API_KEY) {
          // Codex needs OPENAI_API_KEY
          envVars.OPENAI_API_KEY = key;
        }
      }

      if (config.provider.baseUrl) {
        envVars.OPENAI_BASE_URL = config.provider.baseUrl;
      }
      if (config.provider.model) {
        envVars.OPENCODE_MODEL = config.provider.model;
      }
    }

    // Self-improve mode: override workspace to TurboClaw's own source tree
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
      // Mount TurboClaw source as /project AND override workspace to point there
      // so the agent's working directory is the source tree it needs to improve.
      mountProjectSource = process.cwd();
      Object.assign(envVars, buildSelfImproveEnv(config, task.id, restartToken));
      envVars.TURBOCLAW_WORK_DIR = "/project";
    }

    const memoryVaultPath = join(config.home, "memory");

    // Build prompt with memory context and chat history
    // Injection order (outermost first): core → search-based → chat history → prompt
    let prompt = task.description ?? task.title;

    if (task.agent_role === "self-improve") {
      prompt = `${selfImprovePreamble(task.id)}\n\n${prompt}`;
    }

    // Inject recent conversation history for WhatsApp tasks
    if (task.reply_jid) {
      const history = store.getRecentChatMessages(task.reply_jid, 20);
      const previous = history
        .filter(m => m.task_id !== task.id)
        .filter(m => {
          // Defense-in-depth: drop noisy assistant messages that shouldn't
          // have been stored (e.g. "Done. (TASKID)", failure notifications,
          // raw JSON error payloads)
          if (m.role !== "assistant") return true;
          const c = m.content.trim();
          if (/^Done\.\s*\(/.test(c)) return false;
          if (/^Sorry, that failed/.test(c)) return false;
          if (/^\{/.test(c)) return false;
          return true;
        });
      if (previous.length > 0) {
        const lines = previous.map(m =>
          m.role === "user" ? `User: ${m.content}` : `Assistant: ${m.content}`
        );
        prompt = `# Recent Conversation\n\n${lines.join("\n\n")}\n\n---\n\n${prompt}`;
      }
    }

    // Search-based memory (daily/weekly notes matched by keywords)
    const memoryContext = buildContext(memoryVaultPath, prompt, [], 3);
    if (memoryContext) {
      prompt = `${memoryContext}\n\n---\n\n${prompt}`;
    }

    // Core memory (always injected, outermost layer)
    const coreContext = buildCoreContext(memoryVaultPath);
    if (coreContext) {
      prompt = `${coreContext}\n\n---\n\n${prompt}`;
    }

    // Completion protocol (outermost — agent sees this first)
    const apiUrl = `http://host.docker.internal:${config.gateway.port}`;
    prompt = `${completionProtocol(task.id, apiUrl)}${prompt}`;

    // Resolve agent CLI command based on configured agent type
    let agentCommand = buildAgentCommand(agentType);

    // For OpenCode, resolve the model string from provider config
    // For opencode-config, strip --model entirely — let opencode use its own config
    if (agentType === "opencode" && config.provider?.type === "opencode-config") {
      const filtered: string[] = [];
      for (let i = 0; i < agentCommand.length; i++) {
        if (agentCommand[i] === "--model") {
          i++; // skip the model value placeholder
        } else {
          filtered.push(agentCommand[i]!);
        }
      }
      agentCommand = filtered;
    } else if (agentType === "opencode" && config.provider) {
      const model = resolveOpenCodeModel(config.provider);
      agentCommand = agentCommand.map(arg => arg === "{model}" ? model : arg);
    } else if (agentType === "opencode") {
      // No provider configured, use default model
      agentCommand = agentCommand.map(arg => arg === "{model}" ? "anthropic/claude-sonnet-4-20250514" : arg);
    }

    // Merge agent-specific env vars
    const agentEnv = getAgentEnvVars(agentType);
    Object.assign(envVars, agentEnv);

    // Resolve credential paths for OAuth providers, deduplicated
    const credentialPaths = config.provider?.type
      ? resolveCredentialPaths(config.provider.type)
      : [];

    // Also include agent-specific credential paths (dedup to avoid duplicate Docker mounts)
    const agentCredPaths = getAgentCredentialPaths(agentType);
    for (const p of agentCredPaths) {
      if (!credentialPaths.includes(p)) {
        credentialPaths.push(p);
      }
    }

    // Auto-discover skills from registries based on task prompt
    let skillPaths: Array<{ name: string; hostDir: string }> = [];
    if (config.skills.autoDiscover && agentType !== "codex") {
      try {
        const projectRoot = process.cwd();
        const taskPrompt = task.description ?? task.title;
        const skillNames = await discoverSkills(taskPrompt, projectRoot, config.skills);
        if (skillNames.length > 0) {
          const cache = createSkillCache(projectRoot);
          skillPaths = skillNames.map((name) => ({
            name,
            hostDir: cache.skillDir(name),
          }));
          store.addEvent(run.id, "info", `Discovered ${skillNames.length} skills: ${skillNames.join(", ")}`);
        }
      } catch (err) {
        logger.warn(`Skill discovery failed for task ${task.id}:`, err);
      }
    }

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
        agentType,
        skillPaths,
        gatewayPort: config.gateway.port,
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

            // Auto-memory: write task log to vault
            try {
              const events = store.listEvents(run.id);
              const output = events.filter(e => e.kind === "stdout").map(e => e.payload).join("\n").trim();
              if (output) {
                maybeCreateTaskMemory(memoryVaultPath, task, output);
              }
            } catch (err) {
              logger.warn(`Auto-memory failed for task ${task.id}:`, err);
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
          replyJid?: string;
        };

        const task = store.createTask({
          title: template.title,
          description: template.description ?? null,
          agentRole: (template.agentRole as "coder" | "reviewer" | "planner" | "self-improve" | "librarian") ?? "coder",
          priority: template.priority ?? 0,
          replyJid: template.replyJid ?? null,
        });
        store.updateTaskStatus(task.id, "queued");

        const now = Math.floor(Date.now() / 1000);

        if (cron.one_shot) {
          // One-shot crons disable themselves after firing
          store.updateCronLastRun(cron.id, now, now);
          store.updateCronEnabled(cron.id, false);
          logger.info(`One-shot cron "${cron.name}" fired → created task "${task.title}" (${task.id}), now disabled`);
        } else {
          const next = nextRunAt(cron.schedule, new Date());
          store.updateCronLastRun(cron.id, now, next);
          logger.info(`Cron "${cron.name}" fired → created task "${task.title}" (${task.id}), next run at ${next}`);
        }
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
    // If restart requested, wait for active containers to drain then invoke callback
    if (restartRequested) {
      if (activeCount === 0 && restartCallback) {
        logger.info("All containers drained — executing restart");
        clearInterval(interval);
        restartCallback();
        return;
      }
      // Don't pick up new tasks while draining
      logger.info(`Restart pending — waiting for ${activeCount} active container(s) to finish`);
      tickExpiredLeases();
      return;
    }

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
    requestRestart(callback: () => void) {
      restartRequested = true;
      restartCallback = callback;
      logger.info(`Restart requested — draining ${activeCount} active container(s)`);
      // If no active containers, fire immediately
      if (activeCount === 0) {
        logger.info("No active containers — executing restart immediately");
        clearInterval(interval);
        callback();
      }
    },
  };
}
