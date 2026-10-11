import { expect, test } from 'vitest';
import { focusSet, focusTrail } from '@/lib/tree-focus';
import type { Item, Task } from '../../src/types';

type Links = Pick<Item, 'parent' | 'children'>;
const task = (n: number, links: Links = {}): Task => ({
  item: { itemId: `I${n}`, id: String(n), title: `Task ${n}`, body: '', url: '', ...links }, stage: 'Build', boardColumn: '', auto: true,
});
// The handoff's tree: #870 lists #871…#874, #872 lists #875 and #876; #9 is in no tree
const TREE = [
  task(870, { children: ['I871', 'I872', 'I873', 'I874'] }),
  task(871, { parent: 'I870' }), task(872, { parent: 'I870', children: ['I875', 'I876'] }), task(873, { parent: 'I870' }), task(874, { parent: 'I870' }),
  task(875, { parent: 'I872' }), task(876, { parent: 'I872' }), task(9),
];

test('focusSet on #872 holds #872, #875 and #876 only; a task in no tree is a set of one; an itemId that is no task gives undefined (#35)', () => {
  expect([...(focusSet(TREE, 'I872') ?? [])].sort()).toEqual(['I872', 'I875', 'I876']);
  expect(focusSet(TREE, 'I9')).toEqual(new Set(['I9']));
  expect(focusSet(TREE, 'I999')).toBeUndefined();
});

test('focusTrail runs from the root down to the task: #875 gives #870, #872, #875; a root gives itself; an itemId that is no task gives none (#35)', () => {
  expect(focusTrail(TREE, 'I875').map((t) => t.item.id)).toEqual(['870', '872', '875']);
  expect(focusTrail(TREE, 'I870').map((t) => t.item.id)).toEqual(['870']);
  expect(focusTrail(TREE, 'I999')).toEqual([]);
});
