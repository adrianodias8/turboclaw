import { useState, useEffect } from "react";
import type { Store } from "../../tracker/store";
import type { Run, Cron, Alert } from "../../tracker/types";

export function useHealthStatus(store: Store) {
  const [health, setHealth] = useState({ queueDepth: 0, activeWorkers: 0, failedCount: 0, runningCount: 0 });
  useEffect(() => {
    const refresh = () => setHealth(store.getHealthStatus());
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);
  return health;
}

export function useActiveRuns(store: Store) {
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    const refresh = () => setRuns(store.getActiveRuns());
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);
  return runs;
}

export function useAlertCount(store: Store) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () => setCount(store.getUnacknowledgedAlertCount());
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);
  return count;
}

export function useCronList(store: Store) {
  const [crons, setCrons] = useState<Cron[]>([]);
  useEffect(() => {
    const refresh = () => setCrons(store.listCrons());
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [store]);
  return crons;
}

export function useAlertList(store: Store) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const refresh = () => setAlerts(store.listAlerts({ limit: 50 }));
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [store]);
  return { alerts, refresh };
}
