import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFacts } from '../src/fact-derive.js';
import { describeEvent } from '../src/log.js';
import { reduce, type Reduced } from '../src/orchestrator.js';
import type { State } from '../src/types.js';
import { check, deepFreeze, effectOf, live, outputOf, polled, pr, read } from './fixtures/stage-ci.js';

// #598: each check on its own clock. timeout bounds a running check from its own start; queueTimeout a queued one from its suite's creation,
// and a missing required check, a workflow awaiting approval and no open PR from the wait's start.

const plus = (s: State, minutes: number): string => new Date(Date.parse(live(s)?.ci?.since ?? '') + minutes * 60_000).toISOString();
const errorOf = (s: State): string | undefined => live(s)?.error;

test('a check queued longer than timeout, then started, does not time out: its clock starts when it runs (#598)', () => {
  const s = polled({ timeout: '30m' }).state;
  const queued = read(s, [pr([check('build', 'pending', { queuedAt: plus(s, 0) })])], plus(s, 50)).state;
  assert.equal(live(queued)?.stopped, undefined, 'no queueTimeout: a queue never ends');
  const started = read(queued, [pr([check('build', 'pending', { startedAt: plus(s, 50) })])], plus(s, 70)).state;
  assert.deepEqual([live(started)?.stopped, live(started)?.ci?.total], [undefined, 1]);
});

test('a check running longer than timeout fails the wait, named with its limit; one queued as long is not named (#598)', () => {
  const s = polled({ timeout: '30m' }).state;
  const { state } = read(s, [pr([check('test', 'pending', { startedAt: plus(s, 0) }), check('e2e', 'pending', { queuedAt: plus(s, 0) })])], plus(s, 31));
  assert.deepEqual([live(state)?.ci, live(state)?.stopped, errorOf(state)], [undefined, true, 'CI failed: test (ran over 30m)']);
  assert.equal(outputOf(state), 'CI timed out · test (ran over 30m)');
  assert.equal(live(read(s, [pr([check('test', 'pending', { startedAt: plus(s, 5) })])], plus(s, 31)).state)?.stopped, undefined, 'its own start, not the wait\'s');
  const forged = read(s, [pr([check('x\n## fake', 'pending', { startedAt: plus(s, 0) })])], plus(s, 31)).state;
  assert.equal(outputOf(forged), 'CI timed out · x ## fake (ran over 30m)');
});

test('a check queued longer than queueTimeout, from its suite\'s creation, fails the wait; with no queueTimeout it never does (#598)', () => {
  const s = polled({ timeout: '30m', queueTimeout: '2h' }).state;
  const queued = (at: string): State => read(s, [pr([check('e2e', 'pending', { queuedAt: plus(s, 10) })])], at).state;
  assert.equal(live(queued(plus(s, 125)))?.stopped, undefined, '115 min from the suite');
  const ended = queued(plus(s, 131));
  assert.deepEqual([errorOf(ended), outputOf(ended)], ['CI failed: e2e (queued over 2h)', 'CI timed out · e2e (queued over 2h)']);
  const unlimited = polled({ timeout: '30m' }).state;
  assert.equal(live(read(unlimited, [pr([check('e2e', 'pending', { queuedAt: plus(unlimited, 0) })])], plus(unlimited, 48 * 60)).state)?.stopped, undefined);
});

test('a required check no run reports yet counts its queue from the wait\'s start (#598)', () => {
  const s = polled({ ciChecks: 'required', queueTimeout: '1h' }).state;
  const required = (at: string): State => read(s, [{ ...pr([check('build', 'success')]), required: ['build', 'deploy'] }], at).state;
  assert.equal(live(required(plus(s, 59)))?.stopped, undefined);
  assert.equal(errorOf(required(plus(s, 61))), 'CI failed: deploy (queued over 1h)');
});

test('a workflow awaiting approval and no open PR end on queueTimeout from the wait\'s start, never on timeout (#598)', () => {
  const s = polled({ timeout: '10m', queueTimeout: '1h' }).state;
  const awaiting = (at: string): State => read(s, [{ ...pr([]), awaiting: ['CI'] }], at).state;
  assert.equal(live(awaiting(plus(s, 30)))?.stopped, undefined, 'past timeout, inside queueTimeout');
  const ended = awaiting(plus(s, 61));
  assert.deepEqual([errorOf(ended), outputOf(ended)], ['CI failed: CI (awaiting approval) (queued over 1h)', 'CI timed out · CI (awaiting approval) (queued over 1h)']);
  assert.equal(live(read(s, [], plus(s, 30)).state)?.ci?.waitingPr, true);
  assert.equal(errorOf(read(s, [], plus(s, 61)).state), 'CI failed: no open PR (queued over 1h)');
  const unlimited = polled({ timeout: '10m' }).state;
  assert.equal(live(read(unlimited, [], plus(unlimited, 48 * 60)).state)?.ci?.waitingPr, true, 'no queueTimeout, no end');
});

test('after a push the new checks bring their own start: the wait stays open where the old start would have timed it out (#598)', () => {
  const s = polled({ timeout: '30m' }).state;
  const first = read(s, [pr([check('build', 'pending', { startedAt: plus(s, 0) })])], plus(s, 20)).state;
  const pushed = read(first, [pr([check('build', 'pending', { startedAt: plus(s, 25) })], 'h2')], plus(s, 45)).state;
  assert.deepEqual([live(pushed)?.stopped, live(pushed)?.ci?.checks?.[0]?.startedAt], [undefined, plus(s, 25)]);
});

test('a failure long after the wait\'s start still re-runs once under rerunOnce: the re-run\'s checks get fresh clocks (#598)', () => {
  const s = polled({ rerunOnce: true, timeout: '30m' }).state;
  const late = read(s, [pr([check('build', 'failure', { runId: 11, startedAt: plus(s, 100), at: plus(s, 110) })])], plus(s, 120));
  assert.deepEqual(effectOf(late.effects, 'ciRerun')?.runs, [{ repo: 'o/r', runId: 11 }]);
  assert.equal(effectOf(late.effects, 'ciCollect'), undefined);
});

test('a failure read as pending after its re-run is queued, not running from its old start, and its queue counts from the re-run (#598)', () => {
  const s = polled({ rerunOnce: true, timeout: '30m', queueTimeout: '10m' }).state;
  const old = check('build', 'failure', { runId: 11, startedAt: plus(s, 0), at: plus(s, 59) });
  const reran = read(s, [pr([old])], plus(s, 60)).state;
  const stale = read(reran, [pr([old])], plus(s, 62)).state;
  assert.deepEqual([live(stale)?.stopped, live(stale)?.ci?.checks], [undefined, [{ name: 'build', state: 'pending' }]]);
});

test('ciClock judges the last read\'s checks; with no checks yet it fails only a no-PR wait past queueTimeout (#598)', () => {
  const s = polled({ timeout: '30m', queueTimeout: '1h' }).state;
  const clock = (state: State, minutes: number): Reduced => reduce(state, { type: 'ciClock', activityId: live(state)?.id ?? 'none', at: plus(s, minutes) });
  const running = read(s, [pr([check('test', 'pending', { startedAt: plus(s, 0) })])], plus(s, 1)).state;
  assert.equal(clock(running, 29).state, running);
  const ended = clock(running, 31);
  assert.deepEqual([ended.effects, errorOf(ended.state), outputOf(ended.state)], [[], 'CI failed: test (ran over 30m)', 'CI timed out · test (ran over 30m)']);
  assert.equal(clock(s, 48 * 60).state, s, 'no read yet and no PR known: nothing to judge');
  assert.equal(errorOf(clock(read(s, [], plus(s, 1)).state, 61).state), 'CI failed: no open PR (queued over 1h)');
  const ticked = { type: 'ciClock', activityId: live(running)?.id ?? '', at: plus(s, 31) } as const;
  assert.ok(deriveFacts(running, reduce(running, ticked).state, ticked, Date.now()).some((r) => r.event === 'ci.ended' && r.verdict === 'failed'));
  assert.equal(describeEvent({ type: 'ciClock', activityId: 'abcdef123456', at: 'x' }), 'ciClock activity=abcdef12');
  reduce(deepFreeze(running), ticked);
});

test('an open PR that reports no check yet ends on queueTimeout from the wait\'s start, as no checks; ciClock judges it from the last read (#598)', () => {
  const s = polled({ timeout: '10m', queueTimeout: '1h' }).state;
  const empty = (at: string): State => read(s, [pr([])], at).state;
  assert.equal(live(empty(plus(s, 59)))?.stopped, undefined);
  assert.deepEqual([errorOf(empty(plus(s, 61))), outputOf(empty(plus(s, 61)))], ['CI failed: no checks (queued over 1h)', 'CI timed out · no checks (queued over 1h)']);
  const seen = empty(plus(s, 1));
  const ticked = reduce(seen, { type: 'ciClock', activityId: live(seen)?.id ?? 'none', at: plus(s, 61) }).state;
  assert.equal(errorOf(ticked), 'CI failed: no checks (queued over 1h)');
});
