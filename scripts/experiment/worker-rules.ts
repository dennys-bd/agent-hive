import { isAbsolute } from 'node:path';
import { PLUGIN_DIR } from '../../src/hooks-settings.js';
import { DAEMON_OUT } from './daemon-runner.js';

export interface RunPaths { state: string; home: string }
export interface RunRules { allow: string[]; deny: string[] }

const ALLOW_FLAG = '--allowedTools';
const DENY_FLAG = '--disallowedTools';
// A space or comma would split the flag's list; a glob character would turn the literal path into a pattern
const UNSAFE = /[\s,()*?[\]!#\\]/;
// What a Hive home holds besides plugin/ (src/home.ts and the stores): read through any home, the other arm's above all, a worker would
// learn a daemon's secret and port, the other arm's stage commands, or the experiment's name. plugin/ is the same copy in every home
const HOME_FILES = ['hive.*', '*.json', DAEMON_OUT, 'prompts/**', 'protocol/**', 'reviews/**', 'pr-reviews/**'];

const checked = (value: string, what: string): string => {
  if (UNSAFE.test(value)) throw new Error(`a permission rule cannot hold this ${what}: ${value}`);
  return value;
};

/** `//abs/path`: a single leading slash in a Read rule anchors at the settings source, not at the filesystem root. */
function rooted(path: string): string {
  if (!isAbsolute(path)) throw new Error(`a permission rule needs an absolute path: ${path}`);
  return `/${checked(path, 'path')}`;
}

/** What one run adds to the seed's lists. The push is the Merge prompt's own, exact: an allow can never carve an exception out of a
 *  deny, so the seed denies every other push form and none of its denies matches this one. Read rules also bind Glob and Grep. */
export function runRules(runBranch: string, { state, home }: RunPaths): RunRules {
  const homes = `${rooted(state)}/homes/*`;
  return {
    // Its own branch only, as a worker writes the push: with a trailing redirect or pipe, or naming the merge commit by its sha; the seed's
    // denials still refuse an option, a forced refspec or main, and the sandbox keeps any push on the local origin
    allow: [`Bash(git push origin HEAD:${checked(runBranch, 'branch')}*)`, `Bash(git push origin *:${runBranch}*)`, `Read(${rooted(home)}/${PLUGIN_DIR}/**)`],
    deny: [`Read(${rooted(state)}/experiments/**)`, ...HOME_FILES.map((file) => `Read(${homes}/${file})`)],
  };
}

function withRules(args: readonly string[], flag: string, rules: readonly string[]): string[] {
  const at = args.indexOf(flag);
  if (at === -1 || at + 1 >= args.length) return [...args, flag, rules.join(' ')];
  return args.map((arg, i) => (i === at + 1 ? [arg, ...rules].join(' ') : arg));
}

/** The seed's claudeArgs with the run's rules joined to its two lists. */
export function runClaudeArgs(claudeArgs: readonly string[], runBranch: string, paths: RunPaths): string[] {
  const rules = runRules(runBranch, paths);
  return withRules(withRules(claudeArgs, ALLOW_FLAG, rules.allow), DENY_FLAG, rules.deny);
}
