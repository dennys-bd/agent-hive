import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncRepository } from '../../src/read-model/loop.js';
import { WireError } from '../../src/read-model/normalize.js';
import { assigneesPath, issueTypesPath, labelsPath, milestonesPath, repoPath, syncAssignees, syncIssueTypes, syncLabels, syncMilestones, syncRepo } from '../../src/read-model/repo-scopes.js';
import type { RestGet } from '../../src/read-model/rest.js';
import { scopePath } from '../../src/read-model/sync.js';
import { fakeRest, NO_GQL, NOW, ok, REF, REPO, REPO_ROW, REPO_SCOPE_PATHS, REST_REPO, restIssue, restLabel, SOURCE, SYNCED, T1, tempModel } from './fixtures.js';

const LATER = (): Date => new Date('2026-10-12T13:00:00Z');

test('a first round stores the repos row and every label across pages; a second with the ETags costs one 304 per scope and writes nothing (#181)', async (t) => {
  const db = await tempModel(t);
  const page2 = 'repositories/1/labels?per_page=100&page=2';
  const first = fakeRest([ok(REST_REPO, { etag: 'ER' }), ok([restLabel('bug')], { etag: 'EL', next: page2 }), ok([restLabel('wontfix')])]);
  const deps = { db, rest: first.rest, source: SOURCE, now: NOW };
  assert.deepEqual(await syncRepo(deps, REPO), { kinds: ['repo'], requests: { 200: 1, 304: 0 } });
  assert.deepEqual(await syncLabels(deps, REPO), { kinds: ['labels'], requests: { 200: 2, 304: 0 } });
  assert.deepEqual(first.calls, [[repoPath(REPO), undefined], [labelsPath(REPO), undefined], [page2, undefined]]);
  assert.deepEqual([db.repo(SOURCE, REPO), db.labels(SOURCE, REPO)], [REPO_ROW, ['bug', 'wontfix']]);
  assert.deepEqual(db.scope(SOURCE, REPO, 'labels'), { cursor: null, etag: 'EL', syncedAt: SYNCED });
  const second = fakeRest([{ status: 304 }, { status: 304 }]);
  const again = { ...deps, rest: second.rest, now: LATER };
  assert.deepEqual(await syncRepo(again, REPO), { kinds: [], requests: { 200: 0, 304: 1 } });
  assert.deepEqual(await syncLabels(again, REPO), { kinds: [], requests: { 200: 0, 304: 1 } });
  assert.deepEqual(second.calls.map(([, etag]) => etag), ['ER', 'EL']);
  assert.deepEqual(db.scope(SOURCE, REPO, 'repo'), { cursor: null, etag: 'ER', syncedAt: LATER().toISOString() }, 'a 304 is a complete round');
});

test('a 200 whose labels lost one removes it; a repository answered without permissions cannot push, and a fork names its parent (#181)', async (t) => {
  const db = await tempModel(t);
  db.setLabels(SOURCE, REPO, ['bug', 'wontfix']);
  const { permissions: _permissions, ...anonymous } = REST_REPO;
  const { rest } = fakeRest([ok({ ...anonymous, fork: true, parent: { full_name: 'up/hive' } }), ok([restLabel('bug')])]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  await syncRepo(deps, REPO);
  assert.deepEqual(await syncLabels(deps, REPO), { kinds: ['labels'], requests: { 200: 1, 304: 0 } });
  assert.deepEqual([db.repo(SOURCE, REPO), db.labels(SOURCE, REPO)], [{ ...REPO_ROW, canPush: false, forkParent: 'up/hive' }, ['bug']]);
});

test('a malformed answer throws and leaves the stored row and its ETag as they were (#181)', async (t) => {
  const db = await tempModel(t);
  db.setRepo(REPO_ROW);
  db.setLabels(SOURCE, REPO, ['bug']);
  for (const kind of ['repo', 'labels'] as const) db.setScope(SOURCE, REPO, kind, { cursor: null, etag: `E-${kind}`, syncedAt: T1 });
  const { rest } = fakeRest([ok({ ...REST_REPO, has_issues: 'yes' }, { etag: 'E2' }), ok([{ id: 9 }], { etag: 'E3' })]);
  const deps = { db, rest, source: SOURCE, now: NOW };
  await assert.rejects(syncRepo(deps, REPO), WireError);
  await assert.rejects(syncLabels(deps, REPO), WireError);
  assert.deepEqual([db.repo(SOURCE, REPO), db.labels(SOURCE, REPO)], [REPO_ROW, ['bug']]);
  assert.deepEqual([db.scope(SOURCE, REPO, 'repo'), db.scope(SOURCE, REPO, 'labels')], [
    { cursor: null, etag: 'E-repo', syncedAt: T1 }, { cursor: null, etag: 'E-labels', syncedAt: T1 },
  ]);
});

test('syncRepository runs the repo and labels scopes before issues; the round names them only when they changed (#181)', async (t) => {
  const db = await tempModel(t);
  const { rest, calls } = fakeRest([ok(REST_REPO, { etag: 'ER' }), ok([restLabel('bug')], { etag: 'EL' }), ok([]), ok([]), ok([]), ok([restIssue(1, T1)]), ok([])]);
  const first = await syncRepository({ db, rest, gql: NO_GQL, source: SOURCE, now: NOW }, REF);
  assert.deepEqual(calls.map(([path]) => path), [...REPO_SCOPE_PATHS, scopePath(REPO, 'issues', null), scopePath(REPO, 'comments', null)]);
  assert.deepEqual(first.report.kinds, ['issues', 'repo', 'labels']);
  const quiet = fakeRest([ok(REST_REPO), ok([restLabel('bug')]), ok([]), ok([]), ok([]), { status: 304 }, { status: 304 }]);
  const second = await syncRepository({ db, rest: quiet.rest, gql: NO_GQL, source: SOURCE, now: NOW }, REF);
  assert.deepEqual(second.report, { kinds: [], requests: { 200: 5, 304: 2 } }, 'an identical 200 names no kind');
});

test('a round whose repo, labels and issues scopes all fail reports every failure, so none is missing from the log (#181)', async (t) => {
  const db = await tempModel(t);
  const rest: RestGet = async (path) => {
    if (path === repoPath(REPO)) throw new Error('repo HTTP 403');
    if (path === labelsPath(REPO)) throw new Error('labels HTTP 502');
    throw new Error('issues HTTP 500');
  };
  const { error } = await syncRepository({ db, rest, gql: NO_GQL, source: SOURCE, now: NOW }, REF);
  for (const failure of ['repo HTTP 403', 'labels HTTP 502', 'issues HTTP 500']) assert.match(String(error), new RegExp(failure));
});

test('a stop after a failed repo scope still reports that failure; the stop itself is none (#181)', async (t) => {
  const db = await tempModel(t);
  const calls: string[] = [];
  const rest: RestGet = async (path) => {
    calls.push(path);
    if (path === repoPath(REPO)) throw new Error('repo HTTP 403');
    return ok([]);
  };
  const { error } = await syncRepository({ db, rest, gql: NO_GQL, source: SOURCE, now: NOW, isStopped: () => calls.length >= 2 }, REF);
  assert.deepEqual(calls, [repoPath(REPO), labelsPath(REPO)]);
  assert.match(String(error), /repo HTTP 403/);
  assert.doesNotMatch(String(error), /stop/i);
});

test('assignees, milestones and issue types store on a 200, across pages, and write nothing on a 304; a kind is named only when it changed (#282)', async (t) => {
  const db = await tempModel(t);
  const page2 = 'repositories/1/assignees?per_page=100&page=2';
  const first = fakeRest([
    ok([{ login: 'caio' }], { etag: 'EA', next: page2 }), ok([{ login: 'Bia' }]), ok([{ title: 'v2' }, { title: 'v1' }], { etag: 'EM' }),
    ok([{ name: 'Task' }, { name: 'Bug' }], { etag: 'ET' }),
  ]);
  const deps = { db, rest: first.rest, source: SOURCE, now: NOW };
  assert.deepEqual(await syncAssignees(deps, REPO), { kinds: ['assignees'], requests: { 200: 2, 304: 0 } });
  assert.deepEqual(await syncMilestones(deps, REPO), { kinds: ['milestones'], requests: { 200: 1, 304: 0 } });
  assert.deepEqual(await syncIssueTypes(deps, REPO), { kinds: ['issueTypes'], requests: { 200: 1, 304: 0 } });
  assert.deepEqual(first.calls.map(([path]) => path), [assigneesPath(REPO), page2, milestonesPath(REPO), issueTypesPath('acme')]);
  assert.deepEqual([db.assignees(SOURCE, REPO), db.milestones(SOURCE, REPO), db.issueTypes(SOURCE, 'acme')], [['Bia', 'caio'], ['v1', 'v2'], ['Task', 'Bug']], 'by name, case-insensitive; issue types in the owner\'s order');
  assert.deepEqual(db.scope(SOURCE, 'acme', 'issueTypes'), { cursor: null, etag: 'ET', syncedAt: SYNCED }, 'keyed by the owner');
  const second = fakeRest([{ status: 304 }, { status: 304 }, { status: 304 }]);
  const again = { ...deps, rest: second.rest };
  for (const scope of [syncAssignees, syncMilestones, syncIssueTypes]) assert.deepEqual(await scope(again, REPO), { kinds: [], requests: { 200: 0, 304: 1 } });
  assert.deepEqual(second.calls.map(([, etag]) => etag), ['EA', 'EM', 'ET']);
});

test('a 404 on issue types, a user owner\'s answer, stores none and still counts the scope as synced (#282)', async (t) => {
  const db = await tempModel(t);
  db.setIssueTypes(SOURCE, 'acme', ['Bug']);
  const { rest } = fakeRest([{ status: 404 }]);
  assert.deepEqual(await syncIssueTypes({ db, rest, source: SOURCE, now: NOW }, REPO), { kinds: ['issueTypes'], requests: { 200: 1, 304: 0 } });
  assert.deepEqual(db.issueTypes(SOURCE, 'acme'), []);
  assert.equal(db.scope(SOURCE, 'acme', 'issueTypes')?.syncedAt, SYNCED);
});
