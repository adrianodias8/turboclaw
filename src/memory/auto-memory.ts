import { createTaskLog } from "./writer";
import type { Task } from "../tracker/types";

const UNHELPFUL_PATTERNS = [
  /^done\b/i,
  /i don'?t (see|know|have|find)/i,
  /no .* mentioned/i,
  /outside.*(my|the) scope/i,
  /i can'?t help with/i,
  /not something i/i,
];

export function maybeCreateTaskMemory(
  vaultPath: string,
  task: Task,
  output: string
): string | null {
  if (output.length < 100 || task.title.length < 5) return null;

  // Don't save unhelpful/refusal responses as memories
  if (UNHELPFUL_PATTERNS.some(p => p.test(output.slice(0, 200)))) return null;

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
