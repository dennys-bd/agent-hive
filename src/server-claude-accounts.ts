import type { Express, Request, Response } from 'express';
import { type ClaudeAdd, nameRefusal, trimmedName } from './claude-account.js';
import { readCredentials, removeClaudeCredential } from './credentials.js';
import type { Logger } from './log.js';
import type { AccountsConfig, ClaudeAccountError } from './types.js';

const ROUTE = '/settings/accounts/claude';
const ADD_ROUTE = `${ROUTE}/add`;
const HTTP_ACCEPTED = 202;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const REMOVE_MESSAGE = 'claude account not removed'; // as JIRA_REMOVE_MESSAGE: a write failure is no refusal the card has copy for

export interface ClaudeAccountRouteDeps {
  add: ClaudeAdd;
  credentialsEnv?: NodeJS.ProcessEnv; // the config home credentials.json lives in; tests pass a temp XDG_CONFIG_HOME
  savedAccounts: () => AccountsConfig | undefined; // the saved config's selection; undefined before the first save
  queueSave: (save: () => Promise<void>) => Promise<void>; // POST /settings' chain
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (res: Response, status: number, error: ClaudeAccountError): void => void res.status(status).json({ error });
const storedNames = async (env?: NodeJS.ProcessEnv): Promise<string[]> => Object.keys((await readCredentials(env)).claude ?? {});

async function listNames(res: Response, deps: ClaudeAccountRouteDeps): Promise<void> {
  const names = (await storedNames(deps.credentialsEnv)).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  res.json({ names });
}

// The name is checked before anything runs; the add itself refuses a second one, so two racing POSTs never start two ptys
async function startAdd(req: Request, res: Response, deps: ClaudeAccountRouteDeps): Promise<void> {
  const raw = (req.body as { name?: unknown } | undefined)?.name;
  const refusal = nameRefusal(raw, await storedNames(deps.credentialsEnv));
  if (refusal !== undefined) return refuse(res, HTTP_BAD_REQUEST, refusal);
  const status = deps.add.start(trimmedName(raw));
  if (status === undefined) return refuse(res, HTTP_CONFLICT, 'add-pending');
  res.status(HTTP_ACCEPTED).json(status);
}

// On the save chain, so a save's accountsRefusal (#952) and this check never interleave: a selection never points at nothing by the Hive's
// doing. Answers every error itself: the chain must never reject
async function removeAccount(name: string, res: Response, deps: ClaudeAccountRouteDeps): Promise<void> {
  if (!(await storedNames(deps.credentialsEnv)).includes(name)) return refuse(res, HTTP_NOT_FOUND, 'unknown');
  if (deps.savedAccounts()?.claude === name) return refuse(res, HTTP_CONFLICT, 'selected');
  try {
    await removeClaudeCredential(name, deps.credentialsEnv);
  } catch (err) {
    deps.log.error(`claude account ${name} not removed: ${errorMessage(err)}`);
    return void res.status(HTTP_SERVER_ERROR).json({ error: REMOVE_MESSAGE });
  }
  deps.log.info(`claude account removed: ${name}`);
  res.status(HTTP_NO_CONTENT).end();
}

/** The Claude accounts of Settings (#955), for #964 and #965. Registered next to the Jira routes, outside requireLive, since setup mode shows
 *  Settings too. No answer carries a token. DELETE …/add is registered before …/:name: `add` is a reserved name (nameRefusal). */
export function registerClaudeAccountRoutes(app: Express, deps: ClaudeAccountRouteDeps): void {
  app.get(ROUTE, (_req: Request, res: Response) => listNames(res, deps));
  app.post(ADD_ROUTE, (req: Request, res: Response) => startAdd(req, res, deps));
  app.get(ADD_ROUTE, (_req: Request, res: Response) => { res.json(deps.add.status()); });
  app.delete(ADD_ROUTE, (_req: Request, res: Response) => {
    deps.add.cancel();
    res.status(HTTP_NO_CONTENT).end();
  });
  // Express has already decoded :name
  app.delete(`${ROUTE}/:name`, (req: Request<{ name: string }>, res: Response) => deps.queueSave(() => removeAccount(req.params.name, res, deps)));
}
