// The local machine (#158): the host's own disk, processes and ptys behind Machine, so 7.2 to 7.4 move every caller onto it and node 8's
// remote machine stands in for an actor's task with no caller changing again. The pty half is machine-local-pty.ts.
import { randomBytes } from 'node:crypto';
import { access, appendFile, chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { envValue } from './exec-path.js';
import { type Machine, MachineError, type MachineExec, type MachineFs, type MachineInfo, type Machines } from './machine.js';
import { createLocalPty, type LocalPtyDeps } from './machine-local-pty.js';
import { runDetached } from './machine-run.js';
import { posixShell } from './posix-shell.js';
import { replaceFile } from './replace-file.js';
import type { AgentAvailability, Exec, MachineId } from './types.js';

export interface LocalMachineDeps extends Omit<LocalPtyDeps, 'env' | 'platform'> {
  exec: Exec; // the server's own: tests see every call, as today
  agents: readonly AgentAvailability[]; // what boot detected (#516); 7.4 detects per machine
  env?: NodeJS.ProcessEnv; // process.env unless a test injects one
  platform?: NodeJS.Platform; // process.platform unless a test injects one
}

const LOCAL: MachineId = 'local';
const MODE_BITS = 0o7777;

const text = (value: unknown): string => (typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '');

/** execFile's rejection (or a test fake's) as a MachineError, field for field, the original as its cause. */
export function toMachineError(err: unknown): MachineError {
  if (err instanceof MachineError) return err;
  const fields: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
  const { code } = fields;
  return new MachineError(err instanceof Error ? err.message : String(err), {
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stderr: text(fields.stderr), stdout: text(fields.stdout), killed: fields.killed === true,
  }, { cause: err });
}

// The cap is checked on the stat, so an oversized file is never read; and again on the bytes, for a file that grew in between
function readCapped(path: string, options: { maxBytes: number; encoding: BufferEncoding }): Promise<string>;
function readCapped(path: string, options: { maxBytes: number }): Promise<Buffer>;
async function readCapped(path: string, { maxBytes, encoding }: { maxBytes: number; encoding?: BufferEncoding }): Promise<string | Buffer> {
  const tooLarge = (): MachineError => new MachineError(`file over ${maxBytes} bytes`, { code: MachineError.TOO_LARGE });
  if ((await stat(path)).size > maxBytes) throw tooLarge();
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw tooLarge();
  return encoding === undefined ? bytes : bytes.toString(encoding);
}

// Lifted from server-editor.ts' writeAtomic, which 7.3 deletes when it switches to this one: the text in a temp file beside the original,
// with the original's mode, renamed over it, so a reader never sees half a file; a failure leaves no temp file
async function writeAtomic(file: string, contents: string): Promise<Buffer> {
  const bytes = Buffer.from(contents, 'utf8');
  const mode = (await stat(file)).mode & MODE_BITS;
  const temp = join(dirname(file), `.${basename(file)}.hive-${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); // private until the chmod gives it the original's mode
    await chmod(temp, mode); // writeFile's mode goes through the umask; chmod sets the original's exactly
    await replaceFile(temp, file);
    return bytes;
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

const LOCAL_FS: MachineFs = {
  stat, lstat, realpath, access, readdir, readFile: readCapped, writeFile, writeAtomic, mkdir, mkdtemp, rename, rm, cp, copyFile, link, chmod, unlink, appendFile,
};

// cwd and signal ride along to the exec under it: execFile takes both, and a test's fake sees them
const machineExec = (exec: Exec): MachineExec => async (file, args, opts) => {
  try {
    return await exec(file, args, opts);
  } catch (err) {
    throw toMachineError(err);
  }
};

// #806: win32's env names ignore case; elsewhere PATH is PATH
function infoOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, agents: readonly AgentAvailability[]): MachineInfo {
  const path = (platform === 'win32' ? envValue(env, 'PATH') : env.PATH) ?? '';
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR;
  return {
    platform, arch: process.arch, homedir: homedir(), tmpdir: tmpdir(), path, shell: posixShell().shell,
    ...(claudeConfigDir === undefined ? {} : { claudeConfigDir }), agents: [...agents],
  };
}

export function createLocalMachine(deps: LocalMachineDeps): Machine {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  let read: MachineInfo | undefined; // nothing it holds changes while the Hive runs
  return {
    id: LOCAL, fs: LOCAL_FS, exec: machineExec(deps.exec), run: runDetached,
    pty: createLocalPty({ ...deps, env, platform }),
    info: () => {
      read ??= infoOf(env, platform, deps.agents);
      return read;
    },
  };
}

/** Until node 8 the local machine is every activity's, an id it does not know included. */
export function createLocalMachines(deps: LocalMachineDeps): Machines {
  const local = createLocalMachine(deps);
  return { local, for: () => local };
}
