import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relationsOf } from '../../src/sources/jira-links.js';
import { storedLinks } from '../../src/sources/jira-relations.js';
import { adapter, end, GATES, inward, issue, outward, RELATES, seeded } from './jira-fakes.js';

const DONE = { name: 'Done', statusCategory: { key: 'done' } };

test('a Relates link and a custom type\'s link are relations with their phrases, keys, titles and states; a Blocks link is not; a task with no links has [] (#829)', async () => {
  const db = await seeded([
    issue(1, 'To Do', { issuelinks: [outward('20001', end(2), RELATES), inward('20002', end(3), GATES), inward('20003', end(4))] }),
    issue(5, 'To Do'),
  ]);
  const listed = await adapter({ db }).listItems();
  assert.deepEqual(listed.map((t) => [t.item.id, t.item.relations]), [
    ['ABC-1', [
      { id: 'ABC-2', title: 'Issue 2', state: 'open', type: 'Relates', direction: 'outward', phrase: 'relates to' },
      { id: 'ABC-3', title: 'Issue 3', state: 'open', type: 'Gates', direction: 'inward', phrase: 'is gated by' },
    ]],
    ['ABC-5', []],
  ]);
  assert.deepEqual(listed[0]?.item.blockers?.blockedBy.map((b) => b.id), ['ABC-4'], 'the Blocks link stays in the blockers section only');
});

test('a relation whose other issue\'s row is done reads closed while its link still says new; with no row it takes the link\'s category (#829)', async () => {
  const db = await seeded([
    issue(1, 'To Do', { issuelinks: [outward('20001', end(2), RELATES), outward('20002', end(3, { category: 'done' }), RELATES), outward('20003', end(4), RELATES)] }),
    issue(2, 'Done', { status: DONE }),
  ]);
  const abc1 = (await adapter({ db }).listItems()).find((t) => t.item.id === 'ABC-1');
  assert.deepEqual(abc1?.item.relations?.map((r) => [r.id, r.state]), [['ABC-2', 'closed'], ['ABC-3', 'closed'], ['ABC-4', 'open']]);
});

test('relationsOf: a row with no category is open, and a link stored without a phrase reads under its type\'s name (#829)', () => {
  const links = storedLinks([{ type: 'Relates', direction: 'outward', id: '10002', key: 'ABC-2', title: null, statusCategory: 'done' }]);
  assert.deepEqual(relationsOf(links, ['Blocks'], () => null), [{ id: 'ABC-2', title: '', state: 'open', type: 'Relates', direction: 'outward', phrase: 'Relates' }]);
});
