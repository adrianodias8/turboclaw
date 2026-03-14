export interface WhatsAppConfig {
  enabled: boolean;
  allowedNumbers: string[];
  allowedGroups: string[];
  notifyOnComplete: boolean;
  notifyOnFail: boolean;
}

export interface ParsedCommand {
  type: "task" | "prompt" | "status" | "list" | "cancel" | "help" | "unknown";
  args: string;
}
