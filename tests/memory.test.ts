import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { initVault, parseFrontmatter, extractWikilinks, readNote, listNotes } from "../src/memory/vault";
import { searchByFullText, searchByTag, searchByLink, findOrphans } from "../src/memory/search";
import { createFleetingNote, createPermanentNote, createTaskLog, createMoc } from "../src/memory/writer";
import { buildContext } from "../src/memory/context";
import { processInbox } from "../src/memory/librarian";
import { renderFrontmatter } from "../src/memory/templates";

const TEST_VAULT = join(import.meta.dir, ".test-vault");

beforeEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
  initVault({ vaultPath: TEST_VAULT });
});

afterEach(() => {
  if (existsSync(TEST_VAULT)) rmSync(TEST_VAULT, { recursive: true });
});

describe("vault init", () => {
  it("creates all subdirectories", () => {
    for (const dir of ["inbox", "notes", "projects", "tasks", "agents", "templates", "core", "weekly"]) {
      expect(existsSync(join(TEST_VAULT, dir))).toBe(true);
    }
  });
});

describe("frontmatter parsing", () => {
  it("parses simple frontmatter", () => {
    const raw = `---
id: abc-123
type: fleeting
tags:
  - code
  - bugfix
created: 1700000000
source: null
---

Some content here.`;

    const { frontmatter, content } = parseFrontmatter(raw);
    expect(frontmatter.id).toBe("abc-123");
    expect(frontmatter.type).toBe("fleeting");
    expect(frontmatter.tags).toEqual(["code", "bugfix"]);
    expect(frontmatter.created).toBe(1700000000);
    expect(frontmatter.source).toBeNull();
    expect(content).toBe("Some content here.");
  });

  it("handles missing frontmatter", () => {
    const { frontmatter, content } = parseFrontmatter("Just plain content.");
    expect(frontmatter).toEqual({});
    expect(content).toBe("Just plain content.");
  });
});

describe("wikilinks", () => {
  it("extracts wikilinks", () => {
    const text = "This links to [[Authentication]] and [[Error Handling]].";
    const links = extractWikilinks(text);
    expect(links).toEqual(["Authentication", "Error Handling"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikilinks("No links here.")).toEqual([]);
  });
});

describe("writer", () => {
  it("creates a fleeting note in inbox", () => {
    const path = createFleetingNote(TEST_VAULT, "Noticed a pattern in error logs", ["debugging"]);
    expect(existsSync(path)).toBe(true);
    const note = readNote(path);
    expect(note!.frontmatter.type).toBe("fleeting");
    expect(note!.frontmatter.tags).toEqual(["debugging"]);
  });

  it("creates a permanent note in notes/", () => {
    const path = createPermanentNote(TEST_VAULT, "Authentication Patterns", "JWT vs session cookies...", ["auth", "security"]);
    expect(path).toContain("/notes/");
    const note = readNote(path);
    expect(note!.frontmatter.type).toBe("permanent");
    expect(note!.frontmatter.title).toBe("Authentication Patterns");
  });

  it("creates a task log", () => {
    const path = createTaskLog(
      TEST_VAULT,
      "task-123",
      "Fix login bug",
      "Fixed the redirect loop in auth middleware",
      "Always check session expiry before redirect",
      ["auth", "bugfix"]
    );
    expect(path).toContain("/tasks/");
    const note = readNote(path);
    expect(note!.frontmatter.type).toBe("task-log");
    expect(note!.frontmatter.source).toBe("task-123");
  });

  it("creates a MOC in projects/", () => {
    const path = createMoc(
      TEST_VAULT,
      "Auth System",
      "Everything about authentication",
      ["Authentication Patterns", "Session Management"],
      ["auth"]
    );
    expect(path).toContain("/projects/");
    const note = readNote(path);
    expect(note!.frontmatter.type).toBe("moc");
    expect(note!.links).toEqual(["Authentication Patterns", "Session Management"]);
  });
});

describe("search", () => {
  it("full-text search finds matching notes", () => {
    createPermanentNote(TEST_VAULT, "Auth Patterns", "JWT tokens are stateless", ["auth"]);
    createPermanentNote(TEST_VAULT, "Database Tips", "Always use indexes on foreign keys", ["database"]);

    const results = searchByFullText(TEST_VAULT, "JWT tokens");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.note.frontmatter.title).toBe("Auth Patterns");
  });

  it("tag search finds matching notes", () => {
    createPermanentNote(TEST_VAULT, "A", "content", ["auth"]);
    createPermanentNote(TEST_VAULT, "B", "content", ["database"]);

    const results = searchByTag(TEST_VAULT, "auth");
    expect(results).toHaveLength(1);
    expect(results[0]!.note.frontmatter.title).toBe("A");
  });

  it("link search finds notes linking to target", () => {
    createMoc(TEST_VAULT, "Overview", "desc", ["Target Note"], ["meta"]);

    const results = searchByLink(TEST_VAULT, "Target Note");
    expect(results).toHaveLength(1);
  });
});

describe("context builder", () => {
  it("builds context string from relevant notes", () => {
    createPermanentNote(TEST_VAULT, "Error Handling", "Always use try-catch at boundaries", ["patterns"]);
    createPermanentNote(TEST_VAULT, "Logging Best Practices", "Use structured logging", ["patterns"]);

    const ctx = buildContext(TEST_VAULT, "error handling", ["patterns"], 3);
    expect(ctx).toContain("# Relevant Memory Notes");
    expect(ctx).toContain("Error Handling");
  });

  it("returns empty string when no matches", () => {
    const ctx = buildContext(TEST_VAULT, "nonexistent query", [], 3);
    expect(ctx).toBe("");
  });
});

describe("librarian", () => {
  it("promotes qualifying fleeting notes to permanent", () => {
    createFleetingNote(
      TEST_VAULT,
      "Discovered that the auth middleware checks session cookies before JWT tokens, which explains the priority issue we saw in production.",
      ["auth", "middleware"]
    );
    createFleetingNote(TEST_VAULT, "short", []); // Should NOT be promoted

    const report = processInbox(TEST_VAULT);
    expect(report.processed).toBe(2);
    expect(report.promoted).toBe(1);

    // Inbox should have 1 remaining (the short one)
    const remaining = listNotes(TEST_VAULT, "inbox");
    expect(remaining).toHaveLength(1);

    // Notes should have the promoted one
    const permanent = listNotes(TEST_VAULT, "notes");
    expect(permanent).toHaveLength(1);
  });
});

describe("renderFrontmatter", () => {
  it("renders fields correctly", () => {
    const fm = renderFrontmatter({
      id: "test",
      tags: ["a", "b"],
      source: null,
    });
    expect(fm).toContain("id: test");
    expect(fm).toContain("source: null");
    expect(fm).toContain("  - a");
    expect(fm).toContain("  - b");
  });
});
