import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exitName, exitOf, FEEDBACK_TEMPLATE, isAutomatic, needsHandover, outgoing, resolveSession, takeTry, transitionByKey, transitionKey, transitionPrompt, verdictsOf, verdictText,
} from '../src/transitions.js';
import type { ActivityRecord, Stage, Task, Transition } from '../src/types.js';

// The flow as a graph (#134): which transition a stage end fires, the session and the prompt it hands on, the tries it counts. Pure.

const STAGES: Stage[] = [
  { name: 'Spec', from: {}, prompt: '/spec {url}', approval: true, verdicts: ['needs design', 'ready'] },
  { name: 'Build', from: {}, prompt: '/build' },
  { name: 'Checks', from: {}, action: 'commands', commands: ['lint'], stopOnFailure: true, onMissing: 'fail' },
  { name: 'Review', from: {}, prompt: '/review', verdicts: ['ok', 'redo'] },
  { name: 'PR', from: {}, approval: true },
];
const T = (from: string, to: string, when: Transition['when'], extra: Partial<Transition> = {}): Transition => ({ from, to, when, ...extra });
const FLOW: Transition[] = [
  T('Spec', 'Build', 'approved'), T('Spec', 'Spec', 'feedback', { session: 'previous' }), T('Spec', 'Build', 'verdict', { verdict: 'ready' }),
  T('Build', 'Checks', 'done'),
  T('Checks', 'Review', 'verdict', { verdict: 'passed' }), T('Checks', 'Build', 'verdict', { verdict: 'failed', maxTries: 3 }),
  T('Review', 'PR', 'done'), T('Review', 'Build', 'verdict', { verdict: 'redo' }),
  T('PR', 'end', 'approved'),
];
const graph = { stages: STAGES, transitions: FLOW };
const task: Task = { item: { itemId: 'board:1', id: '1', title: 't', body: '', url: '' }, stage: 'Build', boardColumn: '', auto: true };
const AT = '2026-10-09T00:00:00.000Z';
const records = (sessions: { id: string; stages: string[] }[]): { activityRecords: ActivityRecord[] } =>
  ({ activityRecords: [{ id: 'a', taskIds: ['board:1'], sessions: sessions.map((s) => ({ ...s, startedAt: AT, lastUsedAt: AT })) }] });

test('transitionKey is the (from, when, verdict) triple as JSON, so free-text names never collide; transitionByKey finds it back (#134)', () => {
  assert.equal(transitionKey(T('a', 'b', 'done')), '["a","done",null]');
  assert.notEqual(transitionKey(T('a","done', 'x', 'done')), transitionKey(T('a', 'x', 'done')));
  assert.equal(transitionKey(FLOW[5]), '["Checks","verdict","failed"]');
  assert.equal(transitionByKey(FLOW, '["Checks","verdict","failed"]'), FLOW[5]);
  assert.equal(transitionByKey(FLOW, undefined), undefined);
  assert.deepEqual(outgoing(FLOW, 'Checks'), [FLOW[4], FLOW[5]]);
  assert.deepEqual([isAutomatic('done'), isAutomatic('verdict'), isAutomatic('approved'), isAutomatic('feedback')], [true, true, false, false]);
});

test('exitOf matches the trigger and the verdict; an agent verdict with no transition of its own falls back to done; a commands verdict never does; an approval stage never falls back (#134)', () => {
  assert.equal(exitOf(graph, 'Build', 'done'), FLOW[3]);
  assert.equal(exitOf(graph, 'Spec', 'approved'), FLOW[0]);
  assert.equal(exitOf(graph, 'Spec', 'feedback'), FLOW[1]);
  assert.equal(exitOf(graph, 'Checks', 'verdict', 'failed'), FLOW[5]);
  assert.equal(exitOf(graph, 'Review', 'verdict', 'redo'), FLOW[7]);
  assert.equal(exitOf(graph, 'Review', 'verdict', 'ok'), FLOW[6], 'no ok transition: done');
  assert.equal(exitOf(graph, 'Spec', 'verdict', 'needs design'), undefined, 'an approval stage waits for the user instead');
  assert.equal(exitOf({ stages: STAGES, transitions: FLOW.filter((t) => t !== FLOW[5]) }, 'Checks', 'verdict', 'failed'), undefined, 'a failed check never passes as finished');
  assert.equal(exitOf(graph, 'Build', 'approved'), undefined);
  assert.equal(exitOf(graph, 'Gone', 'done'), undefined);
  assert.deepEqual([exitName('approved'), exitName('verdict', 'failed')], ['approved', 'verdict:failed']);
});

test('verdictsOf: a prompt stage its own, commands and wait for CI passed and failed, a gate and a delete-activity stage none (#134)', () => {
  assert.deepEqual(STAGES.map((s) => [...verdictsOf(s)]), [['needs design', 'ready'], [], ['passed', 'failed'], ['ok', 'redo'], []]);
  assert.deepEqual([...verdictsOf({ action: 'waitForCi' })], ['passed', 'failed']);
  assert.deepEqual([...verdictsOf({ action: 'deleteActivity' })], []);
});

test('resolveSession: previous is the run that just ended, continueOf the task\'s last session in that stage, new a new one; absent follows the destination; nothing to resume is new (#134)', () => {
  const state = records([{ id: 's-build-1', stages: ['Build'] }, { id: 's-spec', stages: ['Spec'] }, { id: 's-build-2', stages: ['Checks', 'Build'] }]);
  const live = { sessionId: 's-spec' };
  const build = STAGES[1];
  assert.deepEqual(resolveSession(state, task, live, { session: 'previous' }, build), { policy: 'continue', sessionId: 's-spec' });
  assert.deepEqual(resolveSession(state, task, live, { session: { continueOf: 'Build' } }, build), { policy: 'continue', sessionId: 's-build-2' });
  assert.deepEqual(resolveSession(state, task, live, { session: { continueOf: 'Review' } }, build), { policy: 'new' }, 'never ran there');
  assert.deepEqual(resolveSession(state, task, live, { session: 'new' }, { ...build, session: 'continue' }), { policy: 'new' });
  assert.deepEqual(resolveSession(state, task, live, {}, { ...build, session: 'continue' }), { policy: 'continue', sessionId: 's-spec' });
  assert.deepEqual(resolveSession(state, task, live, {}, build), { policy: 'new' });
  assert.deepEqual(resolveSession(state, task, undefined, { session: 'previous' }, build), { policy: 'new' });
});

test('transitionPrompt: a new session reads the transition, a blank line, the stage; a continued one the transition alone, or the stage when it is empty; an empty feedback prompt is the feedback behind its lead (#134)', () => {
  const build = { prompt: '/build {url}' };
  assert.equal(transitionPrompt({ when: 'verdict', prompt: 'Fix:\n\n{verdict}' }, build, 'new'), 'Fix:\n\n{verdict}\n\n/build {url}');
  assert.equal(transitionPrompt({ when: 'verdict', prompt: 'Fix:\n\n{verdict}' }, build, 'continue'), 'Fix:\n\n{verdict}');
  assert.equal(transitionPrompt({ when: 'done' }, build, 'continue'), '/build {url}');
  assert.equal(transitionPrompt({ when: 'done', prompt: '  ' }, build, 'new'), '/build {url}');
  assert.equal(FEEDBACK_TEMPLATE, 'The user reviewed this stage and asks:\n\n{feedback}');
  assert.equal(transitionPrompt({ when: 'feedback' }, build, 'continue'), FEEDBACK_TEMPLATE);
  assert.equal(transitionPrompt({ when: 'feedback' }, build, 'new'), `${FEEDBACK_TEMPLATE}\n\n/build {url}`);
  assert.equal(transitionPrompt({ when: 'approved' }, {}, 'new'), '');
  assert.deepEqual(
    [needsHandover({ when: 'done' }), needsHandover({ when: 'done', prompt: 'x' }), needsHandover({ when: 'feedback' }), needsHandover({ when: 'approved', session: 'new' })],
    [false, true, true, true],
  );
});

test('takeTry counts an automatic transition with maxTries per task and per transition, and says exhausted once they ran out; no limit or a user\'s transition counts nothing (#134)', () => {
  const failed = FLOW[5];
  const key = transitionKey(failed);
  assert.deepEqual(takeTry(undefined, failed), { [key]: 1 });
  assert.deepEqual(takeTry({ tries: { [key]: 2, other: 5 } }, failed), { [key]: 3, other: 5 });
  assert.equal(takeTry({ tries: { [key]: 3 } }, failed), undefined);
  assert.deepEqual(takeTry({ tries: { other: 1 } }, FLOW[3]), { other: 1 }, 'no limit');
  assert.deepEqual(takeTry({ tries: { other: 1 } }, FLOW[0]), { other: 1 }, 'a user transition never counts');
});

test('verdictText: a commands or wait-for-CI verdict\'s output, an agent verdict\'s evidence, empty otherwise (#134)', () => {
  const result = { commands: { verdict: 'failed', output: 'lint (1)\nboom' }, ci: { verdict: 'failed', output: 'build failed' }, verdict: { name: 'redo', evidence: 'src/a.ts:3' } };
  assert.equal(verdictText(STAGES[2], result), 'lint (1)\nboom');
  assert.equal(verdictText({ action: 'waitForCi' }, result), 'build failed');
  assert.equal(verdictText(STAGES[3], result), 'src/a.ts:3');
  assert.equal(verdictText(STAGES[3], {}), '');
  assert.equal(verdictText(undefined, undefined), '');
});
