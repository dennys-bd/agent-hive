import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/orchestrator.js';
import { outOfRead } from '../src/out-of-listing.js';
import { mainFlows } from './fixtures/main-flow.js';
import type { Item, SourceItem, SourceItemRead, Stage, State, Task } from '../src/types.js';
import { withWork } from './fixtures/work.js';

// #568: what a read past the listing makes of a started task the poll's listing lacks
const STAGES: Stage[] = [{ name: 'dev', from: { board: ['Ready'] }, prompt: 'x' }, { name: 'review', from: { board: ['In review'] }, prompt: 'y' }];
const AT = '2026-11-04T12:00:00.000Z';
const FACETS = { assignees: ['bia'], labels: ['hive'], fields: {} };
const item = (title = 'T1', extra: Partial<Item> = {}): Item => ({ itemId: 'board:I1', id: '1', title, body: '', url: 'https://github.com/acme/r/issues/1', source: 'board', ...extra });
const TASK: Task = { item: item('T1', { facets: FACETS }), stage: 'dev', boardColumn: 'Ready', auto: true, enteredAt: AT };
const STOPPED: State = withWork(initialState(0), 'board:I1'); // started, no worker
const HELD: State = withWork(initialState(0), 'board:I1', { workerId: 's1' });

test('a listing or filter read merges the entry as a listed task would, the stage entry included, and marks the reason (#568)', () => {
  const entry: SourceItem = { item: item('Renamed', { facets: { ...FACETS, labels: ['spec'] } }), column: 'In review' };
  const read = outOfRead(TASK, { reason: 'filter', entry }, mainFlows(STAGES), STOPPED, AT);
  assert.deepEqual([read?.outOfListing, read?.item.title, read?.item.facets?.labels, read?.boardColumn, read?.stage], ['filter', 'Renamed', ['spec'], 'In review', 'review']);
  assert.equal(outOfRead(TASK, { reason: 'listing', entry }, mainFlows(STAGES), STOPPED, AT)?.outOfListing, 'listing');
});

test('a project read refreshes title, body, url and createdAt alone: the column, the stage and the fields stay (#568)', () => {
  const issue = item('Off the Project', { body: 'new', createdAt: '2026-10-01T00:00:00Z' });
  assert.deepEqual(outOfRead(TASK, { reason: 'project', item: issue }, mainFlows(STAGES), STOPPED, AT),
    { ...TASK, item: { ...TASK.item, title: 'Off the Project', body: 'new', createdAt: '2026-10-01T00:00:00Z' }, outOfListing: 'project' });
});

test('a closed read lets a free task go; one a worker holds stays as it was (#568)', () => {
  const closed: SourceItemRead = { reason: 'closed', item: item() };
  assert.equal(outOfRead(TASK, closed, mainFlows(STAGES), STOPPED, AT), undefined);
  assert.equal(outOfRead(TASK, closed, mainFlows(STAGES), HELD, AT), TASK);
});

test('a gone read turns the task orphan and drops its mark (#568)', () => {
  assert.deepEqual(outOfRead({ ...TASK, outOfListing: 'filter' }, { reason: 'gone' }, mainFlows(STAGES), STOPPED, AT), { ...TASK, orphan: true });
});

test('no read marks an unmarked task listing and leaves a marked one as it is (#568)', () => {
  assert.deepEqual(outOfRead(TASK, undefined, mainFlows(STAGES), STOPPED, AT), { ...TASK, outOfListing: 'listing' });
  const marked: Task = { ...TASK, outOfListing: 'project' };
  assert.equal(outOfRead(marked, undefined, mainFlows(STAGES), STOPPED, AT), marked);
});
