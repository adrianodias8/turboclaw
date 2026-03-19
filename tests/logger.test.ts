import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";

// We need to test the logger module, but it has module-level state.
// Import the functions we need to test.
import { setLogLevel, setLogFile, logger } from "../src/logger";

const TEST_DIR = join(import.meta.dir, ".test-logger");
const LOG_FILE = join(TEST_DIR, "test.log");

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  setLogLevel("debug");
  setLogFile(LOG_FILE);
});

afterEach(() => {
  // Reset to stderr output (no file)
  setLogFile(null as unknown as string);
  setLogLevel("info");
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("log levels", () => {
  it("writes debug messages when level is debug", () => {
    setLogLevel("debug");
    logger.debug("test debug message");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("DEBUG");
    expect(content).toContain("test debug message");
  });

  it("writes info messages", () => {
    logger.info("test info message");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("INFO");
    expect(content).toContain("test info message");
  });

  it("writes warn messages", () => {
    logger.warn("test warning");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("WARN");
    expect(content).toContain("test warning");
  });

  it("writes error messages", () => {
    logger.error("test error");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("ERROR");
    expect(content).toContain("test error");
  });

  it("filters out debug when level is info", () => {
    setLogLevel("info");
    logger.debug("should not appear");
    logger.info("should appear");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).not.toContain("should not appear");
    expect(content).toContain("should appear");
  });

  it("filters out info and debug when level is warn", () => {
    setLogLevel("warn");
    logger.debug("nope");
    logger.info("nope2");
    logger.warn("yes warn");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).not.toContain("nope");
    expect(content).not.toContain("nope2");
    expect(content).toContain("yes warn");
  });

  it("only shows errors when level is error", () => {
    setLogLevel("error");
    logger.debug("no");
    logger.info("no");
    logger.warn("no");
    logger.error("yes error");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).not.toContain(" no\n");
    expect(content).toContain("yes error");
  });
});

describe("log formatting", () => {
  it("includes ISO timestamp", () => {
    logger.info("timestamp test");

    const content = readFileSync(LOG_FILE, "utf-8");
    // ISO format: [2026-03-19T...]
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes additional data when provided", () => {
    logger.info("with data", "extra-info");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("with data");
    expect(content).toContain("extra-info");
  });

  it("each log is on its own line", () => {
    logger.info("line one");
    logger.info("line two");

    const content = readFileSync(LOG_FILE, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("line one");
    expect(lines[1]).toContain("line two");
  });
});

describe("log file output", () => {
  it("creates file on first write", () => {
    expect(existsSync(LOG_FILE)).toBe(false);
    logger.info("first write");
    expect(existsSync(LOG_FILE)).toBe(true);
  });

  it("appends to existing file", () => {
    logger.info("message 1");
    logger.info("message 2");

    const content = readFileSync(LOG_FILE, "utf-8");
    expect(content).toContain("message 1");
    expect(content).toContain("message 2");
  });
});

describe("log rotation", () => {
  it("rotates when file exceeds 10MB after 100 lines", () => {
    // Create a log file just over 10MB
    const bigContent = "x".repeat(10 * 1024 * 1024 + 1000);
    writeFileSync(LOG_FILE, bigContent);

    // Write 101 lines to trigger the rotation check
    for (let i = 0; i < 101; i++) {
      logger.info(`rotation line ${i}`);
    }

    // The original file should have been rotated
    expect(existsSync(`${LOG_FILE}.1`)).toBe(true);
    // New log file should exist with recent content
    expect(existsSync(LOG_FILE)).toBe(true);
    const newContent = readFileSync(LOG_FILE, "utf-8");
    expect(newContent).toContain("rotation line");
    // Rotated file should have the big content
    const rotatedSize = statSync(`${LOG_FILE}.1`).size;
    expect(rotatedSize).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("cascades rotated files (.1 → .2)", () => {
    // Create existing rotated file
    writeFileSync(`${LOG_FILE}.1`, "old rotated content");

    // Create a file over the limit
    writeFileSync(LOG_FILE, "x".repeat(10 * 1024 * 1024 + 100));

    // Trigger rotation
    for (let i = 0; i < 101; i++) {
      logger.info(`cascade line ${i}`);
    }

    expect(existsSync(`${LOG_FILE}.2`)).toBe(true);
    const cascaded = readFileSync(`${LOG_FILE}.2`, "utf-8");
    expect(cascaded).toBe("old rotated content");
  });

  it("does not rotate when file is under 10MB", () => {
    writeFileSync(LOG_FILE, "small content");

    for (let i = 0; i < 101; i++) {
      logger.info(`no-rotate ${i}`);
    }

    expect(existsSync(`${LOG_FILE}.1`)).toBe(false);
  });
});
