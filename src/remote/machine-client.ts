// The machine on the far side of a mux (#937): each member is one request on channel 1 and the rebuild of its answer, so a caller cannot
// tell it from the local machine. info comes from the hello and the pty from the caller (#945); a long-lived process is refused. No direct
// node: import, as the rest of src/remote/; ../machine.js brings node:path, so it loads on Node only.
import { keepTail, type Machine, MachineError, type MachineFs, type MachineInfo, type MachinePty, pathsOf, type ReadOptions, type RunResult, tailOf } from '../machine.js';
import { CHANNEL, isRecord, isString } from './frames.js';
import {
  asBuffer, asString, asStrings, badAnswer, type BigIntStats, capToWire, type Dirent, direntsOf, type MachineMethod, machineErrorOf, splitLines, type Stats,
  statsOf,
} from './machine-wire.js';
import type { Mux } from './protocol.js';

export interface MuxMachineOptions { id: Machine['id']; pty: MachinePty; info: MachineInfo }

type AskOptions = { signal?: AbortSignal; onEvent?: (data: unknown) => void };
type Ask = <T>(method: MachineMethod, args: readonly unknown[], rebuild: (answer: unknown) => T, opts?: AskOptions) => Promise<T>;

const NOT_SUPPORTED = 'not_supported'; // machines.ts' word, and MachineChild's (machine.ts)
const STOPPED = 'stopped'; // runDetached's code and failure for a run its caller stopped (machine-run.ts)
const CANCELLED = 'cancelled';
const ignore = (): void => undefined;
const maybeString = (answer: unknown): string | undefined => (answer === undefined ? undefined : asString(answer));

// JSON turns an undefined argument into null: the trailing ones a caller left out are dropped instead, as if never passed
function wireArgs(args: readonly unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end -= 1;
  return args.slice(0, end);
}

// One request and the rebuild of its answer; a rejection, or an answer not of the method's shape, as a MachineError
const askOver = (mux: Mux): Ask => async (method, args, rebuild, opts) => {
  try {
    return rebuild(await mux.request(CHANNEL.machine, method, wireArgs(args), opts));
  } catch (err) {
    throw machineErrorOf(err);
  }
};

function muxFs(ask: Ask): MachineFs {
  function lstat(path: string): Promise<Stats>;
  function lstat(path: string, options: { bigint: true }): Promise<BigIntStats>;
  function lstat(path: string, options?: { bigint: true }): Promise<Stats | BigIntStats> {
    return options?.bigint === true ? ask('fs.lstat', [path, options], (a) => statsOf(a, true)) : ask('fs.lstat', [path], (a) => statsOf(a, false));
  }
  function readdir(path: string): Promise<string[]>;
  function readdir(path: string, options: { withFileTypes: true; recursive?: boolean }): Promise<Dirent[]>;
  function readdir(path: string, options?: { withFileTypes: true; recursive?: boolean }): Promise<string[] | Dirent[]> {
    return options === undefined ? ask('fs.readdir', [path], asStrings) : ask('fs.readdir', [path, options], direntsOf);
  }
  function readFile(path: string, options: ReadOptions & { encoding: BufferEncoding }): Promise<string>;
  function readFile(path: string, options: ReadOptions): Promise<Buffer>;
  function readFile(path: string, options: ReadOptions & { encoding?: BufferEncoding }): Promise<string | Buffer> {
    return options.encoding === undefined ? ask('fs.readFile', [path, options], asBuffer) : ask('fs.readFile', [path, options], asString);
  }
  // maxBytes already bounds the read, so the lines come from one readFile; its refusals (not_file, too_large) reject the first next()
  async function* readLines(path: string, { maxBytes }: { maxBytes: number }): AsyncGenerator<string> {
    yield* splitLines(await readFile(path, { maxBytes, encoding: 'utf8' }));
  }
  return {
    stat: (path) => ask('fs.stat', [path], (a) => statsOf(a, false)),
    lstat, readdir, readFile, readLines,
    realpath: (path) => ask('fs.realpath', [path], asString),
    access: (path, mode) => ask('fs.access', [path, mode], ignore),
    writeFile: (path, data, options) => ask('fs.writeFile', [path, data, options], ignore),
    writeAtomic: (path, text) => ask('fs.writeAtomic', [path, text], asBuffer),
    mkdir: (path, options) => ask('fs.mkdir', [path, options], maybeString),
    mkdtemp: (prefix) => ask('fs.mkdtemp', [prefix], asString),
    rename: (from, to) => ask('fs.rename', [from, to], ignore),
    rm: (path, options) => ask('fs.rm', [path, options], ignore),
    // a filter is a function and cannot cross: copying without it would drop the COPY step's guards (worktree-copy-step.ts)
    cp: (from, to, options) => (options?.filter === undefined ? ask('fs.cp', [from, to, options], ignore)
      : Promise.reject(new MachineError('cp with a filter does not cross the mux', { code: NOT_SUPPORTED }))),
    copyFile: (from, to, mode) => ask('fs.copyFile', [from, to, mode], ignore),
    link: (existing, created) => ask('fs.link', [existing, created], ignore),
    chmod: (path, mode) => ask('fs.chmod', [path, mode], ignore),
    unlink: (path) => ask('fs.unlink', [path], ignore),
    appendFile: (path, data, options) => ask('fs.appendFile', [path, data, options], ignore),
  };
}

function stdoutOf(answer: unknown): { stdout: string } {
  if (!isRecord(answer) || !isString(answer.stdout)) throw badAnswer('exec result');
  return { stdout: answer.stdout };
}

function runResultOf(answer: unknown): RunResult {
  if (!isRecord(answer)) throw badAnswer('run result');
  const { code, stdout, stderr, tail, failure } = answer;
  if (!(isString(code) || typeof code === 'number') || !isString(stderr) || !isString(tail)) throw badAnswer('run result');
  return { code, stdout: asBuffer(stdout), stderr, tail, ...(isString(failure) ? { failure } : {}) };
}

// A signal does not cross: the mux sends a cancel when it aborts, and rejects the request at once with cancelled (ABORT_ERR here)
const execOver = (ask: Ask): Machine['exec'] => (file, args, opts = {}) => {
  const { signal, ...rest } = opts;
  return ask('exec', [file, args, rest], stdoutOf, { signal });
};

// run never rejects for a stop (RunResult's contract): an abort resolves at once as runDetached's does, its tail from the chunks received.
// The cancel reaches the machine's run, and its late answer is dropped by the mux. A closed link still rejects, as every member does
const runOver = (ask: Ask): Machine['run'] => async (p) => {
  const { signal, onOutput, ...rest } = p;
  let tail = '';
  const onEvent = (data: unknown): void => {
    if (!isString(data)) return;
    onOutput?.(data);
    tail = keepTail(tail + data);
  };
  try {
    return await ask('run', [{ ...rest, maxBytes: capToWire(rest.maxBytes) }], runResultOf, { signal, onEvent });
  } catch (err) {
    if (signal?.aborted === true) return { code: STOPPED, stdout: Buffer.alloc(0), stderr: '', tail: tailOf(tail), failure: CANCELLED };
    throw err;
  }
};

// A request that stays open: its events are the filenames, and it ends only in a failure, the watcher's or the link's, which reaches
// onError once. close() aborts it; the cancelled rejection that follows is this side's own, and nothing fires after close()
const watchOver = (ask: Ask): Machine['watch'] => (path, { recursive }, onEvent, onError) => {
  const controller = new AbortController();
  let isDone = false;
  const event = (data: unknown): void => {
    if (!isDone) onEvent(isString(data) ? data : null);
  };
  void ask('watch', [path, { recursive }], ignore, { signal: controller.signal, onEvent: event }).catch((err: MachineError) => {
    if (isDone) return;
    isDone = true;
    onError(err);
  });
  return {
    close: () => {
      if (isDone) return;
      isDone = true;
      controller.abort();
    },
  };
};

/** The machine served on the far side of `mux` (#937). id and info are the caller's (#945: the distro's id, the hello's facts); pty is
 *  used as is. paths follows info.platform: path.posix for a linux distro on a Windows host. */
export function createMuxMachine(mux: Mux, { id, pty, info }: MuxMachineOptions): Machine {
  const ask = askOver(mux);
  return {
    id, pty, fs: muxFs(ask), exec: execOver(ask), run: runOver(ask), watch: watchOver(ask), info: () => info, paths: pathsOf(info.platform),
    // a long-lived child's three pipes do not cross the mux: MachineChild's comment in machine.ts
    process: () => {
      throw new MachineError(`machine ${id} runs no long-lived process over the mux`, { code: NOT_SUPPORTED });
    },
  };
}
