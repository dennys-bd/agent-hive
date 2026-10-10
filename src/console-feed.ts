import { type ChannelInfo, type ConsoleStore, runHeader, timeoutLine } from './console.js';
import type { PtyHost } from './pty-host.js';
import { timeoutMs } from './timeout.js';

// A run's pty feeding a console channel (#353), shared by a command terminal (server-spawn.ts) and a commands stage's command (#755): the
// header is the run's first line, the pty's output follows, its end moves the run to the history. Out of server-spawn.ts so both read it.

/** timeout(1)'s own code: what a run its timeout stopped ends with, whatever the kill exited with (#537, #755). */
export const TIMED_OUT_EXIT = 124;

export interface ConsoleFeedDeps { ptys: Pick<PtyHost, 'has' | 'subscribe'>; consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'> }

/** What a feed writes and hears: the header's label, the run's timeout and how it is stopped, and, for a commands stage, its output and its code. */
export interface ConsoleFeed {
  label: string; // runHeader's: `#<id>` for a command terminal, `#<id> · running <name> · <n>/<total>` for a stage's command (#755)
  timeout?: string; // a TIMEOUT text; absent = no limit
  group?: string; // the stage execution this run belongs to (#755): its console tab shows only that group's runs
  onTimeout(): void; // after the timeout line: how this run is stopped
  onData?(data: string): void;
  onEnd?(exitCode: number): void; // TIMED_OUT_EXIT once its timeout fired
}

/** The run `ptyId` on `channel` (#353, #511): false when the host does not have its pty, which then failed to spawn and begins no run. The
 * timer is cleared by the pty's own end, so a run that ended first is never touched; a signal's kill exits 0 under node-pty, so a user's Stop
 * reads as done and only a timeout as a failure (#537). */
export function feedConsole({ ptys, consoleStore }: ConsoleFeedDeps, channel: ChannelInfo, ptyId: string, feed: ConsoleFeed): boolean {
  if (!ptys.has(ptyId)) return false;
  consoleStore.begin(channel, ptyId, runHeader(feed.label, new Date()), feed.group);
  const { timeout } = feed;
  const ms = timeout === undefined ? undefined : timeoutMs(timeout);
  let timedOut = false;
  const timer = ms === undefined || timeout === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    consoleStore.append(ptyId, timeoutLine(timeout));
    feed.onTimeout();
  }, ms);
  ptys.subscribe(ptyId, (data) => {
    consoleStore.append(ptyId, data);
    feed.onData?.(data);
  }, (exitCode) => {
    clearTimeout(timer);
    const code = timedOut ? TIMED_OUT_EXIT : exitCode;
    consoleStore.end(ptyId, code);
    feed.onEnd?.(code);
  });
  return true;
}
