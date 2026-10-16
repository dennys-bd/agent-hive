// A formatter's run on save (#749): the buffer's text in on stdin, the formatted text back on stdout, nothing on the disk, so the save stays one
// atomic write after the version check. A supported formatter is its binary with an argv array. A custom one is the user's own line through
// "$SHELL" -c, the third deliberate shell string (CLAUDE.md); the file reaches it only as FILE in its env. Every run is a console run.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { type ConsoleStore, crlf, failLine, formatChannel, runHeader } from './console.js';
import { detectFormatters } from './formatter-detect.js';
import { candidatesFor, type FormatterPick, pickFormatter } from './formatters.js';
import { EDITOR_FILE_MAX, type EditorConfig, FORMAT_TIMEOUT_MS, type FormatLog, type Workspace } from './types.js';

export interface FormatContext {
  cwd: string; // the activity's folder: the tool finds its own config (pyproject.toml, .prettierrc) from here
  file: string; // the saved file's absolute path, in the argv or in FILE
  workspace: Pick<Workspace, 'name' | 'env'>;
  label: string; // the run header's text: `#<task> · <path>`, or `<workspace> · <path>` for a local activity
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  timeoutMs?: number; // FORMAT_TIMEOUT_MS unless a test shortens it
}
export type FormatOutcome = { text: string } | { error: string; log: FormatLog };
/** A run's outcome, with the tool's refusal by its project's own config (#749): only its console run tells, and the save goes on as typed. */
export type RunOutcome = FormatOutcome | { declined: true };

export interface Ran { stdout?: Buffer; stderr: string; failure?: string }
export const CANCELLED = 'cancelled';
interface Process { command: string; args: string[]; env: NodeJS.ProcessEnv }

// Why a run failed, in the words its console run ends with. Never an error's message: Node writes the command line into it, and a custom
// formatter's line is the user's own text, never logged
function failureOf(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) return `exit code ${code}`;
  return signal === null ? 'failed to run' : `killed by ${signal}`;
}

// The whole process group: a custom formatter's shell may have children (a pipeline) that would outlive it holding the pipe
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

// Every chunk of a stream, until `cap` bytes: past it, onOver on each chunk (the caller acts once)
export function collect(stream: Readable | null, cap: number, onOver: () => void): () => Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > cap) onOver();
    else chunks.push(chunk);
  });
  return () => Buffer.concat(chunks);
}

/** The process with `input` on its stdin, its output capped at EDITOR_FILE_MAX, in a group of its own (spawn: execFile drops `detached`). The
 * timer, the cap and the signal's abort (#330: the headless run's cancel) settle at once and kill the group, so a grandchild still holding the
 * pipe never holds the caller. A failure keeps the stdout it got: a CLI may say why there (claude -p --output-format json). A stdin error
 * (EPIPE: it exited without reading) is left to the close event, which carries the exit code and stderr. */
export function runCapped({ command, args, env }: Process, input: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const stop = (failure: string): void => {
      if (settled) return; // once reaped, the pid may be another group's
      killGroup(child.pid);
      settle({ stdout: stdout(), stderr: stderr().toString('utf8'), failure });
    };
    const over = (): void => stop(`output over ${EDITOR_FILE_MAX} bytes`);
    const stdout = collect(child.stdout, EDITOR_FILE_MAX, over);
    const stderr = collect(child.stderr, EDITOR_FILE_MAX, over);
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs);
    const cancel = (): void => stop(CANCELLED);
    signal?.addEventListener('abort', cancel, { once: true });
    function settle(ran: Ran): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(ran);
    }
    child.on('error', (err: NodeJS.ErrnoException) => settle({ stderr: '', failure: err.code === 'ENOENT' ? `${command} not found` : `failed to run (${err.code ?? 'unknown'})` }));
    child.on('close', (code, killedBy) => {
      const err = stderr().toString('utf8');
      settle(code === 0 ? { stdout: stdout(), stderr: err } : { stdout: stdout(), stderr: err, failure: failureOf(code, killedBy) });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
    if (signal?.aborted) cancel(); // aborted before the spawn: there is still a group to kill
  });
}

// stdout as text; undefined for bytes that are not UTF-8, which a save must never write. ponytail: no NUL check (server-editor's decodeText has
// one); a formatter printing NUL is not a case worth a shared module yet
function decoded(stdout: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout);
  } catch {
    return undefined;
  }
}

// What the run printed, as the text or why not: an empty stdout is a failure, never an emptied file
function outcomeOf(ran: Ran): { text: string } | { failure: string } {
  if (ran.failure !== undefined) return { failure: ran.failure };
  if (ran.stdout === undefined || ran.stdout.length === 0) return { failure: 'empty output' };
  const text = decoded(ran.stdout);
  return text === undefined ? { failure: 'output is not UTF-8' } : { text };
}

// Both kinds run in the daemon's env with the workspace's on top (#738: every run of a workspace gets it). A supported pick is its binary and
// argv; a custom one is the user's line in their shell, with FILE as a raw value
function processOf(pick: FormatterPick, { file, workspace }: FormatContext): Process {
  const env = { ...process.env, ...workspace.env };
  if (pick.kind === 'supported') return { command: pick.binary, args: pick.argv(file), env };
  return { command: process.env.SHELL ?? '/bin/sh', args: ['-c', pick.command], env: { ...env, FILE: file } };
}

/** One formatter run on `text` (#749), logged as a run of its console channel: the header, the tool's stderr and, on a failure, the reason in
 * red. Never throws: on a failure the save goes on with the text as typed. */
export async function runFormatter(pick: FormatterPick, text: string, ctx: FormatContext): Promise<RunOutcome> {
  const channel = formatChannel(ctx.workspace.name, pick.name);
  const runId = randomUUID();
  ctx.consoleStore.begin(channel, runId, runHeader(ctx.label, new Date()));
  const ran = await runCapped(processOf(pick, ctx), text, ctx.cwd, ctx.timeoutMs ?? FORMAT_TIMEOUT_MS);
  if (ran.stderr !== '') ctx.consoleStore.append(runId, crlf(ran.stderr));
  const outcome = outcomeOf(ran);
  if ('text' in outcome) {
    ctx.consoleStore.end(runId, 0);
    return outcome;
  }
  if (pick.kind === 'supported' && pick.declines?.test(ran.stderr)) {
    ctx.consoleStore.end(runId, 0);
    return { declined: true };
  }
  ctx.consoleStore.append(runId, `${failLine(outcome.failure)}\r\n`);
  ctx.consoleStore.end(runId, 1);
  return { error: outcome.failure, log: { channel: channel.id, run: runId } };
}

/** The format a save asks for (#749, #780): the file's language's formatters that may run in the workspace detected in the activity's folder,
 * the first that runs picked and run; undefined when none does, and the text is saved as it is. */
export async function formatForSave(editor: EditorConfig, text: string, ctx: FormatContext): Promise<FormatOutcome | undefined> {
  const binaries = await detectFormatters(ctx.cwd, candidatesFor(editor, ctx.file, ctx.workspace.name));
  const pick = pickFormatter(editor, ctx.file, ctx.workspace.name, binaries);
  if (pick === undefined) return undefined;
  const outcome = await runFormatter(pick, text, ctx);
  return 'declined' in outcome ? undefined : outcome;
}
