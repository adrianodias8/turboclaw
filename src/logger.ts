import { appendFileSync } from "fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let logFilePath: string | null = null;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

/** Redirect all logs to a file instead of stderr (use when TUI is active) */
export function setLogFile(path: string) {
  logFilePath = path;
}

function log(level: LogLevel, msg: string, data?: unknown) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase()}`;
  const line = data !== undefined ? `${prefix} ${msg} ${String(data)}` : `${prefix} ${msg}`;

  if (logFilePath) {
    appendFileSync(logFilePath, line + "\n");
  } else {
    console.error(line);
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("debug", msg, data),
  info: (msg: string, data?: unknown) => log("info", msg, data),
  warn: (msg: string, data?: unknown) => log("warn", msg, data),
  error: (msg: string, data?: unknown) => log("error", msg, data),
};
