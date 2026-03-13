import { createTaskLog } from "./writer";
import type { Task } from "../tracker/types";

export function maybeCreateTaskMemory(
  vaultPath: string,
  task: Task,
  output: string
): string | null {
  if (output.length < 50 || task.title.length < 5) return null;

  const trimmed = output.length > 800
    ? output.slice(0, 800) + "..."
    : output;

  const today = new Date();
  const dateTag = `daily-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const autoTags = task.title
    .split(/\s+/)
    .filter(w => w.length > 3)
    .map(w => `auto-${w.toLowerCase().replace(/[^a-z0-9]/g, "")}`)
    .filter(t => t.length > 5)
    .slice(0, 5);

  return createTaskLog(vaultPath, task.id, task.title, trimmed, "", ["auto-memory", "daily", dateTag, ...autoTags]);
}
