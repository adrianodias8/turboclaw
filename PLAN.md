# Implementation Plan: Bug Fixes, Security Hardening & Backup/Restore

## Part 1: Bug Fixes (6 items)

### 1.1 Fix auto-memory deduplication — `n.filename` → basename of `n.path`
**File:** `src/memory/auto-memory.ts:26`
**Bug:** `MemoryNote` has no `filename` property (only `path`). This silently fails — `undefined.startsWith()` throws, caught by caller, dedup never works.
**Fix:** `import { basename } from "path"` and change `n.filename` to `basename(n.path)`.
**Test:** Add test case in `tests/auto-memory.test.ts` verifying dedup skips when task log already exists.

### 1.2 Wire instinct decay into librarian scheduler
**File:** `src/memory/scheduler.ts` (in the `run()` function, after `pruneExpiredMemories`)
**Bug:** `decayInstincts()` in `src/memory/instincts.ts:249` is fully implemented but never called. Instincts accumulate forever.
**Fix:** Import `decayInstincts` from `../memory/instincts` and call it at the end of the librarian's `run()` function (line ~64, after `pruneExpiredMemories`). Log result.
**Test:** Add test case in existing instincts or memory test verifying decay is triggered.

### 1.3 Add gateway error boundary
**File:** `src/gateway/server.ts:21-28`
**Bug:** If `handleRequest(req)` throws, Bun's server crashes. No try-catch.
**Fix:** Wrap the `await handleRequest(req)` call in try-catch. On error, log it and return `500 { error: "Internal server error" }`. Never expose the error message to the client (security).

### 1.4 Validate skill name on PATCH/DELETE routes (path traversal)
**File:** `src/gateway/routes.ts:334-358`
**Bug:** POST route validates skill name via `createSkill()` → `validateSkillName()`, but PATCH/DELETE use the raw URL segment directly. A name like `../../etc` would resolve via `join()` in `findSkill()` and escape the skills directory.
**Fix:** Import `validateSkillName` from `../skills/manager` and call it at the top of the PATCH/DELETE block (line ~337). Return 400 if invalid. The regex `SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/` already blocks `..`, `/`, and all traversal chars.
**Test:** Add test in `tests/skills-manager.test.ts` or `tests/gateway.test.ts` for path traversal attempts on PATCH/DELETE.

### 1.5 Validate checkpoint hash format
**File:** `src/gateway/routes.ts:370-392`
**Bug:** `hash` parameter passed directly to git commands without format validation.
**Fix:** Add a hex hash regex check: `/^[0-9a-f]{7,64}$/i`. Return 400 if invalid. Apply to both POST `/checkpoints/restore` and GET `/checkpoints/diff`.

### 1.6 Validate workspace parameter against allowed roots
**File:** `src/gateway/routes.ts:361-392`
**Bug:** `workspace` query param can be any arbitrary path.
**Fix:** Use `path.resolve()` on the workspace param and verify it starts with `path.resolve(opts.workspaceRoot)` or equals it. Return 403 if it escapes the allowed root. Apply to all 3 checkpoint routes.

---

## Part 2: Security Hardening

### 2.1 Add rate limiting to gateway
**File:** New helper in `src/gateway/rate-limit.ts`, wired in `src/gateway/server.ts`
**Design:** Simple in-memory token bucket per IP. Config: `{ windowMs: 60000, maxRequests: 120 }`. No dependency needed.
- Map of `ip → { count, resetAt }`
- Check before `handleRequest()` in server.ts fetch
- Return `429 Too Many Requests` when exceeded
- Cleanup expired entries every 60s
- `/health` endpoint exempt (used by Docker healthcheck)
**Test:** Add test in `tests/gateway.test.ts` verifying 429 after exceeding limit.

---

## Part 3: Backup & Restore Feature (WPVivid-style)

### Overview
Zip snapshot of ALL TurboClaw state (config, database, memory vault, skills, checkpoints) into a single `.tcbackup.zip` file. Restore imports the zip and overwrites everything.

### 3.1 New module: `src/backup/backup.ts`

**What gets backed up:**
| Component | Source Path | Zip Path |
|-----------|------------|----------|
| Config | `.turboclaw/config.json` | `config.json` |
| Database | `.turboclaw/turboclaw.db` | `turboclaw.db` |
| Memory vault | `.turboclaw/memory/**` | `memory/` |
| Skills | `.turboclaw/skills/**` | `skills/` |
| Checkpoints | `.turboclaw/checkpoints/**` | `checkpoints/` |
| Instincts | `.turboclaw/memory/instincts/**` | `memory/instincts/` |

**What is NOT backed up:**
- Log files (ephemeral)
- WhatsApp auth state (session-specific)
- The workspace itself (user manages this via git)
- `node_modules`, lock files

### 3.2 Export function

```typescript
export function createBackup(home: string, outputPath?: string): { path: string; sizeBytes: number; manifest: BackupManifest }
```

**Steps:**
1. Generate manifest: `{ version: 1, createdAt: unix_ts, turboClawVersion: "x.y.z", components: [...] }`
2. Close DB WAL: Execute `PRAGMA wal_checkpoint(TRUNCATE)` to flush WAL before copying (critical for SQLite integrity)
3. Use Bun's `Bun.file()` + a zip library to build the archive
4. Walk each component directory, add files preserving relative paths
5. Add `manifest.json` at zip root
6. Write to `outputPath ?? ".turboclaw/backups/backup-{timestamp}.tcbackup.zip"`
7. Return path + size + manifest

**Zip library:** Use `node:zlib` + tar (no external dep needed). Or since we need directory structure, use the lightweight `archiver`-compatible approach with Bun's built-in zip support via `Bun.spawn(["zip", ...])` — zip is available on all Linux systems.

Actually, simpler: use `tar` + `gzip` via `Bun.spawnSync()` since this is Linux-only (Hetzner target). Output: `.tcbackup.tar.gz`. Avoids any npm dependency.

### 3.3 Import/Restore function

```typescript
export function restoreBackup(archivePath: string, home: string, opts?: { dryRun?: boolean }): RestoreResult
```

**Steps:**
1. Extract to temp dir
2. Read and validate `manifest.json` (version check, component list)
3. If `dryRun`, return what would be restored (component list, sizes)
4. **Safety snapshot**: Copy current state to `.turboclaw/backups/pre-restore-{timestamp}.tar.gz` (rollback safety net, same pattern as checkpoint restore)
5. Close/detach SQLite DB if open (caller responsibility — document this)
6. Copy each component:
   - `config.json` → `.turboclaw/config.json`
   - `turboclaw.db` → `.turboclaw/turboclaw.db`
   - `memory/` → `.turboclaw/memory/` (rm + copy, not merge)
   - `skills/` → `.turboclaw/skills/` (rm + copy)
   - `checkpoints/` → `.turboclaw/checkpoints/` (rm + copy)
7. Clean up temp dir
8. Return `{ ok: true, restoredComponents: [...], safetyBackupPath: "..." }`

### 3.4 API routes

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | /backup | `{ outputPath? }` | Create backup, returns manifest + download path |
| GET | /backup/latest | — | Download the most recent backup file |
| GET | /backups | — | List available backups (from `.turboclaw/backups/`) |
| POST | /backup/restore | `{ path }` | Restore from backup file. Returns safety backup path. TurboClaw auto-restarts after (exit 75). |
| POST | /backup/restore/dry-run | `{ path }` | Preview what would be restored |

### 3.5 TUI integration

Add backup/restore actions to the **Settings screen** (`src/tui/screens/settings.tsx`):
- `[b]` Create Backup — runs export, shows progress + result path
- `[r]` Restore Backup — file picker (list from `.turboclaw/backups/`), confirm dialog, restore + restart

### 3.6 CLI integration

In `src/index.ts`, add two new subcommands:
```
bun run src/index.ts backup                    # Create backup
bun run src/index.ts backup --output /path     # Create backup at specific path
bun run src/index.ts restore /path/to/backup   # Restore from backup
bun run src/index.ts restore --dry-run /path   # Preview restore
```

### 3.7 Tests

New test file: `tests/backup.test.ts`
- Creates a temp `.turboclaw/` with config, DB, memory notes, skills
- Runs `createBackup()`, verifies archive contains all components
- Runs `restoreBackup()` to a fresh directory, verifies all files restored
- Verifies manifest format and version
- Verifies dry-run returns correct preview without modifying anything
- Verifies safety backup is created before restore
- Verifies invalid/corrupted archives are rejected gracefully

---

## Implementation Order

1. **Bug fixes** (1.1–1.6) — immediate, all are small targeted changes
2. **Rate limiting** (2.1) — small, self-contained
3. **Backup module** (3.2) — core export logic
4. **Restore module** (3.3) — core import logic
5. **Backup tests** (3.7) — validate before wiring up
6. **API routes** (3.4) — wire into gateway
7. **CLI subcommands** (3.6) — wire into index.ts
8. **TUI integration** (3.5) — add to settings screen

---

## Files Modified

| File | Changes |
|------|---------|
| `src/memory/auto-memory.ts` | Fix `n.filename` → `basename(n.path)` |
| `src/memory/scheduler.ts` | Add `decayInstincts()` call |
| `src/gateway/server.ts` | Add try-catch error boundary |
| `src/gateway/routes.ts` | Skill name validation on PATCH/DELETE, hash validation, workspace validation, backup routes |
| `src/gateway/rate-limit.ts` | **New** — token bucket rate limiter |
| `src/backup/backup.ts` | **New** — createBackup + restoreBackup + listBackups |
| `src/backup/types.ts` | **New** — BackupManifest, RestoreResult types |
| `src/index.ts` | Add `backup` and `restore` CLI subcommands |
| `src/tui/screens/settings.tsx` | Add [b] backup and [r] restore keybindings |
| `tests/auto-memory.test.ts` | Add dedup test |
| `tests/gateway.test.ts` | Add rate limit + path traversal tests |
| `tests/backup.test.ts` | **New** — full backup/restore test suite |
