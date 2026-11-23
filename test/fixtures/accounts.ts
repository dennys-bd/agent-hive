import type { AccountEnvDeps } from '../../src/account-env.js';

/** No account selected and an empty credential store (#953): every run on the machine's login. */
export const NO_ACCOUNTS: AccountEnvDeps = { accounts: {}, credentials: async () => ({}) };
