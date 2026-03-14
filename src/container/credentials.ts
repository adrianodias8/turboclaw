import { existsSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME ?? "~";

/**
 * Resolves credential file paths that need to be mounted into worker containers
 * for OAuth-based providers. These are cached by `opencode auth login`.
 */
export function resolveCredentialPaths(providerType: string): string[] {
  const paths: string[] = [];

  switch (providerType) {
    case "copilot": {
      // GitHub CLI credential store
      const ghConfig = join(HOME, ".config", "gh");
      if (existsSync(ghConfig)) paths.push(ghConfig);
      // OpenCode may also cache copilot tokens
      const opencodeCopilot = join(HOME, ".config", "opencode", "auth");
      if (existsSync(opencodeCopilot)) paths.push(opencodeCopilot);
      break;
    }

    case "chatgpt": {
      // OpenAI OAuth tokens cached by opencode
      const openaiAuth = join(HOME, ".config", "opencode", "auth");
      if (existsSync(openaiAuth)) paths.push(openaiAuth);
      // Also check for openai config
      const openaiConfig = join(HOME, ".config", "openai");
      if (existsSync(openaiConfig)) paths.push(openaiConfig);
      break;
    }

    case "claude-sub": {
      // Anthropic OAuth tokens cached by opencode
      const anthropicAuth = join(HOME, ".config", "opencode", "auth");
      if (existsSync(anthropicAuth)) paths.push(anthropicAuth);
      // Anthropic config dir
      const anthropicConfig = join(HOME, ".config", "anthropic");
      if (existsSync(anthropicConfig)) paths.push(anthropicConfig);
      break;
    }

    case "claude-code": {
      // Claude Code stores credentials in ~/.claude/
      const claudeDir = join(HOME, ".claude");
      if (existsSync(claudeDir)) paths.push(claudeDir);
      break;
    }

    case "codex": {
      // Codex stores credentials in ~/.codex/
      const codexDir = join(HOME, ".codex");
      if (existsSync(codexDir)) paths.push(codexDir);
      break;
    }

    case "opencode-config": {
      // Mount the entire opencode config — user's provider setup lives here
      const opencodeDir = join(HOME, ".config", "opencode");
      if (existsSync(opencodeDir)) paths.push(opencodeDir);
      const opencodeData = join(HOME, ".local", "share", "opencode");
      if (existsSync(opencodeData)) paths.push(opencodeData);
      // State dir holds model.json (last-used model/provider selection)
      const opencodeState = join(HOME, ".local", "state", "opencode");
      if (existsSync(opencodeState)) paths.push(opencodeState);
      break;
    }
  }

  // Common: opencode general config (may contain cached tokens)
  const opencodeConfig = join(HOME, ".config", "opencode");
  if (existsSync(opencodeConfig) && !paths.includes(opencodeConfig)) {
    // Only mount the config dir if we haven't already mounted it or a subdir of it
    const sep = "/";
    const prefix = opencodeConfig + sep;
    const alreadyMounted = paths.some((p) => p === opencodeConfig || p.startsWith(prefix));
    if (!alreadyMounted) {
      paths.push(opencodeConfig);
    }
  }

  return paths;
}

