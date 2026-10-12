// The JSONL plumbing every agent's transcript reader shares (#929, out of claude-transcript.ts): a regular file read line by line or for its
// first line only, the folder and freshness checks of a subagent scan, and one stage run's usage as it adds up.
import { createReadStream } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ZERO_TOKENS, type Tokens } from '../events.js';
import type { TurnUsage } from '../usage.js';

/** A finite number as is, anything else 0: 1e400 parses to Infinity and would jam every budget check. */
export const finite = (value: unknown): number => (Number.isFinite(value) ? (value as number) : 0);

export const addTokens = (a: Tokens, b: Tokens): Tokens =>
  ({ input: a.input + b.input, output: a.output + b.output, cache_write: a.cache_write + b.cache_write, cache_read: a.cache_read + b.cache_read });

/** Finite fields can still overflow a sum; nothing non-finite may reach State.usage. */
export const finiteTokens = (t: Tokens): boolean => Object.values(t).every(Number.isFinite);

// A FIFO or a device never reaches EOF and would hold the read (and a threadpool worker) forever
async function requireFile(path: string): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error(`${path}: not a regular file`);
}

/** Calls onLine for every line of a regular file. */
export async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  await requireFile(path);
  return new Promise((resolve, reject) => {
    const input = createReadStream(path);
    input.on('error', reject);
    const lines = createInterface({ input, crlfDelay: Infinity });
    // readline.Interface re-emits the input stream's error as its own; without a listener here it throws unhandled.
    lines.on('error', reject);
    lines.on('line', onLine);
    lines.on('close', resolve);
  });
}

/** A regular file's first line, undefined for an empty one; the rest is never read: a Codex rollout's session_meta is its first line (#929). */
export async function firstLine(path: string): Promise<string | undefined> {
  await requireFile(path);
  return new Promise((resolve, reject) => {
    const input = createReadStream(path);
    input.on('error', reject);
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('error', reject);
    lines.once('line', (line) => {
      resolve(line);
      lines.close();
      input.destroy();
    });
    lines.on('close', () => resolve(undefined)); // after a line, a no-op: the promise is settled
  });
}

export const isRealDir = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined))?.isDirectory() === true;
export const writtenSince = async (path: string, since: number): Promise<boolean> => ((await lstat(path).catch(() => undefined))?.mtimeMs ?? -1) >= since;

/** One model response's usage by type, with its model and time (#742): what a stage run's tally adds up. */
export interface UsageEntry { id: string; byType: Tokens; model?: string; at: number }

/** One stage run's usage as it adds up: each id once across the session's file and its subagents'. */
export interface StageTally { seen: Set<string>; models: Set<string>; tokens: Tokens; subagentTokens: Tokens }

export const newTally = (): StageTally => ({ seen: new Set(), models: new Set(), tokens: ZERO_TOKENS, subagentTokens: ZERO_TOKENS });

export function tally(t: StageTally, usage: UsageEntry | undefined, since: number, subagent: boolean): void {
  if (!usage || t.seen.has(usage.id)) return;
  t.seen.add(usage.id);
  if (!(usage.at >= since)) return; // before the stage run, or with no time: not its own
  t.tokens = addTokens(t.tokens, usage.byType);
  if (subagent) t.subagentTokens = addTokens(t.subagentTokens, usage.byType);
  if (usage.model !== undefined) t.models.add(usage.model);
}

export const turnUsage = (t: StageTally): TurnUsage => ({ tokens: t.tokens, models: [...t.models], subagentTokens: t.subagentTokens });
