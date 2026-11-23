// Copilot's account (#962): every Copilot run, pty and headless, gets an explicit COPILOT_GITHUB_TOKEN, checked before the spawn. Without it
// Copilot reads the GH_TOKEN every run carries for the GitHub account, or its own `copilot login`. The token is the selected GitHub login's,
// else gh's machine login's, never accounts.github's. The check is one GET at every spawn, never held: a held answer would let a revoked token
// run, and bill, for the window (spike C1). copilot-limits.ts shares the token and the GET. No reason names a token, a body or a login.
import { AccountError, type AccountCode } from '../account-error.js';
import { isRecord } from '../rate-limits.js';
import type { AccountCtx } from './runner.js';

export const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user'; // undocumented; what Copilot itself reads (spike §7)
const FETCH_TIMEOUT_MS = 10_000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVER_ERROR = 500;
const TOKEN_ENV = 'COPILOT_GITHUB_TOKEN'; // read by Copilot before GH_TOKEN (spike §3)
const ENTITLED_QUOTAS = ['chat', 'premium_interactions'] as const; // Free carries chat, a paid plan premium (spike §7)
const NETWORK = 'network';

/** The token a run gets, the login it must answer as, and the account it names (absent: the machine's login). */
export interface CopilotToken { token: string; login: string; account?: string }
/** The tests' seam: the fetch the GET goes through. */
export interface CopilotFetch { fetch?: typeof fetch }

const missing = (reason: string): AccountError => new AccountError('copilot', 'missing', reason);

// A stored login of #959/#960: Object.hasOwn, so a name like toString never reads the prototype; an empty token is a hand-edited store
async function storedToken(ctx: AccountCtx, login: string): Promise<CopilotToken> {
  const { github } = await ctx.credentials();
  const token = github !== undefined && Object.hasOwn(github, login) ? github[login].token : '';
  if (token === '') throw missing('no stored token for the selected login');
  return { token, login, account: login };
}

// gh's login from hosts.yml and its token: with no gh login there is nothing the Hive can check, and no fallback to Copilot's own login
async function machineToken(ctx: AccountCtx): Promise<CopilotToken> {
  const login = await ctx.machineGithub.login();
  if (login === '') throw missing('gh has no login');
  const token = await ctx.machineGithub.token().catch(() => { throw missing('gh has no login'); }); // gh's words never travel
  return { token, login };
}

/** The run's token and the login it must answer as, per the selection; copilot/missing when none can be read, before anything is fetched. */
export function copilotToken(ctx: AccountCtx): Promise<CopilotToken> {
  return ctx.selected === undefined ? machineToken(ctx) : storedToken(ctx, ctx.selected);
}

// 401: the token answers for no one (revoked, expired). 403 and 404 on this endpoint: an account without Copilot. A 3xx is neither followed
// nor read. 5xx: GitHub's own failure
function statusCode(status: number): AccountCode {
  if (status === HTTP_UNAUTHORIZED) return 'mismatch';
  if (status >= HTTP_SERVER_ERROR) return 'unreachable';
  return 'missing';
}

/** The one GET of /copilot_internal/user. Throws AccountError: the status's code with `HTTP <status>`, or unreachable with `network` for a
 * transport failure, a timeout or a body that is not JSON (res.json() would quote the body). */
export async function fetchCopilotUser(token: string, deps: CopilotFetch = {}): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const res = await doFetch(COPILOT_USER_URL, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // no retry: the next start is the retry
    redirect: 'manual', // the bearer never follows a redirect off the fixed host
  }).catch(() => { throw new AccountError('copilot', 'unreachable', NETWORK); });
  if (!res.ok) throw new AccountError('copilot', statusCode(res.status), `HTTP ${res.status}`);
  const body: unknown = await res.json().catch(() => { throw new AccountError('copilot', 'unreachable', NETWORK); });
  return body;
}

// A quota the CLI can draw on: unlimited, or a positive entitlement
const entitled = (raw: unknown): boolean => isRecord(raw) && (raw.unlimited === true || (typeof raw.entitlement === 'number' && raw.entitlement > 0));

/** The answer must be `login`'s (GitHub logins are case-insensitive; no login in the body cannot be confirmed) and carry an entitlement. */
export function checkCopilotUser(body: unknown, login: string): void {
  const user: Record<string, unknown> = isRecord(body) ? body : {};
  if (typeof user.login !== 'string' || user.login.toLowerCase() !== login.toLowerCase()) throw new AccountError('copilot', 'mismatch', 'answered as another login');
  const snapshots: Record<string, unknown> = isRecord(user.quota_snapshots) ? user.quota_snapshots : {};
  if (!ENTITLED_QUOTAS.some((key) => entitled(snapshots[key]))) throw missing('no Copilot entitlement');
}

/** Copilot's AgentRunner.accountEnv (#962): the token, the GET, the check; the env and, for a stored login, the account it names. */
export async function copilotAccountEnv(ctx: AccountCtx, deps: CopilotFetch = {}): Promise<{ env: Record<string, string>; account?: string }> {
  const { token, login, account } = await copilotToken(ctx);
  checkCopilotUser(await fetchCopilotUser(token, deps), login);
  return { env: { [TOKEN_ENV]: token }, ...(account === undefined ? {} : { account }) };
}
