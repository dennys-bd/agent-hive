import type { SpawnWorker, WorkerHandle, WorkerLaunch } from './types.js';

export const OUTPUT_LINES = 200;
export const RESULT_LINE = '✔ turno encerrado';
export const DIFF_MAX = 40; // lines shown per side of an Edit; the panel is a glance, not a review
const CUT_MARK = '…';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

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

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface StreamLine {
  type?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
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

// One side of the Edit: every line prefixed, the side cut at DIFF_MAX with a mark; an empty side (a pure insertion) adds nothing.
function diffSide(sign: '-' | '+', text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  const shown = lines.slice(0, DIFF_MAX).map((line) => `${sign}${line}`);
  return lines.length > DIFF_MAX ? [...shown, CUT_MARK] : shown;
}

// The only place in the stream where a diff exists: tool results are dropped and a Write can be huge.
function describeEdit(input: Record<string, unknown>): string[] {
  return [
    `▶ Edit: ${String(input.file_path ?? '').slice(0, TOOL_MAX)}`,
    '```diff',
    ...diffSide('-', String(input.old_string ?? '')),
    ...diffSide('+', String(input.new_string ?? '')),
    '```',
  ];
}

function describeBlock(block: ContentBlock): string[] {
  if (block.type === 'text') return block.text ? [block.text.slice(0, TEXT_MAX)] : [];
  if (block.type !== 'tool_use') return [];
  const input = block.input ?? {};
  if (block.name === 'Edit') return describeEdit(input);
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
        const parsed = parseLine(line);
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
