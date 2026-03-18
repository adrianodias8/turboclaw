import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createBackup, restoreBackup, listBackups } from "../src/backup/backup";

const TEST_HOME = join(import.meta.dir, ".test-backup-home");

beforeEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
  mkdirSync(TEST_HOME, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
});

function seedConfig() {
  writeFileSync(
    join(TEST_HOME, "config.json"),
    JSON.stringify({ gateway: { port: 7800 } }),
  );
}

function seedMemory() {
  const memDir = join(TEST_HOME, "memory", "core");
  mkdirSync(memDir, { recursive: true });
  writeFileSync(join(memDir, "identity.md"), "# Identity\nI am a test agent.");
  const tasksDir = join(TEST_HOME, "memory", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "task-log-1.md"), "# Task Log\nCompleted a task.");
}

function seedSkills() {
  const skillDir = join(TEST_HOME, "skills", "my-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# My Skill\nDoes something.");
}

function seedCheckpoints() {
  const cpDir = join(TEST_HOME, "checkpoints", "abc123");
  mkdirSync(cpDir, { recursive: true });
  writeFileSync(join(cpDir, "HEAD"), "deadbeef");
}

describe("createBackup", () => {
  it("creates a backup with config and memory files", () => {
    seedConfig();
    seedMemory();

    const result = createBackup(TEST_HOME);

    expect(result.ok).toBe(true);
    expect(result.path).toBeDefined();
    expect(result.path!.endsWith(".tcbackup.tar.gz")).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.version).toBe(1);
    expect(result.manifest!.createdAt).toBeGreaterThan(0);

    const componentNames = result.manifest!.components.map((c) => c.name);
    expect(componentNames).toContain("config");
    expect(componentNames).toContain("memory");

    // Archive file should exist on disk
    expect(existsSync(result.path!)).toBe(true);
  });

  it("backs up all components when all are present", () => {
    seedConfig();
    seedMemory();
    seedSkills();
    seedCheckpoints();

    const result = createBackup(TEST_HOME);
    expect(result.ok).toBe(true);

    const componentNames = result.manifest!.components.map((c) => c.name);
    expect(componentNames).toContain("config");
    expect(componentNames).toContain("memory");
    expect(componentNames).toContain("skills");
    expect(componentNames).toContain("checkpoints");
  });

  it("creates backup in custom output path", () => {
    seedConfig();
    const customPath = join(TEST_HOME, "my-backup.tcbackup.tar.gz");
    const result = createBackup(TEST_HOME, customPath);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);
  });

  it("succeeds with empty home (no components)", () => {
    const result = createBackup(TEST_HOME);
    expect(result.ok).toBe(true);
    expect(result.manifest!.components).toHaveLength(0);
  });
});

describe("restoreBackup", () => {
  it("restores all files from archive", () => {
    seedConfig();
    seedMemory();
    seedSkills();

    // Create backup
    const backupResult = createBackup(TEST_HOME);
    expect(backupResult.ok).toBe(true);
    const archivePath = backupResult.path!;

    // Wipe the originals
    rmSync(join(TEST_HOME, "config.json"));
    rmSync(join(TEST_HOME, "memory"), { recursive: true, force: true });
    rmSync(join(TEST_HOME, "skills"), { recursive: true, force: true });

    // Restore
    const restoreResult = restoreBackup(archivePath, TEST_HOME);
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.restoredComponents).toContain("config");
    expect(restoreResult.restoredComponents).toContain("memory");
    expect(restoreResult.restoredComponents).toContain("skills");

    // Verify files are back
    expect(existsSync(join(TEST_HOME, "config.json"))).toBe(true);
    const restoredConfig = JSON.parse(readFileSync(join(TEST_HOME, "config.json"), "utf-8"));
    expect(restoredConfig.gateway.port).toBe(7800);

    expect(existsSync(join(TEST_HOME, "memory", "core", "identity.md"))).toBe(true);
    const restoredMemory = readFileSync(join(TEST_HOME, "memory", "core", "identity.md"), "utf-8");
    expect(restoredMemory).toContain("I am a test agent");

    expect(existsSync(join(TEST_HOME, "skills", "my-skill", "SKILL.md"))).toBe(true);
  });

  it("returns component list on dry run without modifying files", () => {
    seedConfig();
    seedMemory();

    const backupResult = createBackup(TEST_HOME);
    expect(backupResult.ok).toBe(true);

    // Modify config to detect if it gets overwritten
    writeFileSync(join(TEST_HOME, "config.json"), JSON.stringify({ gateway: { port: 9999 } }));

    const restoreResult = restoreBackup(backupResult.path!, TEST_HOME, { dryRun: true });
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.restoredComponents).toContain("config");
    expect(restoreResult.restoredComponents).toContain("memory");

    // Config should NOT have been changed
    const currentConfig = JSON.parse(readFileSync(join(TEST_HOME, "config.json"), "utf-8"));
    expect(currentConfig.gateway.port).toBe(9999);
  });

  it("creates safety backup before restore", () => {
    seedConfig();

    const backupResult = createBackup(TEST_HOME);
    expect(backupResult.ok).toBe(true);

    const restoreResult = restoreBackup(backupResult.path!, TEST_HOME);
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.safetyBackupPath).toBeDefined();
    expect(existsSync(restoreResult.safetyBackupPath!)).toBe(true);
  });

  it("returns error for invalid archive path", () => {
    const result = restoreBackup("/nonexistent/archive.tar.gz", TEST_HOME);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("returns error for corrupted/missing manifest", () => {
    // Create a tar.gz without manifest.json
    const fakeDir = join(TEST_HOME, ".fake-staging");
    mkdirSync(fakeDir, { recursive: true });
    writeFileSync(join(fakeDir, "dummy.txt"), "hello");

    const fakePath = join(TEST_HOME, "fake.tcbackup.tar.gz");
    Bun.spawnSync(["tar", "czf", fakePath, "-C", fakeDir, "."]);
    rmSync(fakeDir, { recursive: true });

    const result = restoreBackup(fakePath, TEST_HOME);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("manifest");
  });
});

describe("listBackups", () => {
  it("returns entries sorted newest first", () => {
    seedConfig();

    // Create two backups with slight delay to ensure different timestamps
    const result1 = createBackup(TEST_HOME);
    expect(result1.ok).toBe(true);

    // Create a second backup with a distinct name
    const secondPath = join(TEST_HOME, "backups", "backup-2099-01-01-000000.tcbackup.tar.gz");
    const result2 = createBackup(TEST_HOME, secondPath);
    expect(result2.ok).toBe(true);

    const backups = listBackups(TEST_HOME);
    expect(backups.length).toBeGreaterThanOrEqual(2);

    // All entries should have valid fields
    for (const b of backups) {
      expect(b.path).toBeDefined();
      expect(b.createdAt).toBeGreaterThan(0);
      expect(b.sizeBytes).toBeGreaterThan(0);
    }

    // Should be sorted newest first (descending createdAt)
    for (let i = 1; i < backups.length; i++) {
      expect(backups[i - 1].createdAt).toBeGreaterThanOrEqual(backups[i].createdAt);
    }
  });

  it("returns empty array when no backups directory", () => {
    const backups = listBackups(TEST_HOME);
    expect(backups).toEqual([]);
  });

  it("ignores non-backup files", () => {
    const backupsDir = join(TEST_HOME, "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, "readme.txt"), "not a backup");

    const backups = listBackups(TEST_HOME);
    expect(backups).toHaveLength(0);
  });
});
