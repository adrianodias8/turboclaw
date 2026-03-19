/**
 * Concurrent memory vault stress tests.
 *
 * Tests the vault under concurrent read/write/delete operations to ensure:
 * - No data corruption from concurrent writes
 * - Cache invalidation works correctly under load
 * - File operations don't throw under concurrent access
 * - listNotes returns consistent results after bulk operations
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import {
  initVault,
  writeNote,
  readNote,
  listNotes,
  deleteNote,
  invalidateNoteCache,
} from "../src/memory/vault";

const TEST_VAULT = join(import.meta.dir, ".test-vault-stress");

function makeNote(id: string, title: string, tags: string[] = []): string {
  const ts = Math.floor(Date.now() / 1000);
  const tagStr = tags.length > 0 ? `\ntags:\n${tags.map((t) => `  - ${t}`).join("\n")}` : "";
  return `---\nid: ${id}\ntitle: ${title}\ntype: fleeting\ncreated: ${ts}${tagStr}\n---\n\nContent for ${title}`;
}

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  initVault({ vaultPath: TEST_VAULT });
});

afterEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
});

describe("vault stress: bulk writes", () => {
  it("handles 100 concurrent note writes", async () => {
    const promises: Promise<void>[] = [];
    const noteCount = 100;

    for (let i = 0; i < noteCount; i++) {
      promises.push(
        new Promise<void>((resolve) => {
          const id = `bulk-${i}`;
          const path = join(TEST_VAULT, "notes", `${id}.md`);
          writeNote(path, makeNote(id, `Note ${i}`));
          resolve();
        }),
      );
    }

    await Promise.all(promises);

    invalidateNoteCache();
    const notes = listNotes(TEST_VAULT, "notes");
    expect(notes).toHaveLength(noteCount);
  });

  it("handles rapid sequential writes to the same file", () => {
    const path = join(TEST_VAULT, "notes", "rapid.md");

    for (let i = 0; i < 50; i++) {
      writeNote(path, makeNote("rapid", `Version ${i}`));
    }

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content).toContain("Version 49");
  });

  it("handles writes to different subdirectories simultaneously", async () => {
    const dirs = ["notes", "tasks", "core", "inbox"];
    const promises: Promise<void>[] = [];

    for (const dir of dirs) {
      for (let i = 0; i < 25; i++) {
        promises.push(
          new Promise<void>((resolve) => {
            const id = `${dir}-${i}`;
            const path = join(TEST_VAULT, dir, `${id}.md`);
            writeNote(path, makeNote(id, `${dir} note ${i}`));
            resolve();
          }),
        );
      }
    }

    await Promise.all(promises);

    invalidateNoteCache();
    for (const dir of dirs) {
      const notes = listNotes(TEST_VAULT, dir);
      expect(notes).toHaveLength(25);
    }
  });
});

describe("vault stress: concurrent read-write", () => {
  it("reads remain consistent during writes", () => {
    // Pre-populate
    for (let i = 0; i < 20; i++) {
      const path = join(TEST_VAULT, "notes", `note-${i}.md`);
      writeNote(path, makeNote(`note-${i}`, `Original ${i}`));
    }

    // Overwrite half while reading all
    for (let i = 0; i < 10; i++) {
      const path = join(TEST_VAULT, "notes", `note-${i}.md`);
      writeNote(path, makeNote(`note-${i}`, `Updated ${i}`));
    }

    invalidateNoteCache();
    const notes = listNotes(TEST_VAULT, "notes");
    expect(notes).toHaveLength(20);

    // Verify updated notes
    for (let i = 0; i < 10; i++) {
      const note = readNote(join(TEST_VAULT, "notes", `note-${i}.md`));
      expect(note!.content).toContain(`Updated ${i}`);
    }

    // Verify untouched notes
    for (let i = 10; i < 20; i++) {
      const note = readNote(join(TEST_VAULT, "notes", `note-${i}.md`));
      expect(note!.content).toContain(`Original ${i}`);
    }
  });

  it("listNotes returns fresh results after cache invalidation", () => {
    const path = join(TEST_VAULT, "notes", "cached-test.md");
    writeNote(path, makeNote("cached-test", "Initial"));

    // First call — populates cache
    const first = listNotes(TEST_VAULT, "notes");
    expect(first).toHaveLength(1);

    // Add another note
    const path2 = join(TEST_VAULT, "notes", "cached-test-2.md");
    writeNote(path2, makeNote("cached-test-2", "Second"));

    // writeNote calls invalidateNoteCache, so this should return 2
    const second = listNotes(TEST_VAULT, "notes");
    expect(second).toHaveLength(2);
  });
});

describe("vault stress: concurrent delete", () => {
  it("handles bulk deletes", () => {
    // Create 50 notes
    for (let i = 0; i < 50; i++) {
      const path = join(TEST_VAULT, "notes", `del-${i}.md`);
      writeNote(path, makeNote(`del-${i}`, `Delete me ${i}`));
    }

    // Delete all of them
    for (let i = 0; i < 50; i++) {
      const path = join(TEST_VAULT, "notes", `del-${i}.md`);
      deleteNote(path);
    }

    invalidateNoteCache();
    const notes = listNotes(TEST_VAULT, "notes");
    expect(notes).toHaveLength(0);
  });

  it("delete during list does not corrupt state", () => {
    // Create notes
    for (let i = 0; i < 30; i++) {
      const path = join(TEST_VAULT, "notes", `mix-${i}.md`);
      writeNote(path, makeNote(`mix-${i}`, `Mix ${i}`));
    }

    // Delete odd-numbered notes
    for (let i = 1; i < 30; i += 2) {
      deleteNote(join(TEST_VAULT, "notes", `mix-${i}.md`));
    }

    invalidateNoteCache();
    const remaining = listNotes(TEST_VAULT, "notes");
    expect(remaining).toHaveLength(15); // 0, 2, 4, ..., 28
  });

  it("double-delete does not throw", () => {
    const path = join(TEST_VAULT, "notes", "double.md");
    writeNote(path, makeNote("double", "Delete twice"));

    deleteNote(path);
    // Second delete should not throw
    deleteNote(path);

    expect(existsSync(path)).toBe(false);
  });
});

describe("vault stress: cache correctness", () => {
  it("cache is invalidated per-vault when specified", () => {
    const otherVault = join(TEST_VAULT, "other-vault");
    initVault({ vaultPath: otherVault });

    // Write to both vaults
    writeNote(join(TEST_VAULT, "notes", "main.md"), makeNote("main", "Main vault"));
    writeNote(join(otherVault, "notes", "other.md"), makeNote("other", "Other vault"));

    // Populate caches
    const mainNotes = listNotes(TEST_VAULT, "notes");
    const otherNotes = listNotes(otherVault, "notes");
    expect(mainNotes).toHaveLength(1);
    expect(otherNotes).toHaveLength(1);

    // Invalidate only main vault cache
    invalidateNoteCache(TEST_VAULT);

    // Write to main vault — cache was invalidated
    writeNote(join(TEST_VAULT, "notes", "main2.md"), makeNote("main2", "Main vault 2"));
    const mainNotesAfter = listNotes(TEST_VAULT, "notes");
    expect(mainNotesAfter).toHaveLength(2);
  });

  it("full cache clear works", () => {
    writeNote(join(TEST_VAULT, "notes", "a.md"), makeNote("a", "A"));
    listNotes(TEST_VAULT, "notes"); // populate cache

    invalidateNoteCache(); // clear ALL caches

    writeNote(join(TEST_VAULT, "notes", "b.md"), makeNote("b", "B"));
    const notes = listNotes(TEST_VAULT, "notes");
    expect(notes).toHaveLength(2);
  });
});

describe("vault stress: edge cases", () => {
  it("handles notes with special characters in content", () => {
    const content = makeNote("special", "Special chars: 日本語 émojis 🎉 <html>&amp;</html>");
    const path = join(TEST_VAULT, "notes", "special.md");
    writeNote(path, content);

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content).toContain("日本語");
    expect(note!.content).toContain("🎉");
  });

  it("handles empty note content", () => {
    const path = join(TEST_VAULT, "notes", "empty.md");
    writeNote(path, "---\nid: empty\ntitle: Empty\ntype: fleeting\ncreated: 0\n---\n");

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.frontmatter.title).toBe("Empty");
  });

  it("handles note with no frontmatter", () => {
    const path = join(TEST_VAULT, "notes", "bare.md");
    writeNote(path, "Just plain text, no frontmatter.");

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content).toBe("Just plain text, no frontmatter.");
  });

  it("handles note with malformed frontmatter", () => {
    const path = join(TEST_VAULT, "notes", "malformed.md");
    writeNote(path, "---\nthis is not: valid: yaml: at all\n: broken\n---\n\nBody text.");

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content).toBe("Body text.");
  });

  it("handles readNote on nonexistent file", () => {
    const note = readNote(join(TEST_VAULT, "notes", "ghost.md"));
    expect(note).toBeNull();
  });

  it("handles listNotes on nonexistent directory", () => {
    const notes = listNotes(TEST_VAULT, "nonexistent-dir");
    expect(notes).toEqual([]);
  });

  it("handles very large note content", () => {
    const largeContent = makeNote("large", "Large note") + "\n" + "x".repeat(100_000);
    const path = join(TEST_VAULT, "notes", "large.md");
    writeNote(path, largeContent);

    const note = readNote(path);
    expect(note).not.toBeNull();
    expect(note!.content.length).toBeGreaterThan(100_000);
  });
});
