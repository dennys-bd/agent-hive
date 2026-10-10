// The daemon's terminals (#251): one pty per pty id, owned by the daemon, not by a window, so closing a tab, a detached window or the main window
// only hides it. Process state like the worker pool: a private Map, never persisted; a worker dies with the daemon.

import { writeFileSync } from 'node:fs';
import type { TerminalSize } from './terminal-wire.js';
import { SLEPT_MAX } from './types.js';

/** The slice of node-pty's IPty the host uses; run.ts hands the real one, tests a fake. */
export interface Pty {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown; // node-pty's own event shape; the console's status reads the code (#537)
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly pid?: number; // node-pty's own (#696): the `sh -c` a terminal's shell runs under; a worktree setup's pipe has none
}

/** What a tab opened late (or reopened) replays first: the run's history, as a terminal's own scrollback shows it. */
export const PTY_SCROLLBACK_BYTES = 1024 * 1024;
const PTY_COLS = 200; // before any page has sent a grid (#808): a worker that prints before any tab opens wraps at 200, not 80
const PTY_ROWS = 50;
const DEFAULT_GRID: TerminalSize = { cols: PTY_COLS, rows: PTY_ROWS };
const LOG_MODE = 0o600; // a terminal's output holds whatever the user typed and printed (#696)

/** What a woken terminal's ring carries right after its seed (#831): the modes a program sets and leaves set when it dies under its
 * terminal, turned off. The replay would turn them on again in every viewer, with that program gone: mouse moves and focus would be typed
 * into the new shell, keys would send application sequences, and the alternate screen, a hidden cursor or colours would hide its output. */
export const MODES_OFF = [
  ...['?9', '?1000', '?1002', '?1003', '?1005', '?1006', '?1015', '?1016'].map((mode) => `\x1b[${mode}l`), // mouse tracking, its encodings
  '\x1b[?2004l', // bracketed paste
  '\x1b[?1l', // application cursor keys
  '\x1b>', // application keypad (DECKPNM)
  '\x1b[?1004l', // focus reporting
  '\x1b[?1047l', // alternate screen: 1047, not 1049, whose leave restores a saved cursor and would put the prompt at a stale or the top row
  '\x1b[?25h', // the cursor shown
  '\x1b[0m', // colours and attributes
].join('');

/** What a pty's end keeps (#672, #696): an agent run's transcript for its sleeping tab ({}); a kept terminal's too, also written to `log` as
 * it ends (synchronously, so a Quit's kills land on disk before the process goes), and `seed`, a woken terminal's old ring, replayed first. */
export interface PtyKeep { log?: string; seed?: string }

export interface PtySpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

/** node-pty's spawn as the host uses it; run.ts hands the real one, the tests a fake. */
export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => Pty;

/** What a server without node-pty (every test that does not care) hands the host: an internal worker then fails to start. */
export const NO_PTY: SpawnPty = () => {
  throw new Error('no pty in this process');
};

export interface PtyHost {
  // throws what spawnPty throws; keep: what outlives it (#672, #696); size: the page's grid (#808), else the largest seen, else 200x50
  spawn(ptyId: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv, keep?: PtyKeep, size?: TerminalSize): void;
  restore(ptyId: string, text: string): void; // #696: a sleeping terminal's saved ring after a boot, served to its sleeping tab
  adopt(ptyId: string, pty: Pty): void; // a pty the host did not spawn (#351): a worktree setup's output, served like a run's
  has(ptyId: string): boolean;
  write(ptyId: string, data: string): boolean; // false: an unknown worker
  resize(ptyId: string, cols: number, rows: number): boolean;
  subscribe(ptyId: string, onData: (data: string) => void, onExit: (exitCode: number) => void): (() => void) | undefined; // the scrollback first
  kill(ptyId: string): boolean;
  pid(ptyId: string): number | undefined; // #696: what a terminal's cwd and its agents are read under; undefined for an unknown or ended one
  forget(ptyId: string): void; // #672: an ended run's kept scrollback goes; a live one keeps none past its exit
}

interface Listener {
  onData(data: string): void;
  onExit(exitCode: number): void;
}

interface Entry {
  pty: Pty;
  chunks: string[];
  size: number;
  listeners: Set<Listener>;
  keep?: PtyKeep;
  grid?: TerminalSize; // #808: the pty's current grid, which a resize to the same is dropped against; a setup's pipe (adopt) has none
}

// An agent run that exited (#672): the tail its sleeping tab replays, and the code its socket closes on
interface Ended {
  text: string;
  exitCode: number;
  pinned?: true; // #696: a kept terminal's, never pushed out by SLEPT_MAX
}

// Old chunks go while what is left still fills the scrollback; the join below trims the head of the oldest one kept.
// ponytail: counts UTF-16 units, not bytes, and the cut can split an escape sequence at the head; xterm's replay tolerates both. A headless
// xterm serializer is the upgrade if it ever shows.
function remember(entry: Entry, chunk: string): void {
  entry.chunks.push(chunk);
  entry.size += chunk.length;
  while (entry.chunks.length > 1 && entry.size - entry.chunks[0].length >= PTY_SCROLLBACK_BYTES) {
    entry.size -= entry.chunks.shift()?.length ?? 0;
  }
}

const scrollback = (entry: Entry): string => entry.chunks.join('').slice(-PTY_SCROLLBACK_BYTES);

// The host's process state, which every helper below reads and writes: the live ptys, the ended ones' tails and the live runs whose tail
// must not outlive them
interface HostMaps {
  entries: Map<string, Entry>;
  ended: Map<string, Ended>; // #672: agent runs that exited, oldest first; #696: and sleeping terminals, pinned
  forgotten: Set<string>; // #672: live runs whose transcript must not outlive them: their tab closed as they slept
  largest?: TerminalSize; // #808: the largest grid a page asked for since boot, each side on its own; never persisted, never shrinks
  onError(message: string): void;
}

// ponytail: the host's own bound, the oldest agent run going past SLEPT_MAX. The reducer's forgetScrollback is the rule, sent for every run
// it does not record too; this only guards against a forget that never arrives. A sleeping terminal's ring is pinned: forget drops it (#696)
function keepEnded({ ended }: HostMaps, ptyId: string, run: Ended): void {
  ended.set(ptyId, run);
  const agents = [...ended].filter(([, e]) => !e.pinned).map(([id]) => id);
  for (const id of agents.slice(0, Math.max(0, agents.length - SLEPT_MAX))) ended.delete(id);
}

// A kept terminal's ring on disk (#696): a failure is reported by its code, never by the path, which holds the home
function persist(h: HostMaps, log: string, text: string): void {
  try {
    writeFileSync(log, text, { mode: LOG_MODE });
  } catch (err) {
    h.onError(`scrollback: ${(err as NodeJS.ErrnoException).code ?? 'write failed'}`);
  }
}

// An ended pty's tail (#672): kept for its sleeping tab; a kept terminal's also written to its log, and pinned (#696)
function end(h: HostMaps, ptyId: string, entry: Entry, exitCode: number): void {
  const text = scrollback(entry);
  const log = entry.keep?.log;
  if (log !== undefined) persist(h, log, text);
  keepEnded(h, ptyId, { text, exitCode, ...(log === undefined ? {} : { pinned: true as const }) });
}

// The pty's exit: its entry leaves, its tail kept as `keep` asks, and every viewer hears it once
function exited(h: HostMaps, ptyId: string, entry: Entry, exitCode: number): void {
  // a terminal woken while this pty still died holds the id now (#696): its entry stays, and no ended tail shadows it
  if (h.entries.get(ptyId) === entry) {
    h.entries.delete(ptyId);
    if (!h.forgotten.delete(ptyId) && entry.keep !== undefined) end(h, ptyId, entry, exitCode);
  }
  for (const listener of entry.listeners) listener.onExit(exitCode);
  entry.listeners.clear();
}

// Serves `pty` as `ptyId`'s: every chunk is kept for a late viewer and handed to the live ones. Its exit drops it, scrollback and all,
// except what `keep` asks for (#672, #696). A spawned pty and a worktree setup's pipe (#351) go the same way. A woken terminal takes its own
// id back from the ended map, its old ring replayed first.
function serve(h: HostMaps, ptyId: string, pty: Pty, keep?: PtyKeep, grid?: TerminalSize): void {
  const entry: Entry = { pty, chunks: [], size: 0, listeners: new Set(), keep, grid };
  h.ended.delete(ptyId);
  // the new shell's prompt below the old output (#696), with the dead program's modes turned off first (#831): in the ring, every viewer
  // gets the reset in order, and the next sleep's log keeps it
  if (keep?.seed !== undefined && keep.seed !== '') remember(entry, `${keep.seed}${MODES_OFF}\r\n`);
  h.entries.set(ptyId, entry);
  pty.onData((data) => {
    remember(entry, data);
    for (const listener of entry.listeners) listener.onData(data);
  });
  pty.onExit(({ exitCode }) => exited(h, ptyId, entry, exitCode));
}

function subscribe(h: HostMaps, ptyId: string, onData: (data: string) => void, onExit: (exitCode: number) => void): (() => void) | undefined {
  const done = h.ended.get(ptyId);
  if (done !== undefined) { // a sleeping run (#672): its kept tail, then its end at once
    if (done.text !== '') onData(done.text);
    onExit(done.exitCode);
    return () => undefined;
  }
  const entry = h.entries.get(ptyId);
  if (!entry) return undefined;
  const text = scrollback(entry);
  if (text !== '') onData(text);
  const listener: Listener = { onData, onExit };
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

function forget(h: HostMaps, ptyId: string): void {
  h.ended.delete(ptyId);
  if (h.entries.has(ptyId)) h.forgotten.add(ptyId);
}

// Runs `use` on a known worker's pty; false for an unknown one or one that ended
function withPty(h: HostMaps, ptyId: string, use: (pty: Pty) => void): boolean {
  const entry = h.entries.get(ptyId);
  if (entry) use(entry.pty);
  return entry !== undefined;
}

// #808: a page's grid, from a spawn or a resize, widens the fallback; a new object each time, so an entry holding the old one never changes
function grow(h: HostMaps, { cols, rows }: TerminalSize): void {
  const seen = h.largest;
  h.largest = seen === undefined ? { cols, rows } : { cols: Math.max(seen.cols, cols), rows: Math.max(seen.rows, rows) };
}

// #808: the grid the pty already has is dropped, so a view that posts it again costs the program no SIGWINCH
function resize(h: HostMaps, ptyId: string, cols: number, rows: number): boolean {
  const entry = h.entries.get(ptyId);
  if (!entry) return false;
  if (entry.grid?.cols === cols && entry.grid.rows === rows) return true;
  entry.pty.resize(cols, rows);
  entry.grid = { cols, rows };
  grow(h, entry.grid);
  return true;
}

/** The daemon's ptys by pty id (#251). An unknown id answers false or undefined, never a throw: the routes pass the page's ids straight in.
 * An agent run's scrollback outlives its exit (#672), until the reducer's forgetScrollback, so its sleeping tab can still show it. */
export function createPtyHost(spawnPty: SpawnPty, onError: (message: string) => void = () => undefined): PtyHost { // onError: the server's log; a test may leave it out
  const h: HostMaps = { entries: new Map(), ended: new Map(), forgotten: new Set(), onError };
  return {
    spawn: (ptyId, [file, ...args], cwd, env, keep, size) => {
      const grid = size ?? h.largest ?? DEFAULT_GRID;
      serve(h, ptyId, spawnPty(file, args, { cwd, env, cols: grid.cols, rows: grid.rows }), keep, grid);
      if (size !== undefined) grow(h, size); // only a page's grid: a fallback spawn widens nothing
    },
    adopt: (ptyId, pty) => serve(h, ptyId, pty),
    subscribe: (ptyId, onData, onExit) => subscribe(h, ptyId, onData, onExit),
    forget: (ptyId) => forget(h, ptyId),
    restore: (ptyId, text) => { if (!h.entries.has(ptyId)) h.ended.set(ptyId, { text, exitCode: 0, pinned: true }); },
    has: (ptyId) => h.entries.has(ptyId) || h.ended.has(ptyId),
    write: (ptyId, data) => withPty(h, ptyId, (pty) => pty.write(data)),
    resize: (ptyId, cols, rows) => resize(h, ptyId, cols, rows),
    kill: (ptyId) => withPty(h, ptyId, (pty) => pty.kill()),
    pid: (ptyId) => h.entries.get(ptyId)?.pty.pid,
  };
}
