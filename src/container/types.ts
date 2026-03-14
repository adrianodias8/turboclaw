export interface ContainerConfig {
  image: string;
  /** Docker image for OpenCode workers. */
  openCodeImage: string;
  network: string;
  memoryLimit: string;
  cpuLimit: string;
  /** Command template for running the agent. Use {prompt} as placeholder. */
  agentCommand: string[];
}

export interface SpawnOptions {
  taskId: string;
  runId: string;
  workspacePath: string;
  agentRole: string;
  prompt: string;
  envVars: Record<string, string>;
  mountProjectSource?: string; // for self-improve mode
  memoryVaultPath?: string;
  providerType?: string; // for credential mounting
  credentialPaths?: string[]; // host paths to mount into container
  agentCommand?: string[]; // per-spawn override for agent CLI command
  agentType?: "opencode" | "claude-code" | "codex";
}

export interface ContainerInfo {
  containerId: string;
  taskId: string;
  runId: string;
  status: "running" | "exited";
  exitCode: number | null;
}

export const DEFAULT_CONTAINER_CONFIG: ContainerConfig = {
  image: "turboclaw-worker:latest",
  openCodeImage: "turboclaw-opencode:latest",
  network: "turboclaw-net",
  memoryLimit: "2g",
  cpuLimit: "2",
  agentCommand: ["opencode", "run", "--model", "{model}", "{prompt}"],
};
