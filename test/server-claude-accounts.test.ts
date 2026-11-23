import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createClaudeAdd } from '../src/claude-account.js';
import { readCredentials, saveClaudeCredential, writeCredentials } from '../src/credentials.js';
import { registerClaudeAccountRoutes } from '../src/server-claude-accounts.js';
import type { AccountsConfig } from '../src/types.js';
import { fakeLog, type FakePty, fakePtys } from './fakes.js';
import { tempDir } from './temp-dir.js';

// Obviously fake: 13 + 95 characters, one digit repeated, so two accounts hold different tokens
const fakeToken = (n: number): string => `sk-ant-oat01-${String(n).repeat(95)}`;

interface Harness {
  base: string;
  env: NodeJS.ProcessEnv;
  lines: string[];
  ptys: FakePty[];
  saved: { accounts?: AccountsConfig };
  queueSave: (save: () => Promise<void>) => Promise<void>;
}

// The routes alone on express, over a temp config home, fake ptys and a save chain of their own
async function routes(t: TestContext): Promise<Harness> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'claude-routes-') };
  const { log, lines } = fakeLog();
  const { spawnPty, ptys } = fakePtys();
  const add = createClaudeAdd({ spawnPty, command: 'claude', env: {}, cwd: env.XDG_CONFIG_HOME, log, save: (name, cred) => saveClaudeCredential(name, cred, env) });
  t.after(() => add.close());
  const saved: Harness['saved'] = {};
  let chain: Promise<void> = Promise.resolve();
  const queueSave = (save: () => Promise<void>): Promise<void> => {
    chain = chain.then(save, save);
    return chain;
  };
  const app = express();
  app.use(express.json());
  registerClaudeAccountRoutes(app, { add, credentialsEnv: env, savedAccounts: () => saved.accounts, queueSave, log });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/settings/accounts/claude`, env, lines, ptys, saved, queueSave };
}

const post = (h: Harness, body: unknown): Promise<Response> =>
  fetch(`${h.base}/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const remove = (h: Harness, path: string): Promise<Response> => fetch(`${h.base}/${path}`, { method: 'DELETE' });
const answered = async (res: Promise<Response>): Promise<[number, unknown]> => {
  const done = await res;
  return [done.status, await done.json()];
};

// The add's status once it leaves pending, polled the way #965 does; bounded, so a stuck add fails the test instead of hanging it
async function settled(h: Harness): Promise<unknown> {
  for (let i = 0; i < 50; i++) {
    const status = (await (await fetch(`${h.base}/add`)).json()) as { state: string };
    if (status.state !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the add never left pending');
}

test('GET answers the stored names only, sorted without regard to case (#955)', async (t) => {
  const h = await routes(t);
  assert.deepEqual(await answered(fetch(h.base)), [200, { names: [] }]);
  for (const [i, name] of ['bob', 'Ana', 'carl'].entries()) await saveClaudeCredential(name, { token: fakeToken(i) }, h.env);
  const res = await fetch(h.base);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { names: ['Ana', 'bob', 'carl'] });
  assert.ok(!text.includes('sk-ant-oat01-'), 'a route never answers a token');
});

test('POST trims the name, spawns one setup-token, answers 202 pending, and the captured token is stored under the trimmed name (#955)', async (t) => {
  const h = await routes(t);
  assert.deepEqual(await answered(post(h, { name: '  ana ' })), [202, { state: 'pending', name: 'ana' }]);
  assert.equal(h.ptys.length, 1);
  assert.deepEqual(h.ptys[0].args, ['setup-token']);
  assert.deepEqual(await answered(fetch(`${h.base}/add`)), [200, { state: 'pending', name: 'ana' }]);
  h.ptys[0].emit(`${fakeToken(7)}\r\n`);
  assert.deepEqual(await settled(h), { state: 'connected', name: 'ana' });
  assert.deepEqual((await readCredentials(h.env)).claude, { ana: { token: fakeToken(7) } });
});

test('an empty, too long, reserved or taken name answers 400 with its code and spawns nothing (#955)', async (t) => {
  const h = await routes(t);
  await saveClaudeCredential('Ana', { token: fakeToken(1) }, h.env);
  const cases: [unknown, string][] = [
    [{}, 'name-empty'], [{ name: 42 }, 'name-empty'], [{ name: '   ' }, 'name-empty'], [{ name: 'x'.repeat(41) }, 'name-too-long'],
    [{ name: 'ana' }, 'name-taken'], [{ name: 'ADD' }, 'name-taken'],
  ];
  for (const [body, error] of cases) assert.deepEqual(await answered(post(h, body)), [400, { error }], JSON.stringify(body));
  assert.equal(h.ptys.length, 0);
});

test('a POST while an add is pending answers 409 add-pending and the first add goes on (#955)', async (t) => {
  const h = await routes(t);
  await post(h, { name: 'ana' });
  assert.deepEqual(await answered(post(h, { name: 'bob' })), [409, { error: 'add-pending' }]);
  assert.equal(h.ptys.length, 1);
  assert.equal(h.ptys[0].killed, 0);
  assert.deepEqual(await answered(fetch(`${h.base}/add`)), [200, { state: 'pending', name: 'ana' }]);
});

test('DELETE add kills the pending pty and answers 204; with nothing pending it is 204 and no change (#955)', async (t) => {
  const h = await routes(t);
  await post(h, { name: 'ana' });
  assert.equal((await remove(h, 'add')).status, 204);
  assert.equal(h.ptys[0].killed, 1);
  assert.deepEqual(await answered(fetch(`${h.base}/add`)), [200, { state: 'cancelled', name: 'ana' }]);
  assert.equal((await remove(h, 'add')).status, 204);
  assert.deepEqual(await answered(fetch(`${h.base}/add`)), [200, { state: 'cancelled', name: 'ana' }]);
});

test('DELETE of a stored name removes only that entry and keeps every other key of the file (#955)', async (t) => {
  const h = await routes(t);
  const github = { token: 'fake-gh-955', login: 'octo' };
  await writeCredentials({ github, claude: { ana: { token: fakeToken(1) }, 'bob / work': { token: fakeToken(2) } } }, h.env);
  assert.equal((await remove(h, 'ana')).status, 204);
  assert.equal((await remove(h, encodeURIComponent('bob / work'))).status, 204);
  assert.deepEqual(await readCredentials(h.env), { github, claude: {} });
  assert.ok(h.lines.includes('INFO claude account removed: ana'), h.lines.join('\n'));
});

test('DELETE of an unknown name answers 404; of the saved accounts.claude 409 selected, by exact match, and keeps the entry (#955)', async (t) => {
  const h = await routes(t);
  await saveClaudeCredential('ana', { token: fakeToken(1) }, h.env);
  assert.deepEqual(await answered(remove(h, 'bob')), [404, { error: 'unknown' }]);
  h.saved.accounts = { claude: 'ana' };
  assert.deepEqual(await answered(remove(h, 'ana')), [409, { error: 'selected' }]);
  assert.deepEqual((await readCredentials(h.env)).claude, { ana: { token: fakeToken(1) } });
  h.saved.accounts = { claude: 'Ana' };
  assert.equal((await remove(h, 'ana')).status, 204, 'the run seam reads the name exactly');
});

test('a remove waits behind a queued save, so a selection that save makes is honoured (#955)', async (t) => {
  const h = await routes(t);
  await saveClaudeCredential('ana', { token: fakeToken(1) }, h.env);
  let release: () => void = () => undefined;
  void h.queueSave(() => new Promise<void>((resolve) => { release = resolve; }));
  const removing = answered(remove(h, 'ana'));
  const early = await Promise.race([removing.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 100))]);
  assert.equal(early, 'waiting');
  h.saved.accounts = { claude: 'ana' }; // what the queued save wrote
  release();
  assert.deepEqual(await removing, [409, { error: 'selected' }]);
});
