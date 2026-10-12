import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf, localActivityId, pruneRecords, pruneWork, prsOf, recordOf, recordsOf, resultOf, usageOf } from '../src/activities.js';
import { initialState } from '../src/orchestrator.js';
import type { Activity, Item, State, Task } from '../src/types.js';
import { activityIdOf, withKeptRecord, withLocal, withWork } from './fixtures/work.js';

const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: '', source: 'board' });
const task = (n: number): Task => ({ item: item(n), stage: 'dev', boardColumn: 'Ready', auto: true });
const base = (tasks: Task[]): State => ({ ...initialState(0), workspaces: ['hive'], tasks });
const ID = 'board:item1';

test('activityOf answers the live activity whose record lists the task, and nothing once only a kept record does (#629)', () => {
  const live = withWork(base([task(1)]), ID, { worktree: '/w/1' });
  assert.equal(activityOf(live, ID)?.worktree, '/w/1');
  assert.deepEqual(recordOf(live, activityIdOf(ID))?.taskIds, [ID]);
  const kept = withKeptRecord(base([task(1)]), ID, 'old');
  assert.equal(activityOf(kept, ID), undefined);
  assert.deepEqual(recordsOf(kept, ID).map((r) => r.id), ['old']);
});

test('resultOf merges every record of the task oldest first, a newer key winning (#629)', () => {
  const state = withWork(withKeptRecord(base([task(1)]), ID, 'old', { result: { spec: 'a.md', plan: 'p1.md' } }), ID, {}, { result: { plan: 'p2.md' } });
  assert.deepEqual(resultOf(state, ID), { spec: 'a.md', plan: 'p2.md' });
  assert.equal(resultOf(base([task(1)]), ID), undefined);
});

test('resultOf keeps a loaded __proto__ key as an own key and never swaps the merged object\'s prototype (#629)', () => {
  const loaded = JSON.parse('{"__proto__": {"x": 1}, "spec": "a"}') as Record<string, unknown>;
  const merged = resultOf(withKeptRecord(base([task(1)]), ID, 'old', { result: loaded }), ID)!;
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.deepEqual([Object.hasOwn(merged, '__proto__'), merged.spec, (merged as { x?: unknown }).x], [true, 'a', undefined]);
});

test('prsOf concatenates every record\'s PRs oldest first, and usageOf sums their usage (#629)', () => {
  const old = { url: 'https://github.com/o/r/pull/1', state: 'merged' as const };
  const fresh = { url: 'https://github.com/o/r/pull/2', state: 'open' as const };
  const state = withWork(
    withKeptRecord(base([task(1)]), ID, 'old', { prs: [old], usage: { tokens: 10, ms: 100, waitingMs: 5 } }),
    ID, {}, { prs: [fresh], usage: { tokens: 1, ms: 2, waitingMs: 3 } },
  );
  assert.deepEqual(prsOf(state, ID), [old, fresh]);
  assert.deepEqual(usageOf(state, ID), { tokens: 11, ms: 102, waitingMs: 8 });
  assert.equal(usageOf(base([task(1)]), ID), undefined);
});

test('pruneRecords drops a record once no live activity has its id and its task left, and keeps the live and the local ones (#629)', () => {
  const state = withLocal(withWork(withKeptRecord(base([task(1), task(2)]), ID, 'old'), 'board:item2'), 'hive');
  assert.equal(pruneRecords(state), state, 'nothing to prune: the same state');
  const left = { ...state, tasks: [task(2)] };
  assert.deepEqual(pruneRecords(left).activityRecords.map((r) => r.id).sort(), [activityIdOf('board:item2'), localActivityId('hive')].sort());
});

test('pruneWork keeps a task activity whose tasks all left while its worktree is on disk and nothing runs, deletes or checks out there; otherwise it goes with its record (#861)', () => {
  const left = (work: Partial<Activity>): State => withWork(base([]), ID, work);
  const kept = left({ worktree: '/w/1' });
  assert.equal(pruneWork(kept), kept, 'kept: the same state');
  const gone: [string, Partial<Activity>][] = [['no worktree', {}], ['worktreeGone', { worktree: '/w/1', worktreeGone: true }], ['a run', { worktree: '/w/1', workerId: 'w1' }], ['deleting', { worktree: '/w/1', deleting: true }], ['the checkout', { worktree: '/repo', local: true }]];
  for (const [why, work] of gone) {
    const pruned = pruneWork(left(work));
    assert.deepEqual([pruned.activities, pruned.activityRecords], [[], []], why);
  }
});
