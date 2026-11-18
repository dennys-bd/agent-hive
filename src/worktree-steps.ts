import { basename, isAbsolute, resolve } from 'node:path';
import { commandLine, okLine } from './console.js';
import type { StepKind } from './facts.js';
import type { Logger } from './log.js';
import type { Machine, RunResult } from './machine.js';
import { posixShellEnv } from './posix-shell.js';
import { describeStep, type SetupStep } from './setup-script.js';
import { timeoutMs as timeoutMsOf } from './timeout.js';
import type { Workspace } from './types.js';
import { copyStep, countFiles, readLoad, refuseLinkedParent } from './worktree-copy-step.js';
import { gitOrWords } from './worktree.js';

const TIMEOUT = 'timeout'; // the machine's run answers these words (src/machine-run.ts)
const STOPPED = 'stopped'; // a Stop on the task during the stage spawn's setup (#351)

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
  log: Pick<Logger, 'info'>;
  onStep?(step: string): void; // the step about to run, as describeStep writes it: a task's progress line; a teardown has none
  output?(text: string): void; // the console run (#351): a header per step and a RUN's output whole; never the log
  signal?: AbortSignal; // a stop (#351): the running RUN's tree is killed and it fails with `stopped`; no later step starts
  onStepEnd?(report: StepReport): void; // #742: facts.jsonl's worktree.step
  onPlan?(steps: string[], skipped: number): void; // #390: the expanded steps as describeStep writes them, once before the first; skipped: what a resume skips
  resume?: Resume; // #390: runSetup's; a teardown never resumes
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const STEP_MAX_LINES = 2;
const STEP_MAX_CHARS = 160;
const SILENT = 'and printed nothing; if the line sends its errors to /dev/null, remove that to see why';

/** A step's text in a failure (#267): a setup line can run to hundreds of characters, so at most STEP_MAX_LINES lines and STEP_MAX_CHARS
 * characters, then `…`. */
export function clipStep(text: string): string {
  const cut = text.split('\n').slice(0, STEP_MAX_LINES).join('\n').slice(0, STEP_MAX_CHARS);
  return cut === text ? text : `${cut}…`;
}

/** Where a failed step sits in its run (#267): index counts from 0 with the skipped steps (#390), total is the whole expanded list. */
interface StepPlace { index: number; total: number }

// The task's reason for a failed step (#267): a RUN's exit code in words, its timeout or its stop, with its output tail on the lines below,
// or, when it printed nothing, a hint, since a line that hides its errors (#105's `2>/dev/null`) leaves only the code; else the error's message.
function reasonOf(err: unknown, timeout?: string): string {
  if (!(err instanceof RunFailure)) return errorMessage(err);
  const exited = typeof err.code === 'number' ? `the command exited with code ${err.code}` : undefined;
  if (exited !== undefined && err.tail === '') return `${exited} ${SILENT}`;
  const reason = exited ?? (err.code === TIMEOUT ? `timed out after ${timeout}` : err.message);
  return err.tail === '' ? reason : `${reason}\n${err.tail}`;
}

/** The worktree's own git dir (<repo>/.git/worktrees/<slug>), where the markers live. An answer that is no absolute path is refused: a marker
 * must never land relative to the Hive's cwd. */
export async function gitDirOf(machine: Machine, worktree: string): Promise<string> {
  const dir = (await gitOrWords(worktree, ['rev-parse', '--absolute-git-dir'], machine.exec)).trim();
  if (!isAbsolute(dir)) throw new Error(`git named no git dir for ${worktree}`);
  return dir;
}

// DEL <path> (#654): only in the worktree, never through a symlinked folder. resolve drops a trailing /, so a link is removed as a link and its
// target is never followed. Missing counts as done.
async function delStep(machine: Machine, worktree: string, step: SetupStep): Promise<string> {
  await refuseLinkedParent(machine, worktree, WORKTREE_NAME, step.arg);
  const target = resolve(worktree, step.arg);
  const found = await machine.fs.lstat(target).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return false;
    throw err;
  });
  if (!found) return `nothing to delete: ${step.arg}`;
  const files = await countFiles(machine, target);
  await machine.fs.rm(target, { recursive: true });
  return `deleted ${step.arg} (${files} files)`;
}

// A RUN's answer as the step's outcome (#299): an exit code, a signal, its timeout or a stop is a RunFailure with the tail the task shows;
// a run that never started (sh not found) fails with the machine's words, as the spawn error did
function checkRun(ran: RunResult): void {
  if (ran.code === 0) return;
  const { code } = ran;
  const ended = typeof code === 'number' || code === TIMEOUT || code === STOPPED || code.startsWith('SIG');
  throw ended ? new RunFailure(code, ran.tail) : new Error(ran.failure ?? `failed to run (${code})`);
}

// One COPY, DEL or RUN (a LOAD never gets here: runSteps expanded it). A COPY and a DEL answer their result line. A RUN is the one shell
// string of the step runner (see CLAUDE.md): the user's own line, run by the machine's POSIX shell in the worktree, its output live (#351)
async function doStep(machine: Machine, phase: Phase, worktree: string, step: SetupStep, deps: StepDeps & { timeoutMs?: number; env: NodeJS.ProcessEnv }): Promise<string | undefined> {
  if (step.kind === 'copy') return copyStep(machine, phase, step);
  if (step.kind === 'del') return delStep(machine, worktree, step);
  const ran = await machine.run({
    command: machine.info().shell, args: ['-c', step.arg], cwd: worktree, env: deps.env, timeoutMs: deps.timeoutMs, signal: deps.signal,
    maxBytes: Number.POSITIVE_INFINITY, // ponytail: runShell kept no cap either; the tail is what the task keeps
    ...(deps.output === undefined ? {} : { onOutput: deps.output }),
  });
  checkRun(ran);
  return undefined;
}

// A LOAD fails before the list is expanded (#299), so it has no place and keeps the line alone
const failure = (phase: Phase, step: SetupStep, reason: string, place?: StepPlace): string => {
  const described = clipStep(describeStep(step));
  const where = place === undefined ? `line ${step.line} (${described})` : `step ${place.index + 1} of ${place.total} (line ${step.line}, ${described})`;
  return `${phase.name} failed at ${where}: ${reason}`;
};

// LOAD <file> (#299): read from the main checkout at every run, in both scripts, so editing it needs no Settings save and a branch cannot
// change what runs; one level only. Its steps take the LOAD's line number, so a failure names a line of the Settings text.
async function loadSteps(machine: Machine, phase: Phase, workspace: Workspace, load: SetupStep): Promise<SetupStep[]> {
  try {
    return (await readLoad(machine, workspace, load)).map((step) => ({ ...step, line: load.line }));
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
async function runStep(machine: Machine, phase: Phase, worktree: string, step: SetupStep, place: StepPlace, deps: StepDeps & { timeoutMs?: number; env: NodeJS.ProcessEnv }): Promise<void> {
  if (deps.signal?.aborted) throw new Error(failure(phase, step, STOPPED, place)); // a stop between steps: the next one never starts (#351)
  const described = describeStep(step);
  const began = Date.now();
  deps.onStep?.(described);
  deps.output?.(`${commandLine(`> ${described}`)}\n`);
  const done = await doStep(machine, phase, worktree, step, deps).then((result) => ({ ok: true as const, result }), (err: unknown) => ({ ok: false as const, err }));
  const ms = Date.now() - began;
  const outcome = done.ok ? 'ok (0)' : `failed (${done.err instanceof RunFailure ? done.err.code : 'error'})`;
  deps.log.info(`${phase.name} ${basename(worktree)} line ${step.line}: ${described} ${outcome} ${ms}ms`);
  const code = !done.ok && done.err instanceof RunFailure ? { code: done.err.code } : {}; // #390: the dialog's failed row
  report(deps, phase, step, { kind: STEP_KINDS[step.kind], index: place.index, durationMs: ms, ok: done.ok, ...code });
  if (!done.ok) throw new Error(failure(phase, step, reasonOf(done.err, phase.timeout), place));
  // The result line, then ok and its time (#654); a failure writes nothing here: the run's red end line sits right under the step
  if (done.result !== undefined) deps.output?.(`${done.result}\n`);
  deps.output?.(`${okLine(`ok ${ms}ms`)}\n`);
}

/** A script's LOAD lines read from the main checkout and expanded in place (#299): what runSetup hashes before anything runs (#390). */
export async function expandSteps(machine: Machine, phase: Phase, workspace: Workspace, steps: SetupStep[]): Promise<SetupStep[]> {
  return (await Promise.all(steps.map((step) => (step.kind === 'load' ? loadSteps(machine, phase, workspace, step) : [step])))).flat();
}

/** A script's steps in `worktree` (#299, #654): the LOAD lines are expanded first, then each step runs in order with the phase's timeout. A
 * resume (#390) skips the steps a failed run passed and records each step that passes; onPlan hears the whole list first. A failure throws
 * `<phase> failed at step <i> of <n> (line <l>, <step>): <reason>` (#267). Answers how many steps ran, for the run's summary. */
export async function runSteps(machine: Machine, phase: Phase, workspace: Workspace, worktree: string, steps: SetupStep[], deps: StepDeps): Promise<number> {
  const expanded = await expandSteps(machine, phase, workspace, steps); // a list runSetup already expanded holds no LOAD: the same list back
  const timeoutMs = phase.timeout === undefined ? undefined : timeoutMsOf(phase.timeout);
  // #738: every RUN sees the workspace's env, its setup's and its teardown's alike; COPY, DEL, LOAD and the Hive's git never read it.
  // #631: on win32 MSYS leaves the line's arguments as written, unless the workspace says otherwise
  const env = { ...process.env, ...posixShellEnv(machine.info().platform), ...workspace.env };
  const skip = deps.resume?.skip ?? 0;
  deps.onPlan?.(expanded.map(describeStep), skip);
  for (const [at, step] of expanded.slice(skip).entries()) {
    await runStep(machine, phase, worktree, step, { index: skip + at, total: expanded.length }, { ...deps, timeoutMs, env });
    // the progress file only saves a resume: one that cannot be written costs the next run its skip, never this setup
    await deps.resume?.passed(skip + at + 1).catch(() => undefined);
  }
  return expanded.length - skip;
}
