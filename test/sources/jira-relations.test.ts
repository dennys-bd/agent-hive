import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadBlockerRefError, BlockerRefNotFoundError, RelationRereadError, SelfBlockerError } from '../../src/blocker-errors.js';
import { JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import { jiraItemOf, linksOf } from '../../src/sources/jira-item.js';
import { blockersOf, openBlockers, storedLinks } from '../../src/sources/jira-relations.js';
import { writeIssue } from '../../src/sources/jira-sync.js';
import type { JiraIssue } from '../../src/sources/jira-queries.js';
import type { BlockerChange, Item, Source } from '../../src/types.js';
import { adapter, DEPENDS, end, fakeJira, inward, issue, NAMES, outward, read, RELATES, ROWS, SCHEMA, seeded, type Setup } from './jira-fakes.js';

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

const add = (ref: string, kind: BlockerChange['kind'] = 'blockedBy'): BlockerChange => ({ action: 'add', kind, ref });
const remove = (ref: string, kind: BlockerChange['kind'] = 'blockedBy'): BlockerChange => ({ action: 'remove', kind, ref });
const TWO = { blockedBy: [{ id: 'ABC-2', title: 'Issue 2', state: 'open' as const }], blocking: [] };
const NONE = { blockedBy: [], blocking: [] };
function relating(setup: Setup = {}): NonNullable<Source['relate']> {
  const { relate } = adapter(setup);
  assert.ok(relate);
  return relate;
}
function finding(setup: Setup = {}): NonNullable<Source['findBlockers']> {
  const { findBlockers } = adapter(setup);
  assert.ok(findBlockers);
  return findBlockers;
}

test('an add on blockedBy posts one link of the first blocking type, the blocker as inwardIssue, and answers the re-read; a second add sends nothing (#828)', async () => {
  const linked = read(issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }));
  const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), linked], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
  const written = await relating({ call: fake.call, source: { blockingLinkTypes: ['Blocks', 'Depends'] } })('10001', add('ABC-2'));
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/ABC-2', 'POST /issueLink', 'GET /issue/10001']);
  assert.deepEqual(fake.bodies, [{ type: { name: 'Blocks' }, inwardIssue: { key: 'ABC-2' }, outwardIssue: { key: 'ABC-1' } }]);
  assert.deepEqual(written.blockers, TWO);
  assert.deepEqual([written.entry?.item.id, written.entry?.item.blockedBy], ['ABC-1', ['ABC-2']]);
  const again = fakeJira({ 'GET /issue/10001': [linked], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))] });
  assert.deepEqual(await relating({ call: again.call })('10001', add('ABC-2')), { blockers: TWO });
  assert.deepEqual(again.sent, ['GET /issue/10001', 'GET /issue/ABC-2']);
});

interface PostedLink { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } }
// How Jira holds a posted link, as the plan reads Atlassian's example for POST /issueLink: the outward phrase runs from inwardIssue to
// outwardIssue, so inwardIssue's own read lists the other end as its outwardIssue, and outwardIssue's read lists it as its inwardIssue
function heldBy({ inwardIssue, outwardIssue }: PostedLink): Record<string, JiraIssue> {
  const n = (key: string): number => Number(key.split('-')[1]);
  return {
    [inwardIssue.key]: issue(n(inwardIssue.key), 'To Do', { issuelinks: [outward('20001', end(n(outwardIssue.key)))] }),
    [outwardIssue.key]: issue(n(outwardIssue.key), 'To Do', { issuelinks: [inward('20001', end(n(inwardIssue.key)))] }),
  };
}

test('the posted link reads back through linkOf in the asked direction on both issues: A blocks B is A\'s outward link and B\'s inward one (#828)', async () => {
  for (const kind of ['blockedBy', 'blocking'] as const) {
    const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), read(issue(1, 'To Do'))], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
    await relating({ call: fake.call })('10001', add('ABC-2', kind));
    const held = heldBy(fake.bodies[0] as PostedLink);
    const [blocker, blocked] = kind === 'blockedBy' ? ['ABC-2', 'ABC-1'] : ['ABC-1', 'ABC-2'];
    assert.deepEqual(linksOf(held[blocker] as JiraIssue).map((l) => [l.key, l.direction]), [[blocked, 'outward']], kind);
    assert.deepEqual(linksOf(held[blocked] as JiraIssue).map((l) => [l.key, l.direction]), [[blocker, 'inward']], kind);
  }
});

test('a remove deletes every blocking-type link to the issue in that direction and nothing else; with no match, or no blocking type, it sends nothing (#828)', async () => {
  const links = [inward('20001', end(2)), inward('20002', end(2), DEPENDS), inward('20003', end(2), RELATES), outward('20004', end(2))];
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do', { issuelinks: links })), read(issue(1, 'To Do', { issuelinks: links.slice(2) }))],
    'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'DELETE /issueLink/20001': [undefined], 'DELETE /issueLink/20002': [undefined],
  });
  const written = await relating({ call: fake.call, source: { blockingLinkTypes: ['Blocks', 'Depends'] } })('10001', remove('ABC-2'));
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/ABC-2', 'DELETE /issueLink/20001', 'DELETE /issueLink/20002', 'GET /issue/10001']);
  assert.deepEqual(written.blockers, { blockedBy: [], blocking: [{ id: 'ABC-2', title: 'Issue 2', state: 'open' }] });
  for (const blockingLinkTypes of [['Blocks'], []]) {
    const quiet = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do', { issuelinks: links.slice(2, 3) }))], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))] });
    assert.deepEqual(await relating({ call: quiet.call, source: { blockingLinkTypes } })('10001', remove('ABC-2')), { blockers: NONE });
    assert.deepEqual(quiet.sent, ['GET /issue/10001', 'GET /issue/ABC-2'], JSON.stringify(blockingLinkTypes));
  }
});

test('a ref that is no key, an unknown key and the item itself are refused; an add with no blocking type is refused before any call (#828)', async () => {
  for (const ref of ['abc-12', '12', 'foo']) {
    const fake = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))] });
    await assert.rejects(relating({ call: fake.call })('10001', add(ref)), (err: unknown) => err instanceof BadBlockerRefError && err.message === `"${ref}" is no ref: write ABC-12 or a task id`);
  }
  const unknown = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/ABC-9': [new JiraNotFoundError()] });
  await assert.rejects(relating({ call: unknown.call })('10001', add('ABC-9')), (err: unknown) => err instanceof BlockerRefNotFoundError && err.message === 'nothing answers ABC-9');
  const self = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/ABC-1': [read(issue(1, 'To Do'))] });
  await assert.rejects(relating({ call: self.call })('10001', add('ABC-1')), SelfBlockerError);
  const none = fakeJira();
  await assert.rejects(relating({ call: none.call, source: { blockingLinkTypes: [] } })('10001', add('ABC-2')), { message: 'no blocking link type is configured' });
  assert.deepEqual(none.sent, []);
});

test('a key in another project of the site is added under its own key (#828)', async () => {
  const xyz = end(7, { project: 'XYZ' });
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do')), read(issue(1, 'To Do', { issuelinks: [inward('20001', xyz)] }))],
    'GET /issue/XYZ-7': [read({ ...issue(7, 'To Do', { project: { key: 'XYZ' } }), key: 'XYZ-7' })], 'POST /issueLink': [undefined],
  });
  const written = await relating({ call: fake.call })('10001', add('XYZ-7'));
  assert.deepEqual(fake.bodies, [{ type: { name: 'Blocks' }, inwardIssue: { key: 'XYZ-7' }, outwardIssue: { key: 'ABC-1' } }]);
  assert.deepEqual(written.blockers.blockedBy, [{ id: 'XYZ-7', title: 'Issue 7', state: 'open' }]);
});

test('a re-read that fails after the write throws RelationRereadError: with the relations once they were read, none when the read failed (#828)', async () => {
  const answers = (reread: unknown) => fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do')), reread], 'GET /issue/ABC-2': [read(issue(2, 'To Do'))], 'POST /issueLink': [undefined] });
  await assert.rejects(relating({ call: answers(new Error('jira api: HTTP 502')).call })('10001', add('ABC-2')),
    (err: unknown) => err instanceof RelationRereadError && err.message === 'jira api: HTTP 502' && err.blockers === undefined);
  const db = await seeded([]);
  const broken = { items: db.items, transaction: <T>(_run: () => T): T => { throw new Error('database is locked'); } };
  const linked = read(issue(1, 'To Do', { issuelinks: [inward('20001', end(2))] }));
  await assert.rejects(relating({ call: answers(linked).call, db: broken })('10001', add('ABC-2')), (err: unknown) => {
    assert.ok(err instanceof RelationRereadError);
    assert.deepEqual([err.message, err.blockers], ['database is locked', TWO]);
    return true;
  });
});

test('findBlockers sends one page of 8 over the project, the text escaped, the key clause only for a key, and answers at most 8 refs; a blank text sends nothing (#828)', async () => {
  const many = Array.from({ length: 9 }, (_, i) => issue(i + 2, 'To Do'));
  const fake = fakeJira({ 'POST /search/jql': [{ issues: many, nextPageToken: 't1' }, { issues: [issue(12, 'Done', { status: DONE })], isLast: true }] });
  const found = await finding({ call: fake.call })('10001', 'say "hi" \\ now');
  assert.deepEqual([found.length, found[0]], [8, { id: 'ABC-2', title: 'Issue 2', state: 'open' }]);
  assert.deepEqual(await finding({ call: fake.call })('10001', ' ABC-12 '), [{ id: 'ABC-12', title: 'Issue 12', state: 'closed' }]);
  assert.deepEqual(fake.bodies, [
    { jql: 'project = "ABC" AND (summary ~ "say \\"hi\\" \\\\ now") ORDER BY updated DESC', fields: ['summary', 'status'], maxResults: 8 },
    { jql: 'project = "ABC" AND (summary ~ "ABC-12" OR key = "ABC-12") ORDER BY updated DESC', fields: ['summary', 'status'], maxResults: 8 },
  ]);
  assert.deepEqual(fake.sent, ['POST /search/jql', 'POST /search/jql'], 'one page each, its token never followed');
  const blank = fakeJira();
  assert.deepEqual(await finding({ call: blank.call })('10001', '  '), []);
  assert.deepEqual(blank.sent, []);
});
