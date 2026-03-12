import type { Store } from "../tracker/store";
import type { CreateTaskInput, CreatePipelineInput } from "../tracker/types";

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

export function createRoutes(store: Store) {
  return async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // Health
    if (method === "GET" && pathname === "/health") {
      return json({ ok: true });
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
      const status = url.searchParams.get("status") as CreateTaskInput["agentRole"] | null;
      const stage = url.searchParams.get("stage");
      const limit = url.searchParams.get("limit");
      const cursor = url.searchParams.get("cursor");

      const tasks = store.listTasks({
        status: status as any,
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

    return error("not found", 404);
  };
}
