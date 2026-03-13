import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "@inkjs/ui";
import { join } from "path";
import type { TurboClawConfig } from "../../config";
import { useMemoryNotes } from "../hooks/use-memory";
import { createCoreNote, updateNoteContent } from "../../memory/writer";
import { deleteNote, readNote } from "../../memory/vault";
import { compileWeeklySummary } from "../../memory/librarian";
import type { MemoryNote } from "../../memory/types";

interface MemoryProps {
  config: TurboClawConfig;
}

type Tier = "core" | "daily" | "weekly";
type Mode = "list" | "view" | "create-title" | "create-content" | "edit";

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "..." : oneLine;
}

export function Memory({ config }: MemoryProps) {
  const vaultPath = join(config.home, "memory");
  const [tier, setTier] = useState<Tier>("core");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [viewNote, setViewNote] = useState<MemoryNote | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editPath, setEditPath] = useState("");

  const notes = useMemoryNotes(vaultPath, tier);

  useInput((input, key) => {
    if (mode !== "list") return;

    // Sub-tab switching
    if (input === "c") { setTier("core"); setSelectedIndex(0); return; }
    if (input === "d") { setTier("daily"); setSelectedIndex(0); return; }
    if (input === "w") { setTier("weekly"); setSelectedIndex(0); return; }

    // Navigation
    if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setSelectedIndex((i) => Math.min(notes.length - 1, i + 1)); return; }

    // View
    if (key.return && notes[selectedIndex]) {
      setViewNote(notes[selectedIndex]);
      setMode("view");
      return;
    }

    // Create (core only)
    if (input === "n" && tier === "core") {
      setNewTitle("");
      setMode("create-title");
      return;
    }

    // Edit (core only)
    if (input === "e" && tier === "core" && notes[selectedIndex]) {
      const note = notes[selectedIndex];
      setEditPath(note.path);
      setEditContent(note.content);
      setMode("edit");
      return;
    }

    // Delete
    if (input === "x" && notes[selectedIndex]) {
      deleteNote(notes[selectedIndex].path);
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    // Regenerate weekly
    if (input === "r" && tier === "weekly") {
      compileWeeklySummary(vaultPath);
      return;
    }
  });

  // Handle Escape from view mode
  useInput((input, key) => {
    if (mode === "view" && key.escape) {
      setMode("list");
      setViewNote(null);
    }
  });

  const handleCreateTitle = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setMode("list");
      return;
    }
    setNewTitle(trimmed);
    setEditContent("");
    setMode("create-content");
  };

  const handleCreateContent = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setMode("list");
      return;
    }
    const slug = newTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    createCoreNote(vaultPath, slug, newTitle, trimmed, ["core"]);
    setMode("list");
  };

  const handleEdit = (value: string) => {
    if (editPath) {
      updateNoteContent(editPath, value);
    }
    setMode("list");
    setEditPath("");
  };

  const tierLabel = tier === "core" ? "Core" : tier === "daily" ? "Daily" : "Weekly";

  // View mode
  if (mode === "view" && viewNote) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1} gap={2}>
          <Text bold color="cyan">{viewNote.frontmatter.title ?? "Untitled"}</Text>
          <Text dimColor>[Esc] back</Text>
        </Box>
        <Text dimColor>Created: {formatTimestamp(viewNote.frontmatter.created)}</Text>
        {viewNote.frontmatter.tags.length > 0 && (
          <Text dimColor>Tags: {viewNote.frontmatter.tags.join(", ")}</Text>
        )}
        <Box marginTop={1}>
          <Text>{viewNote.content}</Text>
        </Box>
      </Box>
    );
  }

  // Create title step
  if (mode === "create-title") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>New core memory — Title:</Text>
        <Text dimColor>Enter to confirm, empty to cancel</Text>
        <Box marginTop={1}>
          <TextInput placeholder="e.g. User Name" onSubmit={handleCreateTitle} />
        </Box>
      </Box>
    );
  }

  // Create content step
  if (mode === "create-content") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>New core memory: {newTitle}</Text>
        <Text dimColor>Enter content (empty to cancel):</Text>
        <Box marginTop={1}>
          <TextInput placeholder="Content..." onSubmit={handleCreateContent} />
        </Box>
      </Box>
    );
  }

  // Edit mode
  if (mode === "edit") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Edit core memory</Text>
        <Text dimColor>Enter new content:</Text>
        <Box marginTop={1}>
          <TextInput defaultValue={editContent} onSubmit={handleEdit} />
        </Box>
      </Box>
    );
  }

  // List mode
  const actions = tier === "core"
    ? "[n] create  [e] edit  [x] delete  [Enter] view"
    : tier === "weekly"
    ? "[x] delete  [r] regenerate  [Enter] view"
    : "[x] delete  [Enter] view";

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1} gap={2}>
        <Text bold color="cyan">Memory</Text>
        <Text color={tier === "core" ? "cyan" : "gray"} bold={tier === "core"}>[c] Core</Text>
        <Text color={tier === "daily" ? "cyan" : "gray"} bold={tier === "daily"}>[d] Daily</Text>
        <Text color={tier === "weekly" ? "cyan" : "gray"} bold={tier === "weekly"}>[w] Weekly</Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>{actions}</Text>
      </Box>

      {notes.length === 0 ? (
        <Text dimColor>No {tierLabel.toLowerCase()} memories.</Text>
      ) : (
        <Box flexDirection="column">
          {notes.map((note, i) => {
            const title = note.frontmatter.title ?? "Untitled";
            const date = formatTimestamp(note.frontmatter.created);
            const preview = truncate(note.content, 60);

            return (
              <Box key={note.path} gap={1}>
                <Text color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
                  {i === selectedIndex ? "> " : "  "}
                </Text>
                {tier === "core" ? (
                  <Text>
                    <Text bold={i === selectedIndex}>{title}</Text>
                    <Text dimColor>: {preview}</Text>
                  </Text>
                ) : tier === "daily" ? (
                  <Text>
                    <Text dimColor>{date}</Text>
                    <Text> | </Text>
                    <Text bold={i === selectedIndex}>{truncate(title, 50)}</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text dimColor>Week of {date}</Text>
                    <Text> | </Text>
                    <Text bold={i === selectedIndex}>{preview}</Text>
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
