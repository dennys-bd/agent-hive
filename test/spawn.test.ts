import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killStray, renderPrompt, spawnEmbeddedWorker, userMessage, workerArgv, workerEnv, writePrompt } from '../src/spawn.js';
import { openItermTab, shellQuote, workerCommand } from '../src/spawn-iterm.js';
import type { Exec } from '../src/types.js';
import { LAUNCH } from './fakes.js';

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

// A stand-in for `claude`: ignores its argv and echoes stdin, so what the spawner writes comes back as stdout lines.
async function echoBinary(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hive-echo-'));
  const bin = join(dir, 'claude-echo');
  await writeFile(bin, '#!/bin/sh\ncat\n');
  await chmod(bin, 0o755);
  return bin;
}

test('spawnEmbeddedWorker sends the prompt as the first user message over stdin, then follow-ups; end() exits once', async () => {
  const lines: string[] = [];
  let exits = 0;
  const handle = spawnEmbeddedWorker({ ...LAUNCH, repo: tmpdir() }, { onLine: (l) => lines.push(l), onExit: () => { exits += 1; } }, await echoBinary());
  handle.send('continua');
  handle.end();
  for (let i = 0; i < 100 && exits === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(exits, 1);
  assert.deepEqual(lines, [userMessage('faz a task').trim(), userMessage('continua').trim()]);
  handle.end(); // a closed stdin again is harmless
});

test('shellQuote single-quotes and escapes embedded quotes', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('openItermTab runs the open-tab script with the text as argv 1 and resolves to the session id', async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { stdout: 'w0t1p0:ABCD\n' };
  };
  assert.equal(await openItermTab("echo 'oi'", exec), 'w0t1p0:ABCD');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.equal(calls[0][1], '-e');
  assert.ok(calls[0][2].includes('com.googlecode.iterm2'));
  assert.ok(calls[0][2].includes('write text (item 1 of argv)'));
  assert.equal(calls[0][3], "echo 'oi'");
});

test('workerCommand (iterm) runs claude interactively in the repo with hive env, worktree, hooks and the prompt file, then reports exit', () => {
  const cmd = workerCommand({
    ...LAUNCH, repo: '/Users/x/my repo', hooksPath: '/Users/x/my repo/.hive/hooks.json',
    promptPath: '/Users/x/my repo/.hive/prompts/hive-1-task.md', claudeArgs: ['--model', 'sonnet'],
  });
  assert.equal(
    cmd,
    "cd '/Users/x/my repo' && HIVE_WORKER_ID=W1 HIVE_PORT=4242 claude --worktree=hive-1-task " +
      "--settings '/Users/x/my repo/.hive/hooks.json' '--model' 'sonnet' \"$(cat '/Users/x/my repo/.hive/prompts/hive-1-task.md')\"; " +
      "curl -s -m 2 -X POST http://127.0.0.1:4242/hooks/exit -H 'x-hive-worker: W1' >/dev/null",
  );
});
