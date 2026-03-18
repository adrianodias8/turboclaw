export interface RouteDecision {
  model: string | null; // null = use default model
  reason: string; // "simple_turn" | "complex_turn" | "routing_disabled"
}

export interface RoutingConfig {
  enabled: boolean;
  cheapModel: string; // e.g. "ollama/qwen3-coder"
  maxChars: number; // max title+description length for "simple"
  maxWords: number; // max word count for "simple"
  complexityKeywords: string[]; // if any present, always use strong model
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false,
  cheapModel: "ollama/qwen3-coder",
  maxChars: 160,
  maxWords: 28,
  complexityKeywords: [
    "debug",
    "implement",
    "refactor",
    "architect",
    "migrate",
    "redesign",
    "optimize",
    "security",
    "vulnerability",
    "performance",
    "database",
    "schema",
    "docker",
    "kubernetes",
    "deploy",
    "test",
    "coverage",
    "ci",
    "pipeline",
  ],
};

/**
 * Evaluate task complexity and decide whether to route to cheap model.
 * Conservative by design — if in doubt, use the strong model.
 */
export function routeTask(
  title: string,
  description: string | null,
  config: RoutingConfig
): RouteDecision {
  if (!config.enabled) {
    return { model: null, reason: "routing_disabled" };
  }

  const text = title + (description ?? "");

  // Length check
  if (text.length > config.maxChars) {
    return { model: null, reason: "complex_turn" };
  }

  // Word count check
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > config.maxWords) {
    return { model: null, reason: "complex_turn" };
  }

  // Complexity keywords (case-insensitive, word boundary)
  const lowerText = text.toLowerCase();
  for (const keyword of config.complexityKeywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lowerText)) {
      return { model: null, reason: "complex_turn" };
    }
  }

  // Code blocks
  if (text.includes("```")) {
    return { model: null, reason: "complex_turn" };
  }

  // URLs
  if (/https?:\/\//.test(text)) {
    return { model: null, reason: "complex_turn" };
  }

  // Multiple newlines (structured/complex content)
  if (/\n.*\n/.test(text)) {
    return { model: null, reason: "complex_turn" };
  }

  // Simple task — route to cheap model
  return { model: config.cheapModel, reason: "simple_turn" };
}
