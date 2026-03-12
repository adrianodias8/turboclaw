import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { createRoutes } from "../src/gateway/routes";

let db: Database;
let store: Store;
let handle: (req: Request) => Promise<Response>;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
  handle = createRoutes(store);
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const opts: RequestInit = { method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await handle(new Request(`http://localhost${path}`, opts));
  const data = await res.json();
  return { status: res.status, data };
}

describe("health", () => {
  it("returns ok", async () => {
    const { status, data } = await req("GET", "/health");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });
});

describe("status", () => {
  it("returns queue depth and workers", async () => {
    const { data } = await req("GET", "/status");
    expect(data.queueDepth).toBe(0);
    expect(data.activeWorkers).toBe(0);
  });
});

describe("pipelines", () => {
  it("creates and lists pipelines", async () => {
    const { status, data } = await req("POST", "/pipelines", {
      name: "deploy",
      stages: ["build", "test", "deploy"],
    });
    expect(status).toBe(201);
    expect(data.name).toBe("deploy");

    const list = await req("GET", "/pipelines");
    expect(list.data).toHaveLength(1);
  });

  it("rejects invalid pipeline", async () => {
    const { status } = await req("POST", "/pipelines", { name: "x" });
    expect(status).toBe(400);
  });
});

describe("tasks", () => {
  it("creates and lists tasks", async () => {
    const { status, data } = await req("POST", "/tasks", {
      title: "Fix bug",
      description: "Login page broken",
      agentRole: "coder",
      priority: 5,
    });
    expect(status).toBe(201);
    expect(data.title).toBe("Fix bug");

    const list = await req("GET", "/tasks");
    expect(list.data).toHaveLength(1);
  });

  it("gets task detail with latest run", async () => {
    const { data: task } = await req("POST", "/tasks", { title: "test" });
    const detail = await req("GET", `/tasks/${task.id}`);
    expect(detail.data.id).toBe(task.id);
    expect(detail.data.latestRun).toBeNull();
  });

  it("returns 404 for missing task", async () => {
    const { status } = await req("GET", "/tasks/nonexistent");
    expect(status).toBe(404);
  });

  it("cancels a task", async () => {
    const { data: task } = await req("POST", "/tasks", { title: "test" });
    const { data } = await req("POST", `/tasks/${task.id}/cancel`);
    expect(data.status).toBe("cancelled");
  });

  it("rejects task without title", async () => {
    const { status } = await req("POST", "/tasks", {});
    expect(status).toBe(400);
  });

  it("filters tasks by status", async () => {
    await req("POST", "/tasks", { title: "a" });
    const { data: task2 } = await req("POST", "/tasks", { title: "b" });
    store.updateTaskStatus(task2.id, "queued");

    const pending = await req("GET", "/tasks?status=pending");
    expect(pending.data).toHaveLength(1);
    expect(pending.data[0].title).toBe("a");
  });
});

describe("artifacts", () => {
  it("lists artifacts", async () => {
    const { data } = await req("GET", "/artifacts");
    expect(data).toEqual([]);
  });
});

describe("SSE events", () => {
  it("streams events as SSE with proper encoding", async () => {
    const task = store.createTask({ title: "sse-test" });
    const run = store.createRun(task.id);
    store.addEvent(run.id, "stdout", "hello world");
    store.finishRun(run.id, "done", 0);

    const res = await handle(new Request(`http://localhost/runs/${run.id}/events`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Read the stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toContain("hello world");
    expect(text).toContain('"kind":"done"');
  });

  it("returns 404 for missing run", async () => {
    const res = await handle(new Request("http://localhost/runs/nonexistent/events"));
    expect(res.status).toBe(404);
  });
});

describe("404", () => {
  it("returns not found for unknown routes", async () => {
    const { status } = await req("GET", "/unknown");
    expect(status).toBe(404);
  });
});
