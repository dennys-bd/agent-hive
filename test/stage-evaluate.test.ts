import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf, withActivity } from '../src/activities.js';
import { deriveFacts } from '../src/fact-derive.js';
import { describeEffect, describeEvent } from '../src/log.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import type { Activity, Effect, HiveEvent, Item, JudgeScore, SourceItem, Stage, State, Transition } from '../src/types.js';

// An evaluate stage (#877): the reducer's side, end to end through reduce. The task is polled into the stage under green: the fill starts the
// evaluation in the one worker, and every effect below is the stage's own.

const ID = 'board:item1';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const listed = (column: string): SourceItem => ({ item, column });
const EVAL: Stage = {
  name: 'eval', from: { board: ['Eval'] }, action: 'evaluate', reviewers: [{ agent: 'claude', focus: 'security' }, { agent: 'codex', focus: 'the spec' }],
  judge: { agent: 'claude' }, threshold: 7, rubric: 'Meets the spec?\nTests cover it?\nNo regression?',
};
const BUILD: Stage = { name: 'build', from: { board: ['Build'] }, prompt: '/build' };
const PR: Stage = { name: 'pr', from: { board: ['PR'] } };
const PASSED: Transition = { from: 'eval', when: 'verdict', verdict: 'passed', to: 'pr' };
const FAILED: Transition = { from: 'eval', when: 'verdict', verdict: 'failed', to: 'build', maxTries: 2 };
const DIMS = ['Meets the spec?', 'Tests cover it?', 'No regression?'];
const scores = (...n: number[]): JudgeScore[] => n.map((score, i) => ({ dimension: DIMS[i], score, evidence: `evidence ${i + 1}` }));
const base = (transitions: Transition[] = [PASSED, FAILED], extra: Partial<State> = {}): State =>
  ({ ...initialState(1), signal: 'green', workspaces: ['hive'], syncs: { board: {} }, stages: [EVAL, BUILD, PR], transitions, ...extra });
const polled = (transitions?: Transition[]): Reduced => reduce(base(transitions), { type: 'poll', source: 'board', items: [listed('Eval')] });
const live = (s: State): Activity | undefined => activityOf(s, ID);
const evaluateOf = (effects: Effect[]) => effects.find((e): e is Extract<Effect, { type: 'evaluate' }> => e.type === 'evaluate');
const ids = (s: State) => ({ activityId: live(s)?.id ?? 'none', runId: live(s)?.evaluate?.runId ?? 'none' });
const ended = (s: State, n: number[], findings = [{ file: 'src/a.ts', line: 3, finding: 'no test' }]): Reduced =>
  reduce(s, { type: 'evaluateEnded', ...ids(s), scores: scores(...n), findings });
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

test('a due task in an evaluate stage starts one evaluation: the mark on its activity, one evaluate effect with the result, the one worker held, not due again (#877)', () => {
  const { state, effects } = polled();
  const mark = live(state)?.evaluate;
  assert.ok(mark);
  assert.deepEqual([mark.stage, mark.phase], ['eval', 'reviewing']);
  const effect = evaluateOf(effects);
  assert.ok(effect);
  assert.deepEqual([effect.runId, effect.stage.name, effect.task.item.itemId, effect.activity.evaluate], [mark.runId, 'eval', ID, mark]);
  assert.equal(effects.filter((e) => e.type === 'evaluate').length, 1);
  assert.deepEqual(state.workers.map((w) => [w.status, w.runId, w.id === mark.workerId]), [['working', undefined, true]]);
  assert.equal(evaluateOf(reduce(state, { type: 'poll', source: 'board', items: [listed('Eval')] }).effects), undefined);
});

test('evaluateJudging moves the phase; a stale run id changes nothing (#877)', () => {
  const s = polled().state;
  assert.equal(live(reduce(s, { type: 'evaluateJudging', ...ids(s) }).state)?.evaluate?.phase, 'judging');
  assert.equal(reduce(s, { type: 'evaluateJudging', activityId: ids(s).activityId, runId: 'old' }).state, s);
});

test('every score at the threshold passes: the record holds the verdict, the scores and the findings; the worker frees; the task moves by passed (#877)', () => {
  const done = ended(polled().state, [7, 9, 10]).state;
  assert.deepEqual([done.tasks[0].stage, live(done)?.evaluate, live(done)?.stopped], ['pr', undefined, undefined]);
  assert.deepEqual(resultOf(done, ID)?.evaluate, { verdict: 'passed', scores: scores(7, 9, 10), output: 'src/a.ts:3 no test' });
  assert.equal(done.workers.filter((w) => w.status !== 'empty').length, 0);
});

test('one score under the threshold fails: the failing dimensions first, then the findings, in the output; the cause names them; the task goes back by failed (#877)', () => {
  const { state } = ended(polled().state, [8, 3, 9]);
  const record = resultOf(state, ID)?.evaluate as { verdict: string; output: string };
  assert.equal(record.verdict, 'failed');
  assert.equal(record.output, 'Tests cover it? (3/7): evidence 2\nsrc/a.ts:3 no test');
  assert.equal(state.tasks[0].stage, 'build');
  const tries = live(state)?.tryLog ?? [];
  assert.deepEqual(tries.map((r) => [r.cause, r.error, r.n, r.max]), [['Tests cover it?', 'Tests cover it? (3/7): evidence 2', 1, 2]]);
});

test('failed with no failed transition stops the task in the stage with the rejected dimensions named (#877)', () => {
  const { state } = ended(polled([PASSED]).state, [2, 3, 9]);
  assert.deepEqual([state.tasks[0].stage, live(state)?.stopped, live(state)?.error], ['eval', true, 'evaluation rejected: Meets the spec?, Tests cover it?']);
  assert.deepEqual(reduce(state, { type: 'poll', source: 'board', items: [listed('Eval')] }).effects, [], 'out of the automation until a manual start');
});

test('a broken run stops the task with the reason, records no verdict and spends no try; a manual start runs the whole evaluation again (#877)', () => {
  const s = polled().state;
  const { state } = reduce(s, { type: 'evaluateBroken', ...ids(s), message: 'reviewer 2 (codex): no answer' });
  assert.deepEqual([live(state)?.evaluate, live(state)?.stopped, live(state)?.error, live(state)?.tries], [undefined, true, 'evaluation failed: reviewer 2 (codex): no answer', undefined]);
  assert.equal(resultOf(state, ID)?.evaluate, undefined);
  assert.equal(state.workers.filter((w) => w.status !== 'empty').length, 0);
  const again = reduce(state, { type: 'start', itemId: ID });
  assert.ok(evaluateOf(again.effects));
  assert.notEqual(live(again.state)?.evaluate?.runId, ids(s).runId);
  assert.equal(live(again.state)?.error, undefined);
});

test('a late answer for another run and every answer during a Quit are ignored (#877)', () => {
  const s = polled().state;
  assert.equal(reduce(s, { type: 'evaluateEnded', activityId: ids(s).activityId, runId: 'old', scores: scores(9, 9, 9), findings: [] }).state, s);
  const quitting = reduce(s, { type: 'quit' }).state;
  assert.equal(reduce(quitting, { type: 'evaluateBroken', ...ids(quitting), message: 'cancelled' }).state, quitting);
});

test('a Build ending into the evaluate stage hands it the freed worker under the continuation\'s gate (#727, #877)', () => {
  const INTO: Transition = { from: 'build', when: 'done', to: 'eval' };
  const building = reduce(base([INTO, PASSED, FAILED]), { type: 'poll', source: 'board', items: [listed('Build')] }).state;
  const ptyId = building.workers[0].runId ?? 'none';
  const done = reduce(building, { type: 'done', ptyId }).state;
  const { state, effects } = reduce(done, { type: 'hook', ptyId, payload: { hook_event_name: 'Stop' } });
  assert.ok(evaluateOf(effects));
  assert.equal(effects.some((e) => e.type === 'spawn'), false);
  assert.deepEqual([state.tasks[0].stage, state.workers[0].status, state.workers[0].runId, live(state)?.evaluate?.workerId], ['eval', 'working', undefined, state.workers[0].id]);
});

test('the reducer never writes to its input (#877)', () => {
  const s = deepFreeze(polled().state);
  assert.doesNotThrow(() => ended(s, [8, 3, 9]));
  assert.doesNotThrow(() => reduce(s, { type: 'evaluateJudging', ...ids(s) }));
  assert.doesNotThrow(() => reduce(s, { type: 'evaluateBroken', ...ids(s), message: 'x' }));
});

test('stopEvaluate, a delete and the task leaving abort the evaluation and free its worker, with no verdict (#877)', () => {
  const s = polled().state;
  const runId = ids(s).runId;
  const stop = reduce(s, { type: 'stopEvaluate', activityId: ids(s).activityId });
  assert.deepEqual([live(stop.state)?.evaluate, live(stop.state)?.stopped, resultOf(stop.state, ID)?.evaluate], [undefined, true, undefined]);
  assert.deepEqual(stop.effects.filter((e) => e.type === 'abortEvaluate'), [{ type: 'abortEvaluate', runId }]);
  assert.equal(stop.state.workers.filter((w) => w.status !== 'empty').length, 0);
  assert.equal(stop.state.tasks[0].stage, 'eval', 'the task stops in its stage');
  const withTree = withActivity(s, { ...(live(s) as Activity), worktree: '/wt/hive-1-task-1' }); // something to delete, or the route refuses it
  const deleting = reduce(withTree, { type: 'deletingActivity', activityId: ids(s).activityId });
  assert.ok(deleting.effects.some((e) => e.type === 'abortEvaluate'), 'closeTerminals halts it');
  assert.deepEqual([live(deleting.state)?.evaluate, live(deleting.state)?.stopped, live(deleting.state)?.deleting], [undefined, true, true]);
  const missing = reduce(s, { type: 'poll', source: 'board', items: [] }).state; // only a missing or leaving task closes
  assert.equal(missing.tasks[0].missing, true);
  const closed = reduce(missing, { type: 'closeTask', taskId: ID });
  assert.ok(closed.effects.some((e) => e.type === 'abortEvaluate'));
  assert.equal(closed.state.workers.filter((w) => w.status !== 'empty').length, 0);
  assert.equal(reduce(s, { type: 'stopEvaluate', activityId: 'other' }).state, s);
});

test('a boot during the stage drops the mark and leaves the activity stopped, its worker freed (#877)', () => {
  const s = polled().state;
  const booted = reduce(s, { type: 'boot' }).state;
  assert.deepEqual([live(booted)?.evaluate, live(booted)?.stopped], [undefined, true]);
  assert.equal(booted.workers.filter((w) => w.status !== 'empty').length, 0);
});

test('a save that removes the stage halts the evaluation at once and aborts it (#861, #877)', () => {
  const s = polled().state;
  const saved = reduce(s, { type: 'setStages', stages: [BUILD, PR], transitions: [] });
  assert.equal(live(saved.state)?.evaluate, undefined);
  assert.ok(saved.effects.some((e) => e.type === 'abortEvaluate'));
  assert.equal(saved.state.workers.filter((w) => w.status !== 'empty').length, 0);
});

test('evaluate.ended says passed, failed or broken with how long the stage took; a Stop writes none (#877)', () => {
  const s = polled().state;
  const facts = (event: HiveEvent) => deriveFacts(s, reduce(s, event).state, event, Date.now()).filter((r) => r.event === 'evaluate.ended');
  const end = (n: number[]): HiveEvent => ({ type: 'evaluateEnded', ...ids(s), scores: scores(...n), findings: [] });
  assert.deepEqual(facts(end([9, 9, 9])).map((r) => [r.verdict, r.level]), [['passed', 'info']]);
  assert.deepEqual(facts(end([9, 2, 9])).map((r) => [r.verdict, r.level]), [['failed', 'warn']]);
  assert.deepEqual(facts({ type: 'evaluateBroken', ...ids(s), message: 'x' }).map((r) => [r.verdict, r.level]), [['broken', 'warn']]);
  assert.deepEqual(facts({ type: 'stopEvaluate', activityId: ids(s).activityId }), []);
  assert.ok(Number(facts(end([9, 9, 9]))[0].duration_ms) >= 0);
});

test('hive.log names the evaluation by ids and numbers, never a finding\'s text (#877)', () => {
  const s = polled();
  const effect = evaluateOf(s.effects);
  assert.ok(effect);
  assert.match(describeEffect(effect), /^evaluate #1 stage="eval" run=\S+ reviewers=2$/);
  assert.match(describeEvent({ type: 'evaluateJudging', ...ids(s.state) }), /^evaluateJudging activity=\S+ run=\S+$/);
  const line = describeEvent({ type: 'evaluateEnded', ...ids(s.state), scores: scores(8, 3, 9), findings: [{ file: 'a.ts', finding: 'SECRET TEXT' }] });
  assert.match(line, /scores=8,3,9 findings=1$/);
  assert.equal(line.includes('SECRET TEXT'), false);
  assert.match(describeEvent({ type: 'evaluateBroken', ...ids(s.state), message: 'judge (claude): no answer\nmore' }), /: judge \(claude\): no answer$/);
});
