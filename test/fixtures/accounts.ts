import type { TestContext } from 'node:test';
import type { AccountEnvDeps } from '../../src/account-env.js';
import { runners } from '../../src/agents/registry.js';

/** gh with no login (#962): Copilot's check refuses it as copilot/missing before anything is fetched. */
export const LOGGED_OUT: AccountEnvDeps['machineGithub'] = { login: async () => '', token: async () => { throw new Error('gh has no login'); } };

/** No account selected, an empty credential store and gh logged out (#953, #962): every run on the machine's login. */
export const NO_ACCOUNTS: AccountEnvDeps = { accounts: {}, credentials: async () => ({}), machineGithub: LOGGED_OUT };

/** A Copilot run on the machine's login with no check (#962), for a test about something else: it must reach neither gh nor GitHub. */
export function copilotOnMachine(t: TestContext): void {
  t.mock.method(runners.copilot, 'accountEnv', async () => ({ env: {} }));
}
