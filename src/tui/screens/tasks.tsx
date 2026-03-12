import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { Store } from "../../tracker/store";
import { useTaskList } from "../hooks/use-tracker";
import { TaskRow } from "../components/task-row";
import type { Screen } from "../components/nav";

interface TasksProps {
  store: Store;
  onNavigate: (screen: Screen, detail?: string) => void;
}

export function Tasks({ store, onNavigate }: TasksProps) {
  const { tasks, refresh } = useTaskList(store);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<"list" | "create">("list");
  const [newTitle, setNewTitle] = useState("");

  useInput(
    (input, key) => {
      if (mode !== "list") return;

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelectedIndex((i) => Math.min(tasks.length - 1, i + 1));
      } else if (key.return && tasks.length > 0) {
        const task = tasks[selectedIndex];
        if (task) onNavigate("tasks", task.id);
      } else if (input === "n") {
        setMode("create");
        setNewTitle("");
      } else if (input === "q") {
        const task = tasks[selectedIndex];
        if (task && task.status === "pending") {
          store.updateTaskStatus(task.id, "queued");
          refresh();
        }
      } else if (input === "x") {
        const task = tasks[selectedIndex];
        if (task) {
          store.cancelTask(task.id);
          refresh();
        }
      }
    }
  );

  const handleCreateSubmit = (value: string) => {
    if (value.trim()) {
      store.createTask({ title: value.trim() });
      refresh();
    }
    setMode("list");
    setNewTitle("");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Tasks</Text>
        <Text dimColor>
          [n] new  [q] queue  [x] cancel  [Enter] detail  [Up/Down] navigate
        </Text>
      </Box>

      {mode === "create" && (
        <Box marginBottom={1}>
          <Text color="cyan">Title: </Text>
          <TextInput
            placeholder="Task title..."
            onSubmit={handleCreateSubmit}
          />
        </Box>
      )}

      {tasks.length === 0 ? (
        <Text dimColor>No tasks. Press [n] to create one.</Text>
      ) : (
        <Box flexDirection="column">
          {tasks.map((task, i) => (
            <TaskRow key={task.id} task={task} selected={i === selectedIndex} />
          ))}
        </Box>
      )}
    </Box>
  );
}
