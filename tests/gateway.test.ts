import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { createRoutes } from "../src/gateway/routes";
import { createRateLimiter } from "../src/gateway/rate-limit";

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

describe("crons", () => {
  it("creates and lists crons", async () => {
    const { status, data } = await req("POST", "/crons", {
      name: "nightly-backup",
      schedule: "0 2 * * *",
      taskTemplate: { title: "Run backup", agentRole: "coder" },
    });
    expect(status).toBe(201);
    expect(data.name).toBe("nightly-backup");
    expect(data.schedule).toBe("0 2 * * *");

    const list = await req("GET", "/crons");
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe("nightly-backup");
  });

  it("rejects cron without required fields", async () => {
    const { status } = await req("POST", "/crons", { name: "bad" });
    expect(status).toBe(400);
  });

  it("toggles cron enabled/disabled", async () => {
    const { data: cron } = await req("POST", "/crons", {
      name: "test-cron",
      schedule: "*/5 * * * *",
      taskTemplate: { title: "Test" },
    });
    expect(cron.enabled).toBe(1);

    const { data: toggled } = await req("POST", `/crons/${cron.id}/toggle`);
    expect(toggled.enabled).toBe(0);

    const { data: toggledBack } = await req("POST", `/crons/${toggled.id}/toggle`);
    expect(toggledBack.enabled).toBe(1);
  });

  it("returns 404 for toggling nonexistent cron", async () => {
    const { status } = await req("POST", "/crons/nonexistent/toggle");
    expect(status).toBe(404);
  });

  it("deletes a cron", async () => {
    const { data: cron } = await req("POST", "/crons", {
      name: "to-delete",
      schedule: "0 0 * * *",
      taskTemplate: { title: "Delete me" },
    });

    const res = await req("DELETE", `/crons/${cron.id}`);
    expect(res.data.ok).toBe(true);

    const list = await req("GET", "/crons");
    expect(list.data).toHaveLength(0);
  });

  it("returns 404 for deleting nonexistent cron", async () => {
    const { status } = await req("DELETE", "/crons/nonexistent");
    expect(status).toBe(404);
  });
});

describe("alerts", () => {
  it("lists alerts", async () => {
    const { data } = await req("GET", "/alerts");
    expect(data).toEqual([]);
  });

  it("lists unacknowledged alerts only", async () => {
    store.createAlert("task_failed", "Task X failed", null);
    store.createAlert("lease_expired", "Lease Y expired", null);

    const all = await req("GET", "/alerts");
    expect(all.data).toHaveLength(2);

    // Acknowledge one
    store.acknowledgeAlert(all.data[1].id);

    const unack = await req("GET", "/alerts?acknowledged=false");
    expect(unack.data).toHaveLength(1);
    expect(unack.data[0].message).toBe("Task X failed");
  });

  it("acknowledges an alert via API", async () => {
    store.createAlert("task_failed", "Something broke", null);
    const { data: alerts } = await req("GET", "/alerts");
    expect(alerts).toHaveLength(1);

    const ackRes = await req("POST", `/alerts/${alerts[0].id}/acknowledge`);
    expect(ackRes.data.ok).toBe(true);

    const unack = await req("GET", "/alerts?acknowledged=false");
    expect(unack.data).toHaveLength(0);
  });
});

describe("404", () => {
  it("returns not found for unknown routes", async () => {
    const { status } = await req("GET", "/unknown");
    expect(status).toBe(404);
  });
});

describe("error boundary", () => {
  it("route handler propagates errors (caught by server.ts boundary)", async () => {
    const throwingHandle = createRoutes(
      new Proxy(store, {
        get(target, prop) {
          if (prop === "getQueueDepth") {
            return () => { throw new Error("secret DB corruption details"); };
          }
          return (target as unknown as Record<string, unknown>)[prop];
        },
      })
    );

    let threw = false;
    try {
      await throwingHandle(new Request("http://localhost/status"));
    } catch (err: unknown) {
      threw = true;
      expect((err as Error).message).toBe("secret DB corruption details");
    }
    expect(threw).toBe(true);
  });
});

describe("rate limiting", () => {
  it("allows requests within the limit", () => {
    const limiter = createRateLimiter(5, 60000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("1.2.3.4")).toBe(true);
    }
  });

  it("blocks requests exceeding the limit", () => {
    const limiter = createRateLimiter(3, 60000);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(true);
    expect(limiter.check("1.2.3.4")).toBe(false);
  });

  it("tracks IPs independently", () => {
    const limiter = createRateLimiter(1, 60000);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("2.2.2.2")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    expect(limiter.check("2.2.2.2")).toBe(false);
  });

  it("cleans up expired buckets", () => {
    const limiter = createRateLimiter(1, 1); // 1ms window
    limiter.check("1.2.3.4");
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    limiter.cleanup();
    expect(limiter.check("1.2.3.4")).toBe(true);
  });
});

describe("skill path traversal", () => {
  it("rejects path traversal in PATCH /skills/:name", async () => {
    const handleWithSkills = createRoutes(store, { skillsDir: "/tmp/test-skills" });
    const res = await handleWithSkills(new Request("http://localhost/skills/..%2F..%2Fetc", {
      method: "PATCH",
      body: JSON.stringify({ oldText: "a", newText: "b" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid skill name");
  });

  it("rejects path traversal in DELETE /skills/:name", async () => {
    const handleWithSkills = createRoutes(store, { skillsDir: "/tmp/test-skills" });
    const res = await handleWithSkills(new Request("http://localhost/skills/..%2F..%2Fetc", { method: "DELETE" }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid skill name");
  });

  it("rejects uppercase/special chars in skill names", async () => {
    const handleWithSkills = createRoutes(store, { skillsDir: "/tmp/test-skills" });
    const res = await handleWithSkills(new Request("http://localhost/skills/BADNAME!", {
      method: "PATCH",
      body: JSON.stringify({ oldText: "a", newText: "b" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Invalid skill name");
  });
});

describe("checkpoint hash validation", () => {
  it("rejects malicious hash in POST /checkpoints/restore", async () => {
    const handleWithCheckpoints = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/tmp/test" });
    const res = await handleWithCheckpoints(new Request("http://localhost/checkpoints/restore", {
      method: "POST",
      body: JSON.stringify({ workspace: "/tmp/test", hash: "; rm -rf /" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid hash format");
  });

  it("rejects malicious hash in GET /checkpoints/diff", async () => {
    const handleWithCheckpoints = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/tmp/test" });
    const res = await handleWithCheckpoints(new Request("http://localhost/checkpoints/diff?workspace=/tmp/test&hash=;rm+-rf+/"));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid hash format");
  });

  it("accepts valid short hash (passes hash validation, may fail for other reasons)", async () => {
    const handleWithCheckpoints = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/tmp" });
    const res = await handleWithCheckpoints(new Request("http://localhost/checkpoints/restore", {
      method: "POST",
      body: JSON.stringify({ workspace: "/tmp/test", hash: "abc1234" }),
      headers: { "Content-Type": "application/json" },
    }));
    const data = await res.json();
    // Hash is valid format — error should NOT be "invalid hash format"
    expect(data.error).not.toBe("invalid hash format");
  });
});

describe("workspace escape", () => {
  it("rejects workspace outside allowed root in GET /checkpoints", async () => {
    const handleWithRoot = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/home/user/projects" });
    const res = await handleWithRoot(new Request("http://localhost/checkpoints?workspace=../../etc"));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("workspace outside allowed root");
  });

  it("rejects workspace outside allowed root in POST /checkpoints/restore", async () => {
    const handleWithRoot = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/home/user/projects" });
    const res = await handleWithRoot(new Request("http://localhost/checkpoints/restore", {
      method: "POST",
      body: JSON.stringify({ workspace: "/etc/passwd", hash: "abc1234" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe("workspace outside allowed root");
  });

  it("allows workspace within allowed root", async () => {
    const handleWithRoot = createRoutes(store, { checkpointsBase: "/tmp/cp", workspaceRoot: "/home/user/projects" });
    const res = await handleWithRoot(new Request("http://localhost/checkpoints?workspace=/home/user/projects/myapp"));
    expect(res.status).toBe(200);
  });
});
