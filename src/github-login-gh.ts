// #960: a GitHub login added through gh's browser login. gh runs on pipes, never in a pty: with stdin not a TTY it asks nothing and never
// offers to set up git (probed on gh 2.97). Its GH_CONFIG_DIR is a scratch dir of the Hive's home, so the machine's hosts.yml is never
// opened. One add at a time; what gh prints lives in memory only, for the code and the URL.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { join } from 'node:path';
import { resolveExec } from './exec-path.js';
import { childEnv, cliEnv, GITHUB_HOST, TOKEN_CHARS } from './github-token.js';
import type { Logger } from './log.js';
import type { Exec, GithubAddStatus } from './types.js';

// --hostname and --git-protocol close the two prompts gh would otherwise need; --insecure-storage writes the token into the scratch hosts.yml
export const GH_LOGIN_ARGS: readonly string[] = ['auth', 'login', '--web', '--insecure-storage', '--hostname', GITHUB_HOST, '--git-protocol', 'https'];
const TOKEN_ARGS = ['auth', 'token', '--hostname', GITHUB_HOST];
export const GH_ADD_TIMEOUT_MS = 10 * 60 * 1000; // a forgotten add never holds gh until the daemon restarts
const TOKEN_TIMEOUT_MS = 10_000;
const OUTPUT_CHARS = 16 * 1024;
const SCRATCH_MODE = 0o700; // gh writes the token into it
const REMOVE = { recursive: true, force: true } as const;
const CODE = /one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/;
const URL_RUN = /https:\/\/\S+(?=\s)/;

export type SpawnGh = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface GhLoginFs {
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export interface GithubAddDeps {
  spawn: SpawnGh; // node:child_process's; tests replace it
  exec: Exec; // gh auth token
  env: NodeJS.ProcessEnv; // the daemon's minus the Hive's own (withoutHiveEnv)
  platform: NodeJS.Platform; // resolveExec's: on win32 gh is found by its full path
  home: string;
  fs: GhLoginFs;
  store: (token: string) => Promise<string>; // the device flow's store: the token's viewer names the login it answers
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface GithubAdd {
  start(): GithubAddStatus | undefined; // undefined: an add is pending already, and goes on
  status(): GithubAddStatus;
  cancel(): void; // nothing pending: no change
  close(): Promise<void>; // the daemon's close: a pending gh is killed; settles once the scratch dir's removal ran
}

/** The one scratch GH_CONFIG_DIR: one add at a time, so one fixed path is enough. */
export const scratchDir = (home: string): string => join(home, 'gh-login');

type Ended = Extract<GithubAddStatus, { state: 'connected' | 'failed' | 'cancelled' }>;
type FailReason = Extract<GithubAddStatus, { state: 'failed' }>['reason'];

// One add's process state. isEnded: exited, cancelled, timed out or failed to start, so a late chunk, exit or timer changes nothing
interface Flow { env: NodeJS.ProcessEnv; child?: ChildProcess; output: string; code?: string; url?: string; timer?: ReturnType<typeof setTimeout>; isEnded: boolean }
// The flow while one runs (or reads and stores its token), else how the last one ended; fs: the scratch dir's steps, in turn
interface AddState { flow?: Flow; ended: GithubAddStatus; fs: Promise<void> }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const failed = (reason: FailReason): Ended => ({ state: 'failed', reason });
const pendingOf = (f: Flow): GithubAddStatus =>
  ({ state: 'pending', ...(f.code === undefined ? {} : { code: f.code }), ...(f.url === undefined ? {} : { url: f.url }) });

// Every removal and the start's making run one after another: an end's removal never lands on the next add's fresh dir
function queueFs(s: AddState, op: () => Promise<unknown>): Promise<void> {
  const next = s.fs.then(op).then(() => undefined);
  s.fs = next.catch(() => undefined);
  return next;
}

// A removal that fails is logged: the status is the add's end, never its cleanup's
function removeScratch(s: AddState, deps: GithubAddDeps): void {
  queueFs(s, () => deps.fs.rm(scratchDir(deps.home), REMOVE)).catch((err: unknown) => {
    deps.log.warn(`github login add: the scratch dir not removed: ${errorMessage(err)}`);
  });
}

function logEnd(log: GithubAddDeps['log'], next: Ended, detail: string): void {
  if (next.state === 'failed') log.warn(`github login add failed (${next.reason}${detail})`);
  else if (next.state === 'connected') log.info(`github login add connected: ${next.login}`);
  else log.info('github login add cancelled');
}

// The one move out of pending, only for the flow that is still the add's; the scratch dir goes with it
function finish(s: AddState, deps: GithubAddDeps, f: Flow, next: Ended, detail = ''): void {
  if (s.flow !== f) return;
  s.flow = undefined; // gh's words go with it
  s.ended = next;
  logEnd(deps.log, next, detail);
  removeScratch(s, deps);
}

// Marked ended before the kill, since a child may exit inside kill()
function stop(f: Flow, log: GithubAddDeps['log']): void {
  f.isEnded = true;
  clearTimeout(f.timer);
  try {
    f.child?.kill();
  } catch (err) {
    log.warn(`github login add: gh not killed: ${errorMessage(err)}`);
  }
}

// A start that cannot run gh: found nowhere on win32, an ENOENT error event, or a scratch dir that cannot be made
function failStart(s: AddState, deps: GithubAddDeps, f: Flow, detail: string): void {
  if (f.isEnded) return;
  stop(f, deps.log);
  finish(s, deps, f, failed('exited'), detail);
}

// gh's own words, the last 16 KiB, read for the code and the URL only; neither is the token
function read(f: Flow, chunk: string): void {
  if (f.isEnded) return;
  f.output = (f.output + chunk).slice(-OUTPUT_CHARS);
  f.code ??= CODE.exec(f.output)?.[1];
  f.url ??= URL_RUN.exec(f.output)?.[0];
}

// gh reads its own file, so the Hive never parses hosts.yml for a token. A failed or malformed read is no token
async function readToken(deps: GithubAddDeps, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { stdout } = await deps.exec('gh', TOKEN_ARGS, { env, timeout: TOKEN_TIMEOUT_MS }).catch(() => ({ stdout: '' }));
  const token = stdout.trim();
  return TOKEN_CHARS.test(token) ? token : undefined;
}

// After exit 0: the token, then the device flow's store, which keys the login by what the token's viewer answers
async function collect(s: AddState, deps: GithubAddDeps, f: Flow): Promise<void> {
  const token = await readToken(deps, f.env);
  if (token === undefined) return finish(s, deps, f, failed('token'), ', exit 0');
  if (s.flow !== f) return; // closed while gh auth token ran: a stopped add never stores
  try {
    const login = await deps.store(token);
    finish(s, deps, f, { state: 'connected', login });
  } catch (err) {
    deps.log.error(`github login add: not stored: ${errorMessage(err)}`);
    finish(s, deps, f, failed('store'), ', exit 0');
  }
}

function exited(s: AddState, deps: GithubAddDeps, f: Flow, code: number | null, signal: NodeJS.Signals | null): void {
  if (f.isEnded) return;
  f.isEnded = true; // the process is gone: nothing to kill, and a cancel now leaves the end to the token's read and store
  clearTimeout(f.timer);
  if (code === 0) return void collect(s, deps, f);
  finish(s, deps, f, failed('exited'), `, exit ${code ?? signal}`);
}

// exit, not close: a browser gh opens may inherit the pipes and hold close back
function run(s: AddState, deps: GithubAddDeps, f: Flow): void {
  if (f.isEnded) return; // cancelled or timed out while the dir was made: that end queued the removal behind the making
  let child: ChildProcess;
  try {
    const command = resolveExec('gh', GH_LOGIN_ARGS, { platform: deps.platform, env: f.env });
    child = deps.spawn(command.file, [...command.args], {
      env: { ...f.env, ...command.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
  } catch (err) {
    failStart(s, deps, f, `, spawn: ${errorMessage(err)}`);
    return;
  }
  f.child = child;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => read(f, chunk));
  }
  child.on('error', (err) => failStart(s, deps, f, `, spawn: ${errorMessage(err)}`));
  child.on('exit', (code, signal) => exited(s, deps, f, code, signal));
}

function begin(s: AddState, deps: GithubAddDeps): GithubAddStatus {
  deps.log.info('github login add started');
  const dir = scratchDir(deps.home);
  // GH_TOKEN and its kin removed: gh refuses to log in while GH_TOKEN is set; GH_DEBUG would put its HTTP traffic in the output we read
  const f: Flow = { env: childEnv(deps.env, { ...cliEnv(), GH_DEBUG: undefined, DEBUG: undefined, GH_CONFIG_DIR: dir }), output: '', isEnded: false };
  s.flow = f;
  f.timer = setTimeout(() => {
    if (f.isEnded) return;
    stop(f, deps.log);
    finish(s, deps, f, failed('timeout'));
  }, GH_ADD_TIMEOUT_MS);
  // What a crash left is removed first
  void queueFs(s, async () => {
    await deps.fs.rm(dir, REMOVE);
    await deps.fs.mkdir(dir, { mode: SCRATCH_MODE });
  }).then(
    () => run(s, deps, f),
    (err: unknown) => failStart(s, deps, f, `, scratch: ${errorMessage(err)}`),
  );
  return pendingOf(f);
}

/** The one GitHub login add of the daemon (#960). Its state is process state, never persisted: a restart reads idle. */
export function createGithubAdd(deps: GithubAddDeps): GithubAdd {
  const s: AddState = { ended: { state: 'idle' }, fs: Promise.resolve() };
  return {
    start: () => (s.flow === undefined ? begin(s, deps) : undefined),
    status: () => (s.flow === undefined ? s.ended : pendingOf(s.flow)),
    cancel: () => {
      const f = s.flow;
      if (f === undefined || f.isEnded) return; // gh exited 0: the token's read and store end it
      stop(f, deps.log);
      finish(s, deps, f, { state: 'cancelled' });
    },
    close: async () => {
      const f = s.flow;
      if (f !== undefined) {
        if (!f.isEnded) stop(f, deps.log);
        s.flow = undefined;
        removeScratch(s, deps);
      }
      await s.fs;
    },
  };
}
