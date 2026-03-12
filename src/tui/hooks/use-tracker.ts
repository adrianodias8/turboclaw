import { useState, useEffect, useCallback } from "react";
import type { Store } from "../../tracker/store";
import type { Task, Pipeline, TaskStatus } from "../../tracker/types";

export function useTaskList(store: Store, opts?: { status?: TaskStatus; limit?: number }) {
  const [tasks, setTasks] = useState<Task[]>([]);

  const refresh = useCallback(() => {
    setTasks(store.listTasks(opts));
  }, [store, opts?.status, opts?.limit]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { tasks, refresh };
}

export function useTask(store: Store, taskId: string | null) {
  const [task, setTask] = useState<Task | null>(null);

  const refresh = useCallback(() => {
    if (taskId) setTask(store.getTask(taskId));
  }, [store, taskId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { task, refresh };
}

export function usePipelineList(store: Store) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  const refresh = useCallback(() => {
    setPipelines(store.listPipelines());
  }, [store]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { pipelines, refresh };
}

export function useStatus(store: Store) {
  const [status, setStatus] = useState({ queueDepth: 0, activeWorkers: 0 });

  useEffect(() => {
    const refresh = () => {
      setStatus({
        queueDepth: store.getQueueDepth(),
        activeWorkers: store.getActiveWorkerCount(),
      });
    };
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [store]);

  return status;
}
