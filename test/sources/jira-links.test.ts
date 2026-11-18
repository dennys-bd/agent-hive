import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadBlockerRefError, BadRelationTypeError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from '../../src/blocker-errors.js';
import { JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import { linksOf } from '../../src/sources/jira-item.js';
import { relationsOf } from '../../src/sources/jira-links.js';
import { storedLinks } from '../../src/sources/jira-relations.js';
import type { Relation, RelationChange, Source } from '../../src/types.js';
import { adapter, end, fakeJira, GATES, heldBy, inward, issue, outward, type PostedLink, read, RELATES, seeded, type Setup } from './jira-fakes.js';

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

const change = (action: RelationChange['action'], ref: string, type = 'Relates', direction: RelationChange['direction'] = 'outward'): RelationChange => ({ action, type, direction, ref });
const TWO: Relation = { id: 'ABC-2', title: 'Issue 2', state: 'open', type: 'Relates', direction: 'outward', phrase: 'relates to' };
function setting(setup: Setup = {}): NonNullable<Source['setRelation']> {
  const { setRelation } = adapter(setup);
  assert.ok(setRelation);
  return setRelation;
}

test('an add of Relates outward posts one link, the item as inwardIssue, and answers the re-read and the entry; a second add sends nothing (#829)', async () => {
  const linked = read(issue(1, 'To Do', { issuelinks: [outward('20001', end(2), RELATES)] }));
  const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), linked], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
  const written = await setting({ call: fake.call })('10001', change('add', 'ABC-2'));
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/ABC-2', 'POST /issueLink', 'GET /issue/10001']);
  assert.deepEqual(fake.bodies, [{ type: { name: 'Relates' }, inwardIssue: { key: 'ABC-1' }, outwardIssue: { key: 'ABC-2' } }]);
  assert.deepEqual(written.relations, [TWO]);
  assert.deepEqual(written.entry?.item.relations, [TWO]);
  const again = fakeJira({ 'GET /issue/10001': [linked], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))] });
  assert.deepEqual(await setting({ call: again.call })('10001', change('add', 'ABC-2')), { relations: [TWO] });
  assert.deepEqual(again.sent, ['GET /issue/10001', 'GET /issue/ABC-2']);
});

test('the written link reads back through linkOf in the asked direction on the item and the other way on the other issue (#829)', async () => {
  for (const direction of ['outward', 'inward'] as const) {
    const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), read(issue(1, 'To Do'))], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
    await setting({ call: fake.call })('10001', change('add', 'ABC-2', 'Gates', direction));
    const held = heldBy(fake.bodies[0] as PostedLink, GATES);
    const [mine, theirs] = direction === 'outward' ? ['gates', 'is gated by'] : ['is gated by', 'gates'];
    assert.deepEqual(linksOf(held['ABC-1']).map((l) => [l.key, l.direction, l.phrase]), [['ABC-2', direction, mine]], direction);
    assert.deepEqual(linksOf(held['ABC-2']).map((l) => [l.key, l.direction === direction, l.phrase]), [['ABC-1', false, theirs]], direction);
  }
});

test('a removal deletes every link of that type and direction to the other issue and nothing else; with no match it sends nothing (#829)', async () => {
  const links = [
    outward('20001', end(2), RELATES), outward('20002', end(2), RELATES), inward('20003', end(2), RELATES),
    outward('20004', end(2), GATES), outward('20005', end(3), RELATES), inward('20006', end(2)),
  ];
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do', { issuelinks: links })), read(issue(1, 'To Do', { issuelinks: links.slice(2) }))],
    'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'DELETE /issueLink/20001': [undefined], 'DELETE /issueLink/20002': [undefined],
  });
  const written = await setting({ call: fake.call })('10001', change('remove', 'ABC-2'));
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/ABC-2', 'DELETE /issueLink/20001', 'DELETE /issueLink/20002', 'GET /issue/10001']);
  assert.deepEqual(written.relations.map((r) => [r.id, r.type, r.direction]), [['ABC-2', 'Relates', 'inward'], ['ABC-2', 'Gates', 'outward'], ['ABC-3', 'Relates', 'outward']]);
  const quiet = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do', { issuelinks: links.slice(2) }))], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))] });
  await setting({ call: quiet.call })('10001', change('remove', 'ABC-2'));
  assert.deepEqual(quiet.sent, ['GET /issue/10001', 'GET /issue/ABC-2']);
});

test('a change naming a blocking type is refused before any call; a ref that is no key, an unknown key and the item\'s own key take the type-neutral errors (#829)', async () => {
  const none = fakeJira();
  await assert.rejects(setting({ call: none.call })('10001', change('add', 'ABC-2', 'Blocks')), BadRelationTypeError);
  await assert.rejects(setting({ call: none.call })('10001', change('remove', 'ABC-2', 'Blocks', 'inward')), { message: '"Blocks" is a blocking link type: the blockers section edits it' });
  assert.deepEqual(none.sent, []);
  const bad = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))] });
  await assert.rejects(setting({ call: bad.call })('10001', change('add', 'abc-12')), BadBlockerRefError);
  const unknown = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/ABC-9': [new JiraNotFoundError()] });
  await assert.rejects(setting({ call: unknown.call })('10001', change('add', 'ABC-9')), BlockerRefNotFoundError);
  const self = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/ABC-1': [read(issue(1, 'To Do'))] });
  await assert.rejects(setting({ call: self.call })('10001', change('add', 'ABC-1')), SelfBlockerError);
});

test('a re-read that fails after the write throws RelationRereadError: with the relations once they were read, none when the read failed (#829)', async () => {
  const answers = (reread: unknown) => fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), reread], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
  await assert.rejects(setting({ call: answers(new Error('jira api: HTTP 502')).call })('10001', change('add', 'ABC-2')),
    (err: unknown) => err instanceof RelationRereadError && err.message === 'jira api: HTTP 502' && err.relations === undefined && err.blockers === undefined);
  const db = await seeded([]);
  const broken = { items: db.items, transaction: <T>(_run: () => T): T => { throw new Error('database is locked'); } };
  const linked = read(issue(1, 'To Do', { issuelinks: [outward('20001', end(2), RELATES)] }));
  await assert.rejects(setting({ call: answers(linked).call, db: broken })('10001', change('add', 'ABC-2')), (err: unknown) => {
    assert.ok(err instanceof RelationRereadError);
    assert.deepEqual([err.message, err.relations], ['database is locked', [TWO]]);
    return true;
  });
});
