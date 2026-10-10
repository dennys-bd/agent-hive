import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ZERO_TOKENS, type Tokens } from './events.js';
import type { Activity, Budget, UsageSample } from './types.js';
import { taskDir } from './worktree.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

interface TranscriptLine {
  type?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> | null };
}

// One assistant message's usage, by type with its model and time (#742). The four fields sum to ccusage's "Total Tokens", so the number the
// user sees here matches the one they know
interface AssistantUsage { id: string; tokens: number; byType: Tokens; model?: string; at: number }

const finite = (value: unknown): number => (Number.isFinite(value) ? (value as number) : 0); // 1e400 parses to Infinity and would jam every budget check

function parseAssistant(line: string): AssistantUsage | undefined {
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
  const byType: Tokens = {
    input: finite(usage.input_tokens), output: finite(usage.output_tokens), cache_write: finite(usage.cache_creation_input_tokens), cache_read: finite(usage.cache_read_input_tokens),
  };
  const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
  const tokens = byType.input + byType.output + byType.cache_write + byType.cache_read;
  return { id: message.id, tokens, byType, at, ...(typeof message.model === 'string' ? { model: message.model } : {}) };
}

/** One transcript line → its usage, or nothing. The same `message.id` repeats once per content block; the caller dedupes. */
export function parseUsageLine(line: string): { id: string; tokens: number } | undefined {
  const usage = parseAssistant(line);
  return usage === undefined ? undefined : { id: usage.id, tokens: usage.tokens };
}

const addTokens = (a: Tokens, b: Tokens): Tokens =>
  ({ input: a.input + b.input, output: a.output + b.output, cache_write: a.cache_write + b.cache_write, cache_read: a.cache_read + b.cache_read });

const TITLE_MAX = 60; // characters of a session's /rename title a run's tab shows (#489): past it a tab stops being readable
// C0, DEL, C1 and the bidi controls (LRM, RLM, embeddings, overrides, isolates): the transcript is a file outside the Hive's control, and a
// reordered label beside Parar would misname the run it stops. The zero-width joiner stays: emoji sequences need it
const CONTROL_CHARS = /[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** A session's /rename title as display text (#489): control characters dropped, trimmed, at most TITLE_MAX characters, counted in code
 * points so an emoji is never cut in half. Anything but a string, or nothing left, is no title. The state file's stored name reads through it too. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value.replace(CONTROL_CHARS, '').trim()).slice(0, TITLE_MAX).join('').trim();
  return text === '' ? undefined : text;
}

// One transcript line → its /rename title (#489), or nothing: Claude Code appends {"type":"custom-title","customTitle":"…"} at every rename.
function parseTitleLine(line: string): string | undefined {
  let parsed: { type?: unknown; customTitle?: unknown } | null;
  try {
    parsed = JSON.parse(line) as { type?: unknown; customTitle?: unknown } | null;
  } catch {
    return undefined;
  }
  return parsed?.type === 'custom-title' ? cleanTitle(parsed.customTitle) : undefined;
}

/** A stage run's own usage (#742): the tokens by type and the models of the turns at or after its start, its subagents' included;
 * subagentTokens is the subagents' share of tokens. */
export interface TurnUsage { tokens: Tokens; models: string[]; subagentTokens: Tokens }

/** What a turn end reads from a session's transcript (#248, #489): its token total, the last /rename title when the user named it, and, asked
 * with a start time, that stage run's usage (#742). */
export interface TranscriptTurn { tokens: number; title?: string; usage?: TurnUsage }

// Calls onLine for every line of a regular file. A FIFO or a device never reaches EOF and would hold the read (and a threadpool worker) forever
async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  if (!(await stat(path)).isFile()) throw new Error(`${path}: not a regular file`);
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

const isRealDir = async (path: string): Promise<boolean> => (await lstat(path).catch(() => undefined))?.isDirectory() === true;
const writtenSince = async (path: string, since: number): Promise<boolean> => ((await lstat(path).catch(() => undefined))?.mtimeMs ?? -1) >= since;

// Claude Code writes each subagent's transcript to <transcript dir>/<session_id>/subagents/agent-<id>.jsonl, beside the main one. Only the
// .jsonl regular files directly in that folder, through no linked folder: anything else is not this session's. No folder: none. A file
// last written before the stage run holds none of its turns, so it is never opened: an old session's subagents would slow every Stop
async function subagentTranscripts(path: string, since: number): Promise<string[]> {
  const session = join(dirname(path), basename(path, '.jsonl'));
  const dir = join(session, 'subagents');
  if (!(await isRealDir(session)) || !(await isRealDir(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  // readdir's order is the file system's (APFS sorts, ext4 does not): sorted, so the models list the same on every machine
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => join(dir, e.name)).sort();
  const fresh = await Promise.all(files.map((file) => writtenSince(file, since)));
  return files.filter((_, i) => fresh[i]);
}

// One stage run's usage as it adds up: each message.id once across the main transcript and its subagents'
interface StageTally { seen: Set<string>; models: Set<string>; tokens: Tokens; subagentTokens: Tokens }

function tally(t: StageTally, usage: AssistantUsage | undefined, since: number, subagent: boolean): void {
  if (!usage || t.seen.has(usage.id)) return;
  t.seen.add(usage.id);
  if (!(usage.at >= since)) return; // before the stage run, or with no time: not its own
  t.tokens = addTokens(t.tokens, usage.byType);
  if (subagent) t.subagentTokens = addTokens(t.subagentTokens, usage.byType);
  if (usage.model !== undefined) t.models.add(usage.model);
}

/**
 * Sums the tokens of every assistant message in a Claude Code transcript, counting each `message.id` once, and keeps the last /rename
 * title, in one pass. With `since`, the messages at or after it also add up by type with their models (#742), the session's subagent
 * transcripts included: a resumed session's older turns are not the stage run's. The session total (budgets, Worker.tokens) stays the main
 * transcript's alone. Rejects when the file cannot be opened or read; the server treats that as "no tokens and no title this turn".
 * ponytail: reads the whole file at every turn end; if transcripts ever weigh, keep a byte offset per worker and tail from it.
 */
export async function readTranscript(path: string, since?: number): Promise<TranscriptTurn> {
  const stage: StageTally = { seen: new Set(), models: new Set(), tokens: ZERO_TOKENS, subagentTokens: ZERO_TOKENS };
  const seen = new Set<string>();
  let total = 0;
  let title: string | undefined;
  await eachLine(path, (line) => {
    // Only a line naming the type is parsed a second time. A title cleaned to nothing keeps the one before: a rename never clears a name (#489)
    const renamed = line.includes('"custom-title"') ? parseTitleLine(line) : undefined;
    if (renamed !== undefined) {
      title = renamed;
      return;
    }
    const usage = parseAssistant(line);
    if (!usage || seen.has(usage.id)) return;
    seen.add(usage.id);
    total += usage.tokens;
    if (since !== undefined) tally(stage, usage, since, false);
  });
  // Finite fields can still overflow the sum; nothing non-finite may reach State.usage or it jams every budget check
  if (!Number.isFinite(total)) throw new Error(`${path}: token total is not finite`);
  const base = { tokens: total, ...(title === undefined ? {} : { title }) };
  if (since === undefined) return base;
  // A subagent file that fails to read costs only its own share, never the turn's session total
  // One after the other, in name order: the tokens would add up in any order, but the models list in the order they are met
  for (const sub of await subagentTranscripts(path, since)) {
    await eachLine(sub, (line) => tally(stage, parseAssistant(line), since, true)).catch(() => undefined);
  }
  return { ...base, usage: { tokens: stage.tokens, models: [...stage.models], subagentTokens: stage.subagentTokens } };
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

/** Where Claude Code keeps the transcripts of a cwd: `<config dir>/projects/<cwd with every non-alphanumeric as '-'>`. An empty or relative
 * CLAUDE_CONFIG_DIR falls back to ~/.claude: it would resolve against the daemon's cwd, not Claude Code's, and removeTranscripts deletes there (#236). */
export function transcriptDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), '.claude');
  return join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * The worker's own transcript: an absolute `.jsonl` directly under the transcript dir of the folder it runs in (taskDir: its worktree at
 * `<repo>/.hive/worktrees/<slug>`, or the workspace's checkout for a local task, #444). A forged hook cannot point the excerpt at any other file.
 */
export function isWorkerTranscript(value: unknown, repo: string, activity: Pick<Activity, 'slug' | 'local'>, env: NodeJS.ProcessEnv = process.env): value is string {
  return isTranscriptIn(value, taskDir(repo, activity), env);
}

/** An absolute `.jsonl` directly under the transcript dir of `cwd`: a local session's (#587) is its workspace's checkout. */
export function isTranscriptIn(value: unknown, cwd: string, env: NodeJS.ProcessEnv = process.env): value is string {
  return isTranscriptPath(value) && dirname(value) === transcriptDir(cwd, env);
}
