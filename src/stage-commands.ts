import { randomUUID } from 'node:crypto';
import { heldRun, taskOfActivity, withActivity } from './activities.js';
import { withResult, withRun } from './record-kit.js';
import { ensureActivity, none, type Reduced, releaseWorker, slugTaken, sourceWrites, stoppedWork, withTask } from './reducer-kit.js';
import { onSource, resolveWorkspace, stageOf } from './tasks.js';
import { advance, haltGone } from './transit.js';
import { exitOf } from './transitions.js';
import { CHECKS_FAILED, type Activity, type CommandFailure, type Effect, type HiveEvent, type Stage, type StageCommands, type State, type Task, type Worker, type WorkerEventKind } from './types.js';

// A stage that runs a list of the workspace's commands instead of a prompt (#755), out of orchestrator.ts, which is over 800 lines. Pure:
// every function returns new objects. The server runs each command in a pty of its own (server-stage-commands.ts) and answers with
// stageCommandEnded or stageCommandsRefused. A save that deletes the stage while it runs moves the task and marks the run stageGone (#861): its end routes no verdict and the task halts. The run holds a worker for its life, freed before its verdict is
// routed (#727).

// The effect that runs command `run.at` of the stage
const commandEffect = (activity: Activity, task: Task, stage: Stage, run: StageCommands): Effect =>
  ({ type: 'stageCommand', activity, task, stage, at: run.at, ptyId: run.ptyId });

/** What a held stage's start shares (#727, #877): the slug check, the activity born for it when it has none and unstopped, the onStart list
 * written in order, as a prompt stage's start writes it, the workspace frozen and `workers[index]` held. The worker has no run id and no
 * activity (no session), which the caps count and no session view lists. `none(...)` when it cannot start. */
export interface HeldStart { state: State; task: Task; activity: Activity; worker: Worker; stage: Stage; effects: Effect[] }
export function heldStart(given: State, task: Task, index: number, kind: WorkerEventKind, action: 'commands' | 'evaluate'): HeldStart | Reduced {
  const stage = stageOf(given.stages, task.stage);
  const taken = slugTaken(given, task);
  if (taken) return none(taken);
  const born = ensureActivity(given, task);
  const slot = born?.state.workers[index];
  if (!born || !slot || stage?.action !== action) return none(given); // the fill and start only pass a task with a workspace
  const written = sourceWrites(task, onSource(stage.onStart, task.item.source));
  const workspace = resolveWorkspace(task, born.state.workspaces, born.state.sourceWorkspaces, born.state.tasks); // frozen as a spawn freezes it (#179)
  const started: Task = { ...written.task, ...(workspace === undefined ? {} : { workspace }) };
  const { stopped: _stopped, stoppedAt: _stoppedAt, ...unstopped } = born.activity;
  const worker: Worker = { id: slot.id, status: 'working', stage: stage.name, startedAt: new Date().toISOString(), lastEvent: { kind }, ...(slot.draining ? { draining: true } : {}) };
  const held: State = { ...born.state, workers: born.state.workers.map((w, i) => (i === index ? worker : w)) };
  return { state: withTask(held, started), task: started, activity: unstopped, worker, stage, effects: written.effects };
}

/** A commands stage starts on the task (#755) in `workers[index]` (#727), through heldStart: the first command's run on the activity and its
 * effect. The run holds the worker for its life (each command has a pty of its own). A slug another task owns refuses it as a spawn is refused,
 * with the error on the task. */
export function startCommands(given: State, task: Task, index: number, kind: WorkerEventKind): Reduced {
  const held = heldStart(given, task, index, kind, 'commands');
  if (!('worker' in held)) return held;
  const ptyId = randomUUID();
  const run: StageCommands = { stage: held.stage.name, at: 0, ptyId, runId: ptyId, failed: [], workerId: held.worker.id, started: [] };
  const running: Activity = { ...held.activity, commands: run };
  return { state: withActivity(held.state, running), effects: [...held.effects, commandEffect(running, held.task, held.stage, run)] };
}

/** Every commands run's worker (#727: occupied, no run id) that no activity's run names any more frees, after every event: the boot dropped
 * every run (their ptys died with the Hive, as loadState already empties such a worker from a file), and a task that left mid-run (a save that
 * removed its stage) took its activity with it, so the run's end would never find the worker. */
export function freedLostRuns(state: State): State {
  const lost = state.workers.filter((w) => w.status !== 'empty' && w.runId === undefined && !state.activities.some((a) => heldRun(a)?.workerId === w.id));
  return lost.length === 0 ? state : { ...state, workers: lost.reduce(releaseWorker, state.workers) };
}

// The worker the run held frees with its end, whatever the end, and before #134's routing takes the verdict anywhere (#727): a draining one
// leaves, any other empties for the fill, which decides what runs next under the signal. Its time joins the task first (#617): the worker
// holds no activity, so releaseRun never finds it. A commands run's or an evaluation's (#877)
export function releaseHeld(state: State, activity: Pick<Activity, 'id' | 'commands' | 'evaluate'>): State {
  const held = heldRun(activity);
  const worker = held && state.workers.find((w) => w.id === held.workerId);
  if (!worker) return state;
  const task = taskOfActivity(state, activity.id);
  const counted = task ? withRun(state, task, worker, Date.now()) : state;
  return { ...counted, workers: releaseWorker(counted.workers, worker) };
}

// The run `ptyId` answers for, with its activity and task; undefined for an older pty (a late exit after a stop), during a Quit (its kills
// never end the stage) and once the task or its activity left
function runOf(state: State, activityId: string, ptyId: string): { activity: Activity; run: StageCommands; task: Task } | undefined {
  if (state.cleanStop) return undefined;
  const activity = state.activities.find((a) => a.id === activityId);
  const task = activity && taskOfActivity(state, activity.id);
  const run = activity?.commands;
  return activity && task && run?.ptyId === ptyId ? { activity, run, task } : undefined;
}

// failed: the verdict and the output on the record, the run gone, the task stopped in its stage with the failures named, out of the automation
// until a manual start, as a refused delete activity leaves it. No go-back and no loop without a failed transition (#134)
function failCommands(state: State, activity: Activity, task: Task, output: string, list: string, runId: string): Reduced {
  const { commands: _commands, ...rest } = activity;
  const stopped: Activity = { ...rest, stopped: true, stoppedAt: new Date().toISOString(), error: `${CHECKS_FAILED}${list}` };
  return none(withResult(withActivity(releaseHeld(state, activity), stopped), task, { commands: { verdict: 'failed', output, runId } }));
}

// failed (#134): a failed transition takes the task on with the output on the record; without one it stops as before (failCommands)
function failedCommands(state: State, activity: Activity, task: Task, output: string, list: string, runId: string): Reduced {
  const freed = releaseHeld(state, activity);
  if (exitOf(freed, task.stage, 'verdict', 'failed') === undefined) return failCommands(freed, activity, task, output, list, runId);
  const { commands: _commands, ...rest } = activity;
  const failed = withResult(withActivity(freed, rest), task, { commands: { verdict: 'failed', output, runId } });
  const { state: advanced, effects } = advance(failed, task, { trigger: 'verdict', verdict: 'failed', cause: list }); // #915: the try's cause
  return { state: advanced, effects };
}

// #861: the stage was deleted under the run: no verdict routes, the run goes and the task halts in the stage it was moved to
function goneCommands(state: State, activity: Activity, task: Task, gone: string): Reduced {
  const { commands: _commands, ...rest } = activity;
  return none(haltGone(withActivity(releaseHeld(state, activity), rest), task, gone).state);
}

// The stage's end (runId: the execution, which the verdict keeps so ver saída stays scoped to it): passed merges its verdict and moves the task on, as a deleted activity's stage does; any failure fails it
function endCommands(state: State, activity: Activity, task: Task, failed: readonly CommandFailure[], runId: string): Reduced {
  if (activity.stageGone !== undefined) return goneCommands(state, activity, task, activity.stageGone);
  if (failed.length > 0) {
    const output = failed.map((f) => `${f.name} (${f.code})\n${f.output}`).join('\n\n');
    return failedCommands(state, activity, task, output, failed.map((f) => `${f.name} (${f.code})`).join(', '), runId);
  }
  const { commands: _commands, ...rest } = activity;
  const passed = withResult(withActivity(releaseHeld(state, activity), rest), task, { commands: { verdict: 'passed', runId } });
  const { state: advanced, effects } = advance(passed, task, { trigger: 'verdict', verdict: 'passed' }); // #134: passed fires its transition
  return { state: advanced, effects };
}

/** A command of the stage ended (#755): 0 goes on to the next one; any other code is kept and, with stopOnFailure, ends the stage; past the
 * last command the stage ends, passed when nothing failed. The next command gets a fresh pty. */
export function stageCommandEnded(state: State, { activityId, ptyId, code, output }: Extract<HiveEvent, { type: 'stageCommandEnded' }>): Reduced {
  const found = runOf(state, activityId, ptyId);
  if (!found) return none(state);
  const { activity, run, task } = found;
  const stage = stageOf(state.stages, run.stage);
  const names = stage?.commands ?? [];
  const failed = code === 0 ? run.failed : [...run.failed, { name: names[run.at] ?? '', code, output }];
  const next = run.at + 1;
  if (stage === undefined || next >= names.length || (code !== 0 && stage.stopOnFailure === true)) return endCommands(state, activity, task, failed, run.runId);
  const { outputAt: _outputAt, ...kept } = run; // #914: the last output was the command that ended
  const moved: StageCommands = { ...kept, at: next, ptyId: randomUUID(), failed };
  const running: Activity = { ...activity, commands: moved };
  return { state: withActivity(state, running), effects: [commandEffect(running, task, stage, moved)] };
}

/** The current command's pty started, or the command was skipped (#914): its start by index, for the running block's times; an index before it
 * that never got a start (its pty never started) reads ''. Another pty's start changes nothing. */
export function stageCommandStarted(state: State, { activityId, ptyId, at, skipped }: Extract<HiveEvent, { type: 'stageCommandStarted' }>): State {
  const found = runOf(state, activityId, ptyId);
  if (!found) return state;
  const { activity, run } = found;
  const started = Array.from({ length: run.at + 1 }, (_, i) => (i === run.at ? at : run.started[i] ?? ''));
  const skips = skipped ? { skipped: [...(run.skipped ?? []), run.at] } : {};
  return withActivity(state, { ...activity, commands: { ...run, started, ...skips } });
}

/** The current command wrote output (#914), throttled by the server: the running block's silence line counts from it. Another pty's changes nothing. */
export function stageCommandOutput(state: State, { activityId, ptyId, at }: Extract<HiveEvent, { type: 'stageCommandOutput' }>): State {
  const found = runOf(state, activityId, ptyId);
  return found ? withActivity(state, { ...found.activity, commands: { ...found.run, outputAt: at } }) : state;
}

/** The stage could not run (#755): a name not enabled in the task's workspace, or its worktree failed. failed, with the message as its output. */
export function stageCommandsRefused(state: State, { activityId, ptyId, message }: Extract<HiveEvent, { type: 'stageCommandsRefused' }>): Reduced {
  const found = runOf(state, activityId, ptyId);
  if (!found) return none(state);
  if (found.activity.stageGone !== undefined) return goneCommands(state, found.activity, found.task, found.activity.stageGone); // #861
  return failedCommands(state, found.activity, found.task, message, message.split('\n').join(', '), found.run.runId);
}

/** The activity's commands stage stopped (#755): a Stop, a sleep, a delete or the task leaving. Its pty is killed under the activity's slug, the
 * run goes and the activity is stopped, with no verdict: a killed pty exits 0 under node-pty, and its late end finds no run to answer. The same
 * state when no commands stage runs there. */
export function haltCommands(state: State, activityId: string): Reduced {
  const activity = state.activities.find((a) => a.id === activityId);
  if (activity?.commands === undefined) return none(state);
  const { commands, ...rest } = activity;
  return { state: withActivity(releaseHeld(state, activity), stoppedWork(rest)), effects: [{ type: 'kill', slug: activity.slug ?? '', ptyId: commands.ptyId }] };
}
