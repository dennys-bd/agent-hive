import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { readCredentials, writeCredentials } from '../src/credentials.js';
import { registerGitlabAccountRoutes } from '../src/server-gitlab-accounts.js';
import { createServer } from '../src/server.js';
import { fakeLog } from './fakes.js';
import { hiveFetch, SECRET } from './secret-client.js';
import { tempDir } from './temp-dir.js';

const TOKEN = `glpat-test-${randomUUID()}`; // built at runtime: no token in a fixture
const OTHER_TOKEN = `glpat-test-${randomUUID()}`;
const USER = { id: 1, username: 'ana' };
const SELF = { id: 9, scopes: ['api'], expires_at: '2027-01-31' };
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface FakeGitlab { user: () => Response; self: () => Response; calls: string[] }
interface Harness { base: string; dir: string; env: NodeJS.ProcessEnv; lines: string[]; hosts: string[]; gitlab: FakeGitlab; bodies: string[] }

// The routes alone on express, over a temp config home and a fake GitLab that answers every host
async function routes(t: TestContext): Promise<Harness> {
  const dir = await tempDir(t, 'gitlab-routes-');
  const env = { XDG_CONFIG_HOME: dir };
  const { log, lines } = fakeLog();
  const gitlab: FakeGitlab = { user: () => json(200, USER), self: () => json(200, SELF), calls: [] };
  const fakeFetch = (async (url: string | URL | Request) => {
    gitlab.calls.push(String(url));
    return String(url).endsWith('/personal_access_tokens/self') ? gitlab.self() : gitlab.user();
  }) as unknown as typeof fetch;
  const hosts = ['git.example.com'];
  const app = express();
  app.use(express.json());
  registerGitlabAccountRoutes(app, { gitlabHosts: () => hosts, credentialsEnv: env, fetch: fakeFetch, log });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/accounts/gitlab`, dir, env, lines, hosts, gitlab, bodies: [] };
}

// Every answer's text is kept, so the secrecy test can read them all
async function send(h: Harness, method: string, path = '', body?: unknown): Promise<[number, unknown]> {
  const res = await fetch(`${h.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  h.bodies.push(text);
  return [res.status, text === '' ? undefined : JSON.parse(text)];
}
const connect = (h: Harness, host: unknown, token: unknown = TOKEN): Promise<[number, unknown]> => send(h, 'POST', '', { host, token });

test('a connect verifies the token on its host, stores token, username and expiry and answers the row; the list answers the rows sorted by host (#1048)', async (t) => {
  const h = await routes(t);
  assert.deepEqual(await connect(h, 'gitlab.com'), [200, { host: 'gitlab.com', username: 'ana', expiresAt: '2027-01-31' }]);
  assert.deepEqual(h.gitlab.calls, ['https://gitlab.com/api/v4/user', 'https://gitlab.com/api/v4/personal_access_tokens/self']);
  h.gitlab.self = () => json(200, { ...SELF, expires_at: null });
  assert.deepEqual(await connect(h, ' Git.Example.com ', OTHER_TOKEN), [200, { host: 'git.example.com', username: 'ana' }], 'the host trimmed and lowercased');
  assert.deepEqual((await readCredentials(h.env)).gitlab, {
    'gitlab.com': { token: TOKEN, username: 'ana', expiresAt: '2027-01-31' },
    'git.example.com': { token: OTHER_TOKEN, username: 'ana' },
  });
  assert.deepEqual(await send(h, 'GET'), [200, { accounts: [{ host: 'git.example.com', username: 'ana' }, { host: 'gitlab.com', username: 'ana', expiresAt: '2027-01-31' }] }]);
  assert.ok(h.lines.includes('INFO gitlab account connected: gitlab.com (ana)'), h.lines.join('\n'));
});

test('connecting a host again replaces its token, username and expiry (#1048)', async (t) => {
  const h = await routes(t);
  await connect(h, 'gitlab.com');
  h.gitlab.user = () => json(200, { id: 1, username: 'ana.lima' });
  h.gitlab.self = () => json(200, { ...SELF, expires_at: null });
  assert.deepEqual(await connect(h, 'gitlab.com', OTHER_TOKEN), [200, { host: 'gitlab.com', username: 'ana.lima' }]);
  assert.deepEqual((await readCredentials(h.env)).gitlab, { 'gitlab.com': { token: OTHER_TOKEN, username: 'ana.lima' } });
});

test('a host that is neither gitlab.com nor a saved GitLab host is a 400 host, and a token that is empty or not printable ASCII a 400 token: GitLab is never called and nothing is stored (#1048)', async (t) => {
  const h = await routes(t);
  for (const host of ['github.com', 'code.example.org', 'ci.git.example.com', 'git.example.com:8443', '', 42, undefined]) {
    assert.deepEqual(await connect(h, host), [400, { error: 'host' }], String(host));
  }
  for (const token of ['', '   ', 'glpat with spaces', 'glpat-é', 7, undefined]) {
    // send, not connect: connect's default would turn an undefined token into TOKEN
    assert.deepEqual(await send(h, 'POST', '', { host: 'gitlab.com', token }), [400, { error: 'token' }], String(token));
  }
  assert.deepEqual(h.gitlab.calls, [], 'the token never leaves for a host that is not GitLab');
  assert.equal((await readCredentials(h.env)).gitlab, undefined);
  assert.ok(h.lines.includes('WARN gitlab account not connected: not a GitLab host'), h.lines.join('\n'));
  assert.ok(h.lines.includes('WARN gitlab account not connected: gitlab.com: token'), h.lines.join('\n'));
});

test('GitLab\'s refusals answer their code and store nothing: 401 refused, no api scope, a 404 on /self unverifiable, a 5xx or a network error unreachable (#1048)', async (t) => {
  const h = await routes(t);
  const cases: [string, () => void, number, string][] = [
    ['401', () => { h.gitlab.user = () => json(401, {}); }, 422, 'refused'],
    ['read_api only', () => { h.gitlab.user = () => json(200, USER); h.gitlab.self = () => json(200, { ...SELF, scopes: ['read_api'] }); }, 422, 'scope'],
    ['no /self', () => { h.gitlab.self = () => json(404, {}); }, 422, 'unverifiable'],
    ['5xx', () => { h.gitlab.user = () => json(502, {}); }, 502, 'unreachable'],
    ['network', () => { h.gitlab.user = () => { throw new TypeError('fetch failed'); }; }, 502, 'unreachable'],
  ];
  for (const [name, arrange, status, error] of cases) {
    arrange();
    assert.deepEqual(await connect(h, 'gitlab.com'), [status, { error }], name);
  }
  assert.equal((await readCredentials(h.env)).gitlab, undefined);
  assert.ok(h.lines.includes('WARN gitlab account not connected: gitlab.com: refused'), h.lines.join('\n'));
});

test('DELETE removes the host\'s entry only and answers 204; a host with no account answers 404 unknown (#1048)', async (t) => {
  const h = await routes(t);
  const github = { octo: { token: 'fake-gh-1048' } };
  await writeCredentials({ github }, h.env);
  await connect(h, 'gitlab.com');
  await connect(h, 'git.example.com', OTHER_TOKEN);
  assert.deepEqual(await send(h, 'DELETE', '/gitlab.com'), [204, undefined]);
  assert.deepEqual(await readCredentials(h.env), { github, gitlab: { 'git.example.com': { token: OTHER_TOKEN, username: 'ana', expiresAt: '2027-01-31' } } });
  assert.deepEqual(await send(h, 'DELETE', '/gitlab.com'), [404, { error: 'unknown' }]);
  assert.deepEqual(await send(h, 'DELETE', '/toString'), [404, { error: 'unknown' }], 'own entries only');
  assert.ok(h.lines.includes('INFO gitlab account removed: gitlab.com'), h.lines.join('\n'));
});

test('a host dropped from gitlabHosts keeps its stored account: still listed and still removable (#1048)', async (t) => {
  const h = await routes(t);
  await connect(h, 'git.example.com');
  h.hosts.splice(0);
  assert.deepEqual(await send(h, 'GET'), [200, { accounts: [{ host: 'git.example.com', username: 'ana', expiresAt: '2027-01-31' }] }]);
  assert.deepEqual(await connect(h, 'git.example.com'), [400, { error: 'host' }], 'only a new connect checks the host');
  assert.deepEqual(await send(h, 'DELETE', '/git.example.com'), [204, undefined]);
});

test('the token is in no answer, no log line and no file of the config home but credentials.json (#1048)', async (t) => {
  const h = await routes(t);
  await connect(h, 'gitlab.com');
  h.gitlab.user = () => json(401, {});
  await connect(h, 'git.example.com', OTHER_TOKEN);
  await send(h, 'GET');
  await send(h, 'DELETE', '/gitlab.com');
  for (const token of [TOKEN, OTHER_TOKEN]) {
    assert.ok(!h.bodies.some((body) => body.includes(token)), 'no answer');
    assert.ok(!h.lines.some((line) => line.includes(token)), 'no log line');
  }
  const files = (await readdir(h.dir, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.ok(files.some((entry) => entry.name === 'credentials.json'), 'the store was written');
  for (const entry of files.filter((file) => file.name !== 'credentials.json')) {
    const text = await readFile(join(entry.parentPath, entry.name), 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes(OTHER_TOKEN), entry.name);
  }
});

test('the server registers the routes outside setup mode\'s gate: the list answers none, gitlab.com is a GitLab host with no saved config, a remove of no account is 404 (#1048)', async (t) => {
  const home = await tempDir(t, 'gitlab-home-');
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gitlab-cfg-') };
  const { log } = fakeLog();
  const server = createServer({ home, log, secret: SECRET, credentialsEnv: env });
  const port = await server.listen(undefined);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/settings/accounts/gitlab`;
  assert.deepEqual(await (await hiveFetch(url)).json(), { accounts: [] });
  const write = { 'content-type': 'application/json', 'x-hive-ui': '1' };
  const refused = await hiveFetch(url, { method: 'POST', headers: write, body: JSON.stringify({ host: 'gitlab.com', token: '' }) });
  assert.deepEqual([refused.status, await refused.json()], [400, { error: 'token' }], 'past the host check: gitlab.com needs no saved list');
  const gone = await hiveFetch(`${url}/gitlab.com`, { method: 'DELETE', headers: write });
  assert.deepEqual([gone.status, await gone.json()], [404, { error: 'unknown' }]);
});
