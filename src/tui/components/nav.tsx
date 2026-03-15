import React from "react";
import { Box, Text } from "ink";

export type Screen = "dashboard" | "tasks" | "crons" | "alerts" | "logs" | "settings" | "memory";

const TABS: { key: Screen; label: string; shortcut: string }[] = [
  { key: "dashboard", label: "Dashboard", shortcut: "1" },
  { key: "tasks", label: "Tasks", shortcut: "2" },
  { key: "crons", label: "Crons", shortcut: "3" },
  { key: "memory", label: "Memory", shortcut: "4" },
  { key: "alerts", label: "Alerts", shortcut: "5" },
  { key: "logs", label: "Logs", shortcut: "6" },
  { key: "settings", label: "Settings", shortcut: "7" },
];

interface NavProps {
  active: Screen;
}

export function Nav({ active }: NavProps) {
  return (
    <Box borderStyle="single" borderBottom borderLeft={false} borderRight={false} borderTop={false} paddingX={1}>
      {TABS.map((tab, i) => (
        <Box key={tab.key} marginRight={2}>
          <Text color={active === tab.key ? "cyan" : "gray"} bold={active === tab.key}>
            [{tab.shortcut}] {tab.label}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
