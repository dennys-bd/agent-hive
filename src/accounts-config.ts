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

const noGithubLogin = (key: 'github' | 'copilot'): string => `"accounts.${key}" names no saved GitHub login`;
// own entries only: __proto__ and toString name nothing
const isStored = (map: object, name: string | undefined): boolean => name === undefined || Object.hasOwn(map, name);

/** Why a save cannot take its accounts (#952, #959): the store has no Claude credential, or no GitHub login, by that name (400). Copilot runs
 * on a GitHub login. Checked only when the body carries a name, so an unrelated save never fails on a selection made earlier, and never on
 * boot: a token removed after the save is the run seam's to refuse (#953). The message names the key, never the token. */
export async function accountsRefusal(accounts: AccountsConfig | undefined, env?: NodeJS.ProcessEnv): Promise<Refusal | undefined> {
  const { claude: claudeName, github: githubName, copilot: copilotName } = accounts ?? {};
  if (claudeName === undefined && githubName === undefined && copilotName === undefined) return undefined;
  const { claude = {}, github = {} } = await readCredentials(env);
  const checks: [boolean, string][] = [
    [isStored(claude, claudeName), NO_CLAUDE_ACCOUNT], [isStored(github, githubName), noGithubLogin('github')], [isStored(github, copilotName), noGithubLogin('copilot')],
  ];
  const message = checks.find(([ok]) => !ok)?.[1];
  return message === undefined ? undefined : { status: HTTP_BAD_REQUEST, message };
}
