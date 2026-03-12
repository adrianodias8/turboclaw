import type { MemoryNote, SearchResult } from "./types";
import { listNotes } from "./vault";

export function searchByFullText(vaultPath: string, query: string): SearchResult[] {
  const notes = listNotes(vaultPath);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const note of notes) {
    const text = `${note.frontmatter.title ?? ""} ${note.content}`.toLowerCase();
    let matchCount = 0;
    for (const term of terms) {
      if (text.includes(term)) matchCount++;
    }
    if (matchCount > 0) {
      results.push({
        note,
        score: matchCount / terms.length,
        matchedOn: "fulltext",
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

export function searchByTag(vaultPath: string, tag: string): SearchResult[] {
  const notes = listNotes(vaultPath);
  const results: SearchResult[] = [];

  for (const note of notes) {
    if (note.frontmatter.tags.includes(tag)) {
      results.push({ note, score: 1, matchedOn: "tag" });
    }
  }

  return results;
}

export function searchByLink(vaultPath: string, targetTitle: string): SearchResult[] {
  const notes = listNotes(vaultPath);
  const results: SearchResult[] = [];
  const lower = targetTitle.toLowerCase();

  for (const note of notes) {
    for (const link of note.links) {
      if (link.toLowerCase() === lower) {
        results.push({ note, score: 1, matchedOn: "link" });
        break;
      }
    }
  }

  return results;
}

export function findOrphans(vaultPath: string): MemoryNote[] {
  const notes = listNotes(vaultPath);
  const allLinkedTitles = new Set<string>();

  for (const note of notes) {
    for (const link of note.links) {
      allLinkedTitles.add(link.toLowerCase());
    }
  }

  return notes.filter((n) => {
    const title = (n.frontmatter.title ?? "").toLowerCase();
    if (!title) return false;
    // Orphan = not linked by any other note and has no outgoing links
    return !allLinkedTitles.has(title) && n.links.length === 0;
  });
}

export function buildLinkGraph(vaultPath: string): Map<string, Set<string>> {
  const notes = listNotes(vaultPath);
  const graph = new Map<string, Set<string>>();

  for (const note of notes) {
    const title = note.frontmatter.title ?? note.path;
    if (!graph.has(title)) graph.set(title, new Set());
    for (const link of note.links) {
      graph.get(title)!.add(link);
    }
  }

  return graph;
}
