import { spawn } from 'node:child_process';
import { cp, lstat, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { commandLine, okLine } from './console.js';
import type { StepKind } from './events.js';
import type { Logger } from './log.js';
import { checkRelativePath, describeStep, parseSetup, type SetupStep } from './setup-script.js';
import { timeoutMs as timeoutMsOf } from './timeout.js';
import type { Exec, Workspace } from './types.js';
import { gitOrWords } from './worktree.js';

const SHELL = '/bin/sh';
const TAIL_LINES = 20;
const TAIL_CHARS = 8192; // output with no newlines (a progress bar, a binary) is bounded too: the tail lands in state.json and the UI
const TIMEOUT = 'timeout';
const STOPPED = 'stopped'; // a Stop on the task during the stage spawn's setup (#351)

export interface RunOptions {
  cwd: string;
  timeoutMs?: number; // absent = no limit (#511)
  onOutput?(text: string): void; // every decoded chunk, live: the setup's console run (#351)
  signal?: AbortSignal; // a stop (#351): the group is killed as on a timeout, and the step fails with `stopped`
  env?: NodeJS.ProcessEnv; // the child's whole env (#738): the Hive's with the workspace's on top; absent = the Hive's
}
export type RunShell = (file: string, args: string[], options: RunOptions) => Promise<void>;

/** How a RUN step failed (#299): its exit code, a signal name or `timeout`, and the last lines of its output. The log reads only the code;
 * the output can print a secret (`RUN cat .env`), so only the task's error carries it. */
export class RunFailure extends Error {
  readonly code: number | string;
  readonly tail: string;
  constructor(code: number | string, tail: string) {
    super(code === TIMEOUT ? 'timed out' : code === STOPPED ? STOPPED : `exit ${code}`);
    this.code = code;
    this.tail = tail;
  }
}

/** How a source or a destination error names the worktree's side (#654); the main checkout's is the workspace's name. */
export const WORKTREE_NAME = 'the worktree';

/** Which sides a script reads from and writes to (#654): the setup reads the main checkout and writes the worktree, the teardown the reverse.
 * A RUN and a DEL always act in the worktree, and a LOAD always reads the main checkout, whatever the phase. */
export interface Phase {
  name: 'setup' | 'teardown';
  from: string; // where a COPY reads
  fromName: string; // how a source error names that side
  to: string; // where a COPY writes
  toName: string;
  timeout?: string; // per RUN, a TIMEOUT text; absent = no limit (#511)
}

/** What one step reports as it ends (#742): its kind, its place in the run (skipped steps counted, #390), its time and how it went; never the
 * line. code: a RUN's exit code, `timeout` or `stopped`, which the Start dialog's row shows (#390). */
export interface StepReport { kind: StepKind; index: number; durationMs: number; ok: boolean; code?: number | string }

/** Where a setup run resumes (#390): the steps a failed run already passed are skipped, and each step that passes is recorded. */
export interface Resume { skip: number; passed(done: number): Promise<void> }

/** What running a script needs (#299, #351, #654). */
export interface StepDeps {
  exec: Exec; // git, for the worktree's git dir; tests inject a fake
  log: Pick<Logger, 'info'>;
  onStep?(step: string): void; // the step about to run, as describeStep writes it: a task's progress line; a teardown has none
  output?(text: string): void; // the console run (#351): a header per step and a RUN's output whole; never the log
  signal?: AbortSignal; // a stop (#351): the running RUN's group is killed and it fails with `stopped`; no later step starts
  run?: RunShell; // runShell unless a test injects one
  home?: string; // where ~ expands in a COPY destination (#654): os.homedir() unless a test injects one
  onStepEnd?(report: StepReport): void; // #742: events.jsonl's worktree.step
  onPlan?(steps: string[], skipped: number): void; // #390: the expanded steps as describeStep writes them, once before the first; skipped: what a resume skips
  resume?: Resume; // #390: runSetup's; a teardown never resumes
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// +1: the last piece is the line still being written, or the empty one after a trailing newline.
const keepTail = (text: string): string => text.slice(-TAIL_CHARS).split('\n').slice(-(TAIL_LINES + 1)).join('\n');
const tailOf = (text: string): string => text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    return; // ESRCH: the group already exited
  }
}

/**
 * A RUN step (#299). The one shell string besides ptyCommand (see CLAUDE.md): the command is the user's own line from their own
 * Settings, with the power the worker already has, and a shell keeps `&&`, pipes and $VAR working. stdin is closed, so a prompt fails at
 * once instead of hanging. `detached` gives the step a process group of its own, so a timeout or a stop (#351) kills what sh started
 * (pnpm and its children), not only sh. Every chunk goes to onOutput as it comes; the last TAIL_LINES are kept for the task's error.
 * The workspace's variables ride the child's env (#738), never the line.
 */
export function runShell(file: string, args: string[], { cwd, timeoutMs, onOutput, signal, env }: RunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunFailure(STOPPED, '')); // stopped before it started: it never runs (#351)
      return;
    }
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const decoder = new StringDecoder('utf8'); // one decoder across chunks: a character split between two keeps its bytes
    let output = '';
    const keep = (chunk: Buffer): void => {
      const text = decoder.write(chunk);
      if (text !== '') onOutput?.(text);
      output = keepTail(output + text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const release = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    // On timeout or a stop it settles at once instead of on 'close': a grandchild that left the group could hold the pipes open forever.
    const settle = (code: string): void => {
      release();
      killGroup(child.pid);
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new RunFailure(code, tailOf(output)));
    };
    const onAbort = (): void => settle(STOPPED);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => settle(TIMEOUT), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      release();
      reject(err);
    });
    child.on('close', (code, closedBy) => {
      release();
      if (code === 0) resolve();
      else reject(new RunFailure(code ?? closedBy ?? 'unknown', tailOf(output)));
    });
  });
}

// The task's reason for a failed step: a RUN's exit or timeout with its output tail on the lines below, else the error's own message.
function reasonOf(err: unknown, timeout?: string): string {
  if (!(err instanceof RunFailure)) return errorMessage(err);
  const reason = err.code === TIMEOUT ? `timed out after ${timeout}` : err.message;
  return err.tail === '' ? reason : `${reason}\n${err.tail}`;
}

/** The worktree's own git dir (<repo>/.git/worktrees/<slug>), where the markers live. An answer that is no absolute path is refused: a marker
 * must never land relative to the Hive's cwd. */
export async function gitDirOf(worktree: string, exec: Exec): Promise<string> {
  const dir = (await gitOrWords(worktree, ['rev-parse', '--absolute-git-dir'], exec)).trim();
  if (!isAbsolute(dir)) throw new Error(`git named no git dir for ${worktree}`);
  return dir;
}

// A COPY / LOAD source (#299, #654), read under `root`: its real path must pass checkRelativePath against root's real path, so a symlink cannot
// lead out of that side, to its top or into .git / .hive. Missing is its own reason, named after the side.
const MISSING: Readonly<Record<string, string>> = { ENOENT: 'not found in', ENOTDIR: 'not a folder in' };

async function insideRoot(root: string, name: string, path: string): Promise<string> {
  const real = await realpath(join(root, path)).catch((err: NodeJS.ErrnoException) => {
    const reason = MISSING[err.code ?? ''];
    throw reason === undefined ? err : new Error(`${reason} ${name}`);
  });
  if (checkRelativePath(relative(await realpath(root), real)) !== undefined) throw new Error(`outside ${name}`);
  return real;
}

// A relative destination (#299, #654): no folder on its way under `root` may be a symlink, or cp would write through it wherever a branch
// pointed it (a worker can commit `config -> ~/somewhere`). The last segment is fine for a file destination: cp with force replaces a link,
// never follows it. A folder destination (`whole`) is written into, so its last segment must not be a link either.
async function refuseLinkedParent(root: string, name: string, path: string, whole = false): Promise<void> {
  const parents = (whole ? path : dirname(path)).split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  for (let i = 1; i <= parents.length; i += 1) {
    const stat = await lstat(join(root, ...parents.slice(0, i))).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (stat === undefined) return; // cp creates the rest as plain folders
    if (stat.isSymbolicLink()) throw new Error(`outside ${name}`);
  }
}

const HOME = '~';

// Where a COPY writes (#654): the same relative path on the other side by default; `~` / `~/…` under the home folder and an absolute path
// as written (the user's own line, as a RUN cp would); a relative one under phase.to, where no folder on its way may be a symlink.
async function destinationOf(phase: Phase, step: SetupStep, home: string): Promise<string> {
  const dest = step.dest ?? step.arg;
  if (dest === HOME || dest.startsWith(`${HOME}/`)) return join(home, dest.slice(HOME.length));
  if (isAbsolute(dest)) return dest;
  await refuseLinkedParent(phase.to, phase.toName, dest, step.arg.endsWith('/') || dest.endsWith('/'));
  return join(phase.to, dest);
}

// The files under `path`, for a result line: a folder's every non-folder entry, a symlink as one, never followed.
async function countFiles(path: string): Promise<number> {
  if (!(await lstat(path)).isDirectory()) return 1;
  return (await readdir(path, { recursive: true, withFileTypes: true })).filter((entry) => !entry.isDirectory()).length;
}

// The cp filter (#654): the worktree is untrusted, so a teardown never copies its symlinks (they would be planted in the main checkout), and
// in both phases a folder is never merged into a destination entry that is a symlink (cp would write through it, outside the side).
function copyFilter(phase: Phase): (src: string, dest: string) => Promise<boolean> {
  return async (src, dest) => {
    const entry = await lstat(src);
    if (entry.isSymbolicLink()) return phase.name !== 'teardown';
    if (!entry.isDirectory()) return true;
    const existing = await lstat(dest).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined;
      throw err;
    });
    if (existing?.isSymbolicLink()) throw new Error(`outside ${phase.toName}`);
    return true;
  };
}

// COPY <source> [destination] (#654), rsync-like: a source ending in / must be a folder (checked below) and its contents
// land in the destination folder; any other source is copied to the destination path itself. fs.cp does both: it merges into a folder that
// exists, overwrites files and deletes nothing.
async function copyStep(phase: Phase, step: SetupStep, home: string): Promise<string> {
  const source = await insideRoot(phase.from, phase.fromName, step.arg);
  // node's realpath drops a trailing /, so the ENOTDIR a file would answer never comes: check it here
  if (step.arg.endsWith('/') && !(await stat(source)).isDirectory()) throw new Error(`not a folder in ${phase.fromName}`);
  const dest = await destinationOf(phase, step, home);
  // a file into `folder/` keeps its name, as cp does; a folder source into `folder/` is the rsync-like merge above
  const target = !step.arg.endsWith('/') && (step.dest ?? '').endsWith('/') && !(await lstat(source)).isDirectory() ? join(dest, basename(step.arg)) : dest;
  await cp(source, target, { recursive: true, force: true, filter: copyFilter(phase) });
  return `copied ${await countFiles(source)} files to ${step.dest ?? step.arg}`;
}

// DEL <path> (#654): only in the worktree, never through a symlinked folder. resolve drops a trailing /, so a link is removed as a link and its
// target is never followed. Missing counts as done.
async function delStep(worktree: string, step: SetupStep): Promise<string> {
  await refuseLinkedParent(worktree, WORKTREE_NAME, step.arg);
  const target = resolve(worktree, step.arg);
  const found = await lstat(target).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  if (!found) return `nothing to delete: ${step.arg}`;
  const files = await countFiles(target);
  await rm(target, { recursive: true });
  return `deleted ${step.arg} (${files} files)`;
}

// One COPY, DEL or RUN (a LOAD never gets here: runSteps expanded it). A COPY and a DEL answer their result line.
async function doStep(phase: Phase, worktree: string, step: SetupStep, deps: StepDeps & { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string | undefined> {
  if (step.kind === 'copy') return copyStep(phase, step, deps.home ?? homedir());
  if (step.kind === 'del') return delStep(worktree, step);
  await (deps.run ?? runShell)(SHELL, ['-c', step.arg], { cwd: worktree, timeoutMs: deps.timeoutMs, onOutput: deps.output, signal: deps.signal, env: deps.env });
  return undefined;
}

const failure = (phase: Phase, step: SetupStep, reason: string): string =>
  `${phase.name} failed at line ${step.line} (${describeStep(step)}): ${reason}`;

// LOAD <file> (#299): read from the main checkout at every run, in both scripts, so editing it needs no Settings save and a branch cannot
// change what runs; one level only. Its steps take the LOAD's line number, so a failure names a line of the Settings text.
async function loadSteps(phase: Phase, workspace: Workspace, load: SetupStep): Promise<SetupStep[]> {
  try {
    const text = await readFile(await insideRoot(workspace.path, workspace.name, load.arg), 'utf8');
    return parseSetup(text, { allowLoad: false }).map((step) => ({ ...step, line: load.line }));
  } catch (err) {
    throw new Error(failure(phase, load, errorMessage(err)));
  }
}

const STEP_KINDS: Readonly<Record<SetupStep['kind'], StepKind>> = { copy: 'COPY', run: 'RUN', load: 'LOAD', del: 'DEL' };

// A step's report (#742), outside the step's own outcome: a callback that throws is one log line, never the step's error nor a failed good step
function report(deps: StepDeps, phase: Phase, step: SetupStep, stepReport: StepReport): void {
  try {
    deps.onStepEnd?.(stepReport);
  } catch (err) {
    deps.log.info(`${phase.name} line ${step.line}: report failed (${err instanceof Error ? err.name : typeof err})`);
  }
}

// One step (a LOAD never gets here: runSteps expanded it). One log line per step, the code and never the output, and its report (#742); the
// console run gets a header line and a RUN's output (#351).
async function runStep(phase: Phase, worktree: string, step: SetupStep, index: number, deps: StepDeps & { timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<void> {
  if (deps.signal?.aborted) throw new Error(failure(phase, step, STOPPED)); // a stop between steps: the next one never starts (#351)
  const described = describeStep(step);
  const began = Date.now();
  deps.onStep?.(described);
  deps.output?.(`${commandLine(`> ${described}`)}\n`);
  const done = await doStep(phase, worktree, step, deps).then((result) => ({ ok: true as const, result }), (err: unknown) => ({ ok: false as const, err }));
  const ms = Date.now() - began;
  const outcome = done.ok ? 'ok (0)' : `failed (${done.err instanceof RunFailure ? done.err.code : 'error'})`;
  deps.log.info(`${phase.name} ${basename(worktree)} line ${step.line}: ${described} ${outcome} ${ms}ms`);
  const code = !done.ok && done.err instanceof RunFailure ? { code: done.err.code } : {}; // #390: the dialog's failed row
  report(deps, phase, step, { kind: STEP_KINDS[step.kind], index, durationMs: ms, ok: done.ok, ...code });
  if (!done.ok) throw new Error(failure(phase, step, reasonOf(done.err, phase.timeout)));
  // The result line, then ok and its time (#654); a failure writes nothing here: the run's red end line sits right under the step
  if (done.result !== undefined) deps.output?.(`${done.result}\n`);
  deps.output?.(`${okLine(`ok ${ms}ms`)}\n`);
}

/** A script's LOAD lines read from the main checkout and expanded in place (#299): what runSetup hashes before anything runs (#390). */
export async function expandSteps(phase: Phase, workspace: Workspace, steps: SetupStep[]): Promise<SetupStep[]> {
  return (await Promise.all(steps.map((step) => (step.kind === 'load' ? loadSteps(phase, workspace, step) : [step])))).flat();
}

/** A script's steps in `worktree` (#299, #654): the LOAD lines are expanded first, then each step runs in order with the phase's timeout. A
 * resume (#390) skips the steps a failed run passed and records each step that passes; onPlan hears the whole list first. A failure throws
 * `<phase> failed at line <n> (<step>): <reason>`. Answers how many steps ran, for the run's summary. */
export async function runSteps(phase: Phase, workspace: Workspace, worktree: string, steps: SetupStep[], deps: StepDeps): Promise<number> {
  const expanded = await expandSteps(phase, workspace, steps); // a list runSetup already expanded holds no LOAD: the same list back
  const timeoutMs = phase.timeout === undefined ? undefined : timeoutMsOf(phase.timeout);
  // #738: every RUN sees the workspace's env, its setup's and its teardown's alike; COPY, DEL, LOAD and the Hive's git never read it
  const env = { ...process.env, ...workspace.env };
  const skip = deps.resume?.skip ?? 0;
  deps.onPlan?.(expanded.map(describeStep), skip);
  for (const [at, step] of expanded.slice(skip).entries()) {
    await runStep(phase, worktree, step, skip + at, { ...deps, timeoutMs, env });
    await deps.resume?.passed(skip + at + 1);
  }
  return expanded.length - skip;
}
