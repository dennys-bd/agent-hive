import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraItemOf } from '../../src/sources/jira-item.js';
import { jiraProjectItem } from '../../src/sources/jira-project-item.js';
import type { JiraIssue } from '../../src/sources/jira-queries.js';
import { PROJECT_KEYS, treeRows } from '../../src/ui/lib/project-tree.js';
import { JIRA_ENTRY } from '../fakes.js';

const ROWS = 'jira:acme.example:acc-1';
const NAMES = { components: 'Components', customfield_10001: 'Team', customfield_10002: 'Points' };
const SCHEMA = { components: { type: 'array', items: 'component' }, customfield_10001: { type: 'option' }, customfield_10002: { type: 'number' } };
const issue = (fields: Record<string, unknown> = {}): JiraIssue => ({
  id: '10001', key: 'ABC-1',
  fields: {
    summary: 'Ship it', updated: '2026-11-16T10:00:00.000+0000', created: '2026-11-01T10:00:00.000+0000',
    status: { name: 'To Do', statusCategory: { key: 'new' } }, project: { key: 'ABC' }, assignee: { displayName: 'Ana Lima' }, labels: ['api'],
    components: [{ name: 'Core' }, { name: 'Web' }], customfield_10001: { value: 'Platform' }, customfield_10002: 5, ...fields,
  },
});
const rows = (fields: Record<string, unknown> = {}) => jiraItemOf(ROWS, 'ABC', issue(fields), NAMES, SCHEMA);

test('a stored issue is its project row: the key as id, the browse url, its status, a multi-valued field joined and a number as a number (#826)', () => {
  assert.deepEqual(jiraProjectItem(rows(), JIRA_ENTRY, false), {
    itemId: '10001', id: 'ABC-1', title: 'Ship it', body: '', url: 'https://acme.example/browse/ABC-1', status: 'To Do',
    labels: ['api'], assignees: ['Ana Lima'], fields: { Components: 'Core, Web', Team: 'Platform', Points: 5 }, pullRequests: [],
    createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-16T10:00:00.000Z',
  });
});

test('a row the filter drops is out as filter; one with no status has none (#826)', () => {
  assert.equal(jiraProjectItem(rows(), JIRA_ENTRY, true).out, 'filter');
  assert.equal('status' in jiraProjectItem(rows({ status: null }), JIRA_ENTRY, false), false);
});

test('a sub-task\'s row names its parent by key, and the tree nests it (#826)', () => {
  const child = jiraProjectItem(rows({ parent: { id: '10000', key: 'ABC-0', fields: { summary: 'Epic' } } }), JIRA_ENTRY, false);
  assert.equal(child.parent, 'ABC-0');
  const parent = { ...jiraProjectItem(rows(), JIRA_ENTRY, false), itemId: '10000', id: 'ABC-0' };
  assert.deepEqual(treeRows([parent, child], new Set(['10000']), PROJECT_KEYS).map((l) => [l.item.id, l.depth]), [['ABC-0', 0], ['ABC-1', 1]]);
});
