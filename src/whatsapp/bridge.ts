import pino from "pino";
import { logger } from "../logger";
import type { Store } from "../tracker/store";
import type { TurboClawConfig } from "../config";
import { parseMessage, formatHelp } from "./parser";
import { startNotifier, type NotifierHandle } from "./notifier";
import { parseTimeReference } from "./time-parser";
import { join } from "path";
import { mkdirSync } from "fs";

export interface WhatsAppGroup {
  id: string;
  subject: string;
}

export interface WhatsAppBridge {
  stop(): void;
  isConnected(): boolean;
  getJoinedGroups(): Promise<WhatsAppGroup[]>;
}

export interface WhatsAppBridgeOptions {
  /** Called when a QR code needs to be scanned. If not provided, prints to terminal. */
  onQR?: (qr: string) => void;
  /** Called when a pairing code is generated. Log it or show in TUI. */
  onPairingCode?: (code: string) => void;
}

// Create a pino logger for Baileys — it expects pino specifically
const baileysLogger = pino({ level: "silent" });

export async function startWhatsAppBridge(
  store: Store,
  config: TurboClawConfig,
  opts: WhatsAppBridgeOptions = {}
): Promise<WhatsAppBridge> {
  const typingRefreshMs = 3000;
  const baileys = await import("@whiskeysockets/baileys");
  const makeWASocket = baileys.default ?? baileys.makeWASocket;
  const {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
  } = baileys;

  // Read whatsapp config live — settings may change at runtime via TUI
  const getWaConfig = () => config.whatsapp;
  const authDir = join(config.home, "whatsapp-auth");
  mkdirSync(authDir, { recursive: true });

  let connected = false;
  let notifier: NotifierHandle | null = null;
  let sock: ReturnType<typeof makeWASocket> | null = null;
  let shouldReconnect = true;
  let alertedThisSession = false;
  let reconnectAttempts = 0;
  const sentMessageIds = new Set<string>();
  // Track which tasks came from WhatsApp and which chat to reply to
  const whatsappTaskJids = new Map<string, string>();
  const activeTypingByJid = new Map<string, ReturnType<typeof setInterval>>();

  // Use pairing code method if we have a phone number in allowedNumbers
  const pairingNumber = getWaConfig().allowedNumbers[0] ?? null;
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

    // Track whether pairing code has been requested for this connection attempt
    let pairingCodeRequested = false;

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (opts.onQR) {
          opts.onQR(qr);
        }
        logger.info("WhatsApp QR code generated — scan with your phone");
      }

      // Request pairing code once the connection is open enough to accept requests
      // Baileys emits connection updates before "open" — we request on the first
      // update that isn't a close/qr, or after a short delay once socket exists
      if (usePairingCode && !state.creds.registered && !pairingCodeRequested && !qr && connection !== "close") {
        pairingCodeRequested = true;
        // Small delay to let the socket stabilize
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
            // Reset so next reconnect can try again
            pairingCodeRequested = false;
          }
        }, 2000);
      }

      if (connection === "close") {
        // Stop all typing indicators before marking as disconnected
        // so we send "paused" while the socket is still alive
        for (const jid of activeTypingByJid.keys()) {
          stopTypingPresence(jid).catch(() => {});
        }
        connected = false;
        const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = err?.output?.statusCode;

        // Handle 515 stream error — reconnect immediately
        // This often happens after pairing succeeds but before registration completes
        if (statusCode === 515) {
          logger.info("WhatsApp stream error (515) — reconnecting immediately...");
          connect(true);
          return;
        }

        // Handle 428 precondition error — server not ready, retry quickly
        if (statusCode === 428) {
          reconnectAttempts++;
          const delay = Math.min(2000 * reconnectAttempts, 10000);
          logger.info(`WhatsApp not ready (428), retrying in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
          setTimeout(() => connect(true), delay);
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
        store.acknowledgeAlertsByKind("whatsapp_disconnect");
        logger.info("WhatsApp connected successfully");

        // Announce availability so WhatsApp relays presence updates (typing indicators)
        sock!.sendPresenceUpdate("available").catch((err) => {
          logger.warn("Failed to send available presence:", err);
        });

        if (!notifier) {
          notifier = startNotifier(store, sendMessage, {
            notifyOnComplete: getWaConfig().notifyOnComplete,
            notifyOnFail: getWaConfig().notifyOnFail,
            getTaskJid: (taskId) => whatsappTaskJids.get(taskId),
          });
        } else if (isReconnect) {
          // Reset notifier so missed notifications get retried
          notifier.reset();
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

        const isGroup = jid.endsWith("@g.us");
        const groupId = isGroup ? jid.split("@")[0] ?? "" : "";
        const number = isGroup ? "" : jid.split("@")[0] ?? "";

        if (isGroup) {
          // Only accept messages from explicitly allowed groups
          if (!getWaConfig().allowedGroups.includes(groupId)) continue;
        } else {
          // Individual chat: only accept from explicitly allowed numbers,
          // or self-chat (message sent by the account owner to themselves).
          // If allowedNumbers is empty (QR pairing), only self-chat is accepted
          // to prevent rogue processing of messages from random contacts.
          //
          // Self-chat = remoteJid matches the account owner's JID.
          // Note: fromMe alone is NOT sufficient — it's true for every outgoing
          // message to ANY contact, not just self-chat.
          // Use jidNormalizedUser to strip device suffix (e.g. 123:5@s.whatsapp.net → 123@s.whatsapp.net)
          const ownJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : "";
          const isSelfChat = !!ownJid && jid === ownJid;
          if (isSelfChat) {
            // Self-chat is always allowed — it's the account owner
          } else if (getWaConfig().allowedNumbers.length === 0) {
            // No allowed numbers configured — reject all non-self individual chats
            continue;
          } else if (!getWaConfig().allowedNumbers.includes(number)) {
            continue;
          }
        }

        const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        const sender = isGroup ? `group:${groupId}` : number;
        logger.info(`WhatsApp message from ${sender}: ${text}`);

        const command = parseMessage(text);
        let reply = "";
        let taskIdForChat: string | null = null;
        let shouldSendTypingPresence = false;

        switch (command.type) {
          case "prompt": {
            // Check for time references like "in 5 minutes" or "at 14:30"
            const scheduled = parseTimeReference(command.args);
            if (scheduled) {
              // Create a one-shot cron that fires at the scheduled time
              const cronName = scheduled.prompt.length > 40
                ? scheduled.prompt.slice(0, 37) + "..."
                : scheduled.prompt;
              store.createCron({
                name: cronName,
                schedule: "@once",
                taskTemplate: {
                  title: cronName,
                  description: scheduled.prompt,
                  replyJid: jid,
                },
                oneShot: true,
                nextRunAt: scheduled.scheduledAt,
              });
              reply = `Got it, I'll do that in ${scheduled.humanDelay}.`;
              break;
            }

            // Immediate execution — create task with prompt as description
            const title = command.args.length > 80
              ? command.args.slice(0, 77) + "..."
              : command.args;
            const task = store.createTask({
              title,
              description: command.args,
              replyJid: jid,
            });
            store.updateTaskStatus(task.id, "queued");
            // Track which tasks came from WhatsApp so we can reply with output
            whatsappTaskJids.set(task.id, jid);
            taskIdForChat = task.id;
            reply = "On it...";
            shouldSendTypingPresence = true;
            break;
          }
          case "task": {
            if (!command.args) {
              reply = "Please provide a task description.";
              break;
            }
            const title = command.args.length > 80
              ? command.args.slice(0, 77) + "..."
              : command.args;
            const task = store.createTask({
              title,
              description: command.args,
              replyJid: jid,
            });
            store.updateTaskStatus(task.id, "queued");
            whatsappTaskJids.set(task.id, jid);
            taskIdForChat = task.id;
            reply = "On it...";
            shouldSendTypingPresence = true;
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
            reply = `Unknown command. Type /help for commands, or just send a message.`;
            break;
        }

        // Record user message in chat history
        store.addChatMessage(jid, "user", text, taskIdForChat);

        if (shouldSendTypingPresence) {
          const typingStarted = await startTypingPresence(jid);
          if (typingStarted) {
            // Typing indicator replaces the "On it..." text reply
            reply = "";
          }
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

  async function sendMessage(text: string, targetJid?: string): Promise<boolean> {
    if (!sock || !connected) return false;

    if (!targetJid) {
      // No target JID — this is a notification for a non-WhatsApp task.
      // Only send if there are explicitly configured allowed numbers.
      // Never broadcast blindly — that's how messages leak to random contacts.
      if (getWaConfig().allowedNumbers.length === 0) {
        logger.info("Skipping notification — no targetJid and no allowedNumbers configured");
        return true; // intentionally skipped, not a failure
      }
      for (const num of getWaConfig().allowedNumbers) {
        const numJid = `${num}@s.whatsapp.net`;
        try {
          const sent = await sock.sendMessage(numJid, { text });
          if (sent?.key?.id) sentMessageIds.add(sent.key.id);
        } catch (err) {
          logger.warn(`Failed to send to ${num}:`, err);
          return false;
        }
      }
      return true;
    } else {
      // Send to specific chat (reply to the conversation that triggered the task)
      try {
        await stopTypingPresence(targetJid);
        const sent = await sock.sendMessage(targetJid, { text });
        if (sent?.key?.id) sentMessageIds.add(sent.key.id);
        return true;
      } catch (err) {
        logger.warn(`Failed to send to ${targetJid}:`, err);
        return false;
      }
    }
  }

  async function startTypingPresence(targetJid: string): Promise<boolean> {
    if (!sock || !connected) return false;
    if (activeTypingByJid.has(targetJid)) return true;

    try {
      await sock.sendPresenceUpdate("composing", targetJid);
    } catch (err) {
      logger.warn(`Failed to send typing presence to ${targetJid}:`, err);
      return false;
    }

    const interval = setInterval(() => {
      if (!sock || !connected) return;
      void sock.sendPresenceUpdate("composing", targetJid).catch((err) => {
        logger.warn(`Failed to refresh typing presence for ${targetJid}:`, err);
      });
    }, typingRefreshMs);
    activeTypingByJid.set(targetJid, interval);
    return true;
  }

  async function stopTypingPresence(targetJid: string): Promise<void> {
    const timer = activeTypingByJid.get(targetJid);
    if (timer) {
      clearInterval(timer);
      activeTypingByJid.delete(targetJid);
    }

    if (!sock || !connected) return;
    try {
      await sock.sendPresenceUpdate("paused", targetJid);
    } catch (err) {
      logger.warn(`Failed to clear typing presence for ${targetJid}:`, err);
    }
  }

  await connect();

  return {
    stop() {
      shouldReconnect = false;
      // Send "paused" for all active typing JIDs before disconnecting
      for (const jid of activeTypingByJid.keys()) {
        stopTypingPresence(jid).catch(() => {});
      }
      notifier?.stop();
      sock?.end(undefined);
      connected = false;
    },
    isConnected() {
      return connected;
    },
    async getJoinedGroups(): Promise<WhatsAppGroup[]> {
      if (!sock || !connected) return [];
      try {
        const groups = await sock.groupFetchAllParticipating();
        return Object.values(groups).map((g) => ({
          id: g.id.split("@")[0] ?? g.id,
          subject: g.subject,
        }));
      } catch (err) {
        logger.warn("Failed to fetch WhatsApp groups:", err);
        return [];
      }
    },
  };
}
