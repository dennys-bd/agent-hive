import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsRefusal } from '../src/accounts-config.js';
import { saveClaudeCredential, saveGithubCredential } from '../src/credentials.js';
import { tempDir, type AfterHost } from './temp-dir.js';

// A relative HIVE_HOME makes credentialsPath throw (home.ts): a refusal that resolves under it never read the credential store
const UNREADABLE: NodeJS.ProcessEnv = { HIVE_HOME: 'relative-home' };
const REFUSED = { status: 400, message: '"accounts.claude" names no saved Claude account' };

const storeWithWork = async (t: AfterHost): Promise<NodeJS.ProcessEnv> => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'accounts-') };
  await saveClaudeCredential('work', { token: 'fake-claude-token-1' }, env);
  return env;
};

test('accountsRefusal reads no credential when the save names no Claude account (#952)', async () => {
  assert.equal(await accountsRefusal(undefined, UNREADABLE), undefined, 'a body without accounts');
  assert.equal(await accountsRefusal({}, UNREADABLE), undefined);
  await assert.rejects(accountsRefusal({ github: 'me' }, UNREADABLE), /HIVE_HOME/, 'a GitHub login does read the store (#959)');
  await assert.rejects(accountsRefusal({ copilot: 'me' }, UNREADABLE), /HIVE_HOME/);
  await assert.rejects(accountsRefusal({ claude: 'work' }, UNREADABLE), /HIVE_HOME/, 'the guard holds: a Claude name does read the store');
});

test('accountsRefusal passes a Claude name with a saved credential and refuses one without with 400, never carrying a token (#952)', async (t) => {
  assert.deepEqual(await accountsRefusal({ claude: 'work' }, { XDG_CONFIG_HOME: await tempDir(t, 'accounts-') }), REFUSED, 'no store at all');
  const env = await storeWithWork(t);
  assert.equal(await accountsRefusal({ claude: 'work' }, env), undefined);
  const refusal = await accountsRefusal({ claude: 'home' }, env);
  assert.deepEqual(refusal, REFUSED);
  assert.ok(!JSON.stringify(refusal).includes('fake-claude-token-1'));
});

test('accountsRefusal counts own entries only: __proto__ and toString name no account (#952)', async (t) => {
  const env = await storeWithWork(t);
  for (const name of ['__proto__', 'toString', 'constructor']) assert.deepEqual(await accountsRefusal({ claude: name }, env), REFUSED, name);
});

test('accountsRefusal refuses an accounts.github or accounts.copilot naming no stored GitHub login with 400, own entries only, and passes a stored one (#959)', async (t) => {
  const env = { XDG_CONFIG_HOME: await tempDir(t, 'accounts-') };
  await saveGithubCredential('alice', { token: 'fake-github-token-1' }, env);
  assert.equal(await accountsRefusal({ github: 'alice', copilot: 'alice' }, env), undefined);
  assert.deepEqual(await accountsRefusal({ github: 'bob' }, env), { status: 400, message: '"accounts.github" names no saved GitHub login' });
  assert.deepEqual(await accountsRefusal({ copilot: 'bob' }, env), { status: 400, message: '"accounts.copilot" names no saved GitHub login' });
  assert.deepEqual(await accountsRefusal({ claude: 'work', github: 'bob' }, env), REFUSED, 'the first problem: claude before github');
  for (const name of ['__proto__', 'toString']) assert.equal((await accountsRefusal({ github: name }, env))?.status, 400, name);
  assert.ok(!JSON.stringify(await accountsRefusal({ github: 'bob' }, env)).includes('fake-github-token-1'));
});

test('accountsRefusal checks only the members that differ from the saved selection: an unchanged name passes unread, even one the store lost (#964)', async (t) => {
  const kept = { claude: 'work', github: 'me', copilot: 'me' };
  assert.equal(await accountsRefusal(kept, UNREADABLE, kept), undefined, 'nothing changed: the store is never read');
  const env = await storeWithWork(t);
  assert.equal(await accountsRefusal({ claude: 'gone' }, env, { claude: 'gone' }), undefined, 'a stale name the save keeps: the run seam refuses the run (#953)');
  assert.deepEqual(await accountsRefusal({ claude: 'home' }, env, { claude: 'work' }), REFUSED, 'a changed name not in the store');
  assert.equal(await accountsRefusal({ claude: 'work' }, env, { claude: 'gone' }), undefined, 'a changed name the store has');
  assert.deepEqual(
    await accountsRefusal({ claude: 'gone', github: 'bob' }, env, { claude: 'gone' }),
    { status: 400, message: '"accounts.github" names no saved GitHub login' },
    'the unchanged member is skipped, the changed one checked',
  );
  assert.equal(await accountsRefusal({}, UNREADABLE, { claude: 'work' }), undefined, 'a member dropped for the machine\'s login names nothing');
});
