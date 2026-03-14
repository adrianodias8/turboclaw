import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { TurboClawConfig } from "../../config";
import type { WhatsAppBridge, WhatsAppGroup } from "../../whatsapp/bridge";

interface SettingsProps {
  config: TurboClawConfig;
  updateConfig: (updater: (prev: TurboClawConfig) => TurboClawConfig) => void;
  whatsappBridge: WhatsAppBridge | null;
}

interface SettingItem {
  label: string;
  value: string;
  action: () => void;
  readOnly?: boolean;
}

type SubView = "main" | "groups";

export function Settings({ config, updateConfig, whatsappBridge }: SettingsProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [hint, setHint] = useState("");
  const [subView, setSubView] = useState<SubView>("main");

  // Group picker state
  const [availableGroups, setAvailableGroups] = useState<WhatsAppGroup[]>([]);
  const [groupSelectedIndex, setGroupSelectedIndex] = useState(0);
  const [loadingGroups, setLoadingGroups] = useState(false);

  const allowedGroupCount = config.whatsapp.allowedGroups?.length ?? 0;

  const items: SettingItem[] = [
    {
      label: "Gateway port",
      value: String(config.gateway.port),
      readOnly: true,
      action: () => setHint("Edit gateway.port in ~/.turboclaw/config.json"),
    },
    {
      label: "Max concurrency",
      value: String(config.orchestrator.maxConcurrency),
      action: () => {
        setHint("");
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
        setHint("");
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
        setHint("");
        updateConfig((c) => ({
          ...c,
          selfImprove: { enabled: !c.selfImprove.enabled },
        }));
      },
    },
    {
      label: "Provider",
      value: config.provider?.type ?? "not configured",
      readOnly: true,
      action: () => setHint("Run `bun run src/index.ts setup` to change provider"),
    },
    {
      label: "WhatsApp",
      value: config.whatsapp.enabled ? "ON" : "OFF",
      action: () => {
        setHint("");
        updateConfig((c) => ({
          ...c,
          whatsapp: { ...c.whatsapp, enabled: !c.whatsapp.enabled },
        }));
      },
    },
    {
      label: "WhatsApp groups",
      value: allowedGroupCount > 0 ? `${allowedGroupCount} group${allowedGroupCount !== 1 ? "s" : ""}` : "none",
      action: () => {
        if (!whatsappBridge || !whatsappBridge.isConnected()) {
          setHint("WhatsApp must be connected to manage groups");
          return;
        }
        setHint("");
        setLoadingGroups(true);
        whatsappBridge.getJoinedGroups().then((groups) => {
          setAvailableGroups(groups);
          setGroupSelectedIndex(0);
          setLoadingGroups(false);
          setSubView("groups");
        });
      },
    },
    {
      label: "Workspace root",
      value: config.workspaceRoot ?? process.cwd(),
      readOnly: true,
      action: () => setHint("Edit workspaceRoot in ~/.turboclaw/config.json"),
    },
    {
      label: "Agent type",
      value: config.agent ?? "opencode",
      action: () => {
        setHint("Switching agent may require a different Docker image");
        const agents = ["opencode", "claude-code", "codex"] as const;
        const current = config.agent ?? "opencode";
        const idx = agents.indexOf(current);
        const next = agents[(idx + 1) % agents.length]!;
        updateConfig((c) => ({ ...c, agent: next }));
      },
    },
  ];

  useInput((input, key) => {
    if (subView === "groups") {
      if (key.escape || input === "b") {
        setSubView("main");
        return;
      }
      if (key.upArrow) {
        setGroupSelectedIndex((i) => Math.max(0, i - 1));
      }
      if (key.downArrow) {
        setGroupSelectedIndex((i) => Math.min(availableGroups.length - 1, i + 1));
      }
      if (key.return || input === " ") {
        const group = availableGroups[groupSelectedIndex];
        if (!group) return;
        const allowed = config.whatsapp.allowedGroups ?? [];
        const isAllowed = allowed.includes(group.id);
        updateConfig((c) => ({
          ...c,
          whatsapp: {
            ...c.whatsapp,
            allowedGroups: isAllowed
              ? allowed.filter((id) => id !== group.id)
              : [...allowed, group.id],
          },
        }));
      }
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      setHint("");
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(items.length - 1, i + 1));
      setHint("");
    }
    if (key.return || input === " ") {
      items[selectedIndex]?.action();
    }
  });

  if (subView === "groups") {
    const allowed = config.whatsapp.allowedGroups ?? [];
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1} gap={2}>
          <Text bold color="cyan">WhatsApp Groups</Text>
          <Text dimColor>[Up/Down] navigate  [Enter/Space] toggle  [b] back</Text>
        </Box>

        {loadingGroups ? (
          <Text dimColor>Loading groups...</Text>
        ) : availableGroups.length === 0 ? (
          <Text dimColor>No groups found. Make sure your WhatsApp account is in at least one group.</Text>
        ) : (
          <Box flexDirection="column">
            {availableGroups.map((group, i) => {
              const isAllowed = allowed.includes(group.id);
              return (
                <Box key={group.id} gap={2}>
                  <Text color={i === groupSelectedIndex ? "cyan" : undefined} bold={i === groupSelectedIndex}>
                    {i === groupSelectedIndex ? "> " : "  "}
                    [{isAllowed ? "x" : " "}]
                  </Text>
                  <Text color={isAllowed ? "green" : undefined}>{group.subject}</Text>
                  <Text dimColor>({group.id})</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
    );
  }

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
            <Text color={item.readOnly ? "gray" : "yellow"}>{item.value}</Text>
          </Box>
        ))}
      </Box>

      {hint && (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}
