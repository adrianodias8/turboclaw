import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { ContainerManager } from "../container/manager";
import type { TurboClawConfig } from "../config";
import { validateSelfImproveTask, buildSelfImproveEnv, selfImprovePreamble } from "../container/self-improve";
import { completionProtocol } from "../container/completion";
import { resolveCredentialPaths } from "../container/credentials";
import { buildAgentCommand, getAgentEnvVars, getAgentCredentialPaths, resolveOpenCodeModel } from "../container/agent-commands";
import type { AgentType } from "../container/agent-commands";
import { buildContext, buildCoreContext, buildAgentMemoryContext, buildRulesContext, buildRoleSkillContext, detectLanguages } from "../memory/context";
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

const NUDGE_INTERVAL = 5;
let taskCounter = 0;

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
    // Use both in-memory count AND DB running count to avoid race conditions
    // where activeCount hasn't been decremented yet after a container finishes
    const dbRunningCount = store.getActiveRuns().length;
    const effectiveActive = Math.max(activeCount, dbRunningCount);
    if (effectiveActive >= config.orchestrator.maxConcurrency) {
      return;
    }

    // Use configured scheduling strategy to pick next task
    const queued = store.listQueuedTasks();
    if (queued.length === 0) return;

    const sorted = sortTasks(queued, config.orchestrator.schedulingStrategy);

    // Try to claim a task — if the top pick was already claimed, try subsequent ones
    let claimed = null;
    for (const nextTask of sorted) {
      claimed = store.claimTask(nextTask.id, "orchestrator", config.orchestrator.leaseDurationSec);
      if (claimed) break;
    }
    if (!claimed) return;

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
          // OpenCode also needs ANTHROPIC_API_KEY if using Anthropic provider
          if (defaultAgent !== "claude-code" && key.startsWith("sk-ant-") && !key.startsWith("sk-ant-oat")) {
            envVars.ANTHROPIC_API_KEY = key;
          }
        } else if (["openai", "chatgpt", "copilot", "custom"].includes(provType)) {
          envVars.OPENAI_API_KEY = key;
        }

        // Cross-agent compatibility: ensure the agent's expected env var is set
        if (defaultAgent === "claude-code" && !envVars.ANTHROPIC_API_KEY && !envVars.CLAUDE_CODE_OAUTH_TOKEN) {
          envVars.ANTHROPIC_API_KEY = key;
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

    // Save original task description before prompt building — used for memory search
    // so we don't pollute queries with protocol/context keywords
    const taskQuery = task.description ?? task.title;

    // Build prompt layers — each layer has a priority (higher = keep when truncating)
    // task=100, protocol=99, core=90, selfImprove=80, rules=70, roleSkill=60, instincts=50, memory=40, chatHistory=30
    const layers: Array<{ name: string; content: string; priority: number }> = [];

    // Task description (highest priority — always kept)
    layers.push({ name: "task", content: taskQuery, priority: 100 });

    // Self-improve preamble
    if (task.agent_role === "self-improve") {
      layers.push({ name: "selfImprove", content: selfImprovePreamble(task.id), priority: 80 });
    }

    // Chat history for WhatsApp tasks
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
        layers.push({ name: "chatHistory", content: `# Recent Conversation\n\n${lines.join("\n\n")}`, priority: 30 });
      }
    }

    // Matched instincts (learned patterns from previous tasks)
    const instinctContext = buildInstinctContext(memoryVaultPath, taskQuery);
    if (instinctContext) {
      layers.push({ name: "instincts", content: instinctContext, priority: 50 });
    }

    // Search-based memory (daily/weekly notes matched by keywords)
    const memoryContext = buildContext(memoryVaultPath, taskQuery, [], 3);
    if (memoryContext) {
      layers.push({ name: "memory", content: memoryContext, priority: 40 });
    }

    // Search-first principle (for coder/planner roles)
    if (["coder", "planner"].includes(task.agent_role)) {
      const searchFirstContext = buildRoleSkillContext(skillsDir, "search-first");
      if (searchFirstContext) {
        layers.push({ name: "searchFirst", content: searchFirstContext, priority: 60 });
      }
    }

    // Role-specific skill (e.g. planner, code-reviewer, security-reviewer)
    const roleSkillContext = buildRoleSkillContext(skillsDir, task.agent_role);
    if (roleSkillContext) {
      layers.push({ name: "roleSkill", content: roleSkillContext, priority: 60 });
    }

    // Coding rules (common + language-specific)
    const languages = detectLanguages(workspacePath);
    const rulesContext = buildRulesContext(rulesDir, languages);
    if (rulesContext) {
      layers.push({ name: "rules", content: rulesContext, priority: 70 });
    }

    // Core memory (always injected)
    const coreContext = buildCoreContext(memoryVaultPath);
    if (coreContext) {
      layers.push({ name: "core", content: coreContext, priority: 90 });
    }

    // Agent memory (always injected — insights saved by previous agents)
    const agentMemoryContext = buildAgentMemoryContext(memoryVaultPath);
    if (agentMemoryContext) {
      layers.push({ name: "agentMemory", content: agentMemoryContext, priority: 85 });
    }

    // Completion protocol (highest after task — agent sees this first)
    const apiUrl = `http://host.docker.internal:${config.gateway.port}`;
    layers.push({ name: "protocol", content: completionProtocol(task.id, apiUrl), priority: 99 });

    // Reflection nudge: every Nth task, remind the agent to save durable insights
    taskCounter++;
    if (taskCounter % NUDGE_INTERVAL === 0) {
      layers.push({
        name: "nudge",
        content: "# Reflection Nudge\n\nBefore finishing, take a moment to reflect: Did you learn anything durable during this task? If so, save it to memory using the memory API. Good candidates: environment quirks, effective patterns, project-specific conventions, debugging insights.",
        priority: 35,
      });
    }

    // Enforce prompt size budget — truncate layers by priority if too large
    const MAX_PROMPT_CHARS = 180000; // ~45K tokens, leaves room for agent output
    const SEPARATOR = "\n\n---\n\n";
    const separatorOverhead = Math.max(0, layers.length - 1) * SEPARATOR.length;
    const totalChars = layers.reduce((sum, l) => sum + l.content.length, 0) + separatorOverhead;

    if (totalChars > MAX_PROMPT_CHARS) {
      const originalLength = totalChars;
      logger.warn(`Prompt for task ${task.id} exceeds budget (${totalChars} chars) — truncating layers`);

      // Sort by priority ascending (lowest priority = cut first)
      const cuttable = layers
        .filter(l => l.name !== "task" && l.name !== "protocol")
        .sort((a, b) => a.priority - b.priority);

      let currentTotal = totalChars;
      for (const layer of cuttable) {
        if (currentTotal <= MAX_PROMPT_CHARS) break;
        const saved = layer.content.length + SEPARATOR.length;
        layer.content = "";
        currentTotal -= saved;
        logger.warn(`Truncated layer "${layer.name}" to fit prompt budget`);
      }

      store.createAlert("prompt_truncated", `Task "${task.title}" prompt was truncated from ${originalLength} to ${MAX_PROMPT_CHARS} chars — some context was lost`, task.id);
    }

    // Assemble prompt: protocol first, then layers by priority descending, task last
    // Order: protocol → core → agentMemory → selfImprove → rules → searchFirst → roleSkill → instincts → memory → nudge → chatHistory → task
    const assemblyOrder = ["protocol", "core", "agentMemory", "selfImprove", "rules", "searchFirst", "roleSkill", "instincts", "memory", "nudge", "chatHistory", "task"];
    const orderedLayers = assemblyOrder
      .map(name => layers.find(l => l.name === name))
      .filter((l): l is { name: string; content: string; priority: number } => l != null && l.content.length > 0);

    let prompt = orderedLayers.map(l => l.content).join(SEPARATOR);

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

    // Smart model routing: use cheap model for simple tasks
    if (config.routing?.enabled && resolvedAgentType === "opencode") {
      const { routeTask, DEFAULT_ROUTING_CONFIG } = await import("./routing");
      const routingConfig = {
        ...DEFAULT_ROUTING_CONFIG,
        ...config.routing,
        enabled: true,
      };
      const route = routeTask(task.title, task.description, routingConfig);
      if (route.model) {
        envVars.OPENCODE_MODEL = route.model;
        store.addEvent(run.id, "info", `Model routing: ${route.reason} → ${route.model}`);
        logger.info(`Task ${task.id} routed to ${route.model} (${route.reason})`);
      }
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
    if (config.skills.autoDiscover) {
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

    // Also mount locally-created skills from .turboclaw/skills/
    const localSkillsDir = join(config.home, "skills");
    if (existsSync(localSkillsDir)) {
      try {
        const { listLocalSkills } = await import("../skills/manager");
        const localSkills = listLocalSkills(localSkillsDir);
        for (const skill of localSkills) {
          // Avoid duplicates with registry skills
          if (!skillPaths.some(s => s.name === skill.name)) {
            skillPaths.push({ name: skill.name, hostDir: skill.path });
          }
        }
        if (localSkills.length > 0) {
          store.addEvent(run.id, "info", `Mounting ${localSkills.length} local skills: ${localSkills.map(s => s.name).join(", ")}`);
        }
      } catch (err) {
        logger.warn(`Failed to load local skills for task ${task.id}:`, err);
      }
    }

    // Checkpoint workspace before task runs
    try {
      const { createCheckpointManager } = await import("../container/checkpoint");
      const checkpointsBase = join(config.home, "checkpoints");
      const mgr = createCheckpointManager(workspacePath, checkpointsBase);
      const cp = mgr.snapshot(task.id, `Pre-task: ${task.title}`);
      if (cp) {
        store.addEvent(run.id, "info", `Checkpoint created: ${cp.hash.slice(0, 8)}`);
      }
      mgr.prune(50);
    } catch (err) {
      logger.warn(`Checkpoint failed for task ${task.id}:`, err);
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

            // Track token usage and cost
            try {
              const { parseTokenUsage, estimateCost } = await import("../tracker/insights");
              const metrics = parseTokenUsage(taskOutput);
              const model = metrics.model ?? envVars.OPENCODE_MODEL ?? "unknown";
              const cost = estimateCost(model, metrics.tokensIn, metrics.tokensOut);
              store.updateRunMetrics(run.id, {
                tokensIn: metrics.tokensIn,
                tokensOut: metrics.tokensOut,
                estimatedCostUsd: cost,
                modelUsed: model,
              });
            } catch (err) {
              logger.warn(`Token tracking failed for run ${run.id}:`, err);
            }

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
            // On failure: extract last stderr lines for the failure reason
            const failEvents = store.listEvents(run.id);
            const stderrLines = failEvents
              .filter(e => e.kind === "stderr")
              .slice(-5)
              .map(e => e.payload)
              .join("\n")
              .slice(0, 500);
            const reason = stderrLines || `exit code ${exitCode}`;

            // Retry if allowed, otherwise mark failed
            const currentTask = store.getTask(task.id);
            if (currentTask && currentTask.retry_count < currentTask.max_retries) {
              store.incrementRetryCount(task.id);
              logger.info(`Task ${task.id} failed (exit ${exitCode}), requeueing (retry ${currentTask.retry_count + 1}/${currentTask.max_retries})`);
              store.updateTaskStatus(task.id, "queued");
            } else {
              store.updateTaskStatus(task.id, "failed");
              store.createAlert("task_failed", `Task "${task.title}" failed: ${reason}`, task.id);
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
