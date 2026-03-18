import { describe, it, expect } from "bun:test";
import { routeTask, DEFAULT_ROUTING_CONFIG } from "../src/orchestrator/routing";
import type { RoutingConfig } from "../src/orchestrator/routing";

const enabledConfig: RoutingConfig = {
  ...DEFAULT_ROUTING_CONFIG,
  enabled: true,
};

describe("routeTask", () => {
  it("returns routing_disabled when not enabled", () => {
    const result = routeTask("Fix typo", null, DEFAULT_ROUTING_CONFIG);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("routing_disabled");
  });

  it("returns simple_turn for short simple tasks", () => {
    const result = routeTask("Update readme", null, enabledConfig);
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("returns simple_turn for short task with short description", () => {
    const result = routeTask("Fix typo", "Change foo to bar", enabledConfig);
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("returns complex_turn for long text (> maxChars)", () => {
    const longTitle = "a".repeat(161);
    const result = routeTask(longTitle, null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn when title + description exceeds maxChars", () => {
    const title = "a".repeat(80);
    const desc = "b".repeat(81);
    const result = routeTask(title, desc, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn for many words (> maxWords)", () => {
    const manyWords = Array(30).fill("word").join(" ");
    const result = routeTask(manyWords, null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn when complexity keywords present", () => {
    const result = routeTask("Debug the login flow", null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("matches complexity keywords case-insensitively", () => {
    const result = routeTask("REFACTOR utils", null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("matches complexity keywords with word boundaries", () => {
    // "test" should match as a whole word
    const result = routeTask("Add a test", null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("does not match partial keyword without word boundary", () => {
    // "contest" contains "test" but not at a word boundary
    const result = routeTask("Win a contest", null, enabledConfig);
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("returns complex_turn for code blocks", () => {
    const result = routeTask("Run this", "```js\nconsole.log();\n```", enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn for URLs", () => {
    const result = routeTask("Check https://example.com", null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn for http URLs", () => {
    const result = routeTask("Check http://localhost:3000", null, enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns complex_turn for multi-line text", () => {
    const result = routeTask("Fix things", "line one\nline two\nline three", enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });

  it("returns simple_turn for single newline (not multiple)", () => {
    // Only one newline — not "multiple newlines"
    const result = routeTask("Fix a typo", "single line\n", enabledConfig);
    // "single line\n" has text\n but the regex /\n.*\n/ needs two newlines in the combined text
    // Combined: "Fix a typosingle line\n" — only one \n, so not complex
    expect(result.reason).toBe("simple_turn");
  });

  it("returns simple_turn at exact maxChars boundary", () => {
    const title = "a".repeat(160);
    const result = routeTask(title, null, enabledConfig);
    // Exactly 160 chars = not over maxChars (160), check word count
    // 1 "word" of 160 chars, maxWords is 28, so 1 <= 28
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("returns simple_turn at exact maxWords boundary", () => {
    const words = Array(28).fill("hi").join(" ");
    const result = routeTask(words, null, enabledConfig);
    // 28 words = not over maxWords (28), and short enough in chars
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("uses custom config values", () => {
    const custom: RoutingConfig = {
      enabled: true,
      cheapModel: "custom/small-model",
      maxChars: 50,
      maxWords: 5,
      complexityKeywords: ["special"],
    };

    // Simple task within custom limits
    const simple = routeTask("Hello", null, custom);
    expect(simple.model).toBe("custom/small-model");
    expect(simple.reason).toBe("simple_turn");

    // Exceeds custom maxChars
    const longResult = routeTask("a".repeat(51), null, custom);
    expect(longResult.model).toBeNull();
    expect(longResult.reason).toBe("complex_turn");

    // Exceeds custom maxWords
    const wordy = routeTask("one two three four five six", null, custom);
    expect(wordy.model).toBeNull();
    expect(wordy.reason).toBe("complex_turn");

    // Custom keyword triggers complex
    const keyword = routeTask("Do special thing", null, custom);
    expect(keyword.model).toBeNull();
    expect(keyword.reason).toBe("complex_turn");

    // Default keywords NOT present in custom config
    const debug = routeTask("Debug it", null, custom);
    expect(debug.model).toBe("custom/small-model");
    expect(debug.reason).toBe("simple_turn");
  });

  it("treats null description as empty string", () => {
    const result = routeTask("Say hi", null, enabledConfig);
    expect(result.model).toBe(enabledConfig.cheapModel);
    expect(result.reason).toBe("simple_turn");
  });

  it("checks description for complexity keywords too", () => {
    const result = routeTask("Do stuff", "please deploy it", enabledConfig);
    expect(result.model).toBeNull();
    expect(result.reason).toBe("complex_turn");
  });
});
