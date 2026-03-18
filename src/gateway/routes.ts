import type { Store } from "../tracker/store";
import type { CreateTaskInput, CreatePipelineInput, CreateCronInput, TaskStatus } from "../tracker/types";
import type { GatewayOptions } from "./server";
import { logger } from "../logger";
import { listAgentMemories, addAgentMemory, replaceAgentMemory, removeAgentMemory, getAgentMemoryBudget } from "../memory/agent-memory";
import { createSkill, patchSkill, deleteSkill, listLocalSkills } from "../skills/manager";
import { guardSkillContent } from "../skills/guard";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function parseBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}


export function createRoutes(store: Store, opts?: GatewayOptions) {
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // Health
    if (method === "GET" && pathname === "/health") {
      return json({ ok: true });
    }

    // Restart
    if (method === "POST" && pathname === "/restart") {
      if (!opts?.requestRestart) {
        return error("Restart not available", 404);
      }

      // Token auth: if a token is configured, require it. Otherwise allow
      // unauthenticated restarts (e.g. from WhatsApp bridge or local curl).
      if (opts.restartToken) {
        const token = req.headers.get("X-Restart-Token");
        if (token && token !== opts.restartToken) {
          return error("Invalid restart token", 403);
        }
      }

      logger.info("Restart requested via API — initiating graceful shutdown");
      // Defer restart so we can return the response first
      setTimeout(() => opts.requestRestart!(), 100);
      return json({ ok: true, message: "Restarting..." });
    }

    // Status
    if (method === "GET" && pathname === "/status") {
      return json({
        queueDepth: store.getQueueDepth(),
        activeWorkers: store.getActiveWorkerCount(),
      });
    }

    // Pipelines
    if (method === "POST" && pathname === "/pipelines") {
      const body = await parseBody<CreatePipelineInput>(req);
      if (!body?.name || !Array.isArray(body.stages)) {
        return error("name and stages[] required");
      }
      const pipeline = store.createPipeline(body);
      return json(pipeline, 201);
    }

    if (method === "GET" && pathname === "/pipelines") {
      return json(store.listPipelines());
    }

    // Tasks
    if (method === "POST" && pathname === "/tasks") {
      const body = await parseBody<CreateTaskInput>(req);
      if (!body?.title) {
        return error("title is required");
      }
      const task = store.createTask(body);
      return json(task, 201);
    }

    if (method === "GET" && pathname === "/tasks") {
      const status = url.searchParams.get("status");
      const stage = url.searchParams.get("stage");
      const limit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");

      const tasks = store.listTasks({
        status: status as TaskStatus | undefined ?? undefined,
        stage: stage ?? undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        cursor: cursor ?? undefined,
      });
      return json(tasks);
    }

    // Task detail
    const taskMatch = pathname.match(/^\/tasks\/([^/]+)$/);
    if (method === "GET" && taskMatch?.[1]) {
      const task = store.getTask(taskMatch[1]);
      if (!task) return error("task not found", 404);
      const latestRun = store.getLatestRun(task.id);
      return json({ ...task, latestRun });
    }

    // Cancel task
    const cancelMatch = pathname.match(/^\/tasks\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch?.[1]) {
      const task = store.cancelTask(cancelMatch[1]);
      if (!task) return error("task not found", 404);
      return json(task);
    }

    // Run events (SSE)
    const eventsMatch = pathname.match(/^\/runs\/([^/]+)\/events$/);
    if (method === "GET" && eventsMatch?.[1]) {
      const runId = eventsMatch[1];
      const run = store.getRun(runId);
      if (!run) return error("run not found", 404);

      let lastId = 0;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          const events = store.listEvents(runId, lastId);
          for (const event of events) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            lastId = event.id;
          }

          // Check if run is finished
          const currentRun = store.getRun(runId);
          if (currentRun && currentRun.status !== "running") {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: "done", status: currentRun.status })}\n\n`));
            controller.close();
            return;
          }

          // Poll interval
          await new Promise((r) => setTimeout(r, 1000));
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Artifacts
    if (method === "GET" && pathname === "/artifacts") {
      const taskId = url.searchParams.get("taskId");
      const runId = url.searchParams.get("runId");
      const artifacts = store.listArtifacts({
        taskId: taskId ?? undefined,
        runId: runId ?? undefined,
      });
      return json(artifacts);
    }

    // Crons
    if (method === "GET" && pathname === "/crons") {
      return json(store.listCrons());
    }

    if (method === "POST" && pathname === "/crons") {
      const body = await parseBody<{ name?: string; schedule?: string; taskTemplate?: unknown; pipelineId?: string }>(req);
      if (!body?.name || !body.schedule || !body.taskTemplate) {
        return error("name, schedule, and taskTemplate are required");
      }
      const input: CreateCronInput = {
        name: body.name,
        schedule: body.schedule,
        taskTemplate: body.taskTemplate as CreateCronInput["taskTemplate"],
      };
      const cron = store.createCron(input);
      return json(cron, 201);
    }

    // Toggle cron enabled/disabled
    const cronToggleMatch = pathname.match(/^\/crons\/([^/]+)\/toggle$/);
    if (method === "POST" && cronToggleMatch?.[1]) {
      const cron = store.toggleCron(cronToggleMatch[1]);
      if (!cron) return error("cron not found", 404);
      return json(cron);
    }

    // Delete cron
    const cronDeleteMatch = pathname.match(/^\/crons\/([^/]+)$/);
    if (method === "DELETE" && cronDeleteMatch?.[1]) {
      const existing = store.getCron(cronDeleteMatch[1]);
      if (!existing) return error("cron not found", 404);
      store.deleteCron(cronDeleteMatch[1]);
      return json({ ok: true });
    }

    // Alerts
    if (method === "GET" && pathname === "/alerts") {
      const ack = url.searchParams.get("acknowledged");
      const alerts = store.listAlerts({
        acknowledged: ack === "false" ? false : undefined,
      });
      return json(alerts);
    }

    // Acknowledge alert
    const alertAckMatch = pathname.match(/^\/alerts\/(\d+)\/acknowledge$/);
    if (method === "POST" && alertAckMatch?.[1]) {
      const alertId = parseInt(alertAckMatch[1], 10);
      store.acknowledgeAlert(alertId);
      return json({ ok: true });
    }

    // Experiments (autoresearch)
    if (method === "GET" && pathname === "/experiments/sessions") {
      return json(store.listExperimentSessions());
    }

    const experimentsMatch = pathname.match(/^\/experiments\/([^/]+)$/);
    if (method === "GET" && experimentsMatch?.[1]) {
      return json(store.listExperiments(experimentsMatch[1]));
    }

    // Agent Memory
    if (pathname === "/memory" && opts?.vaultPath) {
      const vaultPath = opts.vaultPath;

      if (method === "GET") {
        const memories = listAgentMemories(vaultPath);
        const budget = getAgentMemoryBudget(vaultPath);
        return json({
          memories: memories.map((m) => ({
            title: m.frontmatter.title ?? "Untitled",
            content: m.content,
            source: m.frontmatter.source,
            created: m.frontmatter.created,
          })),
          budget,
        });
      }

      if (method === "POST") {
        const body = await parseBody<{
          action?: string;
          title?: string;
          content?: string;
          source?: string;
        }>(req);
        if (!body?.action || !body.title) {
          return error("action and title are required");
        }

        if (body.action === "add") {
          if (!body.content) {
            return error("content is required for add action");
          }
          const result = addAgentMemory(vaultPath, body.title, body.content, body.source ?? null);
          return result.ok ? json(result, 201) : error(result.error!, 400);
        }

        if (body.action === "replace") {
          if (!body.content) {
            return error("content is required for replace action");
          }
          const result = replaceAgentMemory(vaultPath, body.title, body.content);
          return result.ok ? json(result) : error(result.error!, 404);
        }

        if (body.action === "remove") {
          const result = removeAgentMemory(vaultPath, body.title);
          return result.ok ? json(result) : error(result.error!, 404);
        }

        return error(`Unknown action: ${body.action}`);
      }
    }

    // Skills management
    if (pathname === "/skills" && opts?.skillsDir) {
      const skillsDir = opts.skillsDir;

      if (method === "GET") {
        const skills = listLocalSkills(skillsDir);
        return json(skills);
      }

      if (method === "POST") {
        const body = await parseBody<{ name?: string; content?: string; category?: string }>(req);
        if (!body?.name || !body.content) {
          return error("name and content are required");
        }

        const guard = guardSkillContent(body.content);
        if (!guard.allowed) {
          return error(`Skill content rejected: ${guard.threats.join("; ")}`, 403);
        }

        const result = createSkill(skillsDir, body.name, guard.sanitized ?? body.content, body.category);
        return result.ok ? json({ ok: true, path: result.path }, 201) : error(result.error!, 400);
      }
    }

    const skillMatch = pathname.match(/^\/skills\/([^/]+)$/);
    if (skillMatch?.[1] && opts?.skillsDir) {
      const skillsDir = opts.skillsDir;
      const skillName = skillMatch[1];

      if (method === "PATCH") {
        const body = await parseBody<{ oldText?: string; newText?: string }>(req);
        if (!body?.oldText || body.newText === undefined) {
          return error("oldText and newText are required");
        }

        const guard = guardSkillContent(body.newText);
        if (!guard.allowed) {
          return error(`Patch content rejected: ${guard.threats.join("; ")}`, 403);
        }

        const result = patchSkill(skillsDir, skillName, body.oldText, guard.sanitized ?? body.newText);
        return result.ok ? json({ ok: true, path: result.path }) : error(result.error!, 400);
      }

      if (method === "DELETE") {
        const result = deleteSkill(skillsDir, skillName);
        return result.ok ? json({ ok: true }) : error(result.error!, 404);
      }
    }

    return error("not found", 404);
  };
}
