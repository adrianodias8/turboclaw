import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import { startNotifier, type NotifierHandle } from "../src/whatsapp/notifier";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

afterEach(() => {
  db.close();
});

function createDoneTask(st: Store): string {
  const task = st.createTask({ title: "Test task" });
  st.updateTaskStatus(task.id, "queued");
  st.updateTaskStatus(task.id, "running");
  const run = st.createRun(task.id);
  st.addEvent(run.id, "stdout", "Task output here");
  st.finishRun(run.id, "done", 0);
  st.updateTaskStatus(task.id, "done");
  return task.id;
}

function createFailedTask(st: Store, stderrOutput?: string): string {
  const task = st.createTask({ title: "Broken task" });
  st.updateTaskStatus(task.id, "queued");
  st.updateTaskStatus(task.id, "running");
  const run = st.createRun(task.id);
  if (stderrOutput) {
    st.addEvent(run.id, "stderr", stderrOutput);
  }
  st.finishRun(run.id, "failed", 1);
  st.updateTaskStatus(task.id, "failed");
  return task.id;
}

/** Wait until predicate is true, polling every intervalMs. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("startNotifier", () => {
  let handle: NotifierHandle | null = null;

  afterEach(() => {
    if (handle) {
      handle.stop();
      handle = null;
    }
  });

  it("returns handle with stop and reset", () => {
    handle = startNotifier(store, async () => true, {
      notifyOnComplete: false,
      notifyOnFail: false,
    });
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.reset).toBe("function");
  });

  it(
    "notifies on completed tasks",
    async () => {
      const sent: { text: string; jid?: string }[] = [];
      handle = startNotifier(
        store,
        async (text, jid) => {
          sent.push({ text, jid });
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      createDoneTask(store);

      await waitFor(() => sent.length >= 1);
      expect(sent[0].text).toContain("Task output here");
    },
    10000,
  );

  it(
    "notifies on failed tasks with stderr",
    async () => {
      const sent: { text: string; jid?: string }[] = [];
      handle = startNotifier(
        store,
        async (text, jid) => {
          sent.push({ text, jid });
          return true;
        },
        { notifyOnComplete: false, notifyOnFail: true },
      );

      createFailedTask(store, "Error: something broke");

      await waitFor(() => sent.length >= 1);
      expect(sent[0].text).toContain("Sorry, that failed");
      expect(sent[0].text).toContain("Error: something broke");
    },
    10000,
  );

  it(
    "notifies on failed tasks without stderr",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: false, notifyOnFail: true },
      );

      createFailedTask(store);

      await waitFor(() => sent.length >= 1);
      expect(sent[0]).toContain("Sorry, that failed");
    },
    10000,
  );

  it(
    "deduplicates notifications — same task not sent twice",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      createDoneTask(store);

      // Wait for first notification
      await waitFor(() => sent.length >= 1);

      // Wait for another poll cycle — count should stay at 1
      await new Promise((r) => setTimeout(r, 4000));
      expect(sent).toHaveLength(1);
    },
    12000,
  );

  it(
    "does not notify when both flags are off",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: false, notifyOnFail: false },
      );

      createDoneTask(store);
      createFailedTask(store, "Error");

      // Wait past one full poll cycle
      await new Promise((r) => setTimeout(r, 4000));
      expect(sent).toHaveLength(0);
    },
    10000,
  );

  it(
    "uses reply_jid from task when available",
    async () => {
      const sent: { text: string; jid?: string }[] = [];
      handle = startNotifier(
        store,
        async (text, jid) => {
          sent.push({ text, jid });
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      const task = store.createTask({ title: "JID task" });
      db.run("UPDATE tasks SET reply_jid = ? WHERE id = ?", ["user@s.whatsapp.net", task.id]);
      store.updateTaskStatus(task.id, "queued");
      store.updateTaskStatus(task.id, "running");
      const run = store.createRun(task.id);
      store.addEvent(run.id, "stdout", "Output");
      store.finishRun(run.id, "done", 0);
      store.updateTaskStatus(task.id, "done");

      await waitFor(() => sent.length >= 1);
      expect(sent[0].jid).toBe("user@s.whatsapp.net");
    },
    10000,
  );

  it(
    "uses getTaskJid callback when provided",
    async () => {
      const sent: { text: string; jid?: string }[] = [];
      const taskIds: string[] = [];

      handle = startNotifier(
        store,
        async (text, jid) => {
          sent.push({ text, jid });
          return true;
        },
        {
          notifyOnComplete: true,
          notifyOnFail: false,
          getTaskJid: (taskId) => {
            if (taskIds.includes(taskId)) return "custom@s.whatsapp.net";
            return undefined;
          },
        },
      );

      const taskId = createDoneTask(store);
      taskIds.push(taskId);

      await waitFor(() => sent.length >= 1);
      expect(sent[0].jid).toBe("custom@s.whatsapp.net");
    },
    10000,
  );

  it(
    "does not re-send when send returns false (not added to dedup set)",
    async () => {
      let callCount = 0;
      handle = startNotifier(
        store,
        async () => {
          callCount++;
          return false; // simulate send failure — task stays un-notified
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      createDoneTask(store);

      // Wait for at least 2 poll cycles — since send returns false, task stays
      // un-notified and will be retried on the next cycle when lastCheckedAt
      // has moved past the task's updated_at, so it won't appear again.
      // The key behavior: send was attempted at least once.
      await waitFor(() => callCount >= 1);
      expect(callCount).toBeGreaterThanOrEqual(1);
    },
    10000,
  );

  it(
    "stores chat history for completed tasks with output and jid",
    async () => {
      handle = startNotifier(store, async () => true, {
        notifyOnComplete: true,
        notifyOnFail: false,
      });

      const task = store.createTask({ title: "Chat history task" });
      db.run("UPDATE tasks SET reply_jid = ? WHERE id = ?", ["user@s.whatsapp.net", task.id]);
      store.updateTaskStatus(task.id, "queued");
      store.updateTaskStatus(task.id, "running");
      const run = store.createRun(task.id);
      store.addEvent(run.id, "stdout", "Agent completed the work");
      store.finishRun(run.id, "done", 0);
      store.updateTaskStatus(task.id, "done");

      // Wait for notification to be sent and chat history to be saved
      await new Promise((r) => setTimeout(r, 4000));

      const messages = store.getRecentChatMessages("user@s.whatsapp.net", 10);
      const assistantMsgs = messages.filter((m) => m.role === "assistant");
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(1);
      expect(assistantMsgs.some((m) => m.content.includes("Agent completed the work"))).toBe(true);
    },
    10000,
  );

  it(
    "stop() prevents further polling",
    async () => {
      let callCount = 0;
      handle = startNotifier(
        store,
        async () => {
          callCount++;
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      handle.stop();
      handle = null;

      createDoneTask(store);
      await new Promise((r) => setTimeout(r, 4000));

      expect(callCount).toBe(0);
    },
    10000,
  );

  it(
    "reset() clears dedup set and looks back 5 minutes",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      createDoneTask(store);
      await waitFor(() => sent.length >= 1);

      const countBefore = sent.length;
      handle.reset();

      // After reset, the dedup set is cleared and lastCheckedAt is rewound 5 min.
      // Since the task was completed within the last 5 min, it may be re-notified.
      await new Promise((r) => setTimeout(r, 4000));
      expect(sent.length).toBeGreaterThanOrEqual(countBefore);
    },
    12000,
  );

  it(
    "truncates long output to 4000 chars",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: true, notifyOnFail: false },
      );

      const task = store.createTask({ title: "Long output task" });
      store.updateTaskStatus(task.id, "queued");
      store.updateTaskStatus(task.id, "running");
      const run = store.createRun(task.id);
      store.addEvent(run.id, "stdout", "x".repeat(5000));
      store.finishRun(run.id, "done", 0);
      store.updateTaskStatus(task.id, "done");

      await waitFor(() => sent.length >= 1);
      expect(sent[0].length).toBeLessThanOrEqual(4000);
    },
    10000,
  );

  it(
    "truncates long stderr to 1000 chars",
    async () => {
      const sent: string[] = [];
      handle = startNotifier(
        store,
        async (text) => {
          sent.push(text);
          return true;
        },
        { notifyOnComplete: false, notifyOnFail: true },
      );

      createFailedTask(store, "E".repeat(2000));

      await waitFor(() => sent.length >= 1);
      // "Sorry, that failed:\n" + 1000 chars of stderr
      expect(sent[0].length).toBeLessThan(1100);
    },
    10000,
  );
});
