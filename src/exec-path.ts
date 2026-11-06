// How to run a command by name (#632). On win32 execFile and spawn never get a bare name: a shim is a .cmd that Node refuses without a
// shell, and an agent's native installer leaves its .exe off PATH. The platform and the lookups are parameters, so every win32 branch is
// tested with node --test on any OS. Looked up on every call, never cached: an agent installed while the Hive runs is found. createExec is
// the one place the server's execs resolve names (#633).
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Exec } from './types.js';

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
  /** Set by the .cmd runner only: what the child's env must add, so a bare name inside the batch file never resolves in the cwd. */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
// cmd.exe expands %…% even inside quotes and ends the line at a break; no quoting carries them, so the runner refuses them
const UNSAFE_FOR_CMD = /[%\r\n\0]/;
const NO_CWD_LOOKUP = { NoDefaultCurrentDirectoryInExePath: '1' } as const;

const isRegularFile = (file: string): boolean => {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
};

// Windows' env names are case-insensitive: a child of PowerShell has Path, not PATH
// The last match: in a merged env ({ ...process.env, ...launch }) the later key is the one the spread meant to win
export const envValue = (env: NodeJS.ProcessEnv, key: string): string | undefined =>
  Object.entries(env).filter(([name]) => name.toUpperCase() === key).at(-1)?.[1];

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
  // A relative folder would resolve against the daemon's working directory, which a repository can choose
  const pathDirs = split(envValue(lookup.env, 'PATH') ?? '').filter((dir) => path.win32.isAbsolute(dir));
  const extraDirs = (lookup.dirs ?? []).filter((dir) => path.win32.isAbsolute(dir)); // a relative USERPROFILE, say, from a workspace's env
  const dirs = path.win32.isAbsolute(name) ? [''] : [...extraDirs, ...pathDirs];
  for (const dir of dirs) {
    const found = namesOf(path.win32.join(dir, name), lookup.env).find(isFile);
    if (found !== undefined) return found;
  }
  return undefined;
}

// One argument as the C runtime reads it back: in quotes, a quote doubled, the backslashes before a quote or the end doubled. Inside the
// quotes cmd.exe leaves & | < > ^ alone, and a doubled quote never leaves them.
const quoteArg = (arg: string): string => `"${arg.replace(/(\\*)"/g, '$1$1""').replace(/(\\*)$/, '$1$1')}"`;

// ComSpec only when it is cmd.exe by its full path: the line is quoted for cmd.exe's rules and no other's
function commandProcessor(env: NodeJS.ProcessEnv): string {
  const comspec = envValue(env, 'COMSPEC');
  if (comspec !== undefined && path.win32.isAbsolute(comspec) && path.win32.basename(comspec).toLowerCase() === 'cmd.exe') return comspec;
  const root = envValue(env, 'SYSTEMROOT');
  return path.win32.join(root !== undefined && path.win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', 'cmd.exe');
}

/** The .cmd runner, the repository's fifth deliberate shell string (CLAUDE.md): cmd.exe runs the batch file with every argument quoted
 *  here and nowhere else. /d skips AutoRun, /s keeps the line's own quotes, /v:off leaves ! alone. */
function cmdRunner(file: string, args: readonly string[], env: NodeJS.ProcessEnv): ExecCommand {
  // The position only, never the value: an argument may carry a secret, and the error reaches the log
  const unsafe = [file, ...args].findIndex((arg) => UNSAFE_FOR_CMD.test(arg));
  if (unsafe === 0) throw new Error(`${path.win32.basename(file)}: cmd.exe cannot run a batch file whose path has %`);
  if (unsafe > 0) throw new Error(`${path.win32.basename(file)}: cmd.exe cannot pass argument ${unsafe} (it has %, a line break or NUL)`);
  const comspec = commandProcessor(env);
  const line = [file, ...args].map(quoteArg).join(' ');
  // cmd.exe looks a bare name up in the cwd before PATH, and an npm shim starts a bare `node`: a repository's node.exe would run
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', `"${line}"`], windowsVerbatimArguments: true, env: NO_CWD_LOOKUP };
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

/** What a run gets: the caller's options, and windowsVerbatimArguments when the .cmd runner built the line. */
export type ExecRunOptions = NonNullable<Parameters<Exec>[2]> & { windowsVerbatimArguments?: true };
export type ExecRun = (file: string, args: string[], opts: ExecRunOptions) => Promise<{ stdout: string }>;

export interface CreateExecOptions {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv; // the daemon's: the lookup's env when a call passes none
  readonly dirsFor: (name: string) => readonly string[];
  readonly run?: ExecRun; // the tests' seam; the promisified execFile otherwise
  readonly isFile?: (file: string) => boolean; // the tests' fake file system
}

const execFileAsync: ExecRun = promisify(execFile);

/** One Exec for `platform` (#633): every name it runs, git included, goes through resolveExec on each call. The lookup reads the call's env
 *  when it has one, since that is the PATH the child gets, else the daemon's. A name found nowhere, or an argument the .cmd runner refuses,
 *  is a rejection, never a synchronous throw: detectAgents reads it as "not installed", and every gh caller already handles a failed gh. */
export function createExec({ platform, env, dirsFor, run = execFileAsync, isFile }: CreateExecOptions): Exec {
  return async (file, args, opts) => {
    const command = resolveExec(file, args, { platform, env: opts?.env ?? env, dirs: dirsFor(file), isFile });
    const extra = command.env === undefined ? {} : { env: { ...(opts?.env ?? env), ...command.env } };
    return run(command.file, [...command.args], { ...opts, ...extra, ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}) });
  };
}
