// Copilot's plan limits (#879, node 7 of #608): `gh api /copilot_internal/user` (spike §7). Undocumented, so parsed defensively; it spends
// nothing, and it answers for gh's own logged-in account, which may not be the one a run uses (COPILOT_GITHUB_TOKEN, a `copilot login`).
import { childEnv, cliEnv } from '../github-token.js';
import { createExec } from '../exec-path.js';
import { isPercent, isRecord, PERCENT_MAX } from '../rate-limits.js';
import type { Exec, RateLimits, RateLimitWindow } from '../types.js';
import { agentDirs } from './command.js';
import type { PlanLimitsDeps } from './claude-limits.js';

const GH_ARGS = ['api', '/copilot_internal/user'];
const GH_TIMEOUT_MS = 10_000;
// The quotas the CLI draws on, first match wins: a paid plan's premium requests, else Free's chat (spike §7). completions is the editor's
const QUOTAS = ['premium_interactions', 'chat'] as const;
const HUNDREDTHS = 100; // 100 − 97.6 is 2.4000000000000057: kept to the hundredths the API gives

const execGh: Exec = createExec({ platform: process.platform, env: process.env, dirsFor: (name) => agentDirs(name, process.platform, process.env) });

// A quota the CLI can spend: an entitlement, not unlimited, and its percent_remaining
function usedPercent(raw: unknown): number | undefined {
  if (!isRecord(raw) || raw.unlimited !== false || typeof raw.entitlement !== 'number' || raw.entitlement <= 0) return undefined;
  if (!isPercent(raw.percent_remaining)) return undefined;
  const used = Math.min(Math.max(PERCENT_MAX - raw.percent_remaining, 0), PERCENT_MAX);
  return Math.round(used * HUNDREDTHS) / HUNDREDTHS;
}

/** The body of /copilot_internal/user → one thirty_day window (the monthly quota), or no reading. */
export function parseCopilotUser(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.quota_snapshots) || typeof body.quota_reset_date_utc !== 'string') return undefined;
  const reset = new Date(body.quota_reset_date_utc);
  if (Number.isNaN(reset.getTime())) return undefined;
  const snapshots = body.quota_snapshots;
  const percent = QUOTAS.map((key) => usedPercent(snapshots[key])).find((value) => value !== undefined);
  if (percent === undefined) return undefined;
  const window: RateLimitWindow = { usedPercent: percent, resetsAt: reset.toISOString() };
  return { at: now.toISOString(), windows: { thirty_day: window } };
}

/** One read of gh's account (#879). No reading throws its reason (#557), for planLimitsReading to list; no reason quotes gh's words. */
export async function readCopilotPlanLimits(deps: Pick<PlanLimitsDeps, 'exec' | 'env' | 'now'> = {}): Promise<RateLimits> {
  const exec = deps.exec ?? execGh;
  const env = childEnv(deps.env ?? process.env, cliEnv()); // gh's login, never an inherited GH_TOKEN (#180)
  const { stdout } = await exec('gh', GH_ARGS, { env, timeout: GH_TIMEOUT_MS }).catch(() => {
    throw new Error('gh api /copilot_internal/user failed: run gh auth login');
  });
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error('gh answered no JSON for the Copilot quota');
  }
  const reading = parseCopilotUser(body, deps.now?.() ?? new Date());
  if (!reading) throw new Error('no Copilot quota with an entitlement');
  return reading;
}
