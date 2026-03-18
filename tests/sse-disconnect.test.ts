/**
 * Tests for SSE stream cleanup on client disconnect.
 * Ensures the poll loop stops when the client cancels the stream.
 */
import { describe, it, expect, beforeEach } from "bun:test";
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

describe("SSE stream disconnect handling", () => {
  it("stream closes when run finishes", async () => {
    const task = store.createTask({ title: "sse-close-test" });
    const run = store.createRun(task.id);
    store.addEvent(run.id, "stdout", "working...");
    store.finishRun(run.id, "done", 0);

    const res = await handle(new Request(`http://localhost/runs/${run.id}/events`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    // Read the full stream — it should close since the run is already done
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }

    expect(text).toContain("working...");
    expect(text).toContain('"kind":"done"');
  });

  it("stream can be cancelled by reader", async () => {
    const task = store.createTask({ title: "sse-cancel-test" });
    const run = store.createRun(task.id);
    // Don't finish the run — it stays "running"
    store.addEvent(run.id, "stdout", "line 1");

    const res = await handle(new Request(`http://localhost/runs/${run.id}/events`));
    const reader = res.body!.getReader();

    // Read one chunk
    const { done, value } = await reader.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toContain("line 1");

    // Cancel the stream (simulates client disconnect)
    await reader.cancel();

    // The stream should now be cancelled — no infinite polling
    // This test passes if it doesn't hang indefinitely
  });

  it("returns 404 for missing run", async () => {
    const res = await handle(
      new Request("http://localhost/runs/nonexistent-id/events")
    );
    expect(res.status).toBe(404);
  });
});
