// The run env seam (#953): the one place a run's account env is composed, at every spawn, before anything is spawned, for a pty run and a
// headless run alike. The GitHub provider (#961) answers for every run; the run's agent's runner (AgentRunner.accountEnv) is asked over it. A provider that
// cannot give the account throws AccountError, which every start path turns into a refusal. Also the accounts each pty's run resolved, kept
// for the run's life, so a worker's report is attributed to the account its run started on.
import { runners } from './agents/registry.js';
import type { AccountProvider, AccountsConfig, AgentId, Credentials } from './types.js';

export type AccountCode = 'missing' | 'mismatch' | 'unreachable';

/** A provider's refusal (#953). Its message is safe to log and to show raw: it names the provider, the code and a reason, never a token. */
export class AccountError extends Error {
  readonly provider: AccountProvider;
  readonly code: AccountCode;
  constructor(provider: AccountProvider, code: AccountCode, reason?: string) {
    super(`account ${provider} ${code}${reason === undefined ? '' : `: ${reason}`}`);
    this.name = 'AccountError';
    this.provider = provider;
    this.code = code;
  }
}

/** The one line a refusal becomes wherever it leaves the process (#953): provider and code, never the reason, which is free-form text a
 * provider could let a token into. The reason stays in the process. */
export const refusalLine = (err: AccountError): string => `account ${err.provider} ${err.code}`;

export const ACCOUNT_UNAVAILABLE = 'account unavailable';

/** The shim's refusal line for whatever the seam threw: an AccountError's own line, any other error a fixed one, never its message. */
export const seamRefusalLine = (err: unknown): string => (err instanceof AccountError ? refusalLine(err) : ACCOUNT_UNAVAILABLE);

/** What each provider resolved to for one run; a member absent = the machine's login. Names only, never a token. */
export type RunAccounts = AccountsConfig;
export interface AccountEnvDeps { accounts: AccountsConfig; credentials(): Promise<Credentials> }
export interface AccountEnvAnswer { env: Record<string, string>; accounts: RunAccounts }
/** The seam bound to the live selection and store (server.ts): what a start path calls. */
export type AccountSeam = (run: { agent?: AgentId }) => Promise<AccountEnvAnswer>;

// Which provider an agent's account is (#950: Codex has none). One table, no runner field
const AGENT_PROVIDER: Record<AgentId, AccountProvider | undefined> = { claude: 'claude', copilot: 'copilot', codex: undefined };

// The GitHub provider (#961): only accounts.github selects. Absent is the machine's login, nothing set, whatever auth.github and the store say
async function githubEnv(deps: AccountEnvDeps): Promise<AccountEnvAnswer> {
  const login = deps.accounts.github;
  if (login === undefined) return { env: {}, accounts: {} };
  const logins = (await deps.credentials()).github ?? {};
  if (!Object.hasOwn(logins, login)) throw new AccountError('github', 'missing', `no stored token for the login ${login}`); // never a silent fall back to the machine's login
  return { env: { GH_TOKEN: logins[login].token }, accounts: { github: login } };
}

/** One run's account env and the accounts it names: the GitHub provider's for every run, then the agent's laid over it (the more specific one). */
export async function accountEnv(run: { agent?: AgentId }, deps: AccountEnvDeps): Promise<AccountEnvAnswer> {
  const github = await githubEnv(deps);
  if (run.agent === undefined) return github;
  const provider = AGENT_PROVIDER[run.agent];
  const selected = provider === undefined ? undefined : deps.accounts[provider];
  const answer = await runners[run.agent].accountEnv({ ...(selected === undefined ? {} : { selected }), credentials: deps.credentials });
  const agentAccounts = provider === undefined || answer.account === undefined ? {} : { [provider]: answer.account };
  return { env: { ...github.env, ...answer.env }, accounts: { ...github.accounts, ...agentAccounts } };
}

export interface RunAccountsStore { set(ptyId: string, accounts: RunAccounts): void; get(ptyId: string): RunAccounts | undefined; drop(ptyId: string): void }

/** The accounts of every live pty (#953), process state: a worker dies with the daemon (pty-host.ts), so no pty outlives it. */
export function createRunAccounts(): RunAccountsStore {
  const byPty = new Map<string, RunAccounts>();
  return { set: (ptyId, accounts) => void byPty.set(ptyId, accounts), get: (ptyId) => byPty.get(ptyId), drop: (ptyId) => void byPty.delete(ptyId) };
}

/** A pty run's env (#953): the seam resolved, its accounts kept under the pty, the workspace's env laid over the account's so it wins. */
export async function ptyAccountEnv(deps: { accountEnv: AccountSeam; runAccounts: Pick<RunAccountsStore, 'set'> }, ptyId: string, agent: AgentId | undefined, workspaceEnv: Record<string, string>): Promise<Record<string, string>> {
  const account = await deps.accountEnv(agent === undefined ? {} : { agent });
  deps.runAccounts.set(ptyId, account.accounts);
  return { ...account.env, ...workspaceEnv };
}

/** The account a worker's report is attributed to (#953): its run's, for its agent's provider; undefined for the machine's login, Codex or a
 * pty with no entry. */
export function reportedAccount(store: Pick<RunAccountsStore, 'get'>, ptyId: string, agent: AgentId): string | undefined {
  const provider = AGENT_PROVIDER[agent];
  return provider === undefined ? undefined : store.get(ptyId)?.[provider];
}
