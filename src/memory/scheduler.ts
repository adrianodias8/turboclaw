import { existsSync } from "fs";
import { join } from "path";
import { processInbox, pruneOrphans, findUnlinkedRelated, compileWeeklySummary, pruneExpiredMemories } from "./librarian";
import { logger } from "../logger";

export interface MemoryConfig {
  dailyRetentionDays: number;
  weeklyRetentionWeeks: number;
}

export interface LibrarianHandle {
  stop(): void;
  runNow(): void;
}

function getMondayOfPreviousWeek(): string {
  const now = new Date();
  const prev = new Date(now);
  prev.setDate(prev.getDate() - 7);
  const day = prev.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  prev.setDate(prev.getDate() + diff);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
}

/**
 * Runs the librarian periodically to maintain the memory vault.
 * Processes inbox, prunes orphans, compiles weekly summaries, and prunes expired memories.
 */
export function startLibrarian(
  vaultPath: string,
  memoryConfig: MemoryConfig = { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 },
  intervalMs: number = 300_000
): LibrarianHandle {
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

      // Compile previous week's summary if it doesn't exist
      const prevMonday = getMondayOfPreviousWeek();
      const weeklyPath = join(vaultPath, "weekly", `week-${prevMonday}.md`);
      if (!existsSync(weeklyPath)) {
        compileWeeklySummary(vaultPath);
      }

      // Prune expired memories
      pruneExpiredMemories(vaultPath, memoryConfig.dailyRetentionDays, memoryConfig.weeklyRetentionWeeks);
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
