import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Store } from "../../tracker/store";
import type { Experiment } from "../../tracker/types";
import { formatTimestamp } from "../constants";

interface ExperimentsProps {
  store: Store;
}

const STATUS_COLORS: Record<string, string> = {
  keep: "green",
  discard: "gray",
  crash: "red",
  regression: "yellow",
};

type View = "sessions" | "detail";

export function Experiments({ store }: ExperimentsProps) {
  const [view, setView] = useState<View>("sessions");
  const [sessions, setSessions] = useState<Array<{ session_id: string; count: number; keeps: number; started_at: number; latest_at: number }>>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedSession, setSelectedSession] = useState("");

  useEffect(() => {
    const refresh = () => {
      if (view === "sessions") {
        setSessions(store.listExperimentSessions());
      } else {
        setExperiments(store.listExperiments(selectedSession));
      }
    };
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [store, view, selectedSession]);

  useInput((input, key) => {
    if (view === "detail" && (key.escape || input === "b")) {
      setView("sessions");
      setSelectedIndex(0);
      return;
    }

    const list = view === "sessions" ? sessions : experiments;

    if (key.upArrow) setSelectedIndex((i) => Math.max(0, i - 1));
    if (key.downArrow) setSelectedIndex((i) => Math.min(list.length - 1, i + 1));

    if (key.return && view === "sessions" && sessions[selectedIndex]) {
      setSelectedSession(sessions[selectedIndex].session_id);
      setView("detail");
      setSelectedIndex(0);
    }
  });

  if (view === "detail") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1} gap={2}>
          <Text bold color="cyan">Experiments — {selectedSession}</Text>
          <Text dimColor>[b/Esc] back</Text>
        </Box>

        {experiments.length === 0 ? (
          <Text dimColor>No experiments in this session.</Text>
        ) : (
          <Box flexDirection="column">
            {experiments.map((exp, i) => (
              <Box key={exp.id} gap={1}>
                <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                  {i === selectedIndex ? "> " : "  "}
                </Text>
                <Box width={4}>
                  <Text dimColor>#{i}</Text>
                </Box>
                <Box width={12}>
                  <Text color={STATUS_COLORS[exp.status] ?? "white"}>
                    {exp.status.toUpperCase().padEnd(10)}
                  </Text>
                </Box>
                <Box width={9}>
                  <Text dimColor>{exp.commit_hash}</Text>
                </Box>
                <Box width={12}>
                  <Text>{exp.tests_passed}/{exp.tests_total} pass</Text>
                </Box>
                <Text>{exp.description.slice(0, 50)}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Autoresearch Sessions</Text>
        <Text dimColor>[Enter] view session</Text>
      </Box>

      {sessions.length === 0 ? (
        <Text dimColor>No autoresearch sessions yet.</Text>
      ) : (
        <Box flexDirection="column">
          {sessions.map((s, i) => (
            <Box key={s.session_id} gap={1}>
              <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                {i === selectedIndex ? "> " : "  "}
              </Text>
              <Box width={14}>
                <Text>{s.session_id}</Text>
              </Box>
              <Box width={20}>
                <Text color="green">{s.keeps}</Text>
                <Text dimColor>/{s.count} kept</Text>
              </Box>
              <Box width={20}>
                <Text dimColor>{formatTimestamp(s.started_at, { includeDate: true })}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
