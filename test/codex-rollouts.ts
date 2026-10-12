// Codex rollouts for the tests (#929): the record shapes of finding.codex-surface §9 and §11, built in code so no account id can ride along
// (a real session_meta carries creator_account_id and creator_user_id). Every file goes under a CODEX_HOME made by tempDir.
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SESSION = '019a1b2c-0000-7000-8000-000000000001';
export const CHILD = '019a1b2c-0000-7000-8000-000000000002';
export const OTHER = '019a1b2c-0000-7000-8000-000000000003';
export const STALE = '019a1b2c-0000-7000-8000-000000000004';
export const OTHER_CHILD = '019a1b2c-0000-7000-8000-000000000005';
export const NOW = Date.parse('2026-10-12T12:00:00.000Z');
export const DAY = '2026/10/12';
/** The worktree every fixture session ran in: deletion only takes a rollout whose session_meta names it. */
export const CWD = '/repo/.hive/worktrees/hive-1-t';

const pad = (n: number): string => String(n).padStart(2, '0');
/** A time's local date folder, as Codex names it: YYYY/MM/DD. */
export const localDay = (at: Date): string => `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())}`;

export const line = (timestamp: string, type: string, payload: unknown): string => JSON.stringify({ timestamp, type, payload });
export const sessionMeta = (id: string, parent?: string, cwd = CWD): string => line('2026-10-12T10:00:00.000Z', 'session_meta', {
  id, cwd,
  source: parent === undefined ? 'cli' : { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_role: 'hive-reviewer' } } },
});
export const turnContext = (timestamp: string, turnId: string, model: string): string => line(timestamp, 'turn_context', { turn_id: turnId, model });
export interface Usage { input: number; cached: number; cacheWrite: number; output: number }
export const usageRecord = (timestamp: string, turnId: string, responseId: string, u: Usage, threadTotal: number): string => line(timestamp, 'token_usage_record', {
  turn_id: turnId, session_id: SESSION, response_id: responseId,
  usage: { input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: u.cacheWrite, output_tokens: u.output, reasoning_output_tokens: 0, total_tokens: u.input + u.output },
  thread_token_usage: { total_tokens: threadTotal },
});
export const tokenCount = (timestamp: string, rateLimits: unknown): string => line(timestamp, 'event_msg', { type: 'token_count', info: null, rate_limits: rateLimits });

/** Two turns of SESSION on two models, the second response written twice. */
export const TWO_TURNS: readonly string[] = [
  sessionMeta(SESSION),
  turnContext('2026-10-12T10:00:01.000Z', 'turn-1', 'gpt-5.6-luna'),
  usageRecord('2026-10-12T10:00:05.000Z', 'turn-1', 'resp-1', { input: 11803, cached: 9000, cacheWrite: 0, output: 63 }, 11866),
  turnContext('2026-10-12T10:10:00.000Z', 'turn-2', 'gpt-5.6-terra'),
  usageRecord('2026-10-12T10:10:05.000Z', 'turn-2', 'resp-2', { input: 20000, cached: 15000, cacheWrite: 100, output: 500 }, 32366),
  usageRecord('2026-10-12T10:10:05.000Z', 'turn-2', 'resp-2', { input: 20000, cached: 15000, cacheWrite: 100, output: 500 }, 32366),
];

/** A subagent rollout: its own id, its parent, one turn. */
export const subagent = (id: string, parent: string): string[] => [
  sessionMeta(id, parent), turnContext('2026-10-12T10:12:00.000Z', 'turn-c1', 'gpt-6-luna'),
  usageRecord('2026-10-12T10:12:05.000Z', 'turn-c1', `resp-${id}`, { input: 3000, cached: 1000, cacheWrite: 0, output: 200 }, 3200),
];

/** Writes a rollout under `<home>/sessions/<day>/`, named as Codex names it, last written at `mtimeMs`. */
export async function writeRollout(home: string, day: string, id: string, lines: readonly string[], mtimeMs = NOW): Promise<string> {
  const dir = join(home, 'sessions', ...day.split('/'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${day.replaceAll('/', '-')}T10-00-00-${id}.jsonl`);
  await writeFile(path, `${lines.join('\n')}\n`);
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  return path;
}
