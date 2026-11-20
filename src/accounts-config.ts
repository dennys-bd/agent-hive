// The `accounts` key of hive.config.json (#952), out of config.ts, which is over 400 lines. Required, no default: a missing or bad value names
// its key and what it accepts. The problem comes back as a sentence; config.ts adds the file's name.
import { readCredentials } from './credentials.js';
import type { Refusal } from './server-tasks.js';
import { ACCOUNT_PROVIDERS, type AccountProvider, type AccountsConfig } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const HTTP_BAD_REQUEST = 400;
const NO_CLAUDE_ACCOUNT = '"accounts.claude" names no saved Claude account';
const PROVIDERS = ACCOUNT_PROVIDERS.join(', ');

/** The parsed key, or the first problem as a sentence without the file's name. A name is kept as written: it is a map key elsewhere. */
export function parseAccounts(raw: unknown): AccountsConfig | string {
  if (!isRecord(raw)) return `"accounts" is required and must be an object with any of ${PROVIDERS}`;
  // an unknown member is refused, never dropped: a typo would otherwise select the machine's login in silence
  const unknown = Object.keys(raw).find((key) => !ACCOUNT_PROVIDERS.includes(key as AccountProvider));
  if (unknown !== undefined) return `"accounts.${unknown}" is not an account provider; one of: ${PROVIDERS}`;
  const empty = Object.entries(raw).find(([, name]) => typeof name !== 'string' || name.trim() === '');
  if (empty !== undefined) return `"accounts.${empty[0]}" must be a non-empty name`;
  return { ...raw } as AccountsConfig;
}

/** Why a save cannot take its Claude account (#952): the store has no credential by that name (400). Checked only when the body carries a
 * Claude name, so an unrelated save never fails on a selection made earlier, and never on boot: a token removed after the save is the run
 * seam's to refuse (#953). The message names the key, never the token. */
export async function accountsRefusal(accounts: AccountsConfig | undefined, env?: NodeJS.ProcessEnv): Promise<Refusal | undefined> {
  const name = accounts?.claude;
  if (name === undefined) return undefined;
  const { claude } = await readCredentials(env);
  return claude !== undefined && Object.hasOwn(claude, name) ? undefined : { status: HTTP_BAD_REQUEST, message: NO_CLAUDE_ACCOUNT };
}
