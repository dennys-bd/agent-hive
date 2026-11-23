// The GitHub account (#959, node 3.1 of #958): which login the Hive's own reads run as, and the token each stored login has.
import { readCredentials } from './credentials.js';
import type { Credentials } from './types.js';

export const NO_TOKEN_MESSAGE = 'no GitHub token: run `hive login` or connect in settings';
const SEVERAL_MESSAGE = 'several GitHub logins are stored: choose one in "accounts.github"';
const NONE = ''; // no login: accessFor answers undefined, as today
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
