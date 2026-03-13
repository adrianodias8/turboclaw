import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface TurboClawConfig {
  home: string;
  gateway: {
    port: number;
    host: string;
  };
  orchestrator: {
    pollIntervalMs: number;
    maxConcurrency: number;
    leaseDurationSec: number;
    schedulingStrategy: "fifo" | "priority" | "round-robin";
  };
  selfImprove: {
    enabled: boolean;
  };
  provider: {
    type: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  } | null;
  agent?: "opencode" | "claude-code" | "codex";
  whatsapp: {
    enabled: boolean;
    allowedNumbers: string[];
    notifyOnComplete: boolean;
    notifyOnFail: boolean;
  };
  memory: {
    dailyRetentionDays: number;
    weeklyRetentionWeeks: number;
  };
  dbPath: string;
}

const DEFAULT_CONFIG: Omit<TurboClawConfig, "home" | "dbPath"> = {
  gateway: {
    port: 7800,
    host: "0.0.0.0",
  },
  orchestrator: {
    pollIntervalMs: 2000,
    maxConcurrency: 2,
    leaseDurationSec: 600,
    schedulingStrategy: "priority",
  },
  selfImprove: {
    enabled: false,
  },
  provider: null,
  whatsapp: {
    enabled: false,
    allowedNumbers: [],
    notifyOnComplete: false,
    notifyOnFail: false,
  },
  memory: {
    dailyRetentionDays: 7,
    weeklyRetentionWeeks: 4,
  },
};

export function loadConfig(): TurboClawConfig {
  const home = process.env.TURBOCLAW_HOME ?? join(process.env.HOME ?? "~", ".turboclaw");
  const configPath = join(home, "config.json");
  const dbPath = join(home, "turboclaw.db");

  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }

  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // ignore malformed config
    }
  }

  const config: TurboClawConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    home,
    dbPath,
    gateway: { ...DEFAULT_CONFIG.gateway, ...(fileConfig.gateway as Record<string, unknown> ?? {}) },
    orchestrator: { ...DEFAULT_CONFIG.orchestrator, ...(fileConfig.orchestrator as Record<string, unknown> ?? {}) },
    selfImprove: { ...DEFAULT_CONFIG.selfImprove, ...(fileConfig.selfImprove as Record<string, unknown> ?? {}) },
    whatsapp: { ...DEFAULT_CONFIG.whatsapp, ...(fileConfig.whatsapp as Record<string, unknown> ?? {}) },
    memory: { ...DEFAULT_CONFIG.memory, ...(fileConfig.memory as Record<string, unknown> ?? {}) },
    agent: (fileConfig.agent as TurboClawConfig["agent"]) ?? undefined,
  } as TurboClawConfig;

  // Env var overrides
  if (process.env.TURBOCLAW_GATEWAY_PORT) {
    config.gateway.port = parseInt(process.env.TURBOCLAW_GATEWAY_PORT, 10);
  }
  if (process.env.TURBOCLAW_GATEWAY_HOST) {
    config.gateway.host = process.env.TURBOCLAW_GATEWAY_HOST;
  }
  if (process.env.TURBOCLAW_MAX_CONCURRENCY) {
    config.orchestrator.maxConcurrency = parseInt(process.env.TURBOCLAW_MAX_CONCURRENCY, 10);
  }
  if (process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS) {
    config.memory.dailyRetentionDays = parseInt(process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS, 10);
  }
  if (process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS) {
    config.memory.weeklyRetentionWeeks = parseInt(process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS, 10);
  }

  return config;
}

export function saveConfig(config: TurboClawConfig): void {
  const configPath = join(config.home, "config.json");
  const { home, dbPath, ...rest } = config;
  writeFileSync(configPath, JSON.stringify(rest, null, 2));
}
