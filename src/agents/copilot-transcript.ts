// Copilot's transcripts (#878, node 6 of #608). Its sessions live by id under the copilot home (spike §6), never per cwd, so transcriptDir stays
// undefined for good: <home>/session-state/<session id>/events.jsonl, one event per line, and a workspace.yaml beside it. A subagent writes into
// its parent's file, its events marked by a non-null agentId.
import type { Machine } from '../machine.js';
import { isRecord } from '../rate-limits.js';
import { cleanTitle } from '../title.js';
import type { TranscriptTurn } from '../usage.js';
import { copilotHomeOf } from './copilot-home.js';
import { eachLine, finite, finiteTokens, isRealDir, newTally, tally, turnUsage, type UsageEntry } from './jsonl.js';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE_DIR = 'session-state';
const EVENTS_FILE = 'events.jsonl';
const WORKSPACE_FILE = 'workspace.yaml';
const YAML_MAX_BYTES = 64 * 1024;

export const transcriptDir = (): string | undefined => undefined;

const stateRoot = (machine: Pick<Machine, 'info' | 'paths'>): string => machine.paths.join(copilotHomeOf(machine.info(), machine.paths), STATE_DIR);

/** The events file of `sessionId` and nothing else: absolute, normalized, exactly <home>/session-state/<id>/events.jsonl. Without a full session
 * id nothing is owned: a forged hook can only name the file of an id it already knows. */
export function ownsTranscript(machine: Pick<Machine, 'info' | 'paths'>, path: string, _cwd: string, sessionId: string | undefined): boolean {
  if (!sessionId || !SESSION_ID.test(sessionId) || !machine.paths.isAbsolute(path) || machine.paths.normalize(path) !== path) return false;
  return path === machine.paths.join(stateRoot(machine), sessionId, EVENTS_FILE);
}

// workspace.yaml is flat `key: value` lines; a line regex keeps a YAML parser out of the dependencies
function yamlValue(text: string, key: string): string | undefined {
  const raw = new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'm').exec(text)?.[1];
  if (raw === undefined) return undefined;
  const quoted = /^(["'])(.*)\1$/.exec(raw);
  return quoted ? quoted[2] : raw;
}

const workspaceOf = (machine: Pick<Machine, 'fs' | 'paths'>, folder: string): Promise<string | undefined> =>
  machine.fs.readFile(machine.paths.join(folder, WORKSPACE_FILE), { maxBytes: YAML_MAX_BYTES, encoding: 'utf8' }).catch(() => undefined);

/** Every file deleting session `id` of `cwd` removes: its events file, then its folder (findTranscript takes the first). Only a real folder
 * directly under session-state/ whose own workspace.yaml names that cwd, so a forged id never deletes a session run elsewhere. */
export async function sessionFiles(machine: Machine, cwd: string, id: string): Promise<string[]> {
  if (!SESSION_ID.test(id)) return [];
  const folder = machine.paths.join(stateRoot(machine), id);
  if (!(await isRealDir(machine, folder))) return [];
  const yaml = await workspaceOf(machine, folder);
  return yaml !== undefined && yamlValue(yaml, 'cwd') === cwd ? [machine.paths.join(folder, EVENTS_FILE), folder] : [];
}

function parseEvent(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined; // a half-written last line
  }
}

// inputTokens includes the cache reads (spike §6); reasoningTokens are not added, the model's output already counts them
function usageEntry(event: Record<string, unknown>): UsageEntry | undefined {
  const { id, data, timestamp } = event;
  const usage = isRecord(data) ? data.usage : undefined;
  if (typeof id !== 'string' || !isRecord(usage)) return undefined;
  const read = finite(usage.cacheReadTokens);
  return {
    id, at: typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN,
    byType: { input: Math.max(0, finite(usage.inputTokens) - read), output: finite(usage.outputTokens), cache_write: finite(usage.cacheWriteTokens), cache_read: read },
    ...(typeof usage.model === 'string' ? { model: usage.model } : {}),
  };
}

const sum = (t: UsageEntry['byType']): number => t.input + t.output + t.cache_write + t.cache_read;

/** A Copilot turn end: the session total (main agent only) and, with `since`, the stage run's usage, each record once, its subagents' included.
 * Rejects when the file cannot be read or a tally overflows; the server treats that as "no tokens this turn".
 * ponytail: reads the whole file at every turn end, as the other readers do; keep a byte offset per worker if sessions ever weigh. */
export async function readTurn(machine: Machine, path: string, since?: number): Promise<TranscriptTurn> {
  const stage = newTally();
  const seen = new Set<string>();
  let tokens = 0;
  await eachLine(machine, path, (text) => {
    const event = parseEvent(text);
    if (event?.type !== 'session.usage_record') return;
    const entry = usageEntry(event);
    if (!entry) return;
    const subagent = event.agentId != null;
    if (!subagent && !seen.has(entry.id)) tokens += sum(entry.byType);
    seen.add(entry.id);
    if (since !== undefined) tally(stage, entry, since, subagent);
  });
  const yaml = await workspaceOf(machine, machine.paths.dirname(path));
  const title = yaml !== undefined && yamlValue(yaml, 'user_named') === 'true' ? cleanTitle(yamlValue(yaml, 'name')) : undefined;
  // before the early return: a total with no stage run must not carry Infinity into State.usage either
  if (!Number.isFinite(tokens) || !finiteTokens(stage.tokens)) throw new Error(`${path}: token total is not finite`);
  const base = { tokens, ...(title === undefined ? {} : { title }) };
  if (since === undefined) return base;
  return { ...base, usage: turnUsage(stage) };
}

/** The main agent's user and assistant messages; a subagent's are not the conversation. */
export async function countMessages(machine: Machine, path: string): Promise<number> {
  let count = 0;
  await eachLine(machine, path, (text) => {
    const event = parseEvent(text);
    if (event?.agentId == null && (event?.type === 'user.message' || event?.type === 'assistant.message')) count += 1;
  });
  return count;
}
