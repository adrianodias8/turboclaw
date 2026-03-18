import {
  mkdirSync,
  existsSync,
  copyFileSync,
  readdirSync,
  statSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "fs";
import { join, relative } from "path";
import { logger } from "../logger";
import type {
  BackupManifest,
  BackupComponent,
  BackupResult,
  RestoreResult,
} from "./types";

const BACKUP_EXTENSION = ".tcbackup.tar.gz";

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function copyDirRecursive(src: string, dest: string): { fileCount: number; sizeBytes: number } {
  let fileCount = 0;
  let sizeBytes = 0;

  if (!existsSync(src)) {
    return { fileCount, sizeBytes };
  }

  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src);
  for (const entry of entries) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      const sub = copyDirRecursive(srcPath, destPath);
      fileCount += sub.fileCount;
      sizeBytes += sub.sizeBytes;
    } else if (stat.isFile()) {
      mkdirSync(dest, { recursive: true });
      copyFileSync(srcPath, destPath);
      fileCount += 1;
      sizeBytes += stat.size;
    }
  }

  return { fileCount, sizeBytes };
}

function flushWal(dbPath: string): void {
  try {
    const result = Bun.spawnSync(["sqlite3", dbPath, "PRAGMA wal_checkpoint(TRUNCATE);"]);
    if (result.exitCode !== 0) {
      logger.warn(`WAL checkpoint returned exit code ${result.exitCode}`);
    }
  } catch (err) {
    logger.warn("Failed to flush WAL (sqlite3 may not be installed):", err);
  }
}

export function createBackup(home: string, outputPath?: string): BackupResult {
  try {
    const backupsDir = join(home, "backups");
    mkdirSync(backupsDir, { recursive: true });

    const filename = `backup-${formatTimestamp()}${BACKUP_EXTENSION}`;
    const archivePath = outputPath ?? join(backupsDir, filename);

    // Create temp staging directory
    const stagingDir = join(home, "backups", `.staging-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    const components: BackupComponent[] = [];

    try {
      // 1. Config
      const configPath = join(home, "config.json");
      if (existsSync(configPath)) {
        const stat = statSync(configPath);
        copyFileSync(configPath, join(stagingDir, "config.json"));
        components.push({ name: "config", fileCount: 1, sizeBytes: stat.size });
      }

      // 2. Database — flush WAL first
      const dbPath = join(home, "turboclaw.db");
      if (existsSync(dbPath)) {
        flushWal(dbPath);

        const dbStagingDir = join(stagingDir, "database");
        mkdirSync(dbStagingDir, { recursive: true });

        let fileCount = 0;
        let sizeBytes = 0;

        copyFileSync(dbPath, join(dbStagingDir, "turboclaw.db"));
        fileCount += 1;
        sizeBytes += statSync(dbPath).size;

        const walPath = `${dbPath}-wal`;
        if (existsSync(walPath)) {
          copyFileSync(walPath, join(dbStagingDir, "turboclaw.db-wal"));
          fileCount += 1;
          sizeBytes += statSync(walPath).size;
        }

        const shmPath = `${dbPath}-shm`;
        if (existsSync(shmPath)) {
          copyFileSync(shmPath, join(dbStagingDir, "turboclaw.db-shm"));
          fileCount += 1;
          sizeBytes += statSync(shmPath).size;
        }

        components.push({ name: "database", fileCount, sizeBytes });
      }

      // 3. Memory
      const memoryDir = join(home, "memory");
      if (existsSync(memoryDir)) {
        const result = copyDirRecursive(memoryDir, join(stagingDir, "memory"));
        if (result.fileCount > 0) {
          components.push({ name: "memory", fileCount: result.fileCount, sizeBytes: result.sizeBytes });
        }
      }

      // 4. Skills
      const skillsDir = join(home, "skills");
      if (existsSync(skillsDir)) {
        const result = copyDirRecursive(skillsDir, join(stagingDir, "skills"));
        if (result.fileCount > 0) {
          components.push({ name: "skills", fileCount: result.fileCount, sizeBytes: result.sizeBytes });
        }
      }

      // 5. Checkpoints
      const checkpointsDir = join(home, "checkpoints");
      if (existsSync(checkpointsDir)) {
        const result = copyDirRecursive(checkpointsDir, join(stagingDir, "checkpoints"));
        if (result.fileCount > 0) {
          components.push({ name: "checkpoints", fileCount: result.fileCount, sizeBytes: result.sizeBytes });
        }
      }

      // Write manifest
      const manifest: BackupManifest = {
        version: 1,
        createdAt: Math.floor(Date.now() / 1000),
        components,
      };
      writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));

      // Create tar.gz archive
      const tarResult = Bun.spawnSync(["tar", "czf", archivePath, "-C", stagingDir, "."]);
      if (tarResult.exitCode !== 0) {
        const stderr = tarResult.stderr.toString();
        return { ok: false, error: `tar failed (exit ${tarResult.exitCode}): ${stderr}` };
      }

      const archiveStat = statSync(archivePath);

      logger.info(`Backup created: ${archivePath} (${archiveStat.size} bytes, ${components.length} components)`);

      return {
        ok: true,
        path: archivePath,
        sizeBytes: archiveStat.size,
        manifest,
      };
    } finally {
      // Clean up staging dir
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Backup failed:", message);
    return { ok: false, error: message };
  }
}

export function restoreBackup(
  archivePath: string,
  home: string,
  opts?: { dryRun?: boolean },
): RestoreResult {
  try {
    if (!existsSync(archivePath)) {
      return { ok: false, error: `Archive not found: ${archivePath}` };
    }

    // Extract to temp dir
    const tempDir = join(home, "backups", `.restore-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    try {
      const extractResult = Bun.spawnSync(["tar", "xzf", archivePath, "-C", tempDir]);
      if (extractResult.exitCode !== 0) {
        const stderr = extractResult.stderr.toString();
        return { ok: false, error: `tar extract failed (exit ${extractResult.exitCode}): ${stderr}` };
      }

      // Read and validate manifest
      const manifestPath = join(tempDir, "manifest.json");
      if (!existsSync(manifestPath)) {
        return { ok: false, error: "Invalid backup: missing manifest.json" };
      }

      let manifest: BackupManifest;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as BackupManifest;
      } catch {
        return { ok: false, error: "Invalid backup: corrupted manifest.json" };
      }

      if (manifest.version !== 1) {
        return { ok: false, error: `Unsupported backup version: ${manifest.version}` };
      }

      const componentNames = manifest.components.map((c) => c.name);

      // Dry run — just return what would be restored
      if (opts?.dryRun) {
        return { ok: true, restoredComponents: componentNames };
      }

      // Safety backup before restore
      const safetyResult = createBackup(home);
      const safetyBackupPath = safetyResult.ok ? safetyResult.path : undefined;

      if (!safetyResult.ok) {
        logger.warn("Safety backup failed, proceeding with restore anyway:", safetyResult.error);
      }

      const restoredComponents: string[] = [];

      // Restore config
      if (componentNames.includes("config")) {
        const srcConfig = join(tempDir, "config.json");
        if (existsSync(srcConfig)) {
          copyFileSync(srcConfig, join(home, "config.json"));
          restoredComponents.push("config");
        }
      }

      // Restore database — remove existing WAL/SHM first
      if (componentNames.includes("database")) {
        const dbDir = join(tempDir, "database");
        const dbDest = join(home, "turboclaw.db");

        // Remove existing WAL/SHM files
        const walDest = `${dbDest}-wal`;
        const shmDest = `${dbDest}-shm`;
        if (existsSync(walDest)) rmSync(walDest);
        if (existsSync(shmDest)) rmSync(shmDest);

        const srcDb = join(dbDir, "turboclaw.db");
        if (existsSync(srcDb)) {
          copyFileSync(srcDb, dbDest);

          const srcWal = join(dbDir, "turboclaw.db-wal");
          if (existsSync(srcWal)) copyFileSync(srcWal, walDest);

          const srcShm = join(dbDir, "turboclaw.db-shm");
          if (existsSync(srcShm)) copyFileSync(srcShm, shmDest);

          restoredComponents.push("database");
        }
      }

      // Restore memory
      if (componentNames.includes("memory")) {
        const srcMemory = join(tempDir, "memory");
        const destMemory = join(home, "memory");
        if (existsSync(srcMemory)) {
          if (existsSync(destMemory)) rmSync(destMemory, { recursive: true, force: true });
          copyDirRecursive(srcMemory, destMemory);
          restoredComponents.push("memory");
        }
      }

      // Restore skills
      if (componentNames.includes("skills")) {
        const srcSkills = join(tempDir, "skills");
        const destSkills = join(home, "skills");
        if (existsSync(srcSkills)) {
          if (existsSync(destSkills)) rmSync(destSkills, { recursive: true, force: true });
          copyDirRecursive(srcSkills, destSkills);
          restoredComponents.push("skills");
        }
      }

      // Restore checkpoints
      if (componentNames.includes("checkpoints")) {
        const srcCheckpoints = join(tempDir, "checkpoints");
        const destCheckpoints = join(home, "checkpoints");
        if (existsSync(srcCheckpoints)) {
          if (existsSync(destCheckpoints)) rmSync(destCheckpoints, { recursive: true, force: true });
          copyDirRecursive(srcCheckpoints, destCheckpoints);
          restoredComponents.push("checkpoints");
        }
      }

      logger.info(`Restore complete: ${restoredComponents.join(", ")} from ${archivePath}`);

      return {
        ok: true,
        restoredComponents,
        safetyBackupPath,
      };
    } finally {
      // Clean up temp dir
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Restore failed:", message);
    return { ok: false, error: message };
  }
}

export function listBackups(home: string): Array<{ path: string; createdAt: number; sizeBytes: number }> {
  const backupsDir = join(home, "backups");
  if (!existsSync(backupsDir)) {
    return [];
  }

  const entries = readdirSync(backupsDir);
  const backups: Array<{ path: string; createdAt: number; sizeBytes: number }> = [];

  for (const entry of entries) {
    if (!entry.endsWith(BACKUP_EXTENSION)) continue;
    const fullPath = join(backupsDir, entry);
    const stat = statSync(fullPath);
    if (!stat.isFile()) continue;

    backups.push({
      path: fullPath,
      createdAt: Math.floor(stat.mtimeMs / 1000),
      sizeBytes: stat.size,
    });
  }

  // Sort newest first
  backups.sort((a, b) => b.createdAt - a.createdAt);

  return backups;
}
