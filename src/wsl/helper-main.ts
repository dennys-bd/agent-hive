// The distro's helper (#941): the program a distro's node runs as `node wsl-helper.mjs <folder>`, speaking the mux over its stdin and
// stdout. It serves its own disk and processes on channel 1 and relays hooks on channel 2. Only node: imports may end up under it: the
// bundle (scripts/build-wsl-helper.mjs) is copied into a distro with no node_modules, so it builds its machine from machine-local-disk.ts.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Machine, type MachineInfo, type MachinePty, pathsOf } from '../machine.js';
import { localDisk } from '../machine-local-disk.js';
import { localWatch } from '../machine-local-fs.js';
import { runDetached } from '../machine-run.js';
import { RemoteError } from '../remote/frames.js';
import { replaceFile } from '../replace-file.js';
import { LOCAL_MACHINE } from '../types.js';

export const RELAY_PORT_FILE = 'relay-port';
const PORT_MAX = 65_535;
const DECIMAL = /^\d+$/;
const FILE_MODE = 0o600; // the distro's Hive folder is this user's only

/** The port <folder>/relay-port keeps (#941): a restart listens on it again, so a running worker's hooks.json stays valid. Undefined for a
 *  missing or unreadable file and for anything that is not a port. */
export async function keptPort(folder: string): Promise<number | undefined> {
  const text = await readFile(join(folder, RELAY_PORT_FILE), 'utf8').then((read) => read.trim(), () => '');
  const port = DECIMAL.test(text) ? Number(text) : 0;
  return port > 0 && port <= PORT_MAX ? port : undefined;
}

/** Writes `port` to <folder>/relay-port through a temp file and a rename, so the next start never reads half a number; the folder is
 *  created if it is missing. The temp file is removed first and created exclusively: wx never follows a link planted at its path. */
export async function keepPort(folder: string, port: number): Promise<void> {
  await mkdir(folder, { recursive: true });
  const file = join(folder, RELAY_PORT_FILE);
  const temp = `${file}.tmp`;
  await rm(temp, { force: true });
  await writeFile(temp, `${port}\n`, { flag: 'wx', mode: FILE_MODE });
  await replaceFile(temp, file);
}

/** The WSL version osrelease names (#941): 2 for microsoft-standard-WSL2, 1 for WSL1's Microsoft, null off WSL or when it cannot be read. */
export function wslVersionOf(readOsRelease: () => string): 1 | 2 | null {
  let release: string;
  try {
    release = readOsRelease();
  } catch {
    return null;
  }
  if (release.includes('microsoft-standard-WSL2')) return 2;
  return release.includes('Microsoft') ? 1 : null;
}

/** agentsOnPath's isExecutable on this disk (#941): a regular file, never a directory, that this user may execute. */
export function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false; // missing, unreadable or not executable: no agent there
  }
}

const refuse = (what: string) => (): never => {
  throw new RemoteError('not_supported', `the distro's helper serves no ${what}`);
};

// serveMachine never calls it: the distro's ptys are wsl.exe's on the Windows side (5.2)
function refusingPty(): MachinePty {
  const fail = refuse('pty');
  return { spawn: fail, write: fail, resize: fail, subscribe: fail, kill: fail, pid: fail, has: fail, adopt: fail, forget: fail };
}

/** The distro's own machine (#941): the local disk and exec, runDetached and the local watch, composed here rather than through
 *  createLocalMachine, whose pty half is a native module. serveMachine serves only fs, exec, run and watch. */
export function helperMachine(info: MachineInfo): Machine {
  return {
    id: LOCAL_MACHINE, ...localDisk(promisify(execFile)), run: runDetached, watch: localWatch, paths: pathsOf(info.platform),
    info: () => info, process: refuse('process'), pty: refusingPty(),
  };
}
