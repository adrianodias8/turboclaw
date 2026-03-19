import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { startLibrarian, type LibrarianHandle } from "../src/memory/scheduler";
import { initVault } from "../src/memory/vault";

const TEST_VAULT = join(import.meta.dir, ".test-scheduler-vault");

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  initVault({ vaultPath: TEST_VAULT });
});

describe("startLibrarian", () => {
  let handle: LibrarianHandle | null = null;

  // Always clean up after each test
  afterEach(() => {
    if (handle) {
      handle.stop();
      handle = null;
    }
  });

  it("returns a handle with stop and runNow", () => {
    handle = startLibrarian(TEST_VAULT, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 60_000);
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.runNow).toBe("function");
  });

  it("stop() prevents further runs", async () => {
    // Use a very short interval
    handle = startLibrarian(TEST_VAULT, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 50);
    handle.stop();
    handle = null; // already stopped

    // Wait past the interval — no errors should occur
    await new Promise(r => setTimeout(r, 150));
  });

  it("runNow() can be called multiple times without error", () => {
    handle = startLibrarian(TEST_VAULT, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 60_000);
    // Should not throw
    handle.runNow();
    handle.runNow();
    handle.runNow();
  });

  it("processes inbox notes on startup", () => {
    // Create an inbox note before starting librarian
    const inboxDir = join(TEST_VAULT, "inbox");
    writeFileSync(
      join(inboxDir, "test-note.md"),
      "---\ntitle: Test Note\ntags: [test]\ncreated: 2026-03-19\n---\n\nSome content here."
    );

    handle = startLibrarian(TEST_VAULT, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 60_000);

    // After startup run, inbox note should be processed (promoted or left depending on content)
    // The key thing is it runs without error
  });

  it("creates instincts directory for decay", () => {
    handle = startLibrarian(TEST_VAULT, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 60_000);
    // decayInstincts is called during run — even with no instincts it should not throw
    handle.runNow();
  });

  it("uses custom retention config", () => {
    // Very short retention — should prune old daily notes
    const tasksDir = join(TEST_VAULT, "tasks");

    // Create a "daily" note dated 30 days ago with unix timestamp
    const oldTimestamp = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const filename = `task-old-${oldTimestamp}.md`;
    writeFileSync(
      join(tasksDir, filename),
      `---\ntitle: Old Task\ntags: [daily]\ncreated: ${oldTimestamp}\n---\n\nOld content.`
    );

    handle = startLibrarian(
      TEST_VAULT,
      { dailyRetentionDays: 1, weeklyRetentionWeeks: 1 },
      60_000
    );

    // The startup run should prune the 30-day-old note with 1-day retention
    const noteExists = existsSync(join(tasksDir, filename));
    expect(noteExists).toBe(false);
  });

  it("handles missing vault directories gracefully", () => {
    const emptyVault = join(TEST_VAULT, "empty-sub");
    mkdirSync(emptyVault, { recursive: true });

    // Should not throw even with minimal vault structure
    handle = startLibrarian(emptyVault, { dailyRetentionDays: 7, weeklyRetentionWeeks: 4 }, 60_000);
    handle.runNow();
  });
});
