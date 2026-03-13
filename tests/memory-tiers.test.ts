import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { initVault, readNote, listNotes, deleteNote } from "../src/memory/vault";
import { createCoreNote, updateNoteContent } from "../src/memory/writer";
import { buildCoreContext } from "../src/memory/context";
import { coreTemplate, weeklyTemplate } from "../src/memory/templates";
import { compileWeeklySummary, pruneExpiredMemories } from "../src/memory/librarian";
import { createTaskLog } from "../src/memory/writer";
import { maybeCreateTaskMemory } from "../src/memory/auto-memory";
import type { Task } from "../src/tracker/types";

const TEST_VAULT = join(import.meta.dir, ".test-vault-tiers");

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  initVault({ vaultPath: TEST_VAULT });
});

afterEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
});

describe("vault init with new dirs", () => {
  it("creates core and weekly subdirectories", () => {
    expect(existsSync(join(TEST_VAULT, "core"))).toBe(true);
    expect(existsSync(join(TEST_VAULT, "weekly"))).toBe(true);
  });
});

describe("core notes", () => {
  it("creates a core note in core/", () => {
    const path = createCoreNote(TEST_VAULT, "user-name", "User Name", "Adriano", ["core", "identity"]);
    expect(path).toContain("/core/user-name.md");
    expect(existsSync(path)).toBe(true);

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.frontmatter.type).toBe("core");
    expect(note!.frontmatter.title).toBe("User Name");
    expect(note!.content).toContain("Adriano");
  });

  it("lists core notes", () => {
    createCoreNote(TEST_VAULT, "user-name", "User Name", "Adriano");
    createCoreNote(TEST_VAULT, "user-role", "User Role", "Senior Developer");

    const notes = listNotes(TEST_VAULT, "core");
    expect(notes).toHaveLength(2);
  });

  it("deletes a core note", () => {
    const path = createCoreNote(TEST_VAULT, "temp", "Temp", "temporary");
    expect(existsSync(path)).toBe(true);
    deleteNote(path);
    expect(existsSync(path)).toBe(false);
  });
});

describe("updateNoteContent", () => {
  it("preserves frontmatter and replaces content", () => {
    const path = createCoreNote(TEST_VAULT, "user-name", "User Name", "Old Name", ["core"]);
    updateNoteContent(path, "# User Name\n\nNew Name");

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.frontmatter.type).toBe("core");
    expect(note!.frontmatter.title).toBe("User Name");
    expect(note!.content).toContain("New Name");
    expect(note!.content).not.toContain("Old Name");
  });
});

describe("buildCoreContext", () => {
  it("returns formatted core memory", () => {
    createCoreNote(TEST_VAULT, "user-name", "User Name", "Adriano");
    createCoreNote(TEST_VAULT, "user-role", "User Role", "Senior Developer");

    const ctx = buildCoreContext(TEST_VAULT);
    expect(ctx).toContain("# Core Memory");
    expect(ctx).toContain("## User Name");
    expect(ctx).toContain("Adriano");
    expect(ctx).toContain("## User Role");
    expect(ctx).toContain("Senior Developer");
  });

  it("returns empty string when no core notes", () => {
    const ctx = buildCoreContext(TEST_VAULT);
    expect(ctx).toBe("");
  });
});

describe("templates", () => {
  it("coreTemplate generates valid frontmatter", () => {
    const content = coreTemplate("test-id", "Test Title", "Test content", ["core"]);
    expect(content).toContain("type: core");
    expect(content).toContain("title: Test Title");
    expect(content).toContain("# Test Title");
    expect(content).toContain("Test content");
  });

  it("weeklyTemplate generates valid summary", () => {
    const entries = [
      { title: "Fix login", summary: "Fixed redirect loop" },
      { title: "Add tests", summary: "Added unit tests for auth" },
    ];
    const content = weeklyTemplate("test-id", "2026-03-09", entries, ["weekly-summary"]);
    expect(content).toContain("type: weekly-summary");
    expect(content).toContain("Week of 2026-03-09");
    expect(content).toContain("2 tasks completed");
    expect(content).toContain("**Fix login**");
    expect(content).toContain("**Add tests**");
  });
});

describe("auto-memory daily tags", () => {
  it("adds daily and date tags to task logs", () => {
    const task: Task = {
      id: "task-abc-12345678",
      pipeline_id: null,
      stage: null,
      title: "Fix the authentication bug in the login flow",
      description: null,
      agent_role: "coder",
      status: "done",
      priority: 0,
      created_at: Math.floor(Date.now() / 1000),
      retry_count: 0,
      max_retries: 3,
      reply_jid: null,
      updated_at: Math.floor(Date.now() / 1000),
    };

    const output = "Fixed the redirect loop in the authentication middleware. The session cookie was not being refreshed properly.";
    const path = maybeCreateTaskMemory(TEST_VAULT, task, output);
    expect(path).not.toBeNull();

    const note = readNote(path!);
    expect(note).not.toBeNull();
    expect(note!.frontmatter.tags).toContain("auto-memory");
    expect(note!.frontmatter.tags).toContain("daily");

    const today = new Date();
    const dateTag = `daily-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(note!.frontmatter.tags).toContain(dateTag);
  });
});

describe("weekly summary compilation", () => {
  it("compiles weekly summary from task notes", () => {
    // Create task logs with recent timestamps
    const now = Math.floor(Date.now() / 1000);
    const monday = new Date();
    const day = monday.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    monday.setDate(monday.getDate() + diff);
    monday.setHours(0, 0, 0, 0);

    // Create a task log manually with this week's timestamp
    createTaskLog(TEST_VAULT, "t1", "Fix auth bug", "Fixed redirect loop", "", ["bugfix"]);
    createTaskLog(TEST_VAULT, "t2", "Add tests", "Added unit tests", "", ["testing"]);

    const result = compileWeeklySummary(TEST_VAULT, new Date());
    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);

    const note = readNote(result!);
    expect(note).not.toBeNull();
    expect(note!.frontmatter.type).toBe("weekly-summary");
    expect(note!.content).toContain("Fix auth bug");
    expect(note!.content).toContain("Add tests");
  });

  it("returns null when no task notes exist for the week", () => {
    const result = compileWeeklySummary(TEST_VAULT, new Date("2020-01-06"));
    expect(result).toBeNull();
  });
});

describe("pruneExpiredMemories", () => {
  it("prunes old daily notes but keeps recent ones", () => {
    // Create an "old" task log by writing directly with old timestamp
    const oldId = "old-note-id";
    const oldTimestamp = Math.floor(Date.now() / 1000) - 86400 * 30; // 30 days ago
    const content = `---
id: ${oldId}
type: task-log
tags:
  - auto-memory
created: ${oldTimestamp}
source: task-old
title: Old Task
---

# Old Task

## Summary

Old summary

## Learnings

Old learnings
`;
    writeFileSync(join(TEST_VAULT, "tasks", "old-task.md"), content);

    // Create a recent task log
    createTaskLog(TEST_VAULT, "t-recent", "Recent Task", "Recent summary", "", ["bugfix"]);

    const before = listNotes(TEST_VAULT, "tasks");
    expect(before).toHaveLength(2);

    const result = pruneExpiredMemories(TEST_VAULT, 7, 4);
    expect(result.dailyPruned).toBe(1);

    const after = listNotes(TEST_VAULT, "tasks");
    expect(after).toHaveLength(1);
    expect(after[0]!.frontmatter.title).toBe("Recent Task");
  });

  it("does not prune core notes", () => {
    createCoreNote(TEST_VAULT, "user-name", "User Name", "Adriano", ["core"]);
    const result = pruneExpiredMemories(TEST_VAULT, 0, 0); // retention = 0 days
    expect(result.dailyPruned).toBe(0);
    expect(result.weeklyPruned).toBe(0);

    const coreNotes = listNotes(TEST_VAULT, "core");
    expect(coreNotes).toHaveLength(1);
  });
});
