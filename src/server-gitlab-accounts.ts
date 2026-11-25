import type { Express, Request, Response } from 'express';
import { readCredentials, removeGitlabCredential, saveGitlabCredential } from './credentials.js';
import { TOKEN_CHARS } from './github-token.js';
import { verifyGitlabToken } from './gitlab/account.js';
import type { Logger } from './log.js';
import { hostKind } from './repo-host.js';
import type { GitlabAccountError, GitlabAccountRow } from './types.js';

const ROUTE = '/settings/accounts/gitlab';
const HTTP_NO_CONTENT = 204;
const HTTP_SERVER_ERROR = 500;
// The status of each refusal: the request's own fault, GitLab's verdict on the token, or GitLab out of reach
const STATUS: Record<GitlabAccountError, number> = { host: 400, token: 400, refused: 422, scope: 422, unverifiable: 422, unreachable: 502, unknown: 404 };
const SAVE_MESSAGE = 'gitlab account not stored'; // as the Claude routes' REMOVE_MESSAGE: a write failure is no refusal the card has copy for
const REMOVE_MESSAGE = 'gitlab account not removed';

export interface GitlabAccountRouteDeps {
  gitlabHosts: () => readonly string[]; // the saved config's; none before the first save, when gitlab.com is still one
  credentialsEnv?: NodeJS.ProcessEnv; // the config home credentials.json lives in; tests pass a temp XDG_CONFIG_HOME
  fetch?: typeof globalThis.fetch; // tests inject; default Node's
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

async function listAccounts(res: Response, deps: GitlabAccountRouteDeps): Promise<void> {
  const stored = (await readCredentials(deps.credentialsEnv)).gitlab ?? {};
  const accounts: GitlabAccountRow[] = Object.entries(stored)
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([host, { username, expiresAt }]) => ({ host, username, ...(expiresAt === undefined ? {} : { expiresAt }) }));
  res.json({ accounts });
}

// The host first, so the token is only ever sent to a GitLab host; then its shape; then GitLab. An unchecked host is never logged: it is
// whatever the caller typed, a pasted token included
async function connect(req: Request, res: Response, deps: GitlabAccountRouteDeps): Promise<void> {
  const body = req.body as { host?: unknown; token?: unknown } | undefined;
  const host = text(body?.host).toLowerCase();
  const token = text(body?.token);
  const refuse = (error: GitlabAccountError): void => {
    deps.log.warn(`gitlab account not connected: ${host}: ${error}`);
    res.status(STATUS[error]).json({ error });
  };
  if (hostKind(host, deps.gitlabHosts()) !== 'gitlab') {
    deps.log.warn('gitlab account not connected: not a GitLab host');
    return void res.status(STATUS.host).json({ error: 'host' });
  }
  if (!TOKEN_CHARS.test(token)) return refuse('token');
  const verdict = await verifyGitlabToken(host, token, deps.fetch);
  if ('error' in verdict) return refuse(verdict.error);
  try {
    await saveGitlabCredential(host, { token, ...verdict }, deps.credentialsEnv);
  } catch (err) {
    deps.log.error(`gitlab account ${host} not stored: ${errorMessage(err)}`);
    return void res.status(HTTP_SERVER_ERROR).json({ error: SAVE_MESSAGE });
  }
  deps.log.info(`gitlab account connected: ${host} (${verdict.username})`);
  res.json({ host, ...verdict } satisfies GitlabAccountRow);
}

// Always allowed: no selection points at a GitLab account (spec). removeGitlabCredential writes only when the host is stored
async function removeAccount(host: string, res: Response, deps: GitlabAccountRouteDeps): Promise<void> {
  let isRemoved: boolean;
  try {
    isRemoved = await removeGitlabCredential(host, deps.credentialsEnv);
  } catch (err) {
    deps.log.error(`gitlab account ${host} not removed: ${errorMessage(err)}`);
    return void res.status(HTTP_SERVER_ERROR).json({ error: REMOVE_MESSAGE });
  }
  if (!isRemoved) return void res.status(STATUS.unknown).json({ error: 'unknown' satisfies GitlabAccountError });
  deps.log.info(`gitlab account removed: ${host}`);
  res.status(HTTP_NO_CONTENT).end();
}

/** The GitLab accounts of Settings (#1048), one per bare host. Registered next to the Claude routes, outside requireLive, since setup mode
 * shows Settings too. Writes go through updateCredentials: no config selection to interleave with, so not the save chain. No answer, log
 * line or error carries a token. */
export function registerGitlabAccountRoutes(app: Express, deps: GitlabAccountRouteDeps): void {
  app.get(ROUTE, (_req: Request, res: Response) => listAccounts(res, deps));
  app.post(ROUTE, (req: Request, res: Response) => connect(req, res, deps));
  // Express has already decoded :host
  app.delete(`${ROUTE}/:host`, (req: Request<{ host: string }>, res: Response) => removeAccount(req.params.host, res, deps));
}
