import type { Task } from "../tracker/types";
import type { SchedulingStrategy } from "./types";

export function sortTasks(tasks: Task[], strategy: SchedulingStrategy): Task[] {
  const sorted = [...tasks];

  switch (strategy) {
    case "fifo":
      sorted.sort((a, b) => a.created_at - b.created_at);
      break;
    case "priority":
      sorted.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.created_at - b.created_at;
      });
      break;
    case "round-robin":
      // Group by agent_role, interleave
      const groups = new Map<string, Task[]>();
      for (const t of sorted) {
        const group = groups.get(t.agent_role) ?? [];
        group.push(t);
        groups.set(t.agent_role, group);
      }
      const result: Task[] = [];
      const iterators = [...groups.values()].map((g) => g[Symbol.iterator]());
      let added = true;
      while (added) {
        added = false;
        for (const it of iterators) {
          const next = it.next();
          if (!next.done) {
            result.push(next.value);
            added = true;
          }
        }
      }
      return result;
  }

  return sorted;
}
