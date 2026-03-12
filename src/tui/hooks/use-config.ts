import { useState, useCallback } from "react";
import type { TurboClawConfig } from "../../config";
import { saveConfig } from "../../config";

export function useConfig(initialConfig: TurboClawConfig) {
  const [config, setConfig] = useState(initialConfig);

  const updateConfig = useCallback(
    (updater: (prev: TurboClawConfig) => TurboClawConfig) => {
      setConfig((prev) => {
        const next = updater(prev);
        saveConfig(next);
        return next;
      });
    },
    []
  );

  return { config, updateConfig };
}
