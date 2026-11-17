import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadModel } from '../../src/read-model/db.js';
import { isNotConnected } from '../../src/source-errors.js';
import { archiveIssue, deleteIssue, subtaskIds } from '../../src/sources/jira-actions.js';
import { JiraHttpError, JiraNotFoundError } from '../../src/sources/jira-fetch.js';
import { adapter, fakeJira, issue, read, ROWS, seeded } from './jira-fakes.js';

const PLAN = 'ABC-1: this site\'s plan does not archive issues (Jira Premium or Enterprise)';
const ADMIN = 'ABC-1: archiving needs a Jira admin or site admin';
const SUBTASK = 'ABC-1: a subtask is archived only with its parent';

test('subtaskIds reads each subtask\'s id and skips anything else (#823)', () => {
  assert.deepEqual(subtaskIds(issue(1, 'To Do', { subtasks: [{ id: '10002', key: 'ABC-2' }, { key: 'ABC-3' }, 'x', null, { id: 7 }] })), ['10002']);
  assert.deepEqual(subtaskIds(issue(1, 'To Do')), []);
});

test('deleteIssue sends deleteSubtasks=true, and refuses a ref that is neither before any call (#823)', async () => {
  const fake = fakeJira({ 'DELETE /issue/10001': [undefined] });
  await deleteIssue(fake.call, '10001');
  assert.deepEqual(fake.paths, ['/issue/10001?deleteSubtasks=true']);
  const none = fakeJira();
  await assert.rejects(deleteIssue(none.call, '../x'), /id or key/);
  assert.deepEqual(none.sent, []);
});

test('archiveIssue sends the id, and a 200 that archived it resolves (#823)', async () => {
  const fake = fakeJira({ 'PUT /issue/archive': [{ numberOfIssuesUpdated: 1 }] });
  await archiveIssue(fake.call, '10001', 'ABC-1');
  assert.deepEqual([fake.sent, fake.bodies], [['PUT /issue/archive'], [{ issueIdsOrKeys: ['10001'] }]]);
});

test('archiveIssue maps the plan, admin and subtask refusals, and a 200 that archived nothing, to messages naming the key (#823)', async () => {
  const cases: [unknown, string][] = [
    [new JiraHttpError(400, ['issuesInUnlicensedProjects']), PLAN],
    [new JiraHttpError(403, []), ADMIN],
    [new JiraHttpError(400, ['issueIsSubtask']), SUBTASK],
    [{ numberOfIssuesUpdated: 0, errors: { issueIsSubtask: { count: 1, issueIdsOrKeys: ['10001'] } } }, SUBTASK],
    [{ numberOfIssuesUpdated: 0, errors: {} }, 'ABC-1: Jira archived nothing'],
  ];
  for (const [answer, message] of cases) {
    await assert.rejects(archiveIssue(fakeJira({ 'PUT /issue/archive': [answer] }).call, '10001', 'ABC-1'), { message }, message);
  }
});

test('archiveIssue rethrows any other error as it is (#823)', async () => {
  for (const other of [new JiraHttpError(400, ['somethingElse']), new JiraHttpError(500, []), new Error('jira api: invalid JSON body')]) {
    await assert.rejects(archiveIssue(fakeJira({ 'PUT /issue/archive': [other] }).call, '10001', 'ABC-1'), (err: unknown) => err === other);
  }
});

const PARENT = read(issue(1, 'To Do', { subtasks: [{ id: '10002', key: 'ABC-2' }, { id: '10003', key: 'ABC-3' }] }));
const ALL = ['10001', '10002', '10003', '10004'];
const storedIds = (db: ReadModel): string[] => db.items.items(ROWS, ALL).map((s) => s.item.nodeId);
const four = (): Promise<ReadModel> => seeded([1, 2, 3, 4].map((n) => issue(n, 'To Do')));
const TO_DONE = { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] };

test('close posts the transition to doneStatus and stores the re-read, whatever the reason (#823)', async () => {
  const db = await seeded([issue(1, 'To Do')]);
  const fake = fakeJira({
    'GET /issue/10001': [read(issue(1, 'To Do')), read(issue(1, 'Done', { updated: '2026-11-16T10:05:00.000+0000' }))],
    'GET /issue/10001/transitions': [TO_DONE],
    'POST /issue/10001/transitions': [undefined],
  });
  await adapter({ call: fake.call, db }).apply('10001', { type: 'close', reason: 'wontDo' }, '');
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'GET /issue/10001/transitions', 'POST /issue/10001/transitions', 'GET /issue/10001']);
  assert.deepEqual(fake.bodies, [{ transition: { id: '31' } }]);
  assert.equal(db.items.items(ROWS, ['10001'])[0]?.item.data.status, 'Done');
});

test('close posts nothing when the issue is in doneStatus, and rejects naming the key when no transition reaches it (#823)', async () => {
  const there = fakeJira({ 'GET /issue/10001': [read(issue(1, 'Done'))] });
  await adapter({ call: there.call }).apply('10001', { type: 'close' }, '');
  assert.deepEqual(there.sent, ['GET /issue/10001']);
  const none = fakeJira({ 'GET /issue/10001': [read(issue(1, 'To Do'))], 'GET /issue/10001/transitions': [{ transitions: [TO_DONE.transitions[0]] }] });
  await assert.rejects(adapter({ call: none.call }).apply('10001', { type: 'close' }, ''), { message: 'ABC-1: no transition to "Done"' });
  assert.equal(none.sent.includes('POST /issue/10001/transitions'), false);
});

test('delete reads the subtasks, sends deleteSubtasks=true and drops the issue\'s and its subtasks\' rows (#823)', async () => {
  const db = await four();
  const fake = fakeJira({ 'GET /issue/10001': [PARENT], 'DELETE /issue/10001': [undefined] });
  await adapter({ call: fake.call, db }).apply('10001', { type: 'delete' }, '');
  assert.deepEqual(fake.sent, ['GET /issue/10001', 'DELETE /issue/10001']);
  assert.equal(fake.paths[1], '/issue/10001?deleteSubtasks=true');
  assert.deepEqual(storedIds(db), ['10004']);
  assert.deepEqual(db.items.listing(ROWS, 'ABC'), ['10004']);
  await adapter({ call: fakeJira({ 'GET /issue/10001': [PARENT], 'DELETE /issue/10001': [undefined] }).call }).apply('10001', { type: 'delete' }, ''); // no store: nothing to drop
});

test('archive sends the id and drops the issue\'s and its subtasks\' rows (#823)', async () => {
  const db = await four();
  const fake = fakeJira({ 'GET /issue/10001': [PARENT], 'PUT /issue/archive': [{ numberOfIssuesUpdated: 1 }] });
  await adapter({ call: fake.call, db }).apply('10001', { type: 'archive' }, '');
  assert.deepEqual([fake.sent, fake.bodies], [['GET /issue/10001', 'PUT /issue/archive'], [{ issueIdsOrKeys: ['10001'] }]]);
  assert.deepEqual(storedIds(db), ['10004']);
});

test('archive rejects with the plan, admin and subtask messages and changes no row (#823)', async () => {
  for (const [err, message] of [[new JiraHttpError(400, ['issuesInUnlicensedProjects']), PLAN], [new JiraHttpError(403, []), ADMIN], [new JiraHttpError(400, ['issueIsSubtask']), SUBTASK]] as const) {
    const db = await four();
    const fake = fakeJira({ 'GET /issue/10001': [PARENT], 'PUT /issue/archive': [err] });
    await assert.rejects(adapter({ call: fake.call, db }).apply('10001', { type: 'archive' }, ''), { message }, message);
    assert.deepEqual(storedIds(db), ALL, message);
  }
});

test('with no login, delete and archive reject not connected before any call (#823)', async () => {
  for (const type of ['delete', 'archive'] as const) {
    const fake = fakeJira();
    await assert.rejects(adapter({ call: fake.call, cred: null }).apply('10001', { type }, ''), (err: unknown) => isNotConnected(err));
    assert.deepEqual(fake.sent, [], type);
  }
});

test('delete and archive of an issue Jira no longer has drop its row and write nothing (#823)', async () => {
  for (const type of ['delete', 'archive'] as const) {
    const db = await four();
    const fake = fakeJira({ 'GET /issue/10001': [new JiraNotFoundError()] });
    await adapter({ call: fake.call, db }).apply('10001', { type }, '');
    assert.deepEqual(fake.sent, ['GET /issue/10001'], type);
    assert.deepEqual(storedIds(db), ['10002', '10003', '10004'], type);
  }
});
