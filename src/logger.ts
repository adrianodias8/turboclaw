import { appendFileSync, existsSync, renameSync, statSync } from "fs";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";
let logFilePath: string | null = null;

/** Max log file size before rotation (10 MB) */
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
/** Number of rotated log files to keep */
const MAX_ROTATED_FILES = 3;
let linesSinceRotationCheck = 0;

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

/** Redirect all logs to a file instead of stderr (use when TUI is active) */
export function setLogFile(path: string) {
  logFilePath = path;
}

function maybeRotateLogFile(): void {
  if (!logFilePath) return;

  // Only check every 100 lines to avoid stat() overhead
  linesSinceRotationCheck++;
  if (linesSinceRotationCheck < 100) return;
  linesSinceRotationCheck = 0;

  try {
    if (!existsSync(logFilePath)) return;
    const stat = statSync(logFilePath);
    if (stat.size < MAX_LOG_SIZE_BYTES) return;

    // Rotate: .log → .log.1, .log.1 → .log.2, etc.
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${logFilePath}.${i}`;
      const to = `${logFilePath}.${i + 1}`;
      if (existsSync(from)) {
        renameSync(from, to);
      }
    }
    renameSync(logFilePath, `${logFilePath}.1`);
  } catch {
    // Rotation failure is non-fatal
  }
}

function log(level: LogLevel, msg: string, data?: unknown) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] ${level.toUpperCase()}`;
  const line = data !== undefined ? `${prefix} ${msg} ${String(data)}` : `${prefix} ${msg}`;

  if (logFilePath) {
    maybeRotateLogFile();
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
