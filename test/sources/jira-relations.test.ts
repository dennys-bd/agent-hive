import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraItemOf, linksOf } from '../../src/sources/jira-item.js';
import { blockersOf, openBlockers, storedLinks } from '../../src/sources/jira-relations.js';
import { writeIssue } from '../../src/sources/jira-sync.js';
import type { Item } from '../../src/types.js';
import { adapter, DEPENDS, end, fakeJira, inward, issue, NAMES, outward, read, RELATES, ROWS, SCHEMA, seeded } from './jira-fakes.js';

const NO_ROWS = (): undefined => undefined;
const shown = (item: Item | undefined) => [item?.blockers?.blockedBy, item?.blockedBy];
const IN_PROGRESS = { name: 'In Progress', statusCategory: { key: 'indeterminate' } };
const DONE = { name: 'Done', statusCategory: { key: 'done' } };

test('an inward Blocks link to an issue whose row is in progress is an open blocker and gates the task; once that row is done it is closed, the blocked row untouched (#828)', async () => {
  const db = await seeded([
    issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }),
    issue(2, 'In Progress', { status: IN_PROGRESS, issuelinks: [outward('20001', end(1))] }),
  ]);
  const abc1 = async () => (await adapter({ db }).listItems()).find((t) => t.item.id === 'ABC-1')?.item;
  assert.deepEqual(shown(await abc1()), [[{ id: 'ABC-2', title: 'Issue 2', state: 'open' }], ['ABC-2']]);
  writeIssue(db, jiraItemOf(ROWS, 'ABC', issue(2, 'Done', { status: DONE, updated: '2026-11-16T11:00:00.000+0000' }), NAMES, SCHEMA));
  assert.deepEqual(shown(await abc1()), [[{ id: 'ABC-2', title: 'Issue 2', state: 'closed' }], undefined], 'the link still says new: the row decides');
});

test('a live read takes its blockers\' states from the store too (#828)', async () => {
  const db = await seeded([issue(2, 'Done', { status: DONE })]);
  const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }))] });
  const answer = await adapter({ call: fake.call, db }).item('10001', '');
  assert.ok('entry' in answer);
  assert.deepEqual(shown(answer.entry.item), [[{ id: 'ABC-2', title: 'Issue 2', state: 'closed' }], undefined]);
});

test('with no row a blocker takes its link\'s category; an outward link is blocking; a Relates link is in neither; two blocking types between one pair show once (#828)', () => {
  const links = linksOf(issue(1, 'To Do', { issuelinks: [
    inward('20001', end(2, { category: 'done' })), inward('20002', end(2), DEPENDS), outward('20003', end(3)), inward('20004', end(4), RELATES),
  ] }));
  const blockers = blockersOf(links, ['Blocks', 'Depends'], NO_ROWS);
  assert.deepEqual(blockers, { blockedBy: [{ id: 'ABC-2', title: 'Issue 2', state: 'closed' }], blocking: [{ id: 'ABC-3', title: 'Issue 3', state: 'open' }] });
  assert.deepEqual(openBlockers(blockers), []);
  assert.deepEqual(blockersOf(links, ['Blocks'], () => null).blockedBy, [{ id: 'ABC-2', title: 'Issue 2', state: 'open' }], 'a row with no category is open');
  assert.deepEqual(blockersOf(links, [], NO_ROWS), { blockedBy: [], blocking: [] });
});

test('storedLinks reads data.links leniently: a link stored before #828 has no linkId and still reads; another shape is no link (#828)', () => {
  const old = { type: 'Blocks', direction: 'inward', phrase: 'is blocked by', id: '10002', key: 'ABC-2', title: null, statusCategory: 'new' };
  assert.deepEqual(storedLinks([old, { type: 'Blocks' }, 'x', null]), [{ type: 'Blocks', direction: 'inward', id: '10002', key: 'ABC-2', title: null, statusCategory: 'new' }]);
  assert.deepEqual(storedLinks(undefined), []);
});
