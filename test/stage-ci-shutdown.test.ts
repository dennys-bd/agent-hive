import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, resultOf } from '../src/activities.js';
import { initialState, reduce, type Reduced } from '../src/orchestrator.js';
import type { LegacyStage } from '../src/config-migrate.js';
import type { CiCheck, CiPrRead, Item, State } from '../src/types.js';
import { chained } from './fakes.js';

// #515: a wait for CI holds no worker, yet shutdown when done must wait for it; and a boot hours later must read the checks before the timeout.

const ID = 'board:item1';
const URL = 'https://github.com/o/r/pull/7';
const item: Item = { itemId: ID, id: '1', title: 'Task 1', body: '', url: 'https://github.com/o/r/issues/1', source: 'board' };
const CI: LegacyStage = { name: 'ci', from: { board: ['CI'] }, action: 'waitForCi', ciChecks: 'all', rerunOnce: false, timeout: '60m' };
const REVIEW: LegacyStage = { name: 'review', from: { board: ['Review'] } };
const polled = (extra: Partial<LegacyStage> = {}): State =>
  reduce({ ...initialState(1), signal: 'red', workspaces: ['hive'], syncs: { board: {} }, ...chained([{ ...CI, ...extra }, REVIEW]) }, { type: 'poll', source: 'board', items: [{ item, column: 'CI' }] }).state;
const check = (name: string, state: CiCheck['state']): CiCheck => ({ name, pr: URL, state });
const pr = (checks: CiCheck[]): CiPrRead => ({ url: URL, head: 'h1', checks });
const read = (s: State, prs: CiPrRead[], at = new Date().toISOString()): Reduced =>
  reduce(s, { type: 'ciRead', activityId: activityOf(s, ID)?.id ?? 'none', at, prs });
const lateOf = (s: State): string => new Date(Date.parse(activityOf(s, ID)?.ci?.since ?? '') + 141 * 60_000).toISOString(); // the 2 h 21 min of #515

test('shutdown when done stays armed while a task waits for CI with no worker, and fires once the wait ends (#515)', () => {
  const armed = reduce(polled(), { type: 'setShutdown', armed: true });
  assert.ok(armed.state.shutdown, 'the wait holds the shutdown');
  assert.equal(armed.effects.some((e) => e.type === 'shutdown'), false);
  const passed = read(armed.state, [pr([check('build', 'success')])]);
  assert.deepEqual([passed.state.tasks[0].stage, passed.state.shutdown], ['review', undefined]);
  assert.ok(passed.effects.some((e) => e.type === 'shutdown'));
});

test('a read past the timeout decides on its checks first: all green passes, a failure fetches the logs, still pending times out (#515)', () => {
  const s = polled();
  const green = read(s, [pr([check('build', 'success')])], lateOf(s)).state;
  assert.deepEqual([green.tasks[0].stage, resultOf(green, ID)?.ci], ['review', { verdict: 'passed' }]);
  const failed = read(s, [pr([check('build', 'failure')])], lateOf(s));
  assert.deepEqual([failed.effects.some((e) => e.type === 'ciCollect'), activityOf(failed.state, ID)?.ci?.collecting], [true, true]);
  const pending = read(s, [pr([check('build', 'pending')])], lateOf(s)).state;
  assert.equal(activityOf(pending, ID)?.error, 'CI failed: timed out after 60m');
});

test('past the timeout a failure under rerunOnce is not re-run: its logs are fetched, whether the login may re-run or not (#515)', () => {
  const s = polled({ rerunOnce: true });
  for (const canPush of [true, false]) {
    const failure = { ...pr([{ ...check('build', 'failure'), runId: 11 }]), canPush };
    const late = read(s, [failure], lateOf(s));
    assert.deepEqual(late.effects.map((e) => e.type).filter((t) => t.startsWith('ci')), ['ciCollect'], String(canPush));
  }
  assert.equal(activityOf(read(s, [{ ...pr([{ ...check('build', 'failure'), runId: 11 }]), canPush: false }]).state, ID)?.ci?.noRerun, true, 'before the timeout it holds');
});
