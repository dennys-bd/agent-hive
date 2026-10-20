import { useEffect, useRef, useState } from 'react';
import { SETUP_CHANNEL } from '../../console';
import type { SetupRow } from '../../types';
import { getJson } from '@/lib/api';

// The Start dialog's log tail (#390): the setup run as the console reads it (its channel's runs, then the live run over its pty socket),
// as plain lines cut into the dialog's rows.

const TAIL = 4;
const MAX_CHARS = 65_536; // ponytail: only the tail shows; a run that prints more keeps its last 64k characters here
const ESC = String.fromCharCode(27); // from its code: Biome refuses a control character in a pattern
const SGR = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const RUN_START = '\n── '; // a run's header opens a line (runHeader); ponytail: an output line starting with it would cut there too

/** A run's text as plain lines (#390): its SGR codes gone, a line redrawn with \r as its last drawing, no trailing blank line. */
export function plainLines(text: string): string[] {
  const plain = text.replace(SGR, '').trimEnd();
  return plain === '' ? [] : plain.split(/\r?\n/).map((line) => line.split('\r').filter((part) => part !== '').at(-1) ?? '');
}

/** A step a resume skipped (#390): done with no time; it printed nothing in this run. */
export const isSkipped = (row: SetupRow): boolean => row.kind === 'step' && row.status === 'done' && row.durationMs === undefined;

/** Each row's last TAIL lines (#390). The text is walked in order: a line that is exactly `> <header>` of the next step row not yet reached
 * (skipped ones never print theirs) opens that row; every other line, `> git …` and a RUN's own `> pkg@x build` included, belongs to the row
 * open at that point. What comes before the first header is the worktree row's. */
export function rowTails(text: string, rows: readonly SetupRow[]): string[][] {
  const opens = rows.flatMap((row, i) => (row.kind === 'step' && !isSkipped(row) ? [i] : []));
  const first = { at: rows.findIndex((row) => row.kind === 'worktree'), next: 0, owned: rows.map((): string[] => []) };
  return plainLines(text).reduce(({ at, next, owned }, line) => {
    const opened = next < opens.length && line === `> ${rows[opens[next]]?.header ?? ''}`;
    const row = opened ? opens[next] : at;
    return { at: row, next: opened ? next + 1 : next, owned: owned.map((lines, i) => (i === row ? [...lines, line].slice(-TAIL) : lines)) };
  }, first).owned;
}

// GET /console/:id's answer, as far as this hook reads it
const isView = (value: unknown): value is { history: string; live: { ptyId: string }[] } =>
  typeof value === 'object' && value !== null && typeof (value as { history?: unknown }).history === 'string' && Array.isArray((value as { live?: unknown }).live);

// The last run of the task's group (#390), its header line off: a retry after a failure adds a run
function lastRun(history: string): string {
  const run = history.slice(history.lastIndexOf(RUN_START) + 1);
  return run.slice(run.indexOf('\n') + 1);
}

// The setup run's text: read from the channel (only this task's runs, its group), then, while it is live, over its pty socket, whose first
// frame replays what it printed so far. The socket's close is the run's end: the channel is read again. A retry's new run flips isLive.
function useRunText(consoleId: string, isLive: boolean): string {
  const [text, setText] = useState('');
  const [reads, setReads] = useState(0);
  const last = useRef<{ consoleId: string; isLive: boolean }>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: isLive and reads are the triggers of a new read, not values it uses
  useEffect(() => {
    let current = true;
    let socket: WebSocket | undefined;
    // a new run (another task's, or a retry going live) drops the last one's tail; a run's end keeps it while the channel is read again.
    // consoleId alone cannot tell: it is the task's, the same for every retry
    if (last.current !== undefined && (last.current.consoleId !== consoleId || (isLive && !last.current.isLive))) setText('');
    last.current = { consoleId, isLive };
    getJson<unknown>(`/console/${encodeURIComponent(SETUP_CHANNEL.id)}?run=${encodeURIComponent(consoleId)}`).then((view) => {
      if (!current || !isView(view)) return;
      if (!view.live.some((run) => run.ptyId === consoleId)) return setText(lastRun(view.history));
      let live = '';
      socket = new WebSocket(`ws://${location.host}/ptys/${encodeURIComponent(consoleId)}/pty`);
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        live = (live + event.data).slice(-MAX_CHARS);
        setText(live);
      });
      socket.addEventListener('close', () => { if (current) setReads((n) => n + 1); });
    }).catch(() => undefined); // a failed read, or a socket that cannot open, shows no tail: the console has the run
    return () => { current = false; socket?.close(); };
  }, [consoleId, isLive, reads]);
  return text;
}

/** The setup run's last lines per row (#390), what the dialog's log box shows for the picked row. */
export const useSetupLog = (consoleId: string, rows: readonly SetupRow[], isLive: boolean): string[][] => rowTails(useRunText(consoleId, isLive), rows);
