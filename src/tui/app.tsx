import React, { useState } from "react";
import { Box, useInput, useApp } from "ink";
import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { Nav, type Screen } from "./components/nav";
import { StatusBar } from "./components/status-bar";
import { Dashboard } from "./screens/dashboard";
import { Tasks } from "./screens/tasks";
import { TaskDetail } from "./screens/task-detail";
import { Crons } from "./screens/crons";
import { Alerts } from "./screens/alerts";
import { Settings } from "./screens/settings";
import { Logs } from "./screens/logs";
import { Memory } from "./screens/memory";
import { useConfig } from "./hooks/use-config";
import { useOrchestratorStatus } from "./hooks/use-orchestrator";
import { useStatus } from "./hooks/use-tracker";
import { useAlertCount } from "./hooks/use-health";
import type { WhatsAppBridge } from "../whatsapp/bridge";

interface AppProps {
  store: Store;
  initialConfig: TurboClawConfig;
  startedAt: number;
  whatsappBridge?: WhatsAppBridge | null;
}

export function App({ store, initialConfig, startedAt, whatsappBridge }: AppProps) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [taskDetailId, setTaskDetailId] = useState<string | null>(null);
  const { config, updateConfig } = useConfig(initialConfig);
  const orchStatus = useOrchestratorStatus(startedAt);
  const status = useStatus(store);
  const alertCount = useAlertCount(store);

  const navigate = (target: Screen, detail?: string) => {
    setScreen(target);
    if (target === "tasks" && detail) {
      setTaskDetailId(detail);
    } else {
      setTaskDetailId(null);
    }
  };

  useInput((input, key) => {
    // Ctrl+C or 'q' at top level exits
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // Number keys switch screens (only when not in a detail view)
    if (!taskDetailId) {
      const screenMap: Record<string, Screen> = {
        "1": "dashboard",
        "2": "tasks",
        "3": "crons",
        "4": "alerts",
        "5": "logs",
        "6": "settings",
        "7": "memory",
      };
      if (screenMap[input]) {
        navigate(screenMap[input]);
      }
    }
  });

  const activeScreen = taskDetailId ? "tasks" : screen;

  return (
    <Box flexDirection="column" height="100%">
      <Nav active={activeScreen} />

      <Box flexGrow={1} flexDirection="column">
        {screen === "dashboard" && !taskDetailId && (
          <Dashboard store={store} />
        )}
        {screen === "tasks" && !taskDetailId && (
          <Tasks store={store} onNavigate={navigate} />
        )}
        {screen === "tasks" && taskDetailId && (
          <TaskDetail
            store={store}
            taskId={taskDetailId}
            onNavigate={(s) => navigate(s)}
          />
        )}
        {screen === "crons" && !taskDetailId && (
          <Crons store={store} />
        )}
        {screen === "alerts" && !taskDetailId && (
          <Alerts store={store} />
        )}
        {screen === "settings" && !taskDetailId && (
          <Settings config={config} updateConfig={updateConfig} whatsappBridge={whatsappBridge ?? null} />
        )}
        {screen === "logs" && !taskDetailId && (
          <Logs store={store} />
        )}
        {screen === "memory" && !taskDetailId && (
          <Memory config={config} />
        )}
      </Box>

      <StatusBar
        queueDepth={status.queueDepth}
        activeWorkers={status.activeWorkers}
        uptime={orchStatus.uptime}
        alertCount={alertCount}
        providerName={config.provider?.type}
        whatsappEnabled={config.whatsapp.enabled}
        whatsappConnected={whatsappBridge?.isConnected() ?? false}
      />
    </Box>
  );
}
