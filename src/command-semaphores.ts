import { isDeepStrictEqual } from 'node:util';
import { resolveImpl } from './run-commands.js';
import { timeoutMs } from './timeout.js';
import { type CombConfig, type Command, type CommandSemaphore, type Config, ENV_NAME, type SemaphoreEvent, type SemaphoreState } from './types.js';

// The Command Semaphores at run time (#798): per semaphore its permits, its line and its turns, in memory only, never persisted, so a restart
// starts every semaphore free. Every change ends in one setSemaphores; a turn given dispatches its semaphoreTurn first. Time enters through
// now() and the sweep, never through the reducer. The daemon alone matches an argv against the lines with a semaphore in the pty's workspace.

export interface SemaphoreLine { semaphore: string; words: string[] }

// Decision 1: the first command ends at the first ;, & or | (&& and || included), so 2>&1 is cut to a redirect, which never matches
const FIRST_COMMAND_END = /[;&|]/;
// A word the daemon would have to expand (a quote, $, a backtick, a redirect, a glob, a parenthesis, an escape, ~ or a brace) cannot be compared
// with an argv: the line never matches instead of matching wrong
const UNMATCHABLE = /['"`$<>*?[\](){}~\\]/;

const isAssignment = (word: string): boolean => {
  const at = word.indexOf('=');
  return at > 0 && ENV_NAME.test(word.slice(0, at));
};

/** The words a line matches by (#798, decision 1): its first command's, its leading NAME=value words skipped; undefined = it never matches. */
export function lineWords(command: string): string[] | undefined {
  const first = command.split(FIRST_COMMAND_END)[0] ?? '';
  if (UNMATCHABLE.test(first)) return undefined;
  const words = first.split(/\s+/).filter((w) => w !== '');
  const start = words.findIndex((w) => !isAssignment(w));
  return start === -1 ? undefined : words.slice(start);
}

/** The semaphore of the line whose words prefix `argv` (#798, decision 2): the most words wins, then the first in `lines`' order. */
export function matchSemaphore(argv: readonly string[], lines: readonly SemaphoreLine[]): string | undefined {
  let best: SemaphoreLine | undefined;
  for (const line of lines) {
    const isPrefix = line.words.length <= argv.length && line.words.every((w, i) => w === argv[i]);
    if (isPrefix && line.words.length > (best?.words.length ?? 0)) best = line;
  }
  return best?.semaphore;
}

/** A workspace's lines with a semaphore (#798, decision 3): per command, the line resolveCommand picks there, in comb.commands order. */
export function workspaceLines(commands: readonly Command[], workspace: string): SemaphoreLine[] {
  return commands.flatMap((c) => {
    const impl = resolveImpl(c, workspace);
    const words = impl?.semaphore === undefined ? undefined : lineWords(impl.command);
    return impl?.semaphore === undefined || words === undefined ? [] : [{ semaphore: impl.semaphore, words }];
  });
}

export const SWEEP_MS = 5_000; // decision 13: a leaked permit is freed within seconds; an idle Hive runs no timer
export const MISSED_TURNS_MAX = 3; // decision 10: a session that gave up does not cycle through the line forever

export type SemaphoresConfig = Pick<Config, 'commandSemaphores'> & { comb: Pick<CombConfig, 'commands'> };
/** One acquire (#798): the pty, its kind and workspace as the route read them in the State, and what the shim runs. */
export interface Acquire { ptyId: string; workspace: string; isAgent: boolean; argv: string[]; pid: number; now?: true }
export interface CommandSemaphores {
  acquire(call: Acquire): string; // the shim's answer (decision 6): run | run <semaphore> | refused <semaphore> <place> | wait <semaphore> <place>
  release(ptyId: string, semaphore: string): void; // its permit, its turn or its place
  runNow(semaphore: string, ptyId: string): boolean; // false: ptyId has no place in that semaphore
  ended(ptyId: string): void; // the pty's end: everything it holds, in every semaphore
  apply(config: SemaphoresConfig): void; // a settings save
  stop(): void;
}
export interface SemaphoreDeps { config: SemaphoresConfig; dispatch(event: SemaphoreEvent): void; now(): number; pidAlive(pid: number): boolean }

/** Whether `pid` still runs (#798), probed as kill-tree.ts signals: signal 0 delivers nothing. The shim runs as the Hive's own user, so EPERM
 * (a process of another user) is not our shim: dead. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Waiter { ptyId: string; argv: string[]; missed: number; turnUntil?: number; above?: true } // turnUntil: epoch ms; above: run now's, outside the count
interface Held { def: CommandSemaphore; runs: { ptyId: string; pid: number }[]; line: Waiter[] }
// Process state, as pty-host.ts keeps its HostMaps: each Held is replaced, never changed in place
interface Box { deps: SemaphoreDeps; config: SemaphoresConfig; held: Map<string, Held>; published?: Record<string, SemaphoreState>; stopped?: true; timer?: ReturnType<typeof setInterval> }

const inTurn = (w: Waiter): boolean => w.turnUntil !== undefined;
const reservationEnd = (def: CommandSemaphore, now: number): number => now + (timeoutMs(def.reservation) ?? 0); // the parser refused a bad one (#796)
const placeOf = (line: readonly Waiter[], ptyId: string): number => line.filter((w) => !inTurn(w)).findIndex((w) => w.ptyId === ptyId) + 1;
const without = (h: Held, ptyId: string): Held => ({ ...h, runs: h.runs.filter((r) => r.ptyId !== ptyId), line: h.line.filter((w) => w.ptyId !== ptyId) });
// #799: the turn's event carries its reservation's end, which the notice names; a removed semaphore's place has no turn, so none
const turnEvent = (semaphore: string, w: Waiter): SemaphoreEvent =>
  ({ type: 'semaphoreTurn', ptyId: w.ptyId, semaphore, argv: w.argv, ...(w.turnUntil === undefined ? {} : { until: new Date(w.turnUntil).toISOString() }) });

// The config's semaphores, each keeping the runs and the line it had (decision 15: a lowered limit cuts no run)
const semaphoresOf = (config: SemaphoresConfig, old: ReadonlyMap<string, Held>): Map<string, Held> =>
  new Map(config.commandSemaphores.map((def) => [def.name, { ...(old.get(def.name) ?? { runs: [], line: [] }), def }]));

// Decisions 8, 9, 18: the permits nobody runs or is owed go, in line order, to those with no turn yet; a run-now turn is outside the count
function handTurns(h: Held, now: number): { next: Held; given: Waiter[] } {
  let free = h.def.limit - h.runs.length - h.line.filter((w) => inTurn(w) && w.above !== true).length;
  const given: Waiter[] = [];
  const line = h.line.map((w) => {
    if (free <= 0 || inTurn(w)) return w;
    free -= 1;
    const turned = { ...w, turnUntil: reservationEnd(h.def, now) };
    given.push(turned);
    return turned;
  });
  return { next: given.length === 0 ? h : { ...h, line }, given };
}

// Decision 10: a turn past its reservation moves on, its pty to the back of the line, or out of it on its MISSED_TURNS_MAX-th miss in a row
function expireTurns(h: Held, now: number): Held {
  const missed = h.line.filter((w) => w.turnUntil !== undefined && w.turnUntil <= now);
  if (missed.length === 0) return h;
  const back = missed.flatMap((w) => (w.missed + 1 >= MISSED_TURNS_MAX ? [] : [{ ptyId: w.ptyId, argv: w.argv, missed: w.missed + 1 }]));
  return { ...h, line: [...h.line.filter((w) => !missed.includes(w)), ...back] };
}

function snapshotOf(h: Held): SemaphoreState {
  const turns = h.line.flatMap((w) => (w.turnUntil === undefined ? [] : [{ ptyId: w.ptyId, place: 0, turnUntil: new Date(w.turnUntil).toISOString() }]));
  const places = h.line.filter((w) => !inTurn(w)).map((w, i) => ({ ptyId: w.ptyId, place: i + 1 }));
  return { runs: h.runs.map((r) => r.ptyId), line: [...turns, ...places] };
}

// h stored with its free permits handed out as turns, each turn's event dispatched as it is given
function settle(box: Box, name: string, h: Held): void {
  const { next, given } = handTurns(h, box.deps.now());
  box.held.set(name, next);
  for (const w of given) box.deps.dispatch(turnEvent(name, w));
}

// Decision 22: the whole snapshot, only when it changed, so a call that changed nothing dispatches nothing
function publish(box: Box): void {
  if (box.stopped === true) return; // a pty ending during the server's close must not dispatch or re-arm the sweep
  const snapshot = Object.fromEntries([...box.held].map(([name, h]) => [name, snapshotOf(h)]));
  if (!isDeepStrictEqual(snapshot, box.published)) {
    box.published = snapshot;
    box.deps.dispatch({ type: 'setSemaphores', semaphores: snapshot });
  }
  syncTimer(box);
}

function stopTimer(box: Box): void {
  if (box.timer !== undefined) clearInterval(box.timer);
  box.timer = undefined;
}

// Decisions 13, 14: one sweep, running only while a permit is held or reserved as a turn
function syncTimer(box: Box): void {
  const isBusy = [...box.held.values()].some((h) => h.runs.length > 0 || h.line.some(inTurn));
  if (isBusy && box.timer === undefined) {
    box.timer = setInterval(() => { refresh(box); publish(box); }, SWEEP_MS);
    box.timer.unref(); // the sweep alone never keeps the process alive
  }
  if (!isBusy) stopTimer(box);
}

// Decision 13: a holder whose pid is gone is released; then the turns past their reservation move on
function refresh(box: Box): void {
  const now = box.deps.now();
  for (const [name, h] of box.held) settle(box, name, expireTurns({ ...h, runs: h.runs.filter((r) => box.deps.pidAlive(r.pid)) }, now));
}

// Decisions 6-8: a holder runs with no second permit; its turn, a non-agent's now, or a permit free with nobody in line is a grant, which
// takes its place; anything else keeps (or takes) a place, with the argv its turn's event will carry
function answerTo(box: Box, name: string, h: Held, call: Acquire): string {
  if (h.runs.some((r) => r.ptyId === call.ptyId)) return 'run';
  const isTurn = h.line.some((w) => w.ptyId === call.ptyId && inTurn(w));
  const isFree = h.line.length === 0 && h.runs.length < h.def.limit;
  if (isTurn || isFree || (call.now === true && !call.isAgent)) {
    settle(box, name, { ...without(h, call.ptyId), runs: [...h.runs, { ptyId: call.ptyId, pid: call.pid }] });
    return `run ${name}`;
  }
  const isPlaced = h.line.some((w) => w.ptyId === call.ptyId);
  const line = isPlaced ? h.line.map((w) => (w.ptyId === call.ptyId ? { ...w, argv: call.argv } : w)) : [...h.line, { ptyId: call.ptyId, argv: call.argv, missed: 0 }];
  box.held.set(name, { ...h, line });
  return `${call.isAgent ? 'refused' : 'wait'} ${name} ${placeOf(line, call.ptyId)}`;
}

function acquire(box: Box, call: Acquire): string {
  refresh(box);
  const lines = workspaceLines(box.config.comb.commands, call.workspace).filter((l) => box.held.has(l.semaphore));
  const name = matchSemaphore(call.argv, lines);
  const h = name === undefined ? undefined : box.held.get(name);
  const answer = name === undefined || h === undefined ? 'run' : answerTo(box, name, h, call);
  publish(box);
  return answer;
}

// Decision 9: its permit, its turn or its place; whatever that frees is the next one's turn
function release(box: Box, ptyId: string, semaphore: string): void {
  refresh(box);
  const h = box.held.get(semaphore);
  if (h !== undefined) settle(box, semaphore, without(h, ptyId));
  publish(box);
}

// Decision 12: a pty's end, in every semaphore
function ended(box: Box, ptyId: string): void {
  for (const [name, h] of box.held) settle(box, name, without(h, ptyId));
  publish(box);
}

// Decision 17: a place's turn above the limit, outside the count, at once
function runNow(box: Box, semaphore: string, ptyId: string): boolean {
  refresh(box);
  const h = box.held.get(semaphore);
  const waiter = h?.line.find((w) => w.ptyId === ptyId);
  if (h === undefined || waiter === undefined || inTurn(waiter)) return false; // a turn already given holds its permit: a second would lose it
  const turned: Waiter = { ...waiter, turnUntil: reservationEnd(h.def, box.deps.now()), above: true };
  box.deps.dispatch(turnEvent(semaphore, turned));
  settle(box, semaphore, { ...h, line: [turned, ...h.line.filter((w) => w !== waiter)] });
  publish(box);
  return true;
}

// Decisions 15, 16: a removed semaphore drops its permits, and each place still waiting gets its turn's event, so a held Stop (2.2) is answered;
// a kept one takes its new limit and reservation with its runs and line, so a raised limit hands turns out at once
function apply(box: Box, config: SemaphoresConfig): void {
  const names = new Set(config.commandSemaphores.map((s) => s.name));
  for (const [name, h] of box.held) {
    if (names.has(name)) continue;
    for (const w of h.line.filter((x) => !inTurn(x))) box.deps.dispatch(turnEvent(name, w));
  }
  box.config = config;
  box.held = semaphoresOf(config, box.held);
  for (const [name, h] of box.held) settle(box, name, h);
  publish(box);
}

/** The Command Semaphores at run time (#798): every one free, its empty entry published at once. */
export function createSemaphores(deps: SemaphoreDeps): CommandSemaphores {
  const box: Box = { deps, config: deps.config, held: semaphoresOf(deps.config, new Map()) };
  publish(box);
  const isStopped = (): boolean => box.stopped === true; // after stop() nothing dispatches: acquire answers run, the rest do nothing
  return {
    acquire: (call) => (isStopped() ? 'run' : acquire(box, call)),
    release: (ptyId, semaphore) => { if (!isStopped()) release(box, ptyId, semaphore); },
    runNow: (semaphore, ptyId) => !isStopped() && runNow(box, semaphore, ptyId),
    ended: (ptyId) => { if (!isStopped()) ended(box, ptyId); },
    apply: (config) => { if (!isStopped()) apply(box, config); },
    stop: () => { box.stopped = true; stopTimer(box); },
  };
}
