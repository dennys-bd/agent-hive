import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGhToken, type GhToken } from '../../src/github-token.js';
import { accessFor } from '../../src/read-model/access.js';
import type { Exec } from '../../src/types.js';
import { SOURCE } from './fixtures.js';

const PATH = 'repos/acme/hive/issues';
const TOKEN_RUN = ['gh', 'auth', 'token', '--hostname', 'github.com'];
const NO_HOLDER: GhToken = { login: async () => { throw new Error('api read the holder'); }, token: async () => { throw new Error('api read gh'); }, invalidate: () => undefined };

/** A fetch answering `status` to every call, recording the headers. */
function answering(status: number): { doFetch: typeof fetch; headers: Record<string, string>[] } {
  const headers: Record<string, string>[] = [];
  const doFetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    headers.push(init.headers as Record<string, string>);
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { doFetch, headers };
}

/** The real holder over a fake hosts.yml naming `login`, and a gh that only answers the token. */
function holderOf(login: string): { ghToken: GhToken; runs: string[][]; token: string } {
  const token = `test-${randomUUID()}`; // built at runtime: no token in a fixture
  const runs: string[][] = [];
  const exec: Exec = async (file, args) => {
    runs.push([file, ...args]);
    return { stdout: `${token}\n` };
  };
  const text = login === '' ? '' : `github.com:\n    user: ${login}\n`;
  return { ghToken: createGhToken({ exec, env: { GH_CONFIG_DIR: '/cfg/gh' }, stat: async () => ({ mtimeMs: 1 }), readFile: async () => text }), runs, token };
}

test('cli: the source is hosts.yml\'s login with no gh run, and REST carries the token gh answered (#503)', async () => {
  const { ghToken, runs, token } = holderOf('bia');
  const { doFetch, headers } = answering(304);
  const access = await accessFor('cli', { ghToken, fetch: doFetch });
  assert.equal(access?.source, SOURCE);
  assert.deepEqual(runs, [], 'no gh config get');
  assert.deepEqual(await access?.rest(PATH, 'W/"e"'), { status: 304 });
  assert.deepEqual(runs, [TOKEN_RUN]);
  assert.equal(headers[0]?.Authorization, `Bearer ${token}`);
});

test('cli: a 401 drops the token, so the next request reads it again (#503)', async () => {
  const { ghToken, runs } = holderOf('bia');
  const access = await accessFor('cli', { ghToken, fetch: answering(401).doFetch });
  await assert.rejects(access!.rest(PATH), { message: 'github rest: HTTP 401' });
  await assert.rejects(access!.rest(PATH), { message: 'github rest: HTTP 401' });
  assert.deepEqual(runs, [TOKEN_RUN, TOKEN_RUN]);
});

test('cli: no login in hosts.yml is no access (#503)', async () => {
  assert.equal(await accessFor('cli', { ghToken: holderOf('').ghToken }), undefined);
});

test('api: the source is the stored login, and REST sends the stored token as the bearer; the holder is never read (#503)', async () => {
  const token = `test-${randomUUID()}`;
  const { doFetch, headers } = answering(304);
  const access = await accessFor('api', { ghToken: NO_HOLDER, credentials: async () => ({ github: { token, login: 'bia' } }), fetch: doFetch });
  assert.equal(access?.source, SOURCE);
  await access?.rest(PATH, 'W/"e"');
  assert.equal(headers[0]?.Authorization, `Bearer ${token}`);
});

test('api: nothing stored is no access (#180)', async () => {
  assert.equal(await accessFor('api', { ghToken: NO_HOLDER, credentials: async () => ({}) }), undefined);
});
