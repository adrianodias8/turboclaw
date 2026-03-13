import { logger } from "../logger";
import type { Store } from "../tracker/store";

export interface NotifierHandle {
  stop(): void;
}

export function startNotifier(
  store: Store,
  sendMessage: (text: string, jid?: string) => Promise<void>,
  opts: {
    notifyOnComplete: boolean;
    notifyOnFail: boolean;
    getTaskJid?: (taskId: string) => string | undefined;
  }
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
            const jid = opts.getTaskJid?.(t.id) ?? t.reply_jid ?? undefined;
            // Get error output if available
            const lastRun = store.getLatestRun(t.id);
            let errOutput = "";
            if (lastRun) {
              const events = store.listEvents(lastRun.id);
              const stderrEvents = events.filter((e) => e.kind === "stderr");
              errOutput = stderrEvents.map((e) => e.payload).join("\n").trim();
            }
            const msg = errOutput
              ? `Sorry, that failed:\n${errOutput.slice(0, 1000)}`
              : `Sorry, that failed. (${t.id.slice(0, 8)})`;
            await sendMessage(msg, jid);
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
            // Check both in-memory map and task's reply_jid (for cron-created tasks)
            const jid = opts.getTaskJid?.(t.id) ?? t.reply_jid ?? undefined;
            // Get the agent output
            const lastRun = store.getLatestRun(t.id);
            let output = "";
            if (lastRun) {
              const events = store.listEvents(lastRun.id);
              const stdoutEvents = events.filter((e) => e.kind === "stdout");
              output = stdoutEvents.map((e) => e.payload).join("\n").trim();
            }
            // Send just the output for a natural conversational feel
            const msg = output || `Done. (${t.id.slice(0, 8)})`;
            await sendMessage(msg.slice(0, 4000), jid);
          } catch (err) {
            logger.warn("WhatsApp notify failed:", err);
          }
        }
      }
    }

    lastCheckedAt = now;
  }

  const interval = setInterval(check, 3000);

  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
  };
}
