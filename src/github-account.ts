// The GitHub account (#959, node 3.1 of #958): which login the Hive's own reads run as, and the token each stored login has.
import { readCredentials } from './credentials.js';
import type { GhToken } from './github-token.js';
import type { Config, Credentials, GithubAuth } from './types.js';

export const NO_TOKEN_MESSAGE = 'no GitHub token: run `hive login` or connect in settings';
const SEVERAL_MESSAGE = 'several GitHub logins are stored: choose one in "accounts.github"';
const NONE = ''; // no login: accessFor answers undefined, as today

export interface GithubSelection { auth: GithubAuth; github?: string } // config.auth.github and config.accounts.github
/** The selected login as a GhToken, plus why a 401 happened: a stored login's refusal names it; the machine's answers undefined. */
export interface SelectedGithub extends GhToken { refusal(): Promise<string | undefined> }
export interface GithubAccount {
  use(selection: GithubSelection): void; // hive.ts with the boot config, then the server on every applied config
  selection(): GithubSelection; // what use() last set: the save path's undo reads it
  selected: SelectedGithub; // what the Hive's own reads use
  machine: GhToken; // gh's login and token, whatever the selection (#962 reads it)
  tokenOf(login: string): Promise<string>; // a stored login's token; rejects naming the login when it is absent
}
export interface GithubAccountDeps { machine: GhToken; env?: NodeJS.ProcessEnv; credentials?: () => Promise<Credentials> }
type Logins = NonNullable<Credentials['github']>;

// The api rule with nothing named: the only stored login, NONE with none; several is a failure naming the key that would choose
function onlyLogin(logins: Logins): string {
  const names = Object.keys(logins);
  if (names.length > 1) throw new Error(SEVERAL_MESSAGE);
  return names[0] ?? NONE;
}

/** The api rule with no selection, as a token: what apiGql reads when no holder was handed. Read per call, never held. */
export async function defaultGithubToken(env?: NodeJS.ProcessEnv): Promise<string> {
  const logins = (await readCredentials(env)).github ?? {};
  const login = onlyLogin(logins);
  if (login === NONE) throw new Error(NO_TOKEN_MESSAGE); // makes resolveFields fail on boot, which reopens setup with the reason
  return logins[login].token;
}

const missingMessage = (login: string): string => `"accounts.github" names ${login}, which has no stored token: log in again in Settings`;
const refusedMessage = (login: string): string => `the token of ${login} was refused: log in again in Settings`;

// The stored login the selection reads as; undefined is the machine's (cli, nothing named). Rejects with several in api
async function storedLoginOf(selection: GithubSelection, read: () => Promise<Logins>): Promise<string | undefined> {
  if (selection.github !== undefined) return selection.github;
  if (selection.auth === 'cli') return undefined;
  return onlyLogin(await read());
}

// The selected login as a holder. A stored token is read per call, never held, so a remove or a new login takes the next call
function selectedOf(machine: GhToken, current: () => GithubSelection, read: () => Promise<Logins>, stored: (login: string) => Promise<string | undefined>): SelectedGithub {
  // a named login with no token fails here, never later as another account
  const tokenOfSelected = async (login: string): Promise<string> => {
    const token = await stored(login);
    if (token === undefined) throw new Error(missingMessage(login));
    return token;
  };
  return {
    login: async () => {
      const login = await storedLoginOf(current(), read);
      if (login === undefined) return machine.login();
      if (login !== NONE) await tokenOfSelected(login);
      return login;
    },
    token: async () => {
      const login = await storedLoginOf(current(), read);
      if (login === undefined) return machine.token();
      if (login === NONE) throw new Error(NO_TOKEN_MESSAGE);
      return tokenOfSelected(login);
    },
    invalidate: () => {
      if (current().github === undefined && current().auth === 'cli') machine.invalidate(); // only the machine holds a token
    },
    refusal: async () => {
      const login = await storedLoginOf(current(), read).catch(() => undefined);
      return login === undefined || login === NONE ? undefined : refusedMessage(login);
    },
  };
}

/** One account per daemon (#959). Before the first use the selection is cli with nothing named: today's default for a Hive with no GitHub source. */
export function createGithubAccount(deps: GithubAccountDeps): GithubAccount {
  const credentials = deps.credentials ?? (() => readCredentials(deps.env));
  const read = async (): Promise<Logins> => (await credentials()).github ?? {};
  const stored = async (login: string): Promise<string | undefined> => {
    const logins = await read();
    return Object.hasOwn(logins, login) ? logins[login].token : undefined;
  };
  let current: GithubSelection = { auth: 'cli' };
  return {
    use: (selection) => { current = { ...selection }; },
    selection: () => current,
    selected: selectedOf(deps.machine, () => current, read, stored),
    machine: deps.machine,
    tokenOf: async (login) => {
      const token = await stored(login);
      if (token === undefined) throw new Error(`github: no stored token for the login ${login}`);
      return token;
    },
  };
}

/** The selection a config makes: auth.github (cli without a GitHub source) and accounts.github. */
export const selectionOf = ({ auth, accounts }: Pick<Config, 'auth' | 'accounts'>): GithubSelection =>
  ({ auth: auth?.github ?? 'cli', ...(accounts.github === undefined ? {} : { github: accounts.github }) });

/** A save's switch (#959): `next` now, so the save's check reads as the login that will read; undo() puts the previous one back. changed:
 * accounts.github moved, which kicks a read round once the save applied. */
export function switchSelection(account: GithubAccount, next: GithubSelection): { undo(): void; changed: boolean } {
  const previous = account.selection();
  account.use(next);
  return { undo: () => account.use(previous), changed: previous.github !== next.github };
}
