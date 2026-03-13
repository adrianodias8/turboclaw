import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { VaultConfig, MemoryNote, NoteFrontmatter } from "./types";

const VAULT_DIRS = ["inbox", "notes", "projects", "tasks", "agents", "templates", "core", "weekly"];

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function initVault(config: VaultConfig): void {
  for (const dir of VAULT_DIRS) {
    const p = join(config.vaultPath, dir);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
    }
  }
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }

  const endIdx = raw.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, content: raw };
  }

  const fmBlock = raw.slice(3, endIdx).trim();
  const content = raw.slice(endIdx + 3).trim();
  const frontmatter: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of fmBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("- ") && currentKey && currentArray) {
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    if (value === "") {
      // Start of array
      currentKey = key;
      currentArray = [];
    } else if (value === "null") {
      frontmatter[key] = null;
    } else if (value === "true") {
      frontmatter[key] = true;
    } else if (value === "false") {
      frontmatter[key] = false;
    } else if (/^-?\d+$/.test(value)) {
      frontmatter[key] = parseInt(value, 10);
    } else {
      frontmatter[key] = value;
    }
  }

  // Flush last array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, content };
}

export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  let match;
  while ((match = WIKILINK_RE.exec(content)) !== null) {
    links.push(match[1]!);
  }
  return links;
}

export function readNote(filePath: string): MemoryNote | null {
  if (!existsSync(filePath)) return null;

  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, content } = parseFrontmatter(raw);
  const links = extractWikilinks(content);

  return {
    path: filePath,
    frontmatter: {
      id: (frontmatter.id as string) ?? "",
      type: (frontmatter.type as NoteFrontmatter["type"]) ?? "fleeting",
      tags: (frontmatter.tags as string[]) ?? [],
      created: (frontmatter.created as number) ?? 0,
      source: (frontmatter.source as string | null) ?? null,
      title: frontmatter.title as string | undefined,
      aliases: frontmatter.aliases as string[] | undefined,
    },
    content,
    links,
  };
}

export function writeNote(filePath: string, content: string): void {
  writeFileSync(filePath, content);
}

export function listNotes(vaultPath: string, subdir?: string): MemoryNote[] {
  const dir = subdir ? join(vaultPath, subdir) : vaultPath;
  if (!existsSync(dir)) return [];

  const notes: MemoryNote[] = [];

  function walk(currentDir: string) {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        const note = readNote(fullPath);
        if (note) notes.push(note);
      }
    }
  }

  walk(dir);
  return notes;
}

export function deleteNote(filePath: string): void {
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
