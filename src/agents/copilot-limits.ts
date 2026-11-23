// Copilot's plan limits (#879, node 7 of #608): GET /copilot_internal/user (spike §7). Undocumented, so parsed defensively; it spends nothing.
// #962: with the token the runs use (the selected GitHub login's, else gh's machine login's) over the GET the spawn's check makes. No login
// check: a mismatch is the spawn's to refuse. No reason quotes a token, a body or gh's words.
import { AccountError } from '../account-error.js';
import type { AccountEnvDeps } from '../account-env.js';
import { isPercent, isRecord, PERCENT_MAX } from '../rate-limits.js';
import type { RateLimits, RateLimitWindow } from '../types.js';
import type { PlanLimitsDeps } from './claude-limits.js';
import { copilotToken, fetchCopilotUser } from './copilot-account.js';
import type { AccountCtx } from './runner.js';

const NO_TOKEN = 'no Copilot token';
const UNREACHABLE = 'Copilot quota unreachable';
const NO_QUOTA = 'no Copilot quota with an entitlement';
// The quotas the CLI draws on, first match wins: a paid plan's premium requests, else Free's chat (spike §7). completions is the editor's
const QUOTAS = ['premium_interactions', 'chat'] as const;
const HUNDREDTHS = 100; // 100 − 97.6 is 2.4000000000000057: kept to the hundredths the API gives

// A quota the CLI can spend: an entitlement, `unlimited: false` said outright (every snapshot of spike §7 has it: a shape without it is
// unseen, so no reading rather than a guess), and its percent_remaining
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

// The ctx a run's accountEnv gets (account-env.ts' accountEnv), for Copilot's provider
const ctxOf = (accounts: AccountEnvDeps): AccountCtx =>
  ({ ...(accounts.accounts.copilot === undefined ? {} : { selected: accounts.accounts.copilot }), credentials: accounts.credentials, machineGithub: accounts.machineGithub });

// The GET's refusal names its status (AccountError's fixed `HTTP <status>`); a transport failure or a body that is not JSON is unreachable
const readFailure = (err: unknown): Error =>
  new Error(err instanceof AccountError && err.reason?.startsWith('HTTP ') ? `Copilot quota read failed: ${err.reason}` : UNREACHABLE);

/** One read of the account Copilot's runs use (#879, #962). No reading throws a fixed reason (#557), for planLimitsReading to list. */
export async function readCopilotPlanLimits(deps: Pick<PlanLimitsDeps, 'accounts' | 'fetch' | 'now'> = {}): Promise<RateLimits> {
  if (deps.accounts === undefined) throw new Error(NO_TOKEN);
  const { token } = await copilotToken(ctxOf(deps.accounts)).catch(() => { throw new Error(NO_TOKEN); });
  const body = await fetchCopilotUser(token, deps).catch((err: unknown) => { throw readFailure(err); });
  const reading = parseCopilotUser(body, deps.now?.() ?? new Date());
  if (!reading) throw new Error(NO_QUOTA);
  return reading;
}
