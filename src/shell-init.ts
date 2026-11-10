import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents.js';
import { pwshQuote } from './pwsh-quote.js';
import { BIN_MODE, shimDir, shimPath, type ShimInstall } from './shim.js';
import { AGENT_IDS } from './types.js';

// The terminals' init files (#259): ptyCommand starts zsh, bash and fish on these, and PowerShell on pwsh/profile.ps1 (#645). They run the user's own rc files, then define one function
// per agent calling its shim. A function wins over every PATH entry, so a folder the user's rc files put before <home>/bin (or mise, direnv
// and asdf at each prompt) cannot hide the shim. Rendered on every boot from assets/shell/, as the shims are.

const SHELL_DIR = 'shell'; // <home>/shell: HIVE_SHELL_DIR in every plain terminal's env
const FUNCTIONS = '__HIVE_FUNCTIONS__';
const BIN = '__HIVE_BIN__'; // the profile's PATH fix (#645): the shim folder, pwshQuoted

/** Every template, by its path under assets/shell/ and under <home>/shell/: a fixed list, so nothing hangs on readdir's order. */
export const SHELL_INIT_FILES = ['zsh/.zshenv', 'zsh/.zprofile', 'zsh/.zshrc', 'zsh/.zlogin', 'bash/rc', 'fish/init.fish', 'pwsh/profile.ps1'] as const;

/** An agent's function: its command names it, its shim's path is what it runs. */
export interface ShellShim { command: string; path: string }

/** What the profile renders besides the shims (#645): Git's sh.exe, which its functions run each shim under, and the shim folder. */
export interface ShellInitPaths { sh: string; bin: string }

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
// command is an AGENTS constant, bare as in ptyCommand; the paths are the home's, quoted. PowerShell's runs the POSIX shim under sh.exe
// (#645): cmd.exe would expand a % and re-quote the arguments, and the one shim script is what registers the session. An alias of the
// same name from the user's profile beats a function in PowerShell, so it is removed first.
function functionLine(file: string, { command, path }: ShellShim, sh: string): string {
  if (file.startsWith('fish/')) return `function ${command}; ${fishQuote(path)} $argv; end`;
  if (file.startsWith('pwsh/')) return `Remove-Item -LiteralPath Alias:${command} -Force -ErrorAction SilentlyContinue; function ${command} { & ${pwshQuote(sh)} ${pwshQuote(path)} @args }`;
  return `function ${command} { ${shellQuote(path)} "$@"; }`;
}

/** `template` as written to `file`: its placeholders replaced by the shim folder and by one function per shim, in that file's shell.
 * Replacer functions, so a `$&` or `$'` in a home path is never read as a replacement pattern. */
export const renderShellInit = (template: string, file: string, shims: readonly ShellShim[], paths: ShellInitPaths): string =>
  template.replaceAll(BIN, () => pwshQuote(paths.bin)).replaceAll(FUNCTIONS, () => shims.map((shim) => functionLine(file, shim, paths.sh)).join('\n'));

/** Writes <home>/shell/ from assets/shell/, with a function for every agent of AGENTS, found or not: a missing CLI's shim answers as the shell
 * would (127). The profile is written on every OS (#645), as one fixed list with no platform branch. Folders get the shim folder's mode.
 * Answers <home>/shell. */
export async function installShellInit(home: string, { sh }: ShimInstall): Promise<string> {
  const shims = AGENT_IDS.map((id) => ({ command: AGENTS[id].command, path: shimPath(home, AGENTS[id]) }));
  const paths = { sh, bin: shimDir(home) };
  const dir = shellInitDir(home);
  for (const file of SHELL_INIT_FILES) {
    const target = join(dir, file);
    await mkdir(dirname(target), { recursive: true, mode: BIN_MODE });
    await writeFile(target, renderShellInit(await readFile(join(shellInitSource(), file), 'utf8'), file, shims, paths));
  }
  return dir;
}
