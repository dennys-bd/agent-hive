import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { localActivityId } from '../src/activities.js';
import { LEASE_BODY_MESSAGE } from '../src/server-tree-watch.js';
import type { TreeWatch } from '../src/tree-watch.js';
import { worktreePath } from '../src/worktree.js';
import { startTree, task } from './fixtures/tree-server.js';
import { workPath } from './fixtures/work.js';
import { eventDuring, send } from './review-server.js';
import { hiveFetch } from './secret-client.js';

// POST and DELETE /activities/:id/tree/watch (#502), over the tree routes' test server, with the tree watch faked unless said otherwise
const LOCAL = `/activities/${encodeURIComponent(localActivityId('hive'))}`;
const SETTLE_MS = 500; // Linux's recursive watch walks the tree after watch() returns
const idOf = (path: string): string => decodeURIComponent(path.slice('/activities/'.length));

function recordingWatch(): { treeWatch: TreeWatch; calls: string[][] } {
  const calls: string[][] = [];
  const treeWatch: TreeWatch = {
    lease: async (activityId, root, id, isCheckout) => { calls.push(['lease', activityId, root, id, String(isCheckout)]); },
    release: (id) => { calls.push(['release', id]); },
    watchNested: async (root, repo) => { calls.push(['watchNested', root, repo]); },
    close: () => { calls.push(['close']); },
  };
  return { treeWatch, calls };
}

test('POST /activities/:id/tree/watch leases the root, a task\'s worktree as no checkout and a local activity\'s checkout as one; DELETE releases it, and the server\'s close closes the watch (#502)', async (t) => {
  const fake = recordingWatch();
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })], { treeWatch: fake.treeWatch });
  const path = workPath(f.server, 'local:1');
  assert.equal((await send(f.base, 'POST', `${path}/tree/watch`, { lease: 'L1' })).status, 204);
  assert.equal((await send(f.base, 'POST', `${LOCAL}/tree/watch`, { lease: 'L2' })).status, 204);
  assert.equal((await send(f.base, 'DELETE', `${path}/tree/watch/L1`)).status, 204);
  assert.deepEqual(fake.calls, [
    ['lease', idOf(path), worktreePath(f.repo, 'hive-1-task'), 'L1', 'false'],
    ['lease', localActivityId('hive'), f.repo, 'L2', 'true'],
    ['release', 'L1'],
  ]);
  await f.server.close();
  assert.deepEqual(fake.calls.at(-1), ['close']);
});

test('POST /activities/:id/tree/watch refuses a missing, empty, non-string or longer than 64 characters lease with 400, leasing nothing (#502)', async (t) => {
  const fake = recordingWatch();
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })], { treeWatch: fake.treeWatch });
  const url = `${workPath(f.server, 'local:1')}/tree/watch`;
  for (const body of [{}, { lease: '' }, { lease: 7 }, { lease: 'x'.repeat(65) }]) {
    const res = await send(f.base, 'POST', url, body);
    assert.deepEqual([res.status, await res.json()], [400, { error: LEASE_BODY_MESSAGE }], JSON.stringify(body));
  }
  assert.equal((await send(f.base, 'POST', url, { lease: 'x'.repeat(64) })).status, 204);
  assert.deepEqual(fake.calls.map(([name]) => name), ['lease']);
});

test('POST and DELETE /activities/:id/tree/watch refuse an unknown activity (404) and one with no worktree on disk (409), leasing nothing (#502)', async (t) => {
  const fake = recordingWatch();
  const f = await startTree(t, (repo) => [task(1), task(2, { worktree: worktreePath(repo, 'hive-2-task'), worktreeGone: true })], { treeWatch: fake.treeWatch });
  for (const [id, status] of [['local:9', 404], ['local:1', 404], ['local:2', 409]] as const) {
    assert.equal((await send(f.base, 'POST', `${workPath(f.server, id)}/tree/watch`, { lease: 'L1' })).status, status, id);
    assert.equal((await send(f.base, 'DELETE', `${workPath(f.server, id)}/tree/watch/L1`)).status, status, id);
  }
  assert.deepEqual(fake.calls, []);
});

test('DELETE /activities/:id/tree/watch/:lease answers 204 for a lease it never had (#502)', async (t) => {
  const fake = recordingWatch();
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })], { treeWatch: fake.treeWatch });
  assert.equal((await send(f.base, 'DELETE', `${workPath(f.server, 'local:1')}/tree/watch/never`)).status, 204);
  assert.deepEqual(fake.calls, [['release', 'never']]);
});

test('GET /activities/:id/tree/folder registers the nested repository a folder lies in with watchNested; a folder outside any registers nothing (#502, #1)', async (t) => {
  const fake = recordingWatch();
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })], { treeWatch: fake.treeWatch });
  const wt = worktreePath(f.repo, 'hive-1-task');
  await mkdir(join(wt, 'docs', 'agent'), { recursive: true });
  await mkdir(join(wt, 'src'), { recursive: true });
  await writeFile(join(wt, 'docs', '.git'), 'gitdir: elsewhere');
  const folder = (path: string): Promise<Response> => hiveFetch(`${f.base}${workPath(f.server, 'local:1')}/tree/folder?path=${encodeURIComponent(path)}`);
  assert.equal((await folder('docs/agent')).status, 200);
  assert.deepEqual(fake.calls, [['watchNested', wt, 'docs']]);
  assert.equal((await folder('src')).status, 200);
  assert.deepEqual(fake.calls, [['watchNested', wt, 'docs']]);
});

test('a change in a leased worktree reaches /events as a named tree event for its activity (#502)', async (t) => {
  const f = await startTree(t, (repo) => [task(1, { worktree: worktreePath(repo, 'hive-1-task') })]);
  const path = workPath(f.server, 'local:1');
  const wt = worktreePath(f.repo, 'hive-1-task');
  assert.equal((await send(f.base, 'POST', `${path}/tree/watch`, { lease: 'L1' })).status, 204);
  const change = (await eventDuring(f.base, 'tree', async () => {
    await sleep(SETTLE_MS);
    await writeFile(join(wt, 'new.txt'), 'n');
  })) as { type: string; activityId: string; paths?: string[] };
  assert.deepEqual([change.type, change.activityId], ['tree', idOf(path)]);
  assert.ok(change.paths === undefined || change.paths.includes('new.txt'), JSON.stringify(change));
});
