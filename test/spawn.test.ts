import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killStray, renderPrompt, userMessage, workerArgv, workerEnv, writePrompt } from '../src/spawn.js';

const task = { itemId: 'I1', id: '7', title: 'Fix "login"', body: 'line1\n$(echo pwned) `x`', url: 'https://github.com/a/b/issues/7' };

test('renderPrompt substitutes every placeholder', () => {
  const text = renderPrompt('#{number} {title}\n{body}\n{url}', task);
  assert.equal(text, '#7 Fix "login"\nline1\n$(echo pwned) `x`\nhttps://github.com/a/b/issues/7');
});

test('renderPrompt renders {id} and {number} the same', () => {
  assert.equal(renderPrompt('{id}={number}', { ...task, id: 'T-12' }), 'T-12=T-12');
});

test('writePrompt writes <promptsDir>/<slug>.md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hive-'));
  const path = await writePrompt(dir, 'hive-7-fix', 'hello');
  assert.equal(path, join(dir, 'hive-7-fix.md'));
  assert.equal(await readFile(path, 'utf8'), 'hello');
});

test('workerArgv puts the worktree, the hooks settings and the stream-json print mode before claudeArgs', () => {
  const argv = workerArgv({ slug: 'hive-7-fix', hooksPath: '/Users/x/my repo/.hive/hooks.json', claudeArgs: ['--permission-mode', 'acceptEdits'] });
  assert.deepEqual(argv, [
    '--worktree=hive-7-fix', '--settings', '/Users/x/my repo/.hive/hooks.json',
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
  ]);
  assert.deepEqual(workerArgv({ slug: 's', hooksPath: 'h', claudeArgs: [] }).slice(-1), ['--verbose'], 'no trailing args without claudeArgs');
});

test('workerEnv copies the base env without CLAUDECODE and adds HIVE_WORKER_ID and HIVE_PORT', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', HOME: '/Users/x' };
  assert.deepEqual(workerEnv(base, 'W1', 4242), { PATH: '/bin', HOME: '/Users/x', HIVE_WORKER_ID: 'W1', HIVE_PORT: '4242' });
  assert.equal(base.CLAUDECODE, '1', 'the base env is not touched');
});

test('userMessage wraps text as one stream-json user line', () => {
  assert.equal(userMessage('oi "você"\nlinha 2'), `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'oi "você"\nlinha 2' } })}\n`);
});

test('killStray resolves false when no process matches', async () => {
  assert.equal(await killStray('definitely-not-running-slug-xyz'), false);
});
