import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineWords, matchSemaphore, workspaceLines } from '../src/command-semaphores.js';
import type { Command } from '../src/types.js';

const command = (name: string, impls: Command['impls']): Command => ({ name, impls, menu: true, env: {} });
// #798: `test` holds memory on every workspace but web, whose own line has none; `db` holds disk everywhere
const TEST_COMMAND = command('test', [{ workspace: null, command: 'CI=1 pnpm test && pnpm lint', semaphore: 'memory' }, { workspace: 'web', command: 'pnpm test' }]);
const DB_COMMAND = command('db', [{ workspace: null, command: 'docker compose up', semaphore: 'disk' }]);

test('lineWords: the words of the first command, its leading NAME=value skipped (#798)', () => {
  assert.deepEqual(lineWords('VAR=x pnpm test && pnpm lint'), ['pnpm', 'test']);
  assert.deepEqual(lineWords('  A=1 B_2=y vitest   run\t--reporter=dot | tee out'), ['vitest', 'run', '--reporter=dot'], 'a later NAME=value is an argument');
  for (const line of ['pnpm test; pnpm lint', 'pnpm test || true', 'pnpm test & wait', 'pnpm test&&pnpm lint', 'pnpm test; echo $HOME']) {
    assert.deepEqual(lineWords(line), ['pnpm', 'test'], line);
  }
});

test('lineWords: a first command the daemon would have to expand never matches (#798)', () => {
  for (const line of ['pnpm "test"', "pnpm 'test'", 'pnpm $SCRIPT', 'pnpm `which x`', 'pnpm test > out.txt', 'pnpm test 2>&1', 'pnpm test < in',
    'vitest run *.test.ts', 'vitest run a?.ts', 'vitest run [ab].ts', '(cd web && pnpm test)', 'pnpm test\\ x', 'ls ~', 'echo {a,b}', 'A=1 B=2', '   ']) {
    assert.equal(lineWords(line), undefined, line);
  }
});

test('matchSemaphore: a line matches when its words prefix the argv word for word; the longest wins, then the first (#798)', () => {
  const lines = [{ semaphore: 'disk', words: ['vitest'] }, { semaphore: 'memory', words: ['vitest', 'run'] }, { semaphore: 'other', words: ['vitest', 'run'] }];
  assert.equal(matchSemaphore(['vitest', 'run', 'a.test.ts'], lines), 'memory', 'longest, then first in comb.commands order');
  assert.equal(matchSemaphore(['vitest', 'watch'], lines), 'disk');
  assert.equal(matchSemaphore(['vitest-run'], lines), undefined, 'word for word, never a string prefix');
  assert.equal(matchSemaphore(['npx', 'vitest', 'run'], lines), undefined, 'a prefix, never a substring');
  assert.equal(matchSemaphore([], lines), undefined);
});

test('workspaceLines: each command\'s line resolveCommand picks there, only those with a semaphore and words (#798)', () => {
  const commands = [TEST_COMMAND, DB_COMMAND, command('dev', [{ workspace: null, command: 'pnpm "dev"', semaphore: 'memory' }])];
  assert.deepEqual(workspaceLines(commands, 'api'), [{ semaphore: 'memory', words: ['pnpm', 'test'] }, { semaphore: 'disk', words: ['docker', 'compose', 'up'] }]);
  assert.deepEqual(workspaceLines(commands, 'web'), [{ semaphore: 'disk', words: ['docker', 'compose', 'up'] }], 'web\'s own test line has none');
});
