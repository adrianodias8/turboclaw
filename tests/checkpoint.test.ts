import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createCheckpointManager } from "../src/container/checkpoint";

let workspaceDir: string;
let checkpointsBase: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "tc-ws-"));
  checkpointsBase = mkdtempSync(join(tmpdir(), "tc-cp-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(checkpointsBase, { recursive: true, force: true });
});

describe("createCheckpointManager", () => {
  it("returns a manager object", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    expect(mgr).toBeDefined();
    expect(typeof mgr.snapshot).toBe("function");
    expect(typeof mgr.list).toBe("function");
    expect(typeof mgr.restore).toBe("function");
    expect(typeof mgr.diff).toBe("function");
    expect(typeof mgr.prune).toBe("function");
  });
});

describe("snapshot", () => {
  it("creates a checkpoint when files exist", () => {
    writeFileSync(join(workspaceDir, "hello.txt"), "hello world");
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    const cp = mgr.snapshot("task-1", "Initial snapshot");
    expect(cp).not.toBeNull();
    expect(cp!.hash).toBeTruthy();
    expect(cp!.taskId).toBe("task-1");
    expect(cp!.message).toBe("Initial snapshot");
    expect(cp!.timestamp).toBeGreaterThan(0);
    expect(cp!.stats.files).toBeGreaterThanOrEqual(1);
  });

  it("returns null when nothing changed", () => {
    writeFileSync(join(workspaceDir, "hello.txt"), "hello world");
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    mgr.snapshot("task-1", "First");
    const cp2 = mgr.snapshot("task-2", "Second");
    expect(cp2).toBeNull();
  });

  it("creates a new checkpoint after file modification", () => {
    writeFileSync(join(workspaceDir, "hello.txt"), "hello world");
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    const cp1 = mgr.snapshot("task-1", "First");
    expect(cp1).not.toBeNull();

    writeFileSync(join(workspaceDir, "hello.txt"), "hello updated");
    const cp2 = mgr.snapshot("task-2", "Second");
    expect(cp2).not.toBeNull();
    expect(cp2!.hash).not.toBe(cp1!.hash);
  });
});

describe("list", () => {
  it("returns empty array when no checkpoints", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    expect(mgr.list()).toEqual([]);
  });

  it("returns checkpoints in reverse chronological order", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "a.txt"), "a");
    mgr.snapshot("task-1", "First");

    writeFileSync(join(workspaceDir, "b.txt"), "b");
    mgr.snapshot("task-2", "Second");

    writeFileSync(join(workspaceDir, "c.txt"), "c");
    mgr.snapshot("task-3", "Third");

    const checkpoints = mgr.list();
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0]!.taskId).toBe("task-3");
    expect(checkpoints[0]!.message).toBe("Third");
    expect(checkpoints[1]!.taskId).toBe("task-2");
    expect(checkpoints[2]!.taskId).toBe("task-1");
  });

  it("respects limit parameter", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "a.txt"), "a");
    mgr.snapshot("task-1", "First");

    writeFileSync(join(workspaceDir, "b.txt"), "b");
    mgr.snapshot("task-2", "Second");

    writeFileSync(join(workspaceDir, "c.txt"), "c");
    mgr.snapshot("task-3", "Third");

    const checkpoints = mgr.list(2);
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0]!.taskId).toBe("task-3");
    expect(checkpoints[1]!.taskId).toBe("task-2");
  });
});

describe("restore", () => {
  it("reverts workspace to checkpoint and creates safety snapshot", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "file.txt"), "original content");
    const cp = mgr.snapshot("task-1", "Original");
    expect(cp).not.toBeNull();

    // Modify file but do NOT snapshot — so there are uncommitted changes
    writeFileSync(join(workspaceDir, "file.txt"), "modified content");

    const result = mgr.restore(cp!.hash);
    expect(result.ok).toBe(true);
    expect(result.safetyHash).toBeTruthy();

    // Workspace should be restored
    const content = readFileSync(join(workspaceDir, "file.txt"), "utf-8");
    expect(content).toBe("original content");
  });

  it("reverts workspace when changes are already committed", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "file.txt"), "original content");
    const cp = mgr.snapshot("task-1", "Original");
    expect(cp).not.toBeNull();

    writeFileSync(join(workspaceDir, "file.txt"), "modified content");
    mgr.snapshot("task-2", "Modified");

    const result = mgr.restore(cp!.hash);
    expect(result.ok).toBe(true);
    // safetyHash may be undefined if no uncommitted changes existed

    const content = readFileSync(join(workspaceDir, "file.txt"), "utf-8");
    expect(content).toBe("original content");
  });

  it("returns error for nonexistent hash", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    writeFileSync(join(workspaceDir, "file.txt"), "content");
    mgr.snapshot("task-1", "First");

    const result = mgr.restore("0000000000000000000000000000000000000000");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("returns error when no checkpoints exist", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    const result = mgr.restore("abc123");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No checkpoints exist");
  });
});

describe("diff", () => {
  it("shows changes between checkpoint and current state", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "file.txt"), "original");
    const cp = mgr.snapshot("task-1", "Original");
    expect(cp).not.toBeNull();

    writeFileSync(join(workspaceDir, "file.txt"), "modified");
    mgr.snapshot("task-2", "Modified");

    const d = mgr.diff(cp!.hash);
    expect(d).toContain("original");
    expect(d).toContain("modified");
  });

  it("returns empty string when no checkpoints exist", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    expect(mgr.diff("abc")).toBe("");
  });
});

describe("prune", () => {
  it("removes old checkpoints beyond max count", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    // Create 5 checkpoints
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(workspaceDir, `file${i}.txt`), `content ${i}`);
      mgr.snapshot(`task-${i}`, `Checkpoint ${i}`);
    }

    expect(mgr.list().length).toBe(5);

    const pruned = mgr.prune(3);
    expect(pruned).toBe(2);

    // After pruning, only 3 should remain
    const remaining = mgr.list();
    expect(remaining.length).toBe(3);
  });

  it("does nothing when below max count", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);

    writeFileSync(join(workspaceDir, "a.txt"), "a");
    mgr.snapshot("task-1", "First");

    const pruned = mgr.prune(10);
    expect(pruned).toBe(0);
  });

  it("returns 0 when no checkpoints exist", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    expect(mgr.prune()).toBe(0);
  });
});

describe("shadow repo isolation", () => {
  it("does not create .git in workspace", () => {
    const mgr = createCheckpointManager(workspaceDir, checkpointsBase);
    writeFileSync(join(workspaceDir, "file.txt"), "content");
    mgr.snapshot("task-1", "Test");

    expect(existsSync(join(workspaceDir, ".git"))).toBe(false);
  });

  it("uses separate dirs for different workspaces", () => {
    const workspace2 = mkdtempSync(join(tmpdir(), "tc-ws2-"));
    try {
      writeFileSync(join(workspaceDir, "a.txt"), "a");
      writeFileSync(join(workspace2, "b.txt"), "b");

      const mgr1 = createCheckpointManager(workspaceDir, checkpointsBase);
      const mgr2 = createCheckpointManager(workspace2, checkpointsBase);

      mgr1.snapshot("task-1", "WS1");
      mgr2.snapshot("task-2", "WS2");

      const list1 = mgr1.list();
      const list2 = mgr2.list();

      expect(list1.length).toBe(1);
      expect(list1[0]!.taskId).toBe("task-1");
      expect(list2.length).toBe(1);
      expect(list2[0]!.taskId).toBe("task-2");
    } finally {
      rmSync(workspace2, { recursive: true, force: true });
    }
  });
});
