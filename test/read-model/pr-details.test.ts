import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReadModel, READ_MODEL_FILE, type ReadModel } from '../../src/read-model/db.js';
import {
  awaitingFromRest, checkItemsFromRest, pullFromGql, pullPageFromRest, pullsFromGql, repoFromRest, reviewFromGql, reviewsFromRest, WireError,
} from '../../src/read-model/normalize.js';
import type { CheckRow, PrPage, PullPage, ReviewRow } from '../../src/read-model/rows.js';
import { awaitingPath, batchQuery, checkPath, pollOne, reviewsPath, syncPulls } from '../../src/read-model/pulls.js';
import { MIGRATIONS } from '../../src/read-model/schema.js';
import { EMPTY_REPORT } from '../../src/read-model/sync.js';
import type { Gql } from '../../src/types.js';
import { approvalsOf, prDataOf } from '../../src/read-model/views.js';
import { tempDir } from '../temp-dir.js';
import { commentRow, github, GQL_PR, GQL_REVIEW, HEAD, issueRow, NO_REST, pagesAt, REF, RUN_OK, roundDeps, tempModel, OTHER_SOURCE, prIssueRow, pullKey, REPO, REPO_ROW, REST_REPO, restPull, restReview, SOURCE, T1, T2, T3 } from './fixtures.js';

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

const WINDOW_MS = 30_000; // #178's written_at window
const CLOSES = [{ repository: REPO, number: 12, url: 'https://github.com/acme/hive/issues/12' }];
const page = (extra: Partial<PullPage> = {}): PullPage => ({
  headRef: 'feature', baseRef: 'main', headOwner: 'caio', baseOwner: 'acme', commits: 2, additions: 10, deletions: 3, requested: [{ reviewer: 'bia', team: false }], ...extra,
});
const check = (name: string, state: CheckRow['state'] = 'success'): CheckRow => ({ name, state, url: null, startedAt: null, at: T1 });
const review = (id: string, author: string | null, state: ReviewRow['state'], submittedAt = T1, body = ''): ReviewRow =>
  ({ source: SOURCE, nodeId: id, pullNodeId: 'PR_7', repository: REPO, author, state, body, submittedAt });

test('the page writers set only their own columns and write only on a change; prPage reads the PR row, its pulls row, reviews, comments, checks and repos row (#187)', async () => {
  const db = await memory();
  db.setRepo(REPO_ROW);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.upsertComment(commentRow('IC_1', 'PR_7'), 'sync');
  assert.deepEqual([db.setPullPage(pullKey(7), page()), db.setPullPage(pullKey(7), page())], [true, false]);
  assert.deepEqual([db.setPullCloses(pullKey(7), CLOSES), db.setPullCloses(pullKey(7), CLOSES)], [true, false]);
  assert.deepEqual([db.setPullAwaiting(pullKey(7), ['CI']), db.setPullAwaiting(pullKey(7), ['CI'])], [true, false]);
  db.setPullFlags({ ...pullKey(7), draft: true, mergedAt: null });
  db.upsertReview(review('R2', 'caio', 'APPROVED', T2), 'sync');
  db.upsertReview(review('R1', 'bia', 'COMMENTED', T1), 'sync');
  db.setPullChecks(pullKey(7), [check('test'), check('lint', 'failure')]);
  const found = db.prPage(SOURCE, REPO, 7);
  assert.deepEqual(found?.issue, prIssueRow(7, T1));
  assert.deepEqual([found?.pull?.draft, found?.pull?.headOwner, found?.pull?.requested, found?.pull?.closes, found?.pull?.awaiting], [true, 'caio', [{ reviewer: 'bia', team: false }], CLOSES, ['CI']]);
  assert.deepEqual(found?.reviews.map((r) => r.nodeId), ['R1', 'R2'], 'oldest first');
  assert.deepEqual([found?.comments.map((c) => c.nodeId), found?.checks.map((c) => c.name), found?.repo], [['IC_1'], ['test', 'lint'], REPO_ROW]);
});

test('prPage answers none for an issue or a missing number, and no pulls row for a PR never polled; pullAt finds a PR open or not (#187)', async () => {
  const db = await memory();
  db.upsertIssue(issueRow(1, T1), 'sync');
  db.upsertIssue(prIssueRow(5, T1, { state: 'closed', closedAt: T1 }), 'sync');
  assert.deepEqual([db.prPage(SOURCE, REPO, 1), db.prPage(SOURCE, REPO, 9), db.prPage(SOURCE, REPO, 5)?.pull], [undefined, undefined, undefined]);
  assert.deepEqual(db.pullAt(SOURCE, REPO, 5), { nodeId: 'PR_5', number: 5, headSha: null, mergeState: 'unknown' });
  assert.deepEqual([db.pullAt(SOURCE, REPO, 1), db.pullAt(OTHER_SOURCE, REPO, 5)], [undefined, undefined]);
});

test('setPullChecks replaces the set whole and writes nothing for an identical one; removeIssue takes the PR\'s reviews and checks (#187)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  assert.deepEqual([db.setPullChecks(pullKey(7), [check('test'), check('lint')]), db.setPullChecks(pullKey(7), [check('test'), check('lint')])], [true, false]);
  assert.equal(db.setPullChecks(pullKey(7), [check('e2e', 'pending')]), true);
  assert.deepEqual(db.prPage(SOURCE, REPO, 7)?.checks, [check('e2e', 'pending')]);
  db.upsertReview(review('R1', 'caio', 'APPROVED'), 'sync');
  db.removeIssue(SOURCE, 'PR_7');
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  assert.deepEqual([db.prPage(SOURCE, REPO, 7)?.checks, db.prPage(SOURCE, REPO, 7)?.reviews], [[], []]);
});

test('a review keeps #178\'s replace rule: a sync read before a write does not undo it inside the window; past it the sync wins (#187)', async () => {
  const clock = { now: 1_000 };
  const { db } = await openReadModel(':memory:', { now: () => clock.now });
  assert.equal(db.upsertReview(review('R1', 'caio', 'APPROVED', T1, 'written'), 'write'), true);
  clock.now += WINDOW_MS - 1;
  assert.equal(db.upsertReview(review('R1', 'caio', 'APPROVED', T1, 'stale'), 'sync'), false);
  clock.now += 1;
  assert.equal(db.upsertReview(review('R1', 'caio', 'APPROVED', T1, 'edited'), 'sync'), true, 'past the window the sync is the truth again');
});

const OTHER_HEAD = 'b'.repeat(40);

test('the poll stores the page, the reviews (no PENDING) and the check items; awaiting is not read with no suite awaiting; a quiet round writes nothing (#187)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullRead(pullKey(7), { decision: null, readAt: T1 }); // read already: no batch
  const pages = { ...pagesAt(HEAD), [reviewsPath(REPO, 7)]: { body: [restReview('R1', 'caio', 'APPROVED'), restReview('R2', 'bia', 'PENDING', null)], etag: 'EV' } };
  const first = github(pages);
  assert.deepEqual((await syncPulls(roundDeps(db, first.rest), REF)).report.kinds, ['pulls']);
  const found = db.prPage(SOURCE, REPO, 7);
  assert.deepEqual([found?.pull?.headRef, found?.pull?.baseOwner, found?.reviews.map((r) => r.nodeId), found?.checks.map((c) => [c.name, c.state])], ['feature', 'acme', ['R1'], [['test', 'success']]]);
  assert.ok(first.calls.every(([path]) => !path.includes('actions/runs')), 'no suite awaits: no actions read');
  assert.deepEqual((await syncPulls(roundDeps(db, github(pages).rest), REF)).report, { kinds: [], requests: { 200: 0, 304: 5 } });
});

test('a moved head replaces the check items whole: the old head\'s rows are gone (#187)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullRead(pullKey(7), { decision: null, readAt: T1 });
  const two = { body: { total_count: 2, check_runs: [RUN_OK, { name: 'lint', status: 'completed', conclusion: 'failure' }] }, etag: 'ER2' };
  await syncPulls(roundDeps(db, github(pagesAt(HEAD, two)).rest), REF);
  assert.deepEqual(db.prPage(SOURCE, REPO, 7)?.checks.map((c) => c.name), ['test', 'lint']);
  await syncPulls(roundDeps(db, github(pagesAt(OTHER_HEAD)).rest), REF);
  assert.deepEqual(db.prPage(SOURCE, REPO, 7)?.checks.map((c) => c.name), ['test']);
});

test('a suite awaiting approval reads the workflow names from actions/runs and stores them; a later 200 with none awaiting clears them (#187)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullRead(pullKey(7), { decision: null, readAt: T1 });
  const suites = { body: { total_count: 1, check_suites: [{ conclusion: 'action_required', app: { slug: 'github-actions' } }] }, etag: 'EU2' };
  const pages = { ...pagesAt(HEAD), [checkPath(REPO, HEAD, 'suites')]: suites, [awaitingPath(REPO, HEAD)]: { body: { total_count: 1, workflow_runs: [{ name: 'CI' }] }, etag: 'EA' } };
  await syncPulls(roundDeps(db, github(pages).rest), REF);
  assert.deepEqual(db.prPage(SOURCE, REPO, 7)?.pull?.awaiting, ['CI']);
  await syncPulls(roundDeps(db, github(pagesAt(HEAD)).rest), REF);
  assert.deepEqual(db.prPage(SOURCE, REPO, 7)?.pull?.awaiting, []);
});

test('pollOne polls one PR open or not, for its page\'s refetch; an issue number makes no request (#187)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(5, T1, { state: 'closed', closedAt: T1 }), 'sync');
  db.upsertIssue(issueRow(1, T1), 'sync');
  assert.deepEqual((await pollOne(roundDeps(db, github(pagesAt(HEAD, undefined, 5)).rest), REPO, 5)).kinds, ['pulls']);
  assert.equal(db.prPage(SOURCE, REPO, 5)?.pull?.headSha, HEAD);
  assert.deepEqual(await pollOne(roundDeps(db, NO_REST), REPO, 1), EMPTY_REPORT);
});

test('the batch asks and stores the issues each PR closes (#187)', async (t) => {
  const db = await tempModel(t);
  db.upsertIssue(prIssueRow(5, T1, { state: 'closed', closedAt: T1 }), 'sync');
  const closes = { nodes: [{ number: 12, url: 'https://github.com/acme/hive/issues/12', repository: { nameWithOwner: 'acme/hive' } }] };
  const gql: Gql = async () => ({ p0: { id: 'PR_5', reviewDecision: null, mergeStateStatus: 'UNKNOWN', headCommit: { nodes: [] }, closingIssuesReferences: closes } });
  await syncPulls(roundDeps(db, NO_REST, gql), REF);
  assert.deepEqual(db.prPage(SOURCE, REPO, 5)?.pull?.closes, CLOSES);
  assert.match(batchQuery(1), /closingIssuesReferences\(first: 10\) \{ nodes \{ number url repository \{ nameWithOwner \} \} \}/);
});

const AT = '2026-09-30T10:00:00Z';

test('prDataOf builds the page\'s PrData from the model as #758\'s page fixture had it, files, threads and the on-open values aside (#187)', async () => {
  const db = await memory();
  const key = { ...pullKey(7), nodeId: 'PR_1' };
  db.setRepo(REPO_ROW);
  db.upsertIssue(prIssueRow(7, AT, { nodeId: 'PR_1', title: 'The PR', body: 'The description', createdAt: AT }), 'sync');
  db.setPullPoll(key, { headSha: HEAD, mergeState: 'clean', checks: 'success' });
  db.setPullRead(key, { decision: 'approved', readAt: AT });
  db.setPullPage(key, { headRef: 'feature', baseRef: 'main', headOwner: 'bia', baseOwner: 'acme', commits: 2, additions: 10, deletions: 3, requested: [] });
  db.setPullChecks(key, [{ name: 'test', state: 'success', url: null, startedAt: null, at: AT }]);
  db.upsertReview({ source: SOURCE, nodeId: 'R1', pullNodeId: 'PR_1', repository: REPO, author: 'caio', state: 'APPROVED', body: 'ship it', submittedAt: AT }, 'sync');
  db.upsertComment({ ...commentRow('IC1', 'PR_1', AT), author: null, body: 'thanks' }, 'sync');
  const found = db.prPage(SOURCE, REPO, 7);
  assert.ok(found);
  assert.deepEqual(prDataOf(found, 'ana'), {
    url: 'https://github.com/acme/hive/pull/7', id: 'PR_1', number: 7, title: 'The PR', state: 'open', isDraft: false, mergeState: 'clean', head: HEAD,
    methods: ['merge', 'squash'], viewer: 'ana', body: 'The description', author: 'bia', createdAt: AT, updatedAt: AT, headRef: 'feature', baseRef: 'main',
    commits: 2, additions: 10, deletions: 3, decision: 'approved', approvals: 1, canEdit: true, canPush: true, headOwner: 'bia', baseOwner: 'acme',
    checks: { state: 'success', at: AT, items: [{ name: 'test', state: 'success', at: AT }] },
    reviews: [{ id: 'R1', author: 'caio', at: AT, kind: 'approved', text: 'ship it' }], comments: [{ id: 'IC1', author: 'ghost', at: AT, text: 'thanks' }],
    reviewRequests: [], closes: [],
  });
});

test('approvals follow each reviewer\'s latest opinion; a dismissed review is no event; with no pulls row the defaults, and the author edits, compared without case (#187)', () => {
  const r = (id: string, author: string, state: ReviewRow['state'], at: string): ReviewRow => ({ source: SOURCE, nodeId: id, pullNodeId: 'PR_7', repository: REPO, author, state, body: '', submittedAt: at });
  const reviews = [
    r('R1', 'caio', 'APPROVED', T1), r('R2', 'caio', 'CHANGES_REQUESTED', T2), r('R3', 'dana', 'APPROVED', T1), r('R4', 'dana', 'COMMENTED', T2),
    r('R5', 'erin', 'APPROVED', T1), r('R6', 'erin', 'DISMISSED', T2),
  ];
  assert.equal(approvalsOf(reviews), 1, 'dana alone: a comment is no opinion');
  const bare: PrPage = { issue: prIssueRow(7, T1), pull: undefined, reviews, comments: [], checks: [], repo: undefined };
  const data = prDataOf(bare, 'Bia');
  assert.deepEqual(data.reviews.map((e) => [e.id, e.kind]), [['R1', 'approved'], ['R2', 'changes'], ['R3', 'approved'], ['R4', 'commented'], ['R5', 'approved']]);
  assert.deepEqual([data.canEdit, data.canPush, data.methods, data.head, data.mergeState, 'checks' in data], [true, false, [], '', 'unknown', false]);
});

test('workflows awaiting alone make a pending box with no item; a user request naming the login is the viewer\'s, a team request never (#187)', async () => {
  const db = await memory();
  db.upsertIssue(prIssueRow(7, T1), 'sync');
  db.setPullAwaiting(pullKey(7), ['CI']);
  db.setPullPage(pullKey(7), page({ requested: [{ reviewer: 'ana', team: false }, { reviewer: 'core', team: true }] }));
  const found = db.prPage(SOURCE, REPO, 7);
  assert.ok(found);
  const data = prDataOf(found, 'ANA');
  assert.deepEqual(data.checks, { state: 'pending', items: [], awaiting: ['CI'] });
  assert.deepEqual(data.reviewRequests, [{ reviewer: 'ana', team: false, viewer: true }, { reviewer: 'core', team: true, viewer: false }]);
});
