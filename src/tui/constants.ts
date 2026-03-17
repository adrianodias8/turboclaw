import type { TaskStatus, EventKind } from "../tracker/types";

export const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: "yellow",
  queued: "blue",
  running: "cyan",
  done: "green",
  failed: "red",
  cancelled: "gray",
};

export const KIND_COLORS: Record<EventKind, string> = {
  stdout: "white",
  stderr: "red",
  status: "cyan",
  artifact: "green",
  error: "red",
  info: "blue",
};

export function formatTimestamp(ts: number | null, opts?: { includeDate?: boolean; includeSeconds?: boolean }): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");

  if (opts?.includeDate) {
    const MM = String(d.getMonth() + 1).padStart(2, "0");
    const DD = String(d.getDate()).padStart(2, "0");
    if (opts.includeSeconds) {
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${MM}/${DD} ${hh}:${mm}:${ss}`;
    }
    return `${MM}/${DD} ${hh}:${mm}`;
  }

  if (opts?.includeSeconds) {
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  return `${hh}:${mm}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}
