import { searchByFullText, searchByTag } from "./search";
import { listNotes } from "./vault";
import type { SearchResult } from "./types";

export function buildCoreContext(vaultPath: string): string {
  const coreNotes = listNotes(vaultPath, "core");
  if (coreNotes.length === 0) return "";

  const sections = coreNotes.map((note) => {
    const title = note.frontmatter.title ?? "Untitled";
    return `## ${title}\n\n${note.content}`;
  });

  return `# Core Memory\n\n${sections.join("\n\n")}`;
}

export function buildContext(
  vaultPath: string,
  query: string,
  tags: string[] = [],
  maxNotes: number = 5
): string {
  const results: SearchResult[] = [];

  // Search by full text
  if (query) {
    results.push(...searchByFullText(vaultPath, query));
  }

  // Search by tags
  for (const tag of tags) {
    results.push(...searchByTag(vaultPath, tag));
  }

  // Deduplicate by note path
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    if (!seen.has(r.note.path)) {
      seen.add(r.note.path);
      unique.push(r);
    }
  }

  // Sort by score and take top N
  unique.sort((a, b) => b.score - a.score);
  const top = unique.slice(0, maxNotes);

  if (top.length === 0) return "";

  const sections = top.map((r) => {
    const title = r.note.frontmatter.title ?? "Untitled";
    const tags = r.note.frontmatter.tags.length > 0
      ? ` [${r.note.frontmatter.tags.join(", ")}]`
      : "";
    return `## ${title}${tags}\n\n${r.note.content}`;
  });

  return `# Relevant Memory Notes\n\n${sections.join("\n\n---\n\n")}`;
}
