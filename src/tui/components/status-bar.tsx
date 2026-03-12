import React from "react";
import { Box, Text } from "ink";

interface StatusBarProps {
  queueDepth: number;
  activeWorkers: number;
  uptime: number;
  alertCount?: number;
  providerName?: string;
  whatsappEnabled?: boolean;
  whatsappConnected?: boolean;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function StatusBar({ queueDepth, activeWorkers, uptime, alertCount, providerName, whatsappEnabled, whatsappConnected }: StatusBarProps) {
  return (
    <Box borderStyle="single" borderTop borderBottom={false} borderLeft={false} borderRight={false} paddingX={1} justifyContent="space-between">
      <Text>
        <Text color="cyan">Queue:</Text> {queueDepth}
        {"  "}
        <Text color="cyan">Workers:</Text> {activeWorkers}
        {alertCount !== undefined && alertCount > 0 && (
          <>
            {"  "}
            <Text color="red" bold>Alerts: {alertCount}</Text>
          </>
        )}
      </Text>
      <Text>
        {providerName && (
          <>
            <Text color="cyan">Provider:</Text> {providerName}
            {"  "}
          </>
        )}
        <Text color="cyan">WA:</Text> {whatsappEnabled ? (whatsappConnected ? <Text color="green">connected</Text> : <Text color="yellow">connecting</Text>) : <Text dimColor>off</Text>}
        {"  "}
        <Text color="cyan">Uptime:</Text> {formatUptime(uptime)}
      </Text>
    </Box>
  );
}
