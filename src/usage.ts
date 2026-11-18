import { isAbsolute } from 'node:path';
import { runners } from './agents/registry.js';
import type { Tokens } from './facts.js';
import type { Machine } from './machine.js';
import type { Activity, AgentId, Budget, UsageSample } from './types.js';
import { taskDir } from './worktree.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;


export { cleanTitle } from './title.js';

/** A stage run's own usage (#742): the tokens by type and the models of the turns at or after its start, its subagents' included;
 * subagentTokens is the subagents' share of tokens. tokensByModel (#271) splits tokens by each response's model, `unknown` for one that names
 * none, so it always sums to tokens and any run can be priced per model later. */
export interface TurnUsage { tokens: Tokens; models: string[]; subagentTokens: Tokens; tokensByModel: Record<string, Tokens> }

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
export function isWorkerTranscript(machine: Machine, value: unknown, repo: string, activity: Pick<Activity, 'slug' | 'local'>, agent: AgentId, sessionId?: string): value is string {
  return isTranscriptIn(machine, value, taskDir(repo, activity), agent, sessionId);
}

/** An absolute `.jsonl` that `agent`'s runner owns for `cwd` (#924, #929): a local session's (#587) is its workspace's checkout. */
export function isTranscriptIn(machine: Machine, value: unknown, cwd: string, agent: AgentId, sessionId?: string): value is string {
  return isTranscriptPath(value) && runners[agent].ownsTranscript(machine, value, cwd, sessionId);
}
