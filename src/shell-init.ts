import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js';
import { BIN_MODE, shimPath } from './shim.js';
import { AGENT_IDS } from './types.js';

// The terminals' init files (#259): ptyCommand starts zsh, bash and fish on these. They run the user's own rc files, then define one function
// per agent calling its shim. A function wins over every PATH entry, so a folder the user's rc files put before <home>/bin (or mise, direnv
// and asdf at each prompt) cannot hide the shim. Rendered on every boot from assets/shell/, as the shims are.

const SHELL_DIR = 'shell'; // <home>/shell: HIVE_SHELL_DIR in every plain terminal's env
const FUNCTIONS = '__HIVE_FUNCTIONS__';

/** Every template, by its path under assets/shell/ and under <home>/shell/: a fixed list, so nothing hangs on readdir's order. */
export const SHELL_INIT_FILES = ['zsh/.zshenv', 'zsh/.zprofile', 'zsh/.zshrc', 'zsh/.zlogin', 'bash/rc', 'fish/init.fish'] as const;

/** An agent's function: its command names it, its shim's path is what it runs. */
export interface ShellShim { command: string; path: string }

export const shellInitDir = (home: string): string => join(home, SHELL_DIR);

// assets/shell in the Hive's own checkout, resolved from dist/src/ as shimSource is
const shellInitSource = (): string => fileURLToPath(new URL('../../assets/shell', import.meta.url));

/** A word sh, bash and zsh read literally. Here, not in spawn.ts: hooks-settings imports this file, and spawn.ts imports the runners, which
 * import hooks-settings. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A word fish reads literally: its single quotes take \' and \\ as their only escapes. */
export const fishQuote = (s: string): string => `'${s.replace(/[\\']/g, '\\$&')}'`;

// `function name { … }`, not `name() { … }`: an alias of the same name would be expanded inside the latter's definition and break it. The
// command is an AGENTS constant, bare as in ptyCommand; the path is the home's, quoted.
const functionLine = (file: string, { command, path }: ShellShim): string =>
  (file.startsWith('fish/') ? `function ${command}; ${fishQuote(path)} $argv; end` : `function ${command} { ${shellQuote(path)} "$@"; }`);

/** `template` as written to `file`: its placeholder replaced by one function per shim, in that file's shell. A replacer function, so a `$&` or
 * `$'` in a home path is never read as a replacement pattern. */
export const renderShellInit = (template: string, file: string, shims: readonly ShellShim[]): string =>
  template.replaceAll(FUNCTIONS, () => shims.map((shim) => functionLine(file, shim)).join('\n'));

/** Writes <home>/shell/ from assets/shell/, with a function for every agent of AGENTS, found or not: a missing CLI's shim answers as the shell
 * would (127). Folders get the shim folder's mode. Answers <home>/shell. */
export async function installShellInit(home: string): Promise<string> {
  const shims = AGENT_IDS.map((id) => ({ command: AGENTS[id].command, path: shimPath(home, AGENTS[id]) }));
  const dir = shellInitDir(home);
  for (const file of SHELL_INIT_FILES) {
    const target = join(dir, file);
    await mkdir(dirname(target), { recursive: true, mode: BIN_MODE });
    await writeFile(target, renderShellInit(await readFile(join(shellInitSource(), file), 'utf8'), file, shims));
  }
  return dir;
}
