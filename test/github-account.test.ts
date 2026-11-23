import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveGithubCredential } from '../src/credentials.js';
import { defaultGithubToken, NO_TOKEN_MESSAGE } from '../src/github-account.js';
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
