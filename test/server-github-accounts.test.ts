import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { readCredentials, saveGithubCredential } from '../src/credentials.js';
import { createGithubAccount } from '../src/github-account.js';
import type { GhToken } from '../src/github-token.js';
import type { GithubAdd } from '../src/github-login-gh.js';
import { registerGithubAccountRoutes } from '../src/server-github-accounts.js';
import type { AccountsConfig, GithubAddStatus } from '../src/types.js';
import { fakeLog } from './fakes.js';
import { tempDir } from './temp-dir.js';

interface StubAdd { add: GithubAdd; cancels: number; closes: number }
interface Harness { base: string; env: NodeJS.ProcessEnv; lines: string[]; stub: StubAdd }

const PENDING: GithubAddStatus = { state: 'pending', code: 'AB12-CD34', url: 'https://github.com/login/device' };

// The add as the routes see it: one pending at a time, counted cancels and closes. Its behaviour is test/github-login-gh.test.ts's
function stubAdd(): StubAdd {
  let status: GithubAddStatus = { state: 'idle' };
  const stub: StubAdd = {
    cancels: 0,
    closes: 0,
    add: {
      start: () => {
        if (status.state === 'pending') return undefined;
        status = PENDING;
        return status;
      },
      status: () => status,
      cancel: () => {
        stub.cancels += 1;
        status = { state: 'cancelled' };
      },
      close: async () => {
        stub.closes += 1;
      },
    },
  };
  return stub;
}

const machineAs = (login: string): GhToken => ({ login: async () => login, token: async () => { throw new Error('the machine token was read'); }, invalidate: () => undefined });

// The routes alone on express, over a temp store holding bob and alice, gh's login `machine`, the saved selection `accounts` and a stub add
async function routes(t: TestContext, machine: string, accounts: AccountsConfig = {}): Promise<Harness> {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gh-accounts-') };
  for (const login of ['bob', 'alice']) await saveGithubCredential(login, { token: `fake-${login}-token` }, env);
  const { log, lines } = fakeLog();
  const stub = stubAdd();
  const app = express();
  registerGithubAccountRoutes(app, { account: createGithubAccount({ machine: machineAs(machine), env }), accounts: () => accounts, log, env, queueSave: (save) => save(), add: stub.add });
  const server = app.listen(0);
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, env, lines, stub };
}

const remove = (h: Harness, login: string): Promise<Response> => fetch(`${h.base}/settings/github/accounts/${encodeURIComponent(login)}`, { method: 'DELETE' });

test('GET /settings/github/accounts answers the stored logins sorted and gh\'s own, never a token (#959)', async (t) => {
  const h = await routes(t, 'gh-user');
  const body = await (await fetch(`${h.base}/settings/github/accounts`)).text();
  assert.deepEqual(JSON.parse(body), { logins: ['alice', 'bob'], machine: 'gh-user' });
  assert.ok(!body.includes('fake-'), body);
  const bare = await routes(t, '');
  assert.deepEqual(await (await fetch(`${bare.base}/settings/github/accounts`)).json(), { logins: ['alice', 'bob'] }, 'no machine when gh has no login');
});

test('DELETE refuses the login accounts.github or accounts.copilot selects with 409 and an absent one with 404, and removes any other (#959)', async (t) => {
  const h = await routes(t, '', { github: 'alice', copilot: 'bob' });
  for (const [login, key] of [['alice', 'github'], ['bob', 'copilot']]) {
    const res = await remove(h, login);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: `"accounts.${key}" selects this login` });
  }
  const absent = await remove(h, 'carol');
  assert.equal(absent.status, 404);
  assert.deepEqual(await absent.json(), { error: 'no stored GitHub login by that name' });
  assert.equal((await remove(h, 'toString')).status, 404, 'own entries only');
  const free = await routes(t, '', { github: 'alice' });
  const removed = await remove(free, 'bob');
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });
  assert.deepEqual((await readCredentials(free.env)).github, { alice: { token: 'fake-alice-token' } });
  assert.ok(free.lines.includes('INFO github login removed: bob'));
  assert.ok(free.lines.every((line) => !line.includes('fake-')), free.lines.join('\n'));
});

test('POST /settings/github/add answers 202 with the status, then 409 add-pending; GET answers the status; DELETE cancels with 204 (#960)', async (t) => {
  const h = await routes(t, '');
  const url = `${h.base}/settings/github/add`;
  const first = await fetch(url, { method: 'POST' });
  assert.deepEqual([first.status, await first.json()], [202, PENDING]);
  const second = await fetch(url, { method: 'POST' });
  assert.deepEqual([second.status, await second.json()], [409, { error: 'add-pending' }]);
  assert.deepEqual(await (await fetch(url)).json(), PENDING);
  assert.equal((await remove(h, 'add')).status, 404, 'a login named add is still a login: its remove is not the cancel');
  assert.equal(h.stub.cancels, 0);
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 204);
  assert.equal(h.stub.cancels, 1);
  assert.deepEqual(await (await fetch(url)).json(), { state: 'cancelled' });
});
