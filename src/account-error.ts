// A provider's refusal (#953), in a module of its own (#962): a runner's account module throws it, and account-env.ts imports the runners'
// registry. Importing it from there, a runner loaded first in a fresh process (copilot.ts in its own tests) would close a cycle through the
// registry, which reads every runner before that one exists. This module imports types only.
import type { AccountProvider } from './types.js';

export type AccountCode = 'missing' | 'mismatch' | 'unreachable';

/** Its message is safe to log and to show raw: it names the provider, the code and a reason, never a token. `reason` is the same fixed
 * text, for a reader that maps it (copilot-limits.ts); refusalLine never carries it out of the process. */
export class AccountError extends Error {
  readonly provider: AccountProvider | 'gitlab'; // #1049: GitLab is no agent's provider, so it is no AccountProvider
  readonly code: AccountCode;
  readonly reason: string | undefined;
  constructor(provider: AccountProvider | 'gitlab', code: AccountCode, reason?: string) {
    super(`account ${provider} ${code}${reason === undefined ? '' : `: ${reason}`}`);
    this.name = 'AccountError';
    this.provider = provider;
    this.code = code;
    this.reason = reason;
  }
}
