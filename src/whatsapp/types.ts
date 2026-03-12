export interface WhatsAppConfig {
  enabled: boolean;
  allowedNumbers: string[];
  notifyOnComplete: boolean;
  notifyOnFail: boolean;
}

export interface ParsedCommand {
  type: "task" | "status" | "list" | "cancel" | "help" | "unknown";
  args: string;
}
