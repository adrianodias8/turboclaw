import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { Store } from "../../tracker/store";
import type { Event } from "../../tracker/types";

interface LogsProps {
  store: Store;
}

const KIND_COLORS: Record<string, string> = {
  stdout: "white",
  stderr: "red",
  status: "cyan",
  artifact: "green",
  error: "red",
  info: "blue",
};

export function Logs({ store }: LogsProps) {
  const [events, setEvents] = useState<(Event & { _taskTitle?: string })[]>([]);

  useEffect(() => {
    const refresh = () => {
      // Get recent runs and their events
      const tasks = store.listTasks({ limit: 10 });
      const allEvents: (Event & { _taskTitle?: string })[] = [];

      for (const task of tasks) {
        const run = store.getLatestRun(task.id);
        if (!run) continue;
        const runEvents = store.listEvents(run.id);
        for (const e of runEvents) {
          allEvents.push({ ...e, _taskTitle: task.title });
        }
      }

      allEvents.sort((a, b) => a.id - b.id);
      setEvents(allEvents.slice(-30));
    };

    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Live Event Stream</Text>
      </Box>

      {events.length === 0 ? (
        <Text dimColor>No events yet. Events appear when tasks run.</Text>
      ) : (
        <Box flexDirection="column">
          {events.map((e) => (
            <Box key={`${e.run_id}-${e.id}`} gap={1}>
              <Box width={8}>
                <Text color={KIND_COLORS[e.kind] ?? "white"}>[{e.kind}]</Text>
              </Box>
              {e._taskTitle && (
                <Box width={20}>
                  <Text dimColor>{e._taskTitle.slice(0, 18)}</Text>
                </Box>
              )}
              <Text>{e.payload}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
