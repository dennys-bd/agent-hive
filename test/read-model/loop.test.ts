import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openReadModel } from '../../src/read-model/db.js';
import { createReadModelLoop } from '../../src/read-model/loop.js';
import type { RestGet } from '../../src/read-model/rest.js';
import { scopeOf } from '../../src/read-model/sync.js';
import { fakeRest, NOW, ok, REPO, restIssue, SOURCE, T1 } from './fixtures.js';

const quiet = { error: () => undefined, debug: () => undefined };

test('a round syncs issues then comments of every listed repository, reconciles once per boot, and notifies only on a change (#765)', async () => {
  const db = openReadModel(':memory:');
  const notified: string[] = [];
  const { rest, calls } = fakeRest([ok([restIssue(1, T1)]), ok([]), ok([restIssue(1, T1)]), ok([]), { status: 304 }, { status: 304 }]);
  const loop = createReadModelLoop({ db, source: SOURCE, rest, repositories: async () => [REPO], notify: (source, repository) => { notified.push(`${source} ${repository}`); }, log: quiet, now: NOW });
  await loop.runOnce();
  assert.deepEqual(calls.map(([path]) => path.split('?')[0]), ['repos/acme/hive/issues', 'repos/acme/hive/issues/comments', 'repos/acme/hive/issues', 'repos/acme/hive/issues/comments']);
  assert.deepEqual(notified, [`${SOURCE} ${REPO}`]);
  await loop.runOnce();
  assert.equal(calls.length, 6, 'the second round reconciles nothing: done this boot, under 24 h ago');
  assert.equal(notified.length, 1, 'two 304s change nothing');
});

test('a repository whose sync fails is logged and the next one still syncs; a refetch that changed a row notifies (#765)', async () => {
  const db = openReadModel(':memory:');
  const errors: string[] = [];
  const notified: string[] = [];
  const rest: RestGet = async (path) => {
    if (path.startsWith('repos/acme/broken/')) throw new Error('gh api: HTTP 502');
    return path === 'repos/acme/hive/issues/7' ? ok(restIssue(7, T1)) : ok([]);
  };
  const loop = createReadModelLoop({ db, source: SOURCE, rest, repositories: async () => ['acme/broken', REPO], notify: (_s, repository) => { notified.push(repository); }, log: { ...quiet, error: (m: string) => { errors.push(m); } }, now: NOW });
  await loop.runOnce();
  assert.deepEqual(errors, ['read model: the sync of acme/broken failed: gh api: HTTP 502']);
  assert.notEqual(db.cursor(scopeOf(SOURCE, REPO, 'issues')), undefined);
  await loop.refetch(REPO, 7);
  assert.deepEqual(notified, [REPO]);
});
