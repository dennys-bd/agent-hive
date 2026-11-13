import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix, type PlatformPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineWords, type SemaphoresConfig } from './command-semaphores.js';
import { shellQuote } from './shell-init.js';
import { BIN_MODE } from './shim.js';

// The command shims (#800): one template, assets/bin/command-shim, rendered per first word of a line with a Command Semaphore into
// <home>/command-shims/<word>, first on every pty's PATH, as the agents' shims are rendered into <home>/bin (#696).

export const COMMAND_SHIMS_DIR = 'command-shims'; // <home>/command-shims: first on every pty's PATH
// <home>/command-shims-env/<ptyId>.sh: the line a run's Claude Code Bash tool sources (CLAUDE_ENV_FILE). Under the home, never a shared
// /tmp whose parent another account could own; beside the shims, never among them, since that folder is on PATH and the install deletes
// every file of it that is no shim
export const COMMAND_SHIMS_ENV_DIR = 'command-shims-env';
const COMMAND = '__HIVE_COMMAND__';
const SHIM_MODE = 0o755;

/** `assets/bin/command-shim` in the Hive's own checkout, resolved from dist/src/ as shimSource is. */
export const commandShimSource = (): string => fileURLToPath(new URL('../../assets/bin/command-shim', import.meta.url));

/** The shim as written for `word`: quoted, since a first word lineWords takes can still hold a # or a ! (it never holds a quote). */
export const renderCommandShim = (template: string, word: string): string => template.replaceAll(COMMAND, () => shellQuote(word));

export const commandShimDir = (home: string): string => join(home, COMMAND_SHIMS_DIR);

/** A run's command-shims.sh, derived from the shims' folder <home>/command-shims; `path` is the run's platform's. */
export const commandShimsEnvFile = (commandShims: string, ptyId: string, path: PlatformPath = posix): string =>
  path.join(path.dirname(commandShims), COMMAND_SHIMS_ENV_DIR, `${ptyId}.sh`);

// A path is never looked up on PATH, so no shim could catch it; . and .. would name the folder itself or the home
const isShimmable = (word: string): boolean => !word.includes('/') && word !== '.' && word !== '..';

/** Decision 2: the distinct first words of every line with a semaphore, in any workspace: the folder is the Hive's, one for all of them;
 * the match per workspace stays the daemon's. */
export function shimWords(config: Pick<SemaphoresConfig, 'comb'>): string[] {
  const words = config.comb.commands.flatMap((c) => c.impls).flatMap((impl) => {
    const first = impl.semaphore === undefined ? undefined : lineWords(impl.command)?.[0];
    return first !== undefined && isShimmable(first) ? [first] : [];
  });
  return [...new Set(words)];
}

/** Decisions 1, 3: every word's shim written, then every other file of the folder deleted, so a line removed and saved takes its shim
 * with it when no other line needs that word. A tmp file renamed over the shim: a shim running a command keeps the file it is reading.
 * Answers the words. None on win32: Windows has no command shim until node 5 of #704, and its join reads \ and : in a word. */
export async function installCommandShims(home: string, config: Pick<SemaphoresConfig, 'comb'>, platform: NodeJS.Platform): Promise<string[]> {
  if (platform === 'win32') return [];
  const dir = commandShimDir(home);
  await mkdir(dir, { recursive: true, mode: BIN_MODE });
  const template = await readFile(commandShimSource(), 'utf8');
  const words = shimWords(config);
  for (const word of words) {
    const tmp = join(dir, `.${word}.new`);
    await writeFile(tmp, renderCommandShim(template, word), { mode: SHIM_MODE });
    await chmod(tmp, SHIM_MODE); // writeFile's mode applies only to a new file
    await rename(tmp, join(dir, word));
  }
  const stale = (await readdir(dir)).filter((name) => !words.includes(name));
  await Promise.all(stale.map((name) => rm(join(dir, name), { recursive: true, force: true })));
  return words;
}

/** Decision 16: the one line of a run's command-shims.sh, which Claude Code's Bash tool sources before each command. */
export const claudeEnvLine = (dir: string): string => `PATH=${shellQuote(dir)}:$PATH; export PATH\n`;
