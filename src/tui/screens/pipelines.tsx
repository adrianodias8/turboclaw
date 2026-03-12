import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import type { Store } from "../../tracker/store";
import { usePipelineList } from "../hooks/use-tracker";

interface PipelinesProps {
  store: Store;
}

export function Pipelines({ store }: PipelinesProps) {
  const { pipelines, refresh } = usePipelineList(store);
  const [mode, setMode] = useState<"list" | "create">("list");
  const [newName, setNewName] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (mode !== "list") return;
    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(pipelines.length - 1, i + 1));
    if (input === "n") {
      setMode("create");
      setNewName("");
    }
  });

  const handleSubmit = (value: string) => {
    if (value.trim()) {
      store.createPipeline({ name: value.trim(), stages: [] });
      refresh();
    }
    setMode("list");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Pipelines</Text>
        <Text dimColor>[n] new pipeline</Text>
      </Box>

      {mode === "create" && (
        <Box marginBottom={1}>
          <Text color="cyan">Name: </Text>
          <TextInput placeholder="Pipeline name..." onSubmit={handleSubmit} />
        </Box>
      )}

      {pipelines.length === 0 ? (
        <Text dimColor>No pipelines yet. Press [n] to create one.</Text>
      ) : (
        <Box flexDirection="column">
          {pipelines.map((p, i) => {
            const stages = JSON.parse(p.stages) as unknown[];
            return (
              <Box key={p.id} gap={2}>
                <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                  {i === selectedIndex ? "> " : "  "}
                  {p.name}
                </Text>
                <Text dimColor>({stages.length} stages)</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
