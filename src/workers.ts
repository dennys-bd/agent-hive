import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export const OUTPUT_LINES = 200;
export const RESULT_LINE = '✔ turno encerrado';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

export interface StartWorker {
  workerId: string;
  launch: WorkerLaunch;
  onExit(): void;
  onResult(workerId: string): void; // a `result` line: the turn ended
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

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  message?: { content?: ContentBlock[] };
}

// stream-json: one JSON object per line. Anything else (stderr, CLI warnings) is not a stream line.
function parseLine(line: string): StreamLine | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StreamLine) : undefined;
  } catch {
    return undefined;
  }
}

function describeBlock(block: ContentBlock): string[] {
  if (block.type === 'text') return block.text ? [block.text.slice(0, TEXT_MAX)] : [];
  if (block.type !== 'tool_use') return [];
  const input = block.input ?? {};
  const detail = String(input.command ?? input.file_path ?? input.pattern ?? input.description ?? '').slice(0, TOOL_MAX);
  const name = block.name ?? 'tool';
  return [detail ? `▶ ${name}: ${detail}` : `▶ ${name}`];
}

/** What one stdout line becomes in the panel: assistant text and tool calls, a mark per turn end, nothing for the rest. */
export function formatOutput(line: string): string[] {
  const parsed = parseLine(line);
  if (!parsed) return [line];
  if (parsed.type === 'result') return [RESULT_LINE];
  if (parsed.type !== 'assistant') return [];
  return (parsed.message?.content ?? []).flatMap(describeBlock);
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
        entry.lines = [...entry.lines, ...formatOutput(line)].slice(-OUTPUT_LINES);
        if (parseLine(line)?.type === 'result') o.onResult(workerId);
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
