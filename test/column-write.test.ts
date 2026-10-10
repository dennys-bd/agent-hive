import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_WRITE_TIMEOUT_MS, staleRead, withColumnWrite } from '../src/column-write.js';
import type { Task } from '../src/types.js';

const AT = '2026-10-09T12:00:00.000Z';
const after = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();
// The #793 task: in CI on the source when the Hive moves it on
const TASK: Task = { item: { itemId: 'board:item1', id: '1', title: 'Task 1', body: '', url: '', source: 'board' }, stage: 'ci', boardColumn: 'CI', auto: true };

test('withColumnWrite sets the column and marks the one it replaces as stale; a write over a mark adds the previous target once and never the new column; an empty column marks nothing (#889)', () => {
  const first = withColumnWrite(TASK, 'In review', AT);
  assert.deepEqual([first.boardColumn, first.columnWrite], ['In review', { column: 'In review', stale: ['CI'], at: AT }]);
  assert.equal(TASK.columnWrite, undefined, 'the input is untouched');
  const second = withColumnWrite(first, 'Done', after(1000));
  assert.deepEqual(second.columnWrite, { column: 'Done', stale: ['CI', 'In review'], at: after(1000) }, 'A → B → C: a stale poll may show A or B');
  const back = withColumnWrite(second, 'CI', after(2000));
  assert.deepEqual(back.columnWrite, { column: 'CI', stale: ['In review', 'Done'], at: after(2000) }, 'the column written again is no longer stale');
  const doubled: Task = { ...TASK, boardColumn: 'B', columnWrite: { column: 'B', stale: ['A', 'B'], at: AT } };
  assert.deepEqual(withColumnWrite(doubled, 'C', AT).columnWrite?.stale, ['A', 'B'], 'no duplicates');
  assert.deepEqual(withColumnWrite({ ...TASK, boardColumn: '' }, 'Ready', AT).columnWrite, { column: 'Ready', stale: [], at: AT });
});

test('staleRead holds only a stale column, and only for less than COLUMN_WRITE_TIMEOUT_MS after the write (#889)', () => {
  const marked = withColumnWrite(TASK, 'In review', AT);
  assert.equal(staleRead(marked, 'CI', after(COLUMN_WRITE_TIMEOUT_MS - 1)), true, 'just under the window');
  assert.equal(staleRead(marked, 'CI', after(COLUMN_WRITE_TIMEOUT_MS)), false, 'at the window: expired');
  assert.equal(staleRead(marked, 'In review', AT), false, 'the written column confirms the write');
  assert.equal(staleRead(marked, 'Dev', AT), false, 'a third column is a move');
  assert.equal(staleRead(TASK, 'CI', AT), false, 'no mark, nothing stale');
  assert.equal(staleRead({ ...marked, columnWrite: { ...marked.columnWrite!, at: 'garbage' } }, 'CI', AT), false, 'an unreadable stamp holds nothing');
  assert.equal(staleRead(marked, 'CI', after(-1)), false, 'a stamp in the future (the clock stepped back) holds nothing');
  const damaged = { ...TASK, columnWrite: { column: 'In review', at: AT } } as unknown as Task; // as a damaged state file may hold it
  assert.equal(staleRead(damaged, 'CI', AT), false, 'a mark without its stale list holds nothing and does not throw');
  assert.deepEqual(withColumnWrite(damaged, 'Done', AT).columnWrite?.stale, ['CI'], 'and a write over it starts afresh');
});
