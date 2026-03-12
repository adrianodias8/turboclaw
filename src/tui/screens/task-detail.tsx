import React from "react";
import { Box, Text, useInput } from "ink";
import type { Store } from "../../tracker/store";
import { useTask } from "../hooks/use-tracker";
import { EventStream } from "../components/event-stream";
import type { Screen } from "../components/nav";

interface TaskDetailProps {
  store: Store;
  taskId: string;
  onNavigate: (screen: Screen) => void;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "yellow",
  queued: "blue",
  running: "cyan",
  done: "green",
  failed: "red",
  cancelled: "gray",
};

export function TaskDetail({ store, taskId, onNavigate }: TaskDetailProps) {
  const { task, refresh } = useTask(store, taskId);
  const latestRun = task ? store.getLatestRun(task.id) : null;

  useInput((input, key) => {
    if (key.escape || input === "b") {
      onNavigate("tasks");
    } else if (input === "r" && task && (task.status === "failed" || task.status === "cancelled")) {
      store.updateTaskStatus(task.id, "queued");
      refresh();
    } else if (input === "x" && task) {
      store.cancelTask(task.id);
      refresh();
    }
  });

  if (!task) {
    return (
      <Box padding={1}>
        <Text color="red">Task not found.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Task Detail</Text>
        <Text dimColor>
          [b/Esc] back  [r] retry  [x] cancel
        </Text>
      </Box>

      <Box flexDirection="column" gap={0}>
        <Text>
          <Text bold>Title: </Text>{task.title}
        </Text>
        <Text>
          <Text bold>ID: </Text><Text dimColor>{task.id}</Text>
        </Text>
        <Text>
          <Text bold>Status: </Text>
          <Text color={STATUS_COLORS[task.status]}>{task.status}</Text>
        </Text>
        <Text>
          <Text bold>Role: </Text>{task.agent_role}
        </Text>
        <Text>
          <Text bold>Priority: </Text>{task.priority}
        </Text>
        <Text>
          <Text bold>Retries: </Text>{task.retry_count}/{task.max_retries}
        </Text>
        {task.description && (
          <Text>
            <Text bold>Description: </Text>{task.description}
          </Text>
        )}
      </Box>

      {latestRun && (
        <Box marginTop={1} flexDirection="column">
          <Text bold underline>Latest Run — {latestRun.status}</Text>
          <EventStream store={store} runId={latestRun.id} />
        </Box>
      )}

      {!latestRun && (
        <Box marginTop={1}>
          <Text dimColor>No runs yet.</Text>
        </Box>
      )}
    </Box>
  );
}
