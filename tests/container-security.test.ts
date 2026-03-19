import { describe, it, expect } from "bun:test";
import { scanForSecrets, sanitizeSecrets } from "../src/container/security";

describe("scanForSecrets", () => {
  it("detects Anthropic API key", () => {
    const result = scanForSecrets("key: sk-ant-abc123DEF456ghi789jkl012mno");
    expect(result).toContain("Anthropic API key");
  });

  it("detects OpenAI API key", () => {
    const result = scanForSecrets("OPENAI_KEY=sk-abc123DEF456ghi789jkl012mno345");
    expect(result).toContain("OpenAI API key");
  });

  it("detects GitHub PAT", () => {
    const result = scanForSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result).toContain("GitHub PAT");
  });

  it("detects GitHub fine-grained PAT", () => {
    const result = scanForSecrets("github_pat_abcdefghijklmnopqrstuvwxyz");
    expect(result).toContain("GitHub fine-grained PAT");
  });

  it("detects GitHub user token", () => {
    const result = scanForSecrets("ghu_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result).toContain("GitHub user token");
  });

  it("detects AWS access key", () => {
    const result = scanForSecrets("aws_key=AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("AWS access key");
  });

  it("detects Slack bot token", () => {
    const result = scanForSecrets("SLACK_TOKEN=xoxb-1234567890-abcdefg");
    expect(result).toContain("Slack bot token");
  });

  it("detects private keys", () => {
    const result = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...");
    expect(result).toContain("Private key");
  });

  it("detects EC private keys", () => {
    const result = scanForSecrets("-----BEGIN EC PRIVATE KEY-----\nMHQC...");
    expect(result).toContain("Private key");
  });

  it("detects generic private keys", () => {
    const result = scanForSecrets("-----BEGIN PRIVATE KEY-----\nMIIEv...");
    expect(result).toContain("Private key");
  });

  it("detects JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = scanForSecrets(`auth: ${jwt}`);
    expect(result).toContain("JWT token");
  });

  it("detects multiple secrets in same text", () => {
    const text = "sk-ant-abc123DEF456ghi789jkl012mno and AKIAIOSFODNN7EXAMPLE";
    const result = scanForSecrets(text);
    expect(result).toContain("Anthropic API key");
    expect(result).toContain("AWS access key");
  });

  it("returns empty for clean text", () => {
    const result = scanForSecrets("This is perfectly safe text with no secrets");
    expect(result).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(scanForSecrets("")).toEqual([]);
  });

  it("does not false-positive on short strings", () => {
    const result = scanForSecrets("sk-short");
    expect(result).toEqual([]);
  });
});

describe("sanitizeSecrets", () => {
  it("redacts Anthropic API key", () => {
    const result = sanitizeSecrets("key: sk-ant-abc123DEF456ghi789jkl012mno");
    expect(result).toContain("[REDACTED:Anthropic API key]");
    expect(result).not.toContain("sk-ant-abc123");
  });

  it("redacts OpenAI API key", () => {
    const result = sanitizeSecrets("OPENAI=sk-abc123DEF456ghi789jkl012mno345");
    expect(result).toContain("[REDACTED:");
    expect(result).not.toContain("sk-abc123DEF456");
  });

  it("redacts GitHub PAT", () => {
    const result = sanitizeSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result).toContain("[REDACTED:GitHub PAT]");
  });

  it("redacts AWS access key", () => {
    const result = sanitizeSecrets("aws: AKIAIOSFODNN7EXAMPLE rest");
    expect(result).toContain("[REDACTED:AWS access key]");
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts multiple secrets in one string", () => {
    const text = "api=sk-ant-abc123DEF456ghi789jkl012mno token=ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = sanitizeSecrets(text);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("ghp_");
    expect(result).toContain("[REDACTED:");
  });

  it("leaves clean text unchanged", () => {
    const text = "This is safe text with no secrets at all";
    expect(sanitizeSecrets(text)).toBe(text);
  });

  it("leaves empty string unchanged", () => {
    expect(sanitizeSecrets("")).toBe("");
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = sanitizeSecrets(`Bearer ${jwt}`);
    expect(result).toContain("[REDACTED:JWT token]");
    expect(result).not.toContain("eyJhbGci");
  });

  it("redacts private key markers", () => {
    const result = sanitizeSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...");
    expect(result).toContain("[REDACTED:Private key]");
  });
});
