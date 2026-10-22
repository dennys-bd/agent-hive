import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGhToken, type GhToken } from '../../src/github-token.js';
import type { ReadModel } from '../../src/read-model/db.js';
import { accessFor } from '../../src/read-model/access.js';
import { createReadModelLoop } from '../../src/read-model/loop.js';
import { repoPath } from '../../src/read-model/repo-scopes.js';
import type { Exec } from '../../src/types.js';
import { NOW, REF, REPO, REST_REPO, SOURCE, tempModel } from './fixtures.js';

const API = 'https://api.github.com/';

// GitHub over fetch: the repository for its path, an empty list for every other read, a 304 to the ETag it gave
function fakeGithub(): { doFetch: typeof fetch; statuses: number[] } {
  const statuses: number[] = [];
  const doFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const path = String(url).slice(API.length);
    const etag = `"E-${path}"`;
    const sent = (init.headers as Record<string, string>)['If-None-Match'];
    const answer = sent === etag
      ? new Response(null, { status: 304 })
      : new Response(JSON.stringify(path === repoPath(REPO) ? REST_REPO : []), { status: 200, headers: { ETag: etag } });
    statuses.push(answer.status);
    return answer;
  }) as unknown as typeof fetch;
  return { doFetch, statuses };
}

/** gh as a counter: every run recorded; it only ever answers the token. */
function countingGh(): { exec: Exec; runs: string[][] } {
  const runs: string[][] = [];
  const exec: Exec = async (file, args) => {
    runs.push([file, ...args]);
    return { stdout: `test-${randomUUID()}\n` };
  };
  return { exec, runs };
}

const holder = (exec: Exec): GhToken =>
  createGhToken({ exec, env: { GH_CONFIG_DIR: '/cfg/gh' }, stat: async () => ({ mtimeMs: 1 }), readFile: async () => 'github.com:\n    user: bia\n' });

async function twoRounds(db: ReadModel, access: Parameters<typeof createReadModelLoop>[0]['access']): Promise<string[]> {
  const errors: string[] = [];
  const log = { error: (line: string) => { errors.push(line); }, warn: () => undefined, debug: () => undefined };
  const loop = createReadModelLoop({ db, access, repositories: async () => [REF], notify: () => undefined, log, now: NOW });
  await loop.runOnce();
  await loop.runOnce();
  return errors;
}

test('cli: two sync rounds run gh once, to read the token, and revalidate by ETag over HTTP (#503)', async (t) => {
  const db = await tempModel(t);
  const { exec, runs } = countingGh();
  const ghToken = holder(exec);
  const { doFetch, statuses } = fakeGithub();
  const errors = await twoRounds(db, () => accessFor('cli', { ghToken, fetch: doFetch }));
  assert.deepEqual(errors, []);
  assert.deepEqual(runs, [['gh', 'auth', 'token', '--hostname', 'github.com']], 'no gh config get, no gh api');
  assert.ok(statuses.includes(304), 'the second round answers 304 to the stored ETags');
  assert.ok(db.scope(SOURCE, REPO, 'reconcile'), 'the rounds stored under hosts.yml\'s login');
});

test('api: a sync round runs no gh at all (#503)', async (t) => {
  const db = await tempModel(t);
  const { exec, runs } = countingGh();
  const ghToken = holder(exec);
  const credentials = async () => ({ github: { token: `test-${randomUUID()}`, login: 'bia' } });
  const errors = await twoRounds(db, () => accessFor('api', { ghToken, credentials, fetch: fakeGithub().doFetch }));
  assert.deepEqual(errors, []);
  assert.deepEqual(runs, []);
  assert.ok(db.scope(SOURCE, REPO, 'reconcile'));
});
