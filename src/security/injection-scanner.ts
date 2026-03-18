export interface ScanResult {
  safe: boolean;
  threats: string[];
}

interface ThreatPattern {
  category: string;
  pattern: RegExp;
  description: string;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // Prompt injection
  { category: "prompt_injection", pattern: /ignore\s+previous\s+instructions/i, description: "Prompt injection: attempts to ignore previous instructions" },
  { category: "prompt_injection", pattern: /ignore\s+all\s+instructions/i, description: "Prompt injection: attempts to ignore all instructions" },
  { category: "prompt_injection", pattern: /ignore\s+your\s+instructions/i, description: "Prompt injection: attempts to ignore your instructions" },
  { category: "prompt_injection", pattern: /disregard\s+previous/i, description: "Prompt injection: attempts to disregard previous context" },
  { category: "prompt_injection", pattern: /override\s+your/i, description: "Prompt injection: attempts to override behavior" },
  { category: "prompt_injection", pattern: /new\s+instructions\s*:/i, description: "Prompt injection: attempts to inject new instructions" },
  { category: "prompt_injection", pattern: /system\s+prompt/i, description: "Prompt injection: references system prompt" },
  { category: "prompt_injection", pattern: /you\s+are\s+now\b/i, description: "Prompt injection: attempts to redefine identity" },
  { category: "prompt_injection", pattern: /pretend\s+you\s+are/i, description: "Prompt injection: attempts to make agent pretend" },
  { category: "prompt_injection", pattern: /act\s+as\s+if\s+you\s+are/i, description: "Prompt injection: attempts to make agent act as something else" },
  { category: "prompt_injection", pattern: /forget\s+everything/i, description: "Prompt injection: attempts to reset agent context" },

  // Role hijacking
  { category: "role_hijacking", pattern: /your\s+new\s+role\s+is/i, description: "Role hijacking: attempts to reassign agent role" },
  { category: "role_hijacking", pattern: /from\s+now\s+on\s+you/i, description: "Role hijacking: attempts to change ongoing behavior" },
  { category: "role_hijacking", pattern: /you\s+must\s+always/i, description: "Role hijacking: attempts to impose permanent directive" },
  { category: "role_hijacking", pattern: /you\s+must\s+never/i, description: "Role hijacking: attempts to impose permanent restriction" },

  // Exfiltration
  { category: "exfiltration", pattern: /curl\b.*\$/i, description: "Exfiltration: curl command with variable interpolation" },
  { category: "exfiltration", pattern: /wget\b.*\$/i, description: "Exfiltration: wget command with variable interpolation" },
  { category: "exfiltration", pattern: /curl\b.*\b(TOKEN|SECRET|KEY|PASSWORD)\b/i, description: "Exfiltration: curl command referencing sensitive env vars" },
  { category: "exfiltration", pattern: /wget\b.*\b(TOKEN|SECRET|KEY|PASSWORD)\b/i, description: "Exfiltration: wget command referencing sensitive env vars" },

  // Deception
  { category: "deception", pattern: /do\s+not\s+tell\s+the\s+user/i, description: "Deception: instructs agent to withhold info from user" },
  { category: "deception", pattern: /don['']t\s+tell\s+the\s+user/i, description: "Deception: instructs agent to withhold info from user" },
  { category: "deception", pattern: /hide\s+this\s+from/i, description: "Deception: instructs agent to hide information" },
  { category: "deception", pattern: /keep\s+this\s+secret\s+from\s+the\s+user/i, description: "Deception: instructs agent to keep secrets from user" },

  // Destructive ops
  { category: "destructive", pattern: /rm\s+-rf\s+\//i, description: "Destructive operation: recursive delete of root filesystem" },
  { category: "destructive", pattern: /rm\s+-rf\s+~/i, description: "Destructive operation: recursive delete of home directory" },
  { category: "destructive", pattern: /DROP\s+TABLE/i, description: "Destructive operation: SQL DROP TABLE" },
  { category: "destructive", pattern: /DELETE\s+FROM\s+.*WHERE\s+1/i, description: "Destructive operation: SQL DELETE with always-true condition" },
  { category: "destructive", pattern: /:\(\)\{\s*:\|:&\s*\};:/i, description: "Destructive operation: fork bomb" },
];

const INVISIBLE_CHARS: Record<string, string> = {
  "\u200B": "U+200B zero-width space",
  "\u200C": "U+200C zero-width non-joiner",
  "\u200D": "U+200D zero-width joiner",
  "\u200E": "U+200E left-to-right mark",
  "\u200F": "U+200F right-to-left mark",
  "\u2060": "U+2060 word joiner",
  "\uFEFF": "U+FEFF zero-width no-break space",
};

const INVISIBLE_REGEX = /[\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF]/g;

export function stripInvisibleUnicode(content: string): string {
  return content.replace(INVISIBLE_REGEX, "");
}

export function scanForInjection(content: string): ScanResult {
  const threats: string[] = [];

  // Check for invisible unicode
  const invisibleMatches = content.match(INVISIBLE_REGEX);
  if (invisibleMatches) {
    const found = new Set<string>();
    for (const ch of invisibleMatches) {
      const desc = INVISIBLE_CHARS[ch];
      if (desc) found.add(desc);
    }
    threats.push(`Invisible Unicode characters detected: ${[...found].join(", ")}`);
  }

  // Strip invisible chars before pattern matching to catch obfuscated attacks
  const cleaned = stripInvisibleUnicode(content);

  // Check threat patterns
  for (const tp of THREAT_PATTERNS) {
    if (tp.pattern.test(cleaned)) {
      threats.push(tp.description);
    }
  }

  return {
    safe: threats.length === 0,
    threats,
  };
}
