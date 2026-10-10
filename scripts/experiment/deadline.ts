import { timeoutMs } from '../../src/timeout.js';

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The next local HH:MM after `now`: 07:00 given at 22:00 is tomorrow's, given at 06:00 today's. */
export function untilDeadline(now: Date, hhmm: string): Date {
  const match = HH_MM.exec(hhmm);
  if (!match) throw new Error(`--until must be HH:MM, 24 h, local time: ${hhmm}`);
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]));
  return at > now ? at : new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, at.getHours(), at.getMinutes());
}

/** Only asked before a pair starts: a pair going is never cut by the deadline. */
export const mayStart = (now: Date, deadline: Date | undefined): boolean => deadline === undefined || now < deadline;

export function parseRunTimeout(text: string): number {
  const ms = timeoutMs(text);
  if (ms === undefined) throw new Error(`--run-timeout must be like "90m" or "20h", up to 24h: ${text}`);
  return ms;
}
