import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountError, accountEnv } from '../../src/account-env.js';
import { runners } from '../../src/agents/registry.js';
import type { Credentials } from '../../src/types.js';
import { LOGGED_OUT } from '../fixtures/accounts.js';

const TOKEN = 'not-a-real-token-956';
const STORE: Credentials = { claude: { work: { token: TOKEN } } };
const store = (): (() => Promise<Credentials>) => async () => STORE;
const machineGithub = LOGGED_OUT; // #962: every ctx carries gh's login; Claude never reads it

const isMissing = (err: unknown): boolean => err instanceof AccountError && err.provider === 'claude' && err.code === 'missing';

test('a selected stored account gives its token in CLAUDE_CODE_OAUTH_TOKEN and names the account (#956)', async () => {
  assert.deepEqual(await runners.claude.accountEnv({ selected: 'work', credentials: store(), machineGithub }), { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, account: 'work' });
});

test('no selection is the machine\'s login: no env, no account, and the store is never read (#956)', async (t) => {
  const credentials = t.mock.fn(store());
  assert.deepEqual(await runners.claude.accountEnv({ credentials, machineGithub }), { env: {} });
  assert.equal(credentials.mock.callCount(), 0);
});

test('a selected name the store lacks throws claude/missing, matched exactly, with no name or token in the message (#956)', async () => {
  for (const selected of ['gone', 'Work', 'toString', '__proto__', 'constructor']) {
    await assert.rejects(runners.claude.accountEnv({ selected, credentials: store(), machineGithub }), (err: unknown) => isMissing(err) && !(err as Error).message.includes(selected));
  }
  await assert.rejects(runners.claude.accountEnv({ selected: 'work', credentials: async () => ({}), machineGithub }), isMissing);
  await assert.rejects(runners.claude.accountEnv({ selected: 'work', credentials: async () => ({ claude: { work: { token: '' } } }), machineGithub }), isMissing); // a hand-edited store
});

test('through the seam, a Claude run gets the selected account\'s token and the run\'s account is its name (#956)', async () => {
  const answer = await accountEnv({ agent: 'claude' }, { accounts: { claude: 'work' }, credentials: store(), machineGithub });
  assert.deepEqual(answer, { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, accounts: { claude: 'work' } });
});

test('through the seam, no accounts.claude sets no CLAUDE_CODE_OAUTH_TOKEN, and a name the store lacks refuses (#956)', async () => {
  assert.deepEqual(await accountEnv({ agent: 'claude' }, { accounts: {}, credentials: store(), machineGithub }), { env: {}, accounts: {} });
  await assert.rejects(accountEnv({ agent: 'claude' }, { accounts: { claude: 'gone' }, credentials: store(), machineGithub }), isMissing);
});
