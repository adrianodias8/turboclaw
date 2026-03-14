import { useState, useCallback, useRef } from "react";
import type { TurboClawConfig } from "../../config";
import { saveConfig } from "../../config";

export function useConfig(initialConfig: TurboClawConfig) {
  const [config, setConfig] = useState(initialConfig);
  const rootRef = useRef(initialConfig);

  const updateConfig = useCallback(
    (updater: (prev: TurboClawConfig) => TurboClawConfig) => {
      setConfig((prev) => {
        const next = updater(prev);
        saveConfig(next);
        // Mutate the original config object so live references (e.g. WhatsApp bridge) see changes
        Object.assign(rootRef.current, next);
        Object.assign(rootRef.current.whatsapp, next.whatsapp);
        Object.assign(rootRef.current.orchestrator, next.orchestrator);
        Object.assign(rootRef.current.gateway, next.gateway);
        Object.assign(rootRef.current.memory, next.memory);
        Object.assign(rootRef.current.selfImprove, next.selfImprove);
        return next;
      });
    },
    []
  );

  return { config, updateConfig };
}
