// The daemon launcher shared by bin/hive.js and the viewer (main.ts). Plain Node: no electron, no server.ts (Express) import.
// `home` is always hiveHome() of the environment the daemon inherits (XDG_CONFIG_HOME or HIVE_HOME, #310): run.js boots that same home, so the probe finds it there.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE } from './config.js';
import { lockAgeMs, pidExists, readDaemonPort, readDaemonSecret, readLockPid, WAIT_MS } from './daemon-files.js';
import { LOG_FILE } from './log.js';
import { SECRET_HEADER } from './secret.js';
import { type LivePty, type Signal, type Theme, THEMES } from './types.js';

export { readDaemonPort as daemonPort } from './daemon-files.js';

export type Probe = { status: 'free' } | { status: 'hive'; home: string } | { status: 'foreign' };

/** Where this home's daemon listens and what opens it (#466, #467): hive.port and hive.secret. */
export interface DaemonAddress {
  port: number;
  secret: string;
}

/** What ensureDaemon answers: the port and the secret it probed together (#467), and the pid of a daemon started by this call. */
export interface StartedDaemon extends DaemonAddress {
  pid?: number;
}

/** A boot that did not answer: the child died, or WAIT_MS passed with it still running. `pid` is the child it spawned, so a caller that
 *  must not leave it behind can end it (#786). */
export class DaemonBootError extends Error {
  readonly pid: number | undefined;
  constructor(message: string, pid: number | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonBootError';
    this.pid = pid;
  }
}

export type DaemonStatus =
  | { state: 'running' }
  | { state: 'setup'; reason?: string }
  | { state: 'stopped'; reason?: string } // reason: lastLogError of hive.log
  | { state: 'blocked'; reason: string };

const RUN_JS = new URL('./run.js', import.meta.url); // the daemon is always the build next to this module
const PROBE_TIMEOUT_MS = 1000;
const STOP_TIMEOUT_MS = 5000; // the answer comes before close() runs, so a daemon that takes longer is not ours to wait for
const POLL_MS = 200;
const LOG_TAIL_LINES = 20;
const NOT_RUNNING = 'Agent Hive não está em execução';
const HTTP_FORBIDDEN = 403;
const UI_HEADER = 'x-hive-ui'; // mirrors UI_HEADER in server-events.ts, which cannot be imported here (it pulls Express into the CLI)
const HOME_MODE = 0o700; // the home holds the log, the prompts and the credentials
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/g;
const FORMAT_CHARS = /\p{Cf}/gu; // bidi overrides, zero-width: they could disguise a line of the OS menu
// hive.log markers (#194): hive.ts's boot line (hive and setup mode), server.ts's POST /stop line, log.ts's ERROR tag
const BOOT_MARK = ' boot home=';
const STOP_MARK = 'stop requested';
const ERROR_LINE = /^\S+ ERROR (.*)$/;

// Text from the daemon or its log, bound for an OS menu line
const clean = (text: string): string => text.replace(CONTROL_CHARACTERS, '').replace(FORMAT_CHARS, '');

const logPath = (home: string): string => join(home, LOG_FILE);
const settingsUrl = (port: number): string => `http://127.0.0.1:${port}/settings`;
// Every request carries this boot's secret (#467); the daemon refuses anything without it
const secretHeaders = (secret: string, extra: Record<string, string> = {}): Record<string, string> => ({ [SECRET_HEADER]: secret, ...extra });

// hive.config.json as parsed JSON, undefined when missing or unreadable: the launcher and the window read single keys of it raw, before and
// without parseConfig. The daemon reports a bad file on boot; these readers just fall back to the default.
function rawConfig(home: string): unknown {
  try {
    return JSON.parse(readFileSync(join(home, CONFIG_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The theme of `hive.config.json` for the windows' first paint (#296): system when the file is missing, unparsable or names no theme. Never throws. */
export function configuredTheme(home: string): Theme {
  const raw = rawConfig(home);
  const theme = typeof raw === 'object' && raw !== null ? (raw as { theme?: unknown }).theme : undefined;
  return THEMES.includes(theme as Theme) ? (theme as Theme) : 'system';
}

const isRefused = (err: unknown): boolean => (err as { cause?: { code?: string } } | undefined)?.cause?.code === 'ECONNREFUSED';

/** What holds the port: nothing (refused), a Hive (its home, control characters stripped), or something else (any other answer, a 403 to
 *  this secret, a timeout, a reset). */
export async function probe(port: number, secret: string): Promise<Probe> {
  let res: Response;
  try {
    // redirect: 'error': whoever holds the port must answer itself, never send the probe somewhere else
    res = await fetch(settingsUrl(port), { headers: secretHeaders(secret), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'error' });
  } catch (err) {
    return isRefused(err) ? { status: 'free' } : { status: 'foreign' }; // only a refused connection means free
  }
  if (res.status === HTTP_FORBIDDEN) {
    // a daemon whose secret is not the recorded one (#467): hive.secret belongs to another boot, so this one is not ours to talk to
    await res.body?.cancel();
    return { status: 'foreign' };
  }
  const body: unknown = await res.json().catch(() => undefined);
  const home = typeof body === 'object' && body !== null ? (body as { home?: unknown }).home : undefined;
  return typeof home === 'string' ? { status: 'hive', home: clean(home) } : { status: 'foreign' };
}

// Both paths compared through their real path: a temp dir on macOS is reached through /var -> /private/var.
function sameHome(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false; // the other Hive's home may not even exist here
  }
}

/** hive.port and hive.secret as this home recorded them; undefined when either is missing: no daemon to reach (#466, #467). */
export function recordedDaemon(home: string): DaemonAddress | undefined {
  // The reverse of the daemon's write order (hive.port, then hive.secret): a boot landing between the two reads pairs its new port with the
  // old secret, which the probe refuses, never a new secret with an old port, which could hand the new secret to whoever holds that port.
  const secret = readDaemonSecret(home);
  const port = readDaemonPort(home);
  return port === undefined || secret === undefined ? undefined : { port, secret };
}

/** True when this home's Hive answers at `daemon` (#466, #467). None recorded, a refused port, a foreign program, a 403 to the secret or
 *  another home's Hive are all "not ours": a new daemon of this home moves to another port instead of refusing. */
export async function isOurHive(daemon: DaemonAddress | undefined, home: string): Promise<boolean> {
  if (daemon === undefined) return false;
  const seen = await probe(daemon.port, daemon.secret);
  return seen.status === 'hive' && sameHome(seen.home, home);
}

/** The recorded address when this home's Hive answers there; undefined when nothing of ours does (#466, #467). Read once per client call:
 *  the request that follows uses the same port and secret. */
export async function ourDaemon(home: string): Promise<DaemonAddress | undefined> {
  const daemon = recordedDaemon(home);
  return (await isOurHive(daemon, home)) ? daemon : undefined;
}

// Reads every 200 ms until `read` answers, up to 30 s; `gone` ends the wait early (the child exited)
async function pollFor<T>(read: () => Promise<T | undefined>, gone: () => boolean = () => false): Promise<T | undefined> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (gone()) return undefined;
    const value = await read();
    if (value !== undefined) return value;
    await sleep(POLL_MS);
  }
  return undefined;
}

// The last lines of the log, each stripped of control characters: they carry task titles, hook names and gh stderr, and the
// tail goes straight to the terminal.
function logTail(log: string): string {
  try {
    return readFileSync(log, 'utf8').trimEnd().split('\n').slice(-LOG_TAIL_LINES)
      .map((line) => line.replace(CONTROL_CHARACTERS, '')).join('\n');
  } catch {
    return '';
  }
}

/** The env of the daemon it starts: the parent's, ELECTRON_RUN_AS_NODE (an Electron execPath runs run.js as plain Node) and, from the
 *  viewer, HIVE_LOCALE (#242): its app.getLocale(), which run.js hands to bootHive so the main window and the menus pick the same language. */
export function daemonEnv(env: NodeJS.ProcessEnv, locale?: string): NodeJS.ProcessEnv {
  return { ...env, ELECTRON_RUN_AS_NODE: '1', ...(locale === undefined ? {} : { HIVE_LOCALE: locale }) };
}

// run.js detached, stdout/stderr appended to hive.log, like the Electron process was. process.execPath is Node from the CLI and
// Electron from the viewer: ELECTRON_RUN_AS_NODE makes both run run.js as plain Node. spawn() dups the fd into the child before
// it returns, so the parent's copy is closed right away, whether or not the child comes up.
function spawnDaemon(home: string, locale?: string): ChildProcess {
  mkdirSync(home, { recursive: true, mode: HOME_MODE });
  const fd = openSync(logPath(home), 'a', 0o600); // the log is only for this user
  try {
    return spawn(process.execPath, [fileURLToPath(RUN_JS)], { // no argument: run.js boots hiveHome() (#202)
      detached: true,
      stdio: ['ignore', fd, fd],
      env: daemonEnv(process.env, locale),
    });
  } finally {
    closeSync(fd);
  }
}

// A daemon launched alongside won the lock (#466): the lock names a live pid that is not this child's, so the wait goes on for it. Only a
// young lock counts: the file keeps a dead daemon's pid after a crash (#479), and a reused pid would keep a failed start waiting the whole 30 s.
function rivalHolds(home: string, child: number | undefined): boolean {
  const pid = readLockPid(home);
  return pid !== undefined && pid !== child && pidExists(pid) && lockAgeMs(home) < WAIT_MS;
}

// hive.port is polled, not a port chosen here: the daemon binds its last port or one the OS picks and records it after the bind (#466)
async function startDaemon(home: string, locale?: string): Promise<StartedDaemon> {
  const child = spawnDaemon(home, locale);
  let exited = false;
  let spawnError: DaemonBootError | undefined;
  // wrapped here, so every rejection of startDaemon has one shape and carries the pid the child had (#786)
  child.once('error', (err) => { spawnError = new DaemonBootError(err.message, child.pid, { cause: err }); exited = true; });
  child.once('exit', () => { exited = true; });
  child.unref();
  const gone = (): boolean => exited && !rivalHolds(home, child.pid);
  const daemon = await pollFor(() => ourDaemon(home), gone);
  if (daemon !== undefined) return exited ? daemon : { ...daemon, pid: child.pid }; // exited: the rival's daemon answered, not the one started here
  // The child died (a config error is already in the log) or 30 s passed (left running: it may still come up). The tail is the diagnosis;
  // the pid lets a caller that must not leave the child behind end it (#786).
  throw spawnError ?? new DaemonBootError(`Agent Hive não subiu (veja ${logPath(home)})\n${logTail(logPath(home))}`, child.pid);
}

/** The daemon of `home` on the port hive.port names: found (no pid) or started (with its pid) (#466). Nothing of ours there, whether the
 *  port is refused, foreign or another home's, starts one. `locale` is the viewer's (#242) and reaches only a daemon started here; one
 *  already running keeps the language it booted with. */
export async function ensureDaemon(home: string, locale?: string): Promise<StartedDaemon> {
  const daemon = await ourDaemon(home);
  return daemon ?? startDaemon(home, locale);
}

// GET /ptys on our daemon (#193, #192, #570): the answer's status and its JSON object ({} when not ok or not an object); undefined when nothing
// of ours runs (#466)
async function getPtys(home: string): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const daemon = await ourDaemon(home);
  if (daemon === undefined) return undefined;
  const res = await fetch(`http://127.0.0.1:${daemon.port}/ptys`, { headers: secretHeaders(daemon.secret), signal: AbortSignal.timeout(STOP_TIMEOUT_MS), redirect: 'error' });
  const body: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
  return { status: res.status, body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {} };
}

const unanswered = (status: number): Error => new Error(`o Hive não informou as execuções e os terminais: HTTP ${status}`);

/** How many sessions a stop would kill (#193). 0 when nothing is running. */
export async function activeWorkers(home: string): Promise<number> {
  const answer = await getPtys(home);
  if (!answer) return 0;
  const { active } = answer.body;
  // no count, no stop: Quit shows this instead of stopping a daemon it could not ask
  if (typeof active !== 'number') throw unanswered(answer.status);
  return active;
}

/** The menu bar's lines (#192, #570), in worker order, terminals last. [] when nothing is running. */
export async function livePtys(home: string): Promise<LivePty[]> {
  const answer = await getPtys(home);
  if (!answer) return [];
  const { ptys } = answer.body;
  // a daemon from before #570, or a line of another shape: the caller logs it and shows no line
  if (!Array.isArray(ptys) || !ptys.every(isLivePty)) throw unanswered(answer.status);
  // the label is an issue title shown in the OS menu: format characters (bidi overrides, zero-width) could disguise the line
  return ptys.map((p) => ({ ...p, label: p.label.replace(FORMAT_CHARS, '') }));
}

const MENU_LABEL_MAX = 35;
// \p{Cs}: a lone surrogate left when the cut splits an emoji
const TRAILING_BREAK = /[\s\p{P}\p{Cs}]+$/u;

/** A worker line's label in the menu (#243): past MENU_LABEL_MAX it is cut at the last space after the task number, else hard, plus "…". */
export function menuLabel(label: string): string {
  if (label.length <= MENU_LABEL_MAX) return label;
  const head = label.slice(0, MENU_LABEL_MAX - 1);
  const space = head.lastIndexOf(' ');
  const cut = space > head.indexOf(' ') ? head.slice(0, space) : head;
  return `${cut.replace(TRAILING_BREAK, '')}…`;
}

const LIVE_STATUSES: readonly unknown[] = ['working', 'waiting', 'review', 'approval', 'backoff', 'terminal'] satisfies LivePty['status'][];

function isLivePty(value: unknown): value is LivePty {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  // no taskId: a workspace's terminal (#292) or local session (#587)
  return typeof p.id === 'string' && (p.taskId === undefined || typeof p.taskId === 'string') && typeof p.label === 'string' && LIVE_STATUSES.includes(p.status);
}

/** POST /stop on our daemon, then wait until its port no longer answers as this home (#466): a program may take the freed port at once.
 *  False when nothing of ours was running. */
export async function stopDaemon(home: string): Promise<boolean> {
  const daemon = await ourDaemon(home);
  if (daemon === undefined) return false;
  const res = await fetch(`http://127.0.0.1:${daemon.port}/stop`, {
    method: 'POST', headers: secretHeaders(daemon.secret, { [UI_HEADER]: '1' }), signal: AbortSignal.timeout(STOP_TIMEOUT_MS), redirect: 'error',
  });
  if (!res.ok) throw new Error(`Agent Hive recusou o stop: HTTP ${res.status}`); // a daemon without onStop (an older build)
  // polled with the address it stopped: run.ts removes hive.secret only once the port is closed
  const gone = await pollFor(async () => ((await isOurHive(daemon, home)) ? undefined : true));
  if (!gone) throw new Error('Agent Hive não parou em 30 s (pid no log)');
  return true;
}

/** The menu bar's writes (#196): POST on the port hive.port names, as the main window does. Who answers is checked first: a stale hive.port
 *  now held by another home's Hive must not get the x-hive-ui POST (#466). No port rejects with `Agent Hive não está em execução`; a refusal
 *  rejects with the daemon's own error text, or with `refusal` and the status when it sent none. */
async function postToDaemon(home: string, path: string, body: unknown, refusal: string): Promise<void> {
  const daemon = await ourDaemon(home);
  if (daemon === undefined) throw new Error(NOT_RUNNING);
  const res = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
    method: 'POST',
    headers: secretHeaders(daemon.secret, { [UI_HEADER]: '1', 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.ok) return;
  const answer: unknown = await res.json().catch(() => undefined);
  const error = typeof answer === 'object' && answer !== null ? (answer as { error?: unknown }).error : undefined;
  throw new Error(typeof error === 'string' ? clean(error) : `${refusal}: HTTP ${res.status}`);
}

/** The menu bar's signal radios (#196). */
export const setSignal = (home: string, signal: Signal): Promise<void> => postToDaemon(home, '/signal', { signal }, 'Agent Hive recusou o sinal');


/** Why the daemon that last booted into this log is gone (#194): the message of the last ERROR line after the last boot line (the whole
 *  text when there is none), for an OS menu line. undefined when there is none, or when the stop was requested. */
// ponytail: a daemon killed by a signal, or one that died without logging an ERROR (run.ts's fatal boot error is a plain stderr line),
// shows the last runtime error or none. A crash marker written by run.ts would close that gap if it matters.
export function lastLogError(log: string): string | undefined {
  const lines = log.split('\n');
  const run = lines.slice(lines.map((line) => line.includes(BOOT_MARK)).lastIndexOf(true) + 1); // -1 + 1: the whole text
  if (run.some((line) => line.includes(STOP_MARK))) return undefined;
  const message = run.map((line) => ERROR_LINE.exec(line)?.[1]).filter((m): m is string => m !== undefined).at(-1);
  return message === undefined ? undefined : clean(message);
}

// lastLogError of this home's hive.log; none when the file is missing or unreadable
function logError(home: string): string | undefined {
  try {
    return lastLogError(readFileSync(logPath(home), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The menu bar's status line (#194). Never rejects: a fetch that fails once the probe found our Hive is `blocked`, with its message. */
export async function daemonStatus(home: string): Promise<DaemonStatus> {
  try {
    const daemon = await ourDaemon(home);
    if (daemon === undefined) return { state: 'stopped', reason: logError(home) };
    const res = await fetch(settingsUrl(daemon.port), { headers: secretHeaders(daemon.secret), signal: AbortSignal.timeout(STOP_TIMEOUT_MS), redirect: 'error' });
    const body: unknown = await res.json().catch(() => undefined);
    const { configured, error } = (typeof body === 'object' && body !== null ? body : {}) as { configured?: unknown; error?: unknown };
    if (configured === true) return { state: 'running' };
    // setup mode: setupFallback.error says why the saved config did not boot; none when there is simply no file
    return { state: 'setup', reason: typeof error === 'string' ? clean(error) : undefined };
  } catch (err) {
    return { state: 'blocked', reason: clean((err as Error).message) };
  }
}
