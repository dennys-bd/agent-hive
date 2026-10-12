import { isAbsolute } from 'node:path';
import { runners } from './agents/registry.js';
import type { Tokens } from './events.js';
import type { Activity, AgentId, Budget, UsageSample } from './types.js';
import { taskDir } from './worktree.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

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

/** A stage run's own usage (#742): the tokens by type and the models of the turns at or after its start, its subagents' included;
 * subagentTokens is the subagents' share of tokens. */
export interface TurnUsage { tokens: Tokens; models: string[]; subagentTokens: Tokens }

/** What a turn end reads from a session's transcript (#248, #489): its token total, the last /rename title when the user named it, and, asked
 * with a start time, that stage run's usage (#742). */
export interface TranscriptTurn { tokens: number; title?: string; usage?: TurnUsage }

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


/**
 * The worker's own transcript: an absolute `.jsonl` its agent's runner owns for the folder it runs in (taskDir: its worktree at
 * `<repo>/.hive/worktrees/<slug>`, or the workspace's checkout for a local task, #444), pinned to `sessionId` when given (#929). A forged hook
 * cannot point the excerpt at any other file.
 */
export function isWorkerTranscript(value: unknown, repo: string, activity: Pick<Activity, 'slug' | 'local'>, agent: AgentId, env: NodeJS.ProcessEnv = process.env, sessionId?: string): value is string {
  return isTranscriptIn(value, taskDir(repo, activity), agent, env, sessionId);
}

/** An absolute `.jsonl` that `agent`'s runner owns for `cwd` (#924, #929): a local session's (#587) is its workspace's checkout. */
export function isTranscriptIn(value: unknown, cwd: string, agent: AgentId, env: NodeJS.ProcessEnv = process.env, sessionId?: string): value is string {
  return isTranscriptPath(value) && runners[agent].ownsTranscript(value, cwd, sessionId, env);
}
