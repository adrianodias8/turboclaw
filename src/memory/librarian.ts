import { join } from "path";
import { listNotes, readNote, deleteNote } from "./vault";
import { createPermanentNote } from "./writer";
import { findOrphans } from "./search";
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
