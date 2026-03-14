import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("alerts", () => {
  it("creates an alert", () => {
    const alert = store.createAlert("task_failed", "Task xyz failed after 3 retries");
    expect(alert.id).toBeTruthy();
    expect(alert.kind).toBe("task_failed");
    expect(alert.message).toBe("Task xyz failed after 3 retries");
    expect(alert.task_id).toBeNull();
    expect(alert.acknowledged).toBe(0);
    expect(alert.created_at).toBeTruthy();
  });

  it("creates an alert with task_id", () => {
    const task = store.createTask({ title: "test task" });
    const alert = store.createAlert("task_failed", "Failed", task.id);
    expect(alert.task_id).toBe(task.id);
  });

  it("listAlerts returns all alerts", () => {
    store.createAlert("task_failed", "Fail 1");
    store.createAlert("lease_expired", "Lease expired");
    store.createAlert("task_failed", "Fail 2");

    const alerts = store.listAlerts();
    expect(alerts).toHaveLength(3);
  });

  it("listAlerts with acknowledged: false returns only unacknowledged", () => {
    const a1 = store.createAlert("task_failed", "Fail 1");
    store.createAlert("task_failed", "Fail 2");

    store.acknowledgeAlert(a1.id);

    const unack = store.listAlerts({ acknowledged: false });
    expect(unack).toHaveLength(1);
    expect(unack[0]!.message).toBe("Fail 2");
  });

  it("acknowledgeAlert marks one as acknowledged", () => {
    const a1 = store.createAlert("task_failed", "Fail 1");
    const a2 = store.createAlert("task_failed", "Fail 2");

    store.acknowledgeAlert(a1.id);

    const all = store.listAlerts();
    const acked = all.find((a) => a.id === a1.id);
    const notAcked = all.find((a) => a.id === a2.id);
    expect(acked!.acknowledged).toBe(1);
    expect(notAcked!.acknowledged).toBe(0);
  });

  it("acknowledgeAllAlerts marks all as acknowledged", () => {
    store.createAlert("task_failed", "Fail 1");
    store.createAlert("lease_expired", "Expired");
    store.createAlert("task_failed", "Fail 2");

    store.acknowledgeAllAlerts();

    const unack = store.listAlerts({ acknowledged: false });
    expect(unack).toHaveLength(0);

    const all = store.listAlerts();
    expect(all).toHaveLength(3);
    for (const alert of all) {
      expect(alert.acknowledged).toBe(1);
    }
  });

  it("acknowledgeAlertsByKind only acknowledges matching kind", () => {
    store.createAlert("task_failed", "Fail 1");
    store.createAlert("lease_expired", "Lease 1");
    store.createAlert("task_failed", "Fail 2");
    store.createAlert("whatsapp_disconnect", "WA disconnected");

    store.acknowledgeAlertsByKind("task_failed");

    const unack = store.listAlerts({ acknowledged: false });
    expect(unack).toHaveLength(2);
    expect(unack.map(a => a.kind).sort()).toEqual(["lease_expired", "whatsapp_disconnect"]);

    // All alerts still exist, but only task_failed ones are acknowledged
    const all = store.listAlerts();
    expect(all).toHaveLength(4);
    const acked = all.filter(a => a.acknowledged === 1);
    expect(acked).toHaveLength(2);
    for (const a of acked) {
      expect(a.kind).toBe("task_failed");
    }
  });

  it("getUnacknowledgedAlertCount returns correct count", () => {
    expect(store.getUnacknowledgedAlertCount()).toBe(0);

    store.createAlert("task_failed", "Fail 1");
    store.createAlert("task_failed", "Fail 2");
    store.createAlert("lease_expired", "Expired");
    expect(store.getUnacknowledgedAlertCount()).toBe(3);

    const a = store.createAlert("task_failed", "Fail 3");
    store.acknowledgeAlert(a.id);
    expect(store.getUnacknowledgedAlertCount()).toBe(3);

    store.acknowledgeAllAlerts();
    expect(store.getUnacknowledgedAlertCount()).toBe(0);
  });
});
