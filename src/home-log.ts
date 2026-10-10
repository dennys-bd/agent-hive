import { homedir } from 'node:os';
import { hiveHome } from './home.js';
import { createLogger, type Logger } from './log.js';

// What a process beside the daemon errors to (#742): the Electron main process, run.ts around its boot, hive login. Their console.error reached
// only a terminal that is usually not there.
const STDERR_ONLY: Pick<Logger, 'error'> = {
  error: (message) => {
    process.stderr.write(`${message}\n`);
  },
};

const URL_TEXT = /https?:\/\/\S+/g;
// What follows the home in a path, spaces included (macOS's Application Support): up to a quote, a colon or the end of the line
const UNDER_HOME = /^[^'"`:,;()\n]*/;
const ABSOLUTE_PATH = /(?<![\w.-])~?\/[^\s'"`:,;()]+/g; // a path from the root or the home; a relative one (dist/src/run.js) names no machine

/** An error text as hive.log may keep it (#742): every link and absolute or home path masked, since an fs or an Electron error names the
 * home's files. */
export const maskPaths = (message: string, home: string = homedir()): string =>
  message.replace(URL_TEXT, '<url>').split(home).map((part, i) => (i === 0 ? part : part.replace(UNDER_HOME, '<path>'))).join('').replace(ABSOLUTE_PATH, '<path>');

/** hive.log in the home, opened on the first error (#742), each message through maskPaths; a home that cannot be resolved (a relative
 * HIVE_HOME throws, #310) leaves stderr alone, as before. Never throws. */
export function homeLog(home: () => string = hiveHome): Pick<Logger, 'error'> {
  let log: Pick<Logger, 'error'> | undefined;
  const open = (): Pick<Logger, 'error'> => {
    try {
      return createLogger(home());
    } catch {
      return STDERR_ONLY;
    }
  };
  return {
    error: (message) => {
      log ??= open();
      log.error(maskPaths(message));
    },
  };
}
