import type { Express, Request, Response } from 'express';
import { githubLoginsStored, removeGithubCredential } from './credentials.js';
import type { GithubAccount } from './github-account.js';
import type { GithubAdd } from './github-login-gh.js';
import type { Logger } from './log.js';
import type { AccountsConfig, GithubLogins } from './types.js';

const ACCOUNTS_ROUTE = '/settings/github/accounts';
// #960: outside /accounts/:login, since `add` is a valid GitHub login, whose remove …/accounts/add would hide
const ADD_ROUTE = '/settings/github/add';
const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const NOT_STORED_MESSAGE = 'no stored GitHub login by that name';
export const GITHUB_REMOVE_MESSAGE = 'github login not removed';
const SELECTING = ['github', 'copilot'] as const; // Copilot runs on a GitHub login (#962)

export interface GithubAccountRouteDeps {
  account: GithubAccount;
  accounts: () => AccountsConfig | undefined; // the saved selection; undefined in setup mode
  log: Pick<Logger, 'info' | 'error'>;
  env?: NodeJS.ProcessEnv; // the store the device flow writes
  queueSave: (save: () => Promise<void>) => Promise<void>; // a save that selects this login and the remove never interleave
  add: GithubAdd; // #960: gh's browser login
}

// A gh that cannot be read leaves the machine out: the stored logins still answer
async function list(res: Response, { account, env }: GithubAccountRouteDeps): Promise<void> {
  const [logins, machine] = await Promise.all([githubLoginsStored(env), account.machine.login().catch(() => '')]);
  const body: GithubLogins = { logins, ...(machine === '' ? {} : { machine }) };
  res.json(body);
}

// The selected account cannot be removed (#959): a selection never points at nothing by the Hive's doing. Express has decoded :login
async function remove(req: Request<{ login: string }>, res: Response, deps: GithubAccountRouteDeps): Promise<void> {
  const { login } = req.params;
  const selecting = SELECTING.find((key) => deps.accounts()?.[key] === login);
  if (selecting !== undefined) return void res.status(HTTP_CONFLICT).json({ error: `"accounts.${selecting}" selects this login` });
  let removed: boolean;
  try {
    removed = await removeGithubCredential(login, deps.env);
  } catch (err) {
    deps.log.error(`github login ${login} not removed: ${err instanceof Error ? err.message : String(err)}`);
    return void res.status(HTTP_SERVER_ERROR).json({ error: GITHUB_REMOVE_MESSAGE });
  }
  if (!removed) return void res.status(HTTP_NOT_FOUND).json({ error: NOT_STORED_MESSAGE });
  deps.log.info(`github login removed: ${login}`); // the login only, never the token
  res.json({ ok: true });
}

// The add refuses a second one itself, so two racing POSTs never start two gh
function startAdd(res: Response, add: GithubAdd): void {
  const status = add.start();
  if (status === undefined) return void res.status(HTTP_CONFLICT).json({ error: 'add-pending' });
  res.status(HTTP_ACCEPTED).json(status);
}

/** The GitHub logins of Settings (#959, #960, for #964 and #965). Registered next to /settings/github/auth, outside requireLive: both logins
 *  work in setup mode. No answer carries a token. */
export function registerGithubAccountRoutes(app: Express, deps: GithubAccountRouteDeps): void {
  app.get(ACCOUNTS_ROUTE, (_req: Request, res: Response) => list(res, deps));
  app.delete(`${ACCOUNTS_ROUTE}/:login`, (req: Request<{ login: string }>, res: Response) => deps.queueSave(() => remove(req, res, deps)));
  app.post(ADD_ROUTE, (_req: Request, res: Response) => startAdd(res, deps.add));
  app.get(ADD_ROUTE, (_req: Request, res: Response) => {
    res.json(deps.add.status());
  });
  app.delete(ADD_ROUTE, (_req: Request, res: Response) => {
    deps.add.cancel();
    res.status(HTTP_NO_CONTENT).end();
  });
}
