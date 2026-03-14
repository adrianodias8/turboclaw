import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME ?? "~";

export type AgentType = "opencode" | "claude-code" | "codex";

/**
 * Builds the CLI command array for the given agent type.
 * Use {prompt} as a placeholder — the container manager replaces it at spawn time.
 * Use {model} as a placeholder — the orchestrator replaces it with the resolved model string.
 */
export function buildAgentCommand(agentType: AgentType): string[] {
  switch (agentType) {
    case "claude-code":
      return [
        "claude", "-p", "{prompt}",
        "--dangerously-skip-permissions",
      ];
    case "codex":
      return ["codex", "exec", "--full-auto", "{prompt}"];
    case "opencode":
    default:
      return ["opencode", "run", "--model", "{model}", "{prompt}"];
  }
}

/**
 * Returns extra environment variables needed for a specific agent type.
 */
export function getAgentEnvVars(agentType: AgentType): Record<string, string> {
  switch (agentType) {
    case "claude-code":
      return {
        CLAUDE_CODE_DISABLE_NONINTERACTIVE_CHECK: "1",
      };
    case "codex":
      return {};
    case "opencode":
    default:
      return {
        OPENCODE_BROWSER_BACKEND: "agent",
        // Remap localhost services to Docker host so Ollama etc. are reachable
        OLLAMA_HOST: "http://host.docker.internal:11434",
      };
  }
}

/**
 * Returns credential mount paths specific to the agent type (not the LLM provider).
 * Provider credentials are handled separately in credentials.ts.
 */
export function getAgentCredentialPaths(agentType: AgentType): string[] {
  const paths: string[] = [];

  switch (agentType) {
    case "claude-code": {
      const claudeDir = join(HOME, ".claude");
      if (existsSync(claudeDir)) paths.push(claudeDir);
      break;
    }
    case "codex": {
      const codexDir = join(HOME, ".codex");
      if (existsSync(codexDir)) paths.push(codexDir);
      break;
    }
    case "opencode":
    default: {
      const opencodeData = join(HOME, ".local", "share", "opencode");
      if (existsSync(opencodeData)) paths.push(opencodeData);
      const opencodeConfig = join(HOME, ".config", "opencode");
      if (existsSync(opencodeConfig)) paths.push(opencodeConfig);
      break;
    }
  }

  return paths;
}

/**
 * Resolves a provider config to an OpenCode-compatible model string.
 * Format: "provider/model-name"
 */
export function resolveOpenCodeModel(provider: { type: string; model?: string }): string {
  const userModel = provider.model;

  switch (provider.type) {
    case "anthropic":
    case "claude-code":
    case "claude-sub":
      return userModel
        ? (userModel.includes("/") ? userModel : `anthropic/${userModel}`)
        : "anthropic/claude-sonnet-4-20250514";
    case "openai":
    case "chatgpt":
      return userModel
        ? (userModel.includes("/") ? userModel : `openai/${userModel}`)
        : "openai/gpt-4o";
    case "ollama":
      return userModel
        ? (userModel.includes("/") ? userModel : `ollama/${userModel}`)
        : "ollama/qwen3-coder";
    case "copilot":
      return userModel
        ? (userModel.includes("/") ? userModel : `copilot/${userModel}`)
        : "copilot/gpt-4o";
    case "codex":
      return userModel
        ? (userModel.includes("/") ? userModel : `openai/${userModel}`)
        : "openai/gpt-4o";
    case "custom":
      return userModel
        ? (userModel.includes("/") ? userModel : `custom/${userModel}`)
        : "custom/default";
    default:
      return userModel ?? "anthropic/claude-sonnet-4-20250514";
  }
}
