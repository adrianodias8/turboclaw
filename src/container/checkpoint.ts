import { join } from "path";
import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync } from "fs";
import { createHash } from "crypto";
import { logger } from "../logger";

export interface Checkpoint {
  hash: string;
  taskId: string;
  timestamp: number;
  message: string;
  stats: { files: number; insertions: number; deletions: number };
}

export interface CheckpointManager {
  /** Take a snapshot of the workspace. Returns the checkpoint or null if nothing changed. */
  snapshot(taskId: string, message: string): Checkpoint | null;
  /** List checkpoints for this workspace, newest first. */
  list(limit?: number): Checkpoint[];
  /** Restore workspace to a checkpoint. Takes a pre-restore snapshot first as safety net. */
  restore(hash: string): { ok: boolean; error?: string; safetyHash?: string };
  /** Show diff between a checkpoint and current state. */
  diff(hash: string): string;
  /** Prune old checkpoints beyond the max count. */
  prune(maxCount?: number): number;
}

const SHADOW_GITIGNORE = `.git
node_modules
.env
.env.*
__pycache__
venv
.venv
.turboclaw
bun.lockb
`;

const MAX_FILE_COUNT = 50000;
const DEFAULT_MAX_CHECKPOINTS = 50;

function hashWorkspacePath(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
}

function git(args: string[], checkpointDir: string, workspacePath: string): { stdout: string; stderr: string; exitCode: number } {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    GIT_DIR: join(checkpointDir, ".git"),
    GIT_WORK_TREE: workspacePath,
  };

  const result = Bun.spawnSync(["git", ...args], { env });
  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode,
  };
}

function countFiles(dir: string): number {
  let count = 0;
  const skipDirs = new Set([".git", "node_modules", "__pycache__", "venv", ".venv", ".turboclaw"]);

  function walk(current: string) {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          walk(join(current, entry.name));
        }
      } else {
        count++;
        if (count > MAX_FILE_COUNT) return;
      }
    }
  }

  walk(dir);
  return count;
}

function parseStats(diffStatOutput: string): { files: number; insertions: number; deletions: number } {
  // Parse the summary line from git diff --stat, e.g.:
  // " 3 files changed, 10 insertions(+), 2 deletions(-)"
  const stats = { files: 0, insertions: 0, deletions: 0 };
  const lines = diffStatOutput.split("\n");
  const summary = lines[lines.length - 1] ?? "";

  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/);
  if (filesMatch) stats.files = parseInt(filesMatch[1]!, 10);

  const insertionsMatch = summary.match(/(\d+)\s+insertions?\(\+\)/);
  if (insertionsMatch) stats.insertions = parseInt(insertionsMatch[1]!, 10);

  const deletionsMatch = summary.match(/(\d+)\s+deletions?\(-\)/);
  if (deletionsMatch) stats.deletions = parseInt(deletionsMatch[1]!, 10);

  return stats;
}

function ensureShadowRepo(checkpointDir: string, workspacePath: string): void {
  const gitDir = join(checkpointDir, ".git");
  if (!existsSync(gitDir)) {
    mkdirSync(checkpointDir, { recursive: true });
    const init = git(["init"], checkpointDir, workspacePath);
    if (init.exitCode !== 0) {
      throw new Error(`Failed to init shadow repo: ${init.stderr}`);
    }
    // Write exclude patterns for shadow repo (in git info/exclude, not .gitignore)
    // Since GIT_WORK_TREE is the workspace, .gitignore in checkpointDir won't be seen
    const infoDir = join(checkpointDir, ".git", "info");
    if (!existsSync(infoDir)) {
      mkdirSync(infoDir, { recursive: true });
    }
    writeFileSync(join(infoDir, "exclude"), SHADOW_GITIGNORE);
    // Configure user for commits and disable signing
    git(["config", "user.email", "turboclaw@local"], checkpointDir, workspacePath);
    git(["config", "user.name", "TurboClaw"], checkpointDir, workspacePath);
    git(["config", "commit.gpgsign", "false"], checkpointDir, workspacePath);
    git(["config", "tag.gpgsign", "false"], checkpointDir, workspacePath);
  }
}

export function createCheckpointManager(workspacePath: string, checkpointsBase: string): CheckpointManager {
  const dirHash = hashWorkspacePath(workspacePath);
  const checkpointDir = join(checkpointsBase, dirHash);

  function snapshot(taskId: string, message: string): Checkpoint | null {
    // Check file count before snapshotting
    const fileCount = countFiles(workspacePath);
    if (fileCount > MAX_FILE_COUNT) {
      logger.warn(`Workspace ${workspacePath} has ${fileCount} files (>${MAX_FILE_COUNT}) — skipping checkpoint`);
      return null;
    }

    ensureShadowRepo(checkpointDir, workspacePath);

    // Stage all changes
    const add = git(["add", "-A"], checkpointDir, workspacePath);
    if (add.exitCode !== 0) {
      logger.warn(`git add failed: ${add.stderr}`);
      return null;
    }

    // Check if there are staged changes
    const status = git(["status", "--porcelain"], checkpointDir, workspacePath);
    if (!status.stdout) {
      return null; // Nothing to commit
    }

    // Commit with taskId in message
    const commitMessage = `[${taskId}] ${message}`;
    const commit = git(["commit", "-m", commitMessage], checkpointDir, workspacePath);
    if (commit.exitCode !== 0) {
      logger.warn(`git commit failed: ${commit.stderr}`);
      return null;
    }

    // Get the commit hash
    const rev = git(["rev-parse", "HEAD"], checkpointDir, workspacePath);
    const hash = rev.stdout;

    // Get stats — HEAD~1 may not exist for the first commit
    const diffStat = git(["diff", "--stat", "HEAD~1", "HEAD"], checkpointDir, workspacePath);
    const stats = diffStat.exitCode === 0 ? parseStats(diffStat.stdout) : { files: 0, insertions: 0, deletions: 0 };

    // For first commit, use diff-tree to get stats
    if (diffStat.exitCode !== 0) {
      const treeStats = git(["diff-tree", "--stat", "--root", "HEAD"], checkpointDir, workspacePath);
      if (treeStats.exitCode === 0 && treeStats.stdout) {
        const parsed = parseStats(treeStats.stdout);
        stats.files = parsed.files;
        stats.insertions = parsed.insertions;
        stats.deletions = parsed.deletions;
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);

    return { hash, taskId, timestamp, message, stats };
  }

  function list(limit?: number): Checkpoint[] {
    if (!existsSync(join(checkpointDir, ".git"))) {
      return [];
    }

    const n = limit ?? DEFAULT_MAX_CHECKPOINTS;
    const log = git(["log", `--format=%H|%s|%at`, `-n`, String(n)], checkpointDir, workspacePath);
    if (log.exitCode !== 0 || !log.stdout) {
      return [];
    }

    const checkpoints: Checkpoint[] = [];
    for (const line of log.stdout.split("\n")) {
      if (!line) continue;
      const parts = line.split("|");
      if (parts.length < 3) continue;

      const hash = parts[0]!;
      const rawMessage = parts[1]!;
      const timestamp = parseInt(parts[2]!, 10);

      // Parse taskId from message: "[<taskId>] <message>"
      const taskIdMatch = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
      const taskId = taskIdMatch ? taskIdMatch[1]! : "";
      const message = taskIdMatch ? taskIdMatch[2]! : rawMessage;

      // Stats omitted for performance — fetch on demand via diff
      checkpoints.push({
        hash,
        taskId,
        timestamp,
        message,
        stats: { files: 0, insertions: 0, deletions: 0 },
      });
    }

    return checkpoints;
  }

  function restore(hash: string): { ok: boolean; error?: string; safetyHash?: string } {
    if (!existsSync(join(checkpointDir, ".git"))) {
      return { ok: false, error: "No checkpoints exist for this workspace" };
    }

    // Verify the hash exists
    const verify = git(["cat-file", "-t", hash], checkpointDir, workspacePath);
    if (verify.exitCode !== 0 || verify.stdout !== "commit") {
      return { ok: false, error: `Checkpoint ${hash} not found` };
    }

    // Take a safety snapshot before restoring
    let safetyHash: string | undefined;
    const safety = snapshot("pre-rollback", "Safety snapshot before rollback");
    if (safety) {
      safetyHash = safety.hash;
    }

    // Restore workspace to the checkpoint
    const checkout = git(["checkout", hash, "--", "."], checkpointDir, workspacePath);
    if (checkout.exitCode !== 0) {
      return { ok: false, error: `Restore failed: ${checkout.stderr}`, safetyHash };
    }

    return { ok: true, safetyHash };
  }

  function diff(hash: string): string {
    if (!existsSync(join(checkpointDir, ".git"))) {
      return "";
    }

    const result = git(["diff", hash, "HEAD"], checkpointDir, workspacePath);
    return result.stdout;
  }

  function prune(maxCount?: number): number {
    const max = maxCount ?? DEFAULT_MAX_CHECKPOINTS;
    if (!existsSync(join(checkpointDir, ".git"))) {
      return 0;
    }

    // Get all commit hashes
    const log = git(["log", "--format=%H"], checkpointDir, workspacePath);
    if (log.exitCode !== 0 || !log.stdout) {
      return 0;
    }

    const hashes = log.stdout.split("\n").filter(Boolean);
    if (hashes.length <= max) {
      return 0;
    }

    const pruneCount = hashes.length - max;
    // The oldest-to-keep is at index max-1 (0-indexed, newest first)
    const oldestToKeep = hashes[max - 1]!;

    // Reset to oldest-to-keep, discarding older history
    const reset = git(["reset", "--hard", oldestToKeep], checkpointDir, workspacePath);
    if (reset.exitCode !== 0) {
      logger.warn(`Checkpoint prune reset failed: ${reset.stderr}`);
      return 0;
    }

    // Garbage collect
    git(["gc", "--prune=now"], checkpointDir, workspacePath);

    return pruneCount;
  }

  return { snapshot, list, restore, diff, prune };
}
