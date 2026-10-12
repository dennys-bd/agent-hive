// Codex's rollouts (#929): where it keeps them, which of them a run owns, the per-response usage the Hive reads from them (its subagents'
// included) and every file deleting a session removes. Layout and records: finding.codex-surface §9, §11.
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Tokens } from '../events.js';
import { isRecord } from '../rate-limits.js';
import type { TranscriptTurn } from '../usage.js';
import { eachLine, finite, finiteTokens, firstLine, isRealDir, newTally, tally, turnUsage, type UsageEntry, writtenSince } from './jsonl.js';

const DATE_PARTS: readonly RegExp[] = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/]; // <root>/YYYY/MM/DD, Codex's local date
const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/; // rollout-<local time>-<session id>.jsonl
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MS_PER_DAY = 86_400_000;
// ponytail: a stage run's subagents are looked for at most this many days back; a run open longer loses its oldest subagents' share
const SCAN_DAYS_MAX = 31;

/** One rollout line: `{ timestamp, type, payload }`. */
export interface RolloutLine { timestamp?: unknown; type?: unknown; payload: Record<string, unknown> }

/** Where Codex keeps its rollouts: `$CODEX_HOME/sessions`, `~/.codex/sessions` when CODEX_HOME is empty or relative. It would resolve against
 * the daemon's cwd, and removeTranscripts deletes there, as Claude's transcriptDir does with CLAUDE_CONFIG_DIR (#236). */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return join(configured && isAbsolute(configured) ? configured : join(homedir(), '.codex'), 'sessions');
}

/** A rollout the run of `sessionId` owns: absolute, directly in a date folder of the sessions root, named after that session. Without a session
 * id nothing is: a forged hook can only name a rollout of an id it already knows, and gets a token count. */
export function ownsRollout(path: string, sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  // a full session id only (a tail of one would match), and a normalized path: readRollout derives the root from its folders
  if (!sessionId || !SESSION_ID.test(sessionId) || !isAbsolute(path) || normalize(path) !== path) return false;
  if (!basename(path).endsWith(`-${sessionId}.jsonl`)) return false;
  const parts = relative(sessionsRoot(env), dirname(path)).split(sep);
  return parts.length === DATE_PARTS.length && parts.every((part, i) => DATE_PARTS[i].test(part));
}

export function parseRolloutLine(text: string): RolloutLine | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return undefined;
    const { timestamp, type, payload } = parsed;
    return isRecord(payload) ? { timestamp, type, payload } : undefined;
  } catch {
    return undefined; // a half-written last line
  }
}

// readdir's order is the file system's (APFS sorts, ext4 does not): every listing is sorted, so every machine reads the same order
async function subdirs(dir: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory() && pattern.test(e.name)).map((e) => join(dir, e.name)).sort();
}

/** Every date folder under `root`, oldest first. A link is no directory to a Dirent, so none is followed. */
export async function dateFolders(root: string): Promise<string[]> {
  let level = [root];
  for (const pattern of DATE_PARTS) level = (await Promise.all(level.map((dir) => subdirs(dir, pattern)))).flat();
  return level;
}

/** The .jsonl regular files directly in `folder`, in name order; none when it is not a real folder. */
export async function rolloutsIn(folder: string): Promise<string[]> {
  if (!(await isRealDir(folder))) return [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => join(folder, e.name)).sort();
}

// A rollout's first line, its session_meta: the session's id and cwd and, for a subagent, the session that spawned it
// (source.subagent.thread_spawn.parent_thread_id, §11)
interface SessionMeta { id?: string; cwd?: string; parent?: string }

function sessionMetaOf(text: string | undefined): SessionMeta {
  const meta = text === undefined ? undefined : parseRolloutLine(text);
  if (meta?.type !== 'session_meta') return {};
  const { id, cwd, source } = meta.payload;
  const spawn = isRecord(source) && isRecord(source.subagent) ? source.subagent.thread_spawn : undefined;
  return {
    ...(typeof id === 'string' ? { id } : {}), ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(isRecord(spawn) && typeof spawn.parent_thread_id === 'string' ? { parent: spawn.parent_thread_id } : {}),
  };
}

const metaOf = async (path: string): Promise<SessionMeta> => sessionMetaOf(await firstLine(path).catch(() => undefined));
const parentOf = async (path: string): Promise<string | undefined> => (await metaOf(path)).parent;

// One response's usage (§9): input_tokens includes the cached ones; output_tokens already includes the reasoning, which is not added again
function usageEntry(payload: Record<string, unknown>, at: number, model: string | undefined): UsageEntry | undefined {
  const { usage, response_id: id } = payload;
  if (typeof id !== 'string' || !isRecord(usage)) return undefined;
  const cached = finite(usage.cached_input_tokens);
  const byType: Tokens = {
    input: Math.max(0, finite(usage.input_tokens) - cached), output: finite(usage.output_tokens), cache_write: finite(usage.cache_write_input_tokens), cache_read: cached,
  };
  return { id, byType, at, ...(model === undefined ? {} : { model }) };
}

// One pass: turn_context maps its turn to the model (no usage record names one, §9); each token_usage_record moves the session total to its
// thread_token_usage and hands its response to onEntry. Answers the last session total
async function readLines(path: string, onEntry: (entry: UsageEntry) => void): Promise<number> {
  const models = new Map<string, string>();
  let total = 0;
  await eachLine(path, (text) => {
    const line = parseRolloutLine(text);
    if (line === undefined) return;
    const { payload } = line;
    const turn = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
    if (line.type === 'turn_context') {
      if (turn !== undefined && typeof payload.model === 'string') models.set(turn, payload.model);
      return;
    }
    if (line.type !== 'token_usage_record') return;
    if (isRecord(payload.thread_token_usage)) total = finite(payload.thread_token_usage.total_tokens);
    const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
    const entry = usageEntry(payload, at, turn === undefined ? undefined : models.get(turn));
    if (entry) onEntry(entry);
  });
  return total;
}

const dayFolder = (root: string, day: Date): string =>
  join(root, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));

// The local date of a rollout's own folder: no subagent of it is older
const folderDay = (path: string): number => {
  const [year, month, day] = relative(dirname(dirname(dirname(dirname(path)))), dirname(path)).split(sep).map(Number);
  return new Date(year, month - 1, day).getTime();
};

// The folders a stage run's subagents can be in: Codex names them by its local date, from the day before `since` (never before the parent's
// own folder, nor SCAN_DAYS_MAX back) to the day after today. Rounded up: a DST day of 23 hours never drops the last folder, at the cost of
// one more folder that is not there
function folderRange(root: string, since: number, now: number, floor: number): string[] {
  const from = new Date(Math.max(since, floor + MS_PER_DAY, now - SCAN_DAYS_MAX * MS_PER_DAY));
  const first = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const days = Math.max(0, Math.ceil((now - first.getTime()) / MS_PER_DAY) + 2);
  return Array.from({ length: days }, (_, i) => dayFolder(root, new Date(first.getFullYear(), first.getMonth(), first.getDate() + i)));
}

// The session's direct subagents written since the stage run, in path order. A file last written before it holds none of its turns and is
// never opened, so an old session's subagents never slow a Stop. One at a time: a busy folder must not open every file at once
async function subagentRollouts(root: string, id: string, since: number, now: number, floor: number): Promise<string[]> {
  const files = (await Promise.all(folderRange(root, since, now, floor).map(rolloutsIn))).flat();
  const kept: string[] = [];
  for (const file of files) if ((await writtenSince(file, since)) && (await parentOf(file)) === id) kept.push(file);
  return kept;
}

/**
 * A Codex turn end (#929): the session total from the rollout's last thread_token_usage and, with `since`, the stage run's usage, each response
 * once, its direct subagents' rollouts included, as Claude's reader does. Rejects when the file cannot be read or the tally overflows; the
 * server treats that as "no tokens this turn".
 * ponytail: reads the whole rollout at every turn end, as Claude's reader does; keep a byte offset per worker if rollouts ever weigh.
 */
export async function readRollout(path: string, since?: number, now = Date.now()): Promise<TranscriptTurn> {
  const stage = newTally();
  const tokens = await readLines(path, (entry) => {
    if (since !== undefined) tally(stage, entry, since, false);
  });
  if (since === undefined) return { tokens };
  const id = ROLLOUT_ID.exec(basename(path))?.[1];
  const root = dirname(dirname(dirname(dirname(path)))); // <root>/YYYY/MM/DD/<file>: ownsRollout checked the depth
  // A subagent file that fails to read costs only its own share; one after the other, so the models list in the order they are met
  for (const sub of id === undefined ? [] : await subagentRollouts(root, id, since, now, folderDay(path))) {
    await readLines(sub, (entry) => tally(stage, entry, since, true)).catch(() => undefined);
  }
  if (!finiteTokens(stage.tokens)) throw new Error(`${path}: token total is not finite`);
  return { tokens, usage: turnUsage(stage) };
}

/** Every file deleting session `id` of `cwd` removes (#236, #929): its rollout and its direct subagents', in any date folder; never a folder,
 * never another session's. The id the Hive holds came from a hook, so a rollout goes only when its own session_meta names that id and `cwd`:
 * a forged id never deletes a session the user ran elsewhere. ponytail: opens every rollout's first line once per deletion; index the
 * parents if a sessions folder ever holds thousands. */
export async function rolloutFiles(id: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const files = (await Promise.all((await dateFolders(sessionsRoot(env))).map(rolloutsIn))).flat();
  const own: string[] = [];
  const children: string[] = [];
  for (const file of files) { // one at a time: thousands at once run out of file descriptors
    const meta = await metaOf(file);
    if (basename(file).endsWith(`-${id}.jsonl`) && meta.id === id && meta.cwd === cwd) own.push(file);
    else if (meta.parent === id) children.push(file);
  }
  return own.length === 0 ? [] : [...own, ...children];
}
