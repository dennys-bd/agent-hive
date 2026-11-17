import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JiraIssue } from '../../src/sources/jira-queries.js';
import { groupUnderParents } from '../../src/sources/jira-tree.js';
import type { JiraTree, SourceItem } from '../../src/types.js';
import { adapter, fakeJira, issue, read, seeded } from './jira-fakes.js';

// #830: a Jira project's tree from the parent field, by the source's two toggles and its epics keys
const EPIC = { name: 'Epic', hierarchyLevel: 1 };
const STORY = { name: 'Story', hierarchyLevel: 0 };
const SUBTASK = { name: 'Sub-task', hierarchyLevel: -1 };
const under = (n: number) => ({ id: String(10000 + n), key: `ABC-${n}` });
const DONE = { name: 'Done', statusCategory: { key: 'done' } };

// ABC-1 epic > ABC-2 story > ABC-3 subtask (To Do) and ABC-4 subtask (Done)
const tree = (): JiraIssue[] => [
  issue(1, 'To Do', { issuetype: EPIC }),
  issue(2, 'To Do', { issuetype: STORY, parent: under(1) }),
  issue(3, 'To Do', { issuetype: SUBTASK, parent: under(2) }),
  issue(4, 'Done', { issuetype: SUBTASK, parent: under(2), status: DONE }),
];
const BOTH: JiraTree = { epics: true, subtasks: true };
const links = (tasks: SourceItem[]) => tasks.map(({ item: { id, parent, children, closedChildren, epic } }) => ({ id, parent, children, closedChildren, epic }));
const listed = async (issues: JiraIssue[], source: Parameters<typeof adapter>[0]['source']) => adapter({ db: await seeded(issues), source }).listItems();

test('with both toggles on, an epic, its story and its subtasks list as three levels, a done-category child in closedChildren (#830)', async () => {
  assert.deepEqual(links(await listed(tree(), { tree: BOTH })), [
    { id: 'ABC-1', parent: undefined, children: ['10002'], closedChildren: undefined, epic: undefined },
    { id: 'ABC-2', parent: '10001', children: ['10003', '10004'], closedChildren: ['10004'], epic: undefined },
    { id: 'ABC-3', parent: '10002', children: undefined, closedChildren: undefined, epic: undefined },
  ]);
});

test('with the epic toggle off the story is a root and keeps its subtask; with the subtask toggle off the subtask is a root (#830)', async () => {
  const noEpics = links(await listed(tree(), { tree: { epics: false, subtasks: true } }));
  assert.deepEqual(noEpics.map((t) => [t.id, t.parent, t.children]), [['ABC-1', undefined, undefined], ['ABC-2', undefined, ['10003', '10004']], ['ABC-3', '10002', undefined]]);
  const noSubtasks = links(await listed(tree(), { tree: { epics: true, subtasks: false } }));
  assert.deepEqual(noSubtasks.map((t) => [t.id, t.parent, t.children]), [['ABC-1', undefined, ['10002']], ['ABC-2', '10001', undefined], ['ABC-3', undefined, undefined]]);
});

test('epics: hide drops every parent and keeps its children; show stamps each by epicFollows and switchAt, never deleting its activity (#830)', async () => {
  assert.deepEqual((await listed(tree(), { tree: BOTH, epics: 'hide' })).map((t) => t.item.id), ['ABC-3']);
  const shown = links(await listed(tree(), { tree: BOTH, epics: 'show', epicFollows: 'ahead', switchAt: 'fila' }));
  const epic = { follows: 'ahead', switchAt: 'fila', deleteActivity: false };
  assert.deepEqual(shown.map((t) => [t.id, t.epic]), [['ABC-1', epic], ['ABC-2', epic], ['ABC-3', undefined]]);
});

test('a parent outside the project, or a level above the epic, links nothing: the child is a root (#830)', async () => {
  const issues = [
    issue(1, 'To Do', { issuetype: { name: 'Initiative', hierarchyLevel: 2 } }),
    issue(2, 'To Do', { issuetype: EPIC, parent: under(1) }),
    issue(3, 'To Do', { issuetype: STORY, parent: { id: '99999', key: 'XYZ-9' } }),
  ];
  assert.deepEqual(links(await listed(issues, { tree: BOTH })).map((t) => [t.id, t.parent, t.children]), [['ABC-1', undefined, undefined], ['ABC-2', undefined, undefined], ['ABC-3', undefined, undefined]]);
});

test('children follow their parent in its column only; a child in another column keeps its place (#830)', async () => {
  const issues = [
    issue(1, 'To Do', { issuetype: EPIC }),
    issue(2, 'In Progress', { issuetype: STORY }),
    issue(3, 'To Do', { issuetype: STORY }),
    issue(4, 'To Do', { issuetype: STORY, parent: under(1) }),
    issue(5, 'In Progress', { issuetype: STORY, parent: under(1) }),
  ];
  assert.deepEqual((await listed(issues, { tree: BOTH })).map((t) => t.item.id), ['ABC-1', 'ABC-4', 'ABC-2', 'ABC-3', 'ABC-5']);
});

test('groupUnderParents places a cycle once, after the roots (#830)', () => {
  const task = (itemId: string, parent: string): SourceItem => ({ column: 'To Do', item: { itemId, id: itemId, title: itemId, body: '', url: '', parent, children: [parent] } });
  const root: SourceItem = { column: 'To Do', item: { itemId: 'r', id: 'r', title: 'r', body: '', url: '' } };
  assert.deepEqual(groupUnderParents([task('a', 'b'), root, task('b', 'a')]).map((t) => t.item.itemId), ['r', 'a', 'b']);
});

test('item() answers the re-read issue with its tree from the stored listing (#830)', async () => {
  const db = await seeded(tree());
  const reread = issue(2, 'In Progress', { issuetype: STORY, parent: under(1) });
  const answer = await adapter({ call: fakeJira({ 'GET /issue/10002': [read(reread)] }).call, db, source: { tree: BOTH } }).item('10002', '');
  assert.ok('entry' in answer);
  assert.deepEqual([answer.reason, answer.entry.column, answer.entry.item.parent, answer.entry.item.children], ['listing', 'In Progress', '10001', ['10003', '10004']]);
  const hidden = await adapter({ call: fakeJira({ 'GET /issue/10002': [read(reread)] }).call, db, source: { tree: BOTH, epics: 'hide' } }).item('10002', '');
  assert.equal(hidden.reason, 'filter', 'a parent epics: hide takes off is judged as filtered');
});
