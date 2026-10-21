import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkReduce, isBenchmarkEvent } from '../../src/benchmark-reducer.js';
import { describeEvent } from '../../src/log.js';
import { initialState, reduce } from '../../src/orchestrator.js';
import type { BenchmarkEvent, Experiment, ExperimentPatch, State } from '../../src/types.js';
import { arm, deepFreeze, experiment, ISOLATION, run, stateWith } from './fixtures.js';

const AT = '2026-10-21T12:00:00.000Z';
const LATER = '2026-10-22T07:00:00.000Z';
const TASK = { key: 'T9', title: 'Nine', body: '', blockedBy: [] };

// Every event runs on a deep-frozen state, so a write throws; the answer must be a new state that leaves the input as it was
function apply(state: State, event: BenchmarkEvent): State {
  const before = JSON.stringify(state);
  const next = benchmarkReduce(deepFreeze(state), event);
  assert.notEqual(next, state, `${event.type}: a new state`);
  assert.equal(JSON.stringify(state), before, `${event.type}: the input untouched`);
  return next;
}
const first = (state: State): Experiment => state.benchmark.experiments[0];

test('benchmarkCreated appends the experiment the route built; an id already held is ignored (#458)', () => {
  const next = apply(stateWith(experiment({ id: 'old' })), { type: 'benchmarkCreated', experiment: experiment() });
  assert.deepEqual(next.benchmark.experiments.map((e) => e.id), ['old', 'exp-1']);
  const held = deepFreeze(stateWith(experiment()));
  assert.equal(benchmarkReduce(held, { type: 'benchmarkCreated', experiment: experiment({ name: 'again' }) }), held);
});

test('benchmarkEdited spreads its patch and never touches status, rounds or arms (#458)', () => {
  const start = stateWith(experiment({ status: 'done', rounds: [{ n: 1, runs: [] }] }));
  // a route's slip tsc would refuse: the reducer still keeps what only the run's own events may set
  const patch = { name: 'Renamed', pace: { ...experiment().pace, pairs: 5 }, status: 'draft', rounds: [], arms: [] } as unknown as ExperimentPatch;
  const edited = first(apply(start, { type: 'benchmarkEdited', id: 'exp-1', patch }));
  assert.deepEqual([edited.name, edited.pace.pairs, edited.status, edited.rounds.length, edited.arms.length], ['Renamed', 5, 'done', 1, 2]);
});

test('benchmarkForked appends the fork and leaves its source as it was; an unknown source or a held id is ignored (#458)', () => {
  const source = experiment({ rounds: [{ n: 1, runs: [run('aaaa1')] }] });
  const next = apply(stateWith(source), { type: 'benchmarkForked', from: 'exp-1', experiment: experiment({ id: 'exp-2', name: 'Skills · 2' }) });
  assert.deepEqual(next.benchmark.experiments.map((e) => e.id), ['exp-1', 'exp-2']);
  assert.equal(first(next), source);
  const frozen = deepFreeze(stateWith(source));
  assert.equal(benchmarkReduce(frozen, { type: 'benchmarkForked', from: 'nope', experiment: experiment({ id: 'exp-2' }) }), frozen);
  assert.equal(benchmarkReduce(frozen, { type: 'benchmarkForked', from: 'exp-1', experiment: experiment() }), frozen);
});

test('benchmarkArchived sets archived, and false removes the key (#458)', () => {
  const archived = first(apply(stateWith(experiment()), { type: 'benchmarkArchived', id: 'exp-1', archived: true }));
  assert.equal(archived.archived, true);
  assert.equal('archived' in first(apply(stateWith(archived), { type: 'benchmarkArchived', id: 'exp-1', archived: false })), false);
});

test('benchmarkDeleted removes the experiment (#458)', () => {
  const next = apply(stateWith(experiment(), experiment({ id: 'exp-2' })), { type: 'benchmarkDeleted', id: 'exp-1' });
  assert.deepEqual(next.benchmark.experiments.map((e) => e.id), ['exp-2']);
});

test('benchmarkArmAdded appends an arm, an id already held ignored; benchmarkArmEdited spreads its patch over the arm (#458)', () => {
  assert.deepEqual(first(apply(stateWith(experiment()), { type: 'benchmarkArmAdded', id: 'exp-1', arm: arm('a3', 'C') })).arms.map((a) => a.letter), ['A', 'B', 'C']);
  const held = deepFreeze(stateWith(experiment()));
  assert.equal(benchmarkReduce(held, { type: 'benchmarkArmAdded', id: 'exp-1', arm: arm('a1', 'Z') }), held);
  const edited = first(apply(stateWith(experiment()), { type: 'benchmarkArmEdited', id: 'exp-1', armId: 'a2', patch: { name: 'skills off', overrides: { plugins: ['x'] } } }));
  assert.deepEqual(edited.arms[1], { id: 'a2', letter: 'B', name: 'skills off', overrides: { plugins: ['x'] } });
});

test('benchmarkArmRemoved removes the arm and its key from every isolation row (#458)', () => {
  const isolation = { ...ISOLATION, network: { all: [], perArm: { a1: ['x.test'], a2: ['y.test'] } }, env: { all: {}, perArm: { a2: { CI: '0' } } } };
  const removed = first(apply(stateWith(experiment({ isolation })), { type: 'benchmarkArmRemoved', id: 'exp-1', armId: 'a2' }));
  assert.deepEqual(removed.arms.map((a) => a.id), ['a1']);
  assert.deepEqual([removed.isolation.network.perArm, removed.isolation.env.perArm], [{ a1: ['x.test'] }, {}]);
  assert.equal(removed.isolation.limits, ISOLATION.limits, 'a row with no per-arm value is the same row');
});

test("benchmarkArmsCopied overrides: each target gets the source's overrides minus tasks and keeps its own tasks; unknown targets are skipped (#458)", () => {
  const arms = [arm('a1', 'A', { plugins: ['p'], tasks: [TASK] }), arm('a2', 'B', { rules: { allow: ['x'], deny: [] } }), arm('a3', 'C', { tasks: [] })];
  const copied = first(apply(stateWith(experiment({ arms })), { type: 'benchmarkArmsCopied', id: 'exp-1', from: 'a1', what: 'overrides', to: ['a2', 'a3', 'nope'] }));
  assert.deepEqual(copied.arms.map((a) => a.overrides), [{ plugins: ['p'], tasks: [TASK] }, { plugins: ['p'] }, { plugins: ['p'], tasks: [] }]);
});

test("benchmarkArmsCopied tasks: each target's tasks become the source's, removed when the source has none (#458)", () => {
  const arms = [arm('a1', 'A', { tasks: [TASK] }), arm('a2', 'B', { plugins: ['p'] }), arm('a3', 'C', { plugins: ['q'], tasks: [] })];
  const withTasks = first(apply(stateWith(experiment({ arms })), { type: 'benchmarkArmsCopied', id: 'exp-1', from: 'a1', what: 'tasks', to: ['a2'] }));
  assert.deepEqual(withTasks.arms[1].overrides, { plugins: ['p'], tasks: [TASK] });
  const without = first(apply(stateWith(experiment({ arms })), { type: 'benchmarkArmsCopied', id: 'exp-1', from: 'a2', what: 'tasks', to: ['a3'] }));
  assert.deepEqual(without.arms[2].overrides, { plugins: ['q'] });
});

test("benchmarkRunStarted opens the run's round stamped with its start and sets the experiment running; a repeated token replaces the run (#458)", () => {
  const started = first(apply(stateWith(experiment()), { type: 'benchmarkRunStarted', id: 'exp-1', run: run('aaaa1', { startedAt: AT }) }));
  assert.equal(started.status, 'running');
  assert.deepEqual(started.rounds.map((r) => [r.n, r.startedAt, r.runs.map((x) => x.token)]), [[1, AT, ['aaaa1']]]);
  const second = first(apply(stateWith(started), { type: 'benchmarkRunStarted', id: 'exp-1', run: run('bbbb1', { armId: 'a2' }) }));
  assert.deepEqual(second.rounds[0].runs.map((x) => x.token), ['aaaa1', 'bbbb1']);
  const again = first(apply(stateWith(second), { type: 'benchmarkRunStarted', id: 'exp-1', run: run('aaaa1', { branch: 'neutral/again' }) }));
  assert.deepEqual(again.rounds[0].runs.map((x) => [x.token, x.branch]), [['aaaa1', 'neutral/again'], ['bbbb1', 'neutral/bbbb1']]);
});

test('benchmarkRunChanged spreads its patch over the run; benchmarkRunEnded sets status, endedAt and the reason when given (#458)', () => {
  const start = stateWith(experiment({ status: 'running', rounds: [{ n: 1, runs: [run('aaaa1'), run('bbbb1')] }] }));
  const changed = first(apply(start, { type: 'benchmarkRunChanged', id: 'exp-1', token: 'bbbb1', patch: { status: 'waiting', delivered: 1 } }));
  assert.deepEqual(changed.rounds[0].runs.map((r) => [r.status, r.delivered]), [['running', 0], ['waiting', 1]]);
  const timedOut = first(apply(start, { type: 'benchmarkRunEnded', id: 'exp-1', token: 'aaaa1', status: 'timeout', at: AT, reason: 'run timeout' })).rounds[0].runs[0];
  assert.deepEqual([timedOut.status, timedOut.endedAt, timedOut.reason], ['timeout', AT, 'run timeout']);
  const plain = first(apply(start, { type: 'benchmarkRunEnded', id: 'exp-1', token: 'aaaa1', status: 'done', at: AT })).rounds[0].runs[0];
  assert.equal('reason' in plain, false);
});

test('benchmarkRoundEnded and benchmarkRoundEvaluated stamp the round (#458)', () => {
  const start = stateWith(experiment({ rounds: [{ n: 1, runs: [] }, { n: 2, runs: [] }] }));
  const ended = first(apply(start, { type: 'benchmarkRoundEnded', id: 'exp-1', round: 2, at: AT }));
  const evaluated = first(apply(stateWith(ended), { type: 'benchmarkRoundEvaluated', id: 'exp-1', round: 2, at: LATER }));
  assert.deepEqual(evaluated.rounds, [{ n: 1, runs: [] }, { n: 2, endedAt: AT, evaluatedAt: LATER, runs: [] }]);
});

test('benchmarkSlept records the sleep and sleeps every running or waiting run; benchmarkWoken closes the last open sleep and wakes the sleeping runs as running (#458)', () => {
  const runs = [run('aaaa1'), run('bbbb1', { status: 'waiting' }), run('cccc1', { status: 'done' })];
  const start = stateWith(experiment({ status: 'running', rounds: [{ n: 1, runs }], sleeps: [{ round: 0, at: AT, wokeAt: AT, reason: 'old' }] }));
  const asleep = first(apply(start, { type: 'benchmarkSlept', id: 'exp-1', sleep: { round: 1, at: AT, reason: 'night' } }));
  assert.equal(asleep.status, 'sleeping');
  assert.deepEqual(asleep.rounds[0].runs.map((r) => r.status), ['sleeping', 'sleeping', 'done']);
  const awake = first(apply(stateWith(asleep), { type: 'benchmarkWoken', id: 'exp-1', at: LATER }));
  assert.equal(awake.status, 'running');
  assert.deepEqual(awake.rounds[0].runs.map((r) => r.status), ['running', 'running', 'done']);
  assert.deepEqual(awake.sleeps.map((s) => s.wokeAt), [AT, LATER]);
});

test('benchmarkStopAfterRound sets or removes the flag; benchmarkFinished sets done and removes it (#458)', () => {
  const on = first(apply(stateWith(experiment({ status: 'running' })), { type: 'benchmarkStopAfterRound', id: 'exp-1', on: true }));
  assert.equal(on.stopAfterRound, true);
  assert.equal('stopAfterRound' in first(apply(stateWith(on), { type: 'benchmarkStopAfterRound', id: 'exp-1', on: false })), false);
  const finished = first(apply(stateWith(on), { type: 'benchmarkFinished', id: 'exp-1' }));
  assert.deepEqual([finished.status, 'stopAfterRound' in finished], ['done', false]);
});

test('an event naming an unknown experiment, arm, token or round returns the state itself (#458)', () => {
  const start = deepFreeze(stateWith(experiment({ rounds: [{ n: 1, runs: [run('aaaa1')] }] })));
  const unknown: BenchmarkEvent[] = [
    { type: 'benchmarkEdited', id: 'nope', patch: { name: 'x' } },
    { type: 'benchmarkArchived', id: 'nope', archived: true },
    { type: 'benchmarkDeleted', id: 'nope' },
    { type: 'benchmarkArmAdded', id: 'nope', arm: arm('a9', 'Z') },
    { type: 'benchmarkArmEdited', id: 'exp-1', armId: 'nope', patch: { name: 'x' } },
    { type: 'benchmarkArmRemoved', id: 'exp-1', armId: 'nope' },
    { type: 'benchmarkArmsCopied', id: 'exp-1', from: 'nope', what: 'tasks', to: ['a1'] },
    { type: 'benchmarkArmsCopied', id: 'exp-1', from: 'a1', what: 'tasks', to: ['nope'] },
    { type: 'benchmarkRunStarted', id: 'nope', run: run('bbbb1') },
    { type: 'benchmarkRunChanged', id: 'exp-1', token: 'nope', patch: { delivered: 1 } },
    { type: 'benchmarkRunEnded', id: 'exp-1', token: 'nope', status: 'done', at: AT },
    { type: 'benchmarkRoundEnded', id: 'exp-1', round: 9, at: AT },
    { type: 'benchmarkRoundEvaluated', id: 'exp-1', round: 9, at: AT },
    { type: 'benchmarkSlept', id: 'nope', sleep: { round: 1, at: AT, reason: 'x' } },
    { type: 'benchmarkWoken', id: 'nope', at: AT },
    { type: 'benchmarkStopAfterRound', id: 'nope', on: true },
    { type: 'benchmarkFinished', id: 'nope' },
  ];
  for (const event of unknown) assert.equal(benchmarkReduce(start, event), start, JSON.stringify(event));
});

test('reduce delegates a benchmark event to benchmarkReduce with no effect; isBenchmarkEvent tells them from the others (#458)', () => {
  const { state, effects } = reduce(initialState(0), { type: 'benchmarkCreated', experiment: experiment() });
  assert.deepEqual([state.benchmark.experiments.map((e) => e.id), effects], [['exp-1'], []]);
  assert.equal(isBenchmarkEvent({ type: 'benchmarkFinished', id: 'exp-1' }), true);
  assert.equal(isBenchmarkEvent({ type: 'boot' }), false);
});

test("a benchmark event's log line names the experiment and the run's token only, never a name, a patch or a reason (#458)", () => {
  assert.equal(describeEvent({ type: 'benchmarkCreated', experiment: experiment({ name: 'secret name' }) }), 'benchmarkCreated experiment=exp-1');
  assert.equal(describeEvent({ type: 'benchmarkRunEnded', id: 'exp-1', token: 'aaaa1', status: 'error', at: AT, reason: 'secret' }), 'benchmarkRunEnded experiment=exp-1 token=aaaa1');
  assert.equal(describeEvent({ type: 'benchmarkRunStarted', id: 'exp-1', run: run('bbbb1') }), 'benchmarkRunStarted experiment=exp-1 token=bbbb1');
  assert.equal(describeEvent({ type: 'benchmarkEdited', id: 'exp-1', patch: { name: 'secret' } }), 'benchmarkEdited experiment=exp-1');
});
