import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrate } from '../src/hydrate.js';
import type { Item, SourceItem, Task } from '../src/types.js';

// #191: the boot read's items swapped into the lean tasks state.json loaded
const AT = '2026-10-13T10:00:00.000Z';
const item = (n: number): Item => ({ itemId: `board:item${n}`, id: String(n), title: `Task ${n}`, body: '', url: `https://github.com/o/r/issues/${n}`, source: 'board' });

test('hydrate swaps in each stored item for its task\'s lean one and touches nothing else; an unstored task stays, a stored item with no task adds none (#191)', () => {
  const lean: Task = {
    item: { itemId: 'board:item1', id: '1', title: '', body: '', url: '', source: 'board' }, stage: 'dev', boardColumn: 'Ready', auto: true, pinned: true,
    columnWrite: { column: 'Ready', stale: ['Done'], at: AT },
  };
  const other: Task = { item: item(2), stage: 'dev', boardColumn: 'Ready', auto: true };
  const stored: SourceItem[] = [{ item: item(1), column: 'Done' }, { item: item(3), column: 'Ready' }];
  const hydrated = hydrate([lean, other], stored);
  assert.deepEqual(hydrated[0], { ...lean, item: item(1) }, 'the stored column moves nothing: the first poll does');
  assert.equal(hydrated[1], other, 'no stored item: the same object');
  assert.equal(hydrated.length, 2, 'item3 has no task and gets none');
  assert.equal(lean.item.title, '', 'the input is untouched');
});
