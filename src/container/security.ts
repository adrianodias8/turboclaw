import { logger } from "../logger";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[a-zA-Z0-9]{20,}/, "Anthropic API key"],
  [/sk-[a-zA-Z0-9]{20,}/, "OpenAI API key"],
  [/ghp_[a-zA-Z0-9]{36}/, "GitHub PAT"],
  [/github_pat_[a-zA-Z0-9_]{20,}/, "GitHub fine-grained PAT"],
  [/ghu_[a-zA-Z0-9]{36}/, "GitHub user token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/xoxb-[0-9]{10,13}-[a-zA-Z0-9-]*/, "Slack bot token"],
  [/-----BEGIN (RSA |EC )?PRIVATE KEY/, "Private key"],
  [/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, "JWT token"],
];

/**
 * Scan text for potential secrets. Returns descriptions of matches found.
 */
export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS
    .filter(([pattern]) => pattern.test(text))
    .map(([, desc]) => desc);
}

/**
 * Redact known secret patterns from a string (for log sanitization).
 */
export function sanitizeSecrets(text: string): string {
  let result = text;
  for (const [pattern, desc] of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, "g"), `[REDACTED:${desc}]`);
  }
  return result;
}
