import { formatOutput, OUTPUT_LINES, parseLine, type TranscriptLine } from './transcript.js';
import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export const RESULT_LINE = '✔ turno encerrado';

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onResult(workerId: string, text: string): void; // a `result` line: the turn ended, `text` is its final answer
}

export interface WorkerPool {
  start(o: StartWorker): void;
  send(workerId: string, text: string): boolean; // false when the worker is unknown
  end(workerId: string): boolean;
  kill(workerId: string): boolean;
  exit(workerId: string): boolean; // an exit reported from outside (the tab's curl): same as the handle exiting
  focus(workerId: string): Promise<boolean>; // false when unknown or the handle has no tab
  killAll(): void;
  output(workerId: string): string[]; // copy of the last OUTPUT_LINES formatted lines; [] when unknown
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  lines: string[];
  ended: boolean; // stdin closed: the process is on its way out, nothing more can be sent
  exit(): void;
}

// The stdout ring: stderr (not JSON) passes through and a `result` gets its mark; the rest is what the transcript shows.
function ringLines(line: string, parsed: TranscriptLine | undefined): string[] {
  if (!parsed) return [line];
  return parsed.type === 'result' ? [RESULT_LINE] : formatOutput(line);
}

/** In-memory registry of live workers keyed by workerId. Process state, not domain state: it is never persisted. */
export function createWorkerPool(spawn: SpawnWorker): WorkerPool {
  const entries = new Map<string, Entry>();

  function start(o: StartWorker): void {
    const { workerId } = o;
    let exited = false;
    const onExit = (): void => {
      if (exited) return; // once: the handle and the external signal can both report it
      exited = true;
      entries.delete(workerId);
      o.onExit();
    };
    const handle = spawn(o.launch, {
      onLine: (line) => {
        const entry = entries.get(workerId);
        if (!entry) return; // a line after the exit: nobody is watching this worker any more
        const parsed = parseLine(line);
        entry.lines = [...entry.lines, ...ringLines(line, parsed)].slice(-OUTPUT_LINES);
        if (parsed?.type === 'result') o.onResult(workerId, String(parsed.result ?? ''));
      },
      onExit,
    });
    if (!exited) entries.set(workerId, { handle, lines: [], ended: false, exit: onExit }); // a spawner may fail before returning
  }

  function call(workerId: string, action: (entry: Entry) => void, unlessEnded = false): boolean {
    const entry = entries.get(workerId);
    if (!entry || (unlessEnded && entry.ended)) return false;
    action(entry);
    return true;
  }

  return {
    start,
    send: (workerId, text) => call(workerId, (entry) => entry.handle.send(text), true),
    end: (workerId) => call(workerId, (entry) => {
      entry.ended = true;
      entry.handle.end();
    }),
    kill: (workerId) => call(workerId, (entry) => entry.handle.kill()),
    exit: (workerId) => call(workerId, (entry) => entry.exit()),
    focus: async (workerId) => {
      const focus = entries.get(workerId)?.handle.focus;
      if (!focus) return false;
      await focus();
      return true;
    },
    killAll: () => {
      for (const { handle } of entries.values()) handle.kill();
    },
    output: (workerId) => [...(entries.get(workerId)?.lines ?? [])],
    has: (workerId) => entries.has(workerId),
  };
}
