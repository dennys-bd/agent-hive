import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveIssue, deleteIssue, subtaskIds } from '../../src/sources/jira-actions.js';
import { JiraHttpError } from '../../src/sources/jira-fetch.js';
import { fakeJira, issue } from './jira-fakes.js';

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
