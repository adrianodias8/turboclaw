/**
 * Tests for config loading with env var validation.
 * Ensures invalid env var values (NaN, negative, out-of-range) are rejected
 * gracefully and defaults are preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../src/config";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let testHome: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "TURBOCLAW_HOME",
  "TURBOCLAW_GATEWAY_PORT",
  "TURBOCLAW_GATEWAY_HOST",
  "TURBOCLAW_MAX_CONCURRENCY",
  "TURBOCLAW_WORKSPACE_ROOT",
  "TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS",
  "TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS",
];

beforeEach(() => {
  testHome = join(tmpdir(), `turboclaw-cfg-test-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(testHome, { recursive: true });
  // Save and clear all env vars
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.TURBOCLAW_HOME = testHome;
});

afterEach(() => {
  // Restore env vars
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {}
});

describe("config env var validation", () => {
  it("loads defaults when no env vars or file config", () => {
    const config = loadConfig();
    expect(config.gateway.port).toBe(7800);
    expect(config.gateway.host).toBe("0.0.0.0");
    expect(config.orchestrator.maxConcurrency).toBe(2);
    expect(config.memory.dailyRetentionDays).toBe(7);
    expect(config.memory.weeklyRetentionWeeks).toBe(4);
  });

  it("accepts valid TURBOCLAW_GATEWAY_PORT", () => {
    process.env.TURBOCLAW_GATEWAY_PORT = "8080";
    const config = loadConfig();
    expect(config.gateway.port).toBe(8080);
  });

  it("rejects NaN TURBOCLAW_GATEWAY_PORT and keeps default", () => {
    process.env.TURBOCLAW_GATEWAY_PORT = "abc";
    const config = loadConfig();
    expect(config.gateway.port).toBe(7800);
  });

  it("rejects negative TURBOCLAW_GATEWAY_PORT", () => {
    process.env.TURBOCLAW_GATEWAY_PORT = "-1";
    const config = loadConfig();
    expect(config.gateway.port).toBe(7800);
  });

  it("rejects port > 65535", () => {
    process.env.TURBOCLAW_GATEWAY_PORT = "99999";
    const config = loadConfig();
    expect(config.gateway.port).toBe(7800);
  });

  it("accepts valid TURBOCLAW_MAX_CONCURRENCY", () => {
    process.env.TURBOCLAW_MAX_CONCURRENCY = "4";
    const config = loadConfig();
    expect(config.orchestrator.maxConcurrency).toBe(4);
  });

  it("rejects NaN TURBOCLAW_MAX_CONCURRENCY and keeps default", () => {
    process.env.TURBOCLAW_MAX_CONCURRENCY = "not_a_number";
    const config = loadConfig();
    expect(config.orchestrator.maxConcurrency).toBe(2);
  });

  it("rejects zero TURBOCLAW_MAX_CONCURRENCY", () => {
    process.env.TURBOCLAW_MAX_CONCURRENCY = "0";
    const config = loadConfig();
    expect(config.orchestrator.maxConcurrency).toBe(2);
  });

  it("rejects NaN TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS", () => {
    process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS = "foo";
    const config = loadConfig();
    expect(config.memory.dailyRetentionDays).toBe(7);
  });

  it("rejects NaN TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS", () => {
    process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS = "bar";
    const config = loadConfig();
    expect(config.memory.weeklyRetentionWeeks).toBe(4);
  });

  it("accepts valid memory retention values", () => {
    process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS = "14";
    process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS = "8";
    const config = loadConfig();
    expect(config.memory.dailyRetentionDays).toBe(14);
    expect(config.memory.weeklyRetentionWeeks).toBe(8);
  });

  it("loads config from JSON file", () => {
    const configPath = join(testHome, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { port: 9000 },
        orchestrator: { maxConcurrency: 5 },
      })
    );
    const config = loadConfig();
    expect(config.gateway.port).toBe(9000);
    expect(config.orchestrator.maxConcurrency).toBe(5);
  });

  it("env vars override file config", () => {
    const configPath = join(testHome, "config.json");
    writeFileSync(configPath, JSON.stringify({ gateway: { port: 9000 } }));
    process.env.TURBOCLAW_GATEWAY_PORT = "8080";
    const config = loadConfig();
    expect(config.gateway.port).toBe(8080);
  });

  it("ignores malformed JSON config file", () => {
    const configPath = join(testHome, "config.json");
    writeFileSync(configPath, "not valid json {{{");
    const config = loadConfig();
    // Should fall back to defaults
    expect(config.gateway.port).toBe(7800);
  });
});
