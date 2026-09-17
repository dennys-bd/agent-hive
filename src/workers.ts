import type { SpawnWorker, WorkerHandle } from './types.js';

export const OUTPUT_LINES = 200;
export const RESULT_LINE = '✔ turno encerrado';
const TEXT_MAX = 2000;
const TOOL_MAX = 120;

export interface StartWorker {
  workerId: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string; // first `user` message; the .hive/prompts file is only a record
  onExit(): void;
  onResult(workerId: string): void; // a `result` line: the turn ended
}

export interface WorkerPool {
  start(o: StartWorker): void;
  send(workerId: string, text: string): boolean; // false when the worker is unknown
  end(workerId: string): boolean;
  kill(workerId: string): boolean;
  killAll(): void;
  output(workerId: string): string[]; // copy of the last OUTPUT_LINES formatted lines; [] when unknown
  has(workerId: string): boolean;
}

interface Entry {
  handle: WorkerHandle;
  lines: string[];
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
    const handle = spawn(o.argv, { cwd: o.cwd, env: o.env }, {
      onLine: (line) => {
        const entry = entries.get(workerId);
        if (!entry) return; // a line after the exit: nobody is watching this worker any more
        entry.lines = [...entry.lines, ...formatOutput(line)].slice(-OUTPUT_LINES);
        if (parseLine(line)?.type === 'result') o.onResult(workerId);
      },
      onExit: () => {
        entries.delete(workerId);
        o.onExit();
      },
    });
    entries.set(workerId, { handle, lines: [] });
    handle.send(o.prompt);
  }

  function call(workerId: string, action: (handle: WorkerHandle) => void): boolean {
    const entry = entries.get(workerId);
    if (!entry) return false;
    action(entry.handle);
    return true;
  }

  return {
    start,
    send: (workerId, text) => call(workerId, (handle) => handle.send(text)),
    end: (workerId) => call(workerId, (handle) => handle.end()),
    kill: (workerId) => call(workerId, (handle) => handle.kill()),
    killAll: () => {
      for (const { handle } of entries.values()) handle.kill();
    },
    output: (workerId) => [...(entries.get(workerId)?.lines ?? [])],
    has: (workerId) => entries.has(workerId),
  };
}
