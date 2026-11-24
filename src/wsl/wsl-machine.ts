// The machine of a wsl:<distro> id (#945, node 5.3 of #942): one object a caller keeps across restarts, whose every call waits for the
// distro's helper and goes to the link it is on now. The start (probe, install, helper, hello, relay, the Hive's folder) is one promise
// shared by every call that arrives during it (decision 1): a failed start leaves nothing behind, and an ended helper is started again by
// the next call (decision 13). No timeout of its own on any call: only the start is bounded (decision 2).
import { type Machine, MachineError, type MachineInfo, type MachinePty, type MachineWatcher, pathsOf, toMachineError } from '../machine.js';
import type { PluginRender } from '../plugin-render.js';
import type { PtyHost } from '../pty-host.js';
import { answerRelay } from '../relay/relay-answer.js';
import { createMuxMachine } from '../remote/machine-client.js';
import { type Language, WSL_MACHINE_PREFIX } from '../types.js';
import { distroPluginDir, prepareDistroHome } from './distro-home.js';
import { HELPER_FAILED, helperHash, installHelper, probeHelper, type SpawnChild, startReason, unavailable } from './helper-install.js';
import { type HelperLink, startLink } from './helper-link.js';
import type { HelperHello } from './helper-main.js';
import { stableFs } from './stable-fs.js';
import { type RunFile, wslExec } from './wsl-exe.js';
import { createWslPty } from './wsl-pty.js';

export const HELLO_TIMEOUT_MS = 30_000; // the probe, the install and the hello together: a cold distro's boot is the one wait the machine owns
export const STARTING = 'starting'; // info() before the first hello
export const CLOSED = 'closed'; // any call after close()
const BUNDLE_MAX = 16 << 20; // the bundle is a few hundred KiB; the cap only keeps a wrong helperFile from being read whole
const GH_TOKEN = 'GH_TOKEN';
const NOT_SUPPORTED = 'not_supported';

export interface WslMachineDeps {
  command: readonly string[]; // wsl.exe and any leading args (a test's fake)
  run: RunFile;
  spawn: SpawnChild;
  env: NodeJS.ProcessEnv; // the host's: what wsl.exe itself starts with
  helperFile: string; // the packaged dist/wsl-helper.mjs, read on the host
  node: string; // the distro's node command, found on its login PATH
  hivePort(): number; // what the relay repeats a request against
  secret: string; // this boot's: hive.secret's header line and the MCP config
  shimWords(): readonly string[];
  language(): Language;
  plugins: Pick<PluginRender, 'dir'>;
  host: Machine;
  ptys: PtyHost; // the daemon's
  hostCwd: string; // where a pty's wsl.exe starts on the host
  lend(): Promise<string>; // the GitHub token, read per call; rejects when there is none
  log(line: string): void;
  helloTimeoutMs?: number; // HELLO_TIMEOUT_MS; a test's is short
}

/** A distro's machine (decision 14): close() is the quit's, after which every call rejects with closed. */
export type WslMachine = Machine & { close(): void };

interface Live { link: HelperLink; machine: Machine; pty: MachinePty; info: MachineInfo }
interface Bundle { hash: string; bytes: Buffer }
interface StartContext { id: string; deps: WslMachineDeps & { distro: string }; stable: Machine; closing: AbortSignal; bundle(): Promise<Bundle> }

// After the hello (decision 10): the relay answered against the Hive's port, the Hive's folder rendered for the port the helper listens on,
// and the distro's pty (#944) over that folder. The pty and the plugin copy get the stable machine: distro-home keys its queue by identity
async function joined({ id, deps, stable }: StartContext, link: HelperLink, hello: HelperHello): Promise<Live> {
  answerRelay(link.mux, { port: deps.hivePort() });
  const machine = createMuxMachine(link.mux, { id, pty: stable.pty, info: hello.info });
  const secretLine = `x-hive-secret: ${deps.secret}`;
  const home = await prepareDistroHome(machine, deps.host, { relayPort: hello.relayPort, secretLine, shimWords: deps.shimWords(), language: deps.language() });
  const pty = createWslPty({
    command: deps.command, distro: deps.distro, machine: stable, ptys: deps.ptys, home, relayPort: hello.relayPort, secret: deps.secret,
    pluginDir: (workspace) => distroPluginDir(stable, deps.host, deps.plugins, workspace), hostEnv: deps.env, hostCwd: deps.hostCwd,
  });
  return { link, machine, pty, info: hello.info };
}

// Probe, install and hello under one timeout, which close() also ends; each step is one wsl.exe call, so a failure names its step
async function startLive(ctx: StartContext): Promise<Live> {
  const { id, deps } = ctx;
  const signal = AbortSignal.any([ctx.closing, AbortSignal.timeout(deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)]);
  const { hash, bytes } = await ctx.bundle();
  const probe = await probeHelper(wslExec(deps, deps.distro), deps.node, hash, signal);
  if ('reason' in probe) throw unavailable(id, probe.reason);
  if (!probe.isInstalled) {
    await installHelper(deps, probe.folder, hash, bytes, signal).catch((err: unknown) => { throw unavailable(id, startReason(err), err); });
  }
  const link = startLink(deps, id, probe.folder, hash, signal);
  const hello = await link.hello;
  try {
    return await joined(ctx, link, hello);
  } catch (err) {
    link.stop();
    throw err;
  }
}

// Read per call, never held (decision 3); no token is no GH_TOKEN, and the log names its absence, never a value
async function lent(deps: Pick<WslMachineDeps, 'lend' | 'log'>, distro: string): Promise<Record<string, string>> {
  try {
    return { [GH_TOKEN]: await deps.lend() };
  } catch {
    deps.log(`wsl ${distro}: no GitHub token to lend`);
    return {};
  }
}

// A caller's own GH_TOKEN wins (decision 4). Nothing lent and no env of the caller's stays no env: the helper's own is then used whole
const withLent = (env: NodeJS.ProcessEnv | undefined, token: Record<string, string>): NodeJS.ProcessEnv | undefined =>
  env?.[GH_TOKEN] !== undefined || Object.keys(token).length === 0 ? env : { ...env, ...token };

const asUnavailable = (id: string, err: unknown): MachineError =>
  err instanceof MachineError && err.code === MachineError.UNAVAILABLE ? err : unavailable(id, HELPER_FAILED, err);

// A start that fails reaches onError once (#935's contract); after close() neither callback fires
function watchOn(on: () => Promise<Machine>, path: string, options: { recursive: boolean }, onEvent: (filename: string | null) => void, onError: (err: MachineError) => void): MachineWatcher {
  let inner: MachineWatcher | undefined;
  let isClosed = false;
  on().then((machine) => {
    if (!isClosed) inner = machine.watch(path, options, onEvent, onError);
  }, (err: unknown) => {
    if (!isClosed) onError(toMachineError(err)); // ready() rejects with the start's MachineError already
  });
  return { close: () => { isClosed = true; inner?.close(); } };
}

// spawn waits for the start, then hands the spec on with the token lent; the sync members are the daemon's PtyHost, as #944's are. pid:
// wsl.exe's on the host, never the distro shell's, so none (#944)
function stablePty(ready: () => Promise<Live>, token: () => Promise<Record<string, string>>, ptys: PtyHost): MachinePty {
  return {
    spawn: (spec, handlers) => {
      const inner = ready().then(async (live) => live.pty.spawn({ ...spec, lent: { ...(await token()), ...spec.lent } }, handlers));
      let killing: Promise<void> | undefined;
      return {
        started: inner.then((handle) => handle.started),
        kill: () => {
          killing ??= inner.then((handle) => handle.kill(), () => undefined);
          return killing;
        },
      };
    },
    write: (ptyId, data) => ptys.write(ptyId, data),
    resize: (ptyId, cols, rows, redraw) => ptys.resize(ptyId, cols, rows, redraw),
    subscribe: (ptyId, onData, onExit) => ptys.subscribe(ptyId, onData, onExit),
    kill: (ptyId) => ptys.kill(ptyId),
    pid: () => undefined,
    has: (ptyId) => ptys.has(ptyId),
    adopt: (ptyId, pty) => ptys.adopt(ptyId, pty),
    forget: (ptyId) => ptys.forget(ptyId),
  };
}

// Every member but info and close (decision 11): each waits for the helper; exec and run get the lent token
function members(id: string, ready: () => Promise<Live>, token: () => Promise<Record<string, string>>, ptys: PtyHost): Omit<Machine, 'info'> {
  const on = async (): Promise<Machine> => (await ready()).machine;
  return {
    id, paths: pathsOf('linux'), fs: stableFs(on),
    exec: async (file, args, opts = {}) => {
      const machine = await on();
      const env = withLent(opts.env, await token());
      return machine.exec(file, args, env === undefined ? opts : { ...opts, env });
    },
    run: async (p) => {
      const machine = await on();
      return machine.run({ ...p, env: withLent(p.env, await token()) ?? p.env });
    },
    watch: (path, options, onEvent, onError) => watchOn(on, path, options, onEvent, onError),
    pty: stablePty(ready, token, ptys),
    process: () => {
      throw new MachineError(`machine ${id} runs no long-lived process`, { code: NOT_SUPPORTED });
    },
  };
}

export function createWslMachine(distro: string, deps: WslMachineDeps): WslMachine {
  const id = `${WSL_MACHINE_PREFIX}${distro}`;
  const closing = new AbortController();
  let current: Live | undefined;
  let lastInfo: MachineInfo | undefined;
  let starting: Promise<Live> | undefined;
  let bundle: Promise<Bundle> | undefined;
  // the hash is read once per machine (decision 8); a read that failed is read again by the next start
  const readBundle = (): Promise<Bundle> => {
    bundle ??= deps.host.fs.readFile(deps.helperFile, { maxBytes: BUNDLE_MAX }).then((bytes) => ({ hash: helperHash(bytes), bytes }));
    return bundle.catch((err: unknown) => { bundle = undefined; throw err; });
  };
  const adopt = (live: Live): Live => {
    starting = undefined;
    if (closing.signal.aborted) {
      live.link.stop();
      throw unavailable(id, CLOSED);
    }
    current = live;
    lastInfo = live.info;
    return live;
  };
  const drop = (err: unknown): never => {
    starting = undefined;
    throw closing.signal.aborted ? unavailable(id, CLOSED, err) : asUnavailable(id, err);
  };
  const ready = (): Promise<Live> => {
    if (closing.signal.aborted) return Promise.reject(unavailable(id, CLOSED));
    if (current !== undefined && !current.link.isEnded()) return Promise.resolve(current);
    starting ??= startLive({ id, deps: { ...deps, distro }, stable, closing: closing.signal, bundle: readBundle }).then(adopt, drop);
    return starting;
  };
  const stable: WslMachine = {
    ...members(id, ready, () => lent(deps, distro), deps.ptys),
    // decision 12: the last hello's facts; before the first there is nothing true to answer, so it starts the helper and refuses
    info: () => {
      if (lastInfo !== undefined) return lastInfo;
      void ready().catch(() => undefined); // the failure is the next call's to report
      throw unavailable(id, STARTING);
    },
    close: () => {
      if (closing.signal.aborted) return;
      closing.abort(); // a start in flight ends too: its probe, install or hello wait
      current?.link.stop();
      current = undefined;
    },
  };
  return stable;
}
