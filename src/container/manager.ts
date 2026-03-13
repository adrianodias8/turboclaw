import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { ContainerConfig, SpawnOptions, ContainerInfo } from "./types";
import { DEFAULT_CONTAINER_CONFIG } from "./types";

export interface ContainerManager {
  spawn(opts: SpawnOptions): Promise<ContainerInfo>;
  kill(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<ContainerInfo | null>;
  streamLogs(containerId: string, onData: (kind: "stdout" | "stderr", line: string) => void): Promise<number>;
  cleanup(containerId: string): Promise<void>;
  ensureNetwork(): Promise<void>;
}

export function createContainerManager(
  store: Store,
  config: ContainerConfig = DEFAULT_CONTAINER_CONFIG
): ContainerManager {
  async function runDocker(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const proc = Bun.spawn(["docker", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  }

  return {
    async ensureNetwork() {
      const { exitCode } = await runDocker(["network", "inspect", config.network]);
      if (exitCode !== 0) {
        logger.info(`Creating Docker network: ${config.network}`);
        await runDocker(["network", "create", config.network]);
      }
    },

    async spawn(opts) {
      const containerName = `turboclaw-${opts.taskId.slice(0, 8)}-${opts.runId.slice(0, 8)}`;

      const dockerArgs: string[] = [
        "run",
        "-d",
        "--name", containerName,
        "--network", config.network,
        "--memory", config.memoryLimit,
        "--cpus", config.cpuLimit,
        // Mount workspace
        "-v", `${opts.workspacePath}:/workspace`,
        // Working directory
        "-w", "/workspace",
      ];

      // Mount memory vault co-located with workspace so agents can find it
      if (opts.memoryVaultPath) {
        dockerArgs.push("-v", `${opts.memoryVaultPath}:/workspace/.turboclaw/memory`);
      }

      // Mount project source for self-improve mode
      if (opts.mountProjectSource) {
        dockerArgs.push("-v", `${opts.mountProjectSource}:/project`);
      }

      // Mount OAuth credential files for subscription-based providers
      if (opts.credentialPaths) {
        for (const credPath of opts.credentialPaths) {
          dockerArgs.push("-v", `${credPath}:${credPath}:ro`);
        }
      }

      // Environment variables (agent-specific env vars like OPENCODE_BROWSER_BACKEND
      // are set via opts.envVars by the orchestrator, not hardcoded here)
      dockerArgs.push(
        "-e", `TURBOCLAW_TASK_ID=${opts.taskId}`,
        "-e", `TURBOCLAW_RUN_ID=${opts.runId}`,
        "-e", `TURBOCLAW_AGENT_ROLE=${opts.agentRole}`,
        "-e", `TURBOCLAW_MEMORY_PATH=/workspace/.turboclaw/memory`,
      );

      for (const [key, value] of Object.entries(opts.envVars)) {
        dockerArgs.push("-e", `${key}=${value}`);
      }

      // Select image based on agent type
      const image = opts.agentType === "opencode"
        ? config.openCodeImage
        : config.image;
      dockerArgs.push(image);
      const agentCmd = opts.agentCommand ?? config.agentCommand;
      const cmd = agentCmd.map((arg) => {
        if (arg === "{prompt}") return opts.prompt;
        if (arg === "{model}") return opts.envVars.OPENCODE_MODEL ?? "anthropic/claude-sonnet-4-20250514";
        return arg;
      });
      dockerArgs.push(...cmd);

      logger.info(`Spawning container: ${containerName}`);
      const { stdout, stderr, exitCode } = await runDocker(dockerArgs);

      if (exitCode !== 0) {
        throw new Error(`Failed to spawn container: ${stderr}`);
      }

      const containerId = stdout.slice(0, 12);
      logger.info(`Container started: ${containerId}`);

      return {
        containerId,
        taskId: opts.taskId,
        runId: opts.runId,
        status: "running",
        exitCode: null,
      };
    },

    async kill(containerId) {
      logger.info(`Killing container: ${containerId}`);
      const { exitCode, stderr } = await runDocker(["kill", containerId]);
      if (exitCode !== 0 && !stderr.includes("is not running")) {
        logger.warn(`Failed to kill container ${containerId}: ${stderr}`);
      }
    },

    async inspect(containerId) {
      const { stdout, exitCode } = await runDocker([
        "inspect",
        "--format",
        '{{.State.Status}}|{{.State.ExitCode}}|{{index .Config.Labels "turboclaw.task_id"}}|{{index .Config.Labels "turboclaw.run_id"}}',
        containerId,
      ]);

      if (exitCode !== 0) return null;

      const parts = stdout.split("|");
      const status = parts[0] === "running" ? "running" as const : "exited" as const;
      const code = parts[1] ? parseInt(parts[1], 10) : null;

      return {
        containerId,
        taskId: parts[2] ?? "",
        runId: parts[3] ?? "",
        status,
        exitCode: status === "exited" ? code : null,
      };
    },

    async streamLogs(containerId, onData) {
      const proc = Bun.spawn(["docker", "logs", "-f", containerId], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const readStream = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) onData(kind, line);
          }
        }
        if (buffer.trim()) onData(kind, buffer);
      };

      await Promise.all([
        readStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
        readStream(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      ]);

      return await proc.exited;
    },

    async cleanup(containerId) {
      logger.info(`Removing container: ${containerId}`);
      await runDocker(["rm", "-f", containerId]);
    },
  };
}
