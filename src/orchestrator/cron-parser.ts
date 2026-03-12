// Minimal 5-field cron expression parser.
// Fields: minute hour day-of-month month day-of-week
// Supports: numbers, *, ranges (1-5), steps (star/5), lists (1,3,5)

export function parseCronField(field: string, min: number, max: number): number[] {
  const values: Set<number> = new Set();

  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr!, 10);
      let start = min;
      let end = max;
      if (range !== "*" && range!.includes("-")) {
        [start, end] = range!.split("-").map(Number) as [number, number];
      } else if (range !== "*") {
        start = parseInt(range!, 10);
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [s, e] = part.split("-").map(Number) as [number, number];
      for (let i = s; i <= e; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return [...values].sort((a, b) => a - b);
}

export function nextRunAt(cronExpr: string, after: Date = new Date()): number {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression: ${cronExpr}`);

  const minutes = parseCronField(fields[0]!, 0, 59);
  const hours = parseCronField(fields[1]!, 0, 23);
  const days = parseCronField(fields[2]!, 1, 31);
  const months = parseCronField(fields[3]!, 1, 12);
  const weekdays = parseCronField(fields[4]!, 0, 6);

  // Start from the next minute
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Search up to 2 years ahead
  const limit = new Date(after.getTime() + 2 * 365 * 24 * 60 * 60 * 1000);

  const cursor = new Date(start);
  while (cursor < limit) {
    if (
      months.includes(cursor.getMonth() + 1) &&
      days.includes(cursor.getDate()) &&
      weekdays.includes(cursor.getDay()) &&
      hours.includes(cursor.getHours()) &&
      minutes.includes(cursor.getMinutes())
    ) {
      return Math.floor(cursor.getTime() / 1000);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new Error(`No next run found within 2 years for: ${cronExpr}`);
}
