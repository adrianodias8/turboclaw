import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";
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
  const [scrollTop, setScrollTop] = useState(0);
  const [followTail, setFollowTail] = useState(true);
  const { stdout } = useStdout();

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
      setEvents(allEvents.slice(-200));
    };

    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);

  const columns = stdout.columns ?? 80;
  const rows = stdout.rows ?? 24;
  const contentWidth = Math.max(24, columns - 4);
  const reservedLines = 8;
  const visibleCount = Math.max(4, rows - reservedLines);

  const lines = useMemo(() => {
    const kindWidth = 10;
    const titleWidth = 20;
    const payloadWidth = Math.max(8, contentWidth - kindWidth - titleWidth - 2);

    return events.map((event) => {
      const kind = `[${event.kind}]`.padEnd(kindWidth, " ");
      const title = truncate((event._taskTitle ?? "-").replace(/\s+/g, " "), titleWidth - 1).padEnd(titleWidth, " ");
      const payload = truncate(event.payload.replace(/\s+/g, " "), payloadWidth);
      return `${kind} ${title} ${payload}`;
    });
  }, [contentWidth, events]);

  const maxScrollTop = Math.max(0, lines.length - visibleCount);

  useEffect(() => {
    if (followTail) {
      setScrollTop(maxScrollTop);
      return;
    }
    setScrollTop((current) => Math.min(current, maxScrollTop));
  }, [maxScrollTop, followTail]);

  useInput((input, key) => {
    if (key.upArrow) {
      setFollowTail(false);
      setScrollTop((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setScrollTop((current) => {
        const next = Math.min(maxScrollTop, current + 1);
        if (next === maxScrollTop) {
          setFollowTail(true);
        }
        return next;
      });
      return;
    }

    if (input === "f") {
      setFollowTail(true);
      setScrollTop(maxScrollTop);
    }
  });

  const visibleLines = lines.slice(scrollTop, scrollTop + visibleCount);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Live Event Stream</Text>
        <Text dimColor>[Up/Down] scroll  [f] follow live</Text>
      </Box>

      {events.length === 0 ? (
        <Text dimColor>No events yet. Events appear when tasks run.</Text>
      ) : (
        <Box flexDirection="column">
          {visibleLines.map((line, index) => {
            const event = events[scrollTop + index];
            if (!event) {
              return null;
            }
            return (
              <Text key={`${event.run_id}-${event.id}`} color={KIND_COLORS[event.kind] ?? "white"}>
                {line}
              </Text>
            );
          })}
          <Text dimColor>
            {followTail ? "Following latest events" : `Viewing ${scrollTop + 1}-${Math.min(lines.length, scrollTop + visibleCount)} of ${lines.length}`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  if (max <= 3) {
    return value.slice(0, max);
  }
  return `${value.slice(0, max - 3)}...`;
}
