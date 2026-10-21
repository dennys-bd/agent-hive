import { randomUUID } from 'node:crypto';
import { resultOf, taskOfActivity, withActivity } from './activities.js';
import { withResult } from './record-kit.js';
import { none, type Reduced } from './reducer-kit.js';
import { heldStart, releaseHeld } from './stage-commands.js';
import { stageOf, taskId } from './tasks.js';
import { advance } from './transit.js';
import { exitOf } from './transitions.js';
import { EVALUATION_FAILED, EVALUATION_REJECTED, type Activity, type HiveEvent, type JudgeScore, type ReviewFinding, type StageEvaluate, type State, type Task, type WorkerEventKind } from './types.js';

// An evaluate stage (#877), beside stage-commands.ts and out of orchestrator.ts, which is over 800 lines. Pure: every function returns new
// objects. The server runs the reviewers and the judge headless (server-evaluate.ts) and answers evaluateJudging, then evaluateEnded or
// evaluateBroken. The Hive, never the model, compares each score with the stage's threshold. The run holds a worker for its life, freed before
// its verdict is routed, as a commands run's (#727).

/** The most of the evidence and findings the record keeps (#877), in characters, the failing dimensions first: it has to fit a later prompt. */
export const EVALUATE_OUTPUT_MAX = 16_000; // ponytail: a fixed head; a setting if a Build ever needs more of it

/** An evaluation starts on the task (#877) in `workers[index]`: its onStart written, the mark on the activity, born for it when it has none, and
 * its effect with the record's result, which its rubric renders. A slug another task owns refuses it as a spawn is refused. */
export function startEvaluate(given: State, task: Task, index: number, kind: WorkerEventKind): Reduced {
  const held = heldStart(given, task, index, kind, 'evaluate');
  if (!('worker' in held)) return held;
  const evaluate: StageEvaluate = { stage: held.stage.name, runId: randomUUID(), workerId: held.worker.id, startedAt: new Date().toISOString(), phase: 'reviewing' };
  const running: Activity = { ...held.activity, evaluate };
  const state = withActivity(held.state, running);
  const result = resultOf(state, taskId(held.task));
  return { state, effects: [...held.effects, { type: 'evaluate', activity: running, task: held.task, stage: held.stage, runId: evaluate.runId, ...(result === undefined ? {} : { result }) }] };
}

interface Run { activity: Activity; run: StageEvaluate; task: Task }

// The evaluation `runId` answers for; undefined for an older one (a late answer after a Stop), during a Quit (its aborts never end the stage) and
// once the task or its activity left
function runOf(state: State, activityId: string, runId: string): Run | undefined {
  if (state.cleanStop) return undefined;
  const activity = state.activities.find((a) => a.id === activityId);
  const task = activity && taskOfActivity(state, activity.id);
  const run = activity?.evaluate;
  return activity && task && run?.runId === runId ? { activity, run, task } : undefined;
}

/** Every reviewer answered (#877): the judge runs. */
export function evaluateJudging(state: State, { activityId, runId }: Extract<HiveEvent, { type: 'evaluateJudging' }>): State {
  const found = runOf(state, activityId, runId);
  return found ? withActivity(state, { ...found.activity, evaluate: { ...found.run, phase: 'judging' } }) : state;
}

/** The dimensions under the threshold (#877, spec decision 3): one is enough to fail, never averaged away. */
export const failingScores = (scores: readonly JudgeScore[], threshold: number): JudgeScore[] => scores.filter((s) => s.score < threshold);

/** What result.evaluate.output holds (#877, spec decision 19): each failing dimension with its evidence, then each finding, capped at its head. */
export function evaluationOutput(failing: readonly JudgeScore[], findings: readonly ReviewFinding[], threshold: number): string {
  const dimensions = failing.map((s) => `${s.dimension} (${s.score}/${threshold}): ${s.evidence}`);
  const found = findings.map((f) => `${f.file}${f.line === undefined ? '' : `:${f.line}`} ${f.finding}`);
  return [...dimensions, ...found].join('\n').slice(0, EVALUATE_OUTPUT_MAX);
}

// The mark goes and the worker frees first (#727), whatever the end
const freed = (state: State, { activity }: Run): { state: State; rest: Activity } => {
  const { evaluate: _evaluate, ...rest } = activity;
  return { state: withActivity(releaseHeld(state, activity), rest), rest };
};
const routed = ({ state, effects }: Reduced): Reduced => ({ state, effects }); // advance returns more than the reduction
const stoppedWith = (rest: Activity, error: string): Activity => ({ ...rest, stopped: true, stoppedAt: new Date().toISOString(), error });

/** The judge answered (#877): passed when every score reaches the stage's threshold, failed otherwise, on the record with the scores and the
 * output, then routed by the verdict's transition (#134); failed with none stops the task in its stage, as CHECKS_FAILED does. */
export function evaluateEnded(state: State, { activityId, runId, scores, findings }: Extract<HiveEvent, { type: 'evaluateEnded' }>): Reduced {
  const found = runOf(state, activityId, runId);
  const stage = found && stageOf(state.stages, found.run.stage);
  if (!found || stage === undefined) return none(state); // a vanished stage halted the run first (vanished-stages.ts)
  const threshold = stage.threshold ?? 0;
  const failing = failingScores(scores, threshold);
  const verdict = failing.length === 0 ? 'passed' : 'failed';
  const { state: released, rest } = freed(state, found);
  const recorded = withResult(released, found.task, { evaluate: { verdict, scores, output: evaluationOutput(failing, findings, threshold) } });
  if (verdict === 'passed') return routed(advance(recorded, found.task, { trigger: 'verdict', verdict }));
  const cause = failing.map((s) => s.dimension).join(', ');
  if (exitOf(recorded, found.task.stage, 'verdict', 'failed') === undefined) return none(withActivity(recorded, stoppedWith(rest, `${EVALUATION_REJECTED}${cause}`)));
  return routed(advance(recorded, found.task, { trigger: 'verdict', verdict: 'failed', cause })); // #915: the failing dimensions, the try's cause
}

/** A run broke (#877, spec decision 17): a timeout, no answer, a refused answer or a wrong score count. No verdict and no try: the task stops in its
 * stage with the reason, out of the fill until a manual start, which runs the whole evaluation again. */
export function evaluateBroken(state: State, { activityId, runId, message }: Extract<HiveEvent, { type: 'evaluateBroken' }>): Reduced {
  const found = runOf(state, activityId, runId);
  if (!found) return none(state);
  const { state: released, rest } = freed(state, found);
  return none(withActivity(released, stoppedWith(rest, `${EVALUATION_FAILED}${message}`)));
}
