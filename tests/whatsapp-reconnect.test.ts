/**
 * WhatsApp bridge reconnection tests.
 *
 * Since the bridge is deeply coupled to Baileys (dynamic import, socket events),
 * we test the reconnection logic by extracting and testing the connection.update
 * handler behavior patterns directly, rather than trying to mock Baileys internals.
 *
 * These tests validate:
 * - 515 stream error → immediate reconnect
 * - 428 precondition → exponential backoff reconnect
 * - loggedOut → no reconnect
 * - Generic disconnect → exponential backoff with alert
 * - Heartbeat failure → reconnect trigger
 * - Reconnect attempt counter reset on successful open
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

afterEach(() => {
  db.close();
});

/**
 * Simulates the reconnection state machine from bridge.ts.
 * This is a direct extraction of the connection.update handler logic.
 */
function createReconnectStateMachine(st: Store) {
  let connected = false;
  let shouldReconnect = true;
  let alertedThisSession = false;
  let reconnectAttempts = 0;
  const reconnectCalls: { delay: number; isReconnect: boolean }[] = [];
  const LOGGED_OUT = 401; // DisconnectReason.loggedOut

  function handleConnectionClose(statusCode: number | undefined) {
    connected = false;

    // 515 stream error — immediate reconnect
    if (statusCode === 515) {
      reconnectCalls.push({ delay: 0, isReconnect: true });
      return;
    }

    // 428 precondition — quick exponential backoff
    if (statusCode === 428) {
      reconnectAttempts++;
      const delay = Math.min(2000 * reconnectAttempts, 10000);
      reconnectCalls.push({ delay, isReconnect: true });
      return;
    }

    const shouldRetry = statusCode !== LOGGED_OUT;

    if (shouldRetry && shouldReconnect) {
      reconnectAttempts++;
      const delay = Math.min(3000 * Math.pow(2, reconnectAttempts - 1), 60000);
      if (!alertedThisSession) {
        st.createAlert("whatsapp_disconnect", "WhatsApp disconnected, attempting reconnect");
        alertedThisSession = true;
      }
      reconnectCalls.push({ delay, isReconnect: true });
    } else {
      // Logged out — no reconnect
      st.createAlert("whatsapp_disconnect", "WhatsApp logged out — re-pair to reconnect");
    }
  }

  function handleConnectionOpen() {
    connected = true;
    reconnectAttempts = 0;
    alertedThisSession = false;
    st.acknowledgeAlertsByKind("whatsapp_disconnect");
  }

  function handleHeartbeatFailure() {
    connected = false;
    if (shouldReconnect) {
      reconnectCalls.push({ delay: 0, isReconnect: true });
    }
  }

  return {
    get connected() { return connected; },
    get reconnectAttempts() { return reconnectAttempts; },
    get reconnectCalls() { return reconnectCalls; },
    handleConnectionClose,
    handleConnectionOpen,
    handleHeartbeatFailure,
    stop() { shouldReconnect = false; },
  };
}

describe("WhatsApp reconnection: 515 stream error", () => {
  it("reconnects immediately on 515", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(515);

    expect(sm.reconnectCalls).toHaveLength(1);
    expect(sm.reconnectCalls[0].delay).toBe(0);
    expect(sm.reconnectCalls[0].isReconnect).toBe(true);
    expect(sm.connected).toBe(false);
  });

  it("does not create alert on 515", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(515);

    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(0);
  });

  it("does not increment reconnect attempts on 515", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(515);

    expect(sm.reconnectAttempts).toBe(0);
  });
});

describe("WhatsApp reconnection: 428 precondition", () => {
  it("reconnects with exponential backoff on 428", () => {
    const sm = createReconnectStateMachine(store);

    sm.handleConnectionClose(428);
    expect(sm.reconnectCalls).toHaveLength(1);
    expect(sm.reconnectCalls[0].delay).toBe(2000); // 2000 * 1

    sm.handleConnectionClose(428);
    expect(sm.reconnectCalls).toHaveLength(2);
    expect(sm.reconnectCalls[1].delay).toBe(4000); // 2000 * 2

    sm.handleConnectionClose(428);
    expect(sm.reconnectCalls).toHaveLength(3);
    expect(sm.reconnectCalls[2].delay).toBe(6000); // 2000 * 3
  });

  it("caps 428 backoff at 10 seconds", () => {
    const sm = createReconnectStateMachine(store);

    for (let i = 0; i < 10; i++) {
      sm.handleConnectionClose(428);
    }

    const lastDelay = sm.reconnectCalls[sm.reconnectCalls.length - 1].delay;
    expect(lastDelay).toBeLessThanOrEqual(10000);
  });

  it("does not create alert on 428", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(428);

    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(0);
  });
});

describe("WhatsApp reconnection: generic disconnect", () => {
  it("reconnects with exponential backoff", () => {
    const sm = createReconnectStateMachine(store);

    sm.handleConnectionClose(500);
    expect(sm.reconnectCalls).toHaveLength(1);
    expect(sm.reconnectCalls[0].delay).toBe(3000); // 3000 * 2^0

    sm.handleConnectionClose(500);
    expect(sm.reconnectCalls).toHaveLength(2);
    expect(sm.reconnectCalls[1].delay).toBe(6000); // 3000 * 2^1

    sm.handleConnectionClose(500);
    expect(sm.reconnectCalls).toHaveLength(3);
    expect(sm.reconnectCalls[2].delay).toBe(12000); // 3000 * 2^2
  });

  it("caps backoff at 60 seconds", () => {
    const sm = createReconnectStateMachine(store);

    for (let i = 0; i < 10; i++) {
      sm.handleConnectionClose(500);
    }

    const lastDelay = sm.reconnectCalls[sm.reconnectCalls.length - 1].delay;
    expect(lastDelay).toBeLessThanOrEqual(60000);
  });

  it("creates alert on first disconnect only", () => {
    const sm = createReconnectStateMachine(store);

    sm.handleConnectionClose(500);
    sm.handleConnectionClose(500);
    sm.handleConnectionClose(500);

    // Only one alert for the session
    const alerts = store.listAlerts();
    const disconnectAlerts = alerts.filter((a) => a.kind === "whatsapp_disconnect");
    expect(disconnectAlerts).toHaveLength(1);
    expect(disconnectAlerts[0].message).toContain("attempting reconnect");
  });

  it("handles undefined status code as non-fatal", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(undefined);

    expect(sm.reconnectCalls).toHaveLength(1);
    expect(sm.reconnectCalls[0].isReconnect).toBe(true);
  });
});

describe("WhatsApp reconnection: loggedOut", () => {
  it("does not reconnect on loggedOut (401)", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(401);

    expect(sm.reconnectCalls).toHaveLength(0);
  });

  it("creates re-pair alert on loggedOut", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionClose(401);

    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toContain("re-pair");
  });
});

describe("WhatsApp reconnection: connection open", () => {
  it("resets reconnect attempts on open", () => {
    const sm = createReconnectStateMachine(store);

    // Simulate a few disconnects
    sm.handleConnectionClose(500);
    sm.handleConnectionClose(500);
    expect(sm.reconnectAttempts).toBe(2);

    // Connection opens
    sm.handleConnectionOpen();
    expect(sm.reconnectAttempts).toBe(0);
    expect(sm.connected).toBe(true);
  });

  it("acknowledges disconnect alerts on open", () => {
    const sm = createReconnectStateMachine(store);

    sm.handleConnectionClose(500);
    const alertsBefore = store.listAlerts().filter((a) => !a.acknowledged);
    expect(alertsBefore).toHaveLength(1);

    sm.handleConnectionOpen();
    const alertsAfter = store.listAlerts().filter((a) => !a.acknowledged);
    expect(alertsAfter).toHaveLength(0);
  });

  it("resets alert session flag on open", () => {
    const sm = createReconnectStateMachine(store);

    // First disconnect creates alert
    sm.handleConnectionClose(500);
    sm.handleConnectionOpen();

    // Second disconnect after reconnection creates a new alert
    sm.handleConnectionClose(500);
    const alerts = store.listAlerts().filter((a) => !a.acknowledged);
    expect(alerts).toHaveLength(1);
  });
});

describe("WhatsApp reconnection: heartbeat", () => {
  it("triggers reconnect on heartbeat failure", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionOpen();
    expect(sm.connected).toBe(true);

    sm.handleHeartbeatFailure();
    expect(sm.connected).toBe(false);
    expect(sm.reconnectCalls).toHaveLength(1);
  });

  it("does not reconnect on heartbeat failure after stop()", () => {
    const sm = createReconnectStateMachine(store);
    sm.handleConnectionOpen();
    sm.stop();

    sm.handleHeartbeatFailure();
    expect(sm.connected).toBe(false);
    expect(sm.reconnectCalls).toHaveLength(0);
  });
});

describe("WhatsApp reconnection: stop prevents reconnect", () => {
  it("does not reconnect after stop() on generic disconnect", () => {
    const sm = createReconnectStateMachine(store);
    sm.stop();

    sm.handleConnectionClose(500);
    expect(sm.reconnectCalls).toHaveLength(0);
  });

  it("515 still reconnects immediately regardless (happens before stop check)", () => {
    const sm = createReconnectStateMachine(store);
    // 515 reconnects before checking shouldReconnect in the real code
    sm.handleConnectionClose(515);
    expect(sm.reconnectCalls).toHaveLength(1);
  });
});

describe("WhatsApp reconnection: mixed scenarios", () => {
  it("428 → 428 → open → 515 → open flow", () => {
    const sm = createReconnectStateMachine(store);

    // Two 428 errors
    sm.handleConnectionClose(428);
    sm.handleConnectionClose(428);
    expect(sm.reconnectAttempts).toBe(2);
    expect(sm.reconnectCalls).toHaveLength(2);

    // Connection opens
    sm.handleConnectionOpen();
    expect(sm.reconnectAttempts).toBe(0);

    // 515 stream error
    sm.handleConnectionClose(515);
    expect(sm.reconnectCalls).toHaveLength(3);
    expect(sm.reconnectCalls[2].delay).toBe(0);

    // Connection opens again
    sm.handleConnectionOpen();
    expect(sm.connected).toBe(true);
    expect(sm.reconnectAttempts).toBe(0);
  });

  it("generic disconnect → open → generic disconnect creates two alerts", () => {
    const sm = createReconnectStateMachine(store);

    sm.handleConnectionClose(500);
    sm.handleConnectionOpen();
    sm.handleConnectionClose(500);

    const allAlerts = store.listAlerts();
    const disconnectAlerts = allAlerts.filter((a) => a.kind === "whatsapp_disconnect" && a.message.includes("attempting reconnect"));
    expect(disconnectAlerts).toHaveLength(2);
  });
});
