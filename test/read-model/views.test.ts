import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueDetails } from '../../src/read-model/rows.js';
import { issuePageOf, issuesOf } from '../../src/read-model/views.js';
import { issueRow, REPO, SOURCE, T1, T2, tempModel } from './fixtures.js';

// What a Project read stores beside an issue's REST columns: here only the parent matters
const DETAILS: IssueDetails = {
  url: 'https://github.com/acme/hive/issues/1', milestone: null, issueType: null, parentNumber: 7, parentTitle: 'Epic',
  subIssuesTotal: null, subIssuesCompleted: null,
};

test('the issue list and the issue page carry parent from the issues row\'s parent_number; an issue with none has no parent key (#582)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.upsertIssue(issueRow(2, T2, { state: 'open' }), 'sync');
  assert.equal(db.setIssueDetails(SOURCE, 'I_1', T1, DETAILS, 'sync'), true, 'the Project read wrote #1\'s parent');
  const { issues } = issuesOf(db, SOURCE, REPO, 'open');
  assert.deepEqual(issues.map((i) => [i.number, i.parent]), [[2, undefined], [1, 7]]);
  assert.equal('parent' in issues[0], false);
  assert.equal(issuePageOf(db, SOURCE, REPO, 1)?.parent, 7);
  const page2 = issuePageOf(db, SOURCE, REPO, 2);
  assert.ok(page2 !== undefined && !('parent' in page2));
});
