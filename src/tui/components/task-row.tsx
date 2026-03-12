import React from "react";
import { Box, Text } from "ink";
import type { Task } from "../../tracker/types";

const STATUS_COLORS: Record<string, string> = {
  pending: "yellow",
  queued: "blue",
  running: "cyan",
  done: "green",
  failed: "red",
  cancelled: "gray",
};

interface TaskRowProps {
  task: Task;
  selected: boolean;
}

export function TaskRow({ task, selected }: TaskRowProps) {
  const color = STATUS_COLORS[task.status] ?? "white";
  return (
    <Box>
      <Text color={selected ? "cyan" : undefined} bold={selected}>
        {selected ? "> " : "  "}
      </Text>
      <Box width={10}>
        <Text color={color}>{task.status.toUpperCase().padEnd(9)}</Text>
      </Box>
      <Box width={6}>
        <Text dimColor>P{task.priority}</Text>
      </Box>
      <Box width={10}>
        <Text color="gray">{task.agent_role}</Text>
      </Box>
      <Text>{task.title}</Text>
    </Box>
  );
}
