import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { TurboClawConfig } from "../../config";

interface SettingsProps {
  config: TurboClawConfig;
  updateConfig: (updater: (prev: TurboClawConfig) => TurboClawConfig) => void;
}

interface SettingItem {
  label: string;
  value: string;
  action: () => void;
}

export function Settings({ config, updateConfig }: SettingsProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const items: SettingItem[] = [
    {
      label: "Gateway port",
      value: String(config.gateway.port),
      action: () => {},
    },
    {
      label: "Max concurrency",
      value: String(config.orchestrator.maxConcurrency),
      action: () => {
        updateConfig((c) => ({
          ...c,
          orchestrator: {
            ...c.orchestrator,
            maxConcurrency: c.orchestrator.maxConcurrency >= 8 ? 1 : c.orchestrator.maxConcurrency + 1,
          },
        }));
      },
    },
    {
      label: "Scheduling strategy",
      value: config.orchestrator.schedulingStrategy,
      action: () => {
        const strategies = ["fifo", "priority", "round-robin"] as const;
        const idx = strategies.indexOf(config.orchestrator.schedulingStrategy);
        const next = strategies[(idx + 1) % strategies.length]!;
        updateConfig((c) => ({
          ...c,
          orchestrator: { ...c.orchestrator, schedulingStrategy: next },
        }));
      },
    },
    {
      label: "Self-improve mode",
      value: config.selfImprove.enabled ? "ON" : "OFF",
      action: () => {
        updateConfig((c) => ({
          ...c,
          selfImprove: { enabled: !c.selfImprove.enabled },
        }));
      },
    },
    {
      label: "Provider",
      value: config.provider?.type ?? "not configured",
      action: () => {},
    },
    {
      label: "WhatsApp",
      value: config.whatsapp.enabled ? "ON" : "OFF",
      action: () => {
        updateConfig((c) => ({
          ...c,
          whatsapp: { ...c.whatsapp, enabled: !c.whatsapp.enabled },
        }));
      },
    },
    {
      label: "Agent type",
      value: config.agent ?? "opencode",
      action: () => {
        const agents = ["opencode", "claude-code", "codex"] as const;
        const current = config.agent ?? "opencode";
        const idx = agents.indexOf(current);
        const next = agents[(idx + 1) % agents.length]!;
        updateConfig((c) => ({ ...c, agent: next }));
      },
    },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
    if (key.return || input === " ") {
      items[selectedIndex]?.action();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Settings</Text>
        <Text dimColor>[Up/Down] navigate  [Enter/Space] toggle</Text>
      </Box>

      <Box flexDirection="column">
        {items.map((item, i) => (
          <Box key={item.label} gap={2}>
            <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
              {i === selectedIndex ? "> " : "  "}
              {item.label}:
            </Text>
            <Text color="yellow">{item.value}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
