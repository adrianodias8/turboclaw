/**
 * Parses natural language time references from WhatsApp messages.
 * Time references can appear anywhere in the message:
 *   "in 5 minutes tell me a joke"
 *   "tell me the weather in 2 minutes"
 *   "remind me in half an hour to check the deploy"
 *   "at 14:30 send me a summary"
 *   "check the logs at 2:30pm"
 *   "tomorrow at 9am deploy the fix"
 *   "tomorrow check the logs"
 */
export interface ScheduledMessage {
  scheduledAt: number; // Unix timestamp (seconds)
  prompt: string; // The actual task prompt with time reference removed
  humanDelay: string; // e.g. "5 minutes", "2 hours", "14:30"
}

const WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

const NUM_PATTERN = "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty";
const UNIT_PATTERN = "seconds?|minutes?|mins?|hours?|hrs?";

export function parseTimeReference(text: string): ScheduledMessage | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  // "in half an hour" — anywhere in the message
  const halfHourMatch = lower.match(/\bin\s+half\s+an?\s+hour\b/i);
  if (halfHourMatch) {
    const prompt = removeMatch(lower, halfHourMatch[0]);
    if (prompt) {
      return { scheduledAt: now + 30 * 60, prompt, humanDelay: "30 minutes" };
    }
  }

  // "in X minutes/hours/seconds" — anywhere in the message
  const inRegex = new RegExp(`\\bin\\s+(${NUM_PATTERN})\\s+(${UNIT_PATTERN})\\b`, "i");
  const inMatch = lower.match(inRegex);
  if (inMatch && inMatch[1] && inMatch[2]) {
    const numStr = inMatch[1];
    const unit = inMatch[2];

    const num = WORD_TO_NUM[numStr] ?? parseInt(numStr, 10);
    if (!isNaN(num) && num > 0) {
      let seconds: number;
      if (unit.startsWith("s")) seconds = num;
      else if (unit.startsWith("m")) seconds = num * 60;
      else seconds = num * 3600;

      const unitName = unit.startsWith("s") ? "second" : unit.startsWith("m") ? "minute" : "hour";
      const prompt = removeMatch(lower, inMatch[0]);
      if (prompt) {
        return {
          scheduledAt: now + seconds,
          prompt,
          humanDelay: `${num} ${unitName}${num > 1 ? "s" : ""}`,
        };
      }
    }
  }

  // "tomorrow at HH:MM[am/pm]" — anywhere
  const tomorrowAtRegex = /\btomorrow\s+at\s+(\d{1,2}):?(\d{2})?\s*(am|pm)?\b/i;
  const tomorrowAtMatch = lower.match(tomorrowAtRegex);
  if (tomorrowAtMatch && tomorrowAtMatch[1]) {
    const { ts, timeStr } = parseClockTime(
      parseInt(tomorrowAtMatch[1], 10),
      tomorrowAtMatch[2] ? parseInt(tomorrowAtMatch[2], 10) : 0,
      (tomorrowAtMatch[3] as "am" | "pm") ?? undefined,
      1
    );
    const prompt = removeMatch(lower, tomorrowAtMatch[0]);
    if (prompt) {
      return { scheduledAt: ts, prompt, humanDelay: `tomorrow at ${timeStr}` };
    }
  }

  // "tomorrow" — anywhere (default 9:00 AM)
  const tomorrowMatch = lower.match(/\btomorrow\b/i);
  if (tomorrowMatch) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const prompt = removeMatch(lower, tomorrowMatch[0]);
    if (prompt) {
      return {
        scheduledAt: Math.floor(tomorrow.getTime() / 1000),
        prompt,
        humanDelay: "tomorrow at 9:00",
      };
    }
  }

  // "at HH:MM[am/pm]" — anywhere
  const atRegex = /\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)?\b/i;
  const atMatch = lower.match(atRegex);
  if (atMatch && atMatch[1] && atMatch[2]) {
    const { ts, timeStr } = parseClockTime(
      parseInt(atMatch[1], 10),
      parseInt(atMatch[2], 10),
      (atMatch[3] as "am" | "pm") ?? undefined,
      0
    );
    const finalTs = ts <= now ? ts + 86400 : ts;
    const prompt = removeMatch(lower, atMatch[0]);
    if (prompt) {
      return { scheduledAt: finalTs, prompt, humanDelay: timeStr };
    }
  }

  // "at Xam/pm" (no colon, e.g. "at 2pm")
  const atNocolonRegex = /\bat\s+(\d{1,2})\s*(am|pm)\b/i;
  const atNocolonMatch = lower.match(atNocolonRegex);
  if (atNocolonMatch && atNocolonMatch[1] && atNocolonMatch[2]) {
    const { ts, timeStr } = parseClockTime(
      parseInt(atNocolonMatch[1], 10),
      0,
      atNocolonMatch[2] as "am" | "pm",
      0
    );
    const finalTs = ts <= now ? ts + 86400 : ts;
    const prompt = removeMatch(lower, atNocolonMatch[0]);
    if (prompt) {
      return { scheduledAt: finalTs, prompt, humanDelay: timeStr };
    }
  }

  return null;
}

/** Remove the matched time fragment and clean up the remaining prompt */
function removeMatch(text: string, match: string): string | null {
  const cleaned = text
    .replace(match, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*[,\-–—]\s*/, "")  // leading punctuation
    .replace(/\s*[,\-–—]\s*$/, "")  // trailing punctuation
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function parseClockTime(
  hours: number,
  minutes: number,
  ampm: "am" | "pm" | undefined,
  daysOffset: number
): { ts: number; timeStr: string } {
  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  d.setHours(hours, minutes, 0, 0);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");

  return { ts: Math.floor(d.getTime() / 1000), timeStr: `${hh}:${mm}` };
}
