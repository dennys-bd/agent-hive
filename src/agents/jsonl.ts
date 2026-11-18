// The JSONL plumbing every agent's transcript reader shares (#929, out of claude-transcript.ts): a regular file read, on the machine, line by line or for its
// first line only, the folder and freshness checks of a subagent scan, and one stage run's usage as it adds up.
import { ZERO_TOKENS, type Tokens } from '../facts.js';
import type { Machine } from '../machine.js';
import type { TurnUsage } from '../usage.js';

type Disk = Pick<Machine, 'fs'>;

/** A finite number as is, anything else 0: 1e400 parses to Infinity and would jam every budget check. */
export const finite = (value: unknown): number => (Number.isFinite(value) ? (value as number) : 0);

export const addTokens = (a: Tokens, b: Tokens): Tokens =>
  ({ input: a.input + b.input, output: a.output + b.output, cache_write: a.cache_write + b.cache_write, cache_read: a.cache_read + b.cache_read });

/** Finite fields can still overflow a sum; nothing non-finite may reach State.usage. */
export const finiteTokens = (t: Tokens): boolean => Object.values(t).every(Number.isFinite);

/** Every transcript read's cap (#161): far above any transcript seen so far, so only a runaway file is refused. readTurn then rejects, and the
 * hook goes through without tokens or a title (server.ts' readTurn). */
export const TRANSCRIPT_MAX_BYTES = 512 * 1024 * 1024;

/** Calls onLine for every line of a regular file on the machine. */
export async function eachLine(machine: Disk, path: string, onLine: (line: string) => void): Promise<void> {
  for await (const line of machine.fs.readLines(path, { maxBytes: TRANSCRIPT_MAX_BYTES })) onLine(line);
}

/** A regular file's first line, undefined for an empty one; the return ends the loop, which closes the read: a Codex rollout's session_meta is its first line (#929). */
export async function firstLine(machine: Disk, path: string): Promise<string | undefined> {
  for await (const line of machine.fs.readLines(path, { maxBytes: TRANSCRIPT_MAX_BYTES })) return line;
  return undefined;
}

export const isRealDir = async (machine: Disk, path: string): Promise<boolean> => (await machine.fs.lstat(path).catch(() => undefined))?.isDirectory() === true;
export const writtenSince = async (machine: Disk, path: string, since: number): Promise<boolean> => ((await machine.fs.lstat(path).catch(() => undefined))?.mtimeMs ?? -1) >= since;

/** One model response's usage by type, with its model and time (#742): what a stage run's tally adds up. */
export interface UsageEntry { id: string; byType: Tokens; model?: string; at: number }

/** The model a response with none counts under in tokensByModel (#271): a Codex turn with no turn_context, a Claude line with no model. */
export const UNKNOWN_MODEL = 'unknown';

/** One stage run's usage as it adds up: each id once across the session's file and its subagents'. byModel (#271): a Map, so a transcript's
 * model name is only ever a key, `__proto__` included. */
export interface StageTally { seen: Set<string>; models: Set<string>; tokens: Tokens; subagentTokens: Tokens; byModel: Map<string, Tokens> }

export const newTally = (): StageTally => ({ seen: new Set(), models: new Set(), tokens: ZERO_TOKENS, subagentTokens: ZERO_TOKENS, byModel: new Map() });

export function tally(t: StageTally, usage: UsageEntry | undefined, since: number, subagent: boolean): void {
  if (!usage || t.seen.has(usage.id)) return;
  t.seen.add(usage.id);
  if (!(usage.at >= since)) return; // before the stage run, or with no time: not its own
  t.tokens = addTokens(t.tokens, usage.byType);
  if (subagent) t.subagentTokens = addTokens(t.subagentTokens, usage.byType);
  if (usage.model !== undefined) t.models.add(usage.model);
  // #271: a response with no model still counts, so the split always sums to tokens
  const model = usage.model ?? UNKNOWN_MODEL;
  t.byModel.set(model, addTokens(t.byModel.get(model) ?? ZERO_TOKENS, usage.byType));
}

export const turnUsage = (t: StageTally): TurnUsage =>
  ({ tokens: t.tokens, models: [...t.models], subagentTokens: t.subagentTokens, tokensByModel: Object.fromEntries(t.byModel) });
