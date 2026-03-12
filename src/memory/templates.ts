import type { NoteType } from "./types";

export function renderFrontmatter(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function fleetingTemplate(id: string, content: string, tags: string[], source: string | null): string {
  const fm = renderFrontmatter({
    id,
    type: "fleeting" as NoteType,
    tags,
    created: Math.floor(Date.now() / 1000),
    source,
  });
  return `${fm}\n\n${content}\n`;
}

export function permanentTemplate(id: string, title: string, content: string, tags: string[], source: string | null): string {
  const fm = renderFrontmatter({
    id,
    type: "permanent" as NoteType,
    tags,
    created: Math.floor(Date.now() / 1000),
    source,
    title,
  });
  return `${fm}\n\n# ${title}\n\n${content}\n`;
}

export function taskLogTemplate(id: string, taskId: string, title: string, summary: string, learnings: string, tags: string[]): string {
  const fm = renderFrontmatter({
    id,
    type: "task-log" as NoteType,
    tags,
    created: Math.floor(Date.now() / 1000),
    source: taskId,
    title,
  });
  return `${fm}\n\n# ${title}\n\n## Summary\n\n${summary}\n\n## Learnings\n\n${learnings}\n`;
}

export function mocTemplate(id: string, title: string, description: string, links: string[], tags: string[]): string {
  const fm = renderFrontmatter({
    id,
    type: "moc" as NoteType,
    tags,
    created: Math.floor(Date.now() / 1000),
    source: null,
    title,
  });
  const linkLines = links.map((l) => `- [[${l}]]`).join("\n");
  return `${fm}\n\n# ${title}\n\n${description}\n\n## Notes\n\n${linkLines}\n`;
}
