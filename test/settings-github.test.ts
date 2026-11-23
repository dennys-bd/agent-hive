import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveGithubCredential } from '../src/credentials.js';
import { createGithubAccount } from '../src/github-account.js';
import type { GhToken } from '../src/github-token.js';
import { createServer } from '../src/server.js';
import { fakeSourceFactory, tempHive } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const GITHUB_API = 'https://api.github.com/';

test('the Settings listing reads as the query\'s auth: api before any save lists through the stored login, never through gh (#959)', async (t) => {
  const home = await tempDir(t, 'gh-config-');
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home; // apiGql with no holder reads the credential store of the process
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const token = `test-${randomUUID()}`;
  await saveGithubCredential('alice', { token });
  const ghCalls: string[] = [];
  const machine: GhToken = { login: async () => 'gh-user', token: async () => { ghCalls.push('token'); return 'unused'; }, invalidate: () => undefined };
  const bearers: string[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).startsWith(GITHUB_API)) return realFetch(url, init);
    bearers.push(new Headers(init?.headers).get('Authorization') ?? '');
    return new Response(JSON.stringify({ data: { user: { projectsV2: { nodes: [] } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const { home: hiveHome } = await tempHive(t);
  const server = createServer({ secret: SECRET, home: hiveHome, sourceFactory: fakeSourceFactory().factory, githubAccount: createGithubAccount({ machine }) });
  const port = await server.listen(0);
  t.after(() => server.close());
  await hiveFetch(`http://127.0.0.1:${port}/settings/projects?owner=acme&auth=api`);
  assert.deepEqual(bearers.slice(0, 1), [`Bearer ${token}`]);
  assert.deepEqual(ghCalls, []);
});
