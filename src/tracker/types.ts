export type TaskStatus = "pending" | "queued" | "running" | "done" | "failed" | "cancelled";
export type RunStatus = "running" | "done" | "failed" | "cancelled";
export type EventKind = "stdout" | "stderr" | "status" | "artifact" | "error" | "info";
export type AgentRole = "coder" | "reviewer" | "planner" | "self-improve" | "librarian";

export interface Pipeline {
  id: string;
  name: string;
  stages: string; // JSON array of stage definitions
  created_at: number;
}

export interface Task {
  id: string;
  pipeline_id: string | null;
  stage: string | null;
  title: string;
  description: string | null;
  agent_role: AgentRole;
  priority: number;
  status: TaskStatus;
  max_retries: number;
  retry_count: number;
  reply_jid: string | null;
  created_at: number;
  updated_at: number;
}

export interface Run {
  id: string;
  task_id: string;
  status: RunStatus;
  container_id: string | null;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
}

export interface Lease {
  id: string;
  task_id: string;
  run_id: string;
  worker: string;
  expires_at: number;
  released: number; // 0 or 1
}

export interface Event {
  id: number; // auto-increment
  run_id: string;
  kind: EventKind;
  payload: string;
  created_at: number;
}

export interface Gate {
  id: number; // auto-increment
  pipeline_id: string;
  from_stage: string;
  to_stage: string;
  approved: number; // 0 or 1
  approved_at: number | null;
}

export interface Artifact {
  id: string;
  task_id: string;
  run_id: string;
  name: string;
  path: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: number;
}

export interface CreateTaskInput {
  pipelineId?: string | null;
  stage?: string | null;
  title: string;
  description?: string | null;
  agentRole?: AgentRole;
  priority?: number;
  maxRetries?: number;
  replyJid?: string | null;
}

export interface CreatePipelineInput {
  name: string;
  stages: unknown[];
}

export type AlertKind = "task_failed" | "lease_expired" | "whatsapp_disconnect";

export interface Cron {
  id: string;
  name: string;
  schedule: string;
  task_template: string; // JSON
  enabled: number; // 0 or 1
  one_shot: number; // 0 or 1
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

export interface Alert {
  id: number;
  kind: AlertKind;
  message: string;
  task_id: string | null;
  acknowledged: number; // 0 or 1
  created_at: number;
}

export interface ChatMessage {
  id: number;
  jid: string;
  role: "user" | "assistant";
  content: string;
  task_id: string | null;
  created_at: number;
}

export interface CreateCronInput {
  name: string;
  schedule: string;
  taskTemplate: {
    title: string;
    description?: string;
    agentRole?: AgentRole;
    priority?: number;
    /** WhatsApp JID to send reply to when task completes */
    replyJid?: string;
  };
  /** If true, cron auto-disables after first fire */
  oneShot?: boolean;
  /** Pre-computed next_run_at for one-shot scheduled tasks */
  nextRunAt?: number;
}
