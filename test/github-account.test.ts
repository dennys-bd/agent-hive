import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveGithubCredential } from '../src/credentials.js';
import { createGithubAccount, defaultGithubToken, NO_TOKEN_MESSAGE, selectionOf, switchSelection, type GithubAccount, type GithubSelection } from '../src/github-account.js';
import type { GhToken } from '../src/github-token.js';
import type { Credentials } from '../src/types.js';
import { tempDir } from './temp-dir.js';

const ALICE = `test-${randomUUID()}`;
const BOB = `test-${randomUUID()}`;
const SEVERAL = 'several GitHub logins are stored: choose one in "accounts.github"';

test('defaultGithubToken: the only stored login\'s token, the instruction with none, a failure naming accounts.github with several (#959)', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'gh-default-') };
  await assert.rejects(defaultGithubToken(env), { message: NO_TOKEN_MESSAGE });
  await saveGithubCredential('alice', { token: ALICE }, env);
  assert.equal(await defaultGithubToken(env), ALICE);
  await saveGithubCredential('bob', { token: BOB }, env);
  await assert.rejects(defaultGithubToken(env), { message: SEVERAL });
});

const GH = `test-${randomUUID()}`;
const REFUSED_ALICE = 'the token of alice was refused: log in again in Settings';

// gh's holder as a counter: its login is gh-user, its token GH, every call recorded
function machine(): { holder: GhToken; calls: string[] } {
  const calls: string[] = [];
  const holder: GhToken = {
    login: async () => { calls.push('login'); return 'gh-user'; },
    token: async () => { calls.push('token'); return GH; },
    invalidate: () => { calls.push('invalidate'); },
  };
  return { holder, calls };
}

// The account over a fake store holding `logins` (login → token), with `selection` applied
function accountOver(logins: Record<string, string>, selection: GithubSelection): { account: GithubAccount; calls: string[] } {
  const gh = machine();
  const github = Object.fromEntries(Object.entries(logins).map(([login, token]) => [login, { token }]));
  const account = createGithubAccount({ machine: gh.holder, credentials: async (): Promise<Credentials> => ({ github }) });
  account.use(selection);
  return { account, calls: gh.calls };
}

test('a stored login named in accounts.github answers itself and its token in cli and api, never reading gh (#959)', async () => {
  for (const auth of ['cli', 'api'] as const) {
    const { account, calls } = accountOver({ alice: ALICE, bob: BOB }, { auth, github: 'alice' });
    assert.equal(await account.selected.login(), 'alice');
    assert.equal(await account.selected.token(), ALICE);
    account.selected.invalidate();
    assert.deepEqual(calls, [], `${auth}: no gh auth token, no hosts.yml`);
    assert.equal(await account.selected.refusal(), REFUSED_ALICE);
  }
});

test('a named login with no stored token rejects naming accounts.github and the login, never falling back to gh (#959)', async () => {
  const { account, calls } = accountOver({ bob: BOB }, { auth: 'cli', github: 'alice' });
  const message = '"accounts.github" names alice, which has no stored token: log in again in Settings';
  await assert.rejects(account.selected.login(), { message });
  await assert.rejects(account.selected.token(), { message });
  assert.deepEqual(calls, []);
});

test('no selection in cli is the machine\'s login, token and invalidate, as today; its 401 has no refusal (#959)', async () => {
  const { account, calls } = accountOver({ alice: ALICE }, { auth: 'cli' });
  assert.equal(await account.selected.login(), 'gh-user');
  assert.equal(await account.selected.token(), GH);
  account.selected.invalidate();
  assert.deepEqual(calls, ['login', 'token', 'invalidate']);
  assert.equal(await account.selected.refusal(), undefined);
});

test('no selection in api: the only stored login; none is no login; several fail naming accounts.github (#959)', async () => {
  const one = accountOver({ alice: ALICE }, { auth: 'api' }).account;
  assert.equal(await one.selected.login(), 'alice');
  assert.equal(await one.selected.token(), ALICE);
  assert.equal(await one.selected.refusal(), REFUSED_ALICE);
  const none = accountOver({}, { auth: 'api' }).account;
  assert.equal(await none.selected.login(), '');
  await assert.rejects(none.selected.token(), { message: NO_TOKEN_MESSAGE });
  assert.equal(await none.selected.refusal(), undefined);
  const several = accountOver({ alice: ALICE, bob: BOB }, { auth: 'api' }).account;
  await assert.rejects(several.selected.login(), { message: SEVERAL });
  await assert.rejects(several.selected.token(), { message: SEVERAL });
});

test('machine answers gh whatever the selection; tokenOf answers a stored login and rejects naming an absent one (#959)', async () => {
  const { account } = accountOver({ alice: ALICE, bob: BOB }, { auth: 'api', github: 'alice' });
  assert.equal(await account.machine.login(), 'gh-user');
  assert.equal(await account.machine.token(), GH);
  assert.equal(await account.tokenOf('bob'), BOB);
  await assert.rejects(account.tokenOf('carol'), /carol/);
  await assert.rejects(account.tokenOf('toString'), /toString/, 'own entries only');
});

test('use changes the next call\'s answer, the first selection is cli with nothing named, and no message carries a token (#959)', async () => {
  const fresh = createGithubAccount({ machine: machine().holder, credentials: async () => ({}) });
  assert.deepEqual(fresh.selection(), { auth: 'cli' });
  const { account } = accountOver({ alice: ALICE, bob: BOB }, { auth: 'cli', github: 'alice' });
  account.use({ auth: 'cli', github: 'bob' });
  assert.equal(await account.selected.token(), BOB);
  const absent = account.tokenOf('carol');
  account.use({ auth: 'api' });
  const failures = [absent, account.selected.token()];
  for (const failure of failures) {
    const err = await failure.then(() => undefined, (e: Error) => e);
    assert.ok(err && ![ALICE, BOB, GH].some((token) => err.message.includes(token)), err?.message);
  }
});

test('switchSelection applies the next selection, undo puts the previous back, changed follows accounts.github only (#959)', () => {
  const account = createGithubAccount({ machine: machine().holder, credentials: async () => ({}) });
  account.use({ auth: 'cli', github: 'alice' });
  assert.equal(switchSelection(account, { auth: 'api', github: 'alice' }).changed, false, 'auth alone is no switch of login');
  const moved = switchSelection(account, { auth: 'api', github: 'bob' });
  assert.equal(moved.changed, true);
  assert.deepEqual(account.selection(), { auth: 'api', github: 'bob' });
  moved.undo();
  assert.deepEqual(account.selection(), { auth: 'api', github: 'alice' });
});

test('selectionOf reads auth.github, cli when absent, and accounts.github (#959)', () => {
  assert.deepEqual(selectionOf({ accounts: {} }), { auth: 'cli' });
  assert.deepEqual(selectionOf({ auth: { github: 'api' }, accounts: { github: 'alice', claude: 'work' } }), { auth: 'api', github: 'alice' });
});
