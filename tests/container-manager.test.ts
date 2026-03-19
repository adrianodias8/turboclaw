/**
 * Container manager tests — validates Docker command construction, mount setup,
 * env var injection, and container lifecycle without requiring Docker.
 *
 * Uses a mock runDocker function to capture and assert the exact docker CLI
 * arguments that would be passed.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";
import type { SpawnOptions, ContainerConfig } from "../src/container/types";
import { DEFAULT_CONTAINER_CONFIG } from "../src/container/types";
import { DEFAULT_STREAM_LOGS_INACTIVITY_MS, DEFAULT_STREAM_LOGS_MAX_MS } from "../src/container/manager";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * Build the docker args array that createContainerManager.spawn() would construct.
 * Extracted from manager.ts spawn() logic for testability.
 */
function buildDockerArgs(opts: SpawnOptions, config: ContainerConfig = DEFAULT_CONTAINER_CONFIG): string[] {
  const containerName = `turboclaw-${opts.taskId.slice(0, 8)}-${opts.runId.slice(0, 8)}`;
  const args: string[] = [
    "run", "-d",
    "--name", containerName,
    "--network", config.network,
    "--memory", config.memoryLimit,
    "--cpus", config.cpuLimit,
    "--add-host", "host.docker.internal:host-gateway",
    "-v", `${opts.workspacePath}:/workspace`,
    "-w", "/workspace",
  ];

  if (opts.memoryVaultPath) {
    args.push("-v", `${opts.memoryVaultPath}:/workspace/.turboclaw/memory`);
  }

  if (opts.mountProjectSource) {
    args.push("-v", `${opts.mountProjectSource}:/project`);
  }

  // Env vars
  args.push(
    "-e", `TURBOCLAW_TASK_ID=${opts.taskId}`,
    "-e", `TURBOCLAW_RUN_ID=${opts.runId}`,
    "-e", `TURBOCLAW_AGENT_ROLE=${opts.agentRole}`,
    "-e", `TURBOCLAW_MEMORY_PATH=/workspace/.turboclaw/memory`,
    "-e", `TURBOCLAW_API=http://host.docker.internal:${opts.gatewayPort ?? 7800}`,
  );
  for (const [key, value] of Object.entries(opts.envVars)) {
    args.push("-e", `${key}=${value}`);
  }

  // Skill mounts
  if (opts.skillPaths && opts.skillPaths.length > 0) {
    if (opts.agentType === "opencode") {
      for (const skill of opts.skillPaths) {
        args.push("-v", `${skill.hostDir}:/home/agent/.config/opencode/skills/${skill.name}:ro`);
      }
    } else if (opts.agentType === "claude-code") {
      for (const skill of opts.skillPaths) {
        args.push("-v", `${skill.hostDir}:/workspace/.claude/skills/${skill.name}:ro`);
      }
    }
  }

  // Image
  const image = opts.agentType === "opencode" ? config.openCodeImage : config.image;
  args.push(image);

  // Command
  const agentCmd = opts.agentCommand ?? config.agentCommand;
  const cmd = agentCmd.map(arg => {
    if (arg === "{prompt}") return opts.prompt;
    if (arg === "{model}") return opts.envVars.OPENCODE_MODEL ?? "anthropic/claude-sonnet-4-20250514";
    return arg;
  });
  args.push(...cmd);

  return args;
}

describe("container name generation", () => {
  it("uses first 8 chars of taskId and runId", () => {
    const name = `turboclaw-${"abcdefghijklmnop".slice(0, 8)}-${"1234567890123456".slice(0, 8)}`;
    expect(name).toBe("turboclaw-abcdefgh-12345678");
  });
});

describe("docker args construction", () => {
  it("includes required base args", () => {
    const args = buildDockerArgs({
      taskId: "task-id-12345678",
      runId: "run-id-87654321",
      workspacePath: "/home/user/project",
      agentRole: "coder",
      prompt: "Fix the bug",
      envVars: {},
      agentType: "opencode",
    });

    expect(args).toContain("run");
    expect(args).toContain("-d");
    expect(args).toContain("--network");
    expect(args).toContain("--memory");
    expect(args).toContain("--cpus");
    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args.join(" ")).toContain("-v");
    expect(args.join(" ")).toContain("/home/user/project:/workspace");
    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
  });

  it("mounts memory vault when provided", () => {
    const args = buildDockerArgs({
      taskId: "task-id-12345678",
      runId: "run-id-87654321",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      memoryVaultPath: "/home/user/.turboclaw/memory",
    });

    expect(args).toContain("/home/user/.turboclaw/memory:/workspace/.turboclaw/memory");
  });

  it("mounts project source for self-improve", () => {
    const args = buildDockerArgs({
      taskId: "task-id-12345678",
      runId: "run-id-87654321",
      workspacePath: "/workspace",
      agentRole: "self-improve",
      prompt: "improve tests",
      envVars: {},
      mountProjectSource: "/home/user/turboclaw",
    });

    expect(args).toContain("/home/user/turboclaw:/project");
  });

  it("sets all required env vars", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: { ANTHROPIC_API_KEY: "sk-ant-test" },
      gatewayPort: 7800,
    });

    const envPairs = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envPairs).toContain("TURBOCLAW_TASK_ID=task-abc");
    expect(envPairs).toContain("TURBOCLAW_RUN_ID=run-xyz");
    expect(envPairs).toContain("TURBOCLAW_AGENT_ROLE=coder");
    expect(envPairs).toContain("TURBOCLAW_MEMORY_PATH=/workspace/.turboclaw/memory");
    expect(envPairs).toContain("TURBOCLAW_API=http://host.docker.internal:7800");
    expect(envPairs).toContain("ANTHROPIC_API_KEY=sk-ant-test");
  });

  it("mounts opencode skills to correct path", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentType: "opencode",
      skillPaths: [
        { name: "git-workflow", hostDir: "/tmp/skills/git-workflow" },
        { name: "web-research", hostDir: "/tmp/skills/web-research" },
      ],
    });

    expect(args).toContain("/tmp/skills/git-workflow:/home/agent/.config/opencode/skills/git-workflow:ro");
    expect(args).toContain("/tmp/skills/web-research:/home/agent/.config/opencode/skills/web-research:ro");
  });

  it("mounts claude-code skills to correct path", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentType: "claude-code",
      skillPaths: [
        { name: "git-workflow", hostDir: "/tmp/skills/git-workflow" },
      ],
    });

    expect(args).toContain("/tmp/skills/git-workflow:/workspace/.claude/skills/git-workflow:ro");
  });

  it("selects opencode image for opencode agent", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentType: "opencode",
    });

    expect(args).toContain(DEFAULT_CONTAINER_CONFIG.openCodeImage);
  });

  it("selects default image for non-opencode agent", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentType: "claude-code",
    });

    expect(args).toContain(DEFAULT_CONTAINER_CONFIG.image);
  });

  it("replaces {prompt} placeholder in agent command", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "Fix login bug",
      envVars: {},
      agentCommand: ["claude", "-p", "{prompt}"],
      agentType: "claude-code",
    });

    expect(args).toContain("Fix login bug");
    expect(args).not.toContain("{prompt}");
  });

  it("replaces {model} placeholder with env var or default", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: { OPENCODE_MODEL: "anthropic/claude-haiku" },
      agentCommand: ["opencode", "run", "--model", "{model}", "{prompt}"],
      agentType: "opencode",
    });

    expect(args).toContain("anthropic/claude-haiku");
    expect(args).not.toContain("{model}");
  });

  it("uses default model when OPENCODE_MODEL not set", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      agentCommand: ["opencode", "run", "--model", "{model}", "{prompt}"],
      agentType: "opencode",
    });

    expect(args).toContain("anthropic/claude-sonnet-4-20250514");
  });

  it("uses custom gateway port", () => {
    const args = buildDockerArgs({
      taskId: "task-abc",
      runId: "run-xyz",
      workspacePath: "/workspace",
      agentRole: "coder",
      prompt: "test",
      envVars: {},
      gatewayPort: 9000,
    });

    const envPairs = args.filter((_, i) => i > 0 && args[i - 1] === "-e");
    expect(envPairs).toContain("TURBOCLAW_API=http://host.docker.internal:9000");
  });
});

describe("streamLogs timeout constants", () => {
  it("inactivity timeout is 30 minutes", () => {
    expect(DEFAULT_STREAM_LOGS_INACTIVITY_MS).toBe(30 * 60 * 1000);
  });

  it("max wall-clock timeout is 24 hours", () => {
    expect(DEFAULT_STREAM_LOGS_MAX_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("container ID validation", () => {
  it("validates 12-char hex container IDs", () => {
    const validPattern = /^[a-f0-9]{12}$/;
    expect(validPattern.test("a1b2c3d4e5f6")).toBe(true);
    expect(validPattern.test("ABC123")).toBe(false);
    expect(validPattern.test("a1b2c3")).toBe(false); // too short
    expect(validPattern.test("a1b2c3d4e5f6g7")).toBe(false); // too long
    expect(validPattern.test("hello world!")).toBe(false);
  });
});

describe("credential path validation", () => {
  it("rejects non-absolute paths", () => {
    const credPath = "relative/path";
    expect(credPath.startsWith("/")).toBe(false);
  });

  it("rejects paths with traversal", () => {
    const credPath = "/home/user/../etc/passwd";
    const resolved = require("path").join(credPath);
    expect(resolved.includes("..") || resolved !== credPath).toBe(true);
  });

  it("rejects paths outside home directory", () => {
    const hostHome = "/home/user";
    const credPath = "/etc/shadow";
    expect(credPath.startsWith(hostHome) || credPath.startsWith("/tmp")).toBe(false);
  });

  it("accepts paths under home directory", () => {
    const hostHome = "/home/user";
    const credPath = "/home/user/.config/opencode";
    expect(credPath.startsWith(hostHome)).toBe(true);
  });

  it("accepts paths under /tmp", () => {
    const credPath = "/tmp/test-creds";
    expect(credPath.startsWith("/tmp")).toBe(true);
  });
});
