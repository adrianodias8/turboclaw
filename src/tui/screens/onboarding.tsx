import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Select, TextInput, Spinner } from "@inkjs/ui";
import { existsSync } from "fs";
import { join } from "path";
import type { TurboClawConfig } from "../../config";
import { saveConfig } from "../../config";
import { initVault } from "../../memory/vault";
import { createCoreNote } from "../../memory/writer";
import { QRDisplay } from "../components/qr-display";

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
  | "agent-select"
  | "workspace-root"
  | "build-image"
  | "whatsapp"
  | "whatsapp-method"
  | "whatsapp-number"
  | "whatsapp-pair"
  | "core-name"
  | "core-role"
  | "core-context"
  | "core-prefs"
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
  const [coreName, setCoreName] = useState("");
  const [coreRole, setCoreRole] = useState("");
  const [coreContext, setCoreContext] = useState("");
  const [waQR, setWaQR] = useState<string | null>(null);
  const [waPairingCode, setWaPairingCode] = useState<string | null>(null);
  const [waStatus, setWaStatus] = useState<"connecting" | "connected" | "error">("connecting");
  const [waError, setWaError] = useState("");

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
          setTimeout(() => setStep("agent-select"), 500);
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
          setTimeout(() => setStep("agent-select"), 500);
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
          setTimeout(() => setStep("agent-select"), 500);
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
      saveConfig(config);
      setTimeout(() => setStep("agent-select"), 500);
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
        setStep("agent-select");
      } catch {
        setOllamaModels([]);
        config.provider = { type: "ollama", baseUrl: "http://host.docker.internal:11434" };
        saveConfig(config);
        setStep("agent-select");
      }
    }

    detectOllama();
  }, [step]);

  const suggestAgent = (providerType: string | undefined): "opencode" | "claude-code" | "codex" => {
    switch (providerType) {
      case "claude-code": return "claude-code";
      case "codex": return "codex";
      default: return "opencode";
    }
  };

  const AGENT_OPTIONS = [
    { label: "OpenCode (recommended — multi-provider, browser, skills)", value: "opencode" },
    { label: "Claude Code (Anthropic only)", value: "claude-code" },
    { label: "Codex (OpenAI only)", value: "codex" },
  ];

  const handleAgentSelect = (value: string) => {
    config.agent = value as "opencode" | "claude-code" | "codex";
    saveConfig(config);
    setStep("workspace-root");
  };

  const handleWorkspaceRoot = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      config.workspaceRoot = trimmed;
    }
    // If empty, defaults to cwd at runtime
    saveConfig(config);
    setStep("build-image");
  };

  // Build Docker image
  useEffect(() => {
    if (step !== "build-image") return;

    async function doBuild() {
      const selectedAgent = config.agent ?? "opencode";
      const isOpenCode = selectedAgent === "opencode";
      const imageTag = isOpenCode ? "turboclaw-opencode:latest" : "turboclaw-worker:latest";

      setBuildStatus("building");
      setBuildMessage(`Building ${isOpenCode ? "OpenCode" : "worker"} Docker image (this may take a minute)...`);

      // Check if image already exists
      const checkProc = Bun.spawn(["docker", "image", "inspect", imageTag], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const checkExit = await checkProc.exited;
      if (checkExit === 0) {
        setBuildStatus("success");
        setBuildMessage(`${isOpenCode ? "OpenCode" : "Worker"} image already exists.`);
        setTimeout(() => setStep("whatsapp"), 500);
        return;
      }

      if (isOpenCode) {
        const { buildOpenCodeImage } = await import("../../container/builder");
        const result = await buildOpenCodeImage();
        if (result.success) {
          setBuildStatus("success");
          setBuildMessage("OpenCode image built successfully.");
          Bun.spawn(["docker", "network", "create", "turboclaw-net"], { stdout: "ignore", stderr: "ignore" });
          setTimeout(() => setStep("whatsapp"), 500);
        } else {
          setBuildStatus("error");
          setBuildMessage("Image build failed. You can build it later with: docker build -t turboclaw-opencode:latest -f docker/Dockerfile.opencode docker/");
        }
      } else {
        const { buildWorkerImage } = await import("../../container/builder");
        const result = await buildWorkerImage();
        if (result.success) {
          setBuildStatus("success");
          setBuildMessage("Worker image built successfully.");
          Bun.spawn(["docker", "network", "create", "turboclaw-net"], { stdout: "ignore", stderr: "ignore" });
          setTimeout(() => setStep("whatsapp"), 500);
        } else {
          setBuildStatus("error");
          setBuildMessage("Image build failed. You can build it later with: bun run scripts/build-worker.ts");
        }
      }
    }

    doBuild();
  }, [step]);

  // WhatsApp pairing: start bridge and show QR/pairing code
  useEffect(() => {
    if (step !== "whatsapp-pair") return;

    let bridge: { stop(): void; isConnected(): boolean } | null = null;
    let settled = false;

    async function startPairing() {
      try {
        const { createStore } = await import("../../tracker/store");
        const { Database } = await import("bun:sqlite");
        const db = new Database(join(config.home, "turboclaw.db"));
        const store = createStore(db);

        const { startWhatsAppBridge } = await import("../../whatsapp/bridge");
        bridge = await startWhatsAppBridge(store, config, {
          onQR: (qr) => {
            setWaQR(qr);
          },
          onPairingCode: (code) => {
            setWaPairingCode(code);
          },
        });

        // Poll for connection
        const checkInterval = setInterval(() => {
          if (settled) { clearInterval(checkInterval); return; }
          if (bridge && bridge.isConnected()) {
            settled = true;
            clearInterval(checkInterval);
            setWaStatus("connected");
            setTimeout(() => setStep("core-name"), 1000);
          }
        }, 1000);

        // Timeout after 2 minutes
        setTimeout(() => {
          if (!settled) {
            settled = true;
            clearInterval(checkInterval);
            setWaStatus("error");
            setWaError("Pairing timed out. Press [s] to skip and pair later.");
          }
        }, 120000);
      } catch (err) {
        if (!settled) {
          settled = true;
          setWaStatus("error");
          setWaError(String(err));
        }
      }
    }

    startPairing();
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
    saveConfig(config);
    setStep("agent-select");
  };

  const handleApiKey = (value: string) => {
    if (!value.trim()) return;
    config.provider = { type: provider, apiKey: value.trim() };
    saveConfig(config);
    setStep("agent-select");
  };

  const handleCustomUrl = (value: string) => {
    if (!value.trim()) return;
    config.provider = { type: "custom", baseUrl: value.trim() };
    saveConfig(config);
    setStep("agent-select");
  };

  const handleWhatsappChoice = (value: string) => {
    if (value === "yes") {
      setEnableWhatsapp(true);
      setStep("whatsapp-method");
    } else {
      setEnableWhatsapp(false);
      config.whatsapp = { enabled: false, allowedNumbers: [], notifyOnComplete: false, notifyOnFail: false };
      saveConfig(config);
      setStep("core-name");
    }
  };

  const [waPairMethod, setWaPairMethod] = useState<"phone" | "qr">("phone");

  const handleWhatsappMethod = (value: string) => {
    if (value === "phone") {
      setWaPairMethod("phone");
      setStep("whatsapp-number");
    } else {
      // QR code method — no phone number needed, skip to pairing
      setWaPairMethod("qr");
      config.whatsapp = {
        enabled: true,
        allowedNumbers: [],
        notifyOnComplete: true,
        notifyOnFail: true,
      };
      saveConfig(config);
      setWaStatus("connecting");
      setWaQR(null);
      setWaPairingCode(null);
      setWaError("");
      setStep("whatsapp-pair");
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
    setWaStatus("connecting");
    setWaQR(null);
    setWaPairingCode(null);
    setWaError("");
    setStep("whatsapp-pair");
  };

  const vaultPath = join(config.home, "memory");

  const handleCoreName = (value: string) => {
    initVault({ vaultPath });
    const trimmed = value.trim();
    if (trimmed) {
      setCoreName(trimmed);
      createCoreNote(vaultPath, "user-name", "User Name", trimmed, ["core", "identity"]);
    }
    setStep("core-role");
  };

  const handleCoreRole = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      setCoreRole(trimmed);
      createCoreNote(vaultPath, "user-role", "User Role", trimmed, ["core", "identity"]);
    }
    setStep("core-context");
  };

  const handleCoreContext = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      setCoreContext(trimmed);
      createCoreNote(vaultPath, "project-context", "Project Context", trimmed, ["core", "project"]);
    }
    setStep("core-prefs");
  };

  const handleCorePrefs = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      createCoreNote(vaultPath, "preferences", "Preferences", trimmed, ["core", "preferences"]);
    }
    setStep("ready");
  };

  // Handle key presses for error recovery and ready step
  useInput((input, key) => {
    if (step === "ready" && key.return) {
      onComplete();
    }
    // WhatsApp pairing: press 's' to skip
    if (step === "whatsapp-pair" && (input === "s" || input === "r")) {
      if (input === "s") {
        setStep("core-name");
      } else if (waStatus === "error") {
        setWaStatus("connecting");
        setWaQR(null);
        setWaPairingCode(null);
        setWaError("");
        setStep("whatsapp-pair");
      }
    }
    // Error recovery: press 'r' to retry, 'b' to go back to provider selection
    if (input === "r" || input === "b") {
      if (step === "docker-check" && dockerOk === false) {
        setDockerOk(null);
        setStep("docker-check");
      }
      if (step === "oauth-flow" && oauthStatus === "error") {
        if (input === "r") {
          setOauthStatus("running");
          setOauthMessage("");
          setStep("oauth-flow");
        } else {
          setStep("provider");
        }
      }
      if (step === "cred-check" && credCheckResult === "missing") {
        if (input === "r") {
          setCredCheckResult("checking");
          setStep("cred-check");
        } else {
          setStep("provider");
        }
      }
      if (step === "build-image" && buildStatus === "error") {
        if (input === "r") {
          setBuildStatus("building");
          setBuildMessage("");
          setStep("build-image");
        } else {
          setStep("agent-select");
        }
      }
    }
  });

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
          <Text>Please start Docker, then press [r] to retry.</Text>
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
              <Text dimColor>Press [r] to retry or [b] to go back to provider selection.</Text>
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
              <Text>Run `codex auth` first, then press [r] to retry or [b] to go back.</Text>
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

      {/* Agent selection */}
      {step === "agent-select" && (
        <Box flexDirection="column">
          <Text bold>Which agent should run your tasks?</Text>
          <Text dimColor>
            Suggested: <Text color="cyan">{suggestAgent(config.provider?.type)}</Text> based on your provider
          </Text>
          <Box marginTop={1} />
          <Select options={AGENT_OPTIONS} onChange={handleAgentSelect} />
        </Box>
      )}

      {/* Workspace root */}
      {step === "workspace-root" && (
        <Box flexDirection="column">
          <Text bold>Project directory to mount as workspace:</Text>
          <Text dimColor>The agent will work on files in this directory. Press Enter to use current directory.</Text>
          <Text dimColor>Current: {process.cwd()}</Text>
          <Box marginTop={1}>
            <TextInput placeholder={process.cwd()} onSubmit={handleWorkspaceRoot} />
          </Box>
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
              <Text dimColor>Press [r] to retry or [b] to go back to agent selection.</Text>
            </Box>
          )}
        </Box>
      )}

      {/* WhatsApp setup */}
      {step === "whatsapp" && (
        <Box flexDirection="column">
          <Text bold>Enable WhatsApp bridge?</Text>
          <Text dimColor>Control TurboClaw from WhatsApp: create tasks, check status, get notifications.</Text>
          <Text dimColor>Works with personal chats and groups.</Text>
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

      {/* WhatsApp pairing method */}
      {step === "whatsapp-method" && (
        <Box flexDirection="column">
          <Text bold>How do you want to pair WhatsApp?</Text>
          <Box marginTop={1} />
          <Select
            options={[
              { label: "Phone number (pairing code — easiest)", value: "phone" },
              { label: "QR code (scan from WhatsApp)", value: "qr" },
            ]}
            onChange={handleWhatsappMethod}
          />
        </Box>
      )}

      {step === "whatsapp-number" && (
        <Box flexDirection="column">
          <Text bold>Enter your phone number (with country code, no + or spaces):</Text>
          <Text dimColor>Example: 14155551234</Text>
          <Text dimColor>This will be used for pairing and as the allowed sender.</Text>
          <Box marginTop={1} />
          <TextInput
            placeholder="14155551234"
            onSubmit={handlePhoneNumber}
          />
        </Box>
      )}

      {/* WhatsApp pairing */}
      {step === "whatsapp-pair" && (
        <Box flexDirection="column">
          {waStatus === "connecting" && (
            <Box flexDirection="column">
              <Spinner label="Connecting to WhatsApp..." />
              <Box marginTop={1} />

              {waPairingCode && (
                <Box flexDirection="column">
                  <Text bold color="green">Pairing code: <Text color="cyan">{waPairingCode}</Text></Text>
                  <Box marginTop={1} />
                  <Text>Open WhatsApp on your phone:</Text>
                  <Text dimColor>  Settings → Linked Devices → Link a Device → Link with phone number</Text>
                  <Text dimColor>  Enter the code above.</Text>
                </Box>
              )}

              {waQR && !waPairingCode && (
                <Box flexDirection="column">
                  <QRDisplay qr={waQR} />
                  <Text dimColor>Open WhatsApp → Linked Devices → Link a Device → Scan QR</Text>
                </Box>
              )}

              {!waPairingCode && !waQR && (
                <Text dimColor>Waiting for pairing code or QR code...</Text>
              )}
            </Box>
          )}

          {waStatus === "connected" && (
            <Text color="green" bold>WhatsApp connected successfully!</Text>
          )}

          {waStatus === "error" && (
            <Box flexDirection="column">
              <Text color="red">WhatsApp pairing failed: {waError}</Text>
              <Text dimColor>Press [r] to retry or [s] to skip and pair later.</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Core Memory: Name */}
      {step === "core-name" && (
        <Box flexDirection="column">
          <Text bold>What's your name?</Text>
          <Text dimColor>This helps agents address you. Press Enter to skip.</Text>
          <Box marginTop={1}>
            <TextInput placeholder="Your name" onSubmit={handleCoreName} />
          </Box>
        </Box>
      )}

      {/* Core Memory: Role */}
      {step === "core-role" && (
        <Box flexDirection="column">
          <Text bold>What's your role?</Text>
          <Text dimColor>e.g. Senior Developer, Data Scientist. Press Enter to skip.</Text>
          <Box marginTop={1}>
            <TextInput placeholder="Your role" onSubmit={handleCoreRole} />
          </Box>
        </Box>
      )}

      {/* Core Memory: Project Context */}
      {step === "core-context" && (
        <Box flexDirection="column">
          <Text bold>Describe your project:</Text>
          <Text dimColor>Brief description of what you're working on. Press Enter to skip.</Text>
          <Box marginTop={1}>
            <TextInput placeholder="Project description" onSubmit={handleCoreContext} />
          </Box>
        </Box>
      )}

      {/* Core Memory: Preferences */}
      {step === "core-prefs" && (
        <Box flexDirection="column">
          <Text bold>Any preferences for how agents should work?</Text>
          <Text dimColor>e.g. "Always use TypeScript", "Prefer functional style". Press Enter to skip.</Text>
          <Box marginTop={1}>
            <TextInput placeholder="Preferences (optional)" onSubmit={handleCorePrefs} />
          </Box>
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
          <Text>
            Workspace: <Text color="cyan">{config.workspaceRoot ?? process.cwd()}</Text>
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
          {coreName && (
            <Text>
              Name: <Text color="cyan">{coreName}</Text>
            </Text>
          )}
          {coreRole && (
            <Text>
              Role: <Text color="cyan">{coreRole}</Text>
            </Text>
          )}
          {coreContext && (
            <Text>
              Project: <Text color="cyan">{coreContext.slice(0, 60)}{coreContext.length > 60 ? "..." : ""}</Text>
            </Text>
          )}
          <Box marginTop={1} />
          <Text bold>Press Enter to continue.</Text>
        </Box>
      )}
    </Box>
  );
}
