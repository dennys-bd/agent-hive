import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveGithubCredential } from '../src/credentials.js';
import { createGithubAccount, type GithubAccount } from '../src/github-account.js';
import type { GhToken } from '../src/github-token.js';
import type { ReadModelLoop } from '../src/read-model/loop.js';
import { createServer } from '../src/server.js';
import type { AccountsConfig, Source, SourceSpec } from '../src/types.js';
import { AUTH, GITHUB_ENTRY, STAGES, fakeSourceFactory, tempHive } from './fakes.js';
import { settingsBody } from './review-server.js';
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

// #959: the save side of the logins
const UI_HEADERS = { 'content-type': 'application/json', 'x-hive-ui': '1' };
const MACHINE: GhToken = { login: async () => 'gh-user', token: async () => { throw new Error('the machine token was read'); }, invalidate: () => undefined };

interface Harness { base: string; home: string; repo: string; account: GithubAccount; kicks(): number; resolvedAs: string[] }

function countingLoop(): { loop: ReadModelLoop; kicks(): number } {
  let kicks = 0;
  const loop: ReadModelLoop = {
    runOnce: async () => undefined, refetch: async () => 'skipped', refreshOptions: async () => undefined, start: () => undefined, stop: async () => undefined,
    kick: () => { kicks += 1; },
  };
  return { loop, kicks: () => kicks };
}

// alice and bob stored in a temp home every route reads; every save's source check records the login it read as, and bob's cannot read the Project
async function start(t: TestContext): Promise<Harness> {
  const { home, repo } = await tempHive(t);
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gh-logins-') };
  for (const login of ['alice', 'bob']) await saveGithubCredential(login, { token: `fake-${login}-token` }, env);
  const account = createGithubAccount({ machine: MACHINE, env });
  const fake = fakeSourceFactory();
  const resolvedAs: string[] = [];
  const sourceFactory = (spec: SourceSpec): Source => {
    const source = fake.factory(spec);
    return {
      ...source,
      resolveFields: async () => {
        const login = await account.selected.login();
        resolvedAs.push(login);
        if (login === 'bob') throw new Error('bob cannot read the Project');
        await source.resolveFields();
      },
    };
  };
  const { loop, kicks } = countingLoop();
  const server = createServer({ secret: SECRET, home, sourceFactory, githubAccount: account, readLoop: loop, credentialsEnv: env, githubLogin: { env } });
  const port = await server.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${port}`, home, repo, account, kicks, resolvedAs };
}

const save = (h: Harness, accounts: AccountsConfig): Promise<Response> => hiveFetch(`${h.base}/settings`, {
  method: 'POST', headers: UI_HEADERS, body: JSON.stringify({ ...settingsBody(h.repo, STAGES), auth: AUTH, sources: [GITHUB_ENTRY], accounts }),
});

test('a save that switches accounts.github checks its sources as the new login and kicks one read round; one that keeps it kicks none (#959)', async (t) => {
  const h = await start(t);
  assert.equal((await save(h, { github: 'alice' })).status, 200, 'setup mode\'s first save switches too');
  assert.equal(h.resolvedAs.at(-1), 'alice');
  assert.equal(h.kicks(), 1);
  assert.equal((await save(h, { github: 'alice' })).status, 200);
  assert.equal(h.kicks(), 1, 'the same selection kicks nothing');
});

test('a save whose check fails as the new login leaves the account on the previous selection and kicks nothing (#959)', async (t) => {
  const h = await start(t);
  assert.equal((await save(h, { github: 'alice' })).status, 200);
  const refused = await save(h, { github: 'bob' });
  assert.equal(refused.status, 400);
  assert.match(((await refused.json()) as { error: string }).error, /bob cannot read the Project/);
  assert.equal(h.resolvedAs.at(-1), 'bob', 'the check read as the login the save selects');
  assert.equal(await h.account.selected.login(), 'alice');
  assert.equal(h.kicks(), 1);
});

test('GET /settings/github/auth answers gh\'s login with nothing selected in cli, then the selected stored login, never a token (#959)', async (t) => {
  const h = await start(t);
  assert.deepEqual(await (await hiveFetch(`${h.base}/settings/github/auth`)).json(), { connected: true, login: 'gh-user' });
  assert.equal((await save(h, { github: 'alice' })).status, 200);
  const body = await (await hiveFetch(`${h.base}/settings/github/auth`)).text();
  assert.deepEqual(JSON.parse(body), { connected: true, login: 'alice' });
  assert.ok(!body.includes('fake-alice-token'), body);
});
