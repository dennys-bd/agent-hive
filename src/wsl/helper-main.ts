// The distro's helper (#941): the program a distro's node runs as `node wsl-helper.mjs <folder>`, speaking the mux over its stdin and
// stdout. It serves its own disk and processes on channel 1 and relays hooks on channel 2. Only node: imports may end up under it: the
// bundle (scripts/build-wsl-helper.mjs) is copied into a distro with no node_modules, so it builds its machine from machine-local-disk.ts.
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { agentsOnPath } from '../agents.js';
import { type Machine, type MachineInfo, type MachinePty, pathsOf } from '../machine.js';
import { infoOf, localDisk } from '../machine-local-disk.js';
import { localWatch } from '../machine-local-fs.js';
import { runDetached } from '../machine-run.js';
import { listenRelay } from '../relay/relay-listen.js';
import { RemoteError } from '../remote/frames.js';
import { serveMachine } from '../remote/machine-serve.js';
import { createMux, type Mux } from '../remote/protocol.js';
import { createStdioDecoder, encodeStdioFrame } from '../remote/stdio-frames.js';
import { replaceFile } from '../replace-file.js';
import { type Exec, LOCAL_MACHINE } from '../types.js';

export const RELAY_PORT_FILE = 'relay-port';
const PORT_MAX = 65_535;
const DECIMAL = /^\d+$/;
const FILE_MODE = 0o600; // the distro's Hive folder is this user's only
const FOLDER_MODE = 0o700; // what #945 writes there later (hive.secret, hooks.json) must not sit in a world-readable folder
const EXIT_BAD_FRAME = 1; // also a start that failed
const EXIT_USAGE = 2;
const EXIT_GRACE_MS = 2_000; // what a handle still open (a child exec) gets before the exit is forced
const OS_RELEASE = '/proc/sys/kernel/osrelease';
const USAGE = 'usage: node wsl-helper.mjs <absolute path of the distro\'s Hive folder>';

/** What the helper's hello carries (#941): #945 renders hooks.json from relayPort. The protocol version is the hello frame's own. */
export interface HelperHello { info: MachineInfo; relayPort: number; wslVersion: 1 | 2 | null }
type Relay = Awaited<ReturnType<typeof listenRelay>>;

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
  await mkdir(folder, { recursive: true, mode: FOLDER_MODE });
  const file = join(folder, RELAY_PORT_FILE);
  const temp = `${file}.tmp`;
  await rm(temp, { force: true });
  await writeFile(temp, `${port}\n`, { flag: 'wx', mode: FILE_MODE });
  await replaceFile(temp, file);
}

/** The WSL version osrelease names (#941): 2 for microsoft-standard (4.19 kernels lack the -WSL2 suffix), 1 for WSL1's capitalised
 *  Microsoft, null off WSL or when it cannot be read. */
export function wslVersionOf(readOsRelease: () => string): 1 | 2 | null {
  let release: string;
  try {
    release = readOsRelease();
  } catch {
    return null;
  }
  if (release.includes('microsoft-standard')) return 2;
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

/** A call's env over the helper's own (#945). execFile takes an env whole, so a lent GH_TOKEN alone would leave gh with no PATH or HOME;
 *  over the mux the env is a call's additions, as wslExec's WSLENV adds to a distro's. No env: the process's own, untouched. */
export const overOwnEnv = (exec: Exec, own: NodeJS.ProcessEnv): Exec => (file, args, opts) =>
  exec(file, args, opts?.env === undefined ? opts : { ...opts, env: { ...own, ...opts.env } });

/** The distro's own machine (#941): the local disk and exec, runDetached and the local watch, composed here rather than through
 *  createLocalMachine, whose pty half is a native module. serveMachine serves only fs, exec, run and watch. env: what a call's env lays over. */
export function helperMachine(info: MachineInfo, env: NodeJS.ProcessEnv = process.env): Machine {
  return {
    id: LOCAL_MACHINE, ...localDisk(overOwnEnv(promisify(execFile), env)), run: runDetached, watch: localWatch, paths: pathsOf(info.platform),
    info: () => info, process: refuse('process'), pty: refusingPty(),
  };
}

const isAddressInUse = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE';

/** The relay on the kept port (#941): relay-port's while it is free, else a fresh one, written back for the next start. A busy port would
 *  strand the workers whose hooks.json names it anyway; #945 renders hooks.json from the port the hello carries. */
export async function listenKept(mux: Mux, folder: string): Promise<Relay> {
  const kept = await keptPort(folder);
  const relay = await listenRelay(mux, { port: kept ?? 0 }).catch((err: unknown) => {
    if (kept === undefined || !isAddressInUse(err)) throw err;
    return listenRelay(mux, { port: 0 });
  });
  if (relay.port !== kept) await keepPort(folder, relay.port);
  return relay;
}

const log = (line: string): void => { process.stderr.write(`wsl-helper: ${line}\n`); };

// Ends the helper once: the mux and the relay closed, stdin let go, and the exit forced if a handle still holds the loop past the grace
function stopper(mux: Mux, relay: Relay): (exitCode: number, closeCode?: string) => void {
  let isStopping = false;
  return (exitCode, closeCode) => {
    if (isStopping) return;
    isStopping = true;
    process.exitCode = exitCode;
    mux.close(closeCode); // its onClose calls back here, and is a no-op
    void relay.close();
    process.stdin.destroy();
    setTimeout(() => process.exit(exitCode), EXIT_GRACE_MS).unref();
  };
}

// stdin's chunks reach the mux through the stdio frames (#936). Its end, the mux's close and a stdout the Hive closed all end the helper
function wire(mux: Mux, stop: ReturnType<typeof stopper>): void {
  const decoder = createStdioDecoder(mux.receive, (problem) => {
    log(`bad frame: ${problem}`);
    stop(EXIT_BAD_FRAME, 'bad_frame');
  });
  process.stdin.on('data', (chunk: Buffer) => decoder.push(chunk));
  process.stdin.on('end', () => stop(0));
  process.stdout.on('error', () => stop(0));
  mux.onClose(() => stop(0));
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (folder === undefined || !pathsOf(process.platform).isAbsolute(folder)) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(EXIT_USAGE);
  }
  // PATH is the helper's own: #945 starts it through the user's login shell
  const agents = agentsOnPath({ path: process.env.PATH ?? '', home: homedir(), isExecutable: isExecutableFile });
  const info = infoOf(process.env, process.platform, agents);
  const mux = createMux((data) => { process.stdout.write(encodeStdioFrame(data)); }, { side: 'machine' });
  serveMachine(mux, helperMachine(info));
  const relay = await listenKept(mux, folder);
  wire(mux, stopper(mux, relay));
  const found = agents.filter((a) => a.available).map((a) => a.agent);
  log(`folder ${folder}`);
  log(`relay on 127.0.0.1:${relay.port}`);
  log(`agents found: ${found.length === 0 ? 'none' : found.join(', ')}`);
  const hello: HelperHello = { info, relayPort: relay.port, wslVersion: wslVersionOf(() => readFileSync(OS_RELEASE, 'utf8')) };
  mux.hello(hello);
}

// Only as the entry: the node tests import the parts above without starting a helper
if (import.meta.main) {
  main().catch((err: unknown) => {
    log(`could not start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_BAD_FRAME);
  });
}
