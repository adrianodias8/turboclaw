import React from "react";
import { render } from "ink";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { TurboClawConfig } from "../config";
import { createStore } from "../tracker/store";
import { startGateway } from "../gateway/server";
import { createContainerManager } from "../container/manager";
import { startOrchestrator } from "../orchestrator/loop";
import { initVault } from "../memory/vault";
import { startLibrarian } from "../memory/scheduler";
import { startWhatsAppBridge, type WhatsAppBridge } from "../whatsapp/bridge";
import { logger, setLogFile } from "../logger";
import { App } from "./app";
import { Onboarding } from "./screens/onboarding";

const RESTART_EXIT_CODE = 75;

export function renderApp(config: TurboClawConfig) {
  // Redirect logs to file so they don't corrupt the TUI
  setLogFile(join(config.home, "turboclaw.log"));
  const db = new Database(config.dbPath);
  const store = createStore(db);
  const containerManager = createContainerManager(store);

  const restartToken = crypto.randomUUID();

  const vaultPath = join(config.home, "memory");
  initVault({ vaultPath });
  const librarian = startLibrarian(vaultPath, config.memory);

  const startedAt = Math.floor(Date.now() / 1000);

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
    logger.info("TUI mode: executing restart (exit 75)...");
    gracefulShutdown(RESTART_EXIT_CODE);
  }

  const server = startGateway(store, config, {
    restartToken,
    requestRestart() {
      orchestrator.requestRestart(doRestart);
    },
  });

  const orchestrator = startOrchestrator(store, containerManager, config, restartToken, doRestart);

  function renderTUI(bridge: WhatsAppBridge | null) {
    const instance = render(
      <App store={store} initialConfig={config} startedAt={startedAt} whatsappBridge={bridge} />
    );

    instance.waitUntilExit().then(() => {
      whatsappBridge?.stop();
      orchestrator.stop();
      librarian.stop();
      server.stop();
      db.close();
    });
  }

  if (config.whatsapp.enabled) {
    startWhatsAppBridge(store, config)
      .then((bridge) => {
        whatsappBridge = bridge;
        logger.info("WhatsApp bridge started");
        renderTUI(bridge);
      })
      .catch((err) => {
        logger.warn("WhatsApp bridge failed to start:", err);
        renderTUI(null);
      });
  } else {
    renderTUI(null);
  }
}

export function renderOnboarding(config: TurboClawConfig) {
  const instance = render(
    <Onboarding
      config={config}
      onComplete={() => {
        instance.unmount();
        // Ensure process exits even if background timers/sockets are alive
        setTimeout(() => process.exit(0), 200);
      }}
    />
  );
}
