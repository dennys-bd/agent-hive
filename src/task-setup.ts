import { commandLine, type ConsoleStore, crlf, failLine, okLine, runHeader, SETUP_CHANNEL, setupRunId, type WorktreeRunKind } from './console.js';
import type { FactLog } from './facts.js';
import type { Logger } from './log.js';
import type { Pty, PtyHost } from './pty-host.js';
import { endedRows, failedRows, nestedEndedRows, nestedFailedRows, nestedHeader, nestedStartedRows, plannedRows, preparedRows, startedRows, worktreeRows } from './setup-rows.js';
import type { Task, Effect, Exec, HiveEvent, SetupRow, Workspace } from './types.js';
import type { BeforeRemove } from './worktree.js';
import { isSetUp, runSetup } from './worktree-setup.js';
import { clearTeardownMarker, runTeardown, type TeardownResult } from './worktree-teardown.js';
import type { RunShell, StepReport } from './worktree-steps.js';
import type { NestedEnd, NestedObserver } from './worktree-nested.js';

// A task's worktree setup as the user sees it (#351), shared by the stage spawn and a first /open: the task's run in the setup channel of the
// console (#353), live over the pty socket (#407) through a pipe the pty host serves, and the task's setup events.

export interface WorktreeRunDeps {
  exec: Exec; // git: the worktree's own and its git dir's
  log: Pick<Logger, 'info'>; // one line per step, the code only (#299)
  ptys: Pick<PtyHost, 'adopt' | 'subscribe'>;
  consoleStore: Pick<ConsoleStore, 'begin' | 'append' | 'end'>;
  run?: RunShell; // runShell unless a test injects one
  dispatch?(event: HiveEvent): Promise<Effect[]>; // a task's setupStep (#351); an orphan's run dispatches nothing
  facts?: Pick<FactLog, 'write'>; // #742: each step's worktree.step
}
export interface TaskSetupDeps extends WorktreeRunDeps { dispatch(event: HiveEvent): Promise<Effect[]> }

export interface WorktreeRunOptions {
  id: string; label: string; kind: WorktreeRunKind; activityId?: string;
  branch?: string; base?: string; // the branch row's (#390)
  nested?: readonly string[]; // #450: the workspace's nestedRepos, a queued row each
}

/** One worktree run in the console (#351, #654), from the first git to the end line. */
export interface WorktreeRun {
  id: string; // the run's, in SETUP_CHANNEL: what setupStarted carries as consoleId
  exec: Exec; // the deps' exec, each command and its outcome written to the run: the git that makes the worktree goes through it
  rows(): SetupRow[]; // #390: its rows now, what setupStarted carries
  prepared(): void; // #390: the worktree made: its worktree and branch rows done; #450: called right after the outer git, before the nested repos
  nested: NestedObserver; // #450: each repo's `> nested <path>` line and row, for prepareNested
  // runSetup through that exec, its steps to the task and its output to the run; it leaves the run open for end
  setUp(workspace: Workspace, worktree: string, signal?: AbortSignal): Promise<void>;
  skip(why: string): void; // `<kind> skipped: <why>` (#654); the run then ends clean, with no summary
  // the teardown in `worktree` (#654) when it is there, else skipped as gone; a failing step rejects and the run is left for end
  tearDown(workspace: Workspace, worktree: string, present: boolean): Promise<void>;
  end(failure?: unknown): void; // `<kind> ok · <n> steps · <ms>ms`, or the failure's first line (the lines above have the rest); the run joins the history
}

const GONE: TeardownResult = { outcome: 'gone', steps: 0 }; // a folder not on disk: nowhere to run it (#208)
const SKIPPED: Readonly<Record<'none' | 'done' | 'gone', string>> = { none: 'no teardown lines', done: 'already torn down', gone: 'worktree gone' };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type PipePty = Pty & { emit(data: string): void; exit(exitCode: number): void };

// A pty the host serves like a process's, fed by the setup instead: nothing reads a key or a size, and only its end ends it.
function pipePty(): PipePty {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  return {
    onData: (listener) => dataListeners.add(listener),
    onExit: (listener) => exitListeners.add(listener),
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    emit: (data) => {
      for (const listener of dataListeners) listener(data);
    },
    exit: (exitCode) => {
      for (const listener of exitListeners) listener({ exitCode });
    },
  };
}

// Each command the preparation runs, as a system log shows it (#351, #576): `> git <args>` in bright white, then ok and its time in green,
// or the failure's message in red. Never a success's stdout: it can be large and says nothing here.
function loggedExec(exec: Exec, write: (text: string) => void): Exec {
  return async (file, args, opts) => {
    write(`${commandLine(`> ${[file, ...args].join(' ')}`)}\n`);
    const began = Date.now();
    try {
      const result = await exec(file, args, opts);
      write(`${okLine(`ok ${Date.now() - began}ms`)}\n`);
      return result;
    } catch (err) {
      write(`${failLine(errorMessage(err).trimEnd())}\n`);
      throw err;
    }
  };
}

/** What a prepare is handed besides the logged exec (#450): the mark that the outer worktree is made, and the nested repos' observer. */
export type PrepareHooks = Pick<WorktreeRun, 'prepared' | 'nested'>;

// A task's run's rows as the Start dialog shows them (#390), each change dispatched whole with the step running, as describeStep writes it
// (the flow card's line). Only a task's run (activityId) dispatches; an orphan's run or a teardown keeps its list to itself.
function rowsTracker(dispatch: WorktreeRunDeps['dispatch'], { activityId, branch = '', base = '', nested = [] }: WorktreeRunOptions) {
  let rows = worktreeRows(branch, base, new Date().toISOString(), nested);
  let step: string | undefined;
  const show = (next: SetupRow[]): void => {
    if (next === rows) return; // nothing changed: no event
    rows = next;
    if (activityId !== undefined) void dispatch?.({ type: 'setupStep', activityId, ...(step === undefined ? {} : { step }), rows });
  };
  return {
    rows: (): SetupRow[] => rows,
    prepared: (): void => show(preparedRows(rows, Date.now())),
    nestedStarted: (path: string): void => show(nestedStartedRows(rows, path, new Date().toISOString())),
    nestedEnded: (path: string, end: NestedEnd): void => show(nestedEndedRows(rows, path, end, branch, Date.now())),
    nestedFailed: (path: string): void => show(nestedFailedRows(rows, path, Date.now())),
    onPlan: (steps: string[], skipped: number): void => show(plannedRows(rows, steps, skipped)),
    onStep: (described: string): void => {
      step = described;
      show(startedRows(rows, new Date().toISOString()));
    },
    onStepEnd: (report: StepReport): void => show(endedRows(rows, report)),
    failed: (): void => show(failedRows(rows, Date.now())),
  };
}

// #450: each nested repo's header line before its first git, where the dialog cuts its log, then its row. A repo refused before it
// started writes its header too, so the failure line end() writes reads as that repo's
function nestedObserver(write: (text: string) => void, tracked: ReturnType<typeof rowsTracker>): NestedObserver {
  const header = (path: string): void => write(`${commandLine(`> ${nestedHeader(path)}`)}\n`);
  return {
    started: (path) => {
      header(path);
      tracked.nestedStarted(path);
    },
    ended: tracked.nestedEnded,
    failed: (path) => {
      header(path);
      tracked.nestedFailed(path);
    },
  };
}

/** Begins a worktree run in SETUP_CHANNEL (#351, #654): a task's setup or teardown, or an orphan's teardown, whose header names the label
 * and the kind, the output kept by the store as a command run's is. Only a task's run (activityId, #629) dispatches its steps; the caller
 * marks and unmarks the activity, since the paths differ. */
export function openWorktreeRun(deps: WorktreeRunDeps, options: WorktreeRunOptions): WorktreeRun {
  const { id, label, kind, activityId } = options;
  const { log, dispatch, ptys, consoleStore, run, facts } = deps;
  const pty = pipePty();
  ptys.adopt(id, pty);
  consoleStore.begin(SETUP_CHANNEL, id, runHeader(label, new Date(), kind), activityId === undefined ? undefined : id); // #390: a task's runs are a group, so the Start dialog reads its own
  ptys.subscribe(id, (data) => consoleStore.append(id, data), (exitCode) => consoleStore.end(id, exitCode));
  const write = (text: string): void => pty.emit(crlf(text));
  const [exec, tracked, began] = [loggedExec(deps.exec, write), rowsTracker(dispatch, options), Date.now()];
  let [steps, skipped] = [0, false];
  const skip = (why: string): void => {
    skipped = true;
    write(`${kind} skipped: ${why}\n`);
  };
  // Each step's kind, place, time and outcome to facts.jsonl (#742); a task's run names its activity
  const onStepEnd = (report: StepReport): void => {
    facts?.write({
      event: 'worktree.step', level: report.ok ? 'info' : 'error', ...(activityId === undefined ? {} : { activity_id: activityId }),
      phase: kind, index: report.index, kind: report.kind, duration_ms: report.durationMs, outcome: report.ok ? 'ok' : 'failed',
    });
    tracked.onStepEnd(report);
  };
  return {
    id,
    exec,
    rows: tracked.rows,
    prepared: tracked.prepared,
    nested: nestedObserver(write, tracked),
    setUp: async (workspace, worktree, signal) => {
      steps = await runSetup(workspace, worktree, { exec, log, run, signal, output: write, onStep: tracked.onStep, onPlan: tracked.onPlan, onStepEnd });
    },
    skip,
    tearDown: async (workspace, worktree, present) => {
      const result = present ? await runTeardown(workspace, worktree, { exec, log, run, output: write, onStepEnd }) : GONE;
      if (result.outcome === 'ran') steps = result.steps;
      else skip(SKIPPED[result.outcome]);
    },
    // `<kind> ok · <n> steps · <ms>ms` (#654), or the failure's first line (the lines above have the rest)
    end: (failure) => {
      if (failure !== undefined) tracked.failed(); // #390: before the caller's setupEnded, which reads the failed row
      if (failure === undefined && skipped) { // the skip line already said why
        pty.exit(0);
        return;
      }
      write(`${failure === undefined ? okLine(`${kind} ok · ${steps} steps · ${Date.now() - began}ms`) : failLine(errorMessage(failure).split('\n')[0])}\n`);
      pty.exit(failure === undefined ? 0 : 1); // a failed run reads as failed in the console's status (#537)
    },
  };
}

/** A task's setup run (#390): its branch row's branch and base, and the stop a Stop's kill reaches (#351). */
export interface SetupRunOptions { branch: string; base: string; signal?: AbortSignal }

/** The stage spawn's worktree (#351, #576): `prepare` makes it at `worktree` through the exec it is handed and answers its path. A worktree
 * already there and set up (isSetUp: for a workspace without steps, any folder on disk) prepares with the plain exec: no run, no event. Else,
 * with or without setup steps, the task is marked before the worktree's git with the worktree and branch rows (#390), and that git and the
 * setup run between setupStarted and setupEnded in one console run. #450: the run is handed to `prepare`, which marks the outer worktree
 * made before the nested repos and passes their observer to prepareNested. A failure is rethrown after setupEnded: the spawn turns it into spawnFailed. */
export async function runTaskSetup(
  deps: TaskSetupDeps, task: Task, activityId: string, workspace: Workspace, worktree: string,
  prepare: (exec: Exec, run?: PrepareHooks) => Promise<string>,
  { branch, base, signal }: SetupRunOptions,
): Promise<string> {
  await clearTeardownMarker(workspace, worktree, deps.exec); // #654: used again, so its next removal takes the services down again
  if (await isSetUp(workspace, worktree, deps.exec)) return prepare(deps.exec);
  const setup = openWorktreeRun(deps, { id: setupRunId(task.item.itemId), label: `#${task.item.id}`, kind: 'setup', activityId, branch, base, nested: workspace.nestedRepos });
  await deps.dispatch({ type: 'setupStarted', activityId, consoleId: setup.id, rows: setup.rows() });
  try {
    const path = await prepare(setup.exec, setup);
    setup.prepared(); // a prepare that never marked it still ends the worktree and branch rows; after the mark, the same rows, no event
    await setup.setUp(workspace, path, signal);
    setup.end();
    return path;
  } catch (err) {
    setup.end(err);
    throw err;
  } finally {
    await deps.dispatch({ type: 'setupEnded', activityId });
  }
}

/** Which worktree a removal tears down (#654): its run's id and label, its workspace, and whether the removal is forced. */
export interface TeardownTarget { id: string; label: string; workspace: Workspace; force: boolean }

/** A worktree's removal with its teardown in a console run (#654). Without force, `remove` is handed a beforeRemove that runs the teardown
 * after git's checks (or writes why it skipped); with force the run says `teardown skipped: forced` and `remove` runs alone. The run ends
 * with the outcome, or with the failure, which is rethrown so each caller answers it as it answers a git refusal. */
export async function removeInRun(deps: WorktreeRunDeps, target: TeardownTarget, remove: (beforeRemove?: BeforeRemove) => Promise<void>): Promise<void> {
  const run = openWorktreeRun(deps, { id: target.id, label: target.label, kind: 'teardown' });
  if (target.force) {
    run.skip('forced');
    run.end();
    await remove();
    return;
  }
  let reached = false;
  let teardownFailure: unknown;
  try {
    await remove(async (path, present) => {
      reached = true;
      try {
        await run.tearDown(target.workspace, path, present);
      } catch (err) {
        teardownFailure = err;
        throw err;
      }
    });
  } catch (err) {
    // Only the teardown's own failure is a red line: a git refusal before it, or after it, is the caller's to answer.
    if (teardownFailure !== undefined) run.end(err);
    else {
      if (!reached) run.skip('removal refused');
      run.end();
    }
    throw err;
  }
  run.end();
}
