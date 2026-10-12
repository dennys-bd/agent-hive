import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { collectWindows, isPercent, isRecord, PERCENT_MAX } from '../rate-limits.js';
import type { Exec, RateLimits, RateLimitWindow } from '../types.js';

// Claude Code's plan limits (#924, out of plan-limits.ts and rate-limits.ts): the OAuth usage endpoint and its token, and the two shapes the
// Hive reads them in, the status line's JSON and the endpoint's.

/** Undocumented; what `/usage` in Claude Code reads. The only host this module ever calls. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const MS_PER_SECOND = 1000;

// `used_percentage` is a finite number from 0 (clamped to 100: the meter never overflows); `resets_at` is a positive integer in
// epoch seconds. Anything else drops the window.
function parseWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { used_percentage: usedPercent, resets_at: resetsAt } = raw;
  if (!isPercent(usedPercent)) return undefined;
  if (typeof resetsAt !== 'number' || !Number.isInteger(resetsAt) || resetsAt <= 0) return undefined;
  const reset = new Date(resetsAt * MS_PER_SECOND);
  if (Number.isNaN(reset.getTime())) return undefined; // past the Date range: invalid
  return { usedPercent: Math.min(usedPercent, PERCENT_MAX), resetsAt: reset.toISOString() };
}

/** `body.rate_limits` of a status line JSON → the persisted shape. */
export function parseRateLimits(body: unknown, now: Date): RateLimits | undefined {
  if (!isRecord(body) || !isRecord(body.rate_limits)) return undefined;
  return collectWindows(body.rate_limits, parseWindow, now);
}

// The usage endpoint window: `utilization` percent and `resets_at` as a date string. `null` (a window the plan lacks) drops it.
function parseUsageWindow(raw: unknown): RateLimitWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const { utilization, resets_at: resetsAt } = raw;
  if (!isPercent(utilization) || typeof resetsAt !== 'string') return undefined;
  const reset = new Date(resetsAt);
  if (Number.isNaN(reset.getTime())) return undefined;
  return { usedPercent: Math.min(utilization, PERCENT_MAX), resetsAt: reset.toISOString() };
}

/** The body of GET /api/oauth/usage (undocumented: parsed defensively) → the same persisted shape. `extra_usage` falls to the filter. */
export function parseUsage(body: unknown, now: Date): RateLimits | undefined {
  return isRecord(body) ? collectWindows(body, parseUsageWindow, now) : undefined;
}

const FETCH_TIMEOUT_MS = 10_000;
const OAUTH_BETA = 'oauth-2025-04-20';
const CREDENTIALS_FILE = '.credentials.json';
const KEYCHAIN_ARGS = ['find-generic-password', '-s', 'Claude Code-credentials', '-w'];
// #658: a bare "Keychain" reads as something a Linux user lacks or must set up
const NO_TOKEN_MESSAGE = 'no Claude Code OAuth token (env, .credentials.json or macOS Keychain)';

const execFileAsync: Exec = promisify(execFile);

export interface PlanLimitsDeps {
  fetch?: typeof fetch;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

// The file and the Keychain item hold the same JSON: { claudeAiOauth: { accessToken, refreshToken, expiresAt, … } }. Claude Code
// renews each store on its own, so one can hold a token that expired while the other is current: an expired copy is no source at all,
// it only buys an HTTP 401. `expiresAt` is epoch milliseconds; a store without it is taken at its word.
function tokenFromJson(text: string, now: number): string | undefined {
  try {
    const { claudeAiOauth } = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const token = claudeAiOauth?.accessToken;
    const expiresAt = claudeAiOauth?.expiresAt;
    if (typeof expiresAt === 'number' && expiresAt <= now) return undefined;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined; // not JSON or not an object: the next source
  }
}

async function tokenFromFile(env: NodeJS.ProcessEnv, now: number): Promise<string | undefined> {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), CREDENTIALS_FILE);
  const text = await readFile(path, 'utf8').catch(() => undefined); // missing or unreadable: the next source
  return text === undefined ? undefined : tokenFromJson(text, now);
}

async function tokenFromKeychain(exec: Exec, now: number): Promise<string | undefined> {
  try {
    const { stdout } = await exec('security', KEYCHAIN_ARGS);
    return tokenFromJson(stdout.trim(), now);
  } catch {
    return undefined; // no item, or the Keychain is locked: nothing to read
  }
}

/** Same precedence as Claude Code: env → <config dir>/.credentials.json → macOS Keychain. Read on every call: Claude Code renews it. */
export async function readOAuthToken(deps: PlanLimitsDeps = {}): Promise<string> {
  const { env = process.env, exec = execFileAsync, platform = process.platform, now = () => new Date() } = deps;
  const at = now().getTime();
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || (await tokenFromFile(env, at)) || (platform === 'darwin' ? await tokenFromKeychain(exec, at) : undefined);
  if (!token) throw new Error(NO_TOKEN_MESSAGE);
  return token;
}

/** One reading of the account's plan limits. The token exists only inside this call; no error carries it or the response body. */
export async function readPlanLimits(deps: PlanLimitsDeps = {}): Promise<RateLimits | undefined> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const token = await readOAuthToken(deps);
  const res = await doFetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next reading is the retry
    redirect: 'manual', // the bearer never follows a redirect off the fixed host; a 3xx is just a failed reading (!res.ok)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => { throw new Error('invalid JSON body'); }); // res.json() would quote the body
  return parseUsage(body, now());
}
