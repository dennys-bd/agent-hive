// A detached process for the machine's run (#158): stdin, output caps, a timeout, an abort and the kill of its whole tree. Lifted from
// runCapped (format-run.ts) and runShell (worktree-steps.ts), which stay until 7.3 and 7.2 switch over and delete them. Never rejects: a
// failure is in the answer, in the words those two used, so each maps it back to its own shape (Ran, RunFailure).
import { type ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { killTree, treeSpawnOptions } from './kill-tree.js';
import type { RunProcess, RunResult } from './machine.js';
import { EDITOR_FILE_MAX } from './types.js';

export const RUN_TIMEOUT = 'timeout';
export const RUN_STOPPED = 'stopped';
export const RUN_OVER = 'too_large';
const CANCELLED = 'cancelled'; // format-run.ts' word for a stop
const TAIL_LINES = 20; // worktree-steps.ts' tail, what a task's error shows of a RUN
const TAIL_CHARS = 8192; // output with no newlines (a progress bar) is bounded too

// +1: the last piece is the line still being written
const keepTail = (text: string): string => text.slice(-TAIL_CHARS).split('\n').slice(-(TAIL_LINES + 1)).join('\n');
const tailOf = (text: string): string => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');

// Never an error's message: Node writes the command line into it, and a custom formatter's line is the user's own text
function exitFailure(code: number | null, signal: NodeJS.Signals | null): string | undefined {
  if (code === 0) return undefined;
  if (code !== null) return `exit code ${code}`;
  return signal === null ? 'failed to run' : `killed by ${signal}`;
}

const spawnFailure = (command: string, err: NodeJS.ErrnoException): string =>
  (err.code === 'ENOENT' ? `${command} not found` : `failed to run (${err.code ?? 'unknown'})`);

// One stream's bytes up to the cap (past it onOver on every chunk; the caller acts once). A decoder per stream, so a character split
// between two chunks keeps its bytes and the two streams never mix a half
function watch(stream: Readable | null, cap: number, onText: (text: string) => void, onOver: () => void): () => Buffer {
  const decoder = new StringDecoder('utf8');
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (text !== '') onText(text);
    size += chunk.length;
    if (size > cap) onOver();
    else chunks.push(chunk);
  });
  return () => Buffer.concat(chunks);
}

// A tree of its own (treeSpawnOptions; spawn, since execFile drops detached). No input: stdin closed, so a prompt fails at once
function startChild(p: RunProcess): ChildProcess {
  const stdin = p.input === undefined ? 'ignore' : 'pipe';
  const child = spawn(p.command, p.args, { cwd: p.cwd, env: p.env, stdio: [stdin, 'pipe', 'pipe'], windowsVerbatimArguments: p.windowsVerbatimArguments, ...treeSpawnOptions(process.platform) });
  child.stdin?.on('error', () => undefined); // EPIPE: it exited without reading; close carries the code
  child.stdin?.end(p.input);
  return child;
}

export function runDetached(p: RunProcess): Promise<RunResult> {
  if (p.signal?.aborted) return Promise.resolve({ code: RUN_STOPPED, stdout: Buffer.alloc(0), stderr: '', tail: '', failure: CANCELLED }); // it never starts
  return new Promise((resolve) => {
    const cap = p.maxBytes ?? EDITOR_FILE_MAX;
    const child = startChild(p);
    let settled = false;
    let tail = '';
    const onText = (text: string): void => {
      p.onOutput?.(text);
      tail = keepTail(tail + text);
    };
    // A timeout, the cap or an abort settles now and kills the tree: a grandchild still holding a pipe never holds the caller
    const stop = (code: string, failure: string): void => {
      if (settled) return; // once reaped, the pid may be another process's
      void killTree(child.pid, process.platform);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(code, failure);
    };
    const over = (): void => stop(RUN_OVER, `output over ${cap} bytes`);
    const stdout = watch(child.stdout, cap, onText, over);
    const stderr = watch(child.stderr, cap, onText, over);
    const timer = p.timeoutMs === undefined ? undefined : setTimeout(() => stop(RUN_TIMEOUT, `timed out after ${p.timeoutMs} ms`), p.timeoutMs);
    const onAbort = (): void => stop(RUN_STOPPED, CANCELLED);
    p.signal?.addEventListener('abort', onAbort, { once: true });
    function finish(code: number | string, failure: string | undefined): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout: stdout(), stderr: stderr().toString('utf8'), tail: tailOf(tail), ...(failure === undefined ? {} : { failure }) });
    }
    child.on('error', (err: NodeJS.ErrnoException) => finish(err.code ?? 'error', spawnFailure(p.command, err)));
    child.on('close', (code, signal) => finish(code ?? signal ?? 'unknown', exitFailure(code, signal)));
  });
}
