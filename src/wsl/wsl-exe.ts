// wsl.exe calls (#939): one argv builder, the env that crosses into a distro, and a MachineExec over them. No long-lived process: each call is one
// wsl.exe run. The command and the runner are dependencies: biome keeps node:child_process out of this file, and a test's fake wsl.exe is a command.
import { type ExecOptions, MachineError, type MachineExec } from '../machine.js';
import { isDistro } from '../config-machines.js';
import { ENV_NAME } from '../types.js';

export interface RunOptions { encoding: 'buffer'; env: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number; signal?: AbortSignal; windowsHide: true }
/** promisify(execFile) with encoding 'buffer': rejects with the exit code (or an errno string) and the output as Buffers. */
export type RunFile = (file: string, args: string[], opts: RunOptions) => Promise<{ stdout: Buffer; stderr: Buffer }>;
export interface WslDeps { command: readonly string[]; run: RunFile; env: NodeJS.ProcessEnv } // env: the host's

// wsl.exe's own failure code: -1, which Windows reports unsigned
const WSL_FAILED = [4294967295, -1];
// PATH: WSLENV would put Windows' PATH over the distro's. WSLENV and WSL_UTF8 act on wsl.exe itself (the second makes its messages UTF-8)
const NOT_CROSSING = ['PATH', 'WSLENV', 'WSL_UTF8'];
const OWN_NAMES = new Set(['WSLENV', 'WSL_UTF8']);
const LIST_TIMEOUT_MS = 10_000; // a stuck WSL service would otherwise hang the caller with no answer

// $1 is the cwd, the rest the argv. No backslash: Git for Windows' sh.exe collapses a doubled one in the line it is given.
export const CWD_WRAPPER = 'cd -- "$1" && shift && exec "$@"';

const bad = (message: string): MachineError => new MachineError(message, { code: MachineError.BAD_NAME });

/** The file and args of one wsl.exe call. With a cwd, a missing folder fails the cd, so nothing runs; never --cd or --, which wsl.exe reads its own way. */
export function wslArgv(command: readonly string[], distro: string, argv: readonly string[], cwd?: string): { file: string; args: string[] } {
  const [file, ...head] = command;
  if (file === undefined) throw bad('no wsl.exe command');
  if (!isDistro(distro)) throw bad(`not a distro name: ${distro}`);
  // cd "" is a no-op in sh, so the command would run wherever wsl.exe starts
  if (cwd === '') throw new MachineError('an empty cwd', { code: MachineError.BAD_PATH });
  const inner = cwd === undefined ? argv : ['sh', '-c', CWD_WRAPPER, 'sh', cwd, ...argv];
  return { file, args: [...head, '-d', distro, '--exec', ...inner] };
}

/** The env of the wsl.exe process: the host's, without the two it would act on, plus vars named in WSLENV so they cross by name, never in an argv. */
export function wslEnv(vars: Record<string, string>, hostEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = Object.keys(vars);
  for (const name of names) {
    if (!ENV_NAME.test(name)) throw bad(`not an environment variable name: ${name}`);
    if (NOT_CROSSING.includes(name.toUpperCase())) throw bad(`${name} does not cross into a distro`);
  }
  // WSL_UTF8 would make wsl.exe's own messages UTF-8; they are always read as UTF-16LE
  // matched without case: Windows env names are case-insensitive, so a Wslenv would clash with the WSLENV set here
  const rest = Object.fromEntries(Object.entries(hostEnv).filter(([k]) => !OWN_NAMES.has(k.toUpperCase())));
  return { ...rest, ...vars, WSLENV: names.join(':') };
}

const utf16 = (b: Buffer): string => b.toString('utf16le');

/** The names `wsl.exe -l -q` lists. [] when wsl.exe is missing or fails, which is how no distro installed shows. */
export async function listDistros(deps: WslDeps): Promise<string[]> {
  const { file, args } = { file: deps.command[0] ?? '', args: [...deps.command.slice(1), '-l', '-q'] };
  try {
    const { stdout } = await deps.run(file, args, { encoding: 'buffer', env: wslEnv({}, deps.env), timeout: LIST_TIMEOUT_MS, windowsHide: true });
    return utf16(stdout).replace(/[\0\r]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

interface RunFailure { code?: string | number; stdout?: Buffer; stderr?: Buffer; killed?: boolean }

function failure(err: unknown, file: string): MachineError {
  const f: RunFailure = typeof err === 'object' && err !== null ? (err as RunFailure) : {};
  const own = typeof f.code === 'number' && WSL_FAILED.includes(f.code);
  const text = (b: Buffer | undefined): string => (b === undefined ? '' : own ? utf16(b) : b.toString('utf8'));
  return new MachineError(`${file} failed: ${f.code}`, { code: f.code, stdout: text(f.stdout), stderr: text(f.stderr), killed: f.killed }, { cause: err });
}

/** A MachineExec in `distro`. cwd goes through the wrapper, env through WSLENV; input is refused, as an execFile-shaped runner cannot carry it. */
export function wslExec(deps: WslDeps, distro: string): MachineExec {
  return async (file: string, args: string[], opts: ExecOptions = {}) => {
    if (opts.input !== undefined) throw new MachineError('wsl exec takes no input', { code: 'not_supported' });
    const env = wslEnv(definedOnly(opts.env), deps.env);
    const call = wslArgv(deps.command, distro, [file, ...args], opts.cwd);
    try {
      // only the options given: execFile spreads its options, so an explicit undefined maxBuffer would lift its 1 MiB cap
      const { maxBuffer, timeout, signal } = opts;
      const limits = { ...(maxBuffer !== undefined && { maxBuffer }), ...(timeout !== undefined && { timeout }), ...(signal !== undefined && { signal }) };
      const { stdout } = await deps.run(call.file, call.args, { encoding: 'buffer', env, windowsHide: true, ...limits });
      return { stdout: stdout.toString('utf8') };
    } catch (err) {
      throw failure(err, call.file);
    }
  };
}

const definedOnly = (env: NodeJS.ProcessEnv = {}): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
