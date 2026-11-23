// The run env seam (#953): the one place a run's account env is composed, at every spawn, before anything is spawned, for a pty run and a
// headless run alike. It asks the run's agent's runner (AgentRunner.accountEnv); #961 adds the GitHub provider under it. A provider that
// cannot give the account throws AccountError, which every start path turns into a refusal. Also the accounts each pty's run resolved, kept
// for the run's life, so a worker's report is attributed to the account its run started on.
import { AccountError } from './account-error.js';
import { runners } from './agents/registry.js';
import type { GhToken } from './github-token.js';
import type { AccountProvider, AccountsConfig, AgentId, Credentials } from './types.js';

export { AccountError, type AccountCode } from './account-error.js'; // #962: moved; every caller still imports it from here

/** The one line a refusal becomes wherever it leaves the process (#953): provider and code, never the reason, which is free-form text a
 * provider could let a token into. The reason stays in the process. */
export const refusalLine = (err: AccountError): string => `account ${err.provider} ${err.code}`;

export const ACCOUNT_UNAVAILABLE = 'account unavailable';

/** The shim's refusal line for whatever the seam threw: an AccountError's own line, any other error a fixed one, never its message. */
export const seamRefusalLine = (err: unknown): string => (err instanceof AccountError ? refusalLine(err) : ACCOUNT_UNAVAILABLE);

/** What each provider resolved to for one run; a member absent = the machine's login. Names only, never a token. */
export type RunAccounts = AccountsConfig;
// machineGithub: gh's login and token (#962), Copilot's account when nothing is selected; the GitHub account's machine (server.ts)
export interface AccountEnvDeps { accounts: AccountsConfig; credentials(): Promise<Credentials>; machineGithub: Pick<GhToken, 'login' | 'token'> }
export interface AccountEnvAnswer { env: Record<string, string>; accounts: RunAccounts }
/** The seam bound to the live selection and store (server.ts): what a start path calls. */
export type AccountSeam = (run: { agent?: AgentId }) => Promise<AccountEnvAnswer>;

// Which provider an agent's account is (#950: Codex has none). One table, no runner field
const AGENT_PROVIDER: Record<AgentId, AccountProvider | undefined> = { claude: 'claude', copilot: 'copilot', codex: undefined };

/** One run's account env and the accounts it names. No agent (a terminal): nothing yet, #961's GitHub provider comes here. */
export async function accountEnv(run: { agent?: AgentId }, deps: AccountEnvDeps): Promise<AccountEnvAnswer> {
  if (run.agent === undefined) return { env: {}, accounts: {} };
  const provider = AGENT_PROVIDER[run.agent];
  const selected = provider === undefined ? undefined : deps.accounts[provider];
  const answer = await runners[run.agent].accountEnv({ ...(selected === undefined ? {} : { selected }), credentials: deps.credentials, machineGithub: deps.machineGithub });
  return { env: answer.env, accounts: provider === undefined || answer.account === undefined ? {} : { [provider]: answer.account } };
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
