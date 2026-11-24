// One running helper (#945): wsl.exe started on the login-shell line, the host's side of the mux over its pipes, its stderr in the Hive's
// log and its hello. The link ends when the child exits, its stdout ends or the mux closes; stop() is the Hive's own end of it.
import type { MachineChild } from '../machine.js';
import { isRecord } from '../remote/frames.js';
import { createMux, type Mux } from '../remote/protocol.js';
import { createStdioDecoder, encodeStdioFrame } from '../remote/stdio-frames.js';
import { HELPER_FAILED, helperPath, type InstallDeps, LOGIN_SHELL, unavailable } from './helper-install.js';
import type { HelperHello } from './helper-main.js';
import { wslArgv, wslEnv } from './wsl-exe.js';

// $1 node, $2 the helper, $3 its folder (#941 decision 3). LOGIN_SHELL moved the profile's stdout to stderr: fd 1 is given back first
export const SPAWN_LINE = 'exec 1>&3 3>&-; exec "$1" "$2" "$3"';

export interface LinkDeps extends InstallDeps { node: string; log(line: string): void }
export interface HelperLink { mux: Mux; child: MachineChild; hello: Promise<HelperHello>; stop(): void; isEnded(): boolean }

const isHello = (value: unknown): value is HelperHello =>
  isRecord(value) && isRecord(value.info) && typeof value.info.platform === 'string' && Number.isInteger(value.relayPort);

// The helper's stderr is its log (#941 decision 11): one Hive log line per line it wrote, under the distro's name
function logLines(stream: MachineChild['stderr'], log: (line: string) => void): void {
  let rest = '';
  const emit = (line: string): void => { if (line.trim() !== '') log(line.trimEnd()); };
  stream.on('data', (chunk: Buffer) => {
    const lines = (rest + chunk.toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) emit(line);
  });
  stream.on('end', () => emit(rest));
}

// Settles once: the hello, or helper_failed when the start's signal aborts (the timeout or close()) or the link ends first
function helloOf(mux: Mux, id: string, signal: AbortSignal, stop: () => void): Promise<HelperHello> {
  return new Promise((resolve, reject) => {
    const fail = (why: string): void => {
      signal.removeEventListener('abort', onAbort);
      stop();
      reject(unavailable(id, HELPER_FAILED, new Error(why)));
    };
    const onAbort = (): void => fail('the helper sent no hello before its start ended');
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    mux.onHello((info) => {
      signal.removeEventListener('abort', onAbort);
      if (isHello(info)) resolve(info);
      else fail('a hello not of the helper\'s shape');
    });
    mux.onClose((code) => fail(`the helper ended before its hello${code === undefined ? '' : `: ${code}`}`));
  });
}

/** The helper of `hash` in `folder`, started on the login shell (decision 9), stdout feeding the decoder and the mux sending frames. */
export function startLink(deps: LinkDeps, id: string, folder: string, hash: string, signal: AbortSignal): HelperLink {
  const { file, args } = wslArgv(deps.command, deps.distro, ['sh', '-c', LOGIN_SHELL, 'sh', SPAWN_LINE, deps.node, helperPath(folder, hash), folder]);
  const child = deps.spawn(file, args, { env: wslEnv({}, deps.env), windowsHide: true });
  const mux = createMux((data) => { child.stdin.write(encodeStdioFrame(data)); }, { side: 'host' });
  const prefix = `wsl ${deps.distro}:`;
  const decoder = createStdioDecoder(mux.receive, (problem) => {
    deps.log(`${prefix} bad frame: ${problem}`);
    mux.close('bad_frame');
  });
  child.stdout.on('data', (chunk: Buffer) => decoder.push(chunk));
  logLines(child.stderr, (line) => deps.log(`${prefix} ${line}`));
  child.stdin.on('error', () => undefined); // a frame written after the child died: the exit is what ends the link
  let isStopped = false;
  const stop = (): void => {
    if (isStopped) return;
    isStopped = true;
    mux.close(); // every pending request rejects with machine_unavailable (#937)
    child.stdin.end(); // the helper ends when its stdin does, also where a killed wsl.exe leaves it running
    child.kill();
  };
  child.once('exit', stop);
  child.once('error', (err: Error) => {
    deps.log(`${prefix} ${err.message}`);
    stop();
  });
  child.stdout.once('end', stop);
  mux.onClose(stop); // a bye or a version mismatch: the link is of no use any more
  return { mux, child, hello: helloOf(mux, id, signal, stop), stop, isEnded: () => isStopped };
}
