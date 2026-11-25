import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IssueDetails } from '../../src/read-model/rows.js';
import { issuePageOf, issuesOf, summaryOf } from '../../src/read-model/views.js';
import { issueRow, REF, REPO, REPO_ROW, SOURCE, SYNCED, T1, T2, tempModel } from './fixtures.js';

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

test('a GitHub ref\'s summary reads its row; a GitLab ref of the same path is the fallback with its own link and never that row (#1045, decisions 8, 9)', async (t) => {
  const db = await tempModel(t);
  db.setRepo(REPO_ROW);
  db.upsertIssue(issueRow(1, T1, { state: 'open' }), 'sync');
  db.setScope(SOURCE, REPO, 'repo', { cursor: null, etag: null, syncedAt: SYNCED });
  const github = summaryOf(db, SOURCE, REF);
  assert.deepEqual([github.host, github.url, github.openIssues, github.canPush, github.issuesEnabled, github.syncedAt], ['github.com', 'https://github.com/acme/hive', 1, true, true, SYNCED]);
  assert.deepEqual(summaryOf(db, SOURCE, { host: 'gitlab.com', repository: REPO, workspace: 'lab' }), {
    host: 'gitlab.com', repository: REPO, url: 'https://gitlab.com/acme/hive', workspace: 'lab', openPrs: 0, openIssues: 0, closedIssues: 0, canPush: false, issuesEnabled: false, syncedAt: null,
  });
  assert.equal(summaryOf(db, SOURCE, { ...REF, repository: 'acme/new' }).url, 'https://github.com/acme/new', 'a GitHub ref with no row: its host\'s link, as before');
});
