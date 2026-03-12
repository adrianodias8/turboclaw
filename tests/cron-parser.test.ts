import { describe, it, expect } from "bun:test";
import { parseCronField, nextRunAt } from "../src/orchestrator/cron-parser";

describe("parseCronField", () => {
  it("parses * as all values in range", () => {
    const result = parseCronField("*", 0, 59);
    expect(result).toHaveLength(60);
    expect(result[0]).toBe(0);
    expect(result[59]).toBe(59);
  });

  it("parses step expressions (*/15)", () => {
    const result = parseCronField("*/15", 0, 59);
    expect(result).toEqual([0, 15, 30, 45]);
  });

  it("parses range expressions (1-5)", () => {
    const result = parseCronField("1-5", 0, 59);
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses list expressions (1,3,5)", () => {
    const result = parseCronField("1,3,5", 0, 59);
    expect(result).toEqual([1, 3, 5]);
  });

  it("parses single number", () => {
    const result = parseCronField("30", 0, 59);
    expect(result).toEqual([30]);
  });

  it("parses range with step (1-10/3)", () => {
    const result = parseCronField("1-10/3", 0, 59);
    expect(result).toEqual([1, 4, 7, 10]);
  });

  it("parses combined list and range (1,5-7,10)", () => {
    const result = parseCronField("1,5-7,10", 0, 59);
    expect(result).toEqual([1, 5, 6, 7, 10]);
  });
});

describe("nextRunAt", () => {
  it("* * * * * matches the next minute", () => {
    const now = new Date("2026-03-12T10:30:00Z");
    const result = nextRunAt("* * * * *", now);
    // Should be 10:31:00 UTC
    expect(result).toBe(Math.floor(new Date("2026-03-12T10:31:00Z").getTime() / 1000));
  });

  it("*/5 * * * * matches every 5 minutes", () => {
    const now = new Date("2026-03-12T10:31:00Z");
    const result = nextRunAt("*/5 * * * *", now);
    // Next 5-min mark after 10:31 is 10:35
    expect(result).toBe(Math.floor(new Date("2026-03-12T10:35:00Z").getTime() / 1000));
  });

  it("0 12 * * * matches noon daily", () => {
    const now = new Date("2026-03-12T10:30:00Z");
    const result = nextRunAt("0 12 * * *", now);
    // Should be noon today
    expect(result).toBe(Math.floor(new Date("2026-03-12T12:00:00Z").getTime() / 1000));
  });

  it("0 12 * * * after noon matches noon next day", () => {
    const now = new Date("2026-03-12T13:00:00Z");
    const result = nextRunAt("0 12 * * *", now);
    // Should be noon tomorrow
    expect(result).toBe(Math.floor(new Date("2026-03-13T12:00:00Z").getTime() / 1000));
  });

  it("0 0 1 * * matches midnight on 1st of month", () => {
    const now = new Date("2026-03-12T10:30:00Z");
    const result = nextRunAt("0 0 1 * *", now);
    // Should be April 1st midnight UTC
    expect(result).toBe(Math.floor(new Date("2026-04-01T00:00:00Z").getTime() / 1000));
  });

  it("throws on invalid expression", () => {
    expect(() => nextRunAt("* * *")).toThrow("Invalid cron expression");
  });
});
