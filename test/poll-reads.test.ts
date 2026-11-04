import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/orchestrator.js';
import { readUnlisted, unlistedStarted } from '../src/poll-reads.js';
import type { Item, SourceItem, SourceItemRead, Task } from '../src/types.js';
import { fakeLog } from './fakes.js';
import { withWork } from './fixtures/work.js';

const item = (source: string, n: number): Item => ({ itemId: `${source}:I${n}`, id: String(n), title: `T${n}`, body: '', url: `https://github.com/acme/r/issues/${n}`, source });
const task = (source: string, n: number, extra: Partial<Task> = {}): Task => ({ item: item(source, n), stage: 'dev', boardColumn: 'Ready', auto: true, ...extra });
const listed = (n: number): SourceItem => ({ item: item('board', n), column: 'Ready' });

test('unlistedStarted picks the polled source\'s started tasks its listing lacks: no orphan, created, leaving, listed, never-started or other source\'s task (#568)', () => {
  const tasks = [task('board', 1), task('board', 2, { outOfListing: 'filter' }), task('board', 3, { orphan: true }), task('board', 4, { leaving: true }),
    task('board', 5), task('notes', 6), task('board', 7), task('board', 8, { created: true })];
  const started = ['board:I1', 'board:I2', 'board:I3', 'board:I4', 'notes:I6', 'board:I7', 'board:I8'].reduce((s, id) => withWork(s, id), { ...initialState(0), tasks }); // 5 never started
  assert.deepEqual(unlistedStarted(started, 'board', [listed(7)]).map((c) => c.item.itemId), ['board:I1', 'board:I2']);
});

test('readUnlisted reads item() one task after another with its url; a rejected read is logged with the task id and left out (#568)', async () => {
  const calls: string[] = [];
  let open = 0;
  const answer: SourceItemRead = { reason: 'gone' };
  const source = {
    item: async (itemId: string, url: string): Promise<SourceItemRead> => {
      open += 1;
      assert.equal(open, 1, 'one read at a time');
      calls.push(`${itemId} ${url}`);
      await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
      if (itemId === 'board:I2') throw new Error('rate limited');
      return answer;
    },
  };
  const { log, lines } = fakeLog();
  const reads = await readUnlisted(source, [task('board', 1), task('board', 2), task('board', 3)], log);
  assert.deepEqual(calls, ['board:I1 https://github.com/acme/r/issues/1', 'board:I2 https://github.com/acme/r/issues/2', 'board:I3 https://github.com/acme/r/issues/3']);
  assert.deepEqual(reads, [{ itemId: 'board:I1', read: answer }, { itemId: 'board:I3', read: answer }]);
  assert.deepEqual(lines, ['ERROR poll read #board:I2: rate limited']);
});
