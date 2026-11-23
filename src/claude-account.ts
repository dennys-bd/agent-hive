// #955: `claude setup-token` in a pty of the daemon's own, never the pty host's, whose scrollback ring would keep the token, and the parse of
// what it prints. One add at a time; its screen lives in memory only, for the parse, and goes when the add ends.
import type { ClaudeCredential } from './credentials.js';
import type { Logger } from './log.js';
import type { Pty, SpawnPty } from './pty-host.js';
import type { ClaudeAccountError, ClaudeAddStatus } from './types.js';

export const SETUP_TOKEN_COLS = 512; // the 108-character token never wraps: at 80 columns the stripped line breaks glued the next line onto it
export const SETUP_TOKEN_ROWS = 50;
export const ADD_TIMEOUT_MS = 10 * 60 * 1000; // a forgotten add never holds a pty until the daemon restarts
export const CURSOR_ANSWER = '\x1b[1;1R';
const CURSOR_QUERY = '\x1b[6n'; // the CLI's renderer waits for its answer before drawing (spike appendix A)
const SCREEN_CHARS = 64 * 1024;
const MAX_NAME_LENGTH = 40;
const RESERVED_NAME = 'add'; // DELETE /settings/accounts/claude/add is the cancel: an account by that name could never be removed

// CSI, OSC (ended by BEL or ST), any other ESC sequence, and the line breaks
// biome-ignore lint/suspicious/noControlCharactersInRegex: the screen's escapes are what is replaced
const SCREEN_CONTROLS = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]|[\r\n]/g;
// At least 80 characters and a boundary after it: a run that touches the end of the buffer may still be arriving in the next chunk
const TOKEN = /sk-ant-oat01-[\w-]{67,}(?=[^\w-])/;
const URL_RUN = /https:\/\/\S+(?=\s)/;

/** The raw screen with every escape sequence, `\r` and `\n` turned into a space: deleting one would glue two runs into one. */
export const plainScreen = (raw: string): string => raw.replace(SCREEN_CONTROLS, ' ');
export const tokenFrom = (screen: string): string | undefined => TOKEN.exec(screen)?.[0];
/** The sign-in link #965 shows whether or not the CLI could open a browser. */
export const urlFrom = (screen: string): string | undefined => URL_RUN.exec(screen)?.[0];
export const trimmedName = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/** Why `raw` cannot name a new account; a body whose name is no string reads as empty. Compared without regard to case. */
export function nameRefusal(raw: unknown, names: readonly string[]): ClaudeAccountError | undefined {
  const name = trimmedName(raw);
  if (name === '') return 'name-empty';
  if ([...name].length > MAX_NAME_LENGTH) return 'name-too-long';
  const folded = name.toLowerCase();
  return folded === RESERVED_NAME || names.some((stored) => stored.toLowerCase() === folded) ? 'name-taken' : undefined;
}

export interface ClaudeAddDeps {
  spawnPty: SpawnPty; // the daemon's node-pty, never the pty host
  command: string; // agentCommand's: the word a worker's claude starts with
  env: NodeJS.ProcessEnv;
  cwd: string;
  save: (name: string, cred: ClaudeCredential) => Promise<void>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface ClaudeAdd {
  start(name: string): ClaudeAddStatus | undefined; // undefined: an add is pending already, and goes on
  status(): ClaudeAddStatus;
  cancel(): void; // nothing pending: no change
  close(): void; // the daemon's close: a pending pty is killed
}

type Ended = Extract<ClaudeAddStatus, { state: 'connected' | 'failed' | 'cancelled' }>;

// One add's process state. isEnded: captured, cancelled, timed out or exited, so a late chunk, exit or timer changes nothing
interface Flow { name: string; pty?: Pty; screen: string; url?: string; timer?: ReturnType<typeof setTimeout>; isEnded: boolean }
// The flow while one runs (or stores its token), else how the last one ended, until the next start
interface AddState { flow?: Flow; ended: ClaudeAddStatus }

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const pendingOf = (f: Flow): ClaudeAddStatus => ({ state: 'pending', name: f.name, ...(f.url === undefined ? {} : { url: f.url }) });

function logEnd(log: ClaudeAddDeps['log'], next: Ended, detail: string): void {
  if (next.state === 'failed') log.warn(`claude account add failed: ${next.name} (${next.reason}${detail})`);
  else log.info(`claude account add ${next.state}: ${next.name}`);
}

// The one move out of pending, only for the flow that is still the add's: an identity guard, as githubFlow === flow
function finish(s: AddState, f: Flow, next: Ended, log: ClaudeAddDeps['log'], detail = ''): void {
  if (s.flow !== f) return;
  s.flow = undefined; // the screen goes with it
  s.ended = next;
  logEnd(log, next, detail);
}

// Marked ended before the kill, since a pty may exit inside kill()
function stop(f: Flow, log: ClaudeAddDeps['log']): void {
  f.isEnded = true;
  clearTimeout(f.timer);
  try {
    f.pty?.kill();
  } catch (err) {
    log.warn(`claude account add: the pty of ${f.name} not killed: ${errorMessage(err)}`);
  }
}

function capture(s: AddState, deps: ClaudeAddDeps, f: Flow, token: string): void {
  stop(f, deps.log);
  void deps.save(f.name, { token }).then(
    () => finish(s, f, { state: 'connected', name: f.name }, deps.log),
    (err: unknown) => {
      deps.log.error(`claude account ${f.name} not stored: ${errorMessage(err)}`);
      finish(s, f, { state: 'failed', name: f.name, reason: 'store' }, deps.log);
    },
  );
}

function feed(s: AddState, deps: ClaudeAddDeps, f: Flow, chunk: string): void {
  if (f.isEnded) return;
  if (chunk.includes(CURSOR_QUERY)) f.pty?.write(CURSOR_ANSWER); // ponytail: a query split across two chunks goes unanswered; the CLI writes it whole
  // ponytail: counts UTF-16 units and the cut may split an escape at the head; the token is at the tail
  f.screen = (f.screen + chunk).slice(-SCREEN_CHARS);
  const plain = plainScreen(f.screen);
  f.url ??= urlFrom(plain);
  const token = tokenFrom(plain);
  if (token !== undefined) capture(s, deps, f, token);
}

function begin(s: AddState, deps: ClaudeAddDeps, name: string): ClaudeAddStatus {
  deps.log.info(`claude account add started: ${name}`);
  const f: Flow = { name, screen: '', isEnded: false };
  let pty: Pty;
  try {
    pty = deps.spawnPty(deps.command, ['setup-token'], { cwd: deps.cwd, env: deps.env, cols: SETUP_TOKEN_COLS, rows: SETUP_TOKEN_ROWS });
  } catch (err) {
    const failed: Ended = { state: 'failed', name, reason: 'exited' };
    s.ended = failed;
    logEnd(deps.log, failed, `, spawn: ${errorMessage(err)}`);
    return failed;
  }
  f.pty = pty;
  s.flow = f;
  pty.onData((chunk) => feed(s, deps, f, chunk));
  pty.onExit(({ exitCode }) => {
    if (f.isEnded) return;
    f.isEnded = true; // no kill: the process is gone
    clearTimeout(f.timer);
    finish(s, f, { state: 'failed', name, reason: 'exited' }, deps.log, ` ${exitCode}`);
  });
  f.timer = setTimeout(() => {
    if (f.isEnded) return;
    stop(f, deps.log);
    finish(s, f, { state: 'failed', name, reason: 'timeout' }, deps.log);
  }, ADD_TIMEOUT_MS);
  return pendingOf(f);
}

/** The one Claude account add of the daemon (#955). Its state is process state, never persisted: a restart reads idle. */
export function createClaudeAdd(deps: ClaudeAddDeps): ClaudeAdd {
  const s: AddState = { ended: { state: 'idle' } };
  return {
    start: (name) => (s.flow === undefined ? begin(s, deps, name) : undefined),
    status: () => (s.flow === undefined ? s.ended : pendingOf(s.flow)),
    cancel: () => {
      const f = s.flow;
      if (f === undefined || f.isEnded) return; // a captured token is being stored: its end is the store's
      stop(f, deps.log);
      finish(s, f, { state: 'cancelled', name: f.name }, deps.log);
    },
    close: () => {
      const f = s.flow;
      if (f === undefined) return;
      if (!f.isEnded) stop(f, deps.log);
      s.flow = undefined;
    },
  };
}
