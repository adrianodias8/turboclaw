import type { ParsedCommand } from "./types";

export function parseMessage(text: string): ParsedCommand {
  const trimmed = text.trim();

  // Slash commands for system operations
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

  // /task explicitly names a task
  if (trimmed.startsWith("/task ")) {
    return { type: "task", args: trimmed.slice(6).trim() };
  }

  // Unknown slash command
  if (trimmed.startsWith("/")) {
    return { type: "unknown", args: trimmed };
  }

  // Everything else is a natural language prompt → send to agent
  return { type: "prompt", args: trimmed };
}

export function formatHelp(): string {
  return [
    "*TurboClaw*",
    "",
    "Just send a message and I'll handle it.",
    "",
    "*Commands:*",
    "/status - System status",
    "/list - Recent tasks",
    "/cancel <id> - Cancel a task",
    "/help - This help",
  ].join("\n");
}
