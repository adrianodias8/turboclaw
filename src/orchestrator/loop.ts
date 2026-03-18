import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { ContainerManager } from "../container/manager";
import type { TurboClawConfig } from "../config";
import { validateSelfImproveTask, buildSelfImproveEnv, selfImprovePreamble } from "../container/self-improve";
import { completionProtocol } from "../container/completion";
import { resolveCredentialPaths } from "../container/credentials";
import { buildAgentCommand, getAgentEnvVars, getAgentCredentialPaths, resolveOpenCodeModel } from "../container/agent-commands";
import type { AgentType } from "../container/agent-commands";
import { buildContext, buildCoreContext, buildRulesContext, buildRoleSkillContext, detectLanguages } from "../memory/context";
import { maybeCreateTaskMemory } from "../memory/auto-memory";
import { buildInstinctContext, extractInstincts, saveInstinct, listInstincts } from "../memory/instincts";
import { advanceTask } from "../tracker/pipelines";
import { scanForSecrets, sanitizeSecrets } from "../container/security";
import { sortTasks, resolveAgentForTask } from "./strategies";
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
  restartToken?: string,
  onRestart?: () => void
): OrchestratorHandle {
  let running = true;
  let activeCount = 0;
  let tickInProgress = false;
  let restartRequested = false;
  let restartCallback: (() => void) | null = null;
  const activeContainers = new Map<string, string>(); // runId -> containerId

  function decrementActiveCount() {
    if (activeCount > 0) activeCount--;
  }

  // Record git HEAD at boot for auto-restart detection
  const bootHead = (() => {
    try {
      const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
      return new TextDecoder().decode(result.stdout).trim();
    } catch {
      return "";
    }
  })();

  async function tick() {
    if (!running || tickInProgress) return;
    tickInProgress = true;

    try {
      await tickInner();
    } finally {
      tickInProgress = false;
    }
  }

  async function tickInner() {
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
    // When workspaceRoot is configured, all tasks share that directory (user's intent).
    // When not configured, each task gets its own isolated directory to prevent
    // concurrent tasks from colliding (e.g. two tasks writing to the same files).
    let workspacePath: string;
    if (config.workspaceRoot) {
      workspacePath = config.workspaceRoot;
      if (config.orchestrator.maxConcurrency > 1 && activeCount > 0) {
        logger.warn(`Multiple concurrent tasks sharing workspace ${workspacePath} — consider reducing maxConcurrency to 1 or using per-task workspaces`);
      }
    } else {
      workspacePath = join(config.home, "workspaces", task.id);
    }
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
    const defaultAgent: AgentType = config.agent ?? "opencode";

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
          if (defaultAgent !== "claude-code" && key.startsWith("sk-ant-") && !key.startsWith("sk-ant-oat")) {
            envVars.ANTHROPIC_API_KEY = key;
          }
        } else if (["openai", "chatgpt", "copilot", "codex", "custom"].includes(provType)) {
          envVars.OPENAI_API_KEY = key;
        }

        // Cross-agent compatibility: ensure the agent's expected env var is set
        if (defaultAgent === "claude-code" && !envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
          envVars.ANTHROPIC_API_KEY = key;
        } else if (defaultAgent === "codex" && !envVars.OPENAI_API_KEY) {
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
        decrementActiveCount();
        return;
      }
      // Mount TurboClaw source as /project AND override workspace to point there
      // so the agent's working directory is the source tree it needs to improve.
      mountProjectSource = process.cwd();
      Object.assign(envVars, buildSelfImproveEnv(config, task.id, restartToken));
      envVars.TURBOCLAW_WORK_DIR = "/project";
    }

    const memoryVaultPath = join(config.home, "memory");
    const projectRoot = process.cwd();
    const skillsDir = join(projectRoot, "docker", "skills");
    const rulesDir = join(projectRoot, "docker", "rules");

    // Build prompt — injection order (outermost first):
    // completion → coreMemory → rules → roleSkill → searchFirst → instincts → searchMemory → selfImprove → chatHistory → task
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

    // Matched instincts (learned patterns from previous tasks)
    const instinctContext = buildInstinctContext(memoryVaultPath, task.description ?? task.title);
    if (instinctContext) {
      prompt = `${instinctContext}\n\n---\n\n${prompt}`;
    }

    // Search-based memory (daily/weekly notes matched by keywords)
    const memoryContext = buildContext(memoryVaultPath, prompt, [], 3);
    if (memoryContext) {
      prompt = `${memoryContext}\n\n---\n\n${prompt}`;
    }

    // Search-first principle (for coder/planner roles)
    if (["coder", "planner"].includes(task.agent_role)) {
      const searchFirstContext = buildRoleSkillContext(skillsDir, "search-first");
      if (searchFirstContext) {
        prompt = `${searchFirstContext}\n\n---\n\n${prompt}`;
      }
    }

    // Role-specific skill (e.g. planner, code-reviewer, security-reviewer)
    const roleSkillContext = buildRoleSkillContext(skillsDir, task.agent_role);
    if (roleSkillContext) {
      prompt = `${roleSkillContext}\n\n---\n\n${prompt}`;
    }

    // Coding rules (common + language-specific)
    const languages = detectLanguages(workspacePath);
    const rulesContext = buildRulesContext(rulesDir, languages);
    if (rulesContext) {
      prompt = `${rulesContext}\n\n---\n\n${prompt}`;
    }

    // Core memory (always injected, outermost layer)
    const coreContext = buildCoreContext(memoryVaultPath);
    if (coreContext) {
      prompt = `${coreContext}\n\n---\n\n${prompt}`;
    }

    // Completion protocol (outermost — agent sees this first)
    const apiUrl = `http://host.docker.internal:${config.gateway.port}`;
    prompt = `${completionProtocol(task.id, apiUrl)}${prompt}`;

    // Enforce prompt size budget — truncate if too large for model context
    const MAX_PROMPT_CHARS = 180000; // ~45K tokens, leaves room for agent output
    if (prompt.length > MAX_PROMPT_CHARS) {
      logger.warn(`Prompt for task ${task.id} exceeds budget (${prompt.length} chars) — truncating`);
      // Preserve the completion protocol (outermost) and task description (innermost)
      // Truncate middle context layers
      const taskDesc = task.description ?? task.title;
      const protocol = completionProtocol(task.id, apiUrl);
      const availableForContext = MAX_PROMPT_CHARS - protocol.length - taskDesc.length - 100;
      if (availableForContext > 0) {
        const middleContext = prompt.slice(protocol.length, prompt.length - taskDesc.length);
        prompt = protocol + middleContext.slice(0, availableForContext) + "\n\n---\n\n" + taskDesc;
      } else {
        prompt = protocol + taskDesc;
      }
    }

    // Pre-dispatch security scan — alert if prompt contains potential secrets
    const secretsFound = scanForSecrets(task.description ?? task.title);
    if (secretsFound.length > 0) {
      logger.warn(`Task ${task.id} prompt may contain secrets: ${secretsFound.join(", ")}`);
      store.createAlert("security_warning", `Task "${task.title}" prompt may contain: ${secretsFound.join(", ")}`, task.id);
    }

    const { agent: resolvedAgentType, model: resolvedModel } = resolveAgentForTask(task, defaultAgent, config.provider?.model);
    let agentCommand = buildAgentCommand(resolvedAgentType);
    if (resolvedModel) {
      envVars.OPENCODE_MODEL = resolvedModel;
    }

    // For OpenCode, resolve the model string from provider config
    // For opencode-config, strip --model entirely — let opencode use its own config
    if (resolvedAgentType === "opencode" && config.provider?.type === "opencode-config") {
      const filtered: string[] = [];
      for (let i = 0; i < agentCommand.length; i++) {
        if (agentCommand[i] === "--model") {
          i++; // skip the model value placeholder
        } else {
          filtered.push(agentCommand[i]!);
        }
      }
      agentCommand = filtered;
    } else if (resolvedAgentType === "opencode" && config.provider) {
      const model = resolveOpenCodeModel(config.provider);
      agentCommand = agentCommand.map(arg => arg === "{model}" ? model : arg);
    } else if (resolvedAgentType === "opencode") {
      agentCommand = agentCommand.map(arg => arg === "{model}" ? "anthropic/claude-sonnet-4-20250514" : arg);
    }

    // Merge agent-specific env vars
    const agentEnv = getAgentEnvVars(resolvedAgentType);
    Object.assign(envVars, agentEnv);

    // Resolve credential paths for OAuth providers, deduplicated
    const credentialPaths = config.provider?.type
      ? resolveCredentialPaths(config.provider.type)
      : [];

    // Also include agent-specific credential paths (dedup to avoid duplicate Docker mounts)
    const agentCredPaths = getAgentCredentialPaths(resolvedAgentType);
    for (const p of agentCredPaths) {
      if (!credentialPaths.includes(p)) {
        credentialPaths.push(p);
      }
    }

    // Auto-discover skills from registries based on task prompt
    let skillPaths: Array<{ name: string; hostDir: string }> = [];
    if (config.skills.autoDiscover && resolvedAgentType !== "codex") {
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
        agentType: resolvedAgentType,
        skillPaths,
        gatewayPort: config.gateway.port,
      });

      activeContainers.set(run.id, container.containerId);
      store.addEvent(run.id, "info", `Container started: ${container.containerId}`);

      // Stream logs in background
      containerManager
        .streamLogs(container.containerId, (kind, line) => {
          store.addEvent(run.id, kind, sanitizeSecrets(line));
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

            // Collect stdout once for auto-memory and instinct extraction
            const runEvents = store.listEvents(run.id);
            const taskOutput = runEvents.filter(e => e.kind === "stdout").map(e => e.payload).join("\n").trim();

            // Auto-memory: write task log to vault
            try {
              if (taskOutput) {
                maybeCreateTaskMemory(memoryVaultPath, task, taskOutput);
              }
            } catch (err) {
              logger.warn(`Auto-memory failed for task ${task.id}:`, err);
            }

            // Extract instincts from task output (learned patterns)
            try {
              if (taskOutput && taskOutput.length > 50) {
                const newInstincts = extractInstincts(task.title, taskOutput, task.id);
                const existing = listInstincts(memoryVaultPath);
                const existingIds = new Set(existing.map(i => i.id));
                for (const instinct of newInstincts) {
                  if (existingIds.has(instinct.id)) {
                    const current = existing.find(i => i.id === instinct.id)!;
                    current.confidence = Math.min(0.95, current.confidence + 0.1);
                    current.evidence.push(`Task ${task.id}: ${task.title}`);
                    if (current.evidence.length > 20) {
                      current.evidence = current.evidence.slice(-20);
                    }
                    saveInstinct(memoryVaultPath, current);
                  } else {
                    saveInstinct(memoryVaultPath, instinct);
                  }
                }
                if (newInstincts.length > 0) {
                  logger.info(`Extracted ${newInstincts.length} instinct(s) from task ${task.id}`);
                }
              }
            } catch (err) {
              logger.warn(`Instinct extraction failed for task ${task.id}:`, err);
            }

            // Auto-restart: if a self-improve task completed, check if git HEAD
            // changed from boot time (any new commits on any branch = restart)
            if (task.agent_role === "self-improve" && !restartRequested && onRestart && bootHead && !config.autoresearch.enabled) {
              try {
                const result = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
                const currentHead = new TextDecoder().decode(result.stdout).trim();
                if (currentHead !== bootHead) {
                  logger.info(`Self-improve task ${task.id}: HEAD changed (${bootHead.slice(0, 8)} → ${currentHead.slice(0, 8)}) — triggering auto-restart`);
                  store.addEvent(run.id, "info", `Auto-restart triggered: HEAD changed from ${bootHead.slice(0, 8)} to ${currentHead.slice(0, 8)}`);
                  restartRequested = true;
                  restartCallback = onRestart;
                }
              } catch (err) {
                logger.warn(`Failed to check git HEAD for task ${task.id}:`, err);
              }
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
          decrementActiveCount();

          logger.info(`Run ${run.id} finished: exit ${exitCode}`);
        })
        .catch(async (err) => {
          logger.error(`Error streaming logs for run ${run.id}:`, err);
          store.finishRun(run.id, "failed", -1);
          store.updateTaskStatus(task.id, "failed");
          store.releaseLease(lease.id);
          await containerManager.cleanup(container.containerId);
          activeContainers.delete(run.id);
          decrementActiveCount();
        });
    } catch (err) {
      logger.error(`Failed to spawn container for task ${task.id}:`, err);
      store.finishRun(run.id, "failed", -1);
      store.updateTaskStatus(task.id, "failed");
      store.releaseLease(lease.id);
      decrementActiveCount();
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
      const now = Math.floor(Date.now() / 1000);
      for (const lease of expired) {
        // Auto-extend lease if the container is still producing events recently
        // This prevents killing long-running tasks that are still working
        const run = store.getRun(lease.run_id);
        if (run && run.status === "running") {
          const recentEvents = store.listEvents(lease.run_id).filter(
            e => e.created_at > now - 60
          );
          if (recentEvents.length > 0) {
            store.extendLease(lease.id, config.orchestrator.leaseDurationSec);
            logger.info(`Extended lease ${lease.id} — container still producing events`);
            continue;
          }
        }

        store.releaseLease(lease.id);

        // Mark the task as failed to prevent zombie "running" state
        const expiredTask = store.getTask(lease.task_id);
        if (expiredTask && expiredTask.status === "running") {
          if (expiredTask.retry_count < expiredTask.max_retries) {
            store.incrementRetryCount(lease.task_id);
            store.updateTaskStatus(lease.task_id, "queued");
            logger.info(`Lease expired for task ${lease.task_id} — requeueing (retry ${expiredTask.retry_count + 1}/${expiredTask.max_retries})`);
          } else {
            store.updateTaskStatus(lease.task_id, "failed");
            logger.warn(`Lease expired for task ${lease.task_id} — marking failed (retries exhausted)`);
          }
        }

        // Kill the orphaned container if we're tracking it
        const containerId = activeContainers.get(lease.run_id);
        if (containerId) {
          containerManager.kill(containerId).catch(() => {});
          containerManager.cleanup(containerId).catch(() => {});
          activeContainers.delete(lease.run_id);
          decrementActiveCount();
        }

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
      // Cancel all pending streamLogs processes so they don't hang
      containerManager.cancelAllStreamLogs();
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
