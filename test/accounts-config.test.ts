import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountsRefusal } from '../src/accounts-config.js';
import { saveClaudeCredential } from '../src/credentials.js';
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
  assert.equal(await accountsRefusal({ github: 'me', copilot: 'me' }, UNREADABLE), undefined, 'their check is #959\'s');
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
