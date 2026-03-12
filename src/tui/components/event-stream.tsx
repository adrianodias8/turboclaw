import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { Store } from "../../tracker/store";
import type { Event } from "../../tracker/types";

const KIND_COLORS: Record<string, string> = {
  stdout: "white",
  stderr: "red",
  status: "cyan",
  artifact: "green",
  error: "red",
  info: "blue",
};

interface EventStreamProps {
  store: Store;
  runId: string;
  maxLines?: number;
}

export function EventStream({ store, runId, maxLines = 20 }: EventStreamProps) {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const refresh = () => {
      const all = store.listEvents(runId);
      setEvents(all.slice(-maxLines));
    };
    refresh();
    const interval = setInterval(refresh, 1000);
    return () => clearInterval(interval);
  }, [store, runId, maxLines]);

  if (events.length === 0) {
    return (
      <Box>
        <Text dimColor>No events yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {events.map((e) => (
        <Box key={e.id}>
          <Box width={8}>
            <Text color={KIND_COLORS[e.kind] ?? "white"}>[{e.kind}]</Text>
          </Box>
          <Text> {e.payload}</Text>
        </Box>
      ))}
    </Box>
  );
}
