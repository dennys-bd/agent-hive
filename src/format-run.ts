// A formatter's run on save (#749): the buffer's text in on stdin, the formatted text back on stdout, nothing on the disk, so the save stays one
// atomic write after the version check. A supported formatter is its binary with an argv array. A custom one is the user's own line through
// "$SHELL" -c (Git's sh.exe on Windows, #631), the third deliberate shell string (CLAUDE.md); the file reaches it only as FILE in its env. Every run is a console run, on the activity's machine (#160).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { type ConsoleStore, crlf, failLine, formatChannel, runHeader } from './console.js';
import { type ExecLookup, resolveExec } from './exec-path.js';
import { detectFormatters } from './formatter-detect.js';
import { candidatesFor, type FormatterPick, pickFormatter } from './formatters.js';
import type { Machine } from './machine.js';
import { withMachinePath } from './machine-fs.js';
import { posixShellEnv } from './posix-shell.js';
import { EDITOR_FILE_MAX, type EditorConfig, FORMAT_TIMEOUT_MS, type FormatLog, type Workspace } from './types.js';

export interface FormatContext {
  machine: Machine; // #160: the activity's: its run, its PATH, platform and shell, and its disk for the detection
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
// windowsVerbatimArguments: the .cmd runner's line (#632, #633), which reaches cmd.exe as written
export interface Process { command: string; args: string[]; env: NodeJS.ProcessEnv; windowsVerbatimArguments?: boolean }

/** A binary and argv as the platform spawns them (#634): on win32 a .cmd runs through cmd.exe, so a project's node_modules\.bin\biome.cmd works.
 *  The resolver's refusal (a name found nowhere, an argument cmd.exe cannot carry) comes back as `failure`, never thrown: a run ends as failed. */
export function launchOf(command: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isFile?: ExecLookup['isFile']): Process | { failure: string } {
  try {
    const exec = resolveExec(command, args, { platform, env, isFile });
    return { command: exec.file, args: [...exec.args], env, ...(exec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) };
  } catch (err) {
    // A binary gone since its detection is named by its file only, as check-run names a checker: its absolute path holds the account name
    const name = (platform === 'win32' ? path.win32 : path.posix).basename(command);
    return { failure: (err as Error).message.replaceAll(command, name) };
  }
}

/** A Process on `run` (#160: a machine's, or runDetached for the host's own headless run) with `input` on stdin and each stream capped at
 *  EDITOR_FILE_MAX: the RunResult as a Ran, its failure in the same words the run had before #160. A failure keeps the stdout it got: a CLI may say why
 *  there (claude -p --output-format json). */
export async function runOn(run: Machine['run'], { command, args, env, windowsVerbatimArguments }: Process, input: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  const ran = await run({
    command, args, env, cwd, input, timeoutMs, maxBytes: EDITOR_FILE_MAX,
    ...(signal === undefined ? {} : { signal }), ...(windowsVerbatimArguments ? { windowsVerbatimArguments } : {}),
  });
  return { stdout: ran.stdout, stderr: ran.stderr, ...(ran.failure === undefined ? {} : { failure: ran.failure }) };
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

/** A custom formatter's shell (#749, #631): the user's $SHELL on macOS and Linux, else `posix`, the POSIX shell. On win32 always `posix`:
 *  SHELL there is Git Bash's /usr/bin/bash, an MSYS path node cannot spawn, or unset under cmd and PowerShell. */
export const customShell = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, posix: string): string =>
  (platform === 'win32' ? undefined : env.SHELL) ?? posix;

// Both kinds run in the base env with the workspace's on top (#738: every run of a workspace gets it). A supported pick is its binary and
// argv; a custom one is the user's line in their shell, with FILE as a raw value
function processOf(pick: FormatterPick, { file, workspace, machine }: Pick<FormatContext, 'file' | 'workspace' | 'machine'>): Process | { failure: string } {
  const info = machine.info();
  const base = withMachinePath(process.env, info); // #160: the machine's PATH; the host's env as the base is node 8's to replace
  if (pick.kind === 'supported') return launchOf(pick.binary, pick.argv(file), { ...base, ...workspace.env }, info.platform);
  // #631: on win32 MSYS leaves the line's arguments as written; the workspace's env still wins, and FILE last
  const env = { ...base, ...posixShellEnv(info.platform), ...workspace.env, FILE: file };
  return { command: customShell(info.platform, base, info.shell), args: ['-c', pick.command], env };
}

/** One formatter run on `text` (#749), logged as a run of its console channel: the header, the tool's stderr and, on a failure, the reason in
 * red. Never throws: on a failure the save goes on with the text as typed. */
export async function runFormatter(pick: FormatterPick, text: string, ctx: FormatContext): Promise<RunOutcome> {
  const channel = formatChannel(ctx.workspace.name, pick.name);
  const runId = randomUUID();
  ctx.consoleStore.begin(channel, runId, runHeader(ctx.label, new Date()));
  const proc = processOf(pick, ctx);
  const ran: Ran = 'failure' in proc ? { stderr: '', failure: proc.failure } : await runOn(ctx.machine.run, proc, text, ctx.cwd, ctx.timeoutMs ?? FORMAT_TIMEOUT_MS);
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
  const binaries = await detectFormatters(ctx.machine, ctx.cwd, candidatesFor(editor, ctx.file, ctx.workspace.name));
  const pick = pickFormatter(editor, ctx.file, ctx.workspace.name, binaries);
  if (pick === undefined) return undefined;
  const outcome = await runFormatter(pick, text, ctx);
  return 'declined' in outcome ? undefined : outcome;
}
