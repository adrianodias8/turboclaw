import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { Select, TextInput, Spinner } from "@inkjs/ui";
import { existsSync } from "fs";
import { join } from "path";
import type { TurboClawConfig } from "../../config";
import { saveConfig } from "../../config";

interface OnboardingProps {
  config: TurboClawConfig;
  onComplete: () => void;
}

type Step =
  | "docker-check"
  | "provider"
  | "api-key"
  | "oauth-token"
  | "oauth-flow"
  | "cred-check"
  | "ollama-detect"
  | "custom-url"
  | "build-image"
  | "whatsapp"
  | "whatsapp-number"
  | "ready";

const HOME = process.env.HOME ?? "~";

const PROVIDER_OPTIONS = [
  { label: "Claude Code (subscription — recommended)", value: "claude-code" },
  { label: "Anthropic (API key)", value: "anthropic" },
  { label: "GitHub Copilot (OAuth device flow)", value: "copilot" },
  { label: "ChatGPT (OpenAI OAuth)", value: "chatgpt" },
  { label: "Claude subscription (via OpenCode)", value: "claude-sub" },
  { label: "Codex (OpenAI subscription)", value: "codex" },
  { label: "OpenAI (API key)", value: "openai" },
  { label: "Ollama (local, no key needed)", value: "ollama" },
  { label: "Custom provider", value: "custom" },
];

const OAUTH_PROVIDERS = new Set(["copilot", "chatgpt", "claude-sub"]);
const API_KEY_PROVIDERS = new Set(["anthropic", "openai"]);

export function Onboarding({ config, onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("docker-check");
  const [dockerOk, setDockerOk] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<string>("");
  const [oauthStatus, setOauthStatus] = useState<"running" | "success" | "error">("running");
  const [oauthMessage, setOauthMessage] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [credCheckResult, setCredCheckResult] = useState<"checking" | "found" | "missing">("checking");
  const [buildStatus, setBuildStatus] = useState<"building" | "success" | "error">("building");
  const [buildMessage, setBuildMessage] = useState("");
  const [enableWhatsapp, setEnableWhatsapp] = useState<boolean | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");

  // Step 1: Check Docker
  useEffect(() => {
    if (step !== "docker-check") return;
    const proc = Bun.spawn(["docker", "info"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.exited.then((code) => {
      setDockerOk(code === 0);
      if (code === 0) {
        setStep("provider");
      }
    });
  }, [step]);

  // OAuth flow handler (for Copilot, ChatGPT, Claude-sub via OpenCode)
  useEffect(() => {
    if (step !== "oauth-flow") return;

    async function runOauth() {
      if (provider === "copilot") {
        setOauthMessage("Running `opencode auth login` — check your browser for the GitHub device code...");
        const proc = Bun.spawn(["opencode", "auth", "login"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          config.provider = { type: "copilot" };
          saveConfig(config);
          setOauthStatus("success");
          setOauthMessage("GitHub Copilot authenticated successfully.");
        } else {
          setOauthStatus("error");
          setOauthMessage(`Auth failed: ${stderr.slice(0, 200)}`);
        }
      } else if (provider === "chatgpt") {
        setOauthMessage("Running OpenAI OAuth (PKCE) flow — check your browser...");
        const proc = Bun.spawn(["opencode", "auth", "login", "--provider", "openai"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          config.provider = { type: "chatgpt" };
          saveConfig(config);
          setOauthStatus("success");
          setOauthMessage("ChatGPT (OpenAI OAuth) authenticated successfully.");
        } else {
          setOauthStatus("error");
          setOauthMessage(`Auth failed: ${stderr.slice(0, 200)}`);
        }
      } else if (provider === "claude-sub") {
        setOauthMessage("Running Anthropic OAuth flow — check your browser...");
        const proc = Bun.spawn(["opencode", "auth", "login", "--provider", "anthropic"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          config.provider = { type: "claude-sub" };
          saveConfig(config);
          setOauthStatus("success");
          setOauthMessage("Claude subscription authenticated successfully.");
        } else {
          setOauthStatus("error");
          setOauthMessage(`Auth failed: ${stderr.slice(0, 200)}`);
        }
      }
    }

    runOauth();
  }, [step, provider]);

  // Credential check for Codex
  useEffect(() => {
    if (step !== "cred-check") return;

    const credDir = join(HOME, ".codex");
    if (existsSync(credDir)) {
      setCredCheckResult("found");
      config.provider = { type: "codex" };
      config.agent = "codex";
      saveConfig(config);
      setTimeout(() => setStep("build-image"), 500);
    } else {
      setCredCheckResult("missing");
    }
  }, [step, provider]);

  // Ollama detection
  useEffect(() => {
    if (step !== "ollama-detect") return;

    async function detectOllama() {
      try {
        const resp = await fetch("http://localhost:11434/api/tags");
        if (!resp.ok) throw new Error("not reachable");
        const data = (await resp.json()) as { models?: Array<{ name: string }> };
        const models = (data.models ?? []).map((m) => m.name);
        setOllamaModels(models);
        config.provider = {
          type: "ollama",
          baseUrl: "http://host.docker.internal:11434",
          model: models[0] ?? "llama3",
        };
        saveConfig(config);
        setStep("build-image");
      } catch {
        setOllamaModels([]);
        config.provider = { type: "ollama", baseUrl: "http://host.docker.internal:11434" };
        saveConfig(config);
        setStep("build-image");
      }
    }

    detectOllama();
  }, [step]);

  // Build Docker image
  useEffect(() => {
    if (step !== "build-image") return;

    async function buildImage() {
      setBuildStatus("building");
      setBuildMessage("Building worker Docker image (this may take a minute)...");

      // Check if image already exists
      const checkProc = Bun.spawn(["docker", "image", "inspect", "turboclaw-worker:latest"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const checkExit = await checkProc.exited;
      if (checkExit === 0) {
        setBuildStatus("success");
        setBuildMessage("Worker image already exists.");
        setTimeout(() => setStep("whatsapp"), 500);
        return;
      }

      const { buildWorkerImage } = await import("../../container/builder");
      const result = await buildWorkerImage();
      if (result.success) {
        setBuildStatus("success");
        setBuildMessage("Worker image built successfully.");

        // Also create Docker network
        Bun.spawn(["docker", "network", "create", "turboclaw-net"], {
          stdout: "ignore",
          stderr: "ignore",
        });

        setTimeout(() => setStep("whatsapp"), 500);
      } else {
        setBuildStatus("error");
        setBuildMessage(`Image build failed. You can build it later with: bun run scripts/build-worker.ts`);
      }
    }

    buildImage();
  }, [step]);

  const handleProviderSelect = (value: string) => {
    setProvider(value);
    if (value === "claude-code") {
      // Claude Code needs an OAuth token or API key for containers
      setStep("oauth-token");
    } else if (value === "codex") {
      setCredCheckResult("checking");
      setStep("cred-check");
    } else if (OAUTH_PROVIDERS.has(value)) {
      setOauthStatus("running");
      setStep("oauth-flow");
    } else if (API_KEY_PROVIDERS.has(value)) {
      setStep("api-key");
    } else if (value === "ollama") {
      setStep("ollama-detect");
    } else if (value === "custom") {
      setStep("custom-url");
    }
  };

  const handleOauthToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Detect if it's an API key or OAuth token
    if (trimmed.startsWith("sk-ant-")) {
      config.provider = { type: "anthropic", apiKey: trimmed };
    } else {
      config.provider = { type: "claude-code", apiKey: trimmed };
    }
    config.agent = "claude-code";
    saveConfig(config);
    setStep("build-image");
  };

  const handleApiKey = (value: string) => {
    if (!value.trim()) return;
    config.provider = { type: provider, apiKey: value.trim() };
    saveConfig(config);
    setStep("build-image");
  };

  const handleCustomUrl = (value: string) => {
    if (!value.trim()) return;
    config.provider = { type: "custom", baseUrl: value.trim() };
    saveConfig(config);
    setStep("build-image");
  };

  const handleWhatsappChoice = (value: string) => {
    if (value === "yes") {
      setEnableWhatsapp(true);
      setStep("whatsapp-number");
    } else {
      setEnableWhatsapp(false);
      config.whatsapp = { enabled: false, allowedNumbers: [], notifyOnComplete: false, notifyOnFail: false };
      saveConfig(config);
      setStep("ready");
    }
  };

  const handlePhoneNumber = (value: string) => {
    const cleaned = value.trim().replace(/[^0-9]/g, "");
    if (!cleaned) return;
    setPhoneNumber(cleaned);
    config.whatsapp = {
      enabled: true,
      allowedNumbers: [cleaned],
      notifyOnComplete: true,
      notifyOnFail: true,
    };
    saveConfig(config);
    setStep("ready");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        TurboClaw Setup
      </Text>
      <Text dimColor>Get running in a few steps</Text>
      <Box marginTop={1} />

      {/* Step 1: Docker */}
      {step === "docker-check" && (
        <Box gap={1}>
          <Spinner label="Checking Docker..." />
        </Box>
      )}

      {dockerOk === false && (
        <Box flexDirection="column">
          <Text color="red">Docker is not running.</Text>
          <Text>Please start Docker and run `bun run src/index.ts setup` again.</Text>
        </Box>
      )}

      {/* Step 2: Provider */}
      {step === "provider" && (
        <Box flexDirection="column">
          <Text color="green">Docker is running.</Text>
          <Box marginTop={1} />
          <Text bold>Choose your AI provider:</Text>
          <Select options={PROVIDER_OPTIONS} onChange={handleProviderSelect} />
        </Box>
      )}

      {/* Claude Code: OAuth token or API key */}
      {step === "oauth-token" && (
        <Box flexDirection="column">
          <Text bold>Enter your Anthropic API key or Claude Code OAuth token:</Text>
          <Box marginTop={1} />
          <Text dimColor>To get an API key: https://console.anthropic.com/settings/keys</Text>
          <Text dimColor>To get an OAuth token: run `claude setup-token` in another terminal</Text>
          <Box marginTop={1} />
          <TextInput
            placeholder="sk-ant-... or oauth token"
            onSubmit={handleOauthToken}
          />
        </Box>
      )}

      {/* OAuth flow (Copilot, ChatGPT, Claude-sub) */}
      {step === "oauth-flow" && (
        <Box flexDirection="column">
          {oauthStatus === "running" && (
            <Spinner label={oauthMessage || "Authenticating..."} />
          )}
          {oauthStatus === "success" && (
            <Text color="green">{oauthMessage}</Text>
          )}
          {oauthStatus === "error" && (
            <Box flexDirection="column">
              <Text color="red">{oauthMessage}</Text>
              <Text dimColor>You can try again or choose a different provider.</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Credential check for Codex */}
      {step === "cred-check" && (
        <Box flexDirection="column">
          {credCheckResult === "checking" && (
            <Spinner label="Checking for ~/.codex/ credentials..." />
          )}
          {credCheckResult === "found" && (
            <Text color="green">Codex credentials found at ~/.codex/</Text>
          )}
          {credCheckResult === "missing" && (
            <Box flexDirection="column">
              <Text color="yellow">Credential directory not found: ~/.codex/</Text>
              <Text>Please run `codex auth` first, then re-run setup.</Text>
            </Box>
          )}
        </Box>
      )}

      {/* API key */}
      {step === "api-key" && (
        <Box flexDirection="column">
          <Text bold>Enter your {provider} API key:</Text>
          <TextInput
            placeholder="sk-..."
            onSubmit={handleApiKey}
          />
        </Box>
      )}

      {/* Ollama detection */}
      {step === "ollama-detect" && (
        <Box gap={1}>
          <Spinner label="Detecting Ollama at localhost:11434..." />
        </Box>
      )}

      {/* Custom URL */}
      {step === "custom-url" && (
        <Box flexDirection="column">
          <Text bold>Enter your provider base URL:</Text>
          <TextInput
            placeholder="https://api.example.com/v1"
            onSubmit={handleCustomUrl}
          />
        </Box>
      )}

      {/* Build Docker image */}
      {step === "build-image" && (
        <Box flexDirection="column">
          {buildStatus === "building" && (
            <Spinner label={buildMessage} />
          )}
          {buildStatus === "success" && (
            <Text color="green">{buildMessage}</Text>
          )}
          {buildStatus === "error" && (
            <Box flexDirection="column">
              <Text color="red">{buildMessage}</Text>
            </Box>
          )}
        </Box>
      )}

      {/* WhatsApp setup */}
      {step === "whatsapp" && (
        <Box flexDirection="column">
          <Text bold>Enable WhatsApp bridge?</Text>
          <Text dimColor>Control TurboClaw from WhatsApp: create tasks, check status, get notifications.</Text>
          <Box marginTop={1} />
          <Select
            options={[
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
            ]}
            onChange={handleWhatsappChoice}
          />
        </Box>
      )}

      {step === "whatsapp-number" && (
        <Box flexDirection="column">
          <Text bold>Enter your phone number (with country code, no + or spaces):</Text>
          <Text dimColor>Example: 14155551234</Text>
          <Box marginTop={1} />
          <TextInput
            placeholder="14155551234"
            onSubmit={handlePhoneNumber}
          />
        </Box>
      )}

      {/* Done */}
      {step === "ready" && (
        <Box flexDirection="column">
          <Text color="green" bold>Setup complete!</Text>
          <Box marginTop={1} />
          <Text>
            Provider: <Text color="cyan">{config.provider?.type ?? "none"}</Text>
            {config.agent && <Text dimColor> (agent: {config.agent})</Text>}
          </Text>
          {config.whatsapp.enabled && (
            <Text>
              WhatsApp: <Text color="green">enabled</Text>
              <Text dimColor> ({config.whatsapp.allowedNumbers.join(", ")})</Text>
            </Text>
          )}
          {ollamaModels.length > 0 && (
            <Text>
              Ollama models: <Text color="yellow">{ollamaModels.join(", ")}</Text>
            </Text>
          )}
          <Box marginTop={1} />
          <Text>Run `bun run src/index.ts` to launch TurboClaw.</Text>
          <Text dimColor>Or `bun run src/index.ts --headless` for API-only mode.</Text>
        </Box>
      )}
    </Box>
  );
}
