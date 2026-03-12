import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("crons", () => {
  it("creates a cron and returns it", () => {
    const cron = store.createCron({
      name: "nightly-build",
      schedule: "0 0 * * *",
      taskTemplate: { title: "Nightly build", agentRole: "coder", priority: 5 },
    });

    expect(cron.id).toBeTruthy();
    expect(cron.name).toBe("nightly-build");
    expect(cron.schedule).toBe("0 0 * * *");
    expect(JSON.parse(cron.task_template)).toEqual({
      title: "Nightly build",
      agentRole: "coder",
      priority: 5,
    });
    expect(cron.enabled).toBe(1);
    expect(cron.last_run_at).toBeNull();
    expect(cron.next_run_at).toBeNull();
    expect(cron.created_at).toBeTruthy();
  });

  it("gets a cron by id", () => {
    const cron = store.createCron({
      name: "test",
      schedule: "*/5 * * * *",
      taskTemplate: { title: "Test task" },
    });

    const fetched = store.getCron(cron.id);
    expect(fetched).toEqual(cron);
    expect(store.getCron("nonexistent")).toBeNull();
  });

  it("lists all crons", () => {
    store.createCron({
      name: "a",
      schedule: "0 * * * *",
      taskTemplate: { title: "A" },
    });
    store.createCron({
      name: "b",
      schedule: "0 0 * * *",
      taskTemplate: { title: "B" },
    });

    const crons = store.listCrons();
    expect(crons).toHaveLength(2);
  });

  it("getDueCrons returns crons where next_run_at <= now or next_run_at is null and enabled=1", () => {
    // Cron with null next_run_at and enabled — should be due
    const c1 = store.createCron({
      name: "due-null",
      schedule: "* * * * *",
      taskTemplate: { title: "Due null" },
    });

    // Cron with past next_run_at and enabled — should be due
    const c2 = store.createCron({
      name: "due-past",
      schedule: "* * * * *",
      taskTemplate: { title: "Due past" },
    });
    const pastTime = Math.floor(Date.now() / 1000) - 3600;
    store.updateCronLastRun(c2.id, pastTime - 60, pastTime);

    // Cron with future next_run_at — should NOT be due
    const c3 = store.createCron({
      name: "future",
      schedule: "* * * * *",
      taskTemplate: { title: "Future" },
    });
    const futureTime = Math.floor(Date.now() / 1000) + 3600;
    store.updateCronLastRun(c3.id, Math.floor(Date.now() / 1000), futureTime);

    // Disabled cron with null next_run_at — should NOT be due
    const c4 = store.createCron({
      name: "disabled",
      schedule: "* * * * *",
      taskTemplate: { title: "Disabled" },
    });
    store.updateCronEnabled(c4.id, false);

    const due = store.getDueCrons();
    const dueIds = due.map((c) => c.id);
    expect(dueIds).toContain(c1.id);
    expect(dueIds).toContain(c2.id);
    expect(dueIds).not.toContain(c3.id);
    expect(dueIds).not.toContain(c4.id);
  });

  it("updateCronLastRun updates timestamps", () => {
    const cron = store.createCron({
      name: "test",
      schedule: "*/5 * * * *",
      taskTemplate: { title: "Test" },
    });

    const now = Math.floor(Date.now() / 1000);
    const next = now + 300;
    store.updateCronLastRun(cron.id, now, next);

    const updated = store.getCron(cron.id);
    expect(updated!.last_run_at).toBe(now);
    expect(updated!.next_run_at).toBe(next);
  });

  it("updateCronEnabled toggles enabled", () => {
    const cron = store.createCron({
      name: "test",
      schedule: "0 * * * *",
      taskTemplate: { title: "Test" },
    });
    expect(cron.enabled).toBe(1);

    store.updateCronEnabled(cron.id, false);
    expect(store.getCron(cron.id)!.enabled).toBe(0);

    store.updateCronEnabled(cron.id, true);
    expect(store.getCron(cron.id)!.enabled).toBe(1);
  });

  it("deleteCron removes cron", () => {
    const cron = store.createCron({
      name: "test",
      schedule: "0 * * * *",
      taskTemplate: { title: "Test" },
    });

    store.deleteCron(cron.id);
    expect(store.getCron(cron.id)).toBeNull();
    expect(store.listCrons()).toHaveLength(0);
  });
});
