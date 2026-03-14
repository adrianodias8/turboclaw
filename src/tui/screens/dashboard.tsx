import React from "react";
import { Box, Text } from "ink";
import type { Store } from "../../tracker/store";
import { useTaskList } from "../hooks/use-tracker";
import { useHealthStatus, useActiveRuns, useAlertCount, useCronList } from "../hooks/use-health";

interface DashboardProps {
  store: Store;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "yellow",
  queued: "blue",
  running: "cyan",
  done: "green",
  failed: "red",
  cancelled: "gray",
};

function formatElapsed(startedAt: number): string {
  const now = Math.floor(Date.now() / 1000);
  const elapsed = now - startedAt;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function Dashboard({ store }: DashboardProps) {
  const health = useHealthStatus(store);
  const activeRuns = useActiveRuns(store);
  const alertCount = useAlertCount(store);
  const crons = useCronList(store);
  const { tasks: recentDone } = useTaskList(store, { status: "done", limit: 5 });

  const enabledCrons = crons
    .filter((c) => c.enabled)
    .sort((a, b) => (a.next_run_at ?? Infinity) - (b.next_run_at ?? Infinity))
    .slice(0, 3);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        TurboClaw Dashboard
      </Text>

      <Box marginTop={1} flexDirection="row" gap={4}>
        {/* Left column */}
        <Box flexDirection="column" width="50%">
          <Text bold underline>Health</Text>
          <Box flexDirection="column" marginTop={0}>
            <Text>
              <Text color="cyan">Queue depth:</Text> {health.queueDepth}
            </Text>
            <Text>
              <Text color="cyan">Active workers:</Text> {health.activeWorkers}
            </Text>
            <Text>
              <Text color="red">Failed:</Text> {health.failedCount}
            </Text>
            <Text>
              <Text color="cyan">Running:</Text> {health.runningCount}
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold underline>Active Runs</Text>
            {activeRuns.length === 0 ? (
              <Text dimColor>No active runs</Text>
            ) : (
              activeRuns.map((run) => (
                <Box key={run.id} gap={2}>
                  <Text color="cyan">{run.task_id.slice(0, 8)}</Text>
                  <Text dimColor>{formatElapsed(run.started_at)}</Text>
                </Box>
              ))
            )}
          </Box>
        </Box>

        {/* Right column */}
        <Box flexDirection="column" width="50%">
          <Text bold underline>Recent Completions</Text>
          {recentDone.length === 0 ? (
            <Text dimColor>No completed tasks yet</Text>
          ) : (
            recentDone.map((t) => (
              <Box key={t.id} gap={2}>
                <Text color="green">{STATUS_COLORS[t.status] ? t.status : t.status}</Text>
                <Text>{t.title.slice(0, 40)}</Text>
              </Box>
            ))
          )}

          <Box marginTop={1} flexDirection="column">
            <Text bold underline>Upcoming Crons</Text>
            {enabledCrons.length === 0 ? (
              <Text dimColor>No crons configured</Text>
            ) : (
              enabledCrons.map((c) => (
                <Box key={c.id} gap={2}>
                  <Text>{c.name}</Text>
                  <Text dimColor>next: {formatTimestamp(c.next_run_at)}</Text>
                </Box>
              ))
            )}
          </Box>

          <Box marginTop={1}>
            {alertCount > 0 ? (
              <Text color="red" bold>
                {alertCount} unacknowledged alert{alertCount !== 1 ? "s" : ""} — press [5]
              </Text>
            ) : (
              <Text dimColor>No alerts</Text>
            )}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
