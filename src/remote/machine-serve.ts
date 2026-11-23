// The machine's side of channel 1 (#937): a request checked against its method's params, called on the machine with the request's signal
// and emit standing in for the caller's, which cannot cross, and its answer or failure encoded as machine-wire.ts says. Free of node: like
// the rest of src/remote/.
import type { ExecOptions, Machine, RunProcess } from '../machine.js';
import { CHANNEL, isRecord, RemoteError } from './frames.js';
import {
  type BigIntStats, CALL_PARAMS, type Check, type Dirent, encodeDirent, encodeStats, FS_METHODS, FS_PARAMS, type FsMethod, fitsParams, remoteErrorOf,
  type Stats,
} from './machine-wire.js';
import type { Mux, RequestContext } from './protocol.js';

type Serve = (machine: Machine, args: unknown[], ctx: RequestContext) => Promise<unknown>;
type Served = { checks: readonly Check[]; serve: Serve };
type FsCall = (...args: unknown[]) => Promise<unknown>;

// JSON would cross a Stats or a Dirent without its is*: each crosses as machine-wire.ts encodes it
function answerOf(name: FsMethod, args: unknown[], answer: unknown): unknown {
  if (name === 'stat' || name === 'lstat') return encodeStats(answer as Stats | BigIntStats);
  const options = args[1];
  if (name === 'readdir' && isRecord(options) && options.withFileTypes === true) return (answer as Dirent[]).map(encodeDirent);
  return answer;
}

const serveFs = (name: FsMethod): Serve => async (machine, args) => {
  const fs = machine.fs as unknown as Record<FsMethod, FsCall>;
  return answerOf(name, args, await fs[name](...args));
};

const serveExec: Serve = (machine, [file, args, opts], ctx) =>
  machine.exec(file as string, args as string[], { ...(opts as ExecOptions | undefined), signal: ctx.signal });

const serveRun: Serve = (machine, [p], ctx) =>
  machine.run({ ...(p as RunProcess), signal: ctx.signal, onOutput: (text) => ctx.emit(text) });

// Open until the caller's close() cancels the request, or until the watcher fails, whose error is the request's answer. A cancel that
// crossed the request aborts the signal before this runs, and then nothing is watched
const serveWatch: Serve = (machine, [path, options], ctx) => new Promise((resolve, reject) => {
  if (ctx.signal.aborted) {
    resolve(undefined);
    return;
  }
  const { recursive } = options as { recursive: boolean };
  const watcher = machine.watch(path as string, { recursive }, (filename) => ctx.emit(filename), reject);
  ctx.signal.addEventListener('abort', () => {
    watcher.close();
    resolve(undefined);
  }, { once: true });
});

// a Map, so a method named after an Object.prototype member (toString) serves nothing
const SERVED = new Map<string, Served>([
  ...FS_METHODS.map((name): [string, Served] => [`fs.${name}`, { checks: FS_PARAMS[name], serve: serveFs(name) }]),
  ['exec', { checks: CALL_PARAMS.exec, serve: serveExec }],
  ['run', { checks: CALL_PARAMS.run, serve: serveRun }],
  ['watch', { checks: CALL_PARAMS.watch, serve: serveWatch }],
]);

/** Answers channel 1 of `mux` with `machine` (#937): the helper (#941) serves its distro's local machine with it. */
export function serveMachine(mux: Mux, machine: Machine): void {
  mux.onRequest(CHANNEL.machine, async (method, params, ctx) => {
    const served = SERVED.get(method);
    if (served === undefined) throw new RemoteError('unknown_method', `the machine serves no ${method}`);
    // checked here, so a bad frame never reaches the machine with undefined arguments
    if (!fitsParams(params, served.checks)) throw new RemoteError('bad_params', `the params of ${method} are not its shape`);
    try {
      return await served.serve(machine, params, ctx);
    } catch (err) {
      throw remoteErrorOf(err);
    }
  });
}
