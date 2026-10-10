import { homeLog } from './home-log.js';
import type { Logger } from './log.js';
import { loginToGithub } from './sources/github-auth.js';

const PROVIDER = 'github'; // the only one today; the positional argument is what the next providers extend
const OK = 0;
const FAILED = 1;
const USAGE = 2;

/** `hive login [github]`: prints the URL and the code, waits for the authorization, prints the account. Resolves with the exit code. */
export async function runLogin(provider: string = PROVIDER, log: Pick<Logger, 'error'> = homeLog()): Promise<number> {
  if (provider !== PROVIDER) {
    log.error(`hive login: unknown provider "${provider}" (only: ${PROVIDER})`);
    return USAGE;
  }
  try {
    const login = await loginToGithub(({ userCode, verificationUri }) => {
      console.log(`open ${verificationUri} and enter the code: ${userCode}`);
    });
    console.log(`connected as @${login}`);
    return OK;
  } catch (err) {
    log.error((err as Error).message);
    return FAILED;
  }
}
