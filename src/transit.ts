import { activityOf, resultOf, withActivity } from './activities.js';
import { withoutControls } from './pty-paste.js';
import { ensureActivity, type Reduced, settleEntries, sourceWrites, stoppedWork, withTask } from './reducer-kit.js';
import { renderPrompt, verdictsLine } from './spawn.js';
import { stageSession } from './task-runs.js';
import { canMoveToStage, enter, onSource, stageOf, taskId } from './tasks.js';
import { exitName, exitOf, isAutomatic, outgoing, needsHandover, resolveSession, takeTry, transitionKey, transitionPrompt, verdictsOf, verdictText } from './transitions.js';
import {
  END, FEEDBACK_MAX, NO_TRANSITION, TRIES_OUT, type Activity, type Effect, type Handover, type Stage, type State, type Task, type Transition, type Trigger, type TryRecord,
} from './types.js';

// A stage end taking its transition (#134): the source writes, the move, the arrow the task came through. Out of reducer-kit.ts, which this
// would push past 400 lines. Pure: every function returns new objects.

/** How a stage ended (#134): its trigger, the verdict it gave, the user's feedback, and (#812) the free session whose hive_done ended it.
 * (#915) cause: the failed commands or checks a commands or wait-for-CI end names, what its try records. */
export interface EndOf { trigger: Trigger; verdict?: string; feedback?: string; sessionId?: string; cause?: string }

/** A stage end's outcome: the state, the task as stored, the stage it entered (none on end, a hold or a stop) and the source writes. */
export interface Advanced {
  state: State; moved: Task; next?: Stage; effects: Effect[];
  transition?: Transition; // the one taken
  handover?: Handover; // what the destination's next run is told, when the transition says more than its stage would
}

const held = (state: State, task: Task, effects: Effect[] = []): Advanced => ({ state: withTask(state, task), moved: task, effects });

// The task stays in its stage, out of the fill until a manual start or a move, with an error the card reads in the viewer's language
function halted(state: State, task: Task, error: string): Advanced {
  const born = ensureActivity(state, task);
  return { state: born ? withActivity(born.state, { ...stoppedWork(born.activity), error }) : state, moved: task, effects: [] };
}

// Out of the Hive, as past the last stage before #134: the task goes, its activity stays for its record
function left(state: State, task: Task, effects: Effect[]): Advanced {
  return { state: settleEntries(state.tasks, { ...state, tasks: state.tasks.filter((c) => taskId(c) !== taskId(task)) }), moved: task, effects };
}

// The arrow the task came through and the tries it took, on its activity: what the card reads. A user's transition drops the tries (#134: a
// review's feedback earns the loop its tries back); a task with no activity gets one only when there is a try to keep. #915: the log keeps
// only the records of the counters it explains
function routed(state: State, task: Task, transition: Transition, tries: Record<string, number>): State {
  const kept = Object.keys(tries).length > 0;
  const live = activityOf(state, taskId(task));
  const born = live === undefined ? (kept ? ensureActivity(state, task) : undefined) : { state, activity: live };
  if (born === undefined) return state;
  const { tries: _was, tryLog, ...rest } = born.activity;
  const log = (tryLog ?? []).filter((r) => tries[r.transition] !== undefined);
  return withActivity(born.state, { ...rest, ...(kept ? { tries } : {}), ...(log.length > 0 ? { tryLog: log } : {}), via: transitionKey(transition) });
}

// Into `to` with a fresh entry, or out on end. A loop to its own stage is no new entry: `after`, the pin and the entry stay
function moveOn(state: State, task: Task, transition: Transition, end: EndOf, effects: Effect[]): Advanced {
  if (transition.to === END) return { ...left(state, task, effects), transition };
  const next = stageOf(state.stages, transition.to);
  if (next === undefined) return { ...held(state, task, effects), transition };
  const moved = next.name === task.stage ? task : enter(task, next);
  const entered = settleEntries(state.tasks, withTask(state, moved));
  const handover = handoverOf(entered, moved, transition, next, end);
  return { state: handover === undefined ? entered : withHandover(entered, moved, handover), moved, next, effects, transition, ...(handover === undefined ? {} : { handover }) };
}

// The run that just ended, as `previous` resumes it (#134): the free session whose hive_done ended the stage when one did (#812, #483: it ran
// no stage, so stageSession never finds it), else the latest session that ran the origin, else the activity's
const endedRun = (state: State, task: Task, transition: Transition, end?: EndOf): Pick<Activity, 'sessionId'> =>
  ({ sessionId: end?.sessionId ?? stageSession(task, state, transition.from)?.id ?? activityOf(state, taskId(task))?.sessionId });

// What the destination's next run is told (#134), only when the transition says more than its stage would: its own prompt, a feedback, a
// session of its own. Rendered here, {verdict} and {feedback} in the item's single pass
function handoverOf(state: State, task: Task, transition: Transition, next: Stage, end: EndOf): Handover | undefined {
  if (next.prompt === undefined || !needsHandover(transition)) return undefined;
  const session = resolveSession(state, task, endedRun(state, task, transition, end), transition, next);
  const result = resultOf(state, taskId(task));
  const vars = { verdict: transition.when === 'verdict' ? verdictText(stageOf(state.stages, transition.from), result) : '', feedback: end.feedback ?? '' };
  const prompt = renderPrompt(transitionPrompt(transition, next, session.policy), task.item, result, vars) + verdictsLine(next); // #134: the destination's verdicts, whatever session reads it
  return session.policy === 'continue' ? { prompt, sessionId: session.sessionId } : { prompt };
}

// The handover on the task's activity, born for it when it has none: the next spawn takes it
function withHandover(state: State, task: Task, handover: Handover): State {
  const born = ensureActivity(state, task);
  return born ? withActivity(born.state, { ...born.activity, handover }) : state;
}

/** The activity without its handover (#134): a session typed into already has it. */
export function withoutHandover(state: State, task: Task): State {
  const live = activityOf(state, taskId(task));
  if (live?.handover === undefined) return state;
  const { handover: _handover, ...rest } = live;
  return withActivity(state, rest);
}

/** Whether `transition` hands `next` the session the task's run holds now (#134): only then may the run go on in place, a held Stop included. */
export function keepsRun(state: State, task: Task, transition: Transition, next: Stage): boolean {
  const live = activityOf(state, taskId(task));
  const session = resolveSession(state, task, endedRun(state, task, transition), transition, next);
  return next.prompt !== undefined && session.policy === 'continue' && session.sessionId === live?.sessionId;
}

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

// The try take just counted (#915), as the try history reads it: the failed names a commands or wait-for-CI end gave, else the exit name; the
// first line of what {verdict} reads, only on a verdict end (a done carries no evidence, and an older verdict may still sit on the record)
function tryRecord(state: State, task: Task, transition: Transition, end: EndOf, n: number): TryRecord {
  const text = end.trigger === 'verdict' ? verdictText(stageOf(state.stages, transition.from), resultOf(state, taskId(task))) : '';
  return {
    transition: transitionKey(transition), n, max: transition.maxTries ?? 0, cause: end.cause ?? exitName(end.trigger, end.verdict),
    error: firstLine(text), at: new Date().toISOString(), stage: transition.to,
  };
}

// The record on the activity after the move, which a task leaving on end keeps too; the destination's session when the handover names one
function logged(advanced: Advanced, task: Task, record: TryRecord): Advanced {
  const live = activityOf(advanced.state, taskId(task));
  if (live === undefined) return advanced;
  const sessionId = advanced.handover?.sessionId;
  const entry: TryRecord = sessionId === undefined ? record : { ...record, sessionId };
  return { ...advanced, state: withActivity(advanced.state, { ...live, tryLog: [...(live.tryLog ?? []), entry] }) };
}

// A transition past its count (#915: take's and a retry's): its sources written in order, as onFinish was (#286, #515), a leaving action
// holding the task until the source answers; then the arrow and the tries on the activity, and the move
function pass(state: State, task: Task, transition: Transition, end: EndOf, tries: Record<string, number>): Advanced {
  const { task: written, effects } = sourceWrites(task, onSource(transition.sources, task.item.source));
  const marked = routed(state, written, transition, tries);
  if (written.leaving) return { ...held(marked, written, effects), transition };
  return moveOn(marked, written, transition, end, effects);
}

/** The task through `transition` (#134): an automatic one with maxTries counts a try first, and out of them the task stops in its stage with
 * TRIES_OUT, its verdict kept on the record; then pass. A counted try leaves its record (#915); the exhausting end is no try. A task already
 * leaving is left as it is. */
export function take(state: State, task: Task, transition: Transition, end: EndOf): Advanced {
  if (task.leaving) return { ...held(state, task), transition };
  const live = activityOf(state, taskId(task));
  const tries = isAutomatic(transition.when) ? takeTry(live, transition) : {};
  if (tries === undefined) return halted(state, task, `${TRIES_OUT}${exitName(transition.when, transition.verdict)} · ${transition.maxTries ?? 0}`);
  const advanced = pass(state, task, transition, end, tries);
  const key = transitionKey(transition);
  const n = tries[key] ?? 0;
  return n > (live?.tries?.[key] ?? 0) ? logged(advanced, task, tryRecord(state, task, transition, end, n)) : advanced;
}

/** hive_done's result with its verdict (#134): `result.verdict = { name, evidence? }`, what {verdict} and the panel read. The evidence loses
 * its control characters, as the user's feedback does: it is rendered into prompts and may be typed into a live pty. */
export const withVerdict = (result: Record<string, unknown> | undefined, verdict?: string, evidence?: string): Record<string, unknown> | undefined =>
  (verdict === undefined ? result : { ...result, verdict: { name: verdict, ...(evidence === undefined ? {} : { evidence: withoutControls(evidence) }) } });

const EVIDENCE_ALONE_MESSAGE = 'evidence needs a verdict';
const NO_VERDICT_MESSAGE = 'this stage gives no verdict';
const EVIDENCE_SIZE_MESSAGE = `evidence must be at most ${FEEDBACK_MAX} characters`;

/** Why hive_done's verdict is refused, or undefined (#134): one of the stage's verdicts, the list named when it is not; an evidence only with a
 * verdict, at most FEEDBACK_MAX characters. Here, beside withVerdict, rather than in mcp.ts, which it would push past 400 lines. */
export function verdictProblem(verdict: string | undefined, evidence: string | undefined, stage: Pick<Stage, 'action' | 'prompt' | 'verdicts'> | undefined): string | undefined {
  if (verdict === undefined) return evidence === undefined ? undefined : EVIDENCE_ALONE_MESSAGE;
  const allowed = stage === undefined ? [] : verdictsOf(stage);
  if (!allowed.includes(verdict)) return allowed.length === 0 ? NO_VERDICT_MESSAGE : `verdict must be one of this stage's: ${allowed.join(', ')}`;
  return evidence !== undefined && evidence.length > FEEDBACK_MAX ? EVIDENCE_SIZE_MESSAGE : undefined;
}

/** A move by hand (#134): the tries, their log (#915) and the arrow go with the stage left behind. */
export function unrouted(state: State, id: string): State {
  const live = activityOf(state, id);
  if (live === undefined || (live.tries === undefined && live.via === undefined && live.tryLog === undefined)) return state;
  const { tries: _tries, via: _via, tryLog: _tryLog, ...rest }: Activity = live;
  return withActivity(state, rest);
}

/** A stage end (#134): the transition its trigger fires, taken; none, and the task stops in its stage with NO_TRANSITION. A stage that vanished
 * under a running task lets it leave at its end, as before. */
export function advance(state: State, task: Task, end: EndOf): Advanced {
  if (task.leaving) return held(state, task);
  if (stageOf(state.stages, task.stage) === undefined) return left(state, task, []);
  const transition = exitOf(state, task.stage, end.trigger, end.verdict);
  return transition ? take(state, task, transition, end) : halted(state, task, `${NO_TRANSITION}${exitName(end.trigger, end.verdict)}`);
}

/** The transition whose tries ran out on the task (#915): the one leaving its stage whose exit the TRIES_OUT error names, only the limit after
 * it; undefined for any other error, or once a save removed or renamed that transition. (from, when, verdict) is unique, so the exit names one. */
export function retryTransition(state: Pick<State, 'transitions'>, task: Task, error: string | undefined): Transition | undefined {
  if (error === undefined || !error.startsWith(TRIES_OUT)) return undefined;
  return outgoing(state.transitions, task.stage).find((t) => {
    const prefix = `${TRIES_OUT}${exitName(t.when, t.verdict)} · `;
    return error.startsWith(prefix) && /^\d+$/.test(error.slice(prefix.length));
  });
}

/** Retry (#915): a task stopped with TRIES_OUT takes the spent transition again, as its automatic try would have: that transition's counter
 * back at 0 and its records gone, the other transitions' kept; the error and the stop go so its next run starts. The user's act: it counts no
 * try and records none. Undefined when the task is not halted so, the transition is gone, or a run holds it or it is leaving. */
export function retry(state: State, id: string): Reduced | undefined {
  const task = state.tasks.find((t) => taskId(t) === id);
  const live = activityOf(state, id);
  const transition = task && retryTransition(state, task, live?.error);
  if (task === undefined || live === undefined || transition === undefined || !canMoveToStage(task, state)) return undefined;
  const { error: _error, stopped: _stopped, stoppedAt: _stoppedAt, ...unstopped } = live;
  const { [transitionKey(transition)]: _spent, ...tries } = live.tries ?? {};
  const { state: next, effects } = pass(withActivity(state, unstopped), task, transition, { trigger: transition.when, verdict: transition.verdict }, tries);
  return { state: next, effects };
}
