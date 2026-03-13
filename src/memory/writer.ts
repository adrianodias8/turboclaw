import { join } from "path";
import { newId } from "../ids";
import { writeNote } from "./vault";
import { readFileSync } from "fs";
import { fleetingTemplate, permanentTemplate, taskLogTemplate, mocTemplate, coreTemplate } from "./templates";
import { parseFrontmatter } from "./vault";

export function createFleetingNote(
  vaultPath: string,
  content: string,
  tags: string[] = [],
  source: string | null = null
): string {
  const id = newId();
  const filename = `${Date.now()}-${id.slice(0, 8)}.md`;
  const filePath = join(vaultPath, "inbox", filename);
  writeNote(filePath, fleetingTemplate(id, content, tags, source));
  return filePath;
}

export function createPermanentNote(
  vaultPath: string,
  title: string,
  content: string,
  tags: string[] = [],
  source: string | null = null
): string {
  const id = newId();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${slug}.md`;
  const filePath = join(vaultPath, "notes", filename);
  writeNote(filePath, permanentTemplate(id, title, content, tags, source));
  return filePath;
}

export function createTaskLog(
  vaultPath: string,
  taskId: string,
  title: string,
  summary: string,
  learnings: string,
  tags: string[] = []
): string {
  const id = newId();
  const filename = `${taskId.slice(0, 8)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;
  const filePath = join(vaultPath, "tasks", filename);
  writeNote(filePath, taskLogTemplate(id, taskId, title, summary, learnings, tags));
  return filePath;
}

export function createCoreNote(
  vaultPath: string,
  slug: string,
  title: string,
  content: string,
  tags: string[] = []
): string {
  const id = newId();
  const filename = `${slug}.md`;
  const filePath = join(vaultPath, "core", filename);
  writeNote(filePath, coreTemplate(id, title, content, tags));
  return filePath;
}

export function updateNoteContent(filePath: string, newContent: string): void {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter } = parseFrontmatter(raw);

  // Rebuild frontmatter block
  const fmStart = raw.indexOf("---");
  const fmEnd = raw.indexOf("---", fmStart + 3);
  if (fmStart === -1 || fmEnd === -1) {
    writeNote(filePath, newContent);
    return;
  }

  const fmBlock = raw.slice(fmStart, fmEnd + 3);
  writeNote(filePath, `${fmBlock}\n\n${newContent}\n`);
}

export function createMoc(
  vaultPath: string,
  title: string,
  description: string,
  links: string[] = [],
  tags: string[] = []
): string {
  const id = newId();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const filename = `${slug}.md`;
  const filePath = join(vaultPath, "projects", filename);
  writeNote(filePath, mocTemplate(id, title, description, links, tags));
  return filePath;
}
