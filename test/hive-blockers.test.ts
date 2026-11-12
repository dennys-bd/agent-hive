import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerProblem, blockerSet, closeLeftChildren, closeRefsTo } from '../src/hive-blockers.js';
import { initialState } from '../src/orchestrator.js';
import type { BlockerChange, State, Task } from '../src/types.js';

const hive = (n: number): Task => ({ item: { itemId: `local:${n}`, id: `HIVE-${n}`, title: `T${n}`, body: '', url: '' }, stage: 'dev', boardColumn: '', created: true, auto: true });
const GH: Task = { item: { itemId: 'work:PVTI_1', id: '12', title: 'Gh', body: '', url: '', source: 'work' }, stage: 'dev', boardColumn: '', auto: true };
const stateOf = (tasks: Task[]): State => ({ ...initialState(0), tasks });
const set = (state: State, itemId: string, change: BlockerChange): State => blockerSet(state, { type: 'blockerSet', itemId, change });
const add = (ref: string, kind: BlockerChange['kind'] = 'blockedBy'): BlockerChange => ({ action: 'add', kind, ref });
const remove = (ref: string, kind: BlockerChange['kind'] = 'blockedBy'): BlockerChange => ({ action: 'remove', kind, ref });
const open = (n: number) => ({ id: `HIVE-${n}`, title: `T${n}`, state: 'open' as const });
const NONE = { blockedBy: [], blocking: [] };

test('blockerSet writes both ends, sets blockedBy to the open blocker, and leaves its input untouched (#56)', () => {
  const before = stateOf([hive(1), hive(2), GH]);
  const frozen = structuredClone(before);
  const after = set(before, 'local:1', add('HIVE-2'));
  assert.deepEqual(after.tasks[0].item, { ...hive(1).item, blockers: { blockedBy: [open(2)], blocking: [] }, blockedBy: ['HIVE-2'] });
  assert.deepEqual(after.tasks[1].item, { ...hive(2).item, blockers: { blockedBy: [], blocking: [open(1)] } }, 'no gate on the blocker');
  assert.equal(after.tasks[2], GH, 'another task is the same object');
  assert.deepEqual(before, frozen, 'the input is untouched');
});

test('blockerSet with blocking writes the mirror: the other task is the one blocked (#56)', () => {
  const after = set(stateOf([hive(1), hive(2)]), 'local:1', add('HIVE-2', 'blocking'));
  assert.deepEqual(after.tasks.map((t) => t.item.blockedBy), [undefined, ['HIVE-1']]);
});

test('blockerSet remove clears both ends and the gate, from either side (#56)', () => {
  const linked = set(stateOf([hive(1), hive(2)]), 'local:1', add('HIVE-2'));
  const after = set(linked, 'local:2', remove('HIVE-1', 'blocking'));
  assert.deepEqual(after.tasks.map((t) => [t.item.blockers, 'blockedBy' in t.item]), [[NONE, false], [NONE, false]]);
});

test('blockerSet leaves the state itself for a repeated add, a remove of none, self, the reverse relation, an unknown task and a source\'s task (#56)', () => {
  const linked = set(stateOf([hive(1), hive(2), GH]), 'local:1', add('HIVE-2'));
  const cases: [string, BlockerChange][] = [
    ['local:1', add('HIVE-2')], ['local:1', remove('HIVE-2', 'blocking')], ['local:1', add('HIVE-1')], ['local:2', add('HIVE-1')],
    ['local:9', add('HIVE-2')], ['local:1', add('12')], ['work:PVTI_1', add('HIVE-1')],
  ];
  for (const [itemId, change] of cases) assert.equal(set(linked, itemId, change), linked, `${itemId} ${change.action} ${change.kind} ${change.ref}`);
});

test('blockerProblem names why a hive relation cannot be written, and nothing when it can (#56)', () => {
  const { tasks } = set(stateOf([hive(1), hive(2), GH]), 'local:1', add('HIVE-2'));
  assert.deepEqual([
    blockerProblem(tasks, 'local:9', add('HIVE-2')), blockerProblem(tasks, 'work:PVTI_1', add('HIVE-2')), blockerProblem(tasks, 'local:1', add('HIVE-9')),
    blockerProblem(tasks, 'local:1', add('12')), blockerProblem(tasks, 'local:1', add('HIVE-1')), blockerProblem(tasks, 'local:2', add('HIVE-1')),
    blockerProblem(tasks, 'local:2', remove('HIVE-1')), blockerProblem(tasks, 'local:1', add('HIVE-2')),
  ], ['unknownItem', 'unknownItem', 'unknownRef', 'crossSource', 'self', 'cycle', undefined, undefined]);
});

test('closeRefsTo marks every ref to a dropped hive task closed, its title kept, and frees the gate it held; a source task changes nothing (#56)', () => {
  const { tasks } = set(stateOf([hive(1), hive(2), hive(3)]), 'local:1', add('HIVE-2'));
  const [one, two, three] = tasks;
  const left = closeRefsTo([one, three], two);
  assert.deepEqual(left[0].item.blockers, { blockedBy: [{ id: 'HIVE-2', title: 'T2', state: 'closed' }], blocking: [] });
  assert.equal('blockedBy' in left[0].item, false, 'a closed blocker stops nothing');
  assert.equal(left[1], three, 'a task with no ref to it is the same object');
  assert.equal(closeRefsTo(tasks, GH), tasks);
});

test('a closed ref to a task that left the Hive can be removed from the end that remains (#56)', () => {
  const { tasks } = set(stateOf([hive(1), hive(2)]), 'local:1', add('HIVE-2'));
  const left = stateOf(closeRefsTo([tasks[0]], tasks[1]));
  assert.equal(blockerProblem(left.tasks, 'local:1', remove('HIVE-2')), undefined);
  assert.equal(blockerProblem(left.tasks, 'local:1', add('HIVE-2')), 'unknownRef', 'it cannot be added back');
  assert.deepEqual(set(left, 'local:1', remove('HIVE-2')).tasks[0].item.blockers, NONE);
});

// #782: a hive tree as createTask writes it, local:1 the parent
const kid = (n: number, parent: string): Task => ({ ...hive(n), item: { ...hive(n).item, parent } });
const parentOf = (n: number, children: string[]): Task => ({ ...hive(n), item: { ...hive(n).item, children } });

test('closeLeftChildren returns after itself when no hive task left, or none that left has a hive parent still in the state (#782)', () => {
  const tasks = [parentOf(1, ['local:2']), kid(2, 'local:1')];
  assert.equal(closeLeftChildren(tasks, tasks), tasks);
  const copy = [...tasks];
  assert.equal(closeLeftChildren(tasks, copy), copy, 'a new list with the same tasks');
  const rest = [hive(3)];
  assert.equal(closeLeftChildren([...tasks, ...rest], rest), rest, 'its parent left with it');
  const ghKid: Task = { ...GH, item: { ...GH.item, parent: 'local:1' } };
  const kept = [tasks[0]];
  assert.equal(closeLeftChildren([tasks[0], ghKid], kept), kept, 'a source\'s task is no hive child');
});

test('closeLeftChildren marks each left hive child once on its hive parent, in order, never twice; every other task is the same object (#782)', () => {
  const before = [parentOf(1, ['local:2', 'local:3']), kid(2, 'local:1'), kid(3, 'local:1'), hive(4)];
  const [parent, , three, four] = before;
  const after = closeLeftChildren(before, [parent, three, four]);
  assert.deepEqual(after[0].item.closedChildren, ['local:2']);
  assert.equal(after[1], three);
  assert.equal(after[2], four);
  assert.equal(parent.item.closedChildren, undefined, 'the input is untouched');
  assert.equal(closeLeftChildren(before, after), after, 'already closed: never twice');
  assert.deepEqual(closeLeftChildren(before, [parent, four])[0].item.closedChildren, ['local:2', 'local:3'], 'both in one reduction');
});

test('closeLeftChildren leaves a source parent untouched: its source sends its closed children (#782)', () => {
  const source: Task = { ...GH, item: { ...GH.item, children: ['work:PVTI_9'] } };
  const after = [source];
  assert.equal(closeLeftChildren([source, kid(2, 'work:PVTI_1')], after), after);
});
