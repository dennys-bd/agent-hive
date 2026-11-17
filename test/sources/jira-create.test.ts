import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CreateRefusedError, IssuePlacementError } from '../../src/source-create.js';
import { markdownToAdf } from '../../src/sources/adf-parse.js';
import { JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import type { ReadModel } from '../../src/read-model/db.js';
import { adapter, type Fake, fakeJira, issue, read, ROWS, seeded, STATUSES } from './jira-fakes.js';

const TYPES = { startAt: 0, total: 4, issueTypes: [
  { id: '10000', name: 'Epic', subtask: false, hierarchyLevel: 1 }, { id: '10001', name: 'Story', subtask: false, hierarchyLevel: 0 },
  { id: '10002', name: 'Bug', subtask: false, hierarchyLevel: 0 }, { id: '10003', name: 'Sub-task', subtask: true, hierarchyLevel: -1 },
] };
const REF = { id: 'ABC-7', url: 'https://acme.example/browse/ABC-7' };
const LEVEL_TYPE: Record<number, string> = { 1: 'Epic', 0: 'Story', [-1]: 'Sub-task' };
// A parent of that level, as readIssue reads it
const typed = (n: number, level: number) => read(issue(n, 'To Do', { issuetype: { name: LEVEL_TYPE[level], hierarchyLevel: level } }));
// The project's types, the POST's answer and the move's one read: a create that lands in To Do
const answers = (extra: Record<string, unknown[]> = {}) => ({
  'GET /issue/createmeta/ABC/issuetypes': [TYPES], 'POST /issue': [{ id: '10007', key: 'ABC-7', self: 'x' }], 'GET /issue/10007': [read(issue(7, 'To Do'))], ...extra,
});
interface Asked { body?: string; column?: string | null; labels?: string[]; issueType?: string; parent?: string }
const create = (fake: Fake, asked: Asked = {}, db?: ReadModel) =>
  adapter({ call: fake.call, db }).create!({ title: 'Fix login', body: 'steps', column: 'To Do', labels: ['api'], ...asked });
const posted = (fake: Fake): Record<string, unknown> => (fake.bodies[0] as { fields: Record<string, unknown> }).fields;
const refusedWith = (message: string) => (err: unknown) => err instanceof CreateRefusedError && err.message === message;

test('a create posts summary, ADF description, labels, the type by id and the project key, answers the key, its browse URL and the issue id, and is stored and listed (#831)', async () => {
  const db = await seeded([]);
  const fake = fakeJira(answers());
  assert.deepEqual(await create(fake, {}, db), { itemId: '10007', ref: REF });
  assert.deepEqual(fake.sent, ['GET /issue/createmeta/ABC/issuetypes', 'POST /issue', 'GET /issue/10007']);
  assert.deepEqual(posted(fake), { project: { key: 'ABC' }, summary: 'Fix login', issuetype: { id: '10001' }, labels: ['api'], description: markdownToAdf('steps') });
  assert.equal(db.items.items(ROWS, ['10007'])[0]?.item.key, 'ABC-7', 'stored as the move re-read it');
  assert.deepEqual((await adapter({ call: fakeJira().call, db }).listItems()).map((t) => t.item.itemId), ['10007'], 'listed before the next round');
});

test('with no type the source\'s issueType is used, a chosen one is sent by id, and an empty body sends no description (#831)', async () => {
  const plain = fakeJira(answers());
  await create(plain, { body: '' });
  assert.deepEqual([posted(plain).issuetype, 'description' in posted(plain)], [{ id: '10001' }, false]);
  const bug = fakeJira(answers());
  await create(bug, { issueType: 'Bug' });
  assert.deepEqual(posted(bug).issuetype, { id: '10002' });
});

test('a type the project lacks is refused naming it and the project\'s types, with no POST (#831)', async () => {
  const fake = fakeJira(answers());
  await assert.rejects(create(fake, { issueType: 'Task' }), refusedWith('issue type "Task" is not one of ABC\'s: Epic, Story, Bug, Sub-task'));
  assert.deepEqual(fake.sent, ['GET /issue/createmeta/ABC/issuetypes']);
});

test('under an epic the type is issueType, under a standard issue subtaskType, and the parent is sent by id (#831)', async () => {
  const epic = fakeJira(answers({ 'GET /issue/10021': [typed(21, 1)] }));
  await create(epic, { parent: '10021' });
  assert.deepEqual([posted(epic).issuetype, posted(epic).parent], [{ id: '10001' }, { id: '10021' }]);
  const story = fakeJira(answers({ 'GET /issue/10022': [typed(22, 0)] }));
  await create(story, { parent: '10022' });
  assert.deepEqual([posted(story).issuetype, posted(story).parent], [{ id: '10003' }, { id: '10022' }]);
});

test('under a subtask, a chosen type of the wrong level, a subtask type with no parent and a gone parent are refused naming them, with no POST (#831)', async () => {
  const cases: [Asked, Record<string, unknown[]>, string][] = [
    [{ parent: '10023' }, { 'GET /issue/10023': [typed(23, -1)] }, 'ABC-23 is a subtask: nothing can be created under it'],
    [{ parent: '10022', issueType: 'Bug' }, { 'GET /issue/10022': [typed(22, 0)] }, 'issue type "Bug" cannot go under ABC-22: it takes Sub-task'],
    [{ parent: '10021', issueType: 'Sub-task' }, { 'GET /issue/10021': [typed(21, 1)] }, 'issue type "Sub-task" cannot go under ABC-21: it takes Story, Bug'],
    [{ issueType: 'Sub-task' }, {}, 'issue type "Sub-task" needs a parent'],
    [{ parent: '10099' }, { 'GET /issue/10099': [new JiraNotFoundError()] }, 'parent 10099 is not an issue Jira has'],
  ];
  for (const [asked, extra, message] of cases) {
    const fake = fakeJira(answers(extra));
    await assert.rejects(create(fake, asked), refusedWith(message), message);
    assert.equal(fake.sent.includes('POST /issue'), false, message);
  }
});

test('a column other than the new issue\'s status posts the transition to it and stores the re-read (#831)', async () => {
  const db = await seeded([]);
  const fake = fakeJira(answers({
    'GET /issue/10007': [read(issue(7, 'To Do')), read(issue(7, 'In Progress', { updated: '2026-11-16T10:05:00.000+0000' }))],
    'GET /issue/10007/transitions': [{ transitions: [{ id: '21', name: 'Start', to: { name: 'In Progress' } }] }],
    'POST /issue/10007/transitions': [undefined],
  }));
  assert.deepEqual(await create(fake, { column: 'In Progress' }, db), { itemId: '10007', ref: REF });
  assert.deepEqual(fake.sent.slice(1), ['POST /issue', 'GET /issue/10007', 'GET /issue/10007/transitions', 'POST /issue/10007/transitions', 'GET /issue/10007']);
  assert.deepEqual(fake.bodies[1], { transition: { id: '21' } });
  assert.equal(db.items.items(ROWS, ['10007'])[0]?.item.data.status, 'In Progress');
});

test('a missing or failing transition throws IssuePlacementError with the ref, and nothing is rolled back or made twice (#831)', async () => {
  const none = fakeJira(answers({ 'GET /issue/10007/transitions': [{ transitions: [] }] }));
  const missing = await create(none, { column: 'Done' }).catch((e: unknown) => e);
  assert.ok(missing instanceof IssuePlacementError);
  assert.deepEqual([missing.message, missing.ref], ['issue ABC-7 was created but did not reach "Done": ABC-7: no transition to "Done"', REF]);
  const failing = fakeJira(answers({ 'GET /issue/10007/transitions': [{ transitions: [{ id: '31', to: { name: 'Done' } }] }], 'POST /issue/10007/transitions': [new Error('jira api: HTTP 400')] }));
  const failed = await create(failing, { column: 'Done' }).catch((e: unknown) => e);
  assert.ok(failed instanceof IssuePlacementError);
  assert.deepEqual([failed.message, failed.ref], ['issue ABC-7 was created but did not reach "Done": jira api: HTTP 400', REF]);
  assert.deepEqual(failing.sent.filter((s) => s === 'POST /issue' || s.startsWith('DELETE')), ['POST /issue']);
});

test('column null and a label with a space are refused before any call (#831)', async () => {
  const cases: [Asked, string][] = [[{ column: null }, 'a Jira issue always has a status'], [{ labels: ['api', 'needs review'] }, 'label "needs review" has a space: Jira labels cannot']];
  for (const [asked, message] of cases) {
    const fake = fakeJira();
    await assert.rejects(create(fake, asked), refusedWith(message), message);
    assert.deepEqual(fake.sent, [], message);
  }
});

test('createOptions answers the project\'s statuses, the site\'s labels and every issue type with its level, in the project\'s order (#831)', async () => {
  const fake = fakeJira({ 'GET /project/ABC/statuses': [STATUSES], 'GET /label': [{ isLast: true, values: ['api', 'ux'] }], 'GET /issue/createmeta/ABC/issuetypes': [TYPES] });
  assert.deepEqual(await adapter({ call: fake.call }).createOptions!(), {
    statuses: ['To Do', 'In Progress', 'Done'], labels: ['api', 'ux'],
    issueTypes: [{ name: 'Epic', level: 1 }, { name: 'Story', level: 0 }, { name: 'Bug', level: 0 }, { name: 'Sub-task', level: -1 }],
  });
});
