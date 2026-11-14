import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, posix, type PlatformPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineWords, type SemaphoresConfig } from './command-semaphores.js';
import { shellQuote } from './shell-init.js';
import { BIN_MODE, type ShimInstall } from './shim.js';
import type { Language } from './types.js';

// The command shims (#800): one template, assets/bin/command-shim, rendered per first word of a line with a Command Semaphore into
// <home>/command-shims/<word>, first on every pty's PATH, as the agents' shims are rendered into <home>/bin (#696).

export const COMMAND_SHIMS_DIR = 'command-shims'; // <home>/command-shims: first on every pty's PATH
// <home>/command-shims-env/<ptyId>.sh: the line a run's Claude Code Bash tool sources (CLAUDE_ENV_FILE). Under the home, never a shared
// /tmp whose parent another account could own; beside the shims, never among them, since that folder is on PATH and the install deletes
// every file of it that is no shim
export const COMMAND_SHIMS_ENV_DIR = 'command-shims-env';
// One pass over every placeholder (#801, #806), so a word holding another's text stays whole
const PLACEHOLDER = /__HIVE_(COMMAND|LANGUAGE|PLATFORM)__/g;
const SHIM_MODE = 0o755;

/** `assets/bin/command-shim` in the Hive's own checkout, resolved from dist/src/ as shimSource is. */
export const commandShimSource = (): string => fileURLToPath(new URL('../../assets/bin/command-shim', import.meta.url));

/** The shim as written for `word`: quoted, since a first word lineWords takes can still hold a # or a ! (it never holds a quote). `platform`
 * is the Hive's (#806 decision 2): the script's win32 branches read it, so a test on any OS renders and runs the win32 shim. */
export function renderCommandShim(template: string, word: string, language: Language, platform: NodeJS.Platform): string {
  const values = { COMMAND: word, LANGUAGE: language, PLATFORM: platform };
  return template.replace(PLACEHOLDER, (_match, key: keyof typeof values) => shellQuote(values[key]));
}

export const commandShimDir = (home: string): string => join(home, COMMAND_SHIMS_DIR);

/** A run's command-shims.sh, derived from the shims' folder <home>/command-shims; `path` is the run's platform's. */
export const commandShimsEnvFile = (commandShims: string, ptyId: string, path: PlatformPath = posix): string =>
  path.join(path.dirname(commandShims), COMMAND_SHIMS_ENV_DIR, `${ptyId}.sh`);

/** `assets/bin/command-shim.cmd`, the shim's twin on win32 (#806), which PowerShell and cmd.exe find through PATHEXT. */
const commandShimCmdSource = (): string => fileURLToPath(new URL('../../assets/bin/command-shim.cmd', import.meta.url));

const CMD_PLACEHOLDER = /__HIVE_(COMMAND|SH)__/g;
/** The twin as written: cmd.exe expands %NAME% while reading a line, even in quotes, so a % in the sh.exe path or in the word is written %%
 * (#645, #806); one pass, so a word holding the other's text stays whole. The template's own %~dp0 and %* stay as they are: the folder
 * as %~dp0, never written whole, since cmd.exe reads a batch file in the OEM code page and a home such as C:\Users\João would not survive. */
export const renderCommandShimCmd = (template: string, word: string, sh: string): string =>
  template.replace(CMD_PLACEHOLDER, (_match, key: string) => (key === 'SH' ? sh : word).replaceAll('%', '%%'));

// What a Windows file name cannot hold (#806 decision 12); lineWords already refuses all but :
const WIN32_UNNAMEABLE = /[\\:<>"|?*]/;
// A device name opens the device, with or without an extension, and a trailing dot or space is dropped from the name Windows writes
const WIN32_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)|[. ]$/i;
// A word with a runnable extension would put the sh text under that extension first on PATH: cmd.exe would read it as a batch file, a
// native caller as a program
const WIN32_RUNNABLE = /\.(com|exe|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msc)$/i; // what cmd.exe, PowerShell or Windows Script Host would run
const isWin32Nameable = (word: string): boolean => ![WIN32_UNNAMEABLE, WIN32_RESERVED, WIN32_RUNNABLE].some((re) => re.test(word));
// A path is never looked up on PATH, so no shim could catch it; . and .. would name the folder itself or the home
const isShimmable = (word: string, platform: NodeJS.Platform): boolean =>
  !word.includes('/') && word !== '.' && word !== '..' && (platform !== 'win32' || isWin32Nameable(word));

// #806 decision 12: Windows' file system does not tell Pnpm from pnpm, and word pnpm's twin pnpm.cmd is word pnpm.cmd's shim: the first
// word keeps both its names, a later one that would reuse either gets no shim
function oneFilePerName(words: readonly string[]): string[] {
  return words.reduce<{ kept: string[]; names: string[] }>((acc, word) => {
    const names = [word, `${word}.cmd`].map((name) => name.toLowerCase());
    return names.some((name) => acc.names.includes(name)) ? acc : { kept: [...acc.kept, word], names: [...acc.names, ...names] };
  }, { kept: [], names: [] }).kept;
}

/** Decision 2 of #800: the distinct first words of every line with a semaphore, in any workspace; on win32 only those a file can be named
 * after, one per name (#806). */
export function shimWords(config: Pick<SemaphoresConfig, 'comb'>, platform: NodeJS.Platform): string[] {
  const words = config.comb.commands.flatMap((c) => c.impls).flatMap((impl) => {
    const first = impl.semaphore === undefined ? undefined : lineWords(impl.command)?.[0];
    return first !== undefined && isShimmable(first, platform) ? [first] : [];
  });
  const distinct = [...new Set(words)];
  return platform === 'win32' ? oneFilePerName(distinct) : distinct;
}

// A tmp file renamed over the shim: off win32 a shim running a command keeps the file it is reading. Windows refuses the rename over a
// file a running sh.exe or cmd.exe holds open; the tmp goes, the old shim stays, and the error comes back for the caller to report
async function writeAtomically(dir: string, name: string, text: string): Promise<Error | undefined> {
  const tmp = join(dir, `.${name}.new`);
  try {
    await writeFile(tmp, text, { mode: SHIM_MODE });
    await chmod(tmp, SHIM_MODE); // writeFile's mode applies only to a new file
    await rename(tmp, join(dir, name));
    return undefined;
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined); // a leftover tmp is swept by the next install
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Decisions 1, 3 of #800 and 1, 13 of #806: every word's shim written, on win32 with its .cmd twin, then every other file of the folder
 * deleted, so a line removed and saved takes its shim with it. Answers the words; a save rewrites them all, so a change of language
 * reaches every shim (#801). */
export async function installCommandShims(home: string, config: Pick<SemaphoresConfig, 'comb'>, language: Language, { platform, sh }: ShimInstall): Promise<string[]> {
  const dir = commandShimDir(home);
  await mkdir(dir, { recursive: true, mode: BIN_MODE });
  const template = await readFile(commandShimSource(), 'utf8');
  const twin = platform === 'win32' ? await readFile(commandShimCmdSource(), 'utf8') : undefined;
  const words = shimWords(config, platform);
  const failed: Error[] = [];
  for (const word of words) {
    const files = [{ name: word, text: renderCommandShim(template, word, language, platform) }];
    if (twin !== undefined) files.push({ name: `${word}.cmd`, text: renderCommandShimCmd(twin, word, sh) });
    for (const { name, text } of files) {
      const err = await writeAtomically(dir, name, text);
      if (err !== undefined) failed.push(err);
    }
  }
  const kept = twin === undefined ? words : words.flatMap((word) => [word, `${word}.cmd`]);
  const stale = (await readdir(dir)).filter((name) => !kept.includes(name));
  // Windows refuses to delete a stale shim a running sh.exe holds open, as it refuses the rename: reported with the rest, never in their place
  const swept = await Promise.allSettled(stale.map((name) => rm(join(dir, name), { recursive: true, force: true })));
  swept.forEach((result) => { if (result.status === 'rejected') failed.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason))); });
  // Every other word is written and the sweep ran: one shim held open never keeps a save from the rest
  if (failed.length > 0) throw new Error(`${failed.length} shim file(s) not replaced or removed, the next save retries: ${failed[0].message}`);
  return words;
}

/** #806 decision 8: a Windows path as MSYS spells it, C:\a\b as /c/a/b: Git's bash reads PATH :-separated, and C: would split there. */
export const msysPath = (path: string): string =>
  path.replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`).replaceAll('\\', '/');

/** #800 decision 16: the one line of a run's command-shims.sh, which Claude Code's Bash tool sources before each command; on win32 that
 * tool is Git's bash, so the folder goes in MSYS's form (#806). */
export const claudeEnvLine = (dir: string, platform: NodeJS.Platform): string =>
  `PATH=${shellQuote(platform === 'win32' ? msysPath(dir) : dir)}:$PATH; export PATH\n`;
