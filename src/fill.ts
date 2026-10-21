// What the Hive starts on its own (#727): the effective limits, the fill and the in-place continuation, out of orchestrator.ts, which is over
// 800 lines. One signal table decides: a new task needs `newTasks` (#32: always, or tree with its tree started), a started one waiting for a worker needs resume, a session that ends its
// stage needs continue (its session is #134's keepsRun, checked by the callers); caps and budget hold as before, and a manual act passes none
// of this. Pure: every function returns new objects.
import { liveDefaultAgent } from './agents.js';
import { behaviourOf, mayContinue, mayResume } from './signals.js';
import { candidates, isPastFirstStage, isStarted, stageOf, taskId } from './tasks.js';
import { holdsWorker, runsAgent } from './stage-agent.js';
import { treeStarted } from './task-tree.js';
import { hasBudget } from './usage.js';
import { activeRules, applyUsageRules, disableExpired, disabledStatuses, firedRules, isGlobalRule, rulePercents, stageCapRules, stageCaps, worstSignal } from './usage-rules.js';
import { hasRoom, isFree, occupy, type Reduced, slugTaken, stageHasRoom, withTask } from './reducer-kit.js';
import { startCommands } from './stage-commands.js';
import { startEvaluate } from './stage-evaluate.js';
import type { Effect, EffectiveLimits, SignalBehaviour, Stage, State, Task, Worker, WorkerEventKind } from './types.js';

/** effectiveLimits' answer with what its signal lets the Hive do (#727). */
export type Gate = EffectiveLimits & { behaviour: SignalBehaviour };

/** Effective signal and worker cap: the manual signal and the usage rules can only restrict each other, never loosen. `floor` is what the
 * fired rules alone impose and `signalRules` / `capRules` the fired rules sitting at each side of it (#87, #142). Shut down when done no longer
 * caps the signal (#727): it follows the flow's. A rule disabled from the strip (#297) counts for none of it and is listed in `disabledRules`;
 * an expired disable counts again at once. */
export function effectiveLimits(state: State, now: number): EffectiveLimits {
  const percent = rulePercents(state, now); // #929: each rule on its own agent's reading
  const disabled = state.disabledRules.filter((entry) => !disableExpired(entry, percent, now));
  const rules = activeRules(state.usageRules, disabled, liveDefaultAgent(state));
  const fired = firedRules(percent, rules);
  const floor = applyUsageRules(percent, rules);
  const caps = stageCaps(state.stages, fired); // #475: a stage rule caps its stage only
  return {
    signal: worstSignal(state.signal, floor.signal),
    ...(floor.maxWorkers === undefined ? {} : { maxWorkers: Math.min(state.maxConcurrent, floor.maxWorkers) }),
    floor,
    signalRules: fired.filter((rule) => rule.signal === floor.signal), // a stage rule has no signal
    capRules: floor.maxWorkers === undefined ? [] : fired.filter((rule) => isGlobalRule(rule) && rule.maxWorkers === floor.maxWorkers),
    disabledRules: disabledStatuses(state, disabled, now),
    stageCaps: caps, stageCapRules: stageCapRules(caps, fired),
  };
}

/** The limits with the row of the table their signal reads (#727). */
export function gateOf(state: State, now: number): Gate {
  const limits = effectiveLimits(state, now);
  return { ...limits, behaviour: behaviourOf(limits.signal, state.signals) };
}

/** A new task may start under `behaviour` with room in `workers`. `tree` could (#32): which task qualifies is the candidate filter's question. */
export const canStart = (behaviour: SignalBehaviour, workers: Worker[], limit?: number): boolean => behaviour.newTasks !== 'never' && hasRoom(workers, limit);

/** Whether a new task could start right now (#727): budget, `newTasks` and room. What the stale poll asks. */
export function canSchedule(state: State, now: number): boolean {
  const { behaviour, maxWorkers } = gateOf(state, now);
  return hasBudget(state.usage, state.budget, now) && canStart(behaviour, state.workers, maxWorkers);
}

// Whether `behaviour` lets the fill start `task`, which has not started (#32): any under always, none under never; under tree only one whose tree
// already started, a task of it with a live activity or past the first stage its source enters through (an activity ends, a finished child
// still counts). The task itself counts by its activity alone, which a new task never has: a standalone new task never starts under tree,
// wherever it entered
function mayStartNew(state: State, behaviour: SignalBehaviour, task: Task): boolean {
  if (behaviour.newTasks !== 'tree') return behaviour.newTasks === 'always';
  const started = (t: Task): boolean => isStarted(state, t) || (taskId(t) !== taskId(task) && isPastFirstStage(state.stages, t));
  return treeStarted(state.tasks, taskId(task), started);
}

// The tasks the fill may start, best first (#224, #727): a started one only by its row's resume, a new one only by mayStartNew, so a row that
// starts new tasks never hands a started one a worker its `stay` / `continueOnly` withholds; `keep` (the task a continuation asks about)
// passes whatever the resume says. Only a task whose stage has room under its cap (#475), counted on `state`.
function startable(state: State, gate: Gate, now: number, keep?: string): Task[] {
  const allowed = (c: Task): boolean => taskId(c) === keep || (isStarted(state, c) ? mayResume(gate.behaviour) : mayStartNew(state, gate.behaviour, c));
  return candidates(state, now).filter((c) => allowed(c) && stageHasRoom(state, c.stage, gate.stageCaps));
}

/** A held stage's first move in worker `index` (#727, #877): a commands run or an evaluation; what the fill, a continuation and a manual start call. */
export const startHeldRun = (state: State, task: Task, index: number, kind: WorkerEventKind, stage: Stage): Reduced =>
  (stage.action === 'evaluate' ? startEvaluate(state, task, index, kind) : startCommands(state, task, index, kind));

// A task's first move in a free worker: a held stage's run holds it (#727, #877), any other stage spawns its session
const run = (state: State, index: number, task: Task, stage: Stage, kind: WorkerEventKind): Reduced =>
  (holdsWorker(stage) ? startHeldRun(state, task, index, kind, stage) : occupy(state, index, task, stage, kind));

/** Every free worker takes the best task the table lets the Hive start. The gate is re-checked before every start against the workers as they
 * stand, so the cap counts what was just opened. */
export function fill(reduced: Reduced): Reduced {
  const now = Date.now();
  const gate = gateOf(reduced.state, now);
  const open = (workers: Worker[]): boolean => hasRoom(workers, gate.maxWorkers);
  if (gate.behaviour.newTasks === 'never' && !mayResume(gate.behaviour)) return reduced; // nothing could be picked up
  if (!hasBudget(reduced.state.usage, reduced.state.budget, now) || !open(reduced.state.workers)) return reduced;
  let { state } = reduced;
  const started: Effect[] = [];
  for (let i = 0; i < state.workers.length && open(state.workers); i += 1) {
    if (!isFree(state.workers[i])) continue;
    const task = startable(state, gate, now)[0];
    const stage = task && stageOf(state.stages, task.stage);
    if (!task || !stage) break;
    const taken = slugTaken(state, task);
    if (taken) { // this worker stays free for the round; the refused task is out of the candidates, so the next fill hands it on
      state = taken;
      continue;
    }
    const next = run(state, i, task, stage, 'starting');
    state = next.state;
    started.push(...next.effects);
  }
  return { state, effects: [...reduced.effects, ...started] };
}

// The continuation's own gate (#224, #727): continue in the row, budget and room on the state as if freed, and the task the first one the fill
// could start in that worker. A task in a later stage wins it, and so does a started one ahead of it while the row resumes. A task with auto off
// is compared as if it had it (#283).
function goesOn(freed: State, moved: Task): boolean {
  const now = Date.now();
  const gate = gateOf(freed, now);
  if (!mayContinue(gate.behaviour) || !hasBudget(freed.usage, freed.budget, now) || !hasRoom(freed.workers, gate.maxWorkers)) return false;
  const top = startable(withTask(freed, { ...moved, auto: true }), gate, now, taskId(moved))[0];
  return top !== undefined && taskId(top) === taskId(moved);
}

/** In-place continuation (#134: the caller already checked keepsRun): the destination has a prompt, the worker is not draining, and the gate
 * above lets the task go on; the destination's cap counts through startable (#475). */
export function canContinue(freed: State, worker: Worker, moved: Task, next: Stage): boolean {
  if (!runsAgent(next) || worker.draining) return false; // #710: a skill stage goes on in place too
  return goesOn(freed, moved);
}

/** A stage whose transition enters a commands or evaluate stage (#727, #877): keepsRun is false there (no prompt), so the session's run ended;
 * the held run takes the freed worker when the continuation's gate lets the task go on; otherwise the fill decides. A draining worker leaves
 * with its run. */
export function continueIntoHeld(ended: Reduced, worker: Worker, moved: Task, next: Stage | undefined): Reduced {
  if (next === undefined || !holdsWorker(next) || worker.draining) return ended;
  const index = ended.state.workers.findIndex((w) => w.id === worker.id);
  const task = ended.state.tasks.find((c) => taskId(c) === taskId(moved));
  if (index < 0 || !task || task.stage !== next.name || !goesOn(ended.state, task)) return ended;
  const started = startHeldRun(ended.state, task, index, 'continuing', next);
  return { state: started.state, effects: [...ended.effects, ...started.effects] };
}
