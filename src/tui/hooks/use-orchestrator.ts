import { useState, useEffect } from "react";

export interface OrchestratorStatus {
  running: boolean;
  uptime: number;
}

export function useOrchestratorStatus(startedAt: number) {
  const [status, setStatus] = useState<OrchestratorStatus>({
    running: true,
    uptime: 0,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      setStatus({
        running: true,
        uptime: Math.floor(Date.now() / 1000) - startedAt,
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);

  return status;
}
