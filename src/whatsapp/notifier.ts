import { logger } from "../logger";
import type { Store } from "../tracker/store";

export interface NotifierHandle {
  stop(): void;
}

export function startNotifier(
  store: Store,
  sendMessage: (text: string) => Promise<void>,
  opts: { notifyOnComplete: boolean; notifyOnFail: boolean }
): NotifierHandle {
  let lastCheckedAt = Math.floor(Date.now() / 1000);
  let running = true;

  async function check() {
    if (!running) return;

    const now = Math.floor(Date.now() / 1000);

    if (opts.notifyOnFail) {
      const failed = store.getFailedTasks(10);
      for (const t of failed) {
        if (t.updated_at > lastCheckedAt) {
          try {
            await sendMessage(`Task failed: ${t.title} (${t.id.slice(0, 8)})`);
          } catch (err) {
            logger.warn("WhatsApp notify failed:", err);
          }
        }
      }
    }

    if (opts.notifyOnComplete) {
      const done = store.listTasks({ status: "done", limit: 10 });
      for (const t of done) {
        if (t.updated_at > lastCheckedAt) {
          try {
            // Get the last stdout event from the run to include agent output
            const lastRun = store.getLatestRun(t.id);
            let output = "";
            if (lastRun) {
              const events = store.listEvents(lastRun.id);
              const stdoutEvents = events.filter((e) => e.kind === "stdout");
              output = stdoutEvents.map((e) => e.payload).join("\n").trim();
            }
            const msg = output
              ? `Task completed: ${t.title} (${t.id.slice(0, 8)})\n\n${output.slice(0, 2000)}`
              : `Task completed: ${t.title} (${t.id.slice(0, 8)})`;
            await sendMessage(msg);
          } catch (err) {
            logger.warn("WhatsApp notify failed:", err);
          }
        }
      }
    }

    lastCheckedAt = now;
  }

  const interval = setInterval(check, 5000);

  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
  };
}
