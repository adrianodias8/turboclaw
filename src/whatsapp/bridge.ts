import pino from "pino";
import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { parseMessage, formatHelp } from "./parser";
import { startNotifier, type NotifierHandle } from "./notifier";
import { join } from "path";
import { mkdirSync } from "fs";

export interface WhatsAppBridge {
  stop(): void;
  isConnected(): boolean;
}

export interface WhatsAppBridgeOptions {
  /** Called when a QR code needs to be scanned. If not provided, prints to terminal. */
  onQR?: (qr: string) => void;
  /** Called when a pairing code is generated. Log it or show in TUI. */
  onPairingCode?: (code: string) => void;
}

// Create a pino logger for Baileys — it expects pino specifically
const baileysLogger = pino({ level: "warn" });

export async function startWhatsAppBridge(
  store: Store,
  config: TurboClawConfig,
  opts: WhatsAppBridgeOptions = {}
): Promise<WhatsAppBridge> {
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    Browsers,
  } = baileys;

  const waConfig = config.whatsapp;
  const authDir = join(config.home, "whatsapp-auth");
  mkdirSync(authDir, { recursive: true });

  let connected = false;
  let notifier: NotifierHandle | null = null;
  let sock: ReturnType<typeof makeWASocket> | null = null;
  let shouldReconnect = true;
  let alertedThisSession = false;
  let reconnectAttempts = 0;
  const sentMessageIds = new Set<string>();

  // Use pairing code method if we have a phone number in allowedNumbers
  const pairingNumber = waConfig.allowedNumbers[0] ?? null;
  const usePairingCode = !!pairingNumber;

  async function connect(isReconnect = false) {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Fetch latest WA Web version for protocol compatibility (like bunclaw does)
    const { version } = await fetchLatestWaWebVersion({}).catch((err: unknown) => {
      logger.warn("Failed to fetch latest WA Web version, using default:", err);
      return { version: undefined };
    });

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: Browsers.macOS("Chrome"),
    });

    sock.ev.on("creds.update", saveCreds);

    // Request pairing code if using phone number method
    if (usePairingCode && !state.creds.registered && !isReconnect) {
      setTimeout(async () => {
        try {
          const code = await sock!.requestPairingCode(pairingNumber!);
          logger.info(`WhatsApp pairing code: ${code}`);
          logger.info(`Enter this code in WhatsApp > Linked Devices > Link with phone number`);
          if (opts.onPairingCode) {
            opts.onPairingCode(code);
          }
        } catch (err) {
          logger.warn("Failed to request pairing code:", err);
        }
      }, 3000);
    }

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (opts.onQR) {
          opts.onQR(qr);
        }
        logger.info("WhatsApp QR code generated — scan with your phone");
      }

      if (connection === "close") {
        connected = false;
        const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = err?.output?.statusCode;

        // Handle 515 stream error specifically — reconnect immediately
        // This often happens after pairing succeeds but before registration completes
        if (statusCode === 515) {
          logger.info("WhatsApp stream error (515) — reconnecting immediately...");
          connect(true);
          return;
        }

        const shouldRetry = statusCode !== DisconnectReason.loggedOut;

        if (shouldRetry && shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 60000);
          logger.info(`WhatsApp disconnected (code: ${statusCode}), reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
          if (!alertedThisSession) {
            store.createAlert("whatsapp_disconnect", "WhatsApp disconnected, attempting reconnect");
            alertedThisSession = true;
          }
          setTimeout(() => connect(true), delay);
        } else {
          logger.info("WhatsApp logged out — need to re-pair");
          store.createAlert("whatsapp_disconnect", "WhatsApp logged out — re-pair to reconnect");
        }
      }

      if (connection === "open") {
        connected = true;
        reconnectAttempts = 0;
        alertedThisSession = false;
        logger.info("WhatsApp connected successfully");

        if (!notifier) {
          notifier = startNotifier(store, sendMessage, {
            notifyOnComplete: waConfig.notifyOnComplete,
            notifyOnFail: waConfig.notifyOnFail,
          });
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        // Skip messages sent by this bridge (avoid echo loops)
        if (msg.key.id && sentMessageIds.has(msg.key.id)) {
          sentMessageIds.delete(msg.key.id);
          continue;
        }

        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast") continue;

        const number = jid.split("@")[0] ?? "";
        if (waConfig.allowedNumbers.length > 0 && !waConfig.allowedNumbers.includes(number)) {
          continue;
        }

        const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        logger.info(`WhatsApp message from ${number}: ${text}`);

        const command = parseMessage(text);
        let reply = "";

        switch (command.type) {
          case "task": {
            if (!command.args) {
              reply = "Please provide a task title.";
              break;
            }
            const task = store.createTask({ title: command.args });
            store.updateTaskStatus(task.id, "queued");
            reply = `Task created: ${task.title}\nID: ${task.id.slice(0, 8)}\nStatus: queued`;
            break;
          }
          case "status": {
            const health = store.getHealthStatus();
            reply = [
              `*TurboClaw Status*`,
              `Queue: ${health.queueDepth}`,
              `Workers: ${health.activeWorkers}`,
              `Running: ${health.runningCount}`,
              `Failed: ${health.failedCount}`,
            ].join("\n");
            break;
          }
          case "list": {
            const tasks = store.listTasks({ limit: 10 });
            if (tasks.length === 0) {
              reply = "No tasks.";
            } else {
              reply = tasks.map((t) => `${t.status} | ${t.title} (${t.id.slice(0, 8)})`).join("\n");
            }
            break;
          }
          case "cancel": {
            const tasks = store.listTasks({ limit: 100 });
            const match = tasks.find((t) => t.id.startsWith(command.args));
            if (!match) {
              reply = `No task found starting with: ${command.args}`;
            } else {
              const cancelled = store.cancelTask(match.id);
              reply = cancelled
                ? `Cancelled: ${cancelled.title} (${cancelled.id.slice(0, 8)})`
                : `Could not cancel task.`;
            }
            break;
          }
          case "help":
            reply = formatHelp();
            break;
          case "unknown":
            reply = `Unknown command. ${formatHelp()}`;
            break;
        }

        if (reply) {
          try {
            const sent = await sock!.sendMessage(jid, { text: reply });
            if (sent?.key?.id) sentMessageIds.add(sent.key.id);
          } catch (err) {
            logger.warn("Failed to send WhatsApp reply:", err);
          }
        }
      }
    });
  }

  async function sendMessage(text: string): Promise<void> {
    if (!sock || !connected) return;

    for (const num of waConfig.allowedNumbers) {
      const jid = `${num}@s.whatsapp.net`;
      try {
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id) sentMessageIds.add(sent.key.id);
      } catch (err) {
        logger.warn(`Failed to send to ${num}:`, err);
      }
    }
  }

  await connect();

  return {
    stop() {
      shouldReconnect = false;
      notifier?.stop();
      sock?.end(undefined);
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}
