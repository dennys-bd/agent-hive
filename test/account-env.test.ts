import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, accountEnv, createRunAccounts, ptyAccountEnv, reportedAccount } from '../src/account-env.js';
import type { AccountCtx } from '../src/agents/runner.js';
import { runners } from '../src/agents/registry.js';
import { AGENT_IDS } from '../src/types.js';

const DEPS = { accounts: { claude: 'work', copilot: 'octo' }, credentials: async () => ({}) };

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
  assert.deepEqual([seen[0]?.selected, seen[0]?.credentials], ['octo', DEPS.credentials]);
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

test('every runner answers { env: {} } in this delivery (#953)', async () => {
  for (const id of AGENT_IDS) assert.deepEqual(await runners[id].accountEnv({ credentials: async () => ({}) }), { env: {} }, id);
});

test('AccountError says account <provider> <code>, then the reason after a colon; the seam lets it and any other error through (#953)', async (t) => {
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
