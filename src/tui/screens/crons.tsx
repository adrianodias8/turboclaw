import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { Store } from "../../tracker/store";
import { useCronList } from "../hooks/use-health";

interface CronsProps {
  store: Store;
}

type Mode = "list" | "create-name" | "create-schedule" | "create-title";

function formatTimestamp(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  return `${MM}/${DD} ${hh}:${mm}`;
}

export function Crons({ store }: CronsProps) {
  const crons = useCronList(store);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [newName, setNewName] = useState("");
  const [newSchedule, setNewSchedule] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const resetCreate = () => {
    setMode("list");
    setNewName("");
    setNewSchedule("");
    setNewTitle("");
  };

  useInput((input, key) => {
    if (mode !== "list") {
      if (key.escape) {
        resetCreate();
      }
      return;
    }

    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(crons.length - 1, i + 1));

    if (input === "n") {
      setMode("create-name");
      return;
    }

    if (key.return && crons[selectedIndex]) {
      const cron = crons[selectedIndex];
      store.updateCronEnabled(cron.id, !cron.enabled);
      return;
    }

    if (input === "d" && crons[selectedIndex]) {
      store.deleteCron(crons[selectedIndex].id);
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (input === "r" && crons[selectedIndex]) {
      const cron = crons[selectedIndex];
      try {
        const template = JSON.parse(cron.task_template) as {
          title?: string;
          description?: string;
          agentRole?: string;
          priority?: number;
        };
        const task = store.createTask({
          title: template.title ?? cron.name,
          description: template.description ?? null,
          agentRole: (template.agentRole as "coder") ?? "coder",
          priority: template.priority ?? 0,
        });
        store.updateTaskStatus(task.id, "queued");
      } catch {
        // invalid template, ignore
      }
      return;
    }
  });

  if (mode === "create-name") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">New Cron — Name</Text>
        <Box marginTop={1}>
          <Text>Name: </Text>
          <TextInput
            defaultValue={newName}
            onSubmit={(value: string) => {
              setNewName(value);
              setMode("create-schedule");
            }}
          />
        </Box>
        <Text dimColor>[Esc] cancel</Text>
      </Box>
    );
  }

  if (mode === "create-schedule") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">New Cron — Schedule</Text>
        <Text dimColor>e.g. */5 * * * * (every 5 min), 0 9 * * * (daily 9am)</Text>
        <Box marginTop={1}>
          <Text>Schedule: </Text>
          <TextInput
            defaultValue={newSchedule}
            onSubmit={(value: string) => {
              setNewSchedule(value);
              setMode("create-title");
            }}
          />
        </Box>
        <Text dimColor>[Esc] cancel</Text>
      </Box>
    );
  }

  if (mode === "create-title") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">New Cron — Task Title</Text>
        <Box marginTop={1}>
          <Text>Task title: </Text>
          <TextInput
            defaultValue={newTitle}
            onSubmit={(value: string) => {
              store.createCron({
                name: newName,
                schedule: newSchedule,
                taskTemplate: { title: value },
              });
              resetCreate();
            }}
          />
        </Box>
        <Text dimColor>[Esc] cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Crons</Text>
        <Text dimColor>[n] new  [Enter] toggle  [d] delete  [r] run now</Text>
      </Box>

      {crons.length === 0 ? (
        <Text dimColor>No crons configured. Press [n] to create one.</Text>
      ) : (
        <Box flexDirection="column">
          {crons.map((cron, i) => (
            <Box key={cron.id} gap={2}>
              <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                {i === selectedIndex ? "> " : "  "}
              </Text>
              <Box width={18}>
                <Text color={cron.enabled ? "green" : "gray"}>
                  {cron.one_shot ? (cron.enabled ? "scheduled" : "fired    ") : (cron.enabled ? "enabled  " : "disabled ")}
                </Text>
              </Box>
              <Box width={20}>
                <Text>{cron.name.slice(0, 18)}</Text>
              </Box>
              <Box width={18}>
                <Text dimColor>{cron.schedule}</Text>
              </Box>
              <Box width={16}>
                <Text dimColor>last: {formatTimestamp(cron.last_run_at)}</Text>
              </Box>
              <Box>
                <Text dimColor>next: {formatTimestamp(cron.next_run_at)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
