import { processInbox, pruneOrphans, findUnlinkedRelated } from "./librarian";
import { logger } from "../logger";

export interface LibrarianHandle {
  stop(): void;
  runNow(): void;
}

/**
 * Runs the librarian periodically to maintain the memory vault.
 * Processes inbox, prunes orphans, and logs unlinked related notes.
 */
export function startLibrarian(vaultPath: string, intervalMs: number = 300_000): LibrarianHandle {
  let running = true;

  function run() {
    if (!running) return;

    try {
      const report = processInbox(vaultPath);
      if (report.promoted > 0) {
        logger.info(`Librarian: promoted ${report.promoted}/${report.processed} inbox notes`);
      }

      const pruned = pruneOrphans(vaultPath);
      if (pruned > 0) {
        logger.info(`Librarian: pruned ${pruned} orphan notes`);
      }

      const unlinked = findUnlinkedRelated(vaultPath);
      if (unlinked.length > 0) {
        logger.info(`Librarian: found ${unlinked.length} potentially related unlinked note pairs`);
      }
    } catch (err) {
      logger.error("Librarian error:", err);
    }
  }

  const interval = setInterval(run, intervalMs);
  // Run once at startup
  run();

  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
    runNow: run,
  };
}
