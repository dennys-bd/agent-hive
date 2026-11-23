import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createGithubAccount, type GithubSelection, type SelectedGithub } from '../../src/github-account.js';
import { createGhToken, type GhToken } from '../../src/github-token.js';
import { accessFor } from '../../src/read-model/access.js';
import { VIEWER } from '../../src/sources/github-queries.js';
import type { Exec } from '../../src/types.js';
import { SOURCE } from './fixtures.js';

const PATH = 'repos/acme/hive/issues';
const TOKEN_RUN = ['gh', 'auth', 'token', '--hostname', 'github.com'];
const NO_HOLDER: GhToken = { login: async () => { throw new Error('api read the holder'); }, token: async () => { throw new Error('api read gh'); }, invalidate: () => undefined };

// The account over a fake store holding `logins` (login → token), `machine` as gh's holder, `selection` applied
function selectedOf(selection: GithubSelection, logins: Record<string, string>, machine: GhToken = NO_HOLDER): SelectedGithub {
  const github = Object.fromEntries(Object.entries(logins).map(([login, token]) => [login, { token }]));
  const account = createGithubAccount({ machine, credentials: async () => ({ github }) });
  account.use(selection);
  return account.selected;
}

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
  const access = await accessFor('cli', { ghToken: selectedOf({ auth: 'cli' }, {}, ghToken), fetch: answering(401).doFetch });
  await assert.rejects(access!.rest(PATH), { message: 'github rest: HTTP 401' });
  await assert.rejects(access!.rest(PATH), { message: 'github rest: HTTP 401' });
  assert.deepEqual(runs, [TOKEN_RUN, TOKEN_RUN]);
});

test('cli: no login in hosts.yml is no access (#503)', async () => {
  assert.equal(await accessFor('cli', { ghToken: holderOf('').ghToken }), undefined);
});

test('a selected stored login reads as itself: its source, and its bearer on REST and GraphQL, in cli and api alike (#959)', async () => {
  const token = `test-${randomUUID()}`;
  for (const auth of ['cli', 'api'] as const) {
    const { doFetch, headers } = answering(304);
    const ghToken = selectedOf({ auth, github: 'alice' }, { alice: token, bob: `test-${randomUUID()}` });
    const access = await accessFor(auth, { ghToken, fetch: doFetch });
    assert.equal(access?.source, 'github:github.com:alice');
    await access?.rest(PATH, 'W/"e"');
    await access?.gql(VIEWER).catch(() => undefined); // a 304 is no GraphQL answer: only the header it was sent with matters
    assert.deepEqual(headers.map((h) => h.Authorization), [`Bearer ${token}`, `Bearer ${token}`], auth);
  }
});

test('no selection: cli reads as gh\'s login; api reads the only stored login, none is no access, several reject naming accounts.github (#959)', async () => {
  const { ghToken } = holderOf('bia');
  assert.equal((await accessFor('cli', { ghToken: selectedOf({ auth: 'cli' }, { alice: `test-${randomUUID()}` }, ghToken) }))?.source, SOURCE);
  assert.equal((await accessFor('api', { ghToken: selectedOf({ auth: 'api' }, { bia: `test-${randomUUID()}` }) }))?.source, SOURCE);
  assert.equal(await accessFor('api', { ghToken: selectedOf({ auth: 'api' }, {}) }), undefined);
  await assert.rejects(accessFor('api', { ghToken: selectedOf({ auth: 'api' }, { alice: `test-${randomUUID()}`, bob: `test-${randomUUID()}` }) }), /"accounts\.github"/);
});

test('a 401 for a stored login rejects naming it over REST and GraphQL (#959)', async () => {
  const ghToken = selectedOf({ auth: 'api', github: 'alice' }, { alice: `test-${randomUUID()}` });
  const access = await accessFor('api', { ghToken, fetch: answering(401).doFetch });
  const refused = 'the token of alice was refused: log in again in Settings';
  await assert.rejects(access!.rest(PATH), { message: `github rest: HTTP 401: ${refused}` });
  await assert.rejects(access!.gql(VIEWER), { message: `github api: HTTP 401: ${refused}` });
});
