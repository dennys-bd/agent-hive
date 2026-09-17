import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Budget, UsageSample } from './types.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// The four fields whose sum is ccusage's "Total Tokens", so the number the user sees here matches the one they know.
const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const;

interface TranscriptLine {
  type?: unknown;
  message?: { id?: unknown; usage?: Record<string, unknown> | null };
}

/** One transcript line → its usage, or nothing. The same `message.id` repeats once per content block; the caller dedupes. */
export function parseUsageLine(line: string): { id: string; tokens: number } | undefined {
  let parsed: TranscriptLine | null;
  try {
    parsed = JSON.parse(line) as TranscriptLine | null;
  } catch {
    return undefined;
  }
  if (parsed?.type !== 'assistant') return undefined;
  const message = parsed.message;
  const usage = message?.usage;
  if (typeof message?.id !== 'string' || typeof usage !== 'object' || usage === null) return undefined;
  const tokens = USAGE_FIELDS.reduce((sum, field) => {
    const value = usage[field];
    return sum + (Number.isFinite(value) ? (value as number) : 0); // 1e400 parses to Infinity and would jam every budget check
  }, 0);
  return { id: message.id, tokens };
}

/**
 * Sums the tokens of every assistant message in a Claude Code transcript, counting each `message.id` once.
 * Rejects when the file cannot be opened or read; the server treats that as "no tokens this turn".
 * ponytail: reads the whole file at every turn end; if transcripts ever weigh, keep a byte offset per slot and tail from it.
 */
export async function sumTranscriptTokens(path: string): Promise<number> {
  // A FIFO or a device never reaches EOF and would hold the read (and a threadpool slot) forever
  if (!(await stat(path)).isFile()) throw new Error(`${path}: not a regular file`);
  return new Promise((resolve, reject) => {
    const seen = new Set<string>();
    let total = 0;
    const input = createReadStream(path);
    input.on('error', reject);
    const lines = createInterface({ input, crlfDelay: Infinity });
    // readline.Interface re-emits the input stream's error as its own; without a listener here it throws unhandled.
    lines.on('error', reject);
    lines.on('line', (line) => {
      const usage = parseUsageLine(line);
      if (!usage || seen.has(usage.id)) return;
      seen.add(usage.id);
      total += usage.tokens;
    });
    // Finite fields can still overflow the sum; nothing non-finite may reach State.usage or it jams every budget check
    lines.on('close', () => (Number.isFinite(total) ? resolve(total) : reject(new Error(`${path}: token total is not finite`))));
  });
}

export function usageTotals(usage: UsageSample[], now: number): { hour: number; day: number } {
  return usage.reduce((totals, { at, tokens }) => {
    const age = now - Date.parse(at);
    return { hour: totals.hour + (age < HOUR_MS ? tokens : 0), day: totals.day + (age < DAY_MS ? tokens : 0) };
  }, { hour: 0, day: 0 });
}

const withinLimit = (total: number, limit: number | undefined): boolean => limit === undefined || limit <= 0 || total < limit;

/** The budget gate `fill` consults next to `canStart`: both windows under their limit (an absent or 0 limit never restricts). */
export function hasBudget(usage: UsageSample[], budget: Budget, now: number): boolean {
  const { hour, day } = usageTotals(usage, now);
  return withinLimit(hour, budget.maxTokensPerHour) && withinLimit(day, budget.maxTokensPerDay);
}

export function pruneUsage(usage: UsageSample[], now: number): UsageSample[] {
  return usage.filter((s) => now - Date.parse(s.at) <= DAY_MS);
}

/** Any local process can hit /hooks/event: only an absolute `.jsonl` path is ever opened. */
export function isTranscriptPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.endsWith('.jsonl');
}

/** Where Claude Code keeps the transcripts of a cwd: `<config dir>/projects/<cwd with every non-alphanumeric as '-'>`. */
export function transcriptDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * The worker's own transcript: an absolute `.jsonl` directly under the transcript dir of its worktree
 * (`claude --worktree=<slug>` runs in `<repo>/.claude/worktrees/<slug>`). A forged hook cannot point the excerpt at any other file.
 */
export function isWorkerTranscript(value: unknown, repo: string, slug: string, env: NodeJS.ProcessEnv = process.env): value is string {
  return isTranscriptPath(value) && dirname(value) === transcriptDir(join(repo, '.claude', 'worktrees', slug), env);
}
