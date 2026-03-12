import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Store } from "../../tracker/store";
import { useAlertList } from "../hooks/use-health";
import type { AlertKind } from "../../tracker/types";

interface AlertsProps {
  store: Store;
}

const ALERT_COLORS: Record<AlertKind, string> = {
  task_failed: "red",
  lease_expired: "yellow",
  whatsapp_disconnect: "magenta",
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function Alerts({ store }: AlertsProps) {
  const { alerts, refresh } = useAlertList(store);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const unacked = alerts.filter((a) => !a.acknowledged);

  useInput((input, key) => {
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(unacked.length - 1, i + 1));

    if (key.return && unacked[selectedIndex]) {
      store.acknowledgeAlert(unacked[selectedIndex].id);
      refresh();
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (input === "a") {
      store.acknowledgeAllAlerts();
      refresh();
      setSelectedIndex(0);
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Alerts</Text>
        <Text dimColor>[Enter] acknowledge  [a] acknowledge all</Text>
      </Box>

      {unacked.length === 0 ? (
        <Text dimColor>No unacknowledged alerts.</Text>
      ) : (
        <Box flexDirection="column">
          {unacked.map((alert, i) => (
            <Box key={alert.id} gap={2}>
              <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                {i === selectedIndex ? "> " : "  "}
              </Text>
              <Box width={10}>
                <Text color={ALERT_COLORS[alert.kind] ?? "white"}>
                  {alert.kind.replace(/_/g, " ")}
                </Text>
              </Box>
              <Box width={10}>
                <Text dimColor>{formatTimestamp(alert.created_at)}</Text>
              </Box>
              {alert.task_id && (
                <Box width={10}>
                  <Text dimColor>task:{alert.task_id.slice(0, 8)}</Text>
                </Box>
              )}
              <Text>{alert.message}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
