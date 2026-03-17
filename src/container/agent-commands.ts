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

// Maps provider type → [prefix for user models, default model string]
const PROVIDER_MODEL_DEFAULTS: Record<string, [string, string]> = {
  anthropic: ["anthropic", "anthropic/claude-sonnet-4-20250514"],
  "claude-code": ["anthropic", "anthropic/claude-sonnet-4-20250514"],
  "claude-sub": ["anthropic", "anthropic/claude-sonnet-4-20250514"],
  openai: ["openai", "openai/gpt-4o"],
  chatgpt: ["openai", "openai/gpt-4o"],
  ollama: ["ollama", "ollama/qwen3-coder"],
  copilot: ["copilot", "copilot/gpt-4o"],
  codex: ["openai", "openai/gpt-4o"],
  custom: ["custom", "custom/default"],
};

/**
 * Resolves a provider config to an OpenCode-compatible model string.
 * Format: "provider/model-name"
 */
export function resolveOpenCodeModel(provider: { type: string; model?: string }): string {
  const entry = PROVIDER_MODEL_DEFAULTS[provider.type];
  if (!entry) return provider.model ?? "anthropic/claude-sonnet-4-20250514";

  const [prefix, defaultModel] = entry;
  if (!provider.model) return defaultModel;
  return provider.model.includes("/") ? provider.model : `${prefix}/${provider.model}`;
}
