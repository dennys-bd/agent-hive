import { MEMORY_STATS_DAYS, type MemoryEntry, type MemoryStats } from './types.js';

// The memory dialog's telemetry (#797), from the local events.jsonl only: nothing here is sent anywhere. Pure: the caller reads the files.

const DAY_MS = 86_400_000;
const CHARS_PER_TOKEN = 4; // ponytail: the usual English estimate, not a tokenizer; the block shows it as ~n

interface Fields { event?: unknown; ts?: unknown; workspace?: unknown; memory_ids?: unknown; memory_chars?: unknown; id?: unknown; session_id?: unknown; task?: unknown; stage?: unknown }

export type MemoryRecord = Fields;

/** A line as its record when it parses and names `workspace`, else nothing: the caller keeps only these, so a long log is never held whole. */
export function memoryRecord(line: string, workspace: string): MemoryRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && (value as Fields).workspace === workspace ? (value as Fields) : undefined;
  } catch {
    return undefined;
  }
}

const distinct = (records: readonly Fields[]): Set<unknown> => new Set(records.map((r) => r.id));

/** A workspace's memory stats over its `records` (events.jsonl.1 then events.jsonl, so in time order), the last MEMORY_STATS_DAYS days before `now`. */
export function memoryStats(records: readonly MemoryRecord[], entries: readonly MemoryEntry[], now: number): MemoryStats {
  const since = now - MEMORY_STATS_DAYS * DAY_MS;
  const recent = records.filter((r) => typeof r.ts === 'string' && Date.parse(r.ts) >= since);
  const runs = recent.filter((r) => r.event === 'run.spawned' && Array.isArray(r.memory_ids));
  const applied = recent.filter((r) => r.event === 'memory.applied' && typeof r.id === 'string');
  const kept = new Set(entries.map((e) => e.id));
  const cited = [...distinct(applied)].filter((id) => kept.has(id as string)).length;
  const chars = runs.reduce((sum, r) => sum + (typeof r.memory_chars === 'number' ? r.memory_chars : 0), 0);
  const latest = runs.at(-1);
  // only what the session cited from that run on: an earlier run of the same session is another injection
  const fromLatest = (r: Fields): boolean => latest !== undefined && r.session_id === latest.session_id && Date.parse(String(r.ts)) >= Date.parse(String(latest.ts));
  const sessionCited = latest?.session_id === undefined ? 0 : distinct(applied.filter(fromLatest)).size;
  return {
    runs: runs.length, cited,
    ...(runs.length > 0 ? { tokensPerRun: Math.round(chars / runs.length / CHARS_PER_TOKEN) } : {}),
    ...(latest ? { last: { at: String(latest.ts), task: typeof latest.task === 'string' ? latest.task : '', ...(typeof latest.stage === 'string' ? { stage: latest.stage } : {}), cited: sessionCited } } : {}),
  };
}
