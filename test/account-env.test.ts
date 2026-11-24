import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, accountEnv, createRunAccounts, ptyAccountEnv, reportedAccount, type AccountSeam } from '../src/account-env.js';
import { AccountError as MovedAccountError } from '../src/account-error.js';
import type { AccountCtx } from '../src/agents/runner.js';
import { runners } from '../src/agents/registry.js';
import { LOGGED_OUT } from './fixtures/accounts.js';

const DEPS = { accounts: { claude: 'work', copilot: 'octo' }, credentials: async () => ({}), machineGithub: LOGGED_OUT };

test('with no agent (a terminal) the seam answers no env and no accounts, and asks no runner (#953)', async (t) => {
  const asked = t.mock.method(runners.claude, 'accountEnv');
  assert.deepEqual(await accountEnv({}, DEPS), { env: {}, accounts: {} });
  assert.equal(asked.mock.callCount(), 0);
});

test('the runner is asked with its provider\'s selection and the credential reader; its account lands under that provider (#953)', async (t) => {
  const seen: AccountCtx[] = [];
  t.mock.method(runners.copilot, 'accountEnv', async (ctx: AccountCtx) => {
    seen.push(ctx);
    return { env: { X: '1' }, account: 'octo' };
  });
  assert.deepEqual(await accountEnv({ agent: 'copilot' }, DEPS), { env: { X: '1' }, accounts: { copilot: 'octo' } });
  assert.deepEqual([seen[0]?.selected, seen[0]?.credentials, seen[0]?.machineGithub], ['octo', DEPS.credentials, LOGGED_OUT], '#962: gh\'s machine login reaches the runner');
});

test('a runner answering no account leaves accounts empty: the machine\'s login (#953)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: { X: '1' } }));
  assert.deepEqual(await accountEnv({ agent: 'claude' }, { ...DEPS, accounts: {} }), { env: { X: '1' }, accounts: {} });
});

test('Codex has no provider: its runner gets no selection and its answer keeps no account (#950, #953)', async (t) => {
  const seen: AccountCtx[] = [];
  t.mock.method(runners.codex, 'accountEnv', async (ctx: AccountCtx) => {
    seen.push(ctx);
    return { env: {}, account: 'x' };
  });
  assert.deepEqual(await accountEnv({ agent: 'codex' }, DEPS), { env: {}, accounts: {} });
  assert.equal(seen[0]?.selected, undefined);
});

test('Claude and Codex with no selection answer { env: {} }, the machine\'s login; Copilot\'s is checked (copilot-account.test.ts) (#953, #962)', async () => {
  for (const id of ['claude', 'codex'] as const) assert.deepEqual(await runners[id].accountEnv({ credentials: async () => ({}), machineGithub: LOGGED_OUT }), { env: {} }, id);
});

test('AccountError says account <provider> <code>, then the reason after a colon; the seam lets it and any other error through (#953)', async (t) => {
  assert.equal(AccountError, MovedAccountError, '#962: account-env.ts re-exports the one class');
  assert.deepEqual([new AccountError('github', 'unreachable').reason, new AccountError('copilot', 'mismatch', 'HTTP 401').reason], [undefined, 'HTTP 401']);
  assert.equal(new AccountError('github', 'unreachable').message, 'account github unreachable');
  const refusal = new AccountError('claude', 'missing', 'no token named work');
  assert.deepEqual([refusal.message, refusal.provider, refusal.code, refusal instanceof Error], ['account claude missing: no token named work', 'claude', 'missing', true]);
  t.mock.method(runners.claude, 'accountEnv', async () => { throw refusal; });
  await assert.rejects(accountEnv({ agent: 'claude' }, DEPS), refusal);
  t.mock.method(runners.copilot, 'accountEnv', async () => { throw new Error('boom'); });
  await assert.rejects(accountEnv({ agent: 'copilot' }, DEPS), /^Error: boom$/);
});

test('ptyAccountEnv keeps the run\'s accounts under its pty and lays the workspace\'s env over the account\'s, which it wins (#953)', async () => {
  const runAccounts = createRunAccounts();
  const seam = async () => ({ env: { X: '1', Y: 'account' }, accounts: { claude: 'work' } });
  assert.deepEqual(await ptyAccountEnv({ accountEnv: seam, runAccounts }, 'P1', 'claude', { Y: 'workspace' }), { X: '1', Y: 'workspace' });
  assert.deepEqual(runAccounts.get('P1'), { claude: 'work' });
});

test('the store answers a pty\'s accounts until dropped; reportedAccount answers the member of the agent\'s provider only (#953)', () => {
  const store = createRunAccounts();
  store.set('P1', { claude: 'work', github: 'me' });
  assert.deepEqual([reportedAccount(store, 'P1', 'claude'), reportedAccount(store, 'P1', 'copilot'), reportedAccount(store, 'P1', 'codex')], ['work', undefined, undefined]);
  assert.equal(reportedAccount(store, 'ghost', 'claude'), undefined);
  store.drop('P1');
  assert.equal(store.get('P1'), undefined);
});

const GH_TEST = 'gho_test'; // a placeholder, never a real token
const SELECTED = { accounts: { github: 'octo' }, credentials: async () => ({ github: { octo: { token: GH_TEST }, other: { token: 'gho_other' } } }), machineGithub: LOGGED_OUT };

test('accounts.github naming a stored login: a run with no agent and a Claude run both get its GH_TOKEN and accounts.github, the Claude env beside it (#961)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'claude_test' }, account: 'work' }));
  assert.deepEqual(await accountEnv({}, SELECTED), { env: { GH_TOKEN: GH_TEST }, accounts: { github: 'octo' } });
  assert.deepEqual(await accountEnv({ agent: 'claude' }, { ...SELECTED, accounts: { github: 'octo', claude: 'work' } }), {
    env: { GH_TOKEN: GH_TEST, CLAUDE_CODE_OAUTH_TOKEN: 'claude_test' }, accounts: { github: 'octo', claude: 'work' },
  });
});

test('the agent\'s env goes over the GitHub provider\'s on a shared name (#961)', async (t) => {
  t.mock.method(runners.copilot, 'accountEnv', async () => ({ env: { GH_TOKEN: 'agent' } }));
  assert.equal((await accountEnv({ agent: 'copilot' }, SELECTED)).env.GH_TOKEN, 'agent');
});

test('with accounts.github absent no run gets GH_TOKEN, even with logins stored (#961)', async (t) => {
  t.mock.method(runners.claude, 'accountEnv', async () => ({ env: {} }));
  const absent = { ...SELECTED, accounts: {} };
  for (const run of [{}, { agent: 'claude' as const }]) assert.deepEqual(await accountEnv(run, absent), { env: {}, accounts: {} });
});

test('a named login absent from the store refuses with github / missing before the agent is asked, naming the login and never a token (#961)', async (t) => {
  const asked = t.mock.method(runners.claude, 'accountEnv');
  for (const login of ['ghost', 'toString']) {
    const err = await accountEnv({ agent: 'claude' }, { ...SELECTED, accounts: { github: login } }).then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof AccountError, login);
    assert.deepEqual([err.provider, err.code], ['github', 'missing']);
    assert.ok(err.message.includes(login));
    assert.ok(![GH_TEST, 'gho_other'].some((token) => err.message.includes(token)), err.message);
  }
  assert.equal(asked.mock.callCount(), 0);
});

test('ptyAccountEnv: a workspace env that sets GH_TOKEN wins over the selected login\'s (#961)', async () => {
  const seam: AccountSeam = (run) => accountEnv(run, SELECTED);
  const env = await ptyAccountEnv({ accountEnv: seam, runAccounts: createRunAccounts() }, 'P1', undefined, { GH_TOKEN: 'pinned' });
  assert.equal(env.GH_TOKEN, 'pinned');
});
