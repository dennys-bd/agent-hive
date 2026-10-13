import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import {
  awaitingFromRest, checkItemsFromRest, pullFromGql, pullPageFromRest, pullsFromGql, repoFromRest, reviewFromGql, reviewsFromRest, WireError,
} from '../../src/read-model/normalize.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { tempDir } from '../temp-dir.js';
import { GQL_PR, GQL_REVIEW, HEAD, prIssueRow, pullKey, REPO, REPO_ROW, REST_REPO, restPull, restReview, SOURCE, T1, T2, T3 } from './fixtures.js';

const memory = async (): Promise<ReadModel> => (await openReadModel(':memory:')).db;

test('migration 4 on a version-3 file adds the review and check tables, the page columns and methods, and refills the PR scopes, read_at and the repo ETag (#187)', async (t) => {
  const path = join(await tempDir(t, 'read-model-'), READ_MODEL_FILE);
  // by hand: the model prepares the new statements at open, so one opened at version 3 could not
  const raw = new DatabaseSync(path);
  raw.exec(`${MIGRATIONS.slice(0, 3).join(' ')} PRAGMA user_version = 3;`);
  const scope = raw.prepare('INSERT INTO sync_scopes (source, repository, kind, cursor, etag, synced_at) VALUES (?, ?, ?, ?, ?, ?)');
  scope.run(SOURCE, REPO, 'pull/7/runs', 'success', 'ER', T2);
  scope.run(SOURCE, REPO, 'repo', null, 'ERP', T2);
  scope.run(SOURCE, REPO, 'issues', T1, 'EI', T2);
  raw.prepare('INSERT INTO pulls (source, node_id, repository, number, read_at) VALUES (?, ?, ?, ?, ?)').run(SOURCE, 'PR_7', REPO, 7, T1);
  raw.close();
  const { db, resync } = await openReadModel(path);
  assert.equal(resync, false);
  assert.deepEqual(db.scope(SOURCE, REPO, 'pull/7/runs'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'repo'), { cursor: null, etag: null, syncedAt: T2 });
  assert.deepEqual(db.scope(SOURCE, REPO, 'issues'), { cursor: T1, etag: 'EI', syncedAt: T2 }, 'the issues scopes keep their place');
  db.close();
  const after = new DatabaseSync(path);
  t.after(() => after.close());
  const pull = after.prepare('SELECT read_at, head_ref, head_owner, commits, requested, closes, awaiting FROM pulls').get();
  assert.deepEqual({ ...pull }, { read_at: null, head_ref: '', head_owner: '', commits: 0, requested: '[]', closes: '[]', awaiting: '[]' });
  const tables = after.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pull\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, ['pull_checks', 'pull_reviews']);
});

test('the repos row carries the merge methods the repository allows; a flag GitHub answers null or omits is not allowed (#187)', async () => {
  const db = await memory();
  assert.deepEqual(repoFromRest(SOURCE, REPO, REST_REPO).methods, ['merge', 'squash']);
  assert.deepEqual(repoFromRest(SOURCE, REPO, { ...REST_REPO, allow_merge_commit: null, allow_rebase_merge: true }).methods, ['squash', 'rebase']);
  const { allow_merge_commit: _merge, allow_squash_merge: _squash, allow_rebase_merge: _rebase, ...bare } = REST_REPO;
  assert.deepEqual(repoFromRest(SOURCE, REPO, bare).methods, []);
  assert.deepEqual([db.setRepo(REPO_ROW), db.setRepo(REPO_ROW), db.setRepo({ ...REPO_ROW, methods: ['rebase'] })], [true, false, true]);
  assert.deepEqual(db.repo(SOURCE, REPO)?.methods, ['rebase']);
});

test('pullPageFromRest reads the branches, both owners, the counts and the requested reviewers and teams; a deleted fork is no head owner (#187)', () => {
  const pull = restPull(7, HEAD, { head: { sha: HEAD, ref: 'feature', repo: { owner: { login: 'caio' } } }, commits: 3, additions: 10, deletions: 2,
    requested_reviewers: [{ login: 'bia' }], requested_teams: [{ slug: 'core' }] });
  assert.deepEqual(pullPageFromRest(pull), {
    headRef: 'feature', baseRef: 'main', headOwner: 'caio', baseOwner: 'acme', commits: 3, additions: 10, deletions: 2,
    requested: [{ reviewer: 'bia', team: false }, { reviewer: 'core', team: true }],
  });
  assert.equal(pullPageFromRest(restPull(7, HEAD, { head: { sha: HEAD, ref: 'feature', repo: null } })).headOwner, '');
  assert.throws(() => pullPageFromRest(restPull(7, HEAD, { commits: -1 })), WireError);
});

test('reviewsFromRest reads each submitted review under its PR across pages and skips a pending one; a deleted reviewer has none (#187)', () => {
  const rows = reviewsFromRest(SOURCE, REPO, 'PR_7', [[restReview('R1', 'caio', 'APPROVED'), restReview('R2', 'bia', 'PENDING', null)], [restReview('R3', null, 'COMMENTED', T2)]]);
  assert.deepEqual(rows, [
    { source: SOURCE, nodeId: 'R1', pullNodeId: 'PR_7', repository: REPO, author: 'caio', state: 'APPROVED', body: 'body R1', submittedAt: T1 },
    { source: SOURCE, nodeId: 'R3', pullNodeId: 'PR_7', repository: REPO, author: null, state: 'COMMENTED', body: 'body R3', submittedAt: T2 },
  ]);
  assert.throws(() => reviewsFromRest(SOURCE, REPO, 'PR_7', [{}]), WireError);
});

test('checkItemsFromRest lists the check runs then the status contexts as the page read them: a run not completed is pending, a pending context starts at its creation (#187)', () => {
  const runs = [{ total_count: 2, check_runs: [
    { name: 'test', status: 'completed', conclusion: 'success', details_url: 'https://ci.example/1', started_at: T1, completed_at: T2 },
    { name: 'lint', status: 'in_progress', conclusion: null, details_url: '', started_at: T1, completed_at: null },
  ] }];
  const status = [{ state: 'pending', statuses: [
    { context: 'deploy', state: 'pending', target_url: null, created_at: T3 }, { context: 'sign', state: 'error', target_url: 'https://ci.example/2', created_at: T2 },
  ] }];
  assert.deepEqual(checkItemsFromRest(runs, status), [
    { name: 'test', state: 'success', url: 'https://ci.example/1', startedAt: T1, at: T2 },
    { name: 'lint', state: 'pending', url: null, startedAt: T1, at: null },
    { name: 'deploy', state: 'pending', url: null, startedAt: T3, at: T3 },
    { name: 'sign', state: 'failure', url: 'https://ci.example/2', startedAt: null, at: T2 },
  ]);
});

test('awaitingFromRest names each workflow awaiting approval once (#187)', () => {
  assert.deepEqual(awaitingFromRest([{ total_count: 3, workflow_runs: [{ name: 'CI' }, { name: 'CI' }, { name: 'Lint' }] }]), ['CI', 'Lint']);
  assert.throws(() => awaitingFromRest([{}]), WireError);
});

test('pullFromGql reads a PR\'s issues row (MERGED is closed) and its flags; reviewFromGql reads a review, none while pending (#187)', () => {
  assert.deepEqual(pullFromGql(SOURCE, REPO, GQL_PR), {
    issue: prIssueRow(7, T2, { state: 'closed', closedAt: T2 }), flags: { ...pullKey(7), draft: false, mergedAt: T2 },
  });
  assert.equal(pullFromGql(SOURCE, REPO, { ...GQL_PR, state: 'OPEN', closedAt: null, mergedAt: null }).issue.state, 'open');
  assert.throws(() => pullFromGql(SOURCE, REPO, { ...GQL_PR, state: 'DRAFT' }), WireError);
  assert.deepEqual(reviewFromGql(SOURCE, REPO, 'PR_7', GQL_REVIEW), {
    source: SOURCE, nodeId: 'PRR_1', pullNodeId: 'PR_7', repository: REPO, author: 'caio', state: 'APPROVED', body: 'ship it', submittedAt: T2,
  });
  assert.equal(reviewFromGql(SOURCE, REPO, 'PR_7', { ...GQL_REVIEW, state: 'PENDING', submittedAt: null }), undefined);
});

test('pullsFromGql reads the issues each PR closes, dropping a node the page could not open (#187)', () => {
  const closes = { nodes: [{ number: 12, url: 'https://github.com/acme/hive/issues/12', repository: { nameWithOwner: 'acme/hive' } }, { number: '9' }, null] };
  const [read] = pullsFromGql({ p0: { id: 'PR_7', reviewDecision: null, mergeStateStatus: 'CLEAN', headCommit: { nodes: [] }, closingIssuesReferences: closes } });
  assert.deepEqual(read?.closes, [{ repository: 'acme/hive', number: 12, url: 'https://github.com/acme/hive/issues/12' }]);
});
