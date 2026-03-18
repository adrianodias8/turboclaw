export interface ParsedMetrics {
  tokensIn: number;
  tokensOut: number;
  model: string | null;
}

/**
 * Rough per-million-token pricing by model prefix.
 * Match by prefix — e.g. "anthropic/claude-sonnet-4-20250514" matches "anthropic/claude-sonnet".
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet": { input: 3, output: 15 },
  "anthropic/claude-opus": { input: 15, output: 75 },
  "anthropic/claude-haiku": { input: 0.25, output: 1.25 },
  "openai/gpt-4o": { input: 2.5, output: 10 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "ollama/": { input: 0, output: 0 },
};

/** Default pricing for unknown models (per million tokens) */
const DEFAULT_PRICING = { input: 3, output: 15 };

/**
 * Parse token usage from agent output text.
 * Different agents output usage differently:
 * - Claude Code: "Input tokens: 1234" / "Output tokens: 567"
 * - OpenCode: May include token counts in different formats
 */
export function parseTokenUsage(output: string): ParsedMetrics {
  let tokensIn = 0;
  let tokensOut = 0;
  let model: string | null = null;

  // Try input token patterns
  const inputMatch = output.match(/[Ii]nput[_ ]tokens:\s*(\d+)/);
  if (inputMatch?.[1]) {
    tokensIn = parseInt(inputMatch[1], 10);
  }

  // Try output token patterns
  const outputMatch = output.match(/[Oo]utput[_ ]tokens:\s*(\d+)/);
  if (outputMatch?.[1]) {
    tokensOut = parseInt(outputMatch[1], 10);
  }

  // If neither input nor output found, try total tokens with 70/30 split
  if (tokensIn === 0 && tokensOut === 0) {
    const totalMatch = output.match(/[Tt]otal[_ ]tokens:\s*(\d+)/);
    if (totalMatch?.[1]) {
      const total = parseInt(totalMatch[1], 10);
      tokensIn = Math.round(total * 0.7);
      tokensOut = total - tokensIn;
    }
  }

  // Try model patterns
  const modelMatch = output.match(/[Mm]odel:\s*(.+)/);
  if (modelMatch?.[1]) {
    model = modelMatch[1].trim();
  }

  return { tokensIn, tokensOut, model };
}

/**
 * Estimate cost based on model and token counts.
 * Returns USD estimate. Uses rough pricing tiers.
 */
export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const normalizedModel = model.toLowerCase();

  // Find matching pricing by prefix
  let pricing = DEFAULT_PRICING;
  for (const [prefix, p] of Object.entries(PRICING)) {
    if (normalizedModel.startsWith(prefix)) {
      pricing = p;
      break;
    }
  }

  const inputCost = (tokensIn / 1_000_000) * pricing.input;
  const outputCost = (tokensOut / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}
