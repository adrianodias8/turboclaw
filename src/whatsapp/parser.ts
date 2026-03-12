import type { ParsedCommand } from "./types";

export function parseMessage(text: string): ParsedCommand {
  const trimmed = text.trim();

  if (trimmed.startsWith("/task ")) {
    return { type: "task", args: trimmed.slice(6).trim() };
  }
  if (trimmed === "/status") {
    return { type: "status", args: "" };
  }
  if (trimmed === "/list") {
    return { type: "list", args: "" };
  }
  if (trimmed.startsWith("/cancel ")) {
    return { type: "cancel", args: trimmed.slice(8).trim() };
  }
  if (trimmed === "/help") {
    return { type: "help", args: "" };
  }
  if (trimmed.startsWith("/")) {
    return { type: "unknown", args: trimmed };
  }

  // No slash prefix = not a command, show help
  return { type: "unknown", args: trimmed };
}

export function formatHelp(): string {
  return [
    "*TurboClaw Commands:*",
    "",
    "/task <title> - Create a new task",
    "/status - System status",
    "/list - Recent tasks",
    "/cancel <id> - Cancel a task",
    "/help - Show this help",
    "",
    "All commands require a / prefix.",
  ].join("\n");
}
