// How to run a command by name (#632). On win32 execFile and spawn never get a bare name: a shim is a .cmd that Node refuses without a
// shell, and an agent's native installer leaves its .exe off PATH. The platform and the lookups are parameters, so every win32 branch is
// tested with node --test on any OS. Looked up on every call, never cached: an agent installed while the Hive runs is found.
import { statSync } from 'node:fs';
import path from 'node:path';

export interface ExecLookup {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Folders searched before PATH: an agent's install folder, Git's usr\bin. */
  readonly dirs?: readonly string[];
  readonly isFile?: (file: string) => boolean;
}

export interface ExecCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
// cmd.exe expands %…% even inside quotes and ends the line at a break; no quoting carries them, so the runner refuses them
const UNSAFE_FOR_CMD = /[%\r\n\0]/;

const isRegularFile = (file: string): boolean => {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
};

// Windows' env names are case-insensitive: a child of PowerShell has Path, not PATH
const envValue = (env: NodeJS.ProcessEnv, key: string): string | undefined =>
  Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1];

// A PATH folder may be in quotes (C:\"Program Files"\… is legal there); Windows strips them
const split = (list: string): string[] => list.split(';').map((item) => item.replaceAll('"', '')).filter((item) => item !== '');

// Only what CreateProcess or the .cmd runner can start: PATHEXT also lists .VBS or .JS, which execFile cannot run
const RUNNABLE = new Set(['.com', '.exe', '.bat', '.cmd']);

// The files a win32 name may be: as given when its extension is runnable (go.exe), then with each runnable one of PATHEXT
function namesOf(name: string, env: NodeJS.ProcessEnv): string[] {
  const exts = split(envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).map((ext) => ext.toLowerCase()).filter((ext) => RUNNABLE.has(ext));
  const withExts = exts.map((ext) => name + ext);
  return RUNNABLE.has(path.win32.extname(name).toLowerCase()) ? [name, ...withExts] : withExts;
}

/** The full path `name` resolves to on win32: an absolute name as it is, else the caller's folders, then PATH × PATHEXT. On darwin and
 *  linux, the name itself: execvp searches PATH there. */
export function findExec(name: string, lookup: ExecLookup): string | undefined {
  if (lookup.platform !== 'win32') return name;
  const isFile = lookup.isFile ?? isRegularFile;
  const dirs = path.win32.isAbsolute(name) ? [''] : [...(lookup.dirs ?? []), ...split(envValue(lookup.env, 'PATH') ?? '')];
  for (const dir of dirs) {
    const found = namesOf(path.win32.join(dir, name), lookup.env).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

// One argument as the C runtime reads it back: in quotes, a quote doubled, the backslashes before a quote or the end doubled. Inside the
// quotes cmd.exe leaves & | < > ^ alone, and a doubled quote never leaves them.
const quoteArg = (arg: string): string => `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, '$1$1')}"`;

/** The .cmd runner, the repository's fifth deliberate shell string (CLAUDE.md): cmd.exe runs the batch file with every argument quoted
 *  here and nowhere else. /d skips AutoRun, /s keeps the line's own quotes, /v:off leaves ! alone. */
function cmdRunner(file: string, args: readonly string[], env: NodeJS.ProcessEnv): ExecCommand {
  const unsafe = [file, ...args].find((arg) => UNSAFE_FOR_CMD.test(arg));
  if (unsafe !== undefined) throw new Error(`${path.win32.basename(file)}: cmd.exe cannot pass an argument with %, a line break or NUL (${JSON.stringify(unsafe)})`);
  const comspec = envValue(env, 'COMSPEC') ?? path.win32.join(envValue(env, 'SYSTEMROOT') ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const line = [file, ...args].map(quoteArg).join(' ');
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true };
}

/** What execFile or spawn gets for `name` and `args`: on darwin and linux both unchanged; on win32 the full path of an .exe, or cmd.exe
 *  running a .cmd or .bat. A name found nowhere is an error that names it. */
export function resolveExec(name: string, args: readonly string[], lookup: ExecLookup): ExecCommand {
  if (lookup.platform !== 'win32') return { file: name, args, windowsVerbatimArguments: false };
  const file = findExec(name, lookup);
  if (file === undefined) throw new Error(`${name} was not found`);
  const ext = path.win32.extname(file).toLowerCase();
  return ext === '.cmd' || ext === '.bat' ? cmdRunner(file, args, lookup.env) : { file, args, windowsVerbatimArguments: false };
}
