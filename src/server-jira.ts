import type { Express, Request, Response } from 'express';
import { saveJiraCredential } from './credentials.js';
import type { Logger } from './log.js';
import { isNotConnected } from './source-errors.js';
import { BARE_HOST, jiraFetch, type JiraFetchDeps } from './sources/jira-fetch.js';
import type { JiraConnectError, JiraSiteStatus } from './types.js';

const SITES_ROUTE = '/settings/jira/sites';
const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;
export const JIRA_LOGIN_MESSAGE = 'email and token must be strings'; // the form always sends both, so this gets no copy of its own
export const JIRA_SAVE_MESSAGE = 'jira site not saved';

export interface JiraRouteDeps {
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv; // the config home credentials.json lives in; tests pass a temp XDG_CONFIG_HOME
  fetch?: typeof fetch; // the tests' fake Jira
}

interface Myself { accountId: string; displayName?: string }
type Check = { ok: true; me: Myself } | { ok: false; error: Exclude<JiraConnectError, 'invalid-site'> };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the user typed, as the bare host jiraFetch accepts: pasting the browser's URL works, and the credential still only goes to a bare host. */
export function normalizeJiraSite(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const site = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return BARE_HOST.test(site) ? site : undefined;
}

// /myself's body is untrusted: a non-string accountId, or a displayName that is present but not a string, is no answer at all
function myselfOf(body: unknown): Myself | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { accountId, displayName } = body as { accountId?: unknown; displayName?: unknown };
  if (typeof accountId !== 'string' || (displayName !== undefined && typeof displayName !== 'string')) return undefined;
  return { accountId, ...(displayName === undefined ? {} : { displayName }) };
}

// Refused only on a 401, so the row tells a wrong token (fix it) from a Jira that could not be reached (try again). jiraFetch's
// messages never carry the token or the header, so the raw one may go to hive.log
async function checkMyself(site: string, deps: JiraFetchDeps, log: JiraRouteDeps['log']): Promise<Check> {
  try {
    const me = myselfOf(await jiraFetch(site, '/myself', {}, deps));
    if (me !== undefined) return { ok: true, me };
    log.warn(`jira /myself ${site}: unexpected body`);
    return { ok: false, error: 'unreachable' };
  } catch (err) {
    log.warn(`jira /myself ${site}: ${errorMessage(err)}`);
    return { ok: false, error: isNotConnected(err) ? 'refused' : 'unreachable' };
  }
}

function loginOf(body: unknown): { email: string; token: string } | undefined {
  const { email, token } = (typeof body === 'object' && body !== null ? body : {}) as { email?: unknown; token?: unknown };
  return typeof email === 'string' && typeof token === 'string' ? { email, token } : undefined;
}

async function connect(req: Request, res: Response, { log, env, fetch }: JiraRouteDeps): Promise<void> {
  const body: unknown = req.body;
  const site = normalizeJiraSite((body as { site?: unknown } | undefined)?.site);
  if (site === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: 'invalid-site' });
  const login = loginOf(body);
  if (login === undefined) return void res.status(HTTP_BAD_REQUEST).json({ error: JIRA_LOGIN_MESSAGE });
  // the candidate reaches /myself through #816's provider seam and is written only once it passed: a refused token stores nothing,
  // and a refused reconnect leaves the working login in place
  const check = await checkMyself(site, { env, fetch, credential: async () => ({ ...login, accountId: '' }) }, log);
  if (!check.ok) {
    log.warn(`jira connect refused: ${site} (${check.error})`);
    return void res.status(HTTP_BAD_REQUEST).json({ error: check.error });
  }
  try {
    await saveJiraCredential(site, { ...login, accountId: check.me.accountId }, env);
  } catch (err) {
    log.error(`jira site ${site} not saved: ${errorMessage(err)}`);
    return void res.status(HTTP_SERVER_ERROR).json({ error: JIRA_SAVE_MESSAGE });
  }
  log.info(`jira site connected: ${site}`);
  const status: JiraSiteStatus = { site, state: 'connected', name: check.me.displayName ?? login.email };
  res.json(status);
}

/** The Jira sites of Settings › connections (#817). Registered next to /settings/github/auth, outside requireLive, so they answer in
 *  setup mode, where the first Jira source is created. No body field but the site reaches a log line. */
export function registerJiraRoutes(app: Express, deps: JiraRouteDeps): void {
  app.post(SITES_ROUTE, (req: Request, res: Response) => connect(req, res, deps));
}
