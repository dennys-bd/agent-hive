import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueOfLink, issueUrl, taskOfIssue } from '../../src/repos/issue-task.js';
import type { Task } from '../../src/types.js';

const task = (itemId: string, url: string, origin?: string): Task => ({
  item: { itemId, id: itemId, title: 'T', body: '', url, ...(origin === undefined ? {} : { origin }) }, stage: 'dev', boardColumn: '', auto: true,
});

test('taskOfIssue: the first task in the Hive\'s order with the issue\'s url; else the one whose origin is the item the page came from; else none (#757)', () => {
  const url = issueUrl('acme/hive', 12);
  assert.equal(url, 'https://github.com/acme/hive/issues/12');
  const listed = task('roadmap:PVTI_12', url);
  const copy = task('local:1', url, 'roadmap:PVTI_12');
  const other = task('local:2', issueUrl('acme/hive', 13), 'roadmap:PVTI_99');
  assert.equal(taskOfIssue([copy, listed], url), copy);
  assert.equal(taskOfIssue([other], issueUrl('acme/hive', 99), 'roadmap:PVTI_99'), other);
  assert.equal(taskOfIssue([other], issueUrl('acme/hive', 99)), undefined);
  assert.equal(taskOfIssue([listed], issueUrl('acme/site', 12)), undefined, 'another repository\'s #12');
});

test('issueOfLink reads the repository and number off an issue link, and nothing off any other link (#758)', () => {
  assert.deepEqual(issueOfLink(issueUrl('acme/hive', 12)), { repository: 'acme/hive', number: 12 });
  for (const url of ['https://github.com/acme/hive/pull/12', 'https://github.com/acme/hive/issues/12/x', '']) assert.equal(issueOfLink(url), undefined, url);
});
