import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseUsage } from './rate-limits.js';
import type { Exec, RateLimits } from './types.js';

/** Undocumented; what `/usage` in Claude Code reads. The only host this module ever calls. */
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const PLAN_LIMITS_INTERVAL_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
const OAUTH_BETA = 'oauth-2025-04-20';
const CREDENTIALS_FILE = '.credentials.json';
const KEYCHAIN_ARGS = ['find-generic-password', '-s', 'Claude Code-credentials', '-w'];
const NO_TOKEN_MESSAGE = 'no Claude Code OAuth token (env, .credentials.json or Keychain)';

const execFileAsync: Exec = promisify(execFile);

export interface PlanLimitsDeps {
  fetch?: typeof fetch;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

// The file and the Keychain item hold the same JSON: { claudeAiOauth: { accessToken, refreshToken, expiresAt, … } }.
function tokenFromJson(text: string): string | undefined {
  try {
    const { claudeAiOauth } = JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown } };
    const token = claudeAiOauth?.accessToken;
    return typeof token === 'string' && token !== '' ? token : undefined;
  } catch {
    return undefined; // not JSON or not an object: the next source
  }
}

async function tokenFromFile(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), CREDENTIALS_FILE);
  const text = await readFile(path, 'utf8').catch(() => undefined); // missing or unreadable: the next source
  return text === undefined ? undefined : tokenFromJson(text);
}

async function tokenFromKeychain(exec: Exec): Promise<string | undefined> {
  try {
    const { stdout } = await exec('security', KEYCHAIN_ARGS);
    return tokenFromJson(stdout.trim());
  } catch {
    return undefined; // no item, or the Keychain is locked: nothing to read
  }
}

/** Same precedence as Claude Code: env → <config dir>/.credentials.json → macOS Keychain. Read on every call: Claude Code renews it. */
export async function readOAuthToken(deps: PlanLimitsDeps = {}): Promise<string> {
  const { env = process.env, exec = execFileAsync, platform = process.platform } = deps;
  const token = env.CLAUDE_CODE_OAUTH_TOKEN || (await tokenFromFile(env)) || (platform === 'darwin' ? await tokenFromKeychain(exec) : undefined);
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
