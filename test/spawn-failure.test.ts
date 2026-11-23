import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnFailureCode } from '../src/spawn-failure.js';

test('run.spawn_failed\'s code is one of a closed set read from the known failures; anything else is error, never the text (#742)', () => {
  const cases: [string, string][] = [
    ['agent codex is not on PATH: install it, then restart the Hive', 'agent_missing'], ['choose a workspace', 'no_workspace'],
    ['workspace api is gone', 'workspace_gone'], ['workspace "api" não existe mais', 'workspace_gone'],
    ['comando "dev" não está habilitado no workspace api', 'command_disabled'], ['setup failed at line 3 (RUN pnpm i): exit 1', 'setup_failed'], ['setup failed at step 1 of 2 (line 3, RUN pnpm i): the command exited with code 1', 'setup_failed'],
    ["fatal: '/repo' already exists", 'git_failed'], ['base: main unknown (bad)', 'git_failed'], ['posix_spawnp failed.', 'pty_failed'],
    ['see https://github.com/acme/r/pull/9 and ~/saved', 'error'], ['', 'error'],
  ];
  for (const [message, code] of cases) assert.equal(spawnFailureCode(message), code, message);
});

test('ensureCheckout\'s refusal is checkout_dirty by its first line; without the trailing colon it stays error (#945)', () => {
  assert.equal(spawnFailureCode('/repo has changes that are not committed:\n M src/app.ts\n?? notes.md'), 'checkout_dirty');
  assert.equal(spawnFailureCode('/repo has changes that are not committed'), 'error');
});

test('an account refusal is account_<provider>_<code> by its first words; a reason after the colon does not change it (#953)', () => {
  for (const provider of ['claude', 'copilot', 'github'] as const) {
    for (const code of ['missing', 'mismatch', 'unreachable'] as const) {
      assert.equal(spawnFailureCode(`account ${provider} ${code}`), `account_${provider}_${code}`);
      assert.equal(spawnFailureCode(`account ${provider} ${code}: no token named work`), `account_${provider}_${code}`);
    }
  }
  for (const other of ['account codex missing', 'account claude gone', 'the account claude missing', 'account claude missingly']) assert.equal(spawnFailureCode(other), 'error', other);
});
