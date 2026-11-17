import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraItemOf } from '../../src/sources/jira-item.js';
import { isListed, issueReader, projectOf, taskOf } from '../../src/sources/jira-listing.js';
import type { JiraIssue } from '../../src/sources/jira-queries.js';
import type { FilterRule } from '../../src/types.js';
import { JIRA_ENTRY } from '../fakes.js';

const ROWS = 'jira:acme.example:acc-1';
const NAMES = { components: 'Components', customfield_10001: 'Team' };
const SCHEMA = { components: { type: 'array', items: 'component' }, customfield_10001: { type: 'option' } };
const issue = (fields: Record<string, unknown> = {}): JiraIssue => ({
  id: '10001', key: 'ABC-1',
  fields: {
    summary: 'Ship it', updated: '2026-11-16T10:00:00.000+0000', created: '2026-11-01T10:00:00.000+0000',
    status: { name: 'To Do', statusCategory: { key: 'new' } }, project: { key: 'ABC' }, assignee: { displayName: 'Ana Lima' }, labels: ['api'],
    components: [{ name: 'Core' }, { name: 'Web' }], customfield_10001: { value: 'Platform' }, ...fields,
  },
});
const rows = (fields: Record<string, unknown> = {}) => jiraItemOf(ROWS, 'ABC', issue(fields), NAMES, SCHEMA);

test('a stored issue is its task: the id as itemId, the key as id, the browse url, its facets, and its status as the column (#820)', () => {
  assert.deepEqual(taskOf(rows(), JIRA_ENTRY), {
    column: 'To Do',
    item: {
      itemId: '10001', id: 'ABC-1', title: 'Ship it', body: '', url: 'https://acme.example/browse/ABC-1', createdAt: '2026-11-01T10:00:00.000Z',
      facets: { assignees: ['Ana Lima'], labels: ['api'], fields: { Components: 'Core, Web', Team: 'Platform' } },
      autoOnEntry: true, entry: { flow: 'main' },
    },
  });
});

test('the task properties come from the first matching rule per property, else the defaults (#820)', () => {
  const taskProps = { ...JIRA_ENTRY.taskProps, rules: [
    { field: 'Components', op: 'equals' as const, value: 'Web', set: { workspace: 'site', auto: false } },
    { field: 'assignee', op: 'equals' as const, value: 'Ana Lima', set: { entry: null } },
  ] };
  const { item } = taskOf(rows(), { ...JIRA_ENTRY, taskProps });
  assert.deepEqual([item.workspaceHint, item.autoOnEntry, item.entry], ['site', false, null]);
});

test('the reader reads the title, each label, the assignee\'s name and any stored field by name (#820)', () => {
  const read = issueReader(rows());
  assert.deepEqual(['title', 'labels', 'assignee', 'Components', 'Team', 'Nope'].map(read), [['Ship it'], ['api'], ['Ana Lima'], ['Core', 'Web'], ['Platform'], []]);
});

test('isListed needs a cited column and the filter, @me as the stored name (#820)', () => {
  const task = taskOf(rows(), JIRA_ENTRY);
  const mine: FilterRule[] = [{ field: 'assignee', op: 'any', values: ['@me'] }];
  assert.equal(isListed(task, { filter: [] }, new Set(['To Do']), undefined), true);
  assert.equal(isListed(task, { filter: [] }, new Set(['Done']), undefined), false);
  assert.equal(isListed(task, { filter: mine }, new Set(['To Do']), 'Ana Lima'), true);
  assert.equal(isListed(task, { filter: mine }, new Set(['To Do']), undefined), false, 'an unresolved @me never widens the filter');
});

test('projectOf reads the issue\'s project key, undefined when there is none (#820)', () => {
  assert.equal(projectOf(issue()), 'ABC');
  assert.equal(projectOf(issue({ project: undefined })), undefined);
});
