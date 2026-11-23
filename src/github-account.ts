// The GitHub account (#959, node 3.1 of #958): which login the Hive's own reads run as, and the token each stored login has.
import { readCredentials } from './credentials.js';
import type { GhToken } from './github-token.js';
import type { Machine, MachineExec, Machines } from './machine.js';
import { type Config, type Credentials, type GithubAuth, LOCAL_MACHINE } from './types.js';

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

/** The holder's refusal when it is the account's selected login; undefined for gh's bare holder. */
export const refusalOf = (holder: GhToken | SelectedGithub): SelectedGithub['refusal'] | undefined => ('refusal' in holder ? holder.refusal : undefined);

/** A 401 (#503, #959): the held token is dropped, then a stored login's refusal rejects naming it. */
export async function unauthorized(deps: { onUnauthorized?: () => void; refusal?: () => Promise<string | undefined> }, prefix: string): Promise<void> {
  deps.onUnauthorized?.();
  const why = await deps.refusal?.();
  if (why !== undefined) throw new Error(`${prefix}: HTTP 401: ${why}`);
}

/** What a gh call's env gets from the selection (#961). */
export type GhEnv = () => Promise<Record<string, string>>;

/** The selection as a gh env (#961): {} for the machine's login (accounts.github absent, whatever auth.github), else the named login's
 * GH_TOKEN; rejects with the missing message when it has no stored token, never falling back to gh's own login. */
export async function ghEnvOf(account: Pick<GithubAccount, 'selection' | 'selected'>): Promise<Record<string, string>> {
  if (account.selection().github === undefined) return {};
  return { GH_TOKEN: await account.selected.token() };
}

/** An exec whose gh calls follow the selection (#961). A gh call with an env of its own (GhToken's, #960's login, Copilot's limits) and
 * any other file pass through; on the machine's login the options stay as given, so today's calls are byte for byte today's. */
// base: what the env replaces. The local execFile replaces the whole env, so it gets the daemon's under the selection's; another machine
// (a WSL distro) forwards each key by name and refuses PATH and names like ProgramFiles(x86), so it gets the selection's alone
export function withGhEnv(exec: MachineExec, ghEnv: GhEnv, base: NodeJS.ProcessEnv = process.env): MachineExec {
  return async (file, args, opts) => {
    if (file !== 'gh' || opts?.env !== undefined) return exec(file, args, opts);
    const env = await ghEnv();
    if (Object.keys(env).length === 0) return exec(file, args, opts);
    return exec(file, args, { ...opts, env: { ...base, ...env } });
  };
}

/** The machine with its exec through withGhEnv (#961); everything else of it as it was. */
export const withGhMachine = <M extends Pick<Machine, 'exec'> & Partial<Pick<Machine, 'id'>>>(machine: M, ghEnv: GhEnv): M =>
  ({ ...machine, exec: withGhEnv(machine.exec, ghEnv, machine.id === undefined || machine.id === LOCAL_MACHINE ? process.env : {}) });

/** The registry with every machine it hands out gh-aware (#961), each wrapped once: a machine keeps one identity (distro-home.ts keys a WeakMap by it). */
export function ghMachines(machines: Machines, ghEnv: GhEnv): Machines {
  const wrapped = new WeakMap<Machine, Machine>();
  const wrap = (machine: Machine): Machine => {
    const known = wrapped.get(machine) ?? withGhMachine(machine, ghEnv);
    wrapped.set(machine, known);
    return known;
  };
  return { local: wrap(machines.local), for: (activity) => wrap(machines.for(activity)) };
}
