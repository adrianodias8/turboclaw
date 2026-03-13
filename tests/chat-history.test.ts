import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createStore, type Store } from "../src/tracker/store";

let db: Database;
let store: Store;

beforeEach(() => {
  db = new Database(":memory:");
  store = createStore(db);
});

describe("chat messages", () => {
  const jid = "1234567890@s.whatsapp.net";

  it("adds and retrieves chat messages", () => {
    store.addChatMessage(jid, "user", "hello");
    store.addChatMessage(jid, "assistant", "hi there");

    const messages = store.getRecentChatMessages(jid);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("hello");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("hi there");
  });

  it("returns messages in chronological order", () => {
    store.addChatMessage(jid, "user", "first");
    store.addChatMessage(jid, "assistant", "second");
    store.addChatMessage(jid, "user", "third");

    const messages = store.getRecentChatMessages(jid);
    expect(messages[0]!.content).toBe("first");
    expect(messages[1]!.content).toBe("second");
    expect(messages[2]!.content).toBe("third");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.addChatMessage(jid, "user", `msg ${i}`);
    }

    const messages = store.getRecentChatMessages(jid, 3);
    expect(messages).toHaveLength(3);
    // Should return the last 3 messages
    expect(messages[0]!.content).toBe("msg 7");
    expect(messages[1]!.content).toBe("msg 8");
    expect(messages[2]!.content).toBe("msg 9");
  });

  it("isolates messages by jid", () => {
    const jid2 = "9876543210@s.whatsapp.net";
    store.addChatMessage(jid, "user", "from jid1");
    store.addChatMessage(jid2, "user", "from jid2");

    const messages1 = store.getRecentChatMessages(jid);
    expect(messages1).toHaveLength(1);
    expect(messages1[0]!.content).toBe("from jid1");

    const messages2 = store.getRecentChatMessages(jid2);
    expect(messages2).toHaveLength(1);
    expect(messages2[0]!.content).toBe("from jid2");
  });

  it("links messages to tasks", () => {
    const task = store.createTask({ title: "Test task" });
    store.addChatMessage(jid, "user", "do something", task.id);

    const msg = store.getChatMessageForTask(task.id);
    expect(msg).not.toBeNull();
    expect(msg!.content).toBe("do something");
    expect(msg!.task_id).toBe(task.id);
  });

  it("returns null for unknown task_id", () => {
    const msg = store.getChatMessageForTask("nonexistent");
    expect(msg).toBeNull();
  });

  it("stores messages without task_id", () => {
    store.addChatMessage(jid, "user", "just chatting");
    const messages = store.getRecentChatMessages(jid);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.task_id).toBeNull();
  });
});
