import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME ?? "~";

export type AgentType = "opencode" | "claude-code" | "codex";

/**
 * Builds the CLI command array for the given agent type.
 * Use {prompt} as a placeholder — the container manager replaces it at spawn time.
 */
export function buildAgentCommand(agentType: AgentType): string[] {
  switch (agentType) {
    case "claude-code":
      return ["claude", "-p", "{prompt}", "--allowedTools", "Bash,Read,Edit,Write"];
    case "codex":
      return ["codex", "exec", "--full-auto", "{prompt}"];
    case "opencode":
    default:
      return ["opencode", "run", "--prompt", "{prompt}"];
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
    default:
      // OpenCode credentials handled via credentials.ts (provider-level)
      break;
  }

  return paths;
}
