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
  agent?: "opencode" | "claude-code";
  /** Host project directory to mount as the container workspace. Defaults to cwd. */
  workspaceRoot?: string;
  whatsapp: {
    enabled: boolean;
    allowedNumbers: string[];
    allowedGroups: string[];
    notifyOnComplete: boolean;
    notifyOnFail: boolean;
  };
  memory: {
    dailyRetentionDays: number;
    weeklyRetentionWeeks: number;
  };
  skills: {
    autoDiscover: boolean;
    maxPerTask: number;
    registries: ("clawhub" | "n-skills")[];
  };
  autoresearch: {
    enabled: boolean;
    timeBudgetMs: number;
    maxExperiments: number; // 0 = unlimited
    programPath: string;
  };
  routing?: {
    enabled: boolean;
    cheapModel: string;
    maxChars?: number;
    maxWords?: number;
    complexityKeywords?: string[];
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
    allowedGroups: [],
    notifyOnComplete: false,
    notifyOnFail: false,
  },
  memory: {
    dailyRetentionDays: 7,
    weeklyRetentionWeeks: 4,
  },
  skills: {
    autoDiscover: true,
    maxPerTask: 5,
    registries: ["clawhub", "n-skills"],
  },
  autoresearch: {
    enabled: false,
    timeBudgetMs: 600000,
    maxExperiments: 0,
    programPath: "docker/skills/self-improve/PROGRAM.md",
  },
};

export function loadConfig(): TurboClawConfig {
  const home = process.env.TURBOCLAW_HOME ?? join(process.cwd(), ".turboclaw");
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
    skills: { ...DEFAULT_CONFIG.skills, ...(fileConfig.skills as Record<string, unknown> ?? {}) },
    autoresearch: { ...DEFAULT_CONFIG.autoresearch, ...(fileConfig.autoresearch as Record<string, unknown> ?? {}) },
    agent: (fileConfig.agent as TurboClawConfig["agent"]) ?? undefined,
    workspaceRoot: (fileConfig.workspaceRoot as string) ?? undefined,
  } as TurboClawConfig;

  // Env var overrides — validate numeric values to prevent NaN propagation
  if (process.env.TURBOCLAW_GATEWAY_PORT) {
    const parsed = parseInt(process.env.TURBOCLAW_GATEWAY_PORT, 10);
    if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
      config.gateway.port = parsed;
    }
  }
  if (process.env.TURBOCLAW_GATEWAY_HOST) {
    config.gateway.host = process.env.TURBOCLAW_GATEWAY_HOST;
  }
  if (process.env.TURBOCLAW_MAX_CONCURRENCY) {
    const parsed = parseInt(process.env.TURBOCLAW_MAX_CONCURRENCY, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.orchestrator.maxConcurrency = parsed;
    }
  }
  if (process.env.TURBOCLAW_WORKSPACE_ROOT) {
    config.workspaceRoot = process.env.TURBOCLAW_WORKSPACE_ROOT;
  }
  if (process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS) {
    const parsed = parseInt(process.env.TURBOCLAW_MEMORY_DAILY_RETENTION_DAYS, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.memory.dailyRetentionDays = parsed;
    }
  }
  if (process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS) {
    const parsed = parseInt(process.env.TURBOCLAW_MEMORY_WEEKLY_RETENTION_WEEKS, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      config.memory.weeklyRetentionWeeks = parsed;
    }
  }

  return config;
}

export function saveConfig(config: TurboClawConfig): void {
  const configPath = join(config.home, "config.json");
  const { home, dbPath, ...rest } = config;
  writeFileSync(configPath, JSON.stringify(rest, null, 2));
}
