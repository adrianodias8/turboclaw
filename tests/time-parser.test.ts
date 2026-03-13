import { describe, expect, test } from "bun:test";
import { parseTimeReference } from "../src/whatsapp/time-parser";

describe("parseTimeReference", () => {
  test("returns null for plain text with no time reference", () => {
    expect(parseTimeReference("tell me a joke")).toBeNull();
    expect(parseTimeReference("what time is it")).toBeNull();
    expect(parseTimeReference("hello")).toBeNull();
  });

  test("parses 'in X minutes' at start", () => {
    const result = parseTimeReference("in 5 minutes tell me a joke");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("tell me a joke");
    expect(result!.humanDelay).toBe("5 minutes");
    const now = Math.floor(Date.now() / 1000);
    expect(result!.scheduledAt).toBeGreaterThan(now + 290);
    expect(result!.scheduledAt).toBeLessThan(now + 310);
  });

  test("parses 'in X minutes' in the middle", () => {
    const result = parseTimeReference("tell me the weather in 2 minutes");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("tell me the weather");
    expect(result!.humanDelay).toBe("2 minutes");
  });

  test("parses 'in X minutes' with surrounding text", () => {
    const result = parseTimeReference("remind me in 10 minutes to check the deploy");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("remind me to check the deploy");
    expect(result!.humanDelay).toBe("10 minutes");
  });

  test("parses 'in 1 minute'", () => {
    const result = parseTimeReference("in 1 minute do something");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("do something");
    expect(result!.humanDelay).toBe("1 minute");
  });

  test("parses 'in 2 hours'", () => {
    const result = parseTimeReference("in 2 hours check the server");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the server");
    expect(result!.humanDelay).toBe("2 hours");
    const now = Math.floor(Date.now() / 1000);
    expect(result!.scheduledAt).toBeGreaterThan(now + 7190);
    expect(result!.scheduledAt).toBeLessThan(now + 7210);
  });

  test("parses 'in 30 seconds'", () => {
    const result = parseTimeReference("in 30 seconds ping me");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("ping me");
    expect(result!.humanDelay).toBe("30 seconds");
  });

  test("parses word numbers like 'in five minutes'", () => {
    const result = parseTimeReference("in five minutes remind me to eat");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("remind me to eat");
    expect(result!.humanDelay).toBe("5 minutes");
  });

  test("parses 'in half an hour'", () => {
    const result = parseTimeReference("in half an hour check the deploy");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the deploy");
    expect(result!.humanDelay).toBe("30 minutes");
  });

  test("parses 'in half an hour' in the middle", () => {
    const result = parseTimeReference("check the deploy in half an hour");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the deploy");
    expect(result!.humanDelay).toBe("30 minutes");
  });

  test("parses 'at HH:MM'", () => {
    const result = parseTimeReference("at 14:30 send me a summary");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("send me a summary");
    expect(result!.humanDelay).toBe("14:30");
  });

  test("parses 'at HH:MM' at end", () => {
    const result = parseTimeReference("send me a summary at 14:30");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("send me a summary");
    expect(result!.humanDelay).toBe("14:30");
  });

  test("parses 'at HH:MMam/pm'", () => {
    const result = parseTimeReference("at 2:30pm run the report");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("run the report");
    expect(result!.humanDelay).toBe("14:30");
  });

  test("parses 'at Xpm' without colon", () => {
    const result = parseTimeReference("check the server at 3pm");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the server");
    expect(result!.humanDelay).toBe("15:00");
  });

  test("parses 'tomorrow' with default 9am", () => {
    const result = parseTimeReference("tomorrow check the logs");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the logs");
    expect(result!.humanDelay).toBe("tomorrow at 9:00");
  });

  test("parses 'tomorrow' at end", () => {
    const result = parseTimeReference("check the logs tomorrow");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("check the logs");
    expect(result!.humanDelay).toBe("tomorrow at 9:00");
  });

  test("parses 'tomorrow at HH:MM'", () => {
    const result = parseTimeReference("tomorrow at 10:00 deploy the fix");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("deploy the fix");
    expect(result!.humanDelay).toBe("tomorrow at 10:00");
  });

  test("parses abbreviated units like 'mins' and 'hrs'", () => {
    const result = parseTimeReference("in 10 mins do stuff");
    expect(result).not.toBeNull();
    expect(result!.prompt).toBe("do stuff");

    const result2 = parseTimeReference("in 1 hr check on things");
    expect(result2).not.toBeNull();
    expect(result2!.prompt).toBe("check on things");
  });
});
