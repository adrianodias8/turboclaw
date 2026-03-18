import { Database } from "bun:sqlite";
import { join } from "path";
import { loadConfig } from "./config";
import { createStore } from "./tracker/store";
import { startGateway } from "./gateway/server";
import { createContainerManager } from "./container/manager";
import { startOrchestrator } from "./orchestrator/loop";
import { initVault } from "./memory/vault";
import { startLibrarian } from "./memory/scheduler";
import { renderApp, renderOnboarding } from "./tui/cli";
import { logger } from "./logger";
import { startWhatsAppBridge, type WhatsAppBridge } from "./whatsapp/bridge";
import type { AgentRole } from "./tracker/types";

const args = process.argv.slice(2);
const config = loadConfig();

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx >= args.length - 1) return undefined;
  return args[idx + 1];
}

const RESTART_EXIT_CODE = 75;

async function bootHeadless() {
  const db = new Database(config.dbPath);
  const store = createStore(db);
  const containerManager = createContainerManager(store);

  const restartToken = crypto.randomUUID();

  const vaultPath = join(config.home, "memory");
  initVault({ vaultPath });
  const librarian = startLibrarian(vaultPath, config.memory);

  let whatsappBridge: WhatsAppBridge | null = null;

  function gracefulShutdown(exitCode: number) {
    whatsappBridge?.stop();
    orchestrator.stop();
    librarian.stop();
    server.stop();
    db.close();
    process.exit(exitCode);
  }

  function doRestart() {
    logger.info("Executing restart (exit 75)...");
    gracefulShutdown(RESTART_EXIT_CODE);
  }

  const server = startGateway(store, config, {
    restartToken,
    requestRestart() {
      orchestrator.requestRestart(doRestart);
    },
    vaultPath: join(config.home, "memory"),
    skillsDir: join(config.home, "skills"),
    checkpointsBase: join(config.home, "checkpoints"),
    workspaceRoot: config.workspaceRoot ?? process.cwd(),
    home: config.home,
  });

  const orchestrator = startOrchestrator(store, containerManager, config, restartToken, doRestart);

  if (config.whatsapp.enabled) {
    try {
      whatsappBridge = await startWhatsAppBridge(store, config, {
        onRestart: doRestart,
      });
      logger.info("WhatsApp bridge started (QR code printed to terminal if not yet paired)");
    } catch (err) {
      logger.warn("WhatsApp bridge failed to start:", err);
    }
  }

  logger.info("TurboClaw running in headless mode");

  process.on("SIGINT", () => gracefulShutdown(0));

  return { db, store, server, orchestrator, librarian, whatsappBridge };
}

function handleTaskCreate() {
  const title = getArg("--title");
  if (!title) {
    console.error("Usage: bun run src/index.ts task create --title \"...\" [--role coder] [--priority 0]");
    process.exit(1);
  }

  const role = (getArg("--role") ?? "coder") as AgentRole;
  const priority = parseInt(getArg("--priority") ?? "0", 10);
  const description = getArg("--description") ?? null;

  const db = new Database(config.dbPath);
  const store = createStore(db);

  const task = store.createTask({ title, description, agentRole: role, priority });
  console.log(`Created task: ${task.id}`);
  console.log(`  Title: ${task.title}`);
  console.log(`  Role: ${task.agent_role}`);
  console.log(`  Priority: ${task.priority}`);
  console.log(`  Status: ${task.status}`);

  db.close();
}

if (args[0] === "backup") {
  const { createBackup } = await import("./backup/backup");
  const outputPath = getArg("--output");
  const result = createBackup(config.home, outputPath ?? undefined);
  if (result.ok) {
    console.log(`Backup created: ${result.path}`);
    console.log(`  Size: ${result.sizeBytes} bytes`);
    console.log(`  Components: ${result.manifest!.components.map(c => `${c.name}(${c.fileCount} files)`).join(", ")}`);
  } else {
    console.error(`Backup failed: ${result.error}`);
    process.exit(1);
  }
} else if (args[0] === "restore") {
  const { restoreBackup } = await import("./backup/backup");
  const archivePath = args.find(a => !a.startsWith("-") && a !== "restore");
  if (!archivePath) {
    console.error("Usage: bun run src/index.ts restore <path> [--dry-run]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const result = restoreBackup(archivePath, config.home, { dryRun });
  if (result.ok) {
    if (dryRun) {
      console.log(`Dry run — would restore: ${result.restoredComponents!.join(", ")}`);
    } else {
      console.log(`Restored: ${result.restoredComponents!.join(", ")}`);
      if (result.safetyBackupPath) console.log(`Safety backup: ${result.safetyBackupPath}`);
      process.exit(RESTART_EXIT_CODE);
    }
  } else {
    console.error(`Restore failed: ${result.error}`);
    process.exit(1);
  }
} else if (args[0] === "task" && args[1] === "create") {
  handleTaskCreate();
} else if (args.includes("--headless")) {
  bootHeadless();
} else if (args.includes("setup")) {
  renderOnboarding(config);
} else {
  renderApp(config);
}
