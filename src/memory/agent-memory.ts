import { join } from "path";
import { newId } from "../ids";
import { listNotes, writeNote, readNote, deleteNote } from "./vault";
import { agentMemoryTemplate } from "./templates";
import type { MemoryNote } from "./types";

const DEFAULT_MAX_CHARS = 4000;

export function listAgentMemories(vaultPath: string): MemoryNote[] {
  return listNotes(vaultPath, "agents").filter(
    (note) => note.frontmatter.type === "agent"
  );
}

export function addAgentMemory(
  vaultPath: string,
  title: string,
  content: string,
  source: string | null
): { ok: boolean; error?: string } {
  // Check for duplicate title (case-insensitive)
  const existing = listAgentMemories(vaultPath);
  const lowerTitle = title.toLowerCase();
  if (existing.some((n) => (n.frontmatter.title ?? "").toLowerCase() === lowerTitle)) {
    return { ok: false, error: `Memory with title "${title}" already exists` };
  }

  // Check budget
  const budget = getAgentMemoryBudget(vaultPath);
  if (budget.remaining < content.length) {
    return {
      ok: false,
      error: `Budget exceeded: need ${content.length} chars but only ${budget.remaining} remaining (${budget.used}/${budget.max} used)`,
    };
  }

  const id = newId();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${slug}.md`;
  const filePath = join(vaultPath, "agents", filename);
  writeNote(filePath, agentMemoryTemplate(id, title, content, ["agent-memory"], source));
  return { ok: true };
}

export function replaceAgentMemory(
  vaultPath: string,
  title: string,
  newContent: string
): { ok: boolean; error?: string } {
  const existing = listAgentMemories(vaultPath);
  const lowerTitle = title.toLowerCase();
  const match = existing.find(
    (n) => (n.frontmatter.title ?? "").toLowerCase() === lowerTitle
  );

  if (!match) {
    return { ok: false, error: `No memory found with title "${title}"` };
  }

  // Check budget: subtract old content, add new content
  const budget = getAgentMemoryBudget(vaultPath);
  const oldContentLength = match.content.length;
  const newBudgetUsed = budget.used - oldContentLength + newContent.length;
  if (newBudgetUsed > budget.max) {
    return {
      ok: false,
      error: `Budget exceeded: replacement would use ${newBudgetUsed}/${budget.max} chars`,
    };
  }

  // Rewrite the file with updated content, keeping existing frontmatter fields
  const note = readNote(match.path);
  if (!note) {
    return { ok: false, error: `Failed to read existing memory file` };
  }

  writeNote(
    match.path,
    agentMemoryTemplate(
      note.frontmatter.id,
      note.frontmatter.title ?? title,
      newContent,
      note.frontmatter.tags,
      note.frontmatter.source
    )
  );
  return { ok: true };
}

export function removeAgentMemory(
  vaultPath: string,
  title: string
): { ok: boolean; error?: string } {
  const existing = listAgentMemories(vaultPath);
  const lowerTitle = title.toLowerCase();
  const match = existing.find(
    (n) => (n.frontmatter.title ?? "").toLowerCase() === lowerTitle
  );

  if (!match) {
    return { ok: false, error: `No memory found with title "${title}"` };
  }

  deleteNote(match.path);
  return { ok: true };
}

export function getAgentMemoryBudget(
  vaultPath: string,
  maxChars: number = DEFAULT_MAX_CHARS
): { used: number; remaining: number; max: number } {
  const memories = listAgentMemories(vaultPath);
  const used = memories.reduce((sum, note) => sum + note.content.length, 0);
  return {
    used,
    remaining: Math.max(0, maxChars - used),
    max: maxChars,
  };
}
