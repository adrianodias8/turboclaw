import { join } from "path";
import { existsSync } from "fs";
import { listNotes, readNote, deleteNote, writeNote } from "./vault";
import { createPermanentNote } from "./writer";
import { findOrphans } from "./search";
import { weeklyTemplate } from "./templates";
import { newId } from "../ids";
import { logger } from "../logger";
import type { MemoryNote } from "./types";

export interface LibrarianReport {
  processed: number;
  promoted: number;
  orphansPruned: number;
}

/**
 * Process inbox: promote fleeting notes that have tags or links to permanent notes.
 * Simple heuristic: if a fleeting note has >= 1 tag and content > 50 chars, promote it.
 */
export function processInbox(vaultPath: string): LibrarianReport {
  const inboxNotes = listNotes(vaultPath, "inbox");
  let processed = 0;
  let promoted = 0;

  for (const note of inboxNotes) {
    processed++;

    const shouldPromote =
      note.frontmatter.tags.length > 0 &&
      note.content.length > 50;

    if (shouldPromote) {
      // Extract a title from the first line or first 60 chars
      const firstLine = note.content.split("\n")[0] ?? "";
      const title = firstLine.replace(/^#+\s*/, "").trim().slice(0, 60) || "Untitled Note";

      createPermanentNote(
        vaultPath,
        title,
        note.content,
        note.frontmatter.tags,
        note.frontmatter.source
      );

      deleteNote(note.path);
      promoted++;
      logger.info(`Promoted fleeting note to permanent: ${title}`);
    }
  }

  return { processed, promoted, orphansPruned: 0 };
}

/**
 * Find and prune orphan notes (no links in or out, not recent).
 * Only prunes notes older than minAgeSec.
 */
export function pruneOrphans(vaultPath: string, minAgeSec: number = 604800): number {
  const orphans = findOrphans(vaultPath);
  const now = Math.floor(Date.now() / 1000);
  let pruned = 0;

  for (const note of orphans) {
    const age = now - note.frontmatter.created;
    if (age > minAgeSec) {
      logger.info(`Pruning orphan note: ${note.frontmatter.title ?? note.path}`);
      deleteNote(note.path);
      pruned++;
    }
  }

  return pruned;
}

/**
 * Get Monday of the week containing the given date.
 */
function getMondayOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // adjust when day is Sunday
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Compile a weekly summary from task-log notes in the given week.
 * Default: previous week (Mon–Sun).
 */
export function compileWeeklySummary(vaultPath: string, weekStartDate?: Date): string | null {
  const now = new Date();
  const monday = weekStartDate ?? (() => {
    const prev = new Date(now);
    prev.setDate(prev.getDate() - 7);
    return getMondayOfWeek(prev);
  })();

  const weekStart = getMondayOfWeek(monday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const weekStartTs = Math.floor(weekStart.getTime() / 1000);
  const weekEndTs = Math.floor(weekEnd.getTime() / 1000);

  const taskNotes = listNotes(vaultPath, "tasks");
  const inRange = taskNotes.filter(
    (n) => n.frontmatter.created >= weekStartTs && n.frontmatter.created < weekEndTs
  );

  if (inRange.length === 0) return null;

  const entries = inRange.map((n) => ({
    title: n.frontmatter.title ?? "Untitled",
    summary: n.content.slice(0, 120).replace(/\n/g, " ").trim(),
  }));

  const weekStr = formatDateStr(weekStart);
  const filename = `week-${weekStr}.md`;
  const filePath = join(vaultPath, "weekly", filename);

  const id = newId();
  writeNote(filePath, weeklyTemplate(id, weekStr, entries, ["weekly-summary"]));

  logger.info(`Compiled weekly summary: ${filename} (${entries.length} tasks)`);
  return filePath;
}

/**
 * Prune expired daily task-logs and weekly summaries based on retention config.
 * Core notes are never auto-pruned.
 */
export function pruneExpiredMemories(
  vaultPath: string,
  dailyRetentionDays: number,
  weeklyRetentionWeeks: number
): { dailyPruned: number; weeklyPruned: number } {
  const now = Math.floor(Date.now() / 1000);
  let dailyPruned = 0;
  let weeklyPruned = 0;

  // Prune old task-log notes
  const dailyCutoff = now - dailyRetentionDays * 86400;
  const taskNotes = listNotes(vaultPath, "tasks");
  for (const note of taskNotes) {
    if (note.frontmatter.created < dailyCutoff) {
      deleteNote(note.path);
      dailyPruned++;
    }
  }

  // Prune old weekly summaries
  const weeklyCutoff = now - weeklyRetentionWeeks * 7 * 86400;
  const weeklyNotes = listNotes(vaultPath, "weekly");
  for (const note of weeklyNotes) {
    if (note.frontmatter.created < weeklyCutoff) {
      deleteNote(note.path);
      weeklyPruned++;
    }
  }

  if (dailyPruned > 0 || weeklyPruned > 0) {
    logger.info(`Pruned ${dailyPruned} daily notes, ${weeklyPruned} weekly notes`);
  }

  return { dailyPruned, weeklyPruned };
}

/**
 * Find notes that mention similar terms but aren't linked.
 * Returns pairs of notes that could be linked.
 */
export function findUnlinkedRelated(vaultPath: string): Array<[MemoryNote, MemoryNote]> {
  const notes = listNotes(vaultPath);
  const pairs: Array<[MemoryNote, MemoryNote]> = [];

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i]!;
      const b = notes[j]!;

      // Check if they share tags but aren't linked
      const sharedTags = a.frontmatter.tags.filter((t) => b.frontmatter.tags.includes(t));
      if (sharedTags.length === 0) continue;

      const aTitle = (a.frontmatter.title ?? "").toLowerCase();
      const bTitle = (b.frontmatter.title ?? "").toLowerCase();

      const aLinksToB = a.links.some((l) => l.toLowerCase() === bTitle);
      const bLinksToA = b.links.some((l) => l.toLowerCase() === aTitle);

      if (!aLinksToB && !bLinksToA) {
        pairs.push([a, b]);
      }
    }
  }

  return pairs;
}
